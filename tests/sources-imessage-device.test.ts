import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";

/**
 * Mac iMessage uploader end to end: the real yc_msaw app (static keys) and the real source
 * runtime (packages/sources-runtime: PGlite with the real migration plan, the production
 * iMessage module with its default yc_msaw authority), both on loopback HTTP.
 *
 * yc_msaw mints the device credential once and stays the authority: the runtime asks
 * GET /v1/sources/devices/imessage/verify on every uploader request. The key never
 * authorizes MCP, admin or publish routes; a body userId cannot switch tenants; revoking the
 * binding refuses the device on its next request and revokes the runtime credential too.
 * (yc_msaw cannot host the five wire routes itself: its mcp-use layer answers the uploader's
 * GET /command, sent with Content-Type: application/json and no body, with 400 "Invalid JSON".)
 * Synthetic data only.
 */

// The runtime's env module parses process.env at import time (packages/sources-runtime/tests/setup-env.ts).
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

async function makeApp(env: Record<string, string>, staticEntries: string[], dataDir: string): Promise<App> {
  const { createApp } = await import("../src/app.js");
  const { DirectoryObjectStore } = await import("../src/store/objects.js");
  return createApp({
    env: {
      HOST: "127.0.0.1",
      AUTH_MODE: "static",
      PROCMEM_STATIC_KEYS: staticEntries.join(","),
      PROCMEM_STATIC_KEYS_ON_MCP: "1",
      PROCMEM_STORE: "directory",
      PROCMEM_SANDBOX: "local",
      PROCMEM_DATA_DIR: dataDir,
      SOURCES_RUNTIME_SERVICE_TOKEN: rt.SERVICE_TOKEN,
      ...env,
    },
    store: new DirectoryObjectStore(path.join(dataDir, "objects")),
    builder: async () => {
      throw new Error("no builds");
    },
    leaseFactory: async () => {
      throw new Error("no sandboxes");
    },
    log: () => undefined,
  });
}

