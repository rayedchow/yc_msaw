/**
 * Coding-sessions runtime harness: PGlite with the real migration plan, the real runtime app (service-token
 * internal middleware, forwarded principal) with the production coding-sessions module, either with a fake
 * yc_msaw authority or the default HTTP authority. Synthetic data only.
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
import { createCodingSessionsProvider, type AuthorityVerdict } from "../../../../src/integrations/coding-sessions/lane.js";

export const pg = new PGlite();
export const db = drizzle(pg);
export const ready: Promise<void> = (async () => {
  for (const file of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
})();
export const SERVICE_TOKEN = `svc_${randomBytes(24).toString("hex")}`;

export const fakeAuthority = {
  revoked: new Set<string>(),
  down: false,
  async verify(_key: string, device: { bindingId: string }): Promise<AuthorityVerdict> {
    if (fakeAuthority.down) return { state: "unavailable", reason: "yc_msaw unreachable (test)" };
    return fakeAuthority.revoked.has(device.bindingId) ? { state: "revoked", reason: "refused (test)" } : { state: "active" };
  },
};

function runtimeApp(authority?: typeof fakeAuthority) {
  const registry = new SourceProviderRegistry([createCodingSessionsProvider({ db: db as never, ...(authority ? { authority } : {}) })]);
  return createRuntimeApp({
    db: db as never, registry, exporter: new SourceExporter({ db: db as never, registry, log: () => {} }),
    serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"), integrations: [], mountInternal: true,
  });
}
export const app = runtimeApp(fakeAuthority);
export const productionApp = runtimeApp();

export function internal(method: string, route: string, tenant: string, body?: unknown, scopes = ["traces:write"]) {
  return app.request(`/internal/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "x-procmem-principal": JSON.stringify({ tenantNs: tenant, subject: "u1", issuer: "test", scopes }), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export function mintKey(tenant: string): { key: string; bindingId: string } {
  const bindingId = `sb-${randomBytes(8).toString("hex")}`;
  return { bindingId, key: `gcs_${tenant}.${bindingId}.${randomBytes(32).toString("base64url")}` };
}

export async function enroll(tenant: string) {
  const d = mintKey(tenant);
  const r = await internal("POST", `/tenants/${tenant}/devices/coding-sessions`, tenant, { bindingId: d.bindingId, tokenSha256: createHash("sha256").update(d.key).digest("hex"), label: "Mac" });
  if (r.status !== 201) throw new Error(`enroll failed ${r.status}`);
  return d;
}

/** Exactly what shepherd-onboard sends: JSON content type on every request, including GET. */
export function wire(target: { request: typeof app.request }, method: string, route: string, key: string, body?: unknown) {
  return target.request(`/api/coding-sessions/ingest${route}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": key },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export function session(over: Record<string, unknown> = {}) {
  return {
    provider: "codex", sessionId: "sess-1", startedAt: "2026-10-01T10:00:00Z", lastUpdatedAt: "2026-10-01T10:30:00Z", status: "completed",
    title: "Fix flaky test", repo: { fullName: "acme/app", branch: "main" },
    userMessages: [{ order: 0, text: "please fix the flaky test", timestamp: "2026-10-01T10:00:00Z" }],
    agentResponses: [{ order: 1, text: "Fixed by awaiting the promise.", phase: "final_answer" }],
    ...over,
  };
}

export async function serveApp(target: { fetch: typeof app.fetch } = productionApp) {
  const { serve } = await import("@hono/node-server");
  const server = serve({ fetch: target.fetch, port: 0, hostname: "127.0.0.1", overrideGlobalObjects: false });
  await new Promise((r) => setTimeout(r, 50));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function resetTenant(t: string) {
  await pg.query(`DELETE FROM coding_sessions WHERE tenant_id = $1`, [t]);
  await pg.query(`DELETE FROM coding_session_commands WHERE tenant_id = $1`, [t]);
  await pg.query(`DELETE FROM coding_session_devices WHERE tenant_id = $1`, [t]);
  await pg.query(`DELETE FROM activity_events WHERE user_id = $1`, [t]);
  await pg.query(`DELETE FROM source_lane_bindings WHERE tenant_id = $1`, [t]).catch(() => undefined);
}
