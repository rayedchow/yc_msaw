import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.SOURCES_RUNTIME_PUBLIC_URL = "https://runtime.example.test";
  process.env.GOOGLE_DWD_TENANT_APPROVALS = JSON.stringify({ "tenant-a": ["corp.example"] });
  const { generateKeyPairSync } = process.getBuiltinModule("node:crypto") as typeof import("node:crypto");
  process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON = JSON.stringify({
    client_email: "source-lane-test@example-project.iam.gserviceaccount.com",
    private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  delete process.env.COMPOSIO_API_KEY;
});

vi.mock("../../../../src/db/client.js", async () => {
  const { createGoogleAuthTestDb } = await import("./pglite-db.js");
  const { client, db } = await createGoogleAuthTestDb();
  return { db, pgClient: null, __pglite: client };
});
const startGooglePolling = vi.hoisted(() => vi.fn(async () => undefined));
const enqueueTask = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../../src/queue/dispatch.js", () => ({ startGooglePolling }));
vi.mock("../../../../src/queue/queue.js", () => ({ enqueueTask }));

import { createHash } from "node:crypto";
import { Hono } from "hono";
import * as dbClient from "../../../../src/db/client.js";
import type { PGlite } from "@electric-sql/pglite";
import { createRuntimeApp } from "../../../../src/source-lane/internal/app.js";
import { googleAuthProvider } from "../../../../src/source-lane/providers/google-auth/index.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { resetGoogleOAuthStateForTests } from "../../../../src/vault/google-oauth.js";
import { fakeGoogle } from "./fake-google.js";
import { resetGoogleAuthTables } from "./pglite-db.js";

const pg = (dbClient as unknown as { __pglite: PGlite }).__pglite;

const SERVICE_TOKEN = "synthetic-service-token-0123456789abcdef0123456789";

/** The real core runtime app (internal service-token + principal middleware, provider route mounting). */
function buildApp() {
  return createRuntimeApp({
    db: dbClient.db as never,
    exporter: {} as never,
    registry: new SourceProviderRegistry([googleAuthProvider]),
    serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"),
    integrations: [],
    mountInternal: true,
  });
}

function principalHeader(p: Record<string, unknown>): string {
  return JSON.stringify(p);
}

const ADA_PRINCIPAL = { tenantNs: "tenant-a", subject: "user_ada", issuer: "https://auth.example.test", email: "ada@corp.example", scopes: ["memory:read", "memory:build"] };

const ADMIN_HEADERS: Record<string, string> = {
  authorization: `Bearer ${SERVICE_TOKEN}`,
  "x-procmem-principal": principalHeader(ADA_PRINCIPAL),
  "content-type": "application/json",
};

function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0];
}

