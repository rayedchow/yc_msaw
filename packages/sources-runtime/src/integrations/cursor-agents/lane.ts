/**
 * Cursor background agents, read-only (port of gigabrain 9411c1a362fffb7e5a778080d991082810da2510
 * brain/src/polling/cursor-background-agents.ts + brain/src/webhooks/cursor-background-agents.ts).
 *
 * Kept from the donor:
 *  - API surface: `GET /v0/agents` (limit ≤ 100, `cursor`), `GET /v0/agents/{id}/conversation`, Bearer key.
 *  - Parsers `parseCursorAgent` / `parseCursorConversation`.
 *  - Event identities `cursor_background_agents:agent:<id>` and `cursor_background_agents:webhook:<X-Webhook-ID>`.
 *  - Webhook signature `X-Webhook-Signature: sha256=<HMAC-SHA256(secret, raw body)>`.
 *
 * Changed on purpose:
 *  - Only the read calls are ported. The donor's launch, follow-up and delete calls are not.
 *  - Raw snapshots are immutable versions (`…:agent:<id>:v:<sha16>`). The donor overwrote one row per agent.
 *  - The webhook URL is bound to a connection id (the donor used `/:userId`, a caller-chosen tenant), and the
 *    signing secret is per connection.
 *  - The listing cursor is persisted per page. Agents missing from a completed listing are tombstoned.
 *  - Conversations are fetched under a bounded budget, and a 429 persists Retry-After.
 *  - Cursor rate-limits the user/team behind a key, not a connection: the Retry-After cooldown is shared by every
 *    connection (any owner scope or tenant) holding the same key (cursor_agents_quota, keyed by a key fingerprint).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db as defaultDb } from "../../db/client.js";
import { parseRetryAfterSeconds } from "../../lib/retry-after.js";
import { upsertConnection } from "../../db/connections.js";
import { enqueueTask } from "../../queue/queue.js";
import { upsertTaskSchedule } from "../../queue/sweeper.js";
import { decrypt, encrypt } from "../../vault/encryption.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import type { AqueductIntegration, ConnectResult } from "../types.js";

export type Executor = Pick<typeof defaultDb, "execute">;
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export const CURSOR_BACKGROUND_AGENTS_PROVIDER = "cursor_background_agents";
export const CURSOR_BACKGROUND_AGENT_SNAPSHOT_EVENT = "background_agent_snapshot";
export const CURSOR_BACKGROUND_AGENT_WEBHOOK_EVENT = "background_agent_webhook";
export const CURSOR_CONVERSATION_EVENT = "background_agent_conversation";
const DEFAULT_CURSOR_API_BASE_URL = "https://api.cursor.com";
export const CURSOR_SYNC_FREQUENCY_SECONDS = 300;
const TERMINAL = new Set(["FINISHED", "ERROR", "EXPIRED", "CANCELLED", "DELETED"]);

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const intEnv = (env: NodeJS.ProcessEnv, n: string, f: number, min: number) => {
  const x = Math.floor(Number(env[n] ?? f));
  return Number.isFinite(x) ? Math.max(min, x) : f;
};

// ---------------------------------------------------------------- donor parsers (verbatim semantics)

export interface CursorBackgroundAgent {
  id: string;
  name?: string;
  status?: string;
  source: { repository?: string; ref?: string };
  target: { url?: string; branchName?: string; prUrl?: string; autoCreatePr?: boolean };
  createdAt?: string;
  summary?: string;
  raw: Record<string, unknown>;
}

export interface CursorBackgroundAgentConversation {
  id: string;
  messages: Array<{ id: string; type: string; text?: string; raw: Record<string, unknown> }>;
  raw: Record<string, unknown>;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
const optionalRecord = (v: unknown, label: string) => (v === undefined || v === null ? {} : assertRecord(v, label));

export function parseCursorAgent(raw: unknown): CursorBackgroundAgent {
  const record = assertRecord(raw, "Cursor agent");
  if (typeof record.id !== "string" || !record.id) throw new Error("Cursor agent missing id");
  const source = optionalRecord(record.source, `Cursor agent ${record.id} source`);
  const target = optionalRecord(record.target, `Cursor agent ${record.id} target`);
  return {
    id: record.id,
    name: typeof record.name === "string" && record.name ? record.name : undefined,
    status: typeof record.status === "string" && record.status ? record.status : undefined,
    source: { repository: typeof source.repository === "string" ? source.repository : undefined, ref: typeof source.ref === "string" ? source.ref : undefined },
    target: {
      url: typeof target.url === "string" && target.url ? target.url : undefined,
      branchName: typeof target.branchName === "string" ? target.branchName : undefined,
      prUrl: typeof target.prUrl === "string" ? target.prUrl : undefined,
      autoCreatePr: typeof target.autoCreatePr === "boolean" ? target.autoCreatePr : undefined,
    },
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : undefined,
    summary: typeof record.summary === "string" ? record.summary : undefined,
    raw: record,
  };
}

export function parseCursorConversation(raw: unknown): CursorBackgroundAgentConversation {
  const record = assertRecord(raw, "Cursor conversation");
  if (typeof record.id !== "string" || !record.id) throw new Error("Cursor conversation missing id");
  if (record.messages !== undefined && record.messages !== null && !Array.isArray(record.messages)) throw new Error(`Cursor conversation ${record.id} messages must be an array`);
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return {
    id: record.id,
    messages: messages.map((message) => {
      const msg = assertRecord(message, `Cursor conversation ${record.id} message`);
      if (typeof msg.id !== "string" || !msg.id) throw new Error(`Cursor conversation ${record.id} message missing id`);
      if (typeof msg.type !== "string" || !msg.type) throw new Error(`Cursor conversation ${record.id} message ${msg.id} has invalid type`);
      return { id: msg.id, type: msg.type, text: typeof msg.text === "string" ? msg.text : undefined, raw: msg };
    }),
    raw: record,
  };
}

export function cursorAgentSnapshotSourceEventId(agentId: string): string {
  return `cursor_background_agents:agent:${agentId}`;
}

export function verifyCursorWebhookSignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- read-only client

export class CursorApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds: number | null) {
    super(message);
    this.name = "CursorApiError";
  }
}

/** A request withheld because the key is cooling down after a 429 seen through another connection; nothing was sent. */
class CursorCooldownError extends CursorApiError {}

