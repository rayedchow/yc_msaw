import { sql } from "drizzle-orm";
import { upsertTaskSchedule } from "../../../queue/sweeper.js";
import { NangoApiError } from "./api.js";
import { MIN_POLL_SECONDS, sourceByKey } from "./config.js";
import { rows, safeError, toDate, type NangoRecordsLane } from "./lane.js";

/**
 * Tenant ownership of Nango connections captured by the generic lane.
 *
 * A row is created only by consuming a connect session this server created for a verified
 * yc_msaw principal (sessions.ts). (provider_config_key, connection_id) is the primary key,
 * so a connection can never be re-bound to a second tenant. Status changes reported by
 * webhooks are not trusted as such: they trigger an authenticated GET /connections check.
 */

export const POLL_TASK = "nango_records.poll";
export const SYNC_TASK = "nango_records.sync";
export const RECONCILE_TASK = "nango_records.reconcile";

export type ConnectionStatus = "active" | "error" | "revoked";

export interface LaneConnection {
  providerConfigKey: string;
  connectionId: string;
  tenantId: string;
  source: string;
  status: ConnectionStatus;
  lastError: string | null;
  boundVia: string;
  createdAt: string | null;
  lastReconciledAt: string | null;
}

interface ConnectionRow {
  provider_config_key: string;
  connection_id: string;
  tenant_id: string;
  source: string;
  status: ConnectionStatus;
  last_error: string | null;
  bound_via: string;
  created_at: unknown;
  last_reconciled_at: unknown;
}

function fromRow(r: ConnectionRow): LaneConnection {
  return {
    providerConfigKey: r.provider_config_key,
    connectionId: r.connection_id,
    tenantId: r.tenant_id,
    source: r.source,
    status: r.status,
    lastError: r.last_error,
    boundVia: r.bound_via,
    createdAt: toDate(r.created_at)?.toISOString() ?? null,
    lastReconciledAt: toDate(r.last_reconciled_at)?.toISOString() ?? null,
  };
}

export function pollGroupKey(tenantId: string): string {
  return `${tenantId}:nango-records`;
}

export function syncGroupKey(tenantId: string, providerConfigKey: string, connectionId: string): string {
  return `nango-records:${tenantId}:${providerConfigKey}:${connectionId}`;
}

export async function getConnection(lane: NangoRecordsLane, providerConfigKey: string, connectionId: string): Promise<LaneConnection | null> {
  const r = rows<ConnectionRow>(
    await lane.db.execute(sql`
      SELECT provider_config_key, connection_id, tenant_id, source, status, last_error, bound_via, created_at, last_reconciled_at
      FROM nango_records_connections WHERE provider_config_key = ${providerConfigKey} AND connection_id = ${connectionId}
    `),
  )[0];
  return r ? fromRow(r) : null;
}

export async function tenantConnections(lane: NangoRecordsLane, tenantId: string, source?: string): Promise<LaneConnection[]> {
  return rows<ConnectionRow>(
    await lane.db.execute(sql`
      SELECT provider_config_key, connection_id, tenant_id, source, status, last_error, bound_via, created_at, last_reconciled_at
      FROM nango_records_connections
      WHERE tenant_id = ${tenantId} ${source ? sql`AND source = ${source}` : sql``}
      ORDER BY source, connection_id
    `),
  ).map(fromRow);
}

export type BindOutcome = { bound: true; connection: LaneConnection } | { bound: false; reason: string };

/**
 * Record that `connectionId` of `providerConfigKey` belongs to `tenantId`. Idempotent for the
 * same tenant (re-authorization re-activates); refused when the connection is owned by another
 * tenant. Mirrors the row into the donor `connections` table (status visibility) and arms the
 * tenant's polling floor.
 */
export async function bindConnection(
  lane: NangoRecordsLane,
  input: { tenantId: string; source: string; providerConfigKey: string; connectionId: string; sessionId: string | null; boundVia: "webhook" | "reconcile"; nangoProvider?: string | null; authMode?: string | null; remoteCreatedAt?: Date | null },
): Promise<BindOutcome> {
  const r = rows<ConnectionRow>(
    await lane.db.execute(sql`
      INSERT INTO nango_records_connections (
        provider_config_key, connection_id, tenant_id, source, status, session_id, nango_provider, auth_mode,
        remote_created_at, bound_via, last_auth_event_at
      ) VALUES (
        ${input.providerConfigKey}, ${input.connectionId}, ${input.tenantId}, ${input.source}, 'active', ${input.sessionId},
        ${input.nangoProvider ?? null}, ${input.authMode ?? null},
        ${input.remoteCreatedAt ? input.remoteCreatedAt.toISOString() : null}::timestamptz, ${input.boundVia}, now()
      )
      ON CONFLICT (provider_config_key, connection_id) DO UPDATE SET
        status = 'active', last_error = NULL, last_auth_event_at = now(), updated_at = now(),
        nango_provider = COALESCE(EXCLUDED.nango_provider, nango_records_connections.nango_provider),
        auth_mode = COALESCE(EXCLUDED.auth_mode, nango_records_connections.auth_mode)
      WHERE nango_records_connections.tenant_id = EXCLUDED.tenant_id AND nango_records_connections.source = EXCLUDED.source
      RETURNING provider_config_key, connection_id, tenant_id, source, status, last_error, bound_via, created_at, last_reconciled_at
    `),
  )[0];
  if (!r) return { bound: false, reason: "connection is already bound to another tenant or source" };
  await mirrorDonorConnection(lane, fromRow(r));
  await ensurePollSchedule(lane, input.tenantId);
  return { bound: true, connection: fromRow(r) };
}

