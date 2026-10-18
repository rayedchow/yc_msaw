import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import type { TaskHandler } from "../../../queue/queue.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import type { DbExecutor } from "../../core/types.js";
import {
  AttachmentTooLargeError,
  ConfluenceApiError,
  ConfluenceAuthError,
  ConfluenceClient,
  ConfluenceRateLimitedError,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  isRecord,
  type ConfluenceClientOptions,
  type ConfluenceTarget,
  type JsonResult,
} from "./api.js";
import { objectRowKey, quotaKeyFor, type CommentType, type ConfluenceContentType, type ContainerType } from "./identity.js";
import {
  acquireQuotaLease,
  bumpChildrenEpoch,
  bumpGenerationCounter,
  ChunkWriter,
  checkpointWork,
  clearRateStreak,
  contiguousHistory,
  enqueueWork,
  ensureSyncState,
  findObject,
  finishWork,
  getSyncState,
  insertObservation,
  insertVersion,
  listObjects,
  listSites,
  markInaccessible,
  markSitesRemoved,
  nextWork,
  pendingScanItems,
  quotaBlockedUntil,
  recordRateLimited,
  recordRunOutcome,
  releaseQuotaLease,
  renewQuotaLease,
  retryWorkLater,
  rowsOf,
  setDeltaWatermark,
  setGenerationPhase,
  setObjectFields,
  setSiteStatus,
  startGeneration,
  storedVersionNumbers,
  tombstoneDependents,
  tombstoneObject,
  touchDependents,
  upsertObject,
  upsertSite,
  workState,
  type SiteScope,
  type WorkItem,
  type WorkRow,
} from "./store.js";

/**
 * Confluence deep sweep (task `confluence.sweep`, one schedule per tenant).
 *
 * Per active Nango Confluence connection of the tenant: discover the Atlassian
 * sites the grant reaches (accessible-resources, with scopes), then per site
 * run a bounded slice of a durable work queue (drizzle/9200):
 *
 *   full pass (generation G, every fullScanIntervalMs):
 *     spaces -> per space: pages + blog posts (current/archived, storage body),
 *     trashed pages/blog posts, space permissions -> per container: version
 *     list -> each missing version body (`?version=n&body-format=storage`),
 *     ADF body, footer/inline comments (+ reply children), attachments (+ exact
 *     bytes), page restrictions.
 *     When every scan item is finished, objects not seen in G whose listing
 *     COMPLETED are confirmed one by one (GET by id): 404 -> tombstone (space
 *     404 tombstones the whole space), 403 -> inaccessible (kept), 200 ->
 *     re-captured (moved / listing anomaly). A failed listing never produces
 *     confirmations, so a partial scan cannot delete anything.
 *   delta (every run): CQL `lastmodified >= now("-Nm")` from the stored
 *     watermark, refreshing only objects whose version differs.
 *
 * Every listing item checkpoints its cursor after storing a page, so a crash,
 * lease loss or rate limit resumes exactly there. 429/503 stop the run and
 * persist the Retry-After cooldown on the Atlassian bucket (OAuth app x site),
 * shared by all tenants and workers; nothing sleeps while holding a task.
 */

export const CONFLUENCE_SWEEP_TASK = "confluence.sweep";
export const CONFLUENCE_PROVIDER = "confluence";

const PAGE_LIMIT = 250;
const COMMENT_LIMIT = 100;
const VERSION_LIMIT = 50;
const SEARCH_LIMIT = 100;

export const PRIORITY = {
  delta: 5,
  spaces: 10,
  refresh: 15,
  content: 20,
  permissions: 25,
  comments: 30,
  commentChildren: 32,
  attachments: 35,
  restrictions: 38,
  adf: 45,
  versions: 50,
  version: 60,
  download: 70,
  confirm: 80,
} as const;

export interface SweepOptions {
  client?: ConfluenceClient;
  clientOptions?: Omit<ConfluenceClientOptions, "onRequest">;
  /** Upstream requests per site per run (default CONFLUENCE_SOURCE_MAX_REQUESTS_PER_RUN or 300). */
  maxRequestsPerSite?: number;
  maxMillisPerSite?: number;
  fullScanIntervalMs?: number;
  deltaIntervalMs?: number;
  deltaOverlapMs?: number;
  siteRefreshMs?: number;
  maxAttachmentBytes?: number;
  maxItemAttempts?: number;
  captureAdf?: boolean;
  leaseOwner?: string;
  leaseSeconds?: number;
  heartbeat?: () => Promise<void>;
}

export interface SiteRunReport {
  connectionId: string;
  cloudId: string;
  outcome: "ran" | "deferred" | "lease_busy" | "blocked" | "error";
  requests: number;
  items: number;
  generation?: number;
  phase?: string;
  deferredUntil?: string;
  error?: string;
}

export interface SweepReport {
  tenantId: string;
  connections: number;
  sites: SiteRunReport[];
  notes: string[];
}

interface Ctx {
  db: DbExecutor;
  scope: SiteScope;
  target: ConfluenceTarget;
  client: ConfluenceClient;
  budget: Budget;
  opts: Required<Pick<SweepOptions, "maxAttachmentBytes" | "maxItemAttempts" | "captureAdf" | "deltaOverlapMs">>;
  generation: number;
}

class Budget {
  requests = 0;
  readonly #deadline: number;
  constructor(
    readonly maxRequests: number,
    maxMillis: number,
  ) {
    this.#deadline = Date.now() + maxMillis;
  }
  count(): void {
    this.requests += 1;
  }
  get exhausted(): boolean {
    return this.requests >= this.maxRequests || Date.now() >= this.#deadline;
  }
}

/** Yielded when a listing item must stop for budget; its checkpoint is already stored. */
class Yield extends Error {}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function redact(payload: Record<string, unknown>): Record<string, unknown> {
  return redactProviderPayload(CONFLUENCE_PROVIDER, payload) as Record<string, unknown>;
}

function resultsOf(r: JsonResult): Record<string, unknown>[] {
  const d = r.data;
  if (Array.isArray(d)) return d.filter(isRecord);
  return isRecord(d) && Array.isArray(d.results) ? d.results.filter(isRecord) : [];
}

function nextLinkOf(r: JsonResult): string | null {
  const links = isRecord(r.data) ? r.data._links : null;
  return isRecord(links) ? str(links.next) : null;
}

function containerApi(type: ContainerType): string {
  return type === "page" ? "pages" : "blogposts";
}

function commentApi(type: CommentType): string {
  return type === "footer_comment" ? "footer-comments" : "inline-comments";
}