export class CursorAgentsClient {
  constructor(private readonly apiKey: string, private readonly apiBase = DEFAULT_CURSOR_API_BASE_URL, private readonly fetchImpl: FetchImpl = fetch) {}

  async #get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.apiBase);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${this.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new CursorApiError(0, `Cursor API request failed: ${err instanceof Error ? err.message : String(err)}`, 30);
    }
    const text = await res.text();
    if (!res.ok) {
      const retry = parseRetryAfterSeconds(res.headers.get("retry-after"), { responseDate: res.headers.get("date") });
      throw new CursorApiError(res.status, `Cursor API GET ${url.pathname} failed (${res.status})`, res.status === 429 ? retry ?? 60 : res.status >= 500 ? 30 : null);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new CursorApiError(res.status, `Cursor API GET ${url.pathname} returned invalid JSON`, null);
    }
  }

  async listAgents(opts: { limit?: number; cursor?: string } = {}): Promise<{ agents: CursorBackgroundAgent[]; nextCursor?: string }> {
    const record = assertRecord(await this.#get("/v0/agents", { limit: String(Math.max(1, Math.min(opts.limit ?? 100, 100))), ...(opts.cursor ? { cursor: opts.cursor } : {}) }), "Cursor list agents response");
    if (!Array.isArray(record.agents)) throw new Error("Cursor list agents response missing agents array");
    return { agents: record.agents.map(parseCursorAgent), nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : undefined };
  }

  async getConversation(agentId: string): Promise<CursorBackgroundAgentConversation> {
    return parseCursorConversation(await this.#get(`/v0/agents/${encodeURIComponent(agentId)}/conversation`));
  }
}

// ---------------------------------------------------------------- lane

export interface CursorDeps {
  executor?: Executor;
  fetchImpl?: FetchImpl;
  env?: NodeJS.ProcessEnv;
}

export interface CursorConnection {
  id: string;
  tenantId: string;
  apiBase: string;
  status: "active" | "revoked" | "error";
  statusReason: string | null;
  lastCompleteListingAt: string | null;
  lastPollAt: string | null;
  lastWebhookAt: string | null;
  lastError: string | null;
}

const toConn = (r: Record<string, unknown>): CursorConnection => ({
  id: String(r.id), tenantId: String(r.tenant_id), apiBase: String(r.api_base), status: r.status as CursorConnection["status"],
  statusReason: (r.status_reason as string | null) ?? null, lastCompleteListingAt: iso(r.last_complete_listing_at), lastPollAt: iso(r.last_poll_at),
  lastWebhookAt: iso(r.last_webhook_at), lastError: (r.last_error as string | null) ?? null,
});

function seal(id: string, tenantId: string, field: string, v: string): string {
  return encrypt(JSON.stringify({ c: id, t: tenantId, f: field, v }));
}
function unseal(id: string, tenantId: string, field: string, ct: string): string {
  const p = JSON.parse(decrypt(ct)) as { c?: string; t?: string; f?: string; v?: string };
  if (p.c !== id || p.t !== tenantId || p.f !== field || typeof p.v !== "string") throw new Error("Cursor credential does not belong to this connection");
  return p.v;
}

/** Cooldown key of what Cursor rate-limits behind an API key: a sha256 prefix of the key, never the key itself. */
export function cursorQuotaKey(apiKey: string): string {
  return `cursor:api_key:${sha256(`cursor_api_key:${apiKey}`).slice(0, 32)}`;
}

async function cursorCooldownUntil(ex: Executor, quotaKey: string): Promise<Date | null> {
  const [row] = rowsOf<{ blocked_until: unknown }>(await ex.execute(sql`SELECT blocked_until FROM cursor_agents_quota WHERE quota_key = ${quotaKey}`));
  const until = iso(row?.blocked_until);
  return until && Date.parse(until) > Date.now() ? new Date(until) : null;
}

/** Record a 429 for every connection holding this key; a later, shorter wait never shortens an earlier one. */
async function recordCursorRateLimit(ex: Executor, quotaKey: string, retryAfterSeconds: number): Promise<Date> {
  const until = new Date(Date.now() + retryAfterSeconds * 1000);
  const [row] = rowsOf<{ blocked_until: unknown }>(await ex.execute(sql`
    INSERT INTO cursor_agents_quota (quota_key, blocked_until, last_status, last_retry_after_seconds, rate_limit_count)
    VALUES (${quotaKey}, ${until.toISOString()}::timestamptz, 429, ${retryAfterSeconds}, 1)
    ON CONFLICT (quota_key) DO UPDATE SET
      blocked_until = GREATEST(COALESCE(cursor_agents_quota.blocked_until, EXCLUDED.blocked_until), EXCLUDED.blocked_until),
      last_status = 429, last_retry_after_seconds = EXCLUDED.last_retry_after_seconds,
      rate_limit_count = cursor_agents_quota.rate_limit_count + 1, updated_at = now()
    RETURNING blocked_until
  `));
  return new Date(iso(row?.blocked_until) ?? until.toISOString());
}

async function throwIfCursorCoolingDown(ex: Executor, quotaKey: string): Promise<void> {
  const until = await cursorCooldownUntil(ex, quotaKey);
  if (until) throw new CursorCooldownError(429, `Cursor API key cooling down until ${until.toISOString()}`, Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)));
}

