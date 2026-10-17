/**
 * Exact hosted shape (public bind, WorkOS auth, Modal store/sandbox config).
 * Uses raw node:http so the Host header is really sent (Node's fetch replaces it).
 * Platform probes reach the instance with per-deployment / internal Host headers:
 * health must answer 200 and /mcp must answer 401 with the CANONICAL challenge
 * (never 403). On a loopback bind the SDK's DNS-rebinding protection still applies.
 * No Modal call happens at startup (stores and sandboxes are injected/lazy).
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/index.js";
import { LocalLease } from "../src/sandbox/local.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

const PUBLIC_MCP = "https://wild-zero-kq08i.run.mcp-use.com/mcp";
const CANONICAL_PRM = "https://wild-zero-kq08i.run.mcp-use.com/.well-known/oauth-protected-resource/mcp";

function request(port: number, opts: { method: string; path: string; host: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method, path: opts.path, headers: { Host: opts.host, ...(opts.headers ?? {}) }, setHost: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const rpc = (method: string, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } : {} });
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const sandboxOnly = { builder: async () => ({ status: "failed" as const, error: "not used" }), leaseFactory: () => LocalLease.create(), log: () => undefined };

describe("hosted (public bind, WorkOS) edge behaviour", () => {
  let app: App;
  let port: number;
  beforeAll(async () => {
    app = await createApp({
      env: {
        PORT: "0",
        HOST: "0.0.0.0",
        MCP_PUBLIC_URL: PUBLIC_MCP,
        AUTH_MODE: "workos",
        WORKOS_AUTHKIT_DOMAIN: "sincere-umbrella-45-staging.authkit.app",
        PROCMEM_STORE: "modal",
        PROCMEM_SANDBOX: "modal",
        PROCMEM_DATA_DIR: path.join(os.tmpdir(), "procmem-health"),
      },
      store: new DirectoryObjectStore(path.join(os.tmpdir(), "procmem-health", "objects")),
      ...sandboxOnly,
    });
    port = (await app.listen(0)).port;
  });
  afterAll(async () => {
    await app?.close();
  });

  for (const host of ["wild-zero-kq08i.run.mcp-use.com", "mcp-f2352b28-1558-4c0c-9520-738517ab933d-6.fly.dev", "10.0.12.7:3000", "localhost:3000"]) {
    it(`Host ${host}: health 200, unauthenticated MCP 401 with canonical challenge`, async () => {
      for (const route of ["/health", "/healthz"]) {
        const res = await request(port, { method: "GET", path: route, host });
        expect(res.status, `${route}`).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({ ok: true, auth: "workos" });
      }
      for (const method of ["initialize", "tools/list"]) {
        const res = await request(port, { method: "POST", path: "/mcp", host, headers: mcpHeaders, body: rpc(method) });
        expect(res.status, method).toBe(401);
        expect(String(res.headers["www-authenticate"])).toContain(`resource_metadata="${CANONICAL_PRM}"`);
      }
      const forged = await request(port, { method: "POST", path: "/mcp", host, headers: { ...mcpHeaders, authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0." }, body: rpc("tools/list") });
      expect(forged.status).toBe(401);
    });
  }
});

describe("loopback bind keeps DNS-rebinding protection", () => {
  let app: App;
  let port: number;
  const key = generateStaticKey("tenant-loop", ["memory:read"]);
  beforeAll(async () => {
    app = await createApp({
      env: { PORT: "0", HOST: "127.0.0.1", AUTH_MODE: "static", PROCMEM_STATIC_KEYS: key.entry, PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: path.join(os.tmpdir(), "procmem-loop") },
      store: new DirectoryObjectStore(path.join(os.tmpdir(), "procmem-loop", "objects")),
      ...sandboxOnly,
    });
    port = (await app.listen(0)).port;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("rejects a foreign Host with 403 and accepts localhost", async () => {
    const evil = await request(port, { method: "POST", path: "/mcp", host: "evil.example", headers: { ...mcpHeaders, authorization: `Bearer ${key.key}` }, body: rpc("initialize") });
    expect(evil.status).toBe(403);
    const ok = await request(port, { method: "GET", path: "/health", host: `localhost:${port}` });
    expect(ok.status).toBe(200);
  });
});