function byIdPath(type: ConfluenceContentType, id: string): string {
  const e = encodeURIComponent(id);
  switch (type) {
    case "space":
      return `/wiki/api/v2/spaces/${e}`;
    case "page":
      return `/wiki/api/v2/pages/${e}`;
    case "blogpost":
      return `/wiki/api/v2/blogposts/${e}`;
    case "footer_comment":
      return `/wiki/api/v2/footer-comments/${e}`;
    case "inline_comment":
      return `/wiki/api/v2/inline-comments/${e}`;
    case "attachment":
      return `/wiki/api/v2/attachments/${e}`;
  }
}

// ------------------------------------------------------------------ entry points

export interface ConfluenceConnectionRow {
  connectionId: string;
  providerConfigKey: string;
  status: string;
}

export async function confluenceConnections(db: DbExecutor, tenantId: string): Promise<ConfluenceConnectionRow[]> {
  const rs = rowsOf<{ external_account_id: string | null; nango_connection_id: string | null; provider_config_key: string | null; status: string }>(
    await db.execute(sql`
      SELECT external_account_id, metadata->>'nangoConnectionId' AS nango_connection_id, metadata->>'providerConfigKey' AS provider_config_key, status
      FROM connections WHERE tenant_id = ${tenantId} AND provider = ${CONFLUENCE_PROVIDER}
      ORDER BY created_at, id
    `),
  );
  const out: ConfluenceConnectionRow[] = [];
  for (const r of rs) {
    const connectionId = str(r.external_account_id) ?? str(r.nango_connection_id);
    if (!connectionId) continue;
    out.push({ connectionId, providerConfigKey: str(r.provider_config_key) ?? CONFLUENCE_PROVIDER, status: r.status });
  }
  return out;
}