export async function listCursorConnections(tenantId: string, ex: Executor = defaultDb): Promise<CursorConnection[]> {
  return rowsOf<Record<string, unknown>>(await ex.execute(sql`SELECT * FROM cursor_agents_connections WHERE tenant_id = ${tenantId} ORDER BY created_at, id`)).map(toConn);
}

function normalizeApiBase(raw: string | undefined): string {
  const u = new URL(raw?.trim() || DEFAULT_CURSOR_API_BASE_URL);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error("apiBase must be an https URL without credentials, query or fragment");
  if (u.hostname !== "api.cursor.com") throw new Error("apiBase host must be api.cursor.com");
  return u.origin;
}

export async function connectCursorAgents(input: { tenantId: string; body: unknown }, deps: CursorDeps = {}): Promise<ConnectResult> {
  const ex = deps.executor ?? defaultDb;
  const env = deps.env ?? process.env;
  const bad = (message: string, code = "invalid_input", status = 400): ConnectResult => ({ status, body: { error: { code, message } } });
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !["apiKey", "apiBase", "list"].includes(k));
  if (unknown.length) return bad(`Unknown field(s): ${unknown.join(", ")}`);
  if (body.list === true) return { status: 200, body: { connections: await listCursorConnections(input.tenantId, ex) } };
  if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8 || body.apiKey.length > 500) return bad("apiKey (Cursor API key) is required");
  let apiBase: string;
  try {
    apiBase = normalizeApiBase(typeof body.apiBase === "string" ? body.apiBase : undefined);
  } catch (err) {
    return bad(err instanceof Error ? err.message : String(err));
  }
  const quotaKey = cursorQuotaKey(body.apiKey.trim());
  try {
    await throwIfCursorCoolingDown(ex, quotaKey);
    await new CursorAgentsClient(body.apiKey.trim(), apiBase, deps.fetchImpl).listAgents({ limit: 1 });
  } catch (err) {
    if (err instanceof CursorApiError && (err.status === 401 || err.status === 403)) return bad("Cursor rejected the API key", "invalid_api_key");
    if (err instanceof CursorApiError && err.status === 429) {
      const until = err instanceof CursorCooldownError ? null : await recordCursorRateLimit(ex, quotaKey, err.retryAfterSeconds ?? 60);
      const retryAfterSeconds = until ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)) : err.retryAfterSeconds;
      return { status: 429, body: { error: { code: "rate_limited", message: `Cursor is rate limiting this API key; retry after ${retryAfterSeconds}s`, retryAfterSeconds } } };
    }
    return bad(`Could not verify the key: ${err instanceof Error ? err.message : String(err)}`, "cursor_unreachable", 502);
  }
  const id = `ca_${randomBytes(12).toString("hex")}`;
  const webhookSecret = randomBytes(32).toString("base64url");
  await ex.execute(sql`
    INSERT INTO cursor_agents_connections (id, tenant_id, api_base, api_key_ciphertext, webhook_secret_ciphertext)
    VALUES (${id}, ${input.tenantId}, ${apiBase}, ${seal(id, input.tenantId, "api_key", body.apiKey.trim())}, ${seal(id, input.tenantId, "webhook_secret", webhookSecret)})
  `);
  await upsertConnection({ tenantId: input.tenantId, provider: CURSOR_BACKGROUND_AGENTS_PROVIDER, externalAccountId: id, status: "active", metadata: { connectionId: id, readOnly: true } }, ex);
  await upsertTaskSchedule({ tenantId: input.tenantId, kind: "cursor_agents.sync", frequencySeconds: CURSOR_SYNC_FREQUENCY_SECONDS, queue: "sync", groupKey: `${input.tenantId}:cursor-agents` }, ex);
  await enqueueTask({ queue: "backfill", tenantId: input.tenantId, kind: "cursor_agents.sync", groupKey: `${input.tenantId}:cursor-agents`, dedupeKey: `${input.tenantId}:cursor_agents.sync:${id}`, payload: {} }, ex);
  const base = (env.SOURCES_RUNTIME_PUBLIC_URL ?? env.WEBHOOK_BASE_URL)?.trim().replace(/\/+$/, "");
  return {
    status: 201,
    body: {
      connection: (await listCursorConnections(input.tenantId, ex)).find((c) => c.id === id),
      webhook: base ? { url: `${base}/webhooks/cursor-agents/${id}`, secret: webhookSecret } : null,
      note: "Shown once. Cursor sends webhooks only for agents launched with this {url, secret}; this lane never launches agents, so status changes otherwise arrive by polling.",
    },
  };
}

