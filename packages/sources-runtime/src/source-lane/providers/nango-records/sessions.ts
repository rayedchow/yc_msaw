import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { bindConnection } from "./connections.js";
import { sourceById } from "./config.js";
import { rows, safeError, toDate, type NangoRecordsLane } from "./lane.js";

/**
 * Nango connect sessions bound to a verified yc_msaw principal.
 *
 * The tenant comes only from the internal route (core checked it equals the forwarded
 * principal's tenantNs). The server sends Nango one random correlation tag
 * (`tags.procmem_session`), which Nango copies onto the created connection and into the auth
 * webhook. A connection is bound to a tenant only by consuming that session: once, for the
 * integration it was created for, and only while it is valid (Nango's 30-minute expiry plus a
 * short delivery grace for the webhook; for the reconcile path the connection's own creation
 * time must fall inside the validity window). Tags are never read as tenant identity.
 */

export const SESSION_TAG = "procmem_session";
export const SOURCE_TAG = "procmem_source";
/** Nango documents connect sessions as short-lived (30 minutes). */
export const MAX_SESSION_TTL_MS = 30 * 60_000;
/** Accept the signed auth webhook this long after expiry (Nango retries deliveries for seconds; clocks drift). */
export const WEBHOOK_GRACE_MS = 10 * 60_000;
/** Reconcile path: connection.created may trail expires_at by at most this clock skew. */
export const CREATED_SKEW_MS = 2 * 60_000;
export const MAX_OPEN_SESSIONS_PER_TENANT = 10;

export class SessionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 | 503, readonly code: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionPrincipal {
  subject: string;
  issuer: string;
}

export interface CreatedSession {
  sessionId: string;
  source: string;
  providerConfigKey: string;
  /** Nango connect session token for the Connect UI; returned once, never stored. */
  token: string;
  connectLink: string | null;
  expiresAt: string;
}

export async function createSession(lane: NangoRecordsLane, input: { tenantId: string; principal: SessionPrincipal; source: string }): Promise<CreatedSession> {
  const source = sourceById(lane.catalog, input.source);
  if (!source) throw new SessionError(`source ${JSON.stringify(input.source)} is not a configured Nango records source`, 404, "source_not_configured");
  if (!lane.api) throw new SessionError("NANGO_SECRET_KEY is not configured", 503, "nango_not_configured");
  const verification = rows<{ integration_found: boolean | null }>(
    await lane.db.execute(sql`SELECT integration_found FROM nango_records_verification WHERE provider_config_key = ${source.providerConfigKey}`),
  )[0];
  if (verification?.integration_found === false) {
    throw new SessionError(`Nango integration ${source.providerConfigKey} does not exist in this Nango environment`, 409, "integration_not_found");
  }
  const open = Number(
    rows<{ n: number | string }>(
      await lane.db.execute(sql`SELECT count(*)::int AS n FROM nango_records_connect_sessions WHERE tenant_id = ${input.tenantId} AND consumed_at IS NULL AND expires_at > now()`),
    )[0]?.n ?? 0,
  );
  if (open >= MAX_OPEN_SESSIONS_PER_TENANT) throw new SessionError("too many open connect sessions for this tenant; finish or wait for them to expire", 429, "too_many_sessions");

  const tag = randomBytes(24).toString("hex");
  const created = await lane.api.createConnectSession({
    allowedIntegration: source.providerConfigKey,
    tags: { [SESSION_TAG]: tag, [SOURCE_TAG]: source.source },
    ...(lane.webhookUrlOverride ? { webhookUrlOverride: lane.webhookUrlOverride } : {}),
  });
  const now = lane.now();
  const cap = new Date(now.getTime() + MAX_SESSION_TTL_MS);
  const expiresAt = created.expiresAt && created.expiresAt < cap ? created.expiresAt : cap;
  const r = rows<{ id: string }>(
    await lane.db.execute(sql`
      INSERT INTO nango_records_connect_sessions (session_tag, tenant_id, principal_subject, principal_issuer, source, provider_config_key, created_at, expires_at)
      VALUES (${tag}, ${input.tenantId}, ${input.principal.subject}, ${input.principal.issuer}, ${source.source}, ${source.providerConfigKey},
              ${now.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz)
      RETURNING id::text AS id
    `),
  )[0]!;
  return { sessionId: r.id, source: source.source, providerConfigKey: source.providerConfigKey, token: created.token, connectLink: created.connectLink, expiresAt: expiresAt.toISOString() };
}

