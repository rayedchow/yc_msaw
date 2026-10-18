/**
 * Linear source lane. Port of gigabrain f74c62ca8db7911c819c174bab9a2a34a2a52fc1 (origin/codex/linear-connector):
 * brain/src/linear/api.ts (GraphQL client, field selections, summaries), brain/src/jobs/linear-poll.ts (issue
 * snapshots `linear:issue:<id>:updated:<updatedAt>`) and brain/src/webhooks/linear.ts (Linear-Signature HMAC
 * over the raw body, `linear:webhook:<Linear-Delivery>`, 10-minute webhookTimestamp window).
 *
 * Changed on purpose:
 *  - Read-only. The donor's agent tools (issue create/update, comment, webhook create) are not ported, so no live
 *    webhook is installed.
 *  - Tenant binding: the webhook URL carries the connection id and its secret is per connection. The delivery's
 *    organizationId must be the connection's organization. The donor took a routing key in the query string.
 *  - Polling is fully paginated and covers issues, comments, projects and cycles, so capture never depends on an
 *    admin webhook. The donor polled 100 issues. Cursors are durable, and a delta watermark advances only after a
 *    complete pass.
 *  - Deletions: a `remove` webhook, archived/trashed objects (`includeArchived`), and objects missing from a
 *    completed full listing become tombstones.
 *  - Rate/complexity limits: a 429 or a GraphQL `RATELIMITED` error persists the reset time or Retry-After.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db as defaultDb } from "../../db/client.js";
import { upsertConnection } from "../../db/connections.js";
import { enqueueTask } from "../../queue/queue.js";
import { upsertTaskSchedule } from "../../queue/sweeper.js";
import { decrypt, encrypt } from "../../vault/encryption.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import type { AqueductIntegration, ConnectResult } from "../types.js";

type Executor = Pick<typeof defaultDb, "execute">;
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const WEBHOOK_MAX_TIMESTAMP_AGE_MS = 10 * 60_000;
export const LINEAR_SYNC_FREQUENCY_SECONDS = 300;
export const LINEAR_FULL_PASS_SECONDS = 12 * 3600;
export const RESOURCES = ["issue", "comment", "project", "cycle"] as const;
export type Resource = (typeof RESOURCES)[number];

// ---------------------------------------------------------------- donor field selections (verbatim)
const ISSUE_SUMMARY_FIELDS = `
  id
  identifier
  title
  url
  state { id name }
  assignee { id name email url }
  creator { id name email url }
  priority
  priorityLabel
  labels { nodes { id name color } }
  team { id name key description }
  project { id name state }
  createdAt
  updatedAt
`;
/** Donor ISSUE_DETAIL_FIELDS without the embedded first-20 comments (comments are paged on their own). */
const ISSUE_FIELDS = `
  ${ISSUE_SUMMARY_FIELDS}
  description
  parent { id identifier title }
  children { nodes { id identifier title state { id name } } }
  relations { nodes { type relatedIssue { id identifier title } } }
  archivedAt
  trashed
`;
const FIELDS: Record<Resource, { conn: string; fields: string; filterType: string }> = {
  issue: { conn: "issues", fields: ISSUE_FIELDS, filterType: "IssueFilter" },
  comment: { conn: "comments", fields: "id body url user { id name email url } issue { id identifier } parent { id } createdAt updatedAt archivedAt", filterType: "CommentFilter" },
  project: { conn: "projects", fields: "id name description state url lead { id name email } teams { nodes { id name key description } } startDate targetDate createdAt updatedAt archivedAt", filterType: "ProjectFilter" },
  cycle: { conn: "cycles", fields: "id name number description startsAt endsAt progress team { id name key description } createdAt updatedAt archivedAt", filterType: "CycleFilter" },
};

export class LinearApiError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string, readonly retryAfterSeconds: number | null) {
    super(message);
    this.name = "LinearApiError";
  }
}