export async function disconnectCursorAgents(input: { tenantId: string }, deps: CursorDeps = {}): Promise<void> {
  await (deps.executor ?? defaultDb).execute(sql`
    UPDATE cursor_agents_connections SET status = 'revoked', status_reason = 'disconnected', api_key_ciphertext = '', webhook_secret_ciphertext = '',
      revoked_at = now(), updated_at = now()
    WHERE tenant_id = ${input.tenantId} AND status <> 'revoked'
  `);
}

async function insertRaw(ex: Executor, tenantId: string, sourceEventId: string, eventType: string, at: Date, payload: unknown, objectId: string): Promise<boolean> {
  return rowsOf(await ex.execute(sql`
    INSERT INTO activity_events (user_id, source, event_type, timestamp, source_updated_at, wiki_eligibility_at, raw_payload, source_event_id,
      processing_status, source_namespace, source_object_id, record_kind)
    VALUES (${tenantId}, ${CURSOR_BACKGROUND_AGENTS_PROVIDER}, ${eventType}, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz,
      ${JSON.stringify(redactProviderPayload("cursor-agents", payload))}::jsonb, ${sourceEventId}, 'received', 'cursor', ${objectId}, 'snapshot')
    ON CONFLICT (user_id, source_event_id) DO NOTHING RETURNING id
  `)).length > 0;
}