export type ConsumeResult =
  | { outcome: "connected"; tenantId: string; source: string; sessionId: string }
  | { outcome: "already_connected"; tenantId: string; source: string; sessionId: string }
  | { outcome: "refused"; reason: string; sessionId: string | null };

interface SessionRow {
  id: string;
  tenant_id: string;
  source: string;
  provider_config_key: string;
  expires_at: unknown;
  consumed_at: unknown;
  connection_id: string | null;
  outcome: string;
}

/**
 * Consume a session for a connection Nango created. Atomic (conditional UPDATE): a second
 * connection or a replayed webhook for an already-consumed session is refused, except the
 * identical (session, connection) pair, which is an idempotent re-delivery.
 */
export async function consumeSession(
  lane: NangoRecordsLane,
  input: { tag: string; providerConfigKey: string; connectionId: string; via: "webhook" | "reconcile"; remoteCreatedAt?: Date | null; nangoProvider?: string | null; authMode?: string | null },
): Promise<ConsumeResult> {
  if (!/^[0-9a-f]{48}$/.test(input.tag)) return { outcome: "refused", reason: "malformed session tag", sessionId: null };
  const now = lane.now();
  // Webhook: received within validity + grace. Reconcile: Nango's own creation time inside validity (+ skew).
  const at = input.via === "reconcile" && input.remoteCreatedAt ? input.remoteCreatedAt : now;
  const allowance = input.via === "reconcile" ? CREATED_SKEW_MS : WEBHOOK_GRACE_MS;
  const consumed = rows<SessionRow>(
    await lane.db.execute(sql`
      UPDATE nango_records_connect_sessions
      SET consumed_at = ${now.toISOString()}::timestamptz, connection_id = ${input.connectionId}, outcome = 'connected', last_error = NULL
      WHERE session_tag = ${input.tag}
        AND consumed_at IS NULL
        AND provider_config_key = ${input.providerConfigKey}
        AND ${at.toISOString()}::timestamptz <= expires_at + make_interval(secs => ${allowance / 1000})
        AND ${at.toISOString()}::timestamptz >= created_at - make_interval(secs => ${CREATED_SKEW_MS / 1000})
      RETURNING id::text AS id, tenant_id, source, provider_config_key, expires_at, consumed_at, connection_id, outcome
    `),
  )[0];
  if (consumed) {
    const bound = await bindConnection(lane, {
      tenantId: consumed.tenant_id,
      source: consumed.source,
      providerConfigKey: input.providerConfigKey,
      connectionId: input.connectionId,
      sessionId: consumed.id,
      boundVia: input.via,
      nangoProvider: input.nangoProvider ?? null,
      authMode: input.authMode ?? null,
      remoteCreatedAt: input.remoteCreatedAt ?? null,
    });
    if (!bound.bound) {
      await markSession(lane, consumed.id, "refused", bound.reason);
      return { outcome: "refused", reason: bound.reason, sessionId: consumed.id };
    }
    return { outcome: "connected", tenantId: consumed.tenant_id, source: consumed.source, sessionId: consumed.id };
  }
  const existing = rows<SessionRow>(
    await lane.db.execute(sql`
      SELECT id::text AS id, tenant_id, source, provider_config_key, expires_at, consumed_at, connection_id, outcome
      FROM nango_records_connect_sessions WHERE session_tag = ${input.tag}
    `),
  )[0];
  if (!existing) return { outcome: "refused", reason: "unknown connect session", sessionId: null };
  if (existing.consumed_at && existing.connection_id === input.connectionId && existing.provider_config_key === input.providerConfigKey && existing.outcome === "connected") {
    return { outcome: "already_connected", tenantId: existing.tenant_id, source: existing.source, sessionId: existing.id };
  }
  const reason =
    existing.provider_config_key !== input.providerConfigKey ? `session was created for integration ${existing.provider_config_key}, not ${input.providerConfigKey}`
    : existing.consumed_at ? "connect session was already used"
    : "connect session expired before the connection was created";
  if (!existing.consumed_at) await markSession(lane, existing.id, reason.includes("expired") ? "expired" : "refused", `${reason} (connection ${input.connectionId} left unbound)`);
  else await lane.db.execute(sql`UPDATE nango_records_connect_sessions SET last_error = ${`${reason}: connection ${input.connectionId} left unbound`} WHERE id = ${existing.id}::uuid`);
  return { outcome: "refused", reason, sessionId: existing.id };
}

