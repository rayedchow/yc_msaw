import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/static-keys.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

/**
 * yc_msaw -> runtime forwarding of the Jira deep-lane project selection (runtime
 * providers/jira/routes.ts). A local recorder stands in for the runtime internal API: the
 * service token, URL tenant and x-procmem-principal come from the verified caller; the body is
 * strict (connection/site/projects only), so a caller cannot choose a tenant or user.
 * (jira shared patch request 6.)
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
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-jira-forwarding-"));
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

describe("Jira project selection forwarding", () => {
  it("requires memory:read to view and memory:build to change", async () => {
    expect((await req("GET", "/v1/sources/jira/selection", null)).status).toBe(401);
    expect((await req("GET", "/v1/sources/jira/selection", collector.key)).status).toBe(403);
    expect((await req("PUT", "/v1/sources/jira/selection", reader.key, { mode: "all" })).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("forwards with the verified tenant, principal and scopes", async () => {
    expect((await req("GET", "/v1/sources/jira/selection", reader.key)).status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/internal/v1/tenants/acme/jira/selection", auth: `Bearer ${SERVICE_TOKEN}`, principal: { tenantNs: "acme" } });
    expect(seen[0]!.principal!.scopes).toEqual(["memory:read"]);
    expect((await req("PUT", "/v1/sources/jira/selection", admin.key, { mode: "projects", projects: ["ENG", "10001"], cloudId: "cloud-1" })).status).toBe(200);
    expect(seen[1]).toMatchObject({ method: "PUT", url: "/internal/v1/tenants/acme/jira/selection", body: { mode: "projects", projects: ["ENG", "10001"], cloudId: "cloud-1" } });
    expect(seen[1]!.principal!.scopes).toEqual(["memory:build", "memory:read"]);
    reply = { status: 404, body: { error: { code: "unknown_connection" } } };
    const r = await req("PUT", "/v1/sources/jira/selection", rival.key, { connectionId: "conn-of-acme", mode: "all" });
    expect(r.status).toBe(404);
    expect(seen[2]).toMatchObject({ url: "/internal/v1/tenants/rival/jira/selection", principal: { tenantNs: "rival" } });
  });

  it("refuses tenant/user fields and malformed project refs before forwarding", async () => {
    for (const body of [{ mode: "all", tenantId: "rival" }, { mode: "projects", projects: ["ENG; DROP"] }, { mode: "some" }, {}, { mode: "all", user: "x" }]) {
      expect((await req("PUT", "/v1/sources/jira/selection", admin.key, body)).status).toBe(400);
    }
    expect(seen).toEqual([]);
  });
});