/** Store the agent's observed state: donor id for the first observation, `:v:<sha16>` for every later change. */
async function storeAgent(ex: Executor, c: CursorConnection, agent: CursorBackgroundAgent, runId: string | null): Promise<{ changed: boolean; needsConversation: boolean }> {
  const payload = redactProviderPayload("cursor-agents", agent.raw) as Record<string, unknown>;
  const sha = sha256(JSON.stringify(payload));
  const id = `${c.id}:${agent.id}`;
  const [prior] = rowsOf<{ agent_sha256: string; conversation_state: string; status: string | null; deleted: boolean }>(await ex.execute(sql`
    SELECT agent_sha256, conversation_state, status, deleted FROM cursor_agents_snapshots WHERE id = ${id}
  `));
  const at = agent.createdAt && !Number.isNaN(Date.parse(agent.createdAt)) ? new Date(agent.createdAt) : new Date();
  const receipt = { source: "poll", fetchedAt: new Date().toISOString() };
  const rawPayload = { cursorAgentId: agent.id, name: agent.name, status: agent.status, source: agent.source, target: agent.target, createdAt: agent.createdAt, summary: agent.summary, raw: payload, receipt };
  const changed = !prior || prior.agent_sha256 !== sha || prior.deleted;
  if (changed) {
    const first = await insertRaw(ex, c.tenantId, cursorAgentSnapshotSourceEventId(agent.id), CURSOR_BACKGROUND_AGENT_SNAPSHOT_EVENT, at, rawPayload, `agent:${agent.id}`);
    if (!first) await insertRaw(ex, c.tenantId, `${cursorAgentSnapshotSourceEventId(agent.id)}:v:${sha.slice(0, 16)}`, CURSOR_BACKGROUND_AGENT_SNAPSHOT_EVENT, at, rawPayload, `agent:${agent.id}`);
  }
  await ex.execute(sql`
    INSERT INTO cursor_agents_snapshots (id, tenant_id, connection_id, agent_id, status, agent_payload, agent_sha256, created_at_provider, observed_at, last_seen_run)
    VALUES (${id}, ${c.tenantId}, ${c.id}, ${agent.id}, ${agent.status ?? null}, ${JSON.stringify(payload)}::jsonb, ${sha}, ${agent.createdAt ?? null}::timestamptz, now(), ${runId})
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status, agent_payload = EXCLUDED.agent_payload, agent_sha256 = EXCLUDED.agent_sha256,
      observed_at = CASE WHEN cursor_agents_snapshots.agent_sha256 <> EXCLUDED.agent_sha256 OR cursor_agents_snapshots.deleted THEN now() ELSE cursor_agents_snapshots.observed_at END,
      deleted = false, deleted_reason = NULL, last_seen_run = COALESCE(EXCLUDED.last_seen_run, cursor_agents_snapshots.last_seen_run), updated_at = now()
  `);
  const running = !TERMINAL.has(String(agent.status ?? "").toUpperCase());
  return { changed, needsConversation: changed || !prior || prior.conversation_state !== "stored" || running };
}