export async function setConnectionStatus(lane: NangoRecordsLane, conn: LaneConnection, status: ConnectionStatus, error: string | null): Promise<LaneConnection> {
  const r = rows<ConnectionRow>(
    await lane.db.execute(sql`
      UPDATE nango_records_connections
      SET status = ${status}, last_error = ${error}, last_reconciled_at = now(), updated_at = now()
      WHERE provider_config_key = ${conn.providerConfigKey} AND connection_id = ${conn.connectionId} AND tenant_id = ${conn.tenantId}
      RETURNING provider_config_key, connection_id, tenant_id, source, status, last_error, bound_via, created_at, last_reconciled_at
    `),
  )[0];
  const next = r ? fromRow(r) : { ...conn, status, lastError: error };
  await mirrorDonorConnection(lane, next);
  if (status !== "active") await disablePollScheduleIfIdle(lane, conn.tenantId);
  else await ensurePollSchedule(lane, conn.tenantId);
  return next;
}

/** Donor `connections` row (provider = lane source id) so the runtime status endpoint lists it. No credentials. */
async function mirrorDonorConnection(lane: NangoRecordsLane, c: LaneConnection): Promise<void> {
  const metadata = { authMode: "nango", lane: "nango-records", providerConfigKey: c.providerConfigKey, nangoConnectionId: c.connectionId, ...(c.lastError ? { error: c.lastError } : {}) };
  await lane.db.execute(sql`
    INSERT INTO connections (tenant_id, provider, status, external_account_id, metadata)
    VALUES (${c.tenantId}, ${c.source}, ${c.status}, ${c.connectionId}, ${JSON.stringify(metadata)}::jsonb)
    ON CONFLICT (tenant_id, provider, (COALESCE(external_account_id, ''))) DO UPDATE SET
      status = EXCLUDED.status, metadata = connections.metadata || EXCLUDED.metadata, updated_at = now()
  `);
}

/** The tenant's polling floor: one schedule, fanning out to every active connection x captured model. */
export async function ensurePollSchedule(lane: NangoRecordsLane, tenantId: string): Promise<void> {
  const seconds = Math.max(MIN_POLL_SECONDS, Math.min(...lane.catalog.sources.map((s) => s.pollSeconds), 86_400));
  await upsertTaskSchedule({ tenantId, kind: POLL_TASK, frequencySeconds: seconds, groupKey: pollGroupKey(tenantId), payload: { tenantId } }, lane.db);
}

export async function disablePollScheduleIfIdle(lane: NangoRecordsLane, tenantId: string): Promise<void> {
  await lane.db.execute(sql`
    UPDATE task_schedules SET enabled = false, updated_at = now()
    WHERE tenant_id = ${tenantId} AND kind = ${POLL_TASK} AND group_key = ${pollGroupKey(tenantId)}
      AND NOT EXISTS (SELECT 1 FROM nango_records_connections WHERE tenant_id = ${tenantId} AND status IN ('active', 'error'))
  `);
}

/**
 * Authenticated health check: the connection's state as Nango reports it (GET /connections
 * ?connectionId=). Absent => revoked; an auth/refresh error => error; otherwise active.
 */
export async function checkConnectionHealth(lane: NangoRecordsLane, conn: LaneConnection): Promise<LaneConnection> {
  if (!lane.api) return conn;
  if (conn.status === "revoked") return conn;
  let remote;
  try {
    remote = (await lane.api.listConnections({ connectionId: conn.connectionId })).find((c) => c.providerConfigKey === conn.providerConfigKey);
  } catch (error) {
    if (error instanceof NangoApiError && error.retryable) throw error;
    lane.log(`health check failed for ${conn.providerConfigKey}/${conn.connectionId}: ${safeError(error)}`);
    return conn;
  }
  if (!remote) return setConnectionStatus(lane, conn, "revoked", "connection no longer exists in Nango");
  const authErrors = remote.errors.filter((e) => e.type === "auth" || e.type === "refresh" || e.type === null);
  if (authErrors.length) return setConnectionStatus(lane, conn, "error", `Nango reports ${authErrors.map((e) => e.type ?? "unknown").join(", ")} error; the account must be re-authorized`);
  return setConnectionStatus(lane, conn, "active", null);
}

/** Disconnect: delete the Nango connection (404 = already gone), mark revoked, stop polling when idle. Captured history stays. */
export async function revokeConnection(lane: NangoRecordsLane, tenantId: string, source: string, connectionId: string): Promise<{ revoked: boolean; remoteDeleted: boolean } | null> {
  const s = lane.catalog.sources.find((x) => x.source === source);
  const rows = await tenantConnections(lane, tenantId, source);
  const conn = rows.find((c) => c.connectionId === connectionId && (!s || c.providerConfigKey === s.providerConfigKey));
  if (!conn) return null;
  let remoteDeleted = false;
  if (lane.api) remoteDeleted = (await lane.api.deleteConnection({ providerConfigKey: conn.providerConfigKey, connectionId })).deleted;
  await setConnectionStatus(lane, conn, "revoked", "disconnected by an administrator");
  await lane.db.execute(sql`
    UPDATE task_queue SET state = 'cancelled', finished_at = now(), error_message = 'connection revoked'
    WHERE state = 'queued' AND kind = ${SYNC_TASK} AND group_key = ${syncGroupKey(tenantId, conn.providerConfigKey, connectionId)}
  `);
  return { revoked: true, remoteDeleted };
}

/** Configured source of a connection's integration (undefined when the operator removed it from the catalog). */
export function sourceOf(lane: NangoRecordsLane, conn: Pick<LaneConnection, "providerConfigKey" | "source">) {
  const s = sourceByKey(lane.catalog, conn.providerConfigKey);
  return s && s.source === conn.source ? s : undefined;
}
