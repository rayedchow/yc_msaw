import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/static-keys.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

/**
 * yc_msaw -> source runtime forwarding. A local recorder stands in for the runtime's
 * internal API so the test can assert exactly what is forwarded: the server-held
 * service token, the URL tenant and x-procmem-principal from the verified caller, and
 * nothing a caller can choose.
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
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-forwarding-"));
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

describe("runtime forwarding uses only the verified principal", () => {
  it("forwards Google grant routes with scopes and tenant from the verified key", async () => {
    expect((await req("GET", "/v1/sources/google/auth", null)).status).toBe(401);
    expect((await req("POST", "/v1/sources/google/auth/oauth/start", reader.key, {})).status).toBe(403);
    expect((await req("POST", "/v1/sources/google/auth/dwd/mailboxes", reader.key, { email: "a@example.com" })).status).toBe(403);
    expect((await req("DELETE", "/v1/sources/google/auth/accounts/a%40example.com", reader.key)).status).toBe(403);
    expect(seen).toHaveLength(0);

    expect((await req("GET", "/v1/sources/google/auth", reader.key)).status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/internal/v1/tenants/acme/google/auth", auth: `Bearer ${SERVICE_TOKEN}` });
    expect(seen[0]!.principal).toMatchObject({ tenantNs: "acme", subject: expect.stringMatching(/^static:/), scopes: ["memory:read"] });

    const started = await req("POST", "/v1/sources/google/auth/oauth/start", admin.key, { broker: "google", capabilities: ["gmail", "docs"] });
    expect(started.status).toBe(200);
    expect(seen[1]).toMatchObject({ url: "/internal/v1/tenants/acme/google/auth/oauth/start", body: { broker: "google", capabilities: ["gmail", "docs"] } });
    expect((seen[1]!.principal!.scopes as string[]).sort()).toEqual(["memory:build", "memory:read"]);
  });

  it("refuses caller-chosen tenants and malformed account ids before forwarding", async () => {
    expect((await req("POST", "/v1/sources/google/auth/oauth/start", admin.key, { tenantId: "rival" })).status).toBe(400);
    expect((await req("POST", "/v1/sources/google/auth/dwd/mailboxes", admin.key, { email: "a@example.com", userId: "u-other" })).status).toBe(400);
    expect((await req("DELETE", "/v1/sources/google/auth/accounts/..%2Fx", admin.key)).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect((await req("DELETE", "/v1/sources/google/auth/accounts/A%40Example.com", admin.key)).status).toBe(200);
    expect(seen[0]!.url).toBe("/internal/v1/tenants/acme/google/auth/accounts/a%40example.com");
    // Another tenant's admin reaches only its own tenant.
    await req("GET", "/v1/sources/google/auth", rival.key);
    expect(seen[1]!.url).toBe("/internal/v1/tenants/rival/google/auth");
    expect(seen[1]!.principal).toMatchObject({ tenantNs: "rival" });
  });

  it("provisions a runtime binding without returning its token and revokes it when the runtime refuses", async () => {
    const ok = await req("POST", "/v1/sources/runtime/provision", admin.key);
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as Record<string, any>;
    expect(JSON.stringify(body)).not.toContain("psb_");
    expect(seen[0]).toMatchObject({ method: "PUT", url: "/internal/v1/tenants/acme/binding" });
    const sent = seen[0]!.body as { token: string; bindingId: string; publishUrl: string };
    expect(sent.token.startsWith("psb_acme.")).toBe(true);
    expect(sent.publishUrl).toBe("http://127.0.0.1:65000");

    reply = { status: 500, body: { error: "boom" } };
    const refused = await req("POST", "/v1/sources/runtime/provision", admin.key);
    expect(refused.status).toBe(502);
    const list = (await (await req("GET", "/v1/sources/bindings", admin.key)).json()) as { bindings: Array<{ bindingId: string; revokedAt: string | null }> };
    const refusedId = (seen[1]!.body as { bindingId: string }).bindingId;
    expect(list.bindings.find((b) => b.bindingId === refusedId)?.revokedAt).toBeTruthy();
    expect(list.bindings.find((b) => b.bindingId === sent.bindingId)?.revokedAt).toBeNull();
  });

  it("forwards connect, disconnect and device enrolment with the right scopes", async () => {
    expect((await req("POST", "/v1/sources/connect/jira", reader.key, {})).status).toBe(403);
    await req("POST", "/v1/sources/connect/jira", admin.key, { returnTo: "x" });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/internal/v1/tenants/acme/connect/jira", body: { returnTo: "x" } });
    await req("DELETE", "/v1/sources/connections/jira", admin.key);
    expect(seen[1]).toMatchObject({ method: "DELETE", url: "/internal/v1/tenants/acme/connections/jira" });
    expect((await req("POST", "/v1/sources/connect/Bad_Provider", admin.key, {})).status).toBe(400);
    expect((await req("POST", "/v1/sources/devices/coding-sessions", reader.key, {})).status).toBe(403);
    expect((await req("POST", "/v1/sources/devices/coding-sessions", collector.key, { deviceName: "Mac" })).status).toBe(200);
    expect(seen[2]).toMatchObject({ url: "/internal/v1/tenants/acme/devices/coding-sessions", body: { deviceName: "Mac" } });
    // iMessage devices are enrolled only through the setup route (server-minted credential); nothing is forwarded.
    expect((await req("POST", "/v1/sources/devices/imessage", collector.key, { deviceName: "Mac" })).status).toBe(400);
    expect(seen[2]!.principal).toMatchObject({ tenantNs: "acme", scopes: ["traces:write"] });
    expect(seen).toHaveLength(3);
  });
});