function call(method: string, route: string, key: string, body?: unknown) {
  return fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Exactly what the bundled Mac uploader sends (shepherd-onboard MessagesBatchSender): JSON content type on every request. */
function mac(apiUrl: string, method: string, route: string, agentToken: string, body?: unknown) {
  return fetch(`${apiUrl}/api/imessage/ingest${route}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": agentToken },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function setup(key: string, body: Record<string, unknown> = {}) {
  const res = await call("POST", "/v1/sources/devices/imessage/setup", key, body);
  return { status: res.status, body: (await res.json()) as Any };
}

beforeAll(async () => {
  // Non-literal specifier: the runtime package has its own tsconfig/typecheck, so the target's
  // stricter compiler options must not traverse into it.
  const harness = "../packages/sources-runtime/tests/source-lane/providers/imessage/harness.js";
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
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-imessage-device-"));
  const port = await freePort();
  app = await makeApp(
    { SOURCES_RUNTIME_URL: `${runtime.url}/internal/v1`, SOURCES_PUBLISH_URL: `http://127.0.0.1:${port}`, SOURCES_DEVICE_API_URL: runtime.url },
    [admin.entry, collector.entry, reader.entry, rival.entry, noScope.entry],
    dir,
  );
  await app.listen(port);
  base = `http://127.0.0.1:${port}`;
  // Each tenant's runtime binding: the runtime learns yc_msaw's URL from it (and from nothing else).
  for (const k of [keys.admin, keys.rival]) expect((await call("POST", "/v1/sources/runtime/provision", k)).status).toBe(201);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Mac iMessage uploader with yc_msaw as the authority", () => {
  let config: { apiUrl: string; userId: string; agentToken: string; backfillDays?: number | null; allowedChatIds?: string[] };
  let bindingId: string;

  it("issues the uploader config once to a collection-scoped principal, bound to its tenant", async () => {
    expect((await setup(keys.noScope)).status).toBe(403);
    expect((await call("POST", "/v1/sources/devices/imessage/setup", "pmk_not_a_key", {})).status).toBe(401);
    // No tenant or user can be named in the body.
    expect((await setup(keys.collector, { userId: "rival" })).status).toBe(400);
    expect((await setup(keys.collector, { tenantNs: "rival" })).status).toBe(400);
    // The generic device route no longer enrols iMessage with a caller-chosen body.
    expect((await call("POST", "/v1/sources/devices/imessage", keys.collector, { bindingId: "sb-0123456789abcdef", tokenSha256: "0".repeat(64) })).status).toBe(400);

    const r = await setup(keys.collector, { label: "Ada's MacBook", backfillDays: 30, allowedChatIds: ["iMessage;-;+15550001111"] });
    expect(r.status).toBe(201);
    config = r.body.messagesConfig;
    bindingId = r.body.binding.bindingId;
    expect(config).toEqual({
      apiUrl: runtime.url,
      userId: "acme",
      agentToken: expect.stringMatching(new RegExp(`^gimsg_acme\\.${bindingId}\\.[A-Za-z0-9_-]{43}$`)),
      backfillDays: 30,
      allowedChatIds: ["iMessage;-;+15550001111"],
    });
    expect(r.body.binding).toMatchObject({ kind: "device", providers: ["imessage"], transport: "runtime-ingest", revokedAt: null });
    expect(JSON.stringify(r.body)).not.toContain("psb_");
    // The runtime holds only the hash, bound to the same binding and tenant.
    const [dev] = await rt.query("SELECT tenant_id, binding_id, status FROM imessage_devices WHERE binding_id = $1", [bindingId]);
    expect(dev).toMatchObject({ tenant_id: "acme", binding_id: bindingId, status: "active" });
    const secret = config.agentToken.split(".")[2]!;
    expect(JSON.stringify(await rt.query("SELECT * FROM imessage_devices WHERE binding_id = $1", [bindingId]))).not.toContain(secret);
    expect(await (await call("GET", "/v1/sources/bindings", keys.admin)).text()).not.toContain(secret);
  });

  it("serves the five donor endpoints with the device key and ignores a body userId", async () => {
    const ingested = await mac(config.apiUrl, "POST", "", config.agentToken, {
      userId: "rival",
      messages: [rt.message({ messageId: "G-E2E-1", text: "hello from the Mac" }), rt.message({ messageId: "G-E2E-2", rowId: 2, text: "second" })],
    });
    expect(ingested.status).toBe(200);
    expect(await ingested.json()).toMatchObject({ stored: 2, total: 2 });
    expect((await rt.events("acme")).map((e: Any) => e.raw_payload.text).sort()).toEqual(["hello from the Mac", "second"]);
    expect(await rt.events("rival")).toHaveLength(0);

    expect((await mac(config.apiUrl, "POST", "/sync-contacts", config.agentToken, { userId: "rival", contacts: [{ handle: "+15550001111", name: "Grace" }] })).status).toBe(200);
    expect((await mac(config.apiUrl, "POST", "/local-status", config.agentToken, { status: { status: "idle", queuedMessages: 0 } })).status).toBe(200);
    // GET with Content-Type: application/json and no body, as the Mac sends it.
    expect(await (await mac(config.apiUrl, "GET", "/command", config.agentToken)).json()).toEqual({ command: null });
    expect(await (await mac(config.apiUrl, "POST", "/command/ack", config.agentToken, { id: "00000000-0000-4000-8000-000000000000", status: "completed" })).json()).toEqual({ ok: true, ignored: true });
  });

  it("documents why the wire is not on yc_msaw: its HTTP layer rejects the uploader's GET /command", async () => {
    const res = await mac(base, "GET", "/command", config.agentToken);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid JSON");
  });

  it("answers the runtime's verify call for exactly the key's own identity", async () => {
    const verify = (key: string | null, provider = "imessage") => fetch(`${base}/v1/sources/devices/${provider}/verify`, { headers: key ? { "x-api-key": key } : {} });
    const ok = await verify(config.agentToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ tenantNs: "acme", bindingId, provider: "imessage" });
    expect((await verify(null)).status).toBe(401);
    expect((await verify(`psb_${config.agentToken.slice("gimsg_".length)}`)).status).toBe(401);
    expect((await verify(keys.admin)).status).toBe(401);
    expect((await verify(config.agentToken, "slack")).status).toBe(404);
  });

  it("never lets the device key authorize MCP, admin or publish routes", async () => {
    const psb = `psb_${config.agentToken.slice("gimsg_".length)}`;
    for (const token of [config.agentToken, psb]) {
      const mcpRes = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(mcpRes.status).toBe(401);
      expect((await call("GET", "/v1/sources/status", token)).status).toBe(401);
      expect((await call("GET", "/v1/sources/bindings", token)).status).toBe(401);
      expect((await call("POST", "/v1/sources/devices/imessage/setup", token, {})).status).toBe(401);
    }
    // The derived psb_ token is a runtime-ingest device binding: it cannot publish files itself.
    expect((await call("POST", "/v1/sources/publish", psb, { batchId: "forged", changes: [] })).status).toBe(403);
    expect((await call("POST", "/v1/sources/status-report", psb, { providers: [] })).status).toBe(403);
    // Wrong family / forged secret / another binding id are refused by the runtime.
    expect((await mac(config.apiUrl, "POST", "", psb, { messages: [rt.message()] })).status).toBe(401);
    expect((await mac(config.apiUrl, "POST", "", `${config.agentToken.slice(0, -3)}AAA`, { messages: [rt.message()] })).status).toBe(401);
    expect((await mac(config.apiUrl, "POST", "", config.agentToken.replace(bindingId, "sb-0123456789abcdef"), { messages: [rt.message()] })).status).toBe(401);
  });

  it("keeps tenants apart: another tenant's device writes only its own tenant", async () => {
    const r = await setup(keys.rival);
    expect(r.status).toBe(201);
    expect(r.body.messagesConfig.userId).toBe("rival");
    expect((await mac(r.body.messagesConfig.apiUrl, "POST", "", r.body.messagesConfig.agentToken, { userId: "acme", messages: [rt.message({ messageId: "G-RIVAL", text: "rival only" })] })).status).toBe(200);
    expect((await rt.events("rival")).map((e: Any) => e.raw_payload.text)).toEqual(["rival only"]);
    expect((await rt.events("acme")).some((e: Any) => e.raw_payload.text === "rival only")).toBe(false);
    // A tenant's admin cannot revoke another tenant's device binding.
    expect((await call("DELETE", `/v1/sources/bindings/${r.body.binding.bindingId}`, keys.admin)).status).toBe(404);
  });

  it("revocation in yc_msaw stops collection on the next request and revokes the runtime credential", async () => {
    const revoked = await call("DELETE", `/v1/sources/bindings/${bindingId}`, keys.admin);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ binding: { bindingId, revokedAt: expect.any(String) }, runtimeDevices: { imessage: { revoked: true, status: 200 } } });
    for (const [method, route, body] of [
      ["POST", "", { messages: [rt.message({ messageId: "G-AFTER" })] }],
      ["POST", "/sync-contacts", { contacts: [] }],
      ["POST", "/local-status", { status: {} }],
      ["GET", "/command", undefined],
      ["POST", "/command/ack", { id: "x" }],
    ] as const) {
      expect((await mac(config.apiUrl, method, route, config.agentToken, body)).status).toBe(401);
    }
    expect((await rt.query("SELECT status FROM imessage_devices WHERE binding_id = $1", [bindingId]))[0].status).toBe("revoked");
    expect((await rt.events("acme")).some((e: Any) => e.raw_payload.messageId === "G-AFTER")).toBe(false);
    expect((await fetch(`${base}/v1/sources/devices/imessage/verify`, { headers: { "x-api-key": config.agentToken } })).status).toBe(401);
  });

  it("is authoritative even if the runtime revoke never arrives", async () => {
    const r = await setup(keys.collector);
    const key = r.body.messagesConfig.agentToken as string;
    expect((await mac(runtime.url, "POST", "", key, { messages: [rt.message({ messageId: "G-B1" })] })).status).toBe(200);
    // Revoke only in yc_msaw's binding registry (as if the forwarded runtime revoke were lost).
    await app.sources!.bindings.revoke("acme", r.body.binding.bindingId);
    expect((await rt.query("SELECT status FROM imessage_devices WHERE binding_id = $1", [r.body.binding.bindingId]))[0].status).toBe("active");
    expect((await mac(runtime.url, "POST", "", key, { messages: [rt.message({ messageId: "G-B2" })] })).status).toBe(401);
    expect((await rt.events("acme")).some((e: Any) => e.raw_payload.messageId === "G-B2")).toBe(false);
    // The runtime converged on the refusal.
    expect((await rt.query("SELECT status FROM imessage_devices WHERE binding_id = $1", [r.body.binding.bindingId]))[0].status).toBe("revoked");
  });

  it("revokes the minted binding when the runtime cannot enrol the device, and refuses setup without a device host", async () => {
    const { generateStaticKey } = await import("../src/auth/static-keys.js");
    const k = generateStaticKey("acme", ["memory:build", "memory:read", "traces:write"]);
    const cases: Array<[Record<string, string>, number, string]> = [
      [{ SOURCES_RUNTIME_URL: `http://127.0.0.1:${await freePort()}/internal/v1`, SOURCES_PUBLISH_URL: "http://127.0.0.1:65000", SOURCES_DEVICE_API_URL: "http://127.0.0.1:65001" }, 502, "runtime_unreachable"],
      [{ SOURCES_RUNTIME_URL: `${runtime.url}/internal/v1`, SOURCES_PUBLISH_URL: "http://127.0.0.1:65000" }, 503, "device_ingest_not_configured"],
    ];
    for (const [env, status, code] of cases) {
      const dir2 = await mkdtemp(path.join(os.tmpdir(), "sources-imessage-alt-"));
      const app2 = await makeApp(env, [k.entry], dir2);
      try {
        const port2 = await freePort();
        await app2.listen(port2);
        const res = await fetch(`http://127.0.0.1:${port2}/v1/sources/devices/imessage/setup`, { method: "POST", headers: { Authorization: `Bearer ${k.key}`, "Content-Type": "application/json" }, body: "{}" });
        expect(res.status).toBe(status);
        const body = (await res.json()) as Any;
        expect(body.error.code).toBe(code);
        expect(JSON.stringify(body)).not.toContain("gimsg_");
        const bindings = await app2.sources!.bindings.list("acme");
        expect(bindings.filter((b) => !b.revokedAt)).toHaveLength(0);
      } finally {
        await app2.close();
        await rm(dir2, { recursive: true, force: true });
      }
    }
  });
});
