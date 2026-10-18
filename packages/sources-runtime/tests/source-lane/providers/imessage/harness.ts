/**
 * Test harness: an in-process PostgreSQL (PGlite) with the real source-lane migration
 * plan applied (donor source migrations, core 9000/9001, this provider's 9550), the real
 * runtime Hono app (service-token internal middleware, forwarded-principal tenant check)
 * with the production iMessage module mounted, and helpers that speak the Mac uploader's
 * wire through it. Synthetic data only; no Messages database is read.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { createRuntimeApp } from "../../../../src/source-lane/internal/app.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { createImessageProvider } from "../../../../src/source-lane/providers/imessage/index.js";
import { deviceKeyForBindingToken, sha256Hex } from "../../../../src/source-lane/providers/imessage/device-auth.js";
import type { ImessageDb } from "../../../../src/source-lane/providers/imessage/util.js";
import type { AuthorityVerdict, DeviceAuthority } from "../../../../src/source-lane/providers/imessage/authority.js";

export const pg = new PGlite();
export const db = drizzle(pg) as unknown as ImessageDb;

export const ready: Promise<void> = (async () => {
  for (const file of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
})();

export const SERVICE_TOKEN = `svc_${randomBytes(24).toString("hex")}`;

/**
 * Stand-in for yc_msaw's device-key authority (the real HTTP authority is tested in
 * authority.test.ts and end to end in yc_msaw tests/sources-imessage-device.test.ts).
 * Answers "active" for keys it issued unless revoked; `down` simulates yc_msaw unreachable.
 */
export const fakeAuthority = {
  issued: new Map<string, string>(),
  revoked: new Set<string>(),
  down: false,
  calls: 0,
  async verify(key: string, device: { tenantNs: string; bindingId: string }): Promise<AuthorityVerdict> {
    fakeAuthority.calls++;
    if (fakeAuthority.down) return { state: "unavailable", reason: "yc_msaw unreachable (test)" };
    if (fakeAuthority.issued.get(device.bindingId) !== key || fakeAuthority.revoked.has(device.bindingId)) return { state: "revoked", reason: "yc_msaw refused the device key (401)" };
    return { state: "active" };
  },
} satisfies DeviceAuthority & Record<string, unknown>;

/** The provider with its default authority (yc_msaw at the tenant binding's publish URL). */
export const providerWithBindingAuthority = createImessageProvider({ db });
export const provider = createImessageProvider({ db, authority: fakeAuthority });
export const registry = new SourceProviderRegistry([provider]);
export const app = createRuntimeApp({
  db: db as never,
  registry,
  exporter: new SourceExporter({ db: db as never, registry, log: () => {} }),
  serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"),
  integrations: [],
  mountInternal: true,
});

/** The runtime app exactly as deployed: the iMessage module with its default yc_msaw authority. */
export const productionRegistry = new SourceProviderRegistry([providerWithBindingAuthority]);
export const productionApp = createRuntimeApp({
  db: db as never,
  registry: productionRegistry,
  exporter: new SourceExporter({ db: db as never, registry: productionRegistry, log: () => {} }),
  serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"),
  integrations: [],
  mountInternal: true,
});

export async function query<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

const TENANT_TABLES = [
  ["imessage_device_commands", "tenant_id"],
  ["imessage_sync_progress", "tenant_id"],
  ["imessage_message_mutations", "tenant_id"],
  ["imessage_ingest_rejections", "tenant_id"],
  ["imessage_projection_dirty", "tenant_id"],
  ["imessage_contacts", "tenant_id"],
  ["imessage_devices", "tenant_id"],
  ["activity_event_source_aliases", "user_id"],
  ["activity_events", "user_id"],
  ["mirror_files", "user_id"],
  ["conversation_watermarks", "user_id"],
  ["source_sync_runs", "user_id"],
  ["task_queue", "tenant_id"],
  ["task_schedules", "tenant_id"],
  ["source_lane_journal", "tenant_id"],
  ["source_lane_exported", "tenant_id"],
  ["source_lane_bindings", "tenant_id"],
] as const;

export async function resetTenant(tenantId: string): Promise<void> {
  for (const [table, col] of TENANT_TABLES) await pg.query(`DELETE FROM ${table} WHERE ${col} = $1`, [tenantId]);
}

export interface Enrolled {
  tenantId: string;
  bindingId: string;
  /** The psb_ one-time binding token yc_msaw would mint. */
  bindingToken: string;
  /** The Mac uploader key (agentToken / x-api-key). */
  key: string;
}

