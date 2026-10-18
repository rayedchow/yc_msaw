import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/static-keys.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

/**
 * yc_msaw -> runtime forwarding of the generic Nango records lane setup API
 * (runtime providers/nango-records). A local recorder stands in for the runtime internal API:
 * the service token, URL tenant and x-procmem-principal come from the verified caller; bodies
 * are strict (only a configured source id), so a caller cannot choose a tenant, user or
 * connection mapping. (nango-expansion shared patch request 4.)
 */

const SERVICE_TOKEN = "svc_forwarding_test_token_0123456789abcdef";
const admin = generateStaticKey("acme", ["memory:build", "memory:read"]);
const reader = generateStaticKey("acme", ["memory:read"]);
const collector = generateStaticKey("acme", ["traces:write"]);
const rival = generateStaticKey("rival", ["memory:build", "memory:read"]);

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  principal: Record<string, unknown> | null;
  body: unknown;
}
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true } };
let recorder: Server;
let app: App;
let dir: string;
let base: string;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  const text = Buffer.concat(parts).toString("utf8");
  return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
  recorder = createServer(async (req, res) => {
    const principal = req.headers["x-procmem-principal"];
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization,
      principal: typeof principal === "string" ? (JSON.parse(principal) as Record<string, unknown>) : null,
      body: await readBody(req),
    });
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => recorder.listen(0, "127.0.0.1", r));
  const port = (recorder.address() as { port: number }).port;
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-nango-forwarding-"));
  app = await createApp({
    env: {
      HOST: "127.0.0.1",
      AUTH_MODE: "static",
      PROCMEM_STATIC_KEYS: [admin.entry, reader.entry, collector.entry, rival.entry].join(","),
      PROCMEM_STORE: "directory",
      PROCMEM_SANDBOX: "local",
      PROCMEM_DATA_DIR: dir,
      SOURCES_RUNTIME_URL: `http://127.0.0.1:${port}/internal/v1`,
      SOURCES_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN,
      SOURCES_PUBLISH_URL: "http://127.0.0.1:65000",
    },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => {
      throw new Error("no builds");
    },
    leaseFactory: async () => {
      throw new Error("no sandboxes");
    },
    log: () => undefined,
  });
  base = (await app.listen(0)).url;
});

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { ok: true } };
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => recorder?.close(r));
  await rm(dir, { recursive: true, force: true });
});

function req(method: string, route: string, key: string | null, body?: unknown) {
  return fetch(base + route, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Nango records setup forwarding", () => {
  it("requires the right scope per route", async () => {
    expect((await req("GET", "/v1/sources/nango-records", null)).status).toBe(401);
    expect((await req("POST", "/v1/sources/nango-records/connect-sessions", reader.key, { source: "outlook" })).status).toBe(403);
    expect((await req("DELETE", "/v1/sources/nango-records/connections/outlook/conn-1", reader.key)).status).toBe(403);
    expect((await req("POST", "/v1/sources/nango-records/sync", collector.key, {})).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("forwards status, connect sessions, session status, disconnect and sync with the verified tenant", async () => {
    expect((await req("GET", "/v1/sources/nango-records", reader.key)).status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/internal/v1/tenants/acme/nango-records", auth: `Bearer ${SERVICE_TOKEN}`, principal: { tenantNs: "acme" } });
    expect(seen[0]!.principal!.scopes).toEqual(["memory:read"]);

    reply = { status: 201, body: { sessionId: "4f9c2c55-9f0e-4a43-8a8e-6a8a4b0b1c2d", token: "nango_connect_session_x" } };
    const created = await req("POST", "/v1/sources/nango-records/connect-sessions", admin.key, { source: "outlook" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ token: "nango_connect_session_x" });
    expect(seen[1]).toMatchObject({ method: "POST", url: "/internal/v1/tenants/acme/nango-records/connect-sessions", body: { source: "outlook" }, principal: { tenantNs: "acme" } });

    reply = { status: 200, body: { state: "pending" } };
    expect((await req("GET", "/v1/sources/nango-records/connect-sessions/4F9C2C55-9F0E-4A43-8A8E-6A8A4B0B1C2D", reader.key)).status).toBe(200);
    expect(seen[2]!.url).toBe("/internal/v1/tenants/acme/nango-records/connect-sessions/4f9c2c55-9f0e-4a43-8a8e-6a8a4b0b1c2d");

    expect((await req("DELETE", "/v1/sources/nango-records/connections/outlook/conn%2F1", admin.key)).status).toBe(200);
    expect(seen[3]).toMatchObject({ method: "DELETE", url: "/internal/v1/tenants/acme/nango-records/connections/outlook/conn%2F1" });

    expect((await req("POST", "/v1/sources/nango-records/sync", admin.key, { source: "outlook" })).status).toBe(200);
    expect(seen[4]).toMatchObject({ method: "POST", url: "/internal/v1/tenants/acme/nango-records/sync", body: { source: "outlook" } });

    // A rival key reaches only its own tenant.
    await req("GET", "/v1/sources/nango-records", rival.key);
    expect(seen[5]).toMatchObject({ url: "/internal/v1/tenants/rival/nango-records", principal: { tenantNs: "rival" } });
  });

  it("refuses caller-chosen tenant, user or connection fields and malformed ids before forwarding", async () => {
    for (const body of [{ source: "outlook", tenantId: "rival" }, { source: "outlook", connectionId: "x" }, { source: "Outlook!" }, {}, { source: "outlook", end_user: { id: "rival" } }]) {
      expect((await req("POST", "/v1/sources/nango-records/connect-sessions", admin.key, body)).status).toBe(400);
    }
    expect((await req("POST", "/v1/sources/nango-records/sync", admin.key, { tenantId: "rival" })).status).toBe(400);
    expect((await req("GET", "/v1/sources/nango-records/connect-sessions/not-a-uuid", reader.key)).status).toBe(400);
    expect((await req("DELETE", "/v1/sources/nango-records/connections/Bad_Source/conn-1", admin.key)).status).toBe(400);
    expect(seen).toEqual([]);
  });
});
