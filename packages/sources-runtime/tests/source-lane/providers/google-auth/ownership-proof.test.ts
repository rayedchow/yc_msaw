import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.SOURCES_RUNTIME_PUBLIC_URL = "https://runtime.example.test";
  process.env.GOOGLE_DWD_TENANT_APPROVALS = JSON.stringify({ "tenant-a": ["corp.example"], "tenant-b": ["other.example"] });
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
vi.mock("../../../../src/queue/dispatch.js", () => ({ startGooglePolling: vi.fn(async () => undefined) }));
vi.mock("../../../../src/queue/queue.js", () => ({ enqueueTask: vi.fn(async () => undefined) }));

import { createHash } from "node:crypto";
import type { Hono } from "hono";
import * as dbClient from "../../../../src/db/client.js";
import type { PGlite } from "@electric-sql/pglite";
import { createRuntimeApp } from "../../../../src/source-lane/internal/app.js";
import { googleAccountOwners, googleAuthProvider } from "../../../../src/source-lane/providers/google-auth/index.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { getGoogleApiCredential, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES, resolveGoogleAuthMode } from "../../../../src/vault/google-auth.js";
import { findGoogleOAuthGrant, resetGoogleOAuthStateForTests } from "../../../../src/vault/google-oauth.js";
import { fakeGoogle } from "./fake-google.js";
import { resetGoogleAuthTables } from "./pglite-db.js";

/**
 * Owner-only personal sources need an owner for a domain-wide-delegation mailbox WITHOUT turning it into an
 * OAuth data grant (any google_oauth_grants row makes the address resolve to OAuth). The ownership proof is an
 * identity-only Google sign-in (openid email, online, no incremental scopes): the address keeps DWD collection.
 */
const pg = (dbClient as unknown as { __pglite: PGlite }).__pglite;
const db = dbClient.db as never;
const SERVICE_TOKEN = "synthetic-service-token-0123456789abcdef0123456789";
const ISS = "https://auth.example.test";
const ADMIN = { tenantNs: "tenant-a", subject: "user_admin", issuer: ISS, email: "admin@corp.example", scopes: ["memory:read", "memory:build"] };
const ADA = { tenantNs: "tenant-a", subject: "user_ada", issuer: ISS, email: "ada@corp.example", scopes: ["memory:read", "integrations:read"] };
const BOB = { tenantNs: "tenant-a", subject: "user_bob", issuer: ISS, email: "bob@corp.example", scopes: ["memory:read", "integrations:read"] };

function headers(p: Record<string, unknown>) {
  return { authorization: `Bearer ${SERVICE_TOKEN}`, "x-procmem-principal": JSON.stringify(p), "content-type": "application/json" };
}

