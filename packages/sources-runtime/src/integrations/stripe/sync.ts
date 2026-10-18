/**
 * Stripe collection lanes, per connection, each with a leased durable cursor (`stripe_cursors`):
 *
 *  - `events:backfill`: `GET /v1/events` back to the retention horizon. Stripe documents that events can be
 *    listed for the last 30 days only, so the window is clamped to STRIPE_EVENTS_RETENTION_DAYS (30). The donor
 *    accepted up to 3650 days, which overstated retrievable history. Paginates newest to oldest with
 *    `starting_after`, persisting the cursor after every page.
 *  - `events:poll`: catches events a webhook delivery missed. Lists from the last completed high-water mark
 *    (minus an overlap) and advances the mark only after a full pass.
 *  - `objects:<resource>`: a full paginated listing of the current objects of each configured resource
 *    (STRIPE_SNAPSHOT_RESOURCES). Objects the completed listing did not return are tombstoned. The listing
 *    refreshes every STRIPE_SNAPSHOT_REFRESH_SECONDS; webhook events keep snapshots current in between.
 *
 * Errors stay per lane: permission errors block only that lane, retryable errors persist a retry time
 * (Retry-After as the floor of exponential backoff), and an invalid key marks the connection `error`.
 */
import { randomUUID } from "node:crypto";
import { StripeApiError, StripeClient, type FetchImpl, type StripeEvent } from "./api.js";
import {
  getConnection,
  leaseCursor,
  listConnections,
  saveCursor,
  setConnectionError,
  storeEvent,
  tombstoneUnlisted,
  upsertSnapshot,
  type Executor,
  type StripeConnection,
  type StripeCursor,
} from "./store.js";
import { db as defaultDb } from "../../db/client.js";