/** Mint a synthetic yc_msaw device binding token (same shape as yc_msaw SourceBindings tokens). */
export function mintBinding(tenantId: string): Omit<Enrolled, "key"> & { key: string } {
  const bindingId = `sb-${randomBytes(8).toString("hex")}`;
  const bindingToken = `psb_${tenantId}.${bindingId}.${randomBytes(32).toString("base64url")}`;
  return { tenantId, bindingId, bindingToken, key: deviceKeyForBindingToken(bindingToken) };
}

export function principal(tenantNs: string, scopes = ["memory:build", "memory:read"]): string {
  return JSON.stringify({ tenantNs, subject: `user_${tenantNs}`, issuer: "https://auth.example.test", scopes });
}

export function internal(method: string, route: string, opts: { body?: unknown; tenant?: string; scopes?: string[]; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? SERVICE_TOKEN}`;
  if (opts.tenant) headers["x-procmem-principal"] = principal(opts.tenant, opts.scopes);
  return app.request(`/internal/v1${route}`, { method, headers, ...(opts.body !== undefined ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) } : {}) });
}

export async function enroll(tenantId: string, extra: Record<string, unknown> = {}): Promise<Enrolled> {
  const b = mintBinding(tenantId);
  const res = await internal("POST", `/tenants/${tenantId}/devices/imessage`, { tenant: tenantId, body: { bindingId: b.bindingId, tokenSha256: sha256Hex(b.key), label: "Test Mac", ...extra } });
  if (res.status !== 201) throw new Error(`enroll failed ${res.status}: ${await res.text()}`);
  fakeAuthority.issued.set(b.bindingId, b.key);
  return b;
}

/** Exactly what the bundled Mac uploader sends: `x-api-key` and (always) Content-Type: application/json. */
export function wire(method: string, route: string, device: Pick<Enrolled, "key">, body?: unknown, opts: { key?: string | null; target?: { request: typeof app.request } } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key !== null) headers["x-api-key"] = opts.key ?? device.key;
  return (opts.target ?? app).request(`/api/imessage/ingest${route}`, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}

export async function ingest(device: Enrolled, messages: unknown[], extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await wire("POST", "", device, { messages, ...extra });
  const body = (await res.json()) as Record<string, any>;
  if (res.status !== 200) throw new Error(`ingest ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/** A message in the exact field set the bundled Mac uploader sends (shepherd-onboard messageForIngest). */
export function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  const rowId = (over.rowId as number | undefined) ?? 1;
  return {
    messageId: over.messageId ?? `GUID-${rowId}`,
    providerMessageGuid: over.messageId ?? `GUID-${rowId}`,
    _provider_guid_explicit: true,
    localRowId: rowId,
    rowId,
    deviceId: "11111111-1111-4111-8111-111111111111",
    agentVersion: "0.9.0-test",
    agentChannel: "test",
    text: "hello",
    service: "iMessage",
    chatId: "iMessage;-;+15550001111",
    chatKind: "dm",
    chatName: null,
    participant: "+15550001111",
    isFromMe: false,
    createdAt: "2026-09-10T12:00:00.000Z",
    deliveredAt: null,
    readAt: null,
    editedAt: null,
    retractedAt: null,
    reaction: null,
    attachments: [],
    replyToMessageId: null,
    threadRootMessageId: null,
    sendEffect: null,
    kind: "message",
    isAudioMessage: false,
    isForwarded: false,
    affectedParticipant: null,
    newGroupName: null,
    _resolved_name: null,
    _is_self_handle: false,
    ...over,
  };
}

export async function events(tenantId: string, source = "imessage") {
  return query<{ id: string; source: string; source_event_id: string; event_type: string; record_kind: string; raw_payload: Record<string, any>; processing_status: string }>(
    `SELECT id::text AS id, source, source_event_id, event_type, record_kind, raw_payload, processing_status FROM activity_events WHERE user_id = $1 AND source = $2 ORDER BY timestamp, source_event_id`,
    [tenantId, source],
  );
}

export async function mirror(tenantId: string, prefix = "sources/imessage/") {
  return query<{ path: string; content: string }>(`SELECT path, content FROM mirror_files WHERE user_id = $1 AND path LIKE $2 ORDER BY path`, [tenantId, `${prefix}%`]);
}

/** Serve the runtime app on a loopback port (used by yc_msaw's end-to-end device test). */
export async function serveApp(target: { fetch: typeof app.fetch } = productionApp): Promise<{ url: string; close: () => Promise<void> }> {
  const { serve } = await import("@hono/node-server");
  // Keep Node's global Request/Response: yc_msaw may run in the same process.
  const server = serve({ fetch: target.fetch, port: 0, hostname: "127.0.0.1", overrideGlobalObjects: false });
  await new Promise((r) => setTimeout(r, 50));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