async function storeConversation(ex: Executor, c: CursorConnection, agentId: string, conv: CursorBackgroundAgentConversation): Promise<void> {
  const payload = redactProviderPayload("cursor-agents", conv.raw) as Record<string, unknown>;
  const sha = sha256(JSON.stringify(payload));
  const [prior] = rowsOf<{ conversation_sha256: string | null }>(await ex.execute(sql`SELECT conversation_sha256 FROM cursor_agents_snapshots WHERE id = ${`${c.id}:${agentId}`}`));
  if (prior?.conversation_sha256 === sha) return;
  await insertRaw(ex, c.tenantId, `cursor_background_agents:conversation:${agentId}:${sha.slice(0, 16)}`, CURSOR_CONVERSATION_EVENT, new Date(), { cursorAgentId: agentId, messages: conv.messages.length, raw: payload }, `agent:${agentId}`);
  await ex.execute(sql`
    UPDATE cursor_agents_snapshots SET conversation_payload = ${JSON.stringify(payload)}::jsonb, conversation_sha256 = ${sha}, conversation_state = 'stored',
      conversation_error = NULL, observed_at = now(), updated_at = now()
    WHERE id = ${`${c.id}:${agentId}`}
  `);
}

export async function runCursorAgentsSync(tenantId: string, deps: CursorDeps = {}): Promise<Array<{ connectionId: string; status: string; agents: number; conversations: number; reason?: string }>> {
  const ex = deps.executor ?? defaultDb;
  const env = deps.env ?? process.env;
  const out: Array<{ connectionId: string; status: string; agents: number; conversations: number; reason?: string }> = [];
  for (const listed of await listCursorConnections(tenantId, ex)) {
    if (listed.status !== "active") continue;
    const owner = randomBytes(8).toString("hex");
    const [row] = rowsOf<Record<string, unknown>>(await ex.execute(sql`
      UPDATE cursor_agents_connections SET lease_owner = ${owner}, lease_until = now() + interval '10 minutes'
      WHERE id = ${listed.id} AND status = 'active' AND (lease_until IS NULL OR lease_until < now()) AND (retry_at IS NULL OR retry_at <= now())
      RETURNING *
    `));
    if (!row) {
      out.push({ connectionId: listed.id, status: "skipped", agents: 0, conversations: 0 });
      continue;
    }
    const c = toConn(row);
    const apiKey = unseal(c.id, c.tenantId, "api_key", String(row.api_key_ciphertext));
    const quotaKey = cursorQuotaKey(apiKey);
    const client = new CursorAgentsClient(apiKey, c.apiBase, deps.fetchImpl);
    let cursor = (row.list_cursor as string | null) ?? undefined;
    let runId = (row.list_run as string | null) ?? null;
    if (!runId) {
      runId = randomBytes(8).toString("hex");
      cursor = undefined;
    }
    let agents = 0;
    let conversations = 0;
    const pageBudget = intEnv(env, "CURSOR_AGENTS_PAGES_PER_RUN", 10, 1);
    let convBudget = intEnv(env, "CURSOR_AGENTS_CONVERSATIONS_PER_RUN", 20, 0);
    const save = (u: Record<string, unknown>) => ex.execute(sql`
      UPDATE cursor_agents_connections SET list_cursor = ${(u.cursor as string | null) ?? null}, list_run = ${(u.run as string | null) ?? null},
        last_complete_listing_at = CASE WHEN ${u.complete === true} THEN now() ELSE last_complete_listing_at END,
        last_poll_at = CASE WHEN ${u.polled === true} THEN now() ELSE last_poll_at END,
        retry_at = ${u.retryAt ? (u.retryAt as Date).toISOString() : null}::timestamptz, attempts = ${(u.attempts as number) ?? 0},
        last_error = ${(u.lastError as string | null) ?? null}, status = COALESCE(${(u.status as string | null) ?? null}, status),
        status_reason = COALESCE(${(u.reason as string | null) ?? null}, status_reason),
        lease_owner = CASE WHEN ${u.release === true} THEN NULL ELSE lease_owner END, lease_until = CASE WHEN ${u.release === true} THEN NULL ELSE lease_until END,
        updated_at = now()
      WHERE id = ${c.id} AND lease_owner = ${owner}
    `);
    try {
      let pages = 0;
      let complete = false;
      while (pages < pageBudget) {
        await throwIfCursorCoolingDown(ex, quotaKey);
        const page = await client.listAgents({ limit: 100, ...(cursor ? { cursor } : {}) });
        pages++;
        for (const agent of page.agents) {
          agents++;
          const r = await storeAgent(ex, c, agent, runId);
          if (r.needsConversation && convBudget > 0) {
            convBudget--;
            try {
              await throwIfCursorCoolingDown(ex, quotaKey);
              await storeConversation(ex, c, agent.id, await client.getConversation(agent.id));
              conversations++;
            } catch (err) {
              if (err instanceof CursorApiError && err.status === 429) throw err;
              await ex.execute(sql`UPDATE cursor_agents_snapshots SET conversation_state = 'error', conversation_error = ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}, updated_at = now() WHERE id = ${`${c.id}:${agent.id}`}`);
            }
          }
        }
        cursor = page.nextCursor;
        await save({ cursor: cursor ?? null, run: runId });
        if (!cursor) {
          complete = true;
          break;
        }
      }
      if (complete) {
        // Agents a completed listing no longer returns were deleted at Cursor (or expired out of the API).
        await ex.execute(sql`
          UPDATE cursor_agents_snapshots SET deleted = true, deleted_reason = 'not_in_full_listing', observed_at = now(), updated_at = now()
          WHERE connection_id = ${c.id} AND NOT deleted AND last_seen_run IS DISTINCT FROM ${runId}
        `);
      }
      await save({ cursor: complete ? null : cursor ?? null, run: complete ? null : runId, complete, polled: true, release: true });
      out.push({ connectionId: c.id, status: "ok", agents, conversations });
    } catch (err) {
      const e = err as CursorApiError;
      const attempts = Number(row.attempts ?? 0) + 1;
      if (e instanceof CursorApiError && (e.status === 401 || e.status === 403)) {
        await save({ cursor: cursor ?? null, run: runId, status: "error", reason: "invalid_api_key", lastError: e.message, attempts, release: true });
        out.push({ connectionId: c.id, status: "auth_failed", agents, conversations, reason: e.message });
        continue;
      }
      const delay = e instanceof CursorApiError && e.retryAfterSeconds != null ? Math.max(e.retryAfterSeconds, e.status === 429 ? 0 : 30) : Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
      // A 429 holds every connection on this key (other owner scopes included) until the provider's floor.
      const retryAt = e instanceof CursorApiError && e.status === 429 && !(e instanceof CursorCooldownError)
        ? await recordCursorRateLimit(ex, quotaKey, delay)
        : new Date(Date.now() + delay * 1000);
      // The page cursor and run are kept, so the next run resumes at the failed page.
      await save({ cursor: cursor ?? null, run: runId, retryAt, attempts, lastError: `${e instanceof CursorApiError && e.status === 429 ? "rate_limited" : "error"}: ${(err as Error).message}`, release: true });
      out.push({ connectionId: c.id, status: e instanceof CursorApiError && e.status === 429 ? "rate_limited" : "error", agents, conversations, reason: (err as Error).message });
    }
  }
  return out;
}