function intEnv(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.floor(Number(process.env[name] ?? fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Stripe API reference, List all events: "going back up to 30 days". */
export const STRIPE_EVENTS_RETENTION_DAYS = 30;
export const STRIPE_PAGES_PER_RUN = () => intEnv("STRIPE_PAGES_PER_RUN", 20, 1);
export const STRIPE_POLL_OVERLAP_SECONDS = 300;
export const STRIPE_SNAPSHOT_REFRESH_SECONDS = () => intEnv("STRIPE_SNAPSHOT_REFRESH_SECONDS", 6 * 3600, 600);
export const STRIPE_SYNC_FREQUENCY_SECONDS = 300;

/** Listable resources and their object type (data.object.object) for event routing. */
export const STRIPE_RESOURCES: Readonly<Record<string, { objectType: string; params?: Record<string, string> }>> = {
  customers: { objectType: "customer" },
  products: { objectType: "product" },
  prices: { objectType: "price" },
  subscriptions: { objectType: "subscription", params: { status: "all" } },
  invoices: { objectType: "invoice" },
  coupons: { objectType: "coupon" },
  payment_links: { objectType: "payment_link" },
  charges: { objectType: "charge" },
  payouts: { objectType: "payout" },
  disputes: { objectType: "dispute" },
};
/** Object types for which a `<type>.deleted` event means the object no longer exists. */
const DELETABLE = new Set(["customer", "product", "price", "invoice", "coupon", "plan"]);

export function configuredResources(raw = process.env.STRIPE_SNAPSHOT_RESOURCES): string[] {
  const list = (raw?.trim() ? raw.split(",") : ["customers", "products", "prices", "subscriptions", "invoices"]).map((s) => s.trim()).filter(Boolean);
  return [...new Set(list.filter((r) => r in STRIPE_RESOURCES))];
}

function resourceForObjectType(type: string | undefined, resources: string[]): string | null {
  if (!type) return null;
  for (const r of resources) if (STRIPE_RESOURCES[r]!.objectType === type) return r;
  return null;
}

export function backoffSeconds(attempts: number, retryAfter: number | null): number {
  return Math.max(retryAfter ?? 0, Math.min(3600, 30 * 2 ** Math.min(attempts, 7)));
}

export interface SyncDeps {
  executor?: Executor;
  fetchImpl?: FetchImpl;
  apiBase?: string;
  now?: () => Date;
  resources?: string[];
}

/** Store one event (raw, deduped by id) and fold its object into the current snapshot. */
export async function ingestEvent(conn: Pick<StripeConnection, "id" | "tenantId" | "accountId" | "livemode">, event: StripeEvent, deps: SyncDeps = {}): Promise<{ stored: boolean; snapshot: string | null }> {
  const executor = deps.executor ?? defaultDb;
  const stored = await storeEvent(conn.tenantId, conn.accountId, event, executor);
  const obj = event.data?.object;
  const resource = resourceForObjectType(obj?.object, deps.resources ?? configuredResources());
  if (!resource || !obj || typeof obj.id !== "string") return { stored, snapshot: null };
  const deleted = (obj.deleted === true || event.type === `${obj.object}.deleted`) && DELETABLE.has(String(obj.object));
  const outcome = await upsertSnapshot({
    tenantId: conn.tenantId,
    connectionId: conn.id,
    accountId: conn.accountId,
    livemode: conn.livemode,
    resource,
    object: obj as Record<string, unknown> & { id: string },
    sourceOrder: event.created,
    deleted: deleted ? { reason: `stripe_event:${event.type}` } : null,
  }, executor);
  return { stored, snapshot: outcome };
}

type LaneResult = { lane: string; status: StripeCursor["status"] | "skipped"; pages: number; events?: number; objects?: number; reason?: string | null };

function failure(err: unknown, cursor: StripeCursor): { status: StripeCursor["status"]; retryAt: Date | null; attempts: number; lastError: string; connectionError?: string } {
  const attempts = cursor.attempts + 1;
  if (err instanceof StripeApiError) {
    if (err.status === 401) return { status: "blocked", retryAt: null, attempts, lastError: `invalid_api_key: ${err.message}`, connectionError: "invalid_api_key" };
    if (err.status === 403 || err.type === "invalid_request_error" && err.code === "secret_key_required") {
      // Restricted key without this permission: this lane only; retried hourly in case the key is widened.
      return { status: "blocked", retryAt: new Date(Date.now() + 3600_000), attempts, lastError: `permission_denied: ${err.message}` };
    }
    if (err.retryable) return { status: "error", retryAt: new Date(Date.now() + backoffSeconds(attempts, err.retryAfterSeconds) * 1000), attempts, lastError: `${err.status === 429 ? "rate_limited" : "retryable"}: ${err.message}` };
    return { status: "error", retryAt: new Date(Date.now() + backoffSeconds(attempts, null) * 1000), attempts, lastError: `stripe_${err.status}: ${err.message}` };
  }
  return { status: "error", retryAt: new Date(Date.now() + backoffSeconds(attempts, null) * 1000), attempts, lastError: err instanceof Error ? err.message : String(err) };
}

async function runLane(
  conn: StripeConnection,
  lane: string,
  deps: SyncDeps,
  body: (cursor: StripeCursor, client: StripeClient, save: (state: Record<string, unknown>, extra?: { completed?: boolean }) => Promise<void>) => Promise<{ pages: number; events?: number; objects?: number; done: boolean; state: Record<string, unknown> }>,
): Promise<LaneResult> {
  const executor = deps.executor ?? defaultDb;
  const owner = `stripe-${randomUUID()}`;
  const cursor = await leaseCursor(conn.tenantId, conn.id, lane, owner, {}, executor);
  if (!cursor) return { lane, status: "skipped", pages: 0, reason: "leased or retry pending" };
  const full = await getConnection(conn.id, executor);
  if (!full || full.status !== "active") {
    await saveCursor(cursor, owner, { status: "blocked", state: cursor.state, lastError: "connection not active", release: true }, executor);
    return { lane, status: "blocked", pages: 0, reason: "connection not active" };
  }
  const client = new StripeClient(full.apiKey(), deps.fetchImpl, deps.apiBase);
  const save = async (state: Record<string, unknown>) => {
    if (!(await saveCursor(cursor, owner, { status: "running", state, success: true }, executor))) throw new Error("stripe cursor lease lost");
  };
  try {
    const r = await body(cursor, client, save);
    await saveCursor(cursor, owner, { status: r.done ? "complete" : "running", state: r.state, success: true, completed: r.done, release: true }, executor);
    return { lane, status: r.done ? "complete" : "running", pages: r.pages, ...(r.events !== undefined ? { events: r.events } : {}), ...(r.objects !== undefined ? { objects: r.objects } : {}) };
  } catch (err) {
    const f = failure(err, cursor);
    // Keep whatever page progress was saved; only status/retry change.
    const latest = (await leaseState(executor, conn.id, lane)) ?? cursor.state;
    await saveCursor(cursor, owner, { status: f.status, state: latest, retryAt: f.retryAt, attempts: f.attempts, lastError: f.lastError, release: true }, executor);
    if (f.connectionError) await setConnectionError(conn.id, f.connectionError, executor);
    return { lane, status: f.status, pages: 0, reason: f.lastError };
  }
}

async function leaseState(executor: Executor, connectionId: string, lane: string): Promise<Record<string, unknown> | null> {
  const { sql } = await import("drizzle-orm");
  const r = await executor.execute(sql`SELECT state FROM stripe_cursors WHERE connection_id = ${connectionId} AND lane = ${lane}`);
  const row = (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? [])[0] as { state?: unknown } | undefined;
  if (!row?.state) return null;
  return (typeof row.state === "string" ? JSON.parse(row.state) : row.state) as Record<string, unknown>;
}

/** Events back to the retention horizon (clamped to 30 days), resumable page by page. */
export function runEventsBackfill(conn: StripeConnection, deps: SyncDeps = {}): Promise<LaneResult> {
  const now = () => (deps.now ?? (() => new Date()))();
  return runLane(conn, "events:backfill", deps, async (cursor, client, save) => {
    const requested = intEnv("STRIPE_EVENTS_BACKFILL_DAYS", STRIPE_EVENTS_RETENTION_DAYS, 1, STRIPE_EVENTS_RETENTION_DAYS);
    const state = { ...cursor.state } as { windowFrom?: number; startingAfter?: string | null; events?: number; done?: boolean };
    if (cursor.status === "complete" && state.done) return { pages: 0, done: true, state };
    state.windowFrom ??= Math.floor(now().getTime() / 1000) - requested * 86_400;
    let pages = 0;
    let events = 0;
    while (pages < STRIPE_PAGES_PER_RUN()) {
      const page = await client.listEvents({ createdGte: state.windowFrom, ...(state.startingAfter ? { startingAfter: state.startingAfter } : {}) });
      pages++;
      for (const ev of page.data) if ((await ingestEvent(conn, ev, deps)).stored) events++;
      state.events = (state.events ?? 0) + page.data.length;
      if (!page.has_more || page.data.length === 0) {
        state.done = true;
        state.startingAfter = null;
        return { pages, events, done: true, state };
      }
      state.startingAfter = page.data[page.data.length - 1]!.id;
      await save(state);
    }
    return { pages, events, done: false, state };
  });
}

/** Missed-webhook catch-up from the last completed high-water mark. */
export function runEventsPoll(conn: StripeConnection, deps: SyncDeps = {}): Promise<LaneResult> {
  const now = () => (deps.now ?? (() => new Date()))();
  return runLane(conn, "events:poll", deps, async (cursor, client, save) => {
    const state = { ...cursor.state } as { highWater?: number; pass?: { from: number; startingAfter: string | null; maxCreated: number } | null };
    state.highWater ??= Math.floor(Date.parse(conn.createdAt) / 1000) - STRIPE_POLL_OVERLAP_SECONDS;
    const pass = state.pass ?? { from: Math.max(0, state.highWater - STRIPE_POLL_OVERLAP_SECONDS), startingAfter: null, maxCreated: state.highWater };
    state.pass = pass;
    let pages = 0;
    let events = 0;
    while (pages < STRIPE_PAGES_PER_RUN()) {
      const page = await client.listEvents({ createdGte: pass.from, ...(pass.startingAfter ? { startingAfter: pass.startingAfter } : {}) });
      pages++;
      for (const ev of page.data) {
        if ((await ingestEvent(conn, ev, deps)).stored) events++;
        pass.maxCreated = Math.max(pass.maxCreated, ev.created);
      }
      if (!page.has_more || page.data.length === 0) {
        state.highWater = Math.min(pass.maxCreated, Math.floor(now().getTime() / 1000));
        state.pass = null;
        return { pages, events, done: true, state };
      }
      pass.startingAfter = page.data[page.data.length - 1]!.id;
      await save(state);
    }
    return { pages, events, done: false, state };
  });
}

/** Full listing of one resource's current objects; completes with tombstones for objects no longer listed. */
export function runObjectListing(conn: StripeConnection, resource: string, deps: SyncDeps = {}): Promise<LaneResult> {
  const now = () => (deps.now ?? (() => new Date()))();
  const spec = STRIPE_RESOURCES[resource];
  if (!spec) return Promise.resolve({ lane: `objects:${resource}`, status: "blocked", pages: 0, reason: "unknown resource" });
  return runLane(conn, `objects:${resource}`, deps, async (cursor, client, save) => {
    let state = { ...cursor.state } as { runId?: string | null; listedAt?: number; startingAfter?: string | null; objects?: number; lastCompleteAt?: number };
    const fresh = cursor.status === "complete" && state.lastCompleteAt && now().getTime() / 1000 - state.lastCompleteAt < STRIPE_SNAPSHOT_REFRESH_SECONDS();
    if (fresh) return { pages: 0, done: true, state };
    if (!state.runId) state = { ...state, runId: randomUUID(), listedAt: Math.floor(now().getTime() / 1000), startingAfter: null, objects: 0 };
    let pages = 0;
    let objects = 0;
    while (pages < STRIPE_PAGES_PER_RUN()) {
      const page = await client.list(resource, { ...(state.startingAfter ? { startingAfter: state.startingAfter } : {}), ...(spec.params ? { extra: spec.params } : {}) });
      pages++;
      for (const obj of page.data) {
        const outcome = await upsertSnapshot({
          tenantId: conn.tenantId, connectionId: conn.id, accountId: conn.accountId, livemode: conn.livemode, resource, object: obj,
          sourceOrder: state.listedAt!, runId: state.runId!,
          deleted: obj.deleted === true ? { reason: "listed_deleted" } : null,
        }, deps.executor ?? defaultDb);
        if (outcome !== "unchanged" && outcome !== "stale") objects++;
      }
      state.objects = (state.objects ?? 0) + page.data.length;
      if (!page.has_more || page.data.length === 0) {
        await tombstoneUnlisted(conn.id, resource, state.runId!, state.listedAt!, deps.executor ?? defaultDb);
        return { pages, objects, done: true, state: { lastCompleteAt: Math.floor(now().getTime() / 1000), lastCompleteObjects: state.objects, runId: null } };
      }
      state.startingAfter = page.data[page.data.length - 1]!.id;
      await save(state);
    }
    return { pages, objects, done: false, state };
  });
}

/** Scheduled sync: missed-event poll plus due object listings, for every active connection of the tenant. */
export async function runStripeSync(tenantId: string, deps: SyncDeps = {}): Promise<{ connections: number; lanes: LaneResult[] }> {
  const executor = deps.executor ?? defaultDb;
  const lanes: LaneResult[] = [];
  const conns = (await listConnections(tenantId, executor)).filter((c) => c.status === "active");
  for (const conn of conns) {
    lanes.push(await runEventsPoll(conn, deps));
    for (const resource of deps.resources ?? configuredResources()) lanes.push(await runObjectListing(conn, resource, deps));
  }
  return { connections: conns.length, lanes };
}

export async function runStripeBackfill(tenantId: string, deps: SyncDeps = {}): Promise<{ connections: number; lanes: LaneResult[]; complete: boolean }> {
  const executor = deps.executor ?? defaultDb;
  const lanes: LaneResult[] = [];
  const conns = (await listConnections(tenantId, executor)).filter((c) => c.status === "active");
  for (const conn of conns) lanes.push(await runEventsBackfill(conn, deps));
  return { connections: conns.length, lanes, complete: lanes.every((l) => l.status === "complete" || l.status === "blocked") };
}
