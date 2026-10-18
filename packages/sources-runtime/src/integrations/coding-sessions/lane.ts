/**
 * Coding sessions (Codex / Claude Code) device lane. Ported from gigabrain 5448774
 * brain/src/integrations/coding-sessions/{ingest,commands,auth}.ts; the Fireworks artifact-sync enrichment
 * (graph/LLM work) is excluded.
 *
 * Wire: the bundled Mac agent (`shepherd-onboard`, config `{apiUrl, userId, agentToken}`) calls, with
 * `x-api-key`:
 *  - `POST /api/coding-sessions/ingest`
 *  - `GET  /api/coding-sessions/ingest/command`
 *  - `POST /api/coding-sessions/ingest/command/ack`
 * These run on the runtime's public host, as with iMessage: the agent's GET carries a JSON content type with no
 * body, which yc_msaw's HTTP layer rejects.
 *
 * Auth (replaces the donor's admin key with a body `userId` override, and its token cache):
 *  - The key is `gcs_<tenantNs>.<bindingId>.<secret>`, minted from a yc_msaw device binding (`transport=runtime-ingest`).
 *  - Only sha256(key) is stored here.
 *  - Every request needs an active device row AND a live confirmation from yc_msaw
 *    (`GET <tenant publishUrl>/v1/sources/devices/coding-sessions/verify`).
 *  - If yc_msaw is unreachable the request gets 503 and nothing is stored (fail closed).
 *  - A refusal revokes the row.
 *  - A body `userId` is ignored.
 *
 * Kept from the donor: the session normalization and the `sessions:<provider>:<sessionId>` identity, the
 * content-hash skip with `force`, the command queue semantics (claim oldest pending or lease-expired, ack once)
 * and the source_sync receipt sanitization.
 *
 * Changed:
 *  - Message text is never truncated (the donor cut it at 20,000 chars).
 *  - Raw versions are immutable (`…:v:<contentHash16>`); the donor updated one row in place.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { db as defaultDb } from "../../db/client.js";
import { getTenantBinding } from "../../source-lane/export/bindings.js";
import { deviceDataTenant, deviceListTenants, ensurePersonalScope, registerPersonalDevice, type OwnerIdentity } from "../../source-lane/core/personal-scope.js";
import type { CoverageReport, ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourceProviderModule, InternalRouteDeps } from "../../source-lane/core/types.js";

export type Executor = Pick<typeof defaultDb, "execute">;
export const CODING_SESSIONS_PROVIDER = "coding-sessions";
export const CODING_SESSION_SOURCE = "sessions";
export const DEVICE_KEY_PREFIX = "gcs_";
const MAX_SESSIONS_PER_BATCH = 50;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const COMMAND_LEASE_MS = 10 * 60_000;
export const COMMAND_TYPES = ["source_sync", "force_rescan", "backfill_recent", "repair_status", "upload_diagnostics"] as const;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

// ---------------------------------------------------------------- device identity

export interface DeviceKey {
  tenantNs: string;
  bindingId: string;
}

export function parseDeviceKey(key: string | null | undefined): DeviceKey | null {
  if (typeof key !== "string" || !key.startsWith(DEVICE_KEY_PREFIX) || key.length > 300) return null;
  // Same shape as yc_msaw psb_ binding tokens (tenant namespace, binding id, 43-char secret).
  const m = /^gcs_([a-z0-9][a-z0-9-]{0,79})\.(sb-[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/.exec(key);
  return m ? { tenantNs: m[1]!, bindingId: m[2]! } : null;
}

export type AuthorityVerdict = { state: "active" } | { state: "revoked"; reason: string } | { state: "unavailable"; reason: string };
export interface DeviceAuthority {
  verify(key: string, device: DeviceKey): Promise<AuthorityVerdict>;
}

/** yc_msaw is the authority: asked per request at the tenant's own binding publish URL, with the key only. */
export function createCodingSessionsAuthority(db: Executor, fetchImpl: typeof fetch = fetch): DeviceAuthority {
  return createYcDeviceAuthority(db, CODING_SESSIONS_PROVIDER, fetchImpl);
}