async function markSession(lane: NangoRecordsLane, id: string, outcome: "expired" | "refused", error: string): Promise<void> {
  await lane.db.execute(sql`UPDATE nango_records_connect_sessions SET outcome = ${outcome}, last_error = ${error.slice(0, 500)} WHERE id = ${id}::uuid AND consumed_at IS NULL`);
}

/**
 * Polling reconciliation for sessions whose auth webhook never arrived: look the session tag
 * up through the authenticated Nango API (GET /connections?tags[procmem_session]=...). Bounded
 * to the tenant's most recent open sessions; sessions past expiry + grace with no connection
 * are closed as expired.
 */
export async function reconcileOpenSessions(lane: NangoRecordsLane, tenantId: string, opts: { sessionId?: string; limit?: number } = {}): Promise<{ checked: number; connected: number; expired: number }> {
  const open = rows<{ id: string; session_tag: string; provider_config_key: string; expires_at: unknown }>(
    await lane.db.execute(sql`
      SELECT id::text AS id, session_tag, provider_config_key, expires_at FROM nango_records_connect_sessions
      WHERE tenant_id = ${tenantId} AND consumed_at IS NULL AND outcome = 'pending'
        ${opts.sessionId ? sql`AND id = ${opts.sessionId}::uuid` : sql``}
      ORDER BY created_at DESC LIMIT ${opts.limit ?? 20}
    `),
  );
  let connected = 0;
  let expired = 0;
  if (!lane.api) return { checked: 0, connected, expired };
  for (const s of open) {
    let remote;
    try {
      remote = await lane.api.listConnections({ tags: { [SESSION_TAG]: s.session_tag } });
    } catch (error) {
      await lane.db.execute(sql`UPDATE nango_records_connect_sessions SET last_error = ${safeError(error)}, last_checked_at = now() WHERE id = ${s.id}::uuid`);
      continue;
    }
    await lane.db.execute(sql`UPDATE nango_records_connect_sessions SET last_checked_at = now() WHERE id = ${s.id}::uuid`);
    // Defensive: Nango filters by tag, but only an exact tag + integration match is considered.
    const match = remote.find((c) => c.tags[SESSION_TAG] === s.session_tag && c.providerConfigKey === s.provider_config_key);
    if (match) {
      const r = await consumeSession(lane, { tag: s.session_tag, providerConfigKey: match.providerConfigKey, connectionId: match.connectionId, via: "reconcile", remoteCreatedAt: match.created, nangoProvider: match.provider });
      if (r.outcome === "connected") connected += 1;
      continue;
    }
    const exp = toDate(s.expires_at);
    if (exp && exp.getTime() + WEBHOOK_GRACE_MS < lane.now().getTime()) {
      await markSession(lane, s.id, "expired", "no connection was created before the session expired");
      expired += 1;
    }
  }
  return { checked: open.length, connected, expired };
}

export interface SessionStatus {
  sessionId: string;
  source: string;
  providerConfigKey: string;
  state: "pending" | "connected" | "expired" | "refused";
  connectionId: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

export async function sessionStatus(lane: NangoRecordsLane, tenantId: string, sessionId: string): Promise<SessionStatus | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const r = rows<{ id: string; source: string; provider_config_key: string; outcome: string; connection_id: string | null; created_at: unknown; expires_at: unknown; last_error: string | null }>(
    await lane.db.execute(sql`
      SELECT id::text AS id, source, provider_config_key, outcome, connection_id, created_at, expires_at, last_error
      FROM nango_records_connect_sessions WHERE id = ${sessionId}::uuid AND tenant_id = ${tenantId}
    `),
  )[0];
  if (!r) return null;
  const state = (["pending", "connected", "expired", "refused"].includes(r.outcome) ? r.outcome : "pending") as SessionStatus["state"];
  return {
    sessionId: r.id,
    source: r.source,
    providerConfigKey: r.provider_config_key,
    state,
    connectionId: state === "connected" ? r.connection_id : null,
    createdAt: toDate(r.created_at)?.toISOString() ?? null,
    expiresAt: toDate(r.expires_at)?.toISOString() ?? null,
    error: r.last_error,
  };
}
