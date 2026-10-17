/**
 * Integration catalog/token HTTP contract on the REAL server (createApp):
 *   live integration       -> 200 token
 *   absent integration     -> 404 integration_not_found (retryable:false)
 *   child auth not set up  -> 503 child_auth_not_configured (retryable:false)
 *   unexpected failure     -> 502 token_failed (retryable:true), sanitized public message, redacted log
 *   no catalog on host     -> GET lists [] with childAuthConfigured:false; token 503
 * The tenant namespace and subject always come from the verified caller.
 */
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/index.js";
import { LocalLease } from "../src/sandbox/local.js";
import type { IntegrationCatalogPort, IntegrationTokenResult } from "../src/server.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

const reader = generateStaticKey("tenant-int", ["integrations:read"]);
const memoryOnly = generateStaticKey("tenant-int", ["memory:read"]);
const SECRET_IN_ERROR = "Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(integrationCatalog: IntegrationCatalogPort | null, env: Record<string, string> = {}, logs: string[] = []) {
  const dir = path.join(os.tmpdir(), `procmem-token-route-${process.pid}-${Math.random().toString(36).slice(2)}`);
  app = await createApp({
    env: {
      PORT: "0",
      HOST: "127.0.0.1",
      AUTH_MODE: "static",
      PROCMEM_STATIC_KEYS: [reader.entry, memoryOnly.entry].join(","),
      PROCMEM_STORE: "directory",
      PROCMEM_SANDBOX: "local",
      PROCMEM_DATA_DIR: dir,
      ...env,
    },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => ({ status: "failed", error: "not used" }),
    leaseFactory: () => LocalLease.create(),
    integrationCatalog,
    log: (m) => logs.push(m),
  });
  return (await app.listen(0)).url;
}

function port(token: (ns: string, subject: string, slug: string) => Promise<IntegrationTokenResult>, seen: string[] = []): IntegrationCatalogPort {
  return {
    list: async (ns) => {
      seen.push(`list:${ns}`);
      return { integrations: [{ slug: "notify-hub" }], childAuthConfigured: true };
    },
    accessToken: async (ns, subject, slug) => {
      seen.push(`token:${ns}:${subject}:${slug}`);
      return token(ns, subject, slug);
    },
  };
}

const post = (base: string, slug: string, key = reader.key) => fetch(`${base}/v1/integrations/${slug}/token`, { method: "POST", headers: { Authorization: `Bearer ${key}` } });

describe("POST /v1/integrations/:slug/token", () => {
  it("returns the token for a live integration, with the host-derived tenant", async () => {
    const seen: string[] = [];
    const base = await start(
      port(async (_ns, _sub, slug) => ({ ok: true, token: { slug, mcpUrl: "https://child.example/mcp", token: "t", tokenType: "Bearer", expiresAt: "2026-10-17T22:00:00Z", audience: "urn:procmem:integration:tenant-int:notify-hub" } }), seen),
    );
    const res = await post(base, "notify-hub");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: "notify-hub", tokenType: "Bearer" });
    expect(seen[0]).toMatch(/^token:tenant-int:.+:notify-hub$/);
  });

  it("classifies an absent integration as 404 integration_not_found", async () => {
    const base = await start(port(async () => ({ ok: false, reason: "not_found" })));
    const res = await post(base, "retired-one");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "integration_not_found", message: "No live integration retired-one for this tenant", retryable: false } });
  });

  it("classifies missing child auth as 503 child_auth_not_configured (not retryable)", async () => {
    const base = await start(port(async () => ({ ok: false, reason: "child_auth_not_configured" })));
    const res = await post(base, "notify-hub");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "child_auth_not_configured", retryable: false } });
  });

  it("maps unexpected failures to a sanitized 502 token_failed and logs a redacted detail", async () => {
    const logs: string[] = [];
    const base = await start(
      port(async () => {
        throw new Error(`volume unavailable while reading receipts (${SECRET_IN_ERROR})`);
      }),
      {},
      logs,
    );
    const res = await post(base, "notify-hub");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "token_failed", message: "Could not issue an integration token; retry later", retryable: true } });
    expect(text).not.toContain("volume unavailable");
    const line = logs.find((l) => l.includes("integration token for tenant-int/notify-hub failed"));
    expect(line).toContain("volume unavailable");
    expect(line).not.toContain("eyJhbGciOiJFZERTQSJ9");
  });

  it("uses the real default catalog: no child signing key -> 503 without minting", async () => {
    // Default port (integrationCatalog undefined) with no INTEGRATION_CHILD_SIGNING_JWK in env.
    const base = await start(undefined as unknown as IntegrationCatalogPort, { INTEGRATION_CHILD_SIGNING_JWK: "" });
    const res = await post(base, "notify-hub");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "child_auth_not_configured" } });
    const list = await fetch(`${base}/v1/integrations`, { headers: { Authorization: `Bearer ${reader.key}` } });
    expect(await list.json()).toMatchObject({ integrations: [], childAuthConfigured: false, catalogConfigured: true });
  });

  it("requires integrations:read and keeps the scope check ahead of the catalog", async () => {
    const seen: string[] = [];
    const base = await start(port(async () => ({ ok: false, reason: "not_found" }), seen));
    expect((await post(base, "notify-hub", memoryOnly.key)).status).toBe(403);
    expect((await fetch(`${base}/v1/integrations/notify-hub/token`, { method: "POST" })).status).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe("GET /v1/integrations", () => {
  it("without a catalog on the host: empty list, childAuthConfigured:false", async () => {
    const base = await start(null);
    const res = await fetch(`${base}/v1/integrations`, { headers: { Authorization: `Bearer ${reader.key}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ integrations: [], childAuthConfigured: false, catalogConfigured: false });
    const token = await post(base, "notify-hub");
    expect(token.status).toBe(503);
  });

  it("with a catalog: passes the list through for the caller's own tenant", async () => {
    const seen: string[] = [];
    const base = await start(port(async () => ({ ok: false, reason: "not_found" }), seen));
    const res = await fetch(`${base}/v1/integrations`, { headers: { Authorization: `Bearer ${reader.key}` } });
    expect(await res.json()).toEqual({ integrations: [{ slug: "notify-hub" }], childAuthConfigured: true, catalogConfigured: true });
    expect(seen).toEqual(["list:tenant-int"]);
  });
});