export class LinearClient {
  constructor(private readonly apiKey: string, private readonly fetchImpl: FetchImpl = fetch) {}

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { Authorization: this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new LinearApiError(0, "network", `Linear request failed: ${err instanceof Error ? err.message : String(err)}`, 30);
    }
    const resetMs = Number(res.headers.get("x-ratelimit-requests-reset") ?? res.headers.get("x-ratelimit-complexity-reset") ?? NaN);
    const retryHeader = Number(res.headers.get("retry-after") ?? NaN);
    const retryAfter = Number.isFinite(retryHeader) ? Math.ceil(retryHeader) : Number.isFinite(resetMs) ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000)) : 60;
    let body: { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      if (!res.ok) throw new LinearApiError(res.status, null, `Linear GraphQL request failed: ${res.status}`, res.status === 429 || res.status >= 500 ? retryAfter : null);
      throw new LinearApiError(res.status, null, "Linear GraphQL response was not valid JSON", null);
    }
    const codes = (body.errors ?? []).map((e) => e.extensions?.code ?? "").filter(Boolean);
    if (res.status === 429 || codes.includes("RATELIMITED")) throw new LinearApiError(429, "RATELIMITED", "Linear rate limit (requests or complexity)", retryAfter);
    if (res.status === 401 || codes.includes("AUTHENTICATION_ERROR")) throw new LinearApiError(401, "AUTHENTICATION_ERROR", "Linear rejected the API key", null);
    if (!res.ok) throw new LinearApiError(res.status, codes[0] ?? null, `Linear GraphQL request failed: ${res.status}`, res.status >= 500 ? 30 : null);
    if (body.errors?.length) throw new LinearApiError(400, codes[0] ?? null, `Linear GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`, null);
    if (!body.data) throw new LinearApiError(500, null, "Linear GraphQL returned no data", null);
    return body.data;
  }

  viewer(): Promise<{ viewer: { id: string; organization: { id: string; name: string; urlKey?: string | null } } }> {
    return this.graphql(`query { viewer { id name email url organization { id name urlKey } } }`);
  }

  async page(resource: Resource, opts: { after?: string | null; updatedSince?: string | null }): Promise<{ nodes: Array<Record<string, unknown> & { id: string }>; hasNextPage: boolean; endCursor: string | null }> {
    const f = FIELDS[resource];
    const filter = opts.updatedSince ? { updatedAt: { gte: opts.updatedSince } } : null;
    const data = await this.graphql<Record<string, { nodes: Array<Record<string, unknown> & { id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>>(
      `query ($first: Int!, $after: String${filter ? `, $filter: ${f.filterType}` : ""}) {
        ${f.conn}(first: $first, after: $after, orderBy: updatedAt, includeArchived: true${filter ? ", filter: $filter" : ""}) {
          nodes { ${f.fields} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: 100, after: opts.after ?? null, ...(filter ? { filter } : {}) },
    );
    const conn = data[f.conn]!;
    return { nodes: conn.nodes, hasNextPage: conn.pageInfo.hasNextPage, endCursor: conn.pageInfo.endCursor };
  }
}

/** Donor summarizeLinearIssue (kept in the raw snapshot exactly as the donor stored it). */
export function summarizeLinearIssue(issue: Record<string, any>): Record<string, unknown> {
  const user = (u: any) => (u ? { id: u.id, name: u.name ?? null, email: u.email ?? null, url: u.url ?? null } : null);
  return {
    id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url ?? null,
    status: issue.state?.name ?? null, state_id: issue.state?.id ?? null,
    assignee: user(issue.assignee), creator: user(issue.creator),
    priority: issue.priority ?? null, priority_label: issue.priorityLabel ?? null,
    labels: (issue.labels?.nodes ?? []).map((l: any) => ({ id: l.id, name: l.name, color: l.color ?? null })),
    team: issue.team ? { id: issue.team.id, name: issue.team.name, key: issue.team.key } : null,
    project: issue.project ? { id: issue.project.id, name: issue.project.name, state: issue.project.state ?? null } : null,
    created_at: issue.createdAt, updated_at: issue.updatedAt,
  };
}

/** Donor verifyLinearSignature: hex HMAC-SHA256 of the raw body. */
export function verifyLinearSignature(rawBody: string, signature: string, secret: string): boolean {
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const expected = Buffer.from(computed, "hex");
    const actual = Buffer.from(signature, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- connections

const seal = (id: string, t: string, f: string, v: string) => encrypt(JSON.stringify({ c: id, t, f, v }));
function unseal(id: string, t: string, f: string, ct: string): string {
  const p = JSON.parse(decrypt(ct)) as { c?: string; t?: string; f?: string; v?: string };
  if (p.c !== id || p.t !== t || p.f !== f || typeof p.v !== "string") throw new Error("Linear credential does not belong to this connection");
  return p.v;
}

export interface LinearDeps {
  executor?: Executor;
  fetchImpl?: FetchImpl;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export async function listLinearConnections(tenantId: string, ex: Executor = defaultDb) {
  return rowsOf<Record<string, unknown>>(await ex.execute(sql`
    SELECT id, organization_id, organization_key, status, status_reason, last_webhook_at, created_at FROM linear_connections WHERE tenant_id = ${tenantId} ORDER BY created_at, id
  `));
}

export async function connectLinear(input: { tenantId: string; body: unknown }, deps: LinearDeps = {}): Promise<ConnectResult> {
  const ex = deps.executor ?? defaultDb;
  const env = deps.env ?? process.env;
  const bad = (message: string, code = "invalid_input", status = 400): ConnectResult => ({ status, body: { error: { code, message } } });
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !["apiKey", "list"].includes(k));
  if (unknown.length) return bad(`Unknown field(s): ${unknown.join(", ")}`);
  if (body.list === true) return { status: 200, body: { connections: await listLinearConnections(input.tenantId, ex) } };
  if (typeof body.apiKey !== "string" || !/^lin_api_[A-Za-z0-9]{20,100}$/.test(body.apiKey)) return bad("apiKey must be a Linear personal API key (lin_api_…)");
  let viewer;
  try {
    viewer = (await new LinearClient(body.apiKey, deps.fetchImpl).viewer()).viewer;
  } catch (err) {
    if (err instanceof LinearApiError && err.status === 401) return bad("Linear rejected the API key", "invalid_api_key");
    return bad(`Could not verify the key: ${(err as Error).message}`, "linear_unreachable", 502);
  }
  const id = `lc_${randomBytes(12).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  await ex.execute(sql`
    INSERT INTO linear_connections (id, tenant_id, organization_id, organization_key, viewer_id, api_key_ciphertext, webhook_secret_ciphertext)
    VALUES (${id}, ${input.tenantId}, ${viewer.organization.id}, ${viewer.organization.urlKey ?? null}, ${viewer.id},
      ${seal(id, input.tenantId, "api_key", body.apiKey)}, ${seal(id, input.tenantId, "webhook_secret", secret)})
  `);
  await upsertConnection({ tenantId: input.tenantId, provider: "linear", externalAccountId: viewer.organization.id, status: "active", metadata: { connectionId: id } }, ex);
  await upsertTaskSchedule({ tenantId: input.tenantId, kind: "linear.sync", frequencySeconds: LINEAR_SYNC_FREQUENCY_SECONDS, queue: "sync", groupKey: `${input.tenantId}:linear` }, ex);
  await enqueueTask({ queue: "backfill", tenantId: input.tenantId, kind: "linear.sync", groupKey: `${input.tenantId}:linear`, dedupeKey: `${input.tenantId}:linear.sync:${id}`, payload: {} }, ex);
  const base = (env.SOURCES_RUNTIME_PUBLIC_URL ?? env.WEBHOOK_BASE_URL)?.trim().replace(/\/+$/, "");
  return {
    status: 201,
    body: {
      connection: { id, organizationId: viewer.organization.id, organizationName: viewer.organization.name },
      webhook: base ? { url: `${base}/webhooks/linear/${id}`, secret, resourceTypes: ["Issue", "Comment", "Project", "Cycle"] } : null,
      note: "Shown once. Optionally create a Linear webhook (admin) with this URL and secret; capture does not depend on it (polling covers every resource).",
    },
  };
}

export async function disconnectLinear(input: { tenantId: string }, deps: LinearDeps = {}): Promise<void> {
  await (deps.executor ?? defaultDb).execute(sql`
    UPDATE linear_connections SET status = 'revoked', status_reason = 'disconnected', api_key_ciphertext = '', webhook_secret_ciphertext = '', revoked_at = now(), updated_at = now()
    WHERE tenant_id = ${input.tenantId} AND status <> 'revoked'
  `);
}

// ---------------------------------------------------------------- storage

function labelOf(resource: Resource, node: Record<string, any>): string | null {
  if (resource === "issue") return typeof node.identifier === "string" ? node.identifier : null;
  if (resource === "cycle") return typeof node.number === "number" ? `cycle-${node.number}` : null;
  if (resource === "project") return typeof node.name === "string" ? node.name : null;
  return null;
}

async function insertRaw(ex: Executor, tenantId: string, sourceEventId: string, eventType: string, at: string, payload: unknown, objectKey: string, kind: "snapshot" | "activity" | "tombstone"): Promise<boolean> {
  return rowsOf(await ex.execute(sql`
    INSERT INTO activity_events (user_id, source, event_type, timestamp, source_updated_at, wiki_eligibility_at, raw_payload, source_event_id,
      processing_status, source_namespace, source_object_id, record_kind)
    VALUES (${tenantId}, 'linear', ${eventType}, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz, ${JSON.stringify(payload)}::jsonb, ${sourceEventId},
      'received', 'tenant', ${objectKey}, ${kind})
    ON CONFLICT (user_id, source_event_id) DO NOTHING RETURNING id
  `)).length > 0;
}

/** One observed state: raw snapshot (donor id) + current object, never moving an object back in time. */
async function storeObject(ex: Executor, conn: { id: string; tenantId: string; organizationId: string }, resource: Resource, node: Record<string, any>, runId: string | null): Promise<void> {
  const payload = redactProviderPayload("linear", node) as Record<string, unknown>;
  const updated = iso(node.updatedAt) ?? new Date().toISOString();
  const raw = resource === "issue" ? { issue: payload, summary: summarizeLinearIssue(payload) } : { [resource]: payload };
  await insertRaw(ex, conn.tenantId, `linear:${resource}:${node.id}:updated:${node.updatedAt ?? updated}`, `${resource}.snapshot`, updated, raw, `${resource}:${node.id}`, "snapshot");
  const removed = node.trashed === true || (node.archivedAt != null && resource !== "project" && resource !== "cycle");
  await ex.execute(sql`
    INSERT INTO linear_objects (id, tenant_id, connection_id, organization_id, resource, object_id, label, payload, provider_updated_at, deleted, deleted_reason, last_seen_run)
    VALUES (${`${conn.id}:${resource}:${node.id}`}, ${conn.tenantId}, ${conn.id}, ${conn.organizationId}, ${resource}, ${node.id}, ${labelOf(resource, node)},
      ${JSON.stringify(payload)}::jsonb, ${updated}::timestamptz, ${removed}, ${removed ? (node.trashed ? "trashed" : "archived") : null}, ${runId})
    ON CONFLICT (id) DO UPDATE SET
      label = CASE WHEN EXCLUDED.provider_updated_at >= linear_objects.provider_updated_at THEN EXCLUDED.label ELSE linear_objects.label END,
      payload = CASE WHEN EXCLUDED.provider_updated_at >= linear_objects.provider_updated_at THEN EXCLUDED.payload ELSE linear_objects.payload END,
      deleted = CASE WHEN EXCLUDED.provider_updated_at >= linear_objects.provider_updated_at THEN EXCLUDED.deleted ELSE linear_objects.deleted END,
      deleted_reason = CASE WHEN EXCLUDED.provider_updated_at >= linear_objects.provider_updated_at THEN EXCLUDED.deleted_reason ELSE linear_objects.deleted_reason END,
      observed_at = CASE WHEN EXCLUDED.provider_updated_at > linear_objects.provider_updated_at OR EXCLUDED.deleted <> linear_objects.deleted THEN now() ELSE linear_objects.observed_at END,
      provider_updated_at = GREATEST(linear_objects.provider_updated_at, EXCLUDED.provider_updated_at),
      last_seen_run = COALESCE(EXCLUDED.last_seen_run, linear_objects.last_seen_run),
      updated_at = now()
  `);
}

// ---------------------------------------------------------------- sync

export async function runLinearSync(tenantId: string, deps: LinearDeps = {}): Promise<Array<{ connectionId: string; resource: string; status: string; nodes: number; reason?: string }>> {
  const ex = deps.executor ?? defaultDb;
  const now = deps.now ?? (() => new Date());
  const out: Array<{ connectionId: string; resource: string; status: string; nodes: number; reason?: string }> = [];
  const conns = rowsOf<Record<string, unknown>>(await ex.execute(sql`SELECT * FROM linear_connections WHERE tenant_id = ${tenantId} AND status = 'active' ORDER BY created_at`));
  const pageBudget = Math.max(1, Number(deps.env?.LINEAR_PAGES_PER_RUN ?? process.env.LINEAR_PAGES_PER_RUN ?? 20));
  for (const row of conns) {
    if (row.retry_at && Date.parse(String(row.retry_at)) > now().getTime()) {
      out.push({ connectionId: String(row.id), resource: "*", status: "skipped", nodes: 0, reason: "rate limited" });
      continue;
    }
    const conn = { id: String(row.id), tenantId, organizationId: String(row.organization_id) };
    const client = new LinearClient(unseal(conn.id, tenantId, "api_key", String(row.api_key_ciphertext)), deps.fetchImpl);
    let pages = 0;
    for (const resource of RESOURCES) {
      const owner = randomBytes(8).toString("hex");
      await ex.execute(sql`INSERT INTO linear_cursors (connection_id, resource, tenant_id) VALUES (${conn.id}, ${resource}, ${tenantId}) ON CONFLICT DO NOTHING`);
      const [cur] = rowsOf<Record<string, unknown>>(await ex.execute(sql`
        UPDATE linear_cursors SET lease_owner = ${owner}, lease_until = now() + interval '10 minutes'
        WHERE connection_id = ${conn.id} AND resource = ${resource} AND (lease_until IS NULL OR lease_until < now()) AND (retry_at IS NULL OR retry_at <= now())
        RETURNING *
      `));
      if (!cur) continue;
      // Full pass when never done or every LINEAR_FULL_PASS_SECONDS (deletion reconcile); otherwise a delta from the watermark.
      const lastFull = cur.last_full_at ? Date.parse(String(cur.last_full_at)) : 0;
      let mode = String(cur.mode);
      let after = (cur.after_cursor as string | null) ?? null;
      let runId = (cur.run_id as string | null) ?? null;
      if (!runId) {
        mode = !lastFull || now().getTime() - lastFull >= LINEAR_FULL_PASS_SECONDS * 1000 ? "full" : "delta";
        runId = randomBytes(8).toString("hex");
        after = null;
      }
      const watermark = cur.watermark ? new Date(Date.parse(String(cur.watermark)) - 60_000).toISOString() : null;
      let passMax = (cur.pass_max_updated as string | null) ? iso(cur.pass_max_updated) : null;
      let nodes = 0;
      const save = (u: Record<string, unknown>) => ex.execute(sql`
        UPDATE linear_cursors SET mode = ${(u.mode as string) ?? mode}, after_cursor = ${(u.after as string | null) ?? null}, run_id = ${(u.run as string | null) ?? null},
          pass_max_updated = ${(u.passMax as string | null) ?? null}::timestamptz,
          watermark = COALESCE(${(u.watermark as string | null) ?? null}::timestamptz, watermark),
          last_full_at = CASE WHEN ${u.fullDone === true} THEN now() ELSE last_full_at END,
          last_success_at = CASE WHEN ${u.success === true} THEN now() ELSE last_success_at END,
          status = ${(u.status as string) ?? "running"}, retry_at = ${u.retryAt ? (u.retryAt as Date).toISOString() : null}::timestamptz,
          attempts = ${(u.attempts as number) ?? 0}, last_error = ${(u.lastError as string | null) ?? null},
          lease_owner = CASE WHEN ${u.release === true} THEN NULL ELSE lease_owner END, lease_until = CASE WHEN ${u.release === true} THEN NULL ELSE lease_until END
        WHERE connection_id = ${conn.id} AND resource = ${resource} AND lease_owner = ${owner}
      `);
      try {
        let done = false;
        while (pages < pageBudget) {
          const page = await client.page(resource as Resource, { after, updatedSince: mode === "delta" ? watermark : null });
          pages++;
          for (const node of page.nodes) {
            await storeObject(ex, conn, resource as Resource, node, mode === "full" ? runId : null);
            nodes++;
            const u = iso(node.updatedAt);
            if (u && (!passMax || u > passMax)) passMax = u;
          }
          after = page.hasNextPage ? page.endCursor : null;
          await save({ after, run: runId, passMax, success: true });
          if (!after) {
            done = true;
            break;
          }
        }
        if (done) {
          if (mode === "full") {
            await ex.execute(sql`
              UPDATE linear_objects SET deleted = true, deleted_reason = 'not_in_full_listing', observed_at = now(), updated_at = now()
              WHERE connection_id = ${conn.id} AND resource = ${resource} AND NOT deleted AND last_seen_run IS DISTINCT FROM ${runId}
            `);
          }
          await save({ after: null, run: null, passMax: null, watermark: passMax, fullDone: mode === "full", success: true, status: "complete", release: true });
        } else {
          await save({ after, run: runId, passMax, success: true, status: "running", release: true });
        }
        out.push({ connectionId: conn.id, resource, status: done ? "complete" : "running", nodes });
      } catch (err) {
        const e = err instanceof LinearApiError ? err : new LinearApiError(0, null, (err as Error).message, 60);
        const attempts = Number(cur.attempts ?? 0) + 1;
        if (e.status === 401) {
          await save({ after, run: runId, passMax, status: "blocked", lastError: e.message, attempts, release: true });
          await ex.execute(sql`UPDATE linear_connections SET status = 'error', status_reason = 'invalid_api_key', updated_at = now() WHERE id = ${conn.id}`);
          out.push({ connectionId: conn.id, resource, status: "auth_failed", nodes, reason: e.message });
          break;
        }
        const delay = e.retryAfterSeconds ?? Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
        const retryAt = new Date(Date.now() + delay * 1000);
        // The page cursor is kept: the next run resumes at the failed page.
        await save({ after, run: runId, passMax, status: "error", retryAt, attempts, lastError: `${e.code === "RATELIMITED" ? "rate_limited" : "error"}: ${e.message}`, release: true });
        if (e.code === "RATELIMITED") {
          // Linear's limits are per API key: back off the whole connection.
          await ex.execute(sql`UPDATE linear_connections SET retry_at = ${retryAt.toISOString()}::timestamptz WHERE id = ${conn.id}`);
          out.push({ connectionId: conn.id, resource, status: "rate_limited", nodes, reason: `retry after ${delay}s` });
          break;
        }
        out.push({ connectionId: conn.id, resource, status: "error", nodes, reason: e.message });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- webhook

const TYPE_TO_RESOURCE: Record<string, Resource> = { Issue: "issue", Comment: "comment", Project: "project", Cycle: "cycle" };

export function createLinearWebhook(deps: LinearDeps = {}): Hono {
  const app = new Hono();
  app.post("/:connectionId", async (c) => {
    const ex = deps.executor ?? defaultDb;
    const signature = c.req.header("linear-signature");
    if (!signature) return c.json({ error: "Missing Linear-Signature header" }, 401);
    const deliveryId = c.req.header("linear-delivery");
    if (!deliveryId) return c.json({ error: "Missing Linear-Delivery header" }, 400);
    const raw = await c.req.text();
    const id = c.req.param("connectionId");
    const [row] = /^lc_[0-9a-f]{24}$/.test(id) ? rowsOf<Record<string, unknown>>(await ex.execute(sql`SELECT * FROM linear_connections WHERE id = ${id}`)) : [];
    if (!row || row.status !== "active") return c.json({ error: "Invalid signature" }, 401);
    const secret = unseal(String(row.id), String(row.tenant_id), "webhook_secret", String(row.webhook_secret_ciphertext));
    if (!verifyLinearSignature(raw, signature, secret)) return c.json({ error: "Invalid signature" }, 401);
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(raw) as Record<string, any>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof payload.webhookTimestamp === "number" && Math.abs((deps.now?.() ?? new Date()).getTime() - payload.webhookTimestamp) > WEBHOOK_MAX_TIMESTAMP_AGE_MS) {
      return c.json({ error: "Stale webhook timestamp" }, 401);
    }
    if (typeof payload.organizationId === "string" && payload.organizationId !== row.organization_id) return c.json({ error: "Delivery is for a different Linear organization" }, 401);
    const tenantId = String(row.tenant_id);
    const eventType = `${typeof payload.type === "string" && payload.type.trim() ? payload.type.trim() : "unknown"}.${typeof payload.action === "string" && payload.action.trim() ? payload.action.trim() : "unknown"}`;
    const stored = await insertRaw(ex, tenantId, `linear:webhook:${deliveryId}`, eventType, iso(payload.createdAt) ?? new Date().toISOString(), redactProviderPayload("linear", payload), `${String(payload.type ?? "object").toLowerCase()}:${payload.data?.id ?? deliveryId}`, payload.action === "remove" ? "tombstone" : "activity");
    const resource = TYPE_TO_RESOURCE[String(payload.type)];
    if (stored && resource && payload.data && typeof payload.data.id === "string") {
      const conn = { id: String(row.id), tenantId, organizationId: String(row.organization_id) };
      if (payload.action === "remove") {
        await ex.execute(sql`
          UPDATE linear_objects SET deleted = true, deleted_reason = 'removed', observed_at = now(), updated_at = now()
          WHERE id = ${`${conn.id}:${resource}:${payload.data.id}`} AND NOT deleted
        `);
      } else if (payload.data.updatedAt) {
        await storeObject(ex, conn, resource, payload.data, null);
      }
    }
    await ex.execute(sql`UPDATE linear_connections SET last_webhook_at = now() WHERE id = ${row.id}`);
    return c.json(stored ? { received: true, eventType } : { received: true, duplicate: true });
  });
  return app;
}

export const linearIntegration: AqueductIntegration = {
  id: "linear",
  connect: (input) => connectLinear(input),
  disconnect: (input) => disconnectLinear(input),
  registerHttp(app) {
    app.route("/webhooks/linear", createLinearWebhook());
  },
  taskKinds: () => ["linear.sync"],
  taskHandlers: () => ({
    // The tenant is the queued task's own tenant, never a payload field.
    "linear.sync": async (_payload, ctx) => ({ results: (await runLinearSync(ctx.task.tenantId)).map((r) => `${r.resource}:${r.status}`) }),
  }),
};

export const linearSha = (s: string) => createHash("sha256").update(s).digest("hex");