/** Provider-parameterized yc_msaw device authority (`GET /v1/sources/devices/<provider>/verify`, key only). */
export function createYcDeviceAuthority(db: Executor, provider: string, fetchImpl: typeof fetch = fetch): DeviceAuthority {
  return {
    async verify(key, device) {
      const binding = await getTenantBinding(db as never, device.tenantNs).catch(() => null);
      if (!binding) return { state: "unavailable", reason: "tenant has no source binding" };
      let res: Response;
      try {
        res = await fetchImpl(new URL(`/v1/sources/devices/${provider}/verify`, binding.publishUrl), {
          method: "GET", headers: { "x-api-key": key }, redirect: "error", signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        return { state: "unavailable", reason: `yc_msaw unreachable: ${e instanceof Error ? e.message : String(e)}` };
      }
      // Only yc_msaw's verify refusal (401) revokes. A 403/404 can come from a WAF, a misrouted deploy or a replica
      // with sources disabled; treating it as revocation would permanently revoke every device that checks in.
      if (res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        return { state: "revoked", reason: `yc_msaw refused the device key (${res.status})` };
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { state: "unavailable", reason: `yc_msaw answered ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as { tenantNs?: unknown; bindingId?: unknown; provider?: unknown } | null;
      if (!body || body.tenantNs !== device.tenantNs || body.bindingId !== device.bindingId || body.provider !== provider) {
        return { state: "revoked", reason: "yc_msaw confirmed a different identity" };
      }
      return { state: "active" };
    },
  };
}

async function authenticate(ex: Executor, authority: DeviceAuthority, key: string | null | undefined): Promise<{ ok: true; device: DeviceKey } | { ok: false; status: 401 | 503; error: string }> {
  const parts = parseDeviceKey(key);
  if (!parts || !key) return { ok: false, status: 401, error: "Unauthorized" };
  // SOURCE-LANE PATCH (personal-connection-attribution): a device enrolled into its member's owner scope keeps its
  // registry row and data there (core/personal-scope.ts); the key names the organization tenant and the binding.
  const tenantId = await deviceDataTenant(ex, parts.tenantNs, "coding-sessions", parts.bindingId);
  const [row] = rowsOf<{ token_sha256: string; status: string }>(await ex.execute(sql`
    SELECT token_sha256, status FROM coding_session_devices WHERE tenant_id = ${tenantId} AND binding_id = ${parts.bindingId}
  `));
  const a = Buffer.from(sha256(key), "hex");
  const b = Buffer.from(row?.token_sha256 ?? "00".repeat(32), "hex");
  if (!row || row.status !== "active" || a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, error: "Unauthorized" };
  const verdict = await authority.verify(key, parts);
  if (verdict.state === "unavailable") return { ok: false, status: 503, error: `Device authority unavailable: ${verdict.reason}` };
  if (verdict.state === "revoked") {
    await revokeDevice(ex, tenantId, parts.bindingId);
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  await ex.execute(sql`UPDATE coding_session_devices SET last_seen_at = now() WHERE tenant_id = ${tenantId} AND binding_id = ${parts.bindingId}`);
  // From here on the device acts in the tenant that holds its data (rows, commands, receipts).
  return { ok: true, device: { tenantNs: tenantId, bindingId: parts.bindingId } };
}

export async function enrollDevice(ex: Executor, tenantId: string, input: { bindingId: string; tokenSha256: string; label?: string | null }): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!/^sb-[0-9a-f]{16}$/.test(input.bindingId) || !/^[0-9a-f]{64}$/.test(input.tokenSha256)) return { status: 400, body: { error: "bindingId and tokenSha256 required" } };
  const [prior] = rowsOf<{ token_sha256: string; status: string }>(await ex.execute(sql`SELECT token_sha256, status FROM coding_session_devices WHERE tenant_id = ${tenantId} AND binding_id = ${input.bindingId}`));
  if (prior) {
    if (prior.token_sha256 === input.tokenSha256 && prior.status === "active") return { status: 200, body: { created: false, bindingId: input.bindingId } };
    return { status: 409, body: { error: "device binding already enrolled differently or revoked" } };
  }
  await ex.execute(sql`
    INSERT INTO coding_session_devices (tenant_id, binding_id, token_sha256, label) VALUES (${tenantId}, ${input.bindingId}, ${input.tokenSha256}, ${input.label?.slice(0, 200) ?? null})
  `);
  return { status: 201, body: { created: true, bindingId: input.bindingId, wire: "/api/coding-sessions/ingest" } };
}

export async function revokeDevice(ex: Executor, tenantId: string, bindingId: string): Promise<boolean> {
  const r = rowsOf(await ex.execute(sql`
    UPDATE coding_session_devices SET status = 'revoked', revoked_at = now() WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId} AND status = 'active' RETURNING binding_id
  `));
  if (r.length) {
    await ex.execute(sql`
      UPDATE coding_session_commands SET status = 'cancelled', error_message = 'device revoked', updated_at = now()
      WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId} AND status IN ('pending', 'running')
    `);
  }
  return r.length > 0;
}

// ---------------------------------------------------------------- donor normalization

type Msg = { id: string | null; order: number; role: "user" | "assistant"; text: string; timestamp: string | null; providerType: string | null; phase: string | null; source: string | null };

/** Metadata strings keep the donor 20,000-char bound; transcript text is kept whole (no silent truncation). */
const cleanString = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 20_000) : null);
const cleanText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isoOrNull = (v: unknown): string | null => {
  const t = cleanString(v);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const stripNul = (v: unknown): unknown =>
  typeof v === "string" ? v.replace(/\u0000/g, "").replace(/\\u0000/g, "")
    : Array.isArray(v) ? v.map(stripNul)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripNul(x)])) : v;

function cleanMessages(value: unknown, role: "user" | "assistant"): Msg[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const text = cleanText(row.text);
    if (!text) return [];
    const order = typeof row.order === "number" && Number.isFinite(row.order) ? Math.floor(row.order) : null;
    if (order === null) return [];
    const phase = ["input", "commentary", "final_answer", "unknown"].includes(String(row.phase)) ? String(row.phase) : null;
    return [{ id: cleanString(row.id), order, role, text, timestamp: isoOrNull(row.timestamp), providerType: cleanString(row.providerType), phase, source: cleanString(row.source) }];
  });
}

export function normalizeIngestSession(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const s = input as Record<string, unknown>;
  if (s.provider !== "codex" && s.provider !== "claude") return null;
  const sessionId = cleanString(s.sessionId);
  if (!sessionId) return null;
  const actor = s.actor && typeof s.actor === "object" ? (s.actor as Record<string, unknown>) : null;
  const repo = s.repo && typeof s.repo === "object" ? (s.repo as Record<string, unknown>) : null;
  const normalized: Record<string, unknown> = {
    schemaVersion: 2,
    parserVersion: cleanString(s.parserVersion),
    provider: s.provider,
    sessionId,
    startedAt: isoOrNull(s.startedAt),
    endedAt: isoOrNull(s.endedAt),
    lastUpdatedAt: isoOrNull(s.lastUpdatedAt),
    status: ["active", "settled", "completed", "unknown"].includes(String(s.status)) ? s.status : "unknown",
    actor: actor ? { email: cleanString(actor.email)?.toLowerCase() ?? null, name: cleanString(actor.name) } : null,
    repo: repo ? { fullName: cleanString(repo.fullName), remote: cleanString(repo.remote), branch: cleanString(repo.branch), commit: cleanString(repo.commit) } : null,
    cwdHash: cleanString(s.cwdHash),
    cwdBasename: cleanString(s.cwdBasename),
    title: cleanString(s.title),
    userMessages: cleanMessages(s.userMessages, "user"),
    agentResponses: cleanMessages(s.agentResponses, "assistant"),
    sourcePathHash: cleanString(s.sourcePathHash),
  };
  normalized.contentHash = cleanString(s.contentHash) ?? sha256(JSON.stringify(normalized));
  return stripNul(normalized) as Record<string, unknown>;
}

function sessionTimestamp(s: Record<string, unknown>): Date {
  for (const v of [s.endedAt, s.lastUpdatedAt, s.startedAt]) {
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v);
  }
  return new Date();
}

/** Donor sourceSyncCommandReceiptResult: only typed, bounded fields of a client receipt are kept. */
export function sanitizeReceipt(record: Record<string, unknown>, commandPayload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { provider: "coding_sessions" };
  const num = (k: string) => {
    const v = record[k];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = Math.max(0, Math.floor(n));
  };
  num("receiptVersion");
  if (typeof commandPayload.sourceSyncRunId === "string") out.sourceSyncRunId = commandPayload.sourceSyncRunId.slice(0, 500);
  for (const k of ["agentVersion", "parserVersion"]) if (typeof record[k] === "string" && /^[a-zA-Z0-9._+-]{1,80}$/.test((record[k] as string).trim())) out[k] = (record[k] as string).trim();
  for (const k of ["coverageFrom", "coverageTo"]) {
    if (!(k in record)) continue;
    const v = record[k];
    out[k] = v === null && k === "coverageFrom" ? null : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : "";
  }
  for (const k of ["highWatermark", "manifestHash"]) {
    const v = record[k];
    if (typeof v === "string" && v.trim()) out[k] = /^sha256:[a-f0-9]{64}$/i.test(v.trim()) ? v.trim().toLowerCase() : `sha256:${sha256(v.trim())}`;
  }
  for (const k of ["fullInventory", "exhausted", "capHit"]) if (typeof record[k] === "boolean") out[k] = record[k];
  for (const k of ["filesDiscovered", "filesParsed", "parseErrors", "sessionsSeen", "sessionsEligible", "localFilesSeen", "sessionsUploaded", "uploadedSessions",
    "sessionsSkippedUnchanged", "pendingUploads", "failedUploads", "pendingCount", "failedCount", "queueDepth"]) num(k);
  return out;
}

// ---------------------------------------------------------------- ingest + commands

export async function ingestSessions(ex: Executor, device: DeviceKey, body: { force?: unknown; sessions?: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!Array.isArray(body.sessions) || body.sessions.length === 0) return { status: 400, body: { error: "sessions array is required" } };
  if (body.sessions.length > MAX_SESSIONS_PER_BATCH) return { status: 400, body: { error: `Maximum ${MAX_SESSIONS_PER_BATCH} sessions per batch` } };
  const force = body.force === true;
  let stored = 0;
  let updated = 0;
  let skipped = 0;
  for (const input of body.sessions) {
    const s = normalizeIngestSession(input);
    if (!s) {
      skipped++;
      continue;
    }
    const tenantId = device.tenantNs;
    const id = `${tenantId}:${s.provider}:${s.sessionId}`;
    const hash = String(s.contentHash);
    const [prior] = rowsOf<{ content_hash: string; version: number }>(await ex.execute(sql`SELECT content_hash, version FROM coding_sessions WHERE id = ${id}`));
    if (prior && prior.content_hash === hash && !force) {
      skipped++;
      continue;
    }
    const ts = sessionTimestamp(s);
    const sourceEventId = `sessions:${s.provider}:${s.sessionId}`;
    const insertRaw = (eid: string) => ex.execute(sql`
      INSERT INTO activity_events (user_id, source, event_type, timestamp, source_updated_at, wiki_eligibility_at, raw_payload, source_event_id,
        processing_status, source_namespace, source_object_id, record_kind)
      VALUES (${tenantId}, ${CODING_SESSION_SOURCE}, 'coding_session', ${ts.toISOString()}::timestamptz, ${ts.toISOString()}::timestamptz, ${ts.toISOString()}::timestamptz,
        ${JSON.stringify(s)}::jsonb, ${eid}, 'received', ${`device:${device.bindingId}`}, ${`session:${s.provider}:${s.sessionId}`}, 'snapshot')
      ON CONFLICT (user_id, source_event_id) DO NOTHING RETURNING id
    `);
    if (!rowsOf(await insertRaw(sourceEventId)).length) await insertRaw(`${sourceEventId}:v:${hash.replace(/^sha256:/, "").slice(0, 16)}`);
    if (prior && prior.content_hash === hash) {
      skipped++;
      continue; // forced re-upload of identical content: nothing new to publish
    }
    await ex.execute(sql`
      INSERT INTO coding_sessions (id, tenant_id, binding_id, provider, session_id, content_hash, payload, session_ts)
      VALUES (${id}, ${tenantId}, ${device.bindingId}, ${String(s.provider)}, ${String(s.sessionId)}, ${hash}, ${JSON.stringify(s)}::jsonb, ${ts.toISOString()}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET binding_id = EXCLUDED.binding_id, content_hash = EXCLUDED.content_hash, payload = EXCLUDED.payload,
        session_ts = EXCLUDED.session_ts, version = coding_sessions.version + 1, observed_at = now(), updated_at = now()
    `);
    if (prior) updated++;
    else stored++;
  }
  return { status: 200, body: { stored, updated, skipped, total: body.sessions.length } };
}

export async function requestCommand(ex: Executor, tenantId: string, bindingId: string, input: Record<string, unknown>, requestedBy: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const type = String(input.type ?? "");
  if (!(COMMAND_TYPES as readonly string[]).includes(type)) return { status: 400, body: { error: `Unsupported command type: ${type}` } };
  const [device] = rowsOf(await ex.execute(sql`SELECT 1 FROM coding_session_devices WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId} AND status = 'active'`));
  if (!device) return { status: 404, body: { error: "No active coding-sessions device with that binding" } };
  const payload: Record<string, unknown> = {};
  if (type === "source_sync") {
    payload.sourceSyncRunId = `srs_${randomBytes(8).toString("hex")}`;
    payload.coverageFrom = typeof input.coverageFrom === "string" ? input.coverageFrom : null;
    payload.coverageTo = typeof input.coverageTo === "string" ? input.coverageTo : new Date().toISOString();
    payload.maxFiles = 1_000;
    payload.force = true;
  } else if (type === "force_rescan" || type === "backfill_recent") {
    payload.maxFiles = typeof input.maxFiles === "number" && input.maxFiles > 0 ? Math.floor(input.maxFiles) : 1_000;
    payload.force = true;
  }
  const id = `csc_${randomBytes(10).toString("hex")}`;
  await ex.execute(sql`
    INSERT INTO coding_session_commands (id, tenant_id, binding_id, command_type, payload, requested_by)
    VALUES (${id}, ${tenantId}, ${bindingId}, ${type}, ${JSON.stringify(payload)}::jsonb, ${requestedBy})
  `);
  return { status: 201, body: { id, type, payload } };
}

/** Donor claimCodingSessionAgentCommand: oldest pending, or running past its lease. */
export async function claimCommand(ex: Executor, device: DeviceKey): Promise<Record<string, unknown> | null> {
  const [row] = rowsOf<Record<string, unknown>>(await ex.execute(sql`
    WITH next_command AS (
      SELECT id FROM coding_session_commands
      WHERE tenant_id = ${device.tenantNs} AND binding_id = ${device.bindingId}
        AND (status = 'pending' OR (status = 'running' AND lease_expires_at < now()))
      ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE coding_session_commands c SET status = 'running', claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => ${COMMAND_LEASE_MS / 1000}), updated_at = now()
    FROM next_command WHERE c.id = next_command.id
    RETURNING c.id, c.command_type, c.payload, c.created_at
  `));
  if (!row) return null;
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return { id: row.id, type: row.command_type, payload, requestedAt: iso(row.created_at) };
}

export async function ackCommand(ex: Executor, device: DeviceKey, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return { status: 400, body: { error: "id is required" } };
  const [cmd] = rowsOf<{ status: string; command_type: string; payload: unknown }>(await ex.execute(sql`
    SELECT status, command_type, payload FROM coding_session_commands WHERE id = ${id} AND tenant_id = ${device.tenantNs} AND binding_id = ${device.bindingId}
  `));
  if (!cmd || (cmd.status !== "pending" && cmd.status !== "running")) return { status: 200, body: { ok: true, ignored: true } };
  const status = body.status === "failed" ? "failed" : "completed";
  const raw = body.result && typeof body.result === "object" && !Array.isArray(body.result) ? (body.result as Record<string, unknown>) : body.result === undefined ? undefined : { value: body.result };
  const payload = (typeof cmd.payload === "string" ? JSON.parse(cmd.payload) : cmd.payload) as Record<string, unknown>;
  const result = cmd.command_type === "source_sync" && raw ? sanitizeReceipt(raw, payload) : raw ?? null;
  const error = typeof body.error === "string" ? body.error.replace(/[\u0000-\u001f]/g, " ").slice(0, 500) : null;
  await ex.execute(sql`
    UPDATE coding_session_commands SET status = ${status}, result = ${result ? JSON.stringify(result) : null}::jsonb, error_message = ${error},
      completed_at = now(), updated_at = now()
    WHERE id = ${id} AND status IN ('pending', 'running')
  `);
  return { status: 200, body: { ok: true, command: { id, status } } };
}

// ---------------------------------------------------------------- routes

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
  if (!text.trim()) return {};
  const v = JSON.parse(text) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function registerCodingSessionsPublicRoutes(app: Hono, deps: { db?: Executor; authority?: DeviceAuthority } = {}): void {
  const ex = () => deps.db ?? defaultDb;
  const authority = () => deps.authority ?? createCodingSessionsAuthority(ex());
  const guard = async (c: Context) => {
    const r = await authenticate(ex(), authority(), c.req.header("x-api-key"));
    return r;
  };
  app.post("/api/coding-sessions/ingest", async (c) => {
    const a = await guard(c);
    if (!a.ok) return c.json({ error: a.error }, a.status);
    let body: Record<string, unknown>;
    try {
      body = await readJson(c);
    } catch (e) {
      return c.json({ error: (e as { status?: number }).status === 413 ? "Payload too large" : "Invalid JSON" }, (e as { status?: number }).status === 413 ? 413 : 400);
    }
    // A body userId never selects the tenant (the donor admin override is not ported).
    const r = await ingestSessions(ex(), a.device, body);
    return c.json(r.body, r.status as 200);
  });
  app.get("/api/coding-sessions/ingest/command", async (c) => {
    const a = await guard(c);
    if (!a.ok) return c.json({ error: a.error }, a.status);
    const caps = (c.req.header("x-shepherd-agent-capabilities") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (caps.length) {
      await ex().execute(sql`UPDATE coding_session_devices SET capabilities = ${JSON.stringify({ sourceSyncReceipts: caps.includes("source_sync_receipts") })}::jsonb WHERE tenant_id = ${a.device.tenantNs} AND binding_id = ${a.device.bindingId}`);
    }
    return c.json({ command: await claimCommand(ex(), a.device) });
  });
  app.post("/api/coding-sessions/ingest/command/ack", async (c) => {
    const a = await guard(c);
    if (!a.ok) return c.json({ error: a.error }, a.status);
    const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
    const r = await ackCommand(ex(), a.device, body);
    return c.json(r.body, r.status as 200);
  });
}

export function registerCodingSessionsInternalRoutes(app: Hono, deps: InternalRouteDeps & { db?: Executor }): void {
  const ex = () => deps.db ?? defaultDb;
  const principal = (c: Context) => (c.get("principal" as never) as { subject?: string; issuer?: string; scopes?: string[] } | undefined) ?? {};
  const owner = (c: Context): OwnerIdentity => ({ tenantNs: deps.tenantOf(c), issuer: String(principal(c).issuer ?? ""), subject: String(principal(c).subject ?? "") });
  /** Registry rows of a binding live in its owner scope (devices enrolled before owner scopes: the tenant itself). */
  const deviceTenant = (c: Context) => deviceDataTenant(ex(), deps.tenantOf(c), "coding-sessions", c.req.param("bindingId") ?? "");
  const canWrite = (c: Context) => {
    const scopes = principal(c).scopes ?? [];
    return scopes.includes("traces:write") || scopes.includes("memory:build");
  };
  app.post("/tenants/:tenantId/devices/coding-sessions", async (c) => {
    // Self-service enrolment (owner-only sources); yc_msaw mints the binding.
    if (!canWrite(c) && !(principal(c).scopes ?? []).includes("memory:read")) return c.json({ error: { code: "insufficient_scope" } }, 403);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // yc_msaw enrols every new device with layout "owner-segment": it writes into the enrolling member's own owner
    // scope (core/personal-scope.ts), so its data is theirs alone, with its own keys. Without it: the tenant itself.
    const bindingId = String(body.bindingId ?? "");
    let tenantId = deps.tenantOf(c);
    if (body.layout === "owner-segment") {
      const who = owner(c);
      if (!who.subject || !who.issuer) return c.json({ error: { code: "principal_required" } }, 401);
      if (!/^sb-[0-9a-f]{16}$/.test(bindingId)) return c.json({ error: "bindingId and tokenSha256 required" }, 400);
      const scope = await ensurePersonalScope(ex(), who);
      await registerPersonalDevice(ex(), scope, "coding-sessions", bindingId);
      tenantId = scope.scopeTenantId;
    }
    const r = await enrollDevice(ex(), tenantId, { bindingId, tokenSha256: String(body.tokenSha256 ?? ""), label: typeof body.label === "string" ? body.label : null });
    return c.json(r.body, r.status as 200);
  });
  app.get("/tenants/:tenantId/devices/coding-sessions", async (c) => {
    const rows = rowsOf<Record<string, unknown>>(await ex().execute(sql`
      SELECT binding_id, label, status, capabilities, last_seen_at, created_at, revoked_at FROM coding_session_devices
       WHERE tenant_id = ANY(${`{${(await deviceListTenants(ex(), owner(c))).join(",")}}`}::text[]) ORDER BY created_at
    `));
    return c.json({ devices: rows });
  });
  app.delete("/tenants/:tenantId/devices/coding-sessions/:bindingId", async (c) => {
    // The device owner revokes it (yc_msaw checks ownership before forwarding).
    if (!canWrite(c) && !(principal(c).scopes ?? []).includes("memory:read")) return c.json({ error: { code: "insufficient_scope" } }, 403);
    const ok = await revokeDevice(ex(), await deviceTenant(c), c.req.param("bindingId"));
    return ok ? c.json({ revoked: true }) : c.json({ error: { code: "not_found" } }, 404);
  });
  app.post("/tenants/:tenantId/devices/coding-sessions/:bindingId/commands", async (c) => {
    // The device owner commands it (yc_msaw checks ownership before forwarding).
    if (!canWrite(c) && !(principal(c).scopes ?? []).includes("memory:read")) return c.json({ error: { code: "insufficient_scope" } }, 403);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await requestCommand(ex(), await deviceTenant(c), c.req.param("bindingId"), body, principal(c).subject ?? null);
    return c.json(r.body, r.status as 201);
  });
}

// ---------------------------------------------------------------- export + coverage

export function sessionPath(provider: string, sessionTs: Date, sessionId: string): string {
  return `sources/coding-sessions/${provider}/${sessionTs.toISOString().slice(0, 7)}/${encodeURIComponent(sessionId).replace(/\./g, "%2E")}`;
}

export function renderTranscript(s: Record<string, unknown>): string {
  const msgs = [...((s.userMessages as Msg[]) ?? []), ...((s.agentResponses as Msg[]) ?? [])].sort((a, b) => a.order - b.order);
  const repo = s.repo as { fullName?: string | null; branch?: string | null } | null;
  const head = [`# ${s.title ?? `${s.provider} session ${s.sessionId}`}`, "", `- provider: ${s.provider}`, `- session: ${s.sessionId}`, `- status: ${s.status}`,
    ...(repo?.fullName ? [`- repo: ${repo.fullName}${repo.branch ? ` (${repo.branch})` : ""}`] : []), `- started: ${s.startedAt ?? "unknown"}`, `- updated: ${s.lastUpdatedAt ?? s.endedAt ?? "unknown"}`, ""];
  return [...head, ...msgs.flatMap((m) => [`## ${m.role}${m.phase ? ` (${m.phase})` : ""}${m.timestamp ? ` · ${m.timestamp}` : ""}`, "", m.text, ""])].join("\n");
}

export const codingSessionsExport: ExtraTableExport = {
  table: "coding_sessions",
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
    const [r] = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
      SELECT provider, session_id, payload::text AS payload_text, session_ts, version, observed_at FROM coding_sessions WHERE tenant_id = ${ctx.tenantId} AND id = ${key}
    `));
    if (!r) return prev.map((path) => ({ op: "delete" as const, path, deletedAt: j.enqueuedAt, reason: "session_row_deleted", capturedAt: j.enqueuedAt }));
    const base = sessionPath(String(r.provider), new Date(iso(r.session_ts)), String(r.session_id));
    const capturedAt = iso(r.observed_at);
    const payload = JSON.parse(String(r.payload_text)) as Record<string, unknown>;
    const version = Number(r.version);
    const provenance = { runtime: "coding-sessions device lane", port: "askshepherd/gigabrain@5448774e0a121570666adaa0c8ca18570df72be9 brain/src/integrations/coding-sessions", externalId: String(r.session_id), contentHash: String(payload.contentHash) };
    const updated = typeof payload.lastUpdatedAt === "string" ? payload.lastUpdatedAt : typeof payload.endedAt === "string" ? payload.endedAt : null;
    return [
      { op: "put", path: `${base}.json`, kind: "raw", contentType: "application/json", content: Buffer.from(String(r.payload_text), "utf8"), sourceUpdatedAt: updated, capturedAt, sourceVersion: { ref: `v${version}`, ordinal: version }, provenance },
      { op: "put", path: `${base}.md`, kind: "projection", contentType: "text/markdown", content: Buffer.from(renderTranscript(payload), "utf8"), sourceUpdatedAt: updated, capturedAt, sourceVersion: { ref: `v${version}`, ordinal: version }, provenance },
    ];
  },
};

export async function codingSessionsCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const devices = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
    SELECT binding_id, status, last_seen_at FROM coding_session_devices WHERE tenant_id = ${ctx.tenantId} ORDER BY created_at
  `));
  if (!devices.length) return [{ provider: CODING_SESSIONS_PROVIDER, scope: "devices", state: "pending", reason: "no enrolled coding-sessions device" }];
  const out: CoverageReport[] = [];
  for (const d of devices) {
    const scope = `device:${d.binding_id}`;
    if (d.status !== "active") {
      out.push({ provider: CODING_SESSIONS_PROVIDER, scope, state: "blocked", reason: "device binding revoked" });
      continue;
    }
    const [sync] = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
      SELECT result, completed_at FROM coding_session_commands
      WHERE tenant_id = ${ctx.tenantId} AND binding_id = ${String(d.binding_id)} AND command_type = 'source_sync' AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 1
    `));
    const result = (sync ? (typeof sync.result === "string" ? JSON.parse(sync.result) : sync.result) : null) as Record<string, unknown> | null;
    const full = result?.fullInventory === true && result.exhausted === true && result.capHit !== true && !Number(result.failedUploads ?? 0) && !Number(result.pendingUploads ?? 0);
    out.push({
      provider: CODING_SESSIONS_PROVIDER, scope, state: full ? "complete" : d.last_seen_at ? "partial" : "pending",
      reason: full
        ? `full local inventory confirmed by a source_sync receipt at ${iso(sync!.completed_at)}; sessions are the agent's redacted, normalized transcripts (not raw JSONL)`
        : "no validated full-inventory source_sync receipt yet; sessions arrive as the Mac agent uploads them (normalized transcripts, not raw JSONL)",
      ...(d.last_seen_at ? { lastSuccessAt: iso(d.last_seen_at) } : {}),
    });
  }
  return out;
}

export function createCodingSessionsProvider(deps: { db?: Executor; authority?: DeviceAuthority } = {}): SourceProviderModule {
  return {
    id: CODING_SESSIONS_PROVIDER,
    eventSources: [CODING_SESSION_SOURCE],
    mirrorRoots: [],
    connectionProviders: [],
    extraTables: [codingSessionsExport],
    coverage: (ctx) => codingSessionsCoverage(ctx),
    publicRoutes: (app) => registerCodingSessionsPublicRoutes(app, deps),
    internalRoutes: (app, d) => registerCodingSessionsInternalRoutes(app, { ...d, ...(deps.db ? { db: deps.db } : {}) }),
  };
}