export async function runConfluenceSweep(db: DbExecutor, tenantId: string, options: SweepOptions = {}): Promise<SweepReport> {
  const report: SweepReport = { tenantId, connections: 0, sites: [], notes: [] };
  const conns = (await confluenceConnections(db, tenantId)).filter((c) => c.status === "active");
  report.connections = conns.length;
  if (!conns.length) return report;
  const owner = options.leaseOwner ?? `${hostname().slice(0, 60)}:${process.pid}:${randomBytes(4).toString("hex")}`;
  for (const conn of conns) {
    // Accessible-resources is counted against no site budget (one call per refresh interval).
    const discoveryClient = options.client ?? new ConfluenceClient(options.clientOptions);
    try {
      await refreshSites(db, discoveryClient, tenantId, conn, options.siteRefreshMs ?? 60 * 60_000);
    } catch (error) {
      if (error instanceof ConfluenceAuthError) {
        for (const s of await listSites(db, tenantId, conn.connectionId)) {
          await setSiteStatus(db, { tenantId, connectionId: conn.connectionId, cloudId: s.cloud_id }, "blocked", error.message);
        }
        report.notes.push(`connection ${conn.connectionId}: ${error.message}`);
        if (!(await listSites(db, tenantId, conn.connectionId)).length) {
          report.sites.push({ connectionId: conn.connectionId, cloudId: "", outcome: "blocked", requests: 0, items: 0, error: error.message });
        }
        continue;
      }
      report.notes.push(`connection ${conn.connectionId}: site discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const site of await listSites(db, tenantId, conn.connectionId)) {
      if (site.status !== "active") continue;
      report.sites.push(await runSite(db, { tenantId, connectionId: conn.connectionId, cloudId: site.cloud_id }, { ...conn, siteUrl: site.site_url }, owner, options));
    }
  }
  return report;
}

/** Atlassian sites whose granted scopes include Confluence; removed sites keep their content (access lost is not deletion). */
export async function refreshSites(db: DbExecutor, client: ConfluenceClient, tenantId: string, conn: ConfluenceConnectionRow, refreshMs: number): Promise<void> {
  const existing = await listSites(db, tenantId, conn.connectionId);
  const fresh = existing.length > 0 && existing.every((s) => s.status === "active" && Date.now() - new Date(String(s.last_seen_at)).getTime() < refreshMs);
  if (fresh) return;
  const resources = await client.accessibleResources(conn);
  const keep: string[] = [];
  for (const r of resources) {
    const cloudId = str(r.id);
    if (!cloudId) continue;
    const scopes = Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [];
    if (scopes.length && !scopes.some((s) => s.includes("confluence"))) continue;
    keep.push(cloudId);
    await upsertSite(db, { tenantId, connectionId: conn.connectionId, cloudId, providerConfigKey: conn.providerConfigKey, siteUrl: str(r.url), siteName: str(r.name), scopes, status: "active" });
  }
  await markSitesRemoved(db, tenantId, conn.connectionId, keep, "site not returned by accessible-resources for this grant (access removed or app uninstalled); captured content is kept");
}

async function runSite(db: DbExecutor, scope: SiteScope, conn: ConfluenceConnectionRow & { siteUrl: string | null }, owner: string, options: SweepOptions): Promise<SiteRunReport> {
  const quotaKey = quotaKeyFor(conn.providerConfigKey, scope.cloudId);
  const base: SiteRunReport = { connectionId: scope.connectionId, cloudId: scope.cloudId, outcome: "ran", requests: 0, items: 0 };
  await ensureSyncState(db, { ...scope, providerConfigKey: conn.providerConfigKey, quotaKey });
  const blocked = await quotaBlockedUntil(db, quotaKey);
  if (blocked) return { ...base, outcome: "deferred", deferredUntil: blocked.toISOString() };
  const leaseSeconds = options.leaseSeconds ?? 600;
  if (!(await acquireQuotaLease(db, quotaKey, owner, leaseSeconds))) return { ...base, outcome: "lease_busy" };
  const budget = new Budget(options.maxRequestsPerSite ?? envInt("CONFLUENCE_SOURCE_MAX_REQUESTS_PER_RUN", 300), options.maxMillisPerSite ?? 4 * 60_000);
  const client = options.client ?? new ConfluenceClient({ ...options.clientOptions });
  const counted = new Proxy(client, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "get" || prop === "next" || prop === "download") {
        return (...args: unknown[]) => {
          budget.count();
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
  const target: ConfluenceTarget = { providerConfigKey: conn.providerConfigKey, connectionId: scope.connectionId, cloudId: scope.cloudId, siteUrl: conn.siteUrl };
  let items = 0;
  try {
    let state = (await getSyncState(db, scope))!;
    const fullEvery = options.fullScanIntervalMs ?? envInt("CONFLUENCE_SOURCE_FULL_SCAN_INTERVAL_MS", 24 * 60 * 60_000);
    if (state.generation === 0) {
      await beginGeneration(db, scope, "initial");
    } else if (state.generation_phase === "closed" && Date.now() - new Date(String(state.generation_started_at)).getTime() >= fullEvery) {
      await beginGeneration(db, scope, "scheduled");
    }
    state = (await getSyncState(db, scope))!;
    const ctx: Ctx = {
      db,
      scope,
      target,
      client: counted,
      budget,
      generation: state.generation,
      opts: {
        maxAttachmentBytes: options.maxAttachmentBytes ?? envInt("CONFLUENCE_SOURCE_MAX_ATTACHMENT_BYTES", 256 * 1024 * 1024),
        maxItemAttempts: options.maxItemAttempts ?? 5,
        captureAdf: options.captureAdf ?? process.env.CONFLUENCE_SOURCE_CAPTURE_ADF !== "0",
        deltaOverlapMs: options.deltaOverlapMs ?? 10 * 60_000,
      },
    };
    await maybeArmDelta(ctx, state, options.deltaIntervalMs ?? 5 * 60_000);

    for (;;) {
      if (budget.exhausted) break;
      const batch = await nextWork(db, scope, 25);
      if (!batch.length) {
        const advanced = await advanceGeneration(ctx);
        if (!advanced) break;
        continue;
      }
      for (const item of batch) {
        if (budget.exhausted) break;
        items += 1;
        await processItem(ctx, item);
        await options.heartbeat?.();
        if (items % 20 === 0 && !(await renewQuotaLease(db, quotaKey, owner, leaseSeconds))) throw new Error("confluence sweep lease lost");
      }
    }
    await recordRunOutcome(db, scope, { ok: true });
    await clearRateStreak(db, quotaKey);
    const after = (await getSyncState(db, scope))!;
    return { ...base, requests: budget.requests, items, generation: after.generation, phase: after.generation_phase };
  } catch (error) {
    if (error instanceof ConfluenceRateLimitedError) {
      const until = await recordRateLimited(db, quotaKey, { retryAfterMs: error.retryAfterMs, status: error.status, reason: error.message, defaultBackoffMs: DEFAULT_RATE_LIMIT_BACKOFF_MS });
      await recordRunOutcome(db, scope, { ok: false, error: `rate limited until ${until.toISOString()}` });
      return { ...base, outcome: "deferred", requests: budget.requests, items, deferredUntil: until.toISOString() };
    }
    if (error instanceof ConfluenceAuthError) {
      await setSiteStatus(db, scope, "blocked", error.message);
      await recordRunOutcome(db, scope, { ok: false, error: error.message, blockedCode: "auth", blockedReason: error.message });
      return { ...base, outcome: "blocked", requests: budget.requests, items, error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    await recordRunOutcome(db, scope, { ok: false, error: message });
    return { ...base, outcome: "error", requests: budget.requests, items, error: message };
  } finally {
    await releaseQuotaLease(db, quotaKey, owner);
  }
}

async function beginGeneration(db: DbExecutor, scope: SiteScope, reason: string): Promise<void> {
  const g = await startGeneration(db, scope, reason);
  await enqueueWork(db, scope, g, [{ itemKey: "spaces", kind: "spaces", priority: PRIORITY.spaces, payload: { cursor: null } }], { restart: true });
}

async function maybeArmDelta(ctx: Ctx, state: { delta_watermark: unknown; delta_checked_at: unknown }, intervalMs: number): Promise<void> {
  const current = await workState(ctx.db, ctx.scope, "delta");
  if (current?.state === "pending") return;
  const checked = state.delta_checked_at ? new Date(String(state.delta_checked_at)).getTime() : 0;
  if (Date.now() - checked < intervalMs) return;
  const since = iso(state.delta_watermark) ?? new Date().toISOString();
  await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: "delta", kind: "delta", priority: PRIORITY.delta, payload: { since, startedAt: new Date().toISOString(), cursor: null } }], { restart: true });
}

/** scan -> confirm -> closed. Returns true when it enqueued more work. */
async function advanceGeneration(ctx: Ctx): Promise<boolean> {
  const state = (await getSyncState(ctx.db, ctx.scope))!;
  const g = state.generation;
  if (state.generation_phase === "closed") return false;
  if ((await pendingScanItems(ctx.db, ctx.scope, g)) > 0) return false;
  if (state.generation_phase === "scan") {
    const confirms = await missingObjectConfirmations(ctx, g);
    await setGenerationPhase(ctx.db, ctx.scope, g, "confirm", false);
    if (confirms.length) {
      await enqueueWork(ctx.db, ctx.scope, g, confirms);
      return true;
    }
  }
  const after = (await getSyncState(ctx.db, ctx.scope))!;
  const spaces = await workState(ctx.db, ctx.scope, "spaces");
  const complete = after.generation_failed_items === 0 && spaces?.state === "done" && spaces.generation === g;
  await setGenerationPhase(ctx.db, ctx.scope, g, "closed", complete);
  return false;
}

/** Objects not seen in generation g whose enclosing listing completed in g (deletion candidates, never deleted unconfirmed). */
async function missingObjectConfirmations(ctx: Ctx, g: number): Promise<WorkItem[]> {
  const out: WorkItem[] = [];
  const confirm = (type: ConfluenceContentType, id: string): WorkItem => ({ itemKey: `confirm:${type}:${id}`, kind: "confirm", priority: PRIORITY.confirm, payload: { type, id } });
  const done = async (key: string): Promise<boolean> => {
    const w = await workState(ctx.db, ctx.scope, key);
    return w?.state === "done" && w.generation === g;
  };
  if (await done("spaces")) {
    for (const s of await listObjects(ctx.db, ctx.scope, { types: ["space"], live: true, unseenBefore: g })) out.push(confirm("space", s.content_id));
  }
  for (const space of await listObjects(ctx.db, ctx.scope, { types: ["space"], live: true })) {
    if ((space.seen_generation ?? 0) < g) continue;
    for (const type of ["page", "blogpost"] as const) {
      if (!(await done(`content:${space.content_id}:${type}`))) continue;
      for (const c of await listObjects(ctx.db, ctx.scope, { types: [type], spaceId: space.content_id, live: true, unseenBefore: g })) out.push(confirm(type, c.content_id));
    }
  }
  for (const c of await listObjects(ctx.db, ctx.scope, { types: ["page", "blogpost"], live: true })) {
    if ((c.seen_generation ?? 0) < g) continue;
    for (const ct of ["footer_comment", "inline_comment"] as const) {
      if (!(await done(`comments:${c.content_type}:${c.content_id}:${ct}`))) continue;
      for (const m of await listObjects(ctx.db, ctx.scope, { types: [ct], containerId: c.content_id, live: true, unseenBefore: g })) {
        if (m.container_type === c.content_type) out.push(confirm(ct, m.content_id));
      }
    }
    if (await done(`attachments:${c.content_type}:${c.content_id}`)) {
      for (const a of await listObjects(ctx.db, ctx.scope, { types: ["attachment"], containerId: c.content_id, live: true, unseenBefore: g })) {
        if (a.container_type === c.content_type) out.push(confirm("attachment", a.content_id));
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ item dispatch

async function processItem(ctx: Ctx, item: WorkRow): Promise<void> {
  try {
    const outcome = await runItem(ctx, item);
    if (outcome.state === "inaccessible") await bumpGenerationCounter(ctx.db, ctx.scope, item.generation, "inaccessible");
    await finishWork(ctx.db, ctx.scope, item.item_key, outcome.state, outcome.outcome ?? null);
  } catch (error) {
    if (error instanceof Yield) return;
    if (error instanceof ConfluenceRateLimitedError || error instanceof ConfluenceAuthError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const attempts = await retryWorkLater(ctx.db, ctx.scope, item.item_key, message, Math.min(3600_000, 60_000 * 2 ** item.attempts));
    if (attempts >= ctx.opts.maxItemAttempts) {
      await finishWork(ctx.db, ctx.scope, item.item_key, "failed", null, message);
      await bumpGenerationCounter(ctx.db, ctx.scope, item.generation, "failed");
    }
  }
}

type ItemOutcome = { state: "done" | "inaccessible"; outcome?: Record<string, unknown> };

async function runItem(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const p = item.payload;
  switch (item.kind) {
    case "spaces":
      return listSpaces(ctx, item);
    case "content":
      return listSpaceContent(ctx, item);
    case "permissions":
      return listSpacePermissions(ctx, item);
    case "comments":
      return listComments(ctx, item);
    case "attachments":
      return listAttachments(ctx, item);
    case "restrictions":
      return captureRestrictions(ctx, p.containerType as ContainerType, String(p.containerId));
    case "adf":
      return captureAdf(ctx, p.containerType as ContainerType, String(p.containerId));
    case "versions":
      return listVersions(ctx, item);
    case "version":
      return captureVersionBody(ctx, p.containerType as ContainerType, String(p.containerId), Number(p.number));
    case "download":
      return downloadAttachment(ctx, item);
    case "confirm":
    case "refresh":
      return confirmObject(ctx, p.type as ConfluenceContentType, String(p.id), item.kind === "refresh");
    case "delta":
      return runDelta(ctx, item);
    default:
      throw new Error(`unknown confluence work item kind ${item.kind}`);
  }
}

/**
 * Page a listing: `first` fetches the first page, then `_links.next` is followed.
 * The cursor (next link) is checkpointed after `onPage` stored the page, so a
 * yield or crash resumes on the following page; the item finishes only when exhausted.
 */
async function pageThrough(
  ctx: Ctx,
  item: WorkRow,
  first: () => Promise<JsonResult>,
  onPage: (results: Record<string, unknown>[], r: JsonResult) => Promise<void>,
  tolerate: readonly number[] = [],
): Promise<{ status: number; pages: number; results: number }> {
  let pages = 0;
  let results = 0;
  for (;;) {
    const next = str(item.payload.cursor);
    const r = next ? await ctx.client.next(ctx.target, next, tolerate) : await first();
    if (r.status >= 300) return { status: r.status, pages, results };
    const rs = resultsOf(r);
    // onPage may add accumulated state to item.payload; it is checkpointed together with the cursor.
    await onPage(rs, r);
    pages += 1;
    results += rs.length;
    const link = nextLinkOf(r);
    if (!link || link === next || rs.length === 0) return { status: r.status, pages, results };
    item.payload = { ...item.payload, cursor: link };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
    if (ctx.budget.exhausted) throw new Yield();
  }
}

// ------------------------------------------------------------------ spaces

async function listSpaces(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const r = await pageThrough(
    ctx,
    item,
    () => ctx.client.get(ctx.target, "/wiki/api/v2/spaces", { limit: PAGE_LIMIT, "description-format": "plain" }),
    async (spaces) => {
      for (const s of spaces) await captureSpace(ctx, s, "/wiki/api/v2/spaces");
    },
  );
  return { state: "done", outcome: { pages: r.pages, spaces: r.results } };
}

async function captureSpace(ctx: Ctx, payload: Record<string, unknown>, endpoint: string): Promise<void> {
  const id = str(payload.id);
  if (!id) return;
  const raw = redact(payload);
  await insertObservation(ctx.db, ctx.scope, "space", id, raw, endpoint, null, id);
  const res = await upsertObject(ctx.db, ctx.scope, { type: "space", id, spaceId: id, spaceKey: str(payload.key), status: str(payload.status), title: str(payload.name), versionNumber: null, versionCreatedAt: null, raw }, ctx.generation);
  if (res.restored) {
    for (const c of await listObjects(ctx.db, ctx.scope, { types: ["page", "blogpost"], spaceId: id })) {
      if (c.tombstone_reason === "space_not_found") await enqueueWork(ctx.db, ctx.scope, ctx.generation, [refreshItem(c.content_type, c.content_id)], { restart: true });
    }
  }
  await enqueueWork(ctx.db, ctx.scope, ctx.generation, [
    { itemKey: `content:${id}:page`, kind: "content", priority: PRIORITY.content, payload: { spaceId: id, type: "page", statuses: ["current", "archived"], cursor: null } },
    { itemKey: `content:${id}:blogpost`, kind: "content", priority: PRIORITY.content, payload: { spaceId: id, type: "blogpost", statuses: ["current"], cursor: null } },
    { itemKey: `trash:${id}:page`, kind: "content", priority: PRIORITY.content, payload: { spaceId: id, type: "page", statuses: ["trashed"], cursor: null } },
    { itemKey: `trash:${id}:blogpost`, kind: "content", priority: PRIORITY.content, payload: { spaceId: id, type: "blogpost", statuses: ["trashed"], cursor: null } },
    { itemKey: `permissions:${id}`, kind: "permissions", priority: PRIORITY.permissions, payload: { spaceId: id, cursor: null, acc: [] } },
  ]);
}

async function listSpacePermissions(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const spaceId = String(item.payload.spaceId);
  const key = objectRowKey(ctx.scope, "space", spaceId);
  const acc: unknown[] = Array.isArray(item.payload.acc) ? [...(item.payload.acc as unknown[])] : [];
  const r = await pageThrough(
    ctx,
    item,
    () => ctx.client.get(ctx.target, `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/permissions`, { limit: PAGE_LIMIT }, [401, 403, 404]),
    async (rs) => {
      // Accumulated assignments travel with the cursor checkpoint, so a resumed listing never double counts a page.
      acc.push(...rs.map(redact));
      item.payload = { ...item.payload, acc };
    },
    [401, 403, 404],
  );
  if (r.status === 401 || r.status === 403) {
    await setObjectFields(ctx.db, ctx.scope.tenantId, key, { permissionsStatus: r.status === 401 ? "scope_missing" : "forbidden" });
    return { state: "inaccessible", outcome: { status: r.status } };
  }
  if (r.status === 404) return { state: "inaccessible", outcome: { status: 404 } };
  await setObjectFields(ctx.db, ctx.scope.tenantId, key, { permissions: acc, permissionsStatus: "captured" });
  return { state: "done", outcome: { assignments: acc.length } };
}

// ------------------------------------------------------------------ pages / blog posts

async function listSpaceContent(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const spaceId = String(item.payload.spaceId);
  const type = item.payload.type as ContainerType;
  const statuses = Array.isArray(item.payload.statuses) ? (item.payload.statuses as string[]) : ["current"];
  const endpoint = `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/${containerApi(type)}`;
  const r = await pageThrough(
    ctx,
    item,
    () => ctx.client.get(ctx.target, endpoint, { limit: PAGE_LIMIT, "body-format": "storage", status: statuses }, [403, 404]),
    async (rs) => {
      for (const c of rs) await captureContainer(ctx, type, c, endpoint, { listing: true });
    },
    [403, 404],
  );
  if (r.status === 403 || r.status === 404) return { state: "inaccessible", outcome: { status: r.status } };
  return { state: "done", outcome: { pages: r.pages, results: r.results } };
}

function containerInput(type: ContainerType, payload: Record<string, unknown>, raw: Record<string, unknown>) {
  const version = isRecord(payload.version) ? payload.version : null;
  return {
    type,
    id: str(payload.id)!,
    spaceId: str(payload.spaceId),
    status: str(payload.status),
    title: str(payload.title),
    versionNumber: num(version?.number),
    versionCreatedAt: iso(version?.createdAt),
    raw,
  };
}

/**
 * Capture a page/blog post payload (v2 shape, storage body when requested).
 * Trashed/deleted -> tombstone with its comments and attachments; moved or
 * restored -> dependents re-derive their paths; new version -> version history,
 * ADF and (outside full listings, where they are queued anyway) children refresh.
 */
async function captureContainer(ctx: Ctx, type: ContainerType, payload: Record<string, unknown>, endpoint: string, opts: { listing: boolean; forceChildren?: boolean }): Promise<void> {
  const id = str(payload.id);
  if (!id) return;
  const raw = redact(payload);
  const input = containerInput(type, payload, raw);
  await insertObservation(ctx.db, ctx.scope, type, id, raw, endpoint, input.versionNumber, input.spaceId);
  const status = input.status ?? "current";
  if (status === "trashed" || status === "deleted" || status === "purged") {
    const res = await upsertObject(ctx.db, ctx.scope, { ...input, status, tombstoneReason: status }, ctx.generation);
    if (res.changed) await tombstoneContainer(ctx, type, id, input.spaceId, status);
    return;
  }
  const res = await upsertObject(ctx.db, ctx.scope, input, ctx.generation);
  if (res.moved || res.restored) await touchDependents(ctx.db, ctx.scope, type, id, input.spaceId);
  const n = input.versionNumber;
  if (n !== null && storageOf(payload) !== null) {
    await insertVersion(ctx.db, ctx.scope, type, id, n, raw, endpoint, input.spaceId);
  }
  const key = objectRowKey(ctx.scope, type, id);
  if (n !== null) {
    const have = await storedVersionNumbers(ctx.db, ctx.scope.tenantId, key);
    const missing = Array.from({ length: n }, (_, i) => i + 1).some((v) => !have.has(v));
    await setObjectFields(ctx.db, ctx.scope.tenantId, key, { historyThrough: await contiguousHistory(ctx.db, ctx.scope.tenantId, key) });
    if (missing) await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `versions:${type}:${id}`, kind: "versions", priority: PRIORITY.versions, payload: { containerType: type, containerId: id, cursor: null } }]);
  }
  const fresh = await findObject(ctx.db, ctx.scope, type, id);
  const items: WorkItem[] = [];
  if (ctx.opts.captureAdf && n !== null && fresh?.adf_version !== n) {
    items.push({ itemKey: `adf:${type}:${id}`, kind: "adf", priority: PRIORITY.adf, payload: { containerType: type, containerId: id } });
  }
  const children = opts.listing || opts.forceChildren || res.versionChanged || res.created || res.restored;
  if (children) items.push(...childItems(type, id));
  // Full listings re-check children every generation; delta/confirm refreshes re-arm them even within one.
  if (items.length) await enqueueWork(ctx.db, ctx.scope, ctx.generation, items, { restart: !opts.listing });
}

function childItems(type: ContainerType, id: string): WorkItem[] {
  return [
    { itemKey: `comments:${type}:${id}:footer_comment`, kind: "comments", priority: PRIORITY.comments, payload: { containerType: type, containerId: id, commentType: "footer_comment", cursor: null } },
    { itemKey: `comments:${type}:${id}:inline_comment`, kind: "comments", priority: PRIORITY.comments, payload: { containerType: type, containerId: id, commentType: "inline_comment", cursor: null } },
    { itemKey: `attachments:${type}:${id}`, kind: "attachments", priority: PRIORITY.attachments, payload: { containerType: type, containerId: id, cursor: null } },
    { itemKey: `restrictions:${type}:${id}`, kind: "restrictions", priority: PRIORITY.restrictions, payload: { containerType: type, containerId: id } },
  ];
}

function storageOf(payload: Record<string, unknown>): string | null {
  const body = isRecord(payload.body) ? payload.body : null;
  const storage = body && isRecord(body.storage) ? body.storage : null;
  return typeof storage?.value === "string" ? storage.value : null;
}

async function tombstoneContainer(ctx: Ctx, type: ContainerType, id: string, spaceId: string | null, reason: string): Promise<void> {
  const key = objectRowKey(ctx.scope, type, id);
  await tombstoneObject(ctx.db, ctx.scope.tenantId, key, reason);
  await tombstoneDependents(ctx.db, ctx.scope, type, id, reason);
  await touchDependents(ctx.db, ctx.scope, type, id, spaceId);
}

async function listVersions(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const type = item.payload.containerType as ContainerType;
  const id = String(item.payload.containerId);
  const key = objectRowKey(ctx.scope, type, id);
  const have = await storedVersionNumbers(ctx.db, ctx.scope.tenantId, key);
  const r = await pageThrough(
    ctx,
    item,
    () => ctx.client.get(ctx.target, `/wiki/api/v2/${containerApi(type)}/${encodeURIComponent(id)}/versions`, { limit: VERSION_LIMIT }, [403, 404]),
    async (rs) => {
      const missing: WorkItem[] = [];
      for (const v of rs) {
        const n = num(v.number);
        if (n === null || have.has(n)) continue;
        missing.push({ itemKey: `version:${type}:${id}:${n}`, kind: "version", priority: PRIORITY.version, payload: { containerType: type, containerId: id, number: n } });
      }
      await enqueueWork(ctx.db, ctx.scope, ctx.generation, missing);
    },
    [403, 404],
  );
  if (r.status === 403 || r.status === 404) return { state: "inaccessible", outcome: { status: r.status } };
  return { state: "done", outcome: { versions: r.results } };
}

/** Body of one historical version: GET /pages/{id}?version=n&body-format=storage (the version list carries metadata only). */
async function captureVersionBody(ctx: Ctx, type: ContainerType, id: string, n: number): Promise<ItemOutcome> {
  const endpoint = `/wiki/api/v2/${containerApi(type)}/${encodeURIComponent(id)}`;
  const r = await ctx.client.get(ctx.target, endpoint, { version: n, "body-format": "storage" }, [400, 403, 404]);
  if (r.status !== 200 && r.status !== 204) return { state: "inaccessible", outcome: { status: r.status, version: n } };
  if (!isRecord(r.data)) throw new ConfluenceApiError(`version ${n} of ${type} ${id} returned no object`, r.status, "bad_payload");
  const got = num(isRecord(r.data.version) ? r.data.version.number : null);
  if (got !== n) throw new ConfluenceApiError(`asked for version ${n} of ${type} ${id}, got ${got ?? "none"}`, r.status, "version_mismatch");
  const container = await findObject(ctx.db, ctx.scope, type, id);
  await insertVersion(ctx.db, ctx.scope, type, id, n, redact(r.data), `${endpoint}?version=${n}`, container?.space_id ?? str(r.data.spaceId));
  const key = objectRowKey(ctx.scope, type, id);
  await setObjectFields(ctx.db, ctx.scope.tenantId, key, { historyThrough: await contiguousHistory(ctx.db, ctx.scope.tenantId, key) });
  return { state: "done", outcome: { version: n } };
}

async function captureAdf(ctx: Ctx, type: ContainerType, id: string): Promise<ItemOutcome> {
  const endpoint = `/wiki/api/v2/${containerApi(type)}/${encodeURIComponent(id)}`;
  const r = await ctx.client.get(ctx.target, endpoint, { "body-format": "atlas_doc_format" }, [403, 404]);
  if (r.status === 403 || r.status === 404 || !isRecord(r.data)) return { state: "inaccessible", outcome: { status: r.status } };
  const raw = redact(r.data);
  const version = num(isRecord(r.data.version) ? r.data.version.number : null);
  await insertObservation(ctx.db, ctx.scope, type, id, raw, `${endpoint}?body-format=atlas_doc_format`, version, str(r.data.spaceId));
  const body = isRecord(raw.body) ? raw.body : null;
  const adf = body && isRecord(body.atlas_doc_format) ? body.atlas_doc_format.value : null;
  let doc: unknown = adf ?? null;
  if (typeof adf === "string") {
    try {
      doc = JSON.parse(adf) as unknown;
    } catch {
      doc = adf;
    }
  }
  await setObjectFields(ctx.db, ctx.scope.tenantId, objectRowKey(ctx.scope, type, id), { adf: doc, adfVersion: version });
  return { state: "done", outcome: { version } };
}

async function captureRestrictions(ctx: Ctx, type: ContainerType, id: string): Promise<ItemOutcome> {
  const key = objectRowKey(ctx.scope, type, id);
  const r = await ctx.client.get(ctx.target, `/wiki/rest/api/content/${encodeURIComponent(id)}/restriction`, { expand: "restrictions.user,restrictions.group", limit: 100 }, [401, 403, 404]);
  if (r.status === 401 || r.status === 403) {
    await setObjectFields(ctx.db, ctx.scope.tenantId, key, { restrictionsStatus: r.status === 401 ? "scope_missing" : "forbidden" });
    return { state: "inaccessible", outcome: { status: r.status } };
  }
  if (r.status === 404) return { state: "inaccessible", outcome: { status: 404 } };
  await setObjectFields(ctx.db, ctx.scope.tenantId, key, { restrictions: resultsOf(r).map(redact), restrictionsStatus: "captured" });
  return { state: "done" };
}

// ------------------------------------------------------------------ comments

async function listComments(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const containerType = item.payload.containerType as ContainerType;
  const containerId = String(item.payload.containerId);
  const commentType = item.payload.commentType as CommentType;
  const parent = str(item.payload.parentCommentId);
  const endpoint = parent
    ? `/wiki/api/v2/${commentApi(commentType)}/${encodeURIComponent(parent)}/children`
    : `/wiki/api/v2/${containerApi(containerType)}/${encodeURIComponent(containerId)}/${commentApi(commentType)}`;
  const r = await pageThrough(
    ctx,
    item,
    () => ctx.client.get(ctx.target, endpoint, { limit: COMMENT_LIMIT, "body-format": "storage" }, [403, 404]),
    async (rs) => {
      const children: WorkItem[] = [];
      let changed = false;
      for (const c of rs) {
        const res = await captureComment(ctx, commentType, c, containerType, containerId, parent, endpoint);
        if (res?.changed) changed = true;
        if (res) children.push(commentChildrenItem(containerType, containerId, commentType, res.id));
      }
      await enqueueWork(ctx.db, ctx.scope, ctx.generation, children);
      if (changed) await bumpChildrenEpoch(ctx.db, ctx.scope, containerType, containerId);
    },
    [403, 404],
  );
  if (r.status === 403 || r.status === 404) return { state: "inaccessible", outcome: { status: r.status } };
  return { state: "done", outcome: { comments: r.results } };
}

function commentChildrenItem(containerType: ContainerType, containerId: string, commentType: CommentType, parent: string): WorkItem {
  return {
    itemKey: `comment-children:${commentType}:${parent}`,
    kind: "comments",
    priority: PRIORITY.commentChildren,
    payload: { containerType, containerId, commentType, parentCommentId: parent, cursor: null },
  };
}

async function captureComment(
  ctx: Ctx,
  commentType: CommentType,
  payload: Record<string, unknown>,
  containerType: ContainerType,
  containerId: string,
  parent: string | null,
  endpoint: string,
): Promise<{ id: string; changed: boolean } | null> {
  const id = str(payload.id);
  if (!id) return null;
  const raw = redact(payload);
  const version = isRecord(payload.version) ? payload.version : null;
  const container = await findObject(ctx.db, ctx.scope, containerType, containerId);
  const versionNumber = num(version?.number);
  await insertObservation(ctx.db, ctx.scope, commentType, id, raw, endpoint, versionNumber, container?.space_id ?? null);
  const res = await upsertObject(
    ctx.db,
    ctx.scope,
    {
      type: commentType,
      id,
      spaceId: container?.space_id ?? null,
      containerType,
      containerId,
      parentCommentId: str(payload.parentCommentId) ?? parent,
      status: str(payload.status),
      title: str(payload.title),
      versionNumber,
      versionCreatedAt: iso(version?.createdAt),
      raw,
    },
    ctx.generation,
  );
  return { id, changed: res.changed };
}

// ------------------------------------------------------------------ attachments

async function listAttachments(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const containerType = item.payload.containerType as ContainerType;
  const containerId = String(item.payload.containerId);
  const endpoint = `/wiki/api/v2/${containerApi(containerType)}/${encodeURIComponent(containerId)}/attachments`;
  const r = await pageThrough(
    ctx,
    item,
    () => ctx.client.get(ctx.target, endpoint, { limit: COMMENT_LIMIT }, [403, 404]),
    async (rs) => {
      let changed = false;
      for (const a of rs) changed = (await captureAttachment(ctx, a, containerType, containerId, endpoint)) || changed;
      if (changed) await bumpChildrenEpoch(ctx.db, ctx.scope, containerType, containerId);
    },
    [403, 404],
  );
  if (r.status === 403 || r.status === 404) return { state: "inaccessible", outcome: { status: r.status } };
  return { state: "done", outcome: { attachments: r.results } };
}

async function captureAttachment(ctx: Ctx, payload: Record<string, unknown>, containerType: ContainerType, containerId: string, endpoint: string): Promise<boolean> {
  const id = str(payload.id);
  if (!id) return false;
  const raw = redact(payload);
  const version = isRecord(payload.version) ? payload.version : null;
  const n = num(version?.number);
  const container = await findObject(ctx.db, ctx.scope, containerType, containerId);
  await insertObservation(ctx.db, ctx.scope, "attachment", id, raw, endpoint, n, container?.space_id ?? null);
  const status = str(payload.status) ?? "current";
  const gone = status === "trashed" || status === "deleted" || status === "purged";
  const res = await upsertObject(
    ctx.db,
    ctx.scope,
    { type: "attachment", id, spaceId: container?.space_id ?? null, containerType, containerId, status, title: str(payload.title), versionNumber: n, versionCreatedAt: iso(version?.createdAt), raw, tombstoneReason: gone ? status : null },
    ctx.generation,
  );
  const key = objectRowKey(ctx.scope, "attachment", id);
  if (gone) return res.changed;
  const current = await findObject(ctx.db, ctx.scope, "attachment", id);
  const settled = current?.binary_version === n && ["stored", "too_large"].includes(current?.binary_status ?? "");
  if (!settled) {
    if (current?.binary_status === null) await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: "pending" });
    await enqueueWork(
      ctx.db,
      ctx.scope,
      ctx.generation,
      [{ itemKey: `download:${id}`, kind: "download", priority: PRIORITY.download, payload: { attachmentId: id, containerType, containerId, version: n, fileSize: num(payload.fileSize), mediaType: str(payload.mediaType) } }],
      { restart: true },
    );
  }
  return res.changed;
}

/**
 * Exact attachment bytes through the authenticated proxy
 * (`/wiki/rest/api/content/{containerId}/child/attachment/{id}/download?version=n`),
 * streamed into <= 8 MiB chunks. Over the capture limit -> `too_large`
 * (reported as partial coverage, never silently dropped).
 */
async function downloadAttachment(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const id = String(item.payload.attachmentId);
  const containerId = String(item.payload.containerId);
  const version = num(item.payload.version);
  const key = objectRowKey(ctx.scope, "attachment", id);
  const declared = num(item.payload.fileSize);
  const current = await findObject(ctx.db, ctx.scope, "attachment", id);
  if (!current || current.tombstoned_at) return { state: "done", outcome: { skipped: "attachment no longer live" } };
  if (declared !== null && declared > ctx.opts.maxAttachmentBytes) {
    await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: "too_large", binaryVersion: version, binaryError: `declared ${declared} bytes > limit ${ctx.opts.maxAttachmentBytes}` });
    return { state: "done", outcome: { tooLarge: declared } };
  }
  const writer = new ChunkWriter(ctx.db, ctx.scope.tenantId);
  try {
    const r = await ctx.client.download(
      ctx.target,
      `/wiki/rest/api/content/${encodeURIComponent(containerId)}/child/attachment/${encodeURIComponent(id)}/download`,
      { version: version ?? undefined },
      (piece) => writer.write(piece),
      ctx.opts.maxAttachmentBytes,
      [401, 403, 404],
    );
    if (r.status === 401 || r.status === 403) {
      await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: r.status === 401 ? "scope_missing" : "forbidden", binaryVersion: version, binaryError: `HTTP ${r.status}` });
      return { state: "inaccessible", outcome: { status: r.status } };
    }
    if (r.status === 404) {
      await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: "missing", binaryVersion: version, binaryError: "HTTP 404" });
      await enqueueWork(ctx.db, ctx.scope, ctx.generation, [confirmItem("attachment", id)]);
      return { state: "inaccessible", outcome: { status: 404 } };
    }
    const blob = await writer.finish(r.sha256, r.size, r.mediaType);
    await setObjectFields(ctx.db, ctx.scope.tenantId, key, {
      binaryStatus: "stored",
      binarySha256: blob.sha256,
      binarySize: blob.size,
      binaryVersion: version,
      binaryMediaType: r.mediaType ?? str(current.raw.mediaType),
      binaryError: null,
    });
    return { state: "done", outcome: { size: blob.size, via: r.via } };
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) {
      await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: "too_large", binaryVersion: version, binaryError: error.message });
      return { state: "done", outcome: { tooLarge: error.size } };
    }
    throw error;
  }
}

// ------------------------------------------------------------------ confirmation / refresh

function confirmItem(type: ConfluenceContentType, id: string): WorkItem {
  return { itemKey: `confirm:${type}:${id}`, kind: "confirm", priority: PRIORITY.confirm, payload: { type, id } };
}

function refreshItem(type: ConfluenceContentType, id: string): WorkItem {
  return { itemKey: `refresh:${type}:${id}`, kind: "refresh", priority: PRIORITY.refresh, payload: { type, id } };
}

/**
 * GET one object by id. 200 -> re-capture (handles trash, moves, restores);
 * 404 -> tombstone `not_found` (Confluence answers 404 both for deleted content
 * and content this grant can no longer see; either way it left this
 * connection's view); 403 -> inaccessible, kept.
 */
async function confirmObject(ctx: Ctx, type: ConfluenceContentType, id: string, refresh: boolean): Promise<ItemOutcome> {
  const params: Record<string, string> = type === "page" || type === "blogpost" || type.endsWith("_comment") ? { "body-format": "storage" } : type === "space" ? { "description-format": "plain" } : {};
  const r = await ctx.client.get(ctx.target, byIdPath(type, id), params, [403, 404]);
  const key = objectRowKey(ctx.scope, type, id);
  const existing = await findObject(ctx.db, ctx.scope, type, id);
  if (r.status === 403) {
    if (existing) await markInaccessible(ctx.db, ctx.scope.tenantId, key, "HTTP 403 for this connection");
    return { state: "inaccessible", outcome: { status: 403 } };
  }
  if (r.status === 404) {
    if (!existing) return { state: "done", outcome: { status: 404, known: false } };
    if (type === "space") {
      await tombstoneSpace(ctx, id);
    } else if (type === "page" || type === "blogpost") {
      await tombstoneContainer(ctx, type, id, existing.space_id, "not_found");
    } else {
      await tombstoneObject(ctx.db, ctx.scope.tenantId, key, "not_found");
      if (existing.container_type && existing.container_id) await bumpChildrenEpoch(ctx.db, ctx.scope, existing.container_type as ConfluenceContentType, existing.container_id);
    }
    return { state: "done", outcome: { status: 404, tombstoned: true } };
  }
  if (!isRecord(r.data)) throw new ConfluenceApiError(`${type} ${id} returned no object`, r.status, "bad_payload");
  const endpoint = byIdPath(type, id);
  switch (type) {
    case "space":
      await captureSpace(ctx, r.data, endpoint);
      break;
    case "page":
    case "blogpost":
      await captureContainer(ctx, type, r.data, endpoint, { listing: false, forceChildren: refresh });
      break;
    case "footer_comment":
    case "inline_comment": {
      const containerType: ContainerType = str(r.data.blogPostId) ? "blogpost" : "page";
      const containerId = str(r.data.pageId) ?? str(r.data.blogPostId) ?? existing?.container_id;
      if (!containerId) return { state: "done", outcome: { status: 200, container: null } };
      const res = await captureComment(ctx, type, r.data, (existing?.container_type as ContainerType) ?? containerType, containerId, existing?.parent_comment_id ?? null, endpoint);
      if (res?.changed) await bumpChildrenEpoch(ctx.db, ctx.scope, (existing?.container_type as ContainerType) ?? containerType, containerId);
      break;
    }
    case "attachment": {
      const containerType: ContainerType = str(r.data.blogPostId) ? "blogpost" : "page";
      const containerId = str(r.data.pageId) ?? str(r.data.blogPostId) ?? existing?.container_id;
      if (!containerId) return { state: "done", outcome: { status: 200, container: null } };
      if (await captureAttachment(ctx, r.data, containerType, containerId, endpoint)) await bumpChildrenEpoch(ctx.db, ctx.scope, containerType, containerId);
      break;
    }
  }
  return { state: "done", outcome: { status: 200 } };
}

/** Whole-space deletion: the space and every page/blog post (with comments and attachments) in it. */
async function tombstoneSpace(ctx: Ctx, spaceId: string): Promise<void> {
  await tombstoneObject(ctx.db, ctx.scope.tenantId, objectRowKey(ctx.scope, "space", spaceId), "space_not_found");
  for (const c of await listObjects(ctx.db, ctx.scope, { types: ["page", "blogpost"], spaceId, live: true })) {
    await tombstoneContainer(ctx, c.content_type as ContainerType, c.content_id, spaceId, "space_not_found");
  }
}

// ------------------------------------------------------------------ delta

/**
 * CQL delta: content modified since the watermark (relative `now("-Nm")`, which
 * is timezone independent, plus an overlap). Only objects whose version differs
 * from the stored one are refreshed; the watermark advances to the window start
 * once the search is paged to exhaustion.
 */
async function runDelta(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const since = new Date(String(item.payload.since));
  const startedAt = new Date(String(item.payload.startedAt));
  const minutes = Math.max(1, Math.ceil((startedAt.getTime() - since.getTime() + ctx.opts.deltaOverlapMs) / 60_000));
  const cql = `type in (page, blogpost, comment, attachment) and lastmodified >= now("-${minutes}m") order by lastmodified asc`;
  let refreshed = 0;
  const r = await pageThrough(
    ctx,
    item,
    () => ctx.client.get(ctx.target, "/wiki/rest/api/content/search", { cql, limit: SEARCH_LIMIT, expand: "version,space,container" }),
    async (rs) => {
      const items: WorkItem[] = [];
      for (const c of rs) {
        const it = await deltaItemFor(ctx, c);
        if (it) items.push(it);
      }
      refreshed += items.length;
      await enqueueWork(ctx.db, ctx.scope, ctx.generation, items, { restart: true });
    },
  );
  await setDeltaWatermark(ctx.db, ctx.scope, startedAt);
  return { state: "done", outcome: { results: r.results, refreshed, minutes } };
}

async function deltaItemFor(ctx: Ctx, c: Record<string, unknown>): Promise<WorkItem | null> {
  const id = str(c.id);
  const type = str(c.type);
  if (!id || !type) return null;
  const version = num(isRecord(c.version) ? c.version.number : null);
  const container = isRecord(c.container) ? c.container : null;
  const containerType: ContainerType | null = str(container?.type) === "blogpost" ? "blogpost" : str(container?.type) === "page" ? "page" : null;
  const containerId = str(container?.id);
  if (type === "page" || type === "blogpost") {
    const known = await findObject(ctx.db, ctx.scope, type, id);
    if (known && known.version_number === version && !known.tombstoned_at && known.status === str(c.status)) return null;
    return refreshItem(type, id);
  }
  if (type === "comment") {
    const known = (await findObject(ctx.db, ctx.scope, "footer_comment", id)) ?? (await findObject(ctx.db, ctx.scope, "inline_comment", id));
    if (known && known.version_number === version && !known.tombstoned_at) return null;
    if (known) return refreshItem(known.content_type, id);
    if (!containerType || !containerId) return null;
    const extensions = isRecord(c.extensions) ? c.extensions : null;
    const commentType: CommentType = str(extensions?.location) === "inline" ? "inline_comment" : "footer_comment";
    return { itemKey: `comments:${containerType}:${containerId}:${commentType}`, kind: "comments", priority: PRIORITY.comments, payload: { containerType, containerId, commentType, cursor: null } };
  }
  if (type === "attachment") {
    const known = await findObject(ctx.db, ctx.scope, "attachment", id);
    if (known && known.version_number === version && !known.tombstoned_at) return null;
    if (!containerType || !containerId) return known ? refreshItem("attachment", id) : null;
    return { itemKey: `attachments:${containerType}:${containerId}`, kind: "attachments", priority: PRIORITY.attachments, payload: { containerType, containerId, cursor: null } };
  }
  return null;
}

// ------------------------------------------------------------------ task handler

export function confluenceTaskHandlers(options: SweepOptions = {}): Record<string, TaskHandler> {
  return {
    [CONFLUENCE_SWEEP_TASK]: async (payload, ctx) => {
      const { db } = await import("../../../db/client.js");
      // Tenant comes from the server-written task row; a payload tenant must agree with it.
      const tenantId = ctx.task.tenantId;
      if (typeof payload.tenantId === "string" && payload.tenantId !== tenantId) throw new Error("confluence.sweep payload tenant does not match the task tenant");
      const report = await runConfluenceSweep(db, tenantId, { ...options, heartbeat: async () => ctx.heartbeat() });
      return report as unknown as Record<string, unknown>;
    },
  };
}
