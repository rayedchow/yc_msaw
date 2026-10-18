import { sql } from "drizzle-orm";
import { imessageHandlesFromInput } from "../../../lib/imessage-handles.js";
import { deviceDataTenant } from "../../core/personal-scope.js";
import { deviceKeyMatches, isBindingId, isTokenSha256, parseDeviceKey } from "./device-auth.js";
import { query, type ImessageExecutor } from "./util.js";

/** An enrolled Mac uploader (imessage_devices row) without its credential hash. */
export interface ImessageDevice {
  tenantId: string;
  bindingId: string;
  label: string | null;
  handles: string[];
  status: "active" | "revoked";
  createdAt: string;
  createdBy: { subject: string; issuer: string };
  revokedAt: string | null;
  revokedReason: string | null;
  lastSeenAt: string | null;
  lastDeviceId: string | null;
  lastAgentVersion: string | null;
  lastAgentChannel: string | null;
  localStatus: Record<string, unknown> | null;
  localStatusAt: string | null;
}

/** Authenticated device context of one uploader request. */
export interface DeviceContext {
  tenantId: string;
  bindingId: string;
}

export class DeviceEnrollError extends Error {
  constructor(
    readonly code: "invalid_input" | "binding_exists" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

interface DeviceRow {
  tenant_id: string;
  binding_id: string;
  token_sha256?: string;
  label: string | null;
  handles: unknown;
  status: "active" | "revoked";
  created_at: string | Date;
  created_by_subject: string;
  created_by_issuer: string;
  revoked_at: string | Date | null;
  revoked_reason: string | null;
  last_seen_at: string | Date | null;
  last_device_id: string | null;
  last_agent_version: string | null;
  last_agent_channel: string | null;
  local_status: Record<string, unknown> | null;
  local_status_at: string | Date | null;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toDevice(row: DeviceRow): ImessageDevice {
  return {
    tenantId: row.tenant_id,
    bindingId: row.binding_id,
    label: row.label,
    handles: Array.isArray(row.handles) ? (row.handles as string[]) : [],
    status: row.status,
    createdAt: iso(row.created_at)!,
    createdBy: { subject: row.created_by_subject, issuer: row.created_by_issuer },
    revokedAt: iso(row.revoked_at),
    revokedReason: row.revoked_reason,
    lastSeenAt: iso(row.last_seen_at),
    lastDeviceId: row.last_device_id,
    lastAgentVersion: row.last_agent_version,
    lastAgentChannel: row.last_agent_channel,
    localStatus: row.local_status,
    localStatusAt: iso(row.local_status_at),
  };
}

const DEVICE_COLUMNS = sql.raw(
  "tenant_id, binding_id, label, handles, status, created_at, created_by_subject, created_by_issuer, revoked_at, revoked_reason, last_seen_at, last_device_id, last_agent_version, last_agent_channel, local_status, local_status_at",
);

/**
 * Record a device for a yc_msaw device binding. The runtime never sees the secret:
 * yc_msaw sends sha256(gimsg key). Re-enrolling the same binding with the same hash
 * is idempotent; anything else for an existing binding is refused (a binding id is
 * never re-pointed at another credential, and a revoked binding stays revoked).
 */
export async function enrollImessageDevice(
  executor: ImessageExecutor,
  input: {
    tenantId: string;
    bindingId: unknown;
    tokenSha256: unknown;
    label?: unknown;
    handles?: unknown;
    createdBy: { subject: string; issuer: string };
  },
): Promise<{ device: ImessageDevice; created: boolean }> {
  if (!isBindingId(input.bindingId)) throw new DeviceEnrollError("invalid_input", "bindingId must be a yc_msaw source binding id (sb-<16 hex>)");
  if (!isTokenSha256(input.tokenSha256)) throw new DeviceEnrollError("invalid_input", "tokenSha256 must be the lowercase sha256 hex of the device key");
  if (input.label !== undefined && input.label !== null && typeof input.label !== "string") throw new DeviceEnrollError("invalid_input", "label must be a string");
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 200) : null;
  const handles = imessageHandlesFromInput(input.handles ?? []).slice(0, 50);
  const inserted = await query<DeviceRow>(
    executor,
    sql`
      INSERT INTO imessage_devices (tenant_id, binding_id, token_sha256, label, handles, created_by_subject, created_by_issuer)
      VALUES (${input.tenantId}, ${input.bindingId}, ${input.tokenSha256}, ${label}, ${JSON.stringify(handles)}::jsonb,
              ${input.createdBy.subject.slice(0, 512)}, ${input.createdBy.issuer.slice(0, 512)})
      ON CONFLICT DO NOTHING
      RETURNING ${DEVICE_COLUMNS}
    `,
  );
  if (inserted[0]) return { device: toDevice(inserted[0]), created: true };
  const existing = await query<DeviceRow>(
    executor,
    sql`SELECT ${DEVICE_COLUMNS}, token_sha256 FROM imessage_devices WHERE tenant_id = ${input.tenantId} AND binding_id = ${input.bindingId}`,
  );
  const row = existing[0];
  if (row && row.token_sha256 === input.tokenSha256 && row.status === "active") return { device: toDevice(row), created: false };
  throw new DeviceEnrollError("binding_exists", row ? "this binding is already enrolled with a different credential or was revoked" : "device credential is already enrolled");
}

export async function listImessageDevices(executor: ImessageExecutor, tenantId: string): Promise<ImessageDevice[]> {
  return (await query<DeviceRow>(executor, sql`SELECT ${DEVICE_COLUMNS} FROM imessage_devices WHERE tenant_id = ${tenantId} ORDER BY created_at, binding_id`)).map(toDevice);
}

export async function getImessageDevice(executor: ImessageExecutor, tenantId: string, bindingId: string): Promise<ImessageDevice | null> {
  if (!isBindingId(bindingId)) return null;
  const row = (await query<DeviceRow>(executor, sql`SELECT ${DEVICE_COLUMNS} FROM imessage_devices WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId}`))[0];
  return row ? toDevice(row) : null;
}

/**
 * Revoke a device (yc_msaw forwards this when the device binding is revoked). Takes effect
 * for the next request: every device route re-reads the row. Pending commands are cancelled
 * and their source-sync runs fail, so no command waits on a device that can no longer report.
 */
export async function revokeImessageDevice(
  executor: Pick<ImessageExecutor, "execute">,
  tenantId: string,
  bindingId: string,
  reason = "revoked in yc_msaw",
): Promise<ImessageDevice | null> {
  if (!isBindingId(bindingId)) return null;
  const updated = await query<DeviceRow>(
    executor,
    sql`
      UPDATE imessage_devices
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, ${reason.slice(0, 500)})
      WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId}
      RETURNING ${DEVICE_COLUMNS}
    `,
  );
  if (!updated[0]) return null;
  const cancelled = await query<{ source_sync_run_id: string | null }>(
    executor,
    sql`
      UPDATE imessage_device_commands
      SET status = 'cancelled', acknowledged_at = now(), error = 'device revoked'
      WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId} AND status = 'pending'
      RETURNING source_sync_run_id::text AS source_sync_run_id
    `,
  );
  for (const c of cancelled) {
    if (!c.source_sync_run_id) continue;
    await executor.execute(sql`
      UPDATE source_sync_runs
      SET status = 'failed', phase = 'device_revoked', failed_at = now(), updated_at = now(), error_message = 'iMessage device was revoked before it reported a receipt'
      WHERE id = ${c.source_sync_run_id}::uuid AND status IN ('queued', 'running')
    `);
  }
  return toDevice(updated[0]);
}

/**
 * Check 1 of an uploader request (device-auth.ts): an active device row of the key's own
 * tenant and binding whose hash matches the key in constant time. The caller then asks the
 * yc_msaw authority (authority.ts) before doing anything.
 */
export async function authenticateImessageDevice(executor: ImessageExecutor, key: string | null | undefined): Promise<DeviceContext | null> {
  const parts = parseDeviceKey(key);
  if (!parts) {
    // Still hash once so a malformed request is not measurably faster than a wrong secret.
    deviceKeyMatches(String(key ?? ""), null);
    return null;
  }
  // A device enrolled into its member's owner scope keeps its registry row and data there (core/personal-scope.ts).
  const tenantId = await deviceDataTenant(executor, parts.tenantNs, "imessage", parts.bindingId);
  const row = (
    await query<{ token_sha256: string; status: string }>(
      executor,
      sql`SELECT token_sha256, status FROM imessage_devices WHERE tenant_id = ${tenantId} AND binding_id = ${parts.bindingId}`,
    )
  )[0];
  const match = deviceKeyMatches(key!, row?.token_sha256 ?? null);
  if (!row || !match || row.status !== "active") return null;
  return { tenantId, bindingId: parts.bindingId };
}

export async function touchImessageDevice(
  executor: ImessageExecutor,
  device: DeviceContext,
  meta: { deviceId?: string | null; agentVersion?: string | null; agentChannel?: string | null },
): Promise<void> {
  await executor.execute(sql`
    UPDATE imessage_devices
    SET last_seen_at = now(),
        last_device_id = COALESCE(${meta.deviceId ?? null}, last_device_id),
        last_agent_version = COALESCE(${meta.agentVersion ?? null}, last_agent_version),
        last_agent_channel = COALESCE(${meta.agentChannel ?? null}, last_agent_channel)
    WHERE tenant_id = ${device.tenantId} AND binding_id = ${device.bindingId}
  `);
}