/** OAuth endpoints (fakeGoogle, consenting as `email`) plus the DWD JWT-bearer mint and Gmail profile. */
function fakeAll(email: string) {
  const oauth = fakeGoogle({ email, sub: `sub-${email}` });
  let mints = 0;
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : init.body instanceof URLSearchParams ? init.body : null;
    if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      mints += 1;
      const claims = JSON.parse(Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString("utf8")) as { sub: string };
      lastDwdSubject = claims.sub;
      return Response.json({ access_token: `ya29.dwd-${mints}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return Response.json({ emailAddress: lastDwdSubject, historyId: "1" });
    return oauth.fetch(input, init);
  };
  let lastDwdSubject = "";
  return { ...oauth, fetch: fetchImpl as typeof fetch };
}

describe("Google ownership proof (DWD mailbox owner without a data grant)", () => {
  let app: Hono;
  beforeEach(async () => {
    await resetGoogleAuthTables(pg);
    resetGoogleOAuthStateForTests();
    app = createRuntimeApp({
      db,
      exporter: {} as never,
      registry: new SourceProviderRegistry([googleAuthProvider]),
      serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"),
      integrations: [],
      mountInternal: true,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function connectDwd(email: string) {
    vi.stubGlobal("fetch", fakeAll(email).fetch);
    const res = await app.request("/internal/v1/tenants/tenant-a/google/auth/dwd/mailboxes", { method: "POST", headers: headers(ADMIN), body: JSON.stringify({ email }) });
    expect(res.status).toBe(200);
  }

  /** start (internal, member scopes) -> one-time launch -> Google consent as `consentAs` -> public callback. */
  async function prove(principal: Record<string, unknown>, consentAs: string, account?: unknown) {
    const fake = fakeAll(consentAs);
    vi.stubGlobal("fetch", fake.fetch);
    const started = await app.request("/internal/v1/tenants/tenant-a/google/auth/ownership/start", {
      method: "POST", headers: headers(principal), body: JSON.stringify(account === undefined ? {} : { account }),
    });
    expect(started.status).toBe(201);
    const start = (await started.json()) as { launchUrl: string; expectedEmail: string; scopes: string[] };
    const launched = await app.request(start.launchUrl.replace("https://runtime.example.test", ""));
    expect(launched.status).toBe(302);
    const authorize = new URL(launched.headers.get("location")!);
    const { state } = fake.authorize(authorize.toString());
    const cookie = launched.headers.get("set-cookie")!.split(";")[0]!;
    const cb = await app.request(`/auth/google/oauth/callback?state=${encodeURIComponent(state)}&code=4%2Fsynthetic`, { headers: { cookie } });
    return { start, authorize, cb, html: await cb.text(), fake, state, cookie };
  }

  it("a plain member proves their DWD mailbox: owner reported, collection stays DWD, no grant or token kept", async () => {
    await connectDwd("ada@corp.example");
    expect(await googleAccountOwners("tenant-a", db)).toEqual([{ account: "ada@corp.example", subject: null, issuer: null }]);

    const { start, authorize, cb, html, fake } = await prove(ADA, "ada@corp.example");
    expect(start.expectedEmail).toBe("ada@corp.example");
    expect(start.scopes).toEqual([]);
    // Identity only: no data scope, no refresh token, no previously granted scopes folded in.
    expect(authorize.searchParams.get("scope")).toBe("openid email");
    expect(authorize.searchParams.get("access_type")).toBe("online");
    expect(authorize.searchParams.has("include_granted_scopes")).toBe(false);
    expect(authorize.searchParams.get("login_hint")).toBe("ada@corp.example");
    expect(cb.status).toBe(200);
    expect(html).toContain("ada@corp.example is verified as yours");
    expect(html).not.toContain("synthetic-access");

    expect(await googleAccountOwners("tenant-a", db)).toEqual([{ account: "ada@corp.example", subject: "user_ada", issuer: ISS }]);
    expect(await findGoogleOAuthGrant("tenant-a", "ada@corp.example")).toBeNull();
    expect((await pg.query("SELECT count(*)::int AS n FROM google_oauth_grants")).rows).toEqual([{ n: 0 }]);
    // Nothing token-like is persisted anywhere for the proof, and the connection was not switched to OAuth.
    const proofs = (await pg.query("SELECT * FROM google_account_owner_proofs")).rows;
    expect(JSON.stringify(proofs)).not.toMatch(/ya29|synthetic|refresh/);
    const [conn] = (await pg.query<{ metadata: Record<string, unknown>; status: string }>("SELECT metadata, status FROM connections WHERE external_account_id = 'ada@corp.example'")).rows;
    expect(conn!.status).toBe("active");
    expect(conn!.metadata.authMode).not.toBe("oauth_direct");
    expect(await resolveGoogleAuthMode("tenant-a", "ada@corp.example")).toBe("domain_wide_delegation");
    vi.stubGlobal("fetch", fakeAll("ada@corp.example").fetch);
    const credential = await getGoogleApiCredential("tenant-a", "ada@corp.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES);
    expect(credential.mode).toBe("domain_wide_delegation");
    // The identity-only token is never revoked (revocation would cancel that user's whole grant to the client).
    expect(fake.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
  });

  it("refuses a proof for an address the consenting Google account is not, without revoking anything", async () => {
    await connectDwd("ada@corp.example");
    // Bob names Ada's mailbox but can only sign in to Google as himself.
    const { cb, html, fake } = await prove(BOB, "bob@corp.example", { email: "ada@corp.example" });
    expect(cb.status).toBe(403);
    expect(html).toContain("not the account this connection was started for");
    expect(fake.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    expect(await googleAccountOwners("tenant-a", db)).toEqual([{ account: "ada@corp.example", subject: null, issuer: null }]);
  });

  it("is single use, browser bound and tenant scoped", async () => {
    await connectDwd("ada@corp.example");
    const { state, cookie } = await prove(ADA, "ada@corp.example");
    const replay = await app.request(`/auth/google/oauth/callback?state=${encodeURIComponent(state)}&code=4%2Fsynthetic`, { headers: { cookie } });
    expect(replay.status).toBe(400);
    expect(await googleAccountOwners("tenant-b", db)).toEqual([]);
    // A principal without memory:read cannot start one; a principal of another tenant cannot use tenant-a's URL.
    const noScope = await app.request("/internal/v1/tenants/tenant-a/google/auth/ownership/start", { method: "POST", headers: headers({ ...ADA, scopes: ["integrations:read"] }), body: "{}" });
    expect(noScope.status).toBe(403);
    const foreign = await app.request("/internal/v1/tenants/tenant-a/google/auth/ownership/start", { method: "POST", headers: headers({ ...ADA, tenantNs: "tenant-b" }), body: "{}" });
    expect(foreign.status).toBe(403);
  });

  it("the newest verified control wins between a data grant and a proof (mailbox handed over)", async () => {
    await connectDwd("ada@corp.example");
    await prove(ADA, "ada@corp.example");
    // Later someone else signs in to the same Google account (e.g. the mailbox was reassigned) and proves it.
    await pg.query("UPDATE google_account_owner_proofs SET verified_at = now() - interval '1 day'");
    await prove({ ...BOB, email: "bob@corp.example" }, "ada@corp.example", { email: "ada@corp.example" });
    expect(await googleAccountOwners("tenant-a", db)).toEqual([{ account: "ada@corp.example", subject: "user_bob", issuer: ISS }]);
  });

  it("leaves the ordinary data-grant consent unchanged (offline, incremental, data scopes)", async () => {
    const fake = fakeAll("ada@corp.example");
    vi.stubGlobal("fetch", fake.fetch);
    const started = await app.request("/internal/v1/tenants/tenant-a/google/auth/oauth/start", { method: "POST", headers: headers(ADA), body: JSON.stringify({ capabilities: ["gmail"] }) });
    const { launchUrl } = (await started.json()) as { launchUrl: string };
    const launched = await app.request(launchUrl.replace("https://runtime.example.test", ""));
    const authorize = new URL(launched.headers.get("location")!);
    expect(authorize.searchParams.get("scope")).toBe("openid email profile https://www.googleapis.com/auth/gmail.readonly");
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("include_granted_scopes")).toBe("true");
  });
});
