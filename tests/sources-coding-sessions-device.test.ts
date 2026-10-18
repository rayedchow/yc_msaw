import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";

/**
 * Mac coding-sessions agent end to end: the real yc_msaw app (static keys) and the real source runtime
 * (packages/sources-runtime: PGlite with the real migration plan, the production coding-sessions module with
 * its default yc_msaw authority), both on loopback HTTP. yc_msaw mints the `gcs_` key once and is asked on
 * every agent request; revoking the binding refuses the device at once (even if the runtime revoke were
 * lost) and the key never authorizes MCP, admin or publish routes. Synthetic data only.
 */
process.env.DATABASE_URL ??= "postgres://localhost:5432/aqueduct_test";
process.env.ENCRYPTION_KEY ??= "aqueduct-test-encryption-key";
process.env.API_KEY_PEPPER ??= "aqueduct-test-api-key-pepper";
process.env.WORKOS_API_KEY ??= "sk_test_workos";
process.env.WORKOS_CLIENT_ID ??= "client_test_workos";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let rt: Any;
let runtime: { url: string; close: () => Promise<void> };
let app: App;
let dir: string;
let base: string;
let keys: Record<"admin" | "collector" | "reader" | "rival" | "noScope", string>;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const call = (method: string, route: string, key: string, body?: unknown) =>
  fetch(base + route, { method, headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
/** Exactly what shepherd-onboard's coding-sessions sender sends. */
const agent = (apiUrl: string, method: string, route: string, token: string, body?: unknown) =>
  fetch(`${apiUrl}/api/coding-sessions/ingest${route}`, { method, headers: { "Content-Type": "application/json", "x-api-key": token }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

beforeAll(async () => {
  const harness = "../packages/sources-runtime/tests/source-lane/providers/coding-sessions/harness.js";
  rt = await import(/* @vite-ignore */ harness);
  await rt.ready;
  for (const t of ["acme", "rival"]) await rt.resetTenant(t);
  runtime = await rt.serveApp();
  const { generateStaticKey } = await import("../src/auth/static-keys.js");
  const admin = generateStaticKey("acme", ["memory:build", "memory:read"]);
  const collector = generateStaticKey("acme", ["traces:write"]);
  const reader = generateStaticKey("acme", ["memory:read"]);
  // Owner-only sources: memory:read members may enrol their own device; a key without a source scope may not.
  const noScope = generateStaticKey("acme", ["integrations:read"]);
  const rival = generateStaticKey("rival", ["memory:build", "memory:read", "traces:write"]);
  keys = { admin: admin.key, collector: collector.key, reader: reader.key, rival: rival.key, noScope: noScope.key };
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-coding-device-"));
  const port = await freePort();
  const { createApp } = await import("../src/app.js");
  const { DirectoryObjectStore } = await import("../src/store/objects.js");
  app = await createApp({
    env: {
      HOST: "127.0.0.1", AUTH_MODE: "static", PROCMEM_STATIC_KEYS: [admin.entry, collector.entry, reader.entry, rival.entry, noScope.entry].join(","), PROCMEM_STATIC_KEYS_ON_MCP: "1",
      PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: dir, SOURCES_RUNTIME_SERVICE_TOKEN: rt.SERVICE_TOKEN,
      SOURCES_RUNTIME_URL: `${runtime.url}/internal/v1`, SOURCES_PUBLISH_URL: `http://127.0.0.1:${port}`, SOURCES_DEVICE_API_URL: runtime.url,
    },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => { throw new Error("no builds"); },
    leaseFactory: async () => { throw new Error("no sandboxes"); },
    log: () => undefined,
  });
  await app.listen(port);
  base = `http://127.0.0.1:${port}`;
  for (const k of [keys.admin, keys.rival]) expect((await call("POST", "/v1/sources/runtime/provision", k)).status).toBe(201);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Mac coding-sessions agent with yc_msaw as the authority", () => {
  it("mints the agent config once, uploads through the runtime, and revocation in yc_msaw refuses the device immediately", async () => {
    expect((await call("POST", "/v1/sources/devices/coding-sessions/setup", keys.noScope, {})).status).toBe(403);
    expect((await call("POST", "/v1/sources/devices/coding-sessions/setup", keys.collector, { userId: "rival" })).status).toBe(400);
    expect((await call("POST", "/v1/sources/devices/coding-sessions", keys.collector, { bindingId: "sb-0123456789abcdef", tokenSha256: "0".repeat(64) })).status).toBe(400);
    const res = await call("POST", "/v1/sources/devices/coding-sessions/setup", keys.collector, { label: "Ada's Mac", intervalSeconds: 300 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Any;
    const cfg = body.codingSessionsConfig as { apiUrl: string; userId: string; agentToken: string; intervalSeconds: number };
    const bindingId = body.binding.bindingId as string;
    expect(cfg).toEqual({ apiUrl: runtime.url, userId: "acme", agentToken: expect.stringMatching(new RegExp(`^gcs_acme\\.${bindingId}\\.[A-Za-z0-9_-]{43}$`)), intervalSeconds: 300 });

    // Upload and command poll with the agent's exact headers; a body userId cannot switch tenants.
    const up = await agent(cfg.apiUrl, "POST", "", cfg.agentToken, { userId: "rival", sessions: [rt.session()] });
    expect(await up.json()).toMatchObject({ stored: 1 });
    expect((await agent(cfg.apiUrl, "GET", "/command", cfg.agentToken)).status).toBe(200);
    const rows = (await rt.pg.query(`SELECT tenant_id FROM coding_sessions`)).rows as Array<{ tenant_id: string }>;
    expect(rows.map((r) => r.tenant_id)).toEqual(["acme"]);

    // The device key is not an MCP/admin/publish credential.
    for (const route of ["/v1/sources/status", "/v1/sources/bindings"]) expect((await call("GET", route, cfg.agentToken)).status).toBe(401);
    expect((await call("POST", "/v1/sources/publish", cfg.agentToken, { batchId: "b", changes: [] })).status).toBe(401);

    // Revoke in yc_msaw: the runtime credential is revoked too, and the next agent request is refused.
    const del = await call("DELETE", `/v1/sources/bindings/${bindingId}`, keys.admin);
    expect(del.status).toBe(200);
    expect(((await del.json()) as Any).runtimeDevices["coding-sessions"]).toMatchObject({ revoked: true });
    expect((await agent(cfg.apiUrl, "POST", "", cfg.agentToken, { sessions: [rt.session({ sessionId: "s2" })] })).status).toBe(401);
    expect((await agent(cfg.apiUrl, "GET", "/command", cfg.agentToken)).status).toBe(401);
    expect(((await rt.pg.query(`SELECT count(*)::int AS n FROM coding_sessions`)).rows[0] as Any).n).toBe(1);
    expect(((await call("GET", `/v1/sources/devices/coding-sessions/verify`, "")) as Response).status).toBe(401);
  });

  it("the runtime refuses a device whose binding exists only at the runtime (yc_msaw never issued it)", async () => {
    const forged = await rt.enroll("acme");
    expect((await agent(runtime.url, "POST", "", forged.key, { sessions: [rt.session({ sessionId: "forged" })] })).status).toBe(401);
    expect(((await rt.pg.query(`SELECT status FROM coding_session_devices WHERE binding_id = $1`, [forged.bindingId])).rows[0] as Any).status).toBe("revoked");
  });
});