export function createCursorAgentsWebhook(deps: CursorDeps = {}): Hono {
  const app = new Hono();
  app.post("/:connectionId", async (c) => {
    const ex = deps.executor ?? defaultDb;
    const signature = c.req.header("x-webhook-signature");
    if (!signature) return c.json({ error: "Missing X-Webhook-Signature header" }, 401);
    const webhookId = c.req.header("x-webhook-id");
    if (!webhookId) return c.json({ error: "Missing X-Webhook-ID header" }, 400);
    const webhookEvent = c.req.header("x-webhook-event");
    if (!webhookEvent) return c.json({ error: "Missing X-Webhook-Event header" }, 400);
    const connectionId = c.req.param("connectionId");
    const [row] = /^ca_[0-9a-f]{24}$/.test(connectionId) ? rowsOf<Record<string, unknown>>(await ex.execute(sql`SELECT * FROM cursor_agents_connections WHERE id = ${connectionId}`)) : [];
    const rawBody = await c.req.text();
    if (!row || row.status !== "active") return c.json({ error: "Invalid signature" }, 401);
    const secret = unseal(String(row.id), String(row.tenant_id), "webhook_secret", String(row.webhook_secret_ciphertext));
    if (!verifyCursorWebhookSignature(secret, rawBody, signature)) return c.json({ error: "Invalid signature" }, 401);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const tenantId = String(row.tenant_id);
    const at = typeof payload.timestamp === "string" && !Number.isNaN(Date.parse(payload.timestamp)) ? new Date(payload.timestamp) : new Date();
    const stored = await insertRaw(ex, tenantId, `cursor_background_agents:webhook:${webhookId}`, CURSOR_BACKGROUND_AGENT_WEBHOOK_EVENT, at,
      { webhookId, webhookEvent, payload, rawBody }, typeof payload.id === "string" ? `agent:${payload.id}` : `webhook:${webhookId}`);
    await ex.execute(sql`UPDATE cursor_agents_connections SET last_webhook_at = now() WHERE id = ${connectionId}`);
    // A status change refreshes the snapshot and conversation through the normal (leased) sync.
    if (stored) await enqueueTask({ queue: "sync", tenantId, kind: "cursor_agents.sync", groupKey: `${tenantId}:cursor-agents`, dedupeKey: `${tenantId}:cursor_agents.sync:webhook`, payload: {} }, ex);
    return c.json({ received: true, duplicate: !stored, webhookEvent });
  });
  return app;
}

export const cursorAgentsIntegration: AqueductIntegration = {
  id: CURSOR_BACKGROUND_AGENTS_PROVIDER,
  connect: (input) => connectCursorAgents(input),
  disconnect: (input) => disconnectCursorAgents(input),
  registerHttp(app) {
    app.route("/webhooks/cursor-agents", createCursorAgentsWebhook());
  },
  taskKinds: () => ["cursor_agents.sync"],
  taskHandlers: () => ({
    // The tenant is the queued task's own tenant, never a payload field.
    "cursor_agents.sync": async (_payload, ctx) => ({ connections: (await runCursorAgentsSync(ctx.task.tenantId)).map((r) => `${r.connectionId}:${r.status}`) }),
  }),
};