describe("google-auth provider routes", () => {
  let fake: ReturnType<typeof fakeGoogle>;
  let app: Hono;

  beforeEach(async () => {
    await resetGoogleAuthTables(pg);
    resetGoogleOAuthStateForTests();
    startGooglePolling.mockClear();
    enqueueTask.mockClear();
    fake = fakeGoogle();
    vi.stubGlobal("fetch", fake.fetch);
    app = buildApp();
  });

  afterEach(() => vi.unstubAllGlobals());

  async function start(headers: Record<string, string> = ADMIN_HEADERS, body: unknown = {}) {
    return app.request("/internal/v1/tenants/tenant-a/google/auth/oauth/start", { method: "POST", headers, body: JSON.stringify(body) });
  }

  async function launchAndConsent() {
    const started = await start();
    expect(started.status).toBe(201);
    const { launchUrl } = await started.json() as { launchUrl: string };
    const launchPath = launchUrl.replace("https://runtime.example.test", "");
    const launched = await app.request(launchPath);
    expect(launched.status).toBe(302);
    const location = launched.headers.get("location")!;
    const { state } = fake.authorize(location);
    return { state, cookie: cookiePair(launched.headers.get("set-cookie")!), launched };
  }

  it("requires the service token, a matching forwarded principal and memory:build; tenant comes only from the URL", async () => {
    expect((await start({ "content-type": "application/json" })).status).toBe(401);
    expect((await start({ ...ADMIN_HEADERS, authorization: "Bearer wrong" })).status).toBe(401);
    // Principal of another tenant on tenant-a's URL: core middleware refuses.
    expect((await start({ ...ADMIN_HEADERS, "x-procmem-principal": principalHeader({ ...ADA_PRINCIPAL, tenantNs: "tenant-b" }) })).status).toBe(403);
    // Self-service grants (owner-only sources): memory:read may start a grant for its own account; no scope may not.
    expect((await start({ ...ADMIN_HEADERS, "x-procmem-principal": principalHeader({ ...ADA_PRINCIPAL, scopes: ["integrations:read"] }) })).status).toBe(403);
    // Forwarders that do not send scopes are refused (fail closed).
    const { scopes: _omit, ...noScopes } = ADA_PRINCIPAL;
    expect((await start({ ...ADMIN_HEADERS, "x-procmem-principal": principalHeader(noScopes) })).status).toBe(403);
    // A tenant in the body is ignored, not honored.
    const res = await start(ADMIN_HEADERS, { tenantId: "tenant-b", capabilities: ["gmail"] });
    expect(res.status).toBe(201);
    const [row] = (await pg.query<{ tenant_id: string }>("SELECT tenant_id FROM google_oauth_states")).rows;
    expect(row.tenant_id).toBe("tenant-a");
  });

  it("runs the browser flow end to end and activates the account in the polling roster", async () => {
    const { state, cookie, launched } = await launchAndConsent();
    expect(launched.headers.get("set-cookie")).toMatch(/^__Host-pgo_[0-9a-f]{16}=.+; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    expect(new URL(launched.headers.get("location")!).hostname).toBe("accounts.google.com");

    const cb = await app.request(`/auth/google/oauth/callback?state=${encodeURIComponent(state)}&code=4%2Fsynthetic`, { headers: { cookie } });
    const html = await cb.text();
    expect(cb.status).toBe(200);
    expect(html).toContain("ada@corp.example is connected");
    expect(html).not.toContain("synthetic-access");
    expect(cb.headers.get("referrer-policy")).toBe("no-referrer");
    expect(cb.headers.get("cache-control")).toBe("no-store");

    const conns = (await pg.query("SELECT tenant_id, external_account_id, status, metadata FROM connections")).rows as Array<Record<string, any>>;
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ tenant_id: "tenant-a", external_account_id: "ada@corp.example", status: "active" });
    expect(conns[0].metadata.authMode).toBe("oauth_direct");
    expect(startGooglePolling).toHaveBeenCalledWith("tenant-a");
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "gmail.backfill", payload: expect.objectContaining({ mailbox: "ada@corp.example" }) }));

    const replay = await app.request(`/auth/google/oauth/callback?state=${encodeURIComponent(state)}&code=4%2Fsynthetic`, { headers: { cookie } });
    expect(replay.status).toBe(400);
    expect(fake.tokenCalls("authorization_code")).toHaveLength(1);
  });

  it("rejects a callback from a browser that did not launch the flow", async () => {
    const { state } = await launchAndConsent();
    const cb = await app.request(`/auth/google/oauth/callback?state=${encodeURIComponent(state)}&code=4%2Fsynthetic`);
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain("different browser");
    expect(fake.tokenCalls("authorization_code")).toHaveLength(0);
    expect((await pg.query("SELECT * FROM connections")).rows).toHaveLength(0);
  });

  it("status lists accounts, modes and capability state without any secret material", async () => {
    const { state, cookie } = await launchAndConsent();
    await app.request(`/auth/google/oauth/callback?state=${encodeURIComponent(state)}&code=4%2Fsynthetic`, { headers: { cookie } });
    const res = await app.request("/internal/v1/tenants/tenant-a/google/auth", { headers: ADMIN_HEADERS });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/ciphertext|synthetic-access|synthetic-refresh|g1:/);
    const body = JSON.parse(text);
    expect(body.modes.oauth_direct.configured).toBe(true);
    expect(body.modes.domain_wide_delegation.approved).toEqual({ domains: ["corp.example"], mailboxes: [] });
    expect(body.accounts).toEqual([expect.objectContaining({
      email: "ada@corp.example",
      authMode: "oauth_direct",
      grantStatus: "active",
      connectionStatus: "active",
      hasRefreshToken: true,
      capabilities: expect.objectContaining({ gmail: true, docs: true, directory_admin: false }),
    })]);
    // Other tenants see nothing.
    const other = await app.request("/internal/v1/tenants/tenant-b/google/auth", {
      headers: { ...ADMIN_HEADERS, "x-procmem-principal": principalHeader({ ...ADA_PRINCIPAL, tenantNs: "tenant-b" }) },
    });
    expect((await other.json()).accounts).toEqual([]);
  });

  it("coverage is derived from live grant state: complete, then blocked after reauth", async () => {
    const { state, cookie } = await launchAndConsent();
    await app.request(`/auth/google/oauth/callback?state=${encodeURIComponent(state)}&code=4%2Fsynthetic`, { headers: { cookie } });
    const ctx = { tenantId: "tenant-a", executor: dbClient.db as never };
    const before = await googleAuthProvider.coverage!(ctx);
    expect(before).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "google-auth", scope: "account:ada@corp.example/gmail", state: "complete" }),
      expect.objectContaining({ scope: "tenant/workspace-directory", state: "blocked" }),
    ]));
    await pg.query("UPDATE google_oauth_grants SET status = 'reauth_required', reauth_reason = 'invalid_grant'");
    const after = await googleAuthProvider.coverage!(ctx);
    expect(after).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "account:ada@corp.example", state: "blocked", reason: "oauth_reauth_required:invalid_grant" }),
    ]));
    expect(after.some((r) => r.state === "complete")).toBe(false);
  });

  it("DWD mailbox route enforces the allowlist and disconnect revokes", async () => {
    const denied = await app.request("/internal/v1/tenants/tenant-a/google/auth/dwd/mailboxes", {
      method: "POST", headers: ADMIN_HEADERS, body: JSON.stringify({ email: "ceo@other.example" }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "dwd_not_approved" });
    expect(fake.calls).toHaveLength(0);
    // Same mailbox domain, other tenant: refused even though tenant-a has it approved.
    const cross = await app.request("/internal/v1/tenants/tenant-b/google/auth/dwd/mailboxes", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "x-procmem-principal": principalHeader({ ...ADA_PRINCIPAL, tenantNs: "tenant-b" }) },
      body: JSON.stringify({ email: "ada@corp.example" }),
    });
    expect(cross.status).toBe(403);
    expect(fake.calls).toHaveLength(0);

    const { state, cookie } = await launchAndConsent();
    await app.request(`/auth/google/oauth/callback?state=${encodeURIComponent(state)}&code=4%2Fsynthetic`, { headers: { cookie } });
    const del = await app.request("/internal/v1/tenants/tenant-a/google/auth/accounts/ada%40corp.example", { method: "DELETE", headers: ADMIN_HEADERS });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ authMode: "oauth_direct", status: "revoked", providerRevoked: true });
    const [conn] = (await pg.query<{ status: string }>("SELECT status FROM connections")).rows;
    expect(conn.status).toBe("revoked");
  });
});
