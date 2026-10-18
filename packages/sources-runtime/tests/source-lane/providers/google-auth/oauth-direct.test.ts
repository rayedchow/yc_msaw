import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.SOURCES_RUNTIME_PUBLIC_URL = "https://runtime.example.test";
  delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON;
  delete process.env.GOOGLE_DWD_TENANT_APPROVALS;
});

vi.mock("../../../../src/db/client.js", async () => {
  const { createGoogleAuthTestDb } = await import("./pglite-db.js");
  const { client, db } = await createGoogleAuthTestDb();
  return { db, pgClient: null, __pglite: client };
});

import * as dbClient from "../../../../src/db/client.js";
import type { PGlite } from "@electric-sql/pglite";
import { disconnectAllGoogleAccounts } from "../../../../src/integrations/google/connect.js";
import { classifyCredentialFailure } from "../../../../src/vault/credential-failure.js";
import { getGoogleAccessToken, getGoogleApiCredential } from "../../../../src/vault/google-auth.js";
import { decryptBound, googleGrantAad, sha256Hex } from "../../../../src/vault/google-grant-crypto.js";
import {
  completeGoogleOAuthCallback,
  GoogleOAuthError,
  GoogleOAuthReauthRequiredError,
  GoogleOAuthScopeError,
  launchGoogleAuthorization,
  resetGoogleOAuthStateForTests,
  revokeGoogleOAuthGrant,
  startGoogleOAuthAuthorization,
} from "../../../../src/vault/google-oauth.js";
import { GoogleRateLimitError, resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import { fakeGoogle, s256 } from "./fake-google.js";
import { resetGoogleAuthTables } from "./pglite-db.js";

const pg = (dbClient as unknown as { __pglite: PGlite }).__pglite;
const ADA = { subject: "user_ada", issuer: "https://auth.example.test", email: "ada@corp.example" };

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

async function runConsent(fake: ReturnType<typeof fakeGoogle>, tenantId = "tenant-a", principal = ADA, extra: Record<string, unknown> = {}) {
  const start = await startGoogleOAuthAuthorization({ tenantId, principal, ...extra });
  const state = new URL(start.launchUrl).searchParams.get("state")!;
  const launch = await launchGoogleAuthorization(state);
  const authorized = fake.authorize(launch.redirectUrl);
  return { start, state, launch, authorized };
}

describe("direct Google OAuth (oauth_direct)", () => {
  let fake: ReturnType<typeof fakeGoogle>;

  beforeEach(async () => {
    await resetGoogleAuthTables(pg);
    resetGoogleOAuthStateForTests();
    resetGoogleRateLimitCooldownsForTests();
    fake = fakeGoogle();
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores only the state hash, bound to tenant + principal + expected account", async () => {
    const start = await startGoogleOAuthAuthorization({ tenantId: "tenant-a", principal: ADA });
    const state = new URL(start.launchUrl).searchParams.get("state")!;
    const rows = await q("SELECT * FROM google_oauth_states");
    expect(rows).toHaveLength(1);
    expect(rows[0].state_sha256).toBe(sha256Hex(state));
    expect(JSON.stringify(rows)).not.toContain(state);
    expect(rows[0]).toMatchObject({
      tenant_id: "tenant-a",
      principal_subject: "user_ada",
      principal_issuer: "https://auth.example.test",
      expected_email: "ada@corp.example",
      expected_account_source: "principal",
      mode: "oauth_direct",
    });
    expect(start.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("refuses to start without a principal email unless the admin names the account, and rejects raw scopes", async () => {
    await expect(startGoogleOAuthAuthorization({ tenantId: "tenant-a", principal: { subject: "s", issuer: "i" } }))
      .rejects.toMatchObject({ code: "account_binding_required" });
    await expect(startGoogleOAuthAuthorization({ tenantId: "tenant-a", principal: ADA, capabilities: ["https://mail.google.com/"] }))
      .rejects.toMatchObject({ code: "invalid_request" });
    const start = await startGoogleOAuthAuthorization({
      tenantId: "tenant-a",
      principal: { subject: "s", issuer: "i" },
      account: { email: "Bob@Corp.Example" },
      capabilities: ["gmail"],
    });
    expect(start.expectedEmail).toBe("bob@corp.example");
    expect(start.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });

  it("launch builds a PKCE S256 + nonce authorize URL once; a second launch fails", async () => {
    const start = await startGoogleOAuthAuthorization({ tenantId: "tenant-a", principal: ADA });
    const state = new URL(start.launchUrl).searchParams.get("state")!;
    const launch = await launchGoogleAuthorization(state);
    const url = new URL(launch.redirectUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "test-client.apps.googleusercontent.com",
      redirect_uri: "https://runtime.example.test/auth/google/oauth/callback",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
      login_hint: "ada@corp.example",
      state,
    });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));
    expect(launch.bindingCookie.length).toBeGreaterThan(30);
    await expect(launchGoogleAuthorization(state)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("completes the callback: PKCE verifier matches, tokens stored with row-bound encryption", async () => {
    const { state, launch, authorized } = await runConsent(fake);
    const account = await completeGoogleOAuthCallback({ state, code: "4/synthetic-code", bindingCookie: launch.bindingCookie });

    expect(account).toMatchObject({ tenantId: "tenant-a", email: "ada@corp.example", googleSub: "1100000000000000001", hostedDomain: "corp.example", missingScopes: [] });
    const exchange = fake.tokenCalls("authorization_code")[0];
    expect(s256(exchange.body!.get("code_verifier")!)).toBe(authorized.challenge);
    expect(exchange.body!.get("redirect_uri")).toBe("https://runtime.example.test/auth/google/oauth/callback");

    const [grant] = await q<Record<string, string>>("SELECT * FROM google_oauth_grants");
    expect(grant.tenant_id).toBe("tenant-a");
    expect(JSON.stringify(grant)).not.toContain("synthetic-access-1");
    expect(JSON.stringify(grant)).not.toContain("synthetic-refresh-1");
    expect(decryptBound(grant.refresh_token_ciphertext, googleGrantAad("tenant-a", "ada@corp.example", "refresh_token"))).toBe("1//synthetic-refresh-1");
    // Ciphertext is bound to tenant/account/field: it does not decrypt anywhere else.
    expect(() => decryptBound(grant.refresh_token_ciphertext, googleGrantAad("tenant-b", "ada@corp.example", "refresh_token"))).toThrow();
    expect(() => decryptBound(grant.refresh_token_ciphertext, googleGrantAad("tenant-a", "ada@corp.example", "access_token"))).toThrow();

    expect(await getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"])).toBe("ya29.synthetic-access-1");
    const [st] = await q("SELECT outcome, consumed_at FROM google_oauth_states");
    expect(st.outcome).toBe("connected");
    expect(st.consumed_at).not.toBeNull();
  });

  it("rejects a replayed callback without contacting Google again", async () => {
    const { state, launch } = await runConsent(fake);
    await completeGoogleOAuthCallback({ state, code: "4/synthetic-code", bindingCookie: launch.bindingCookie });
    await expect(completeGoogleOAuthCallback({ state, code: "4/synthetic-code", bindingCookie: launch.bindingCookie }))
      .rejects.toMatchObject({ code: "invalid_state" });
    expect(fake.tokenCalls("authorization_code")).toHaveLength(1);
  });

  it("rejects tampered, unlaunched and expired state", async () => {
    const { state, launch } = await runConsent(fake);
    const tampered = `${state.slice(0, -2)}${state.endsWith("AA") ? "BB" : "AA"}`;
    await expect(completeGoogleOAuthCallback({ state: tampered, code: "c", bindingCookie: launch.bindingCookie })).rejects.toMatchObject({ code: "invalid_state" });

    const fresh = await startGoogleOAuthAuthorization({ tenantId: "tenant-a", principal: ADA });
    const unlaunched = new URL(fresh.launchUrl).searchParams.get("state")!;
    await expect(completeGoogleOAuthCallback({ state: unlaunched, code: "c", bindingCookie: "x" })).rejects.toMatchObject({ code: "invalid_state" });

    const later = Date.now() + 11 * 60 * 1000;
    await expect(completeGoogleOAuthCallback({ state, code: "c", bindingCookie: launch.bindingCookie }, { now: () => later }))
      .rejects.toMatchObject({ code: "invalid_state" });
    expect(fake.tokenCalls("authorization_code")).toHaveLength(0);
  });

  it("burns the state when the callback arrives in a different browser (no binding cookie)", async () => {
    const { state, launch } = await runConsent(fake);
    await expect(completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: "someone-elses-cookie" })).rejects.toMatchObject({ code: "browser_mismatch" });
    // The legitimate browser cannot reuse it either: start again.
    await expect(completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie })).rejects.toMatchObject({ code: "invalid_state" });
    expect(fake.tokenCalls("authorization_code")).toHaveLength(0);
  });

  it("records user denial without exchanging anything", async () => {
    const { state, launch } = await runConsent(fake);
    await expect(completeGoogleOAuthCallback({ state, error: "access_denied", bindingCookie: launch.bindingCookie })).rejects.toMatchObject({ code: "access_denied" });
    const [st] = await q("SELECT outcome FROM google_oauth_states");
    expect(st.outcome).toBe("failed:access_denied");
  });

  it("rejects a different consenting Google account and revokes its fresh token", async () => {
    fake = fakeGoogle({ email: "mallory@other.example" });
    vi.stubGlobal("fetch", fake.fetch);
    const { state, launch } = await runConsent(fake);
    await expect(completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie })).rejects.toMatchObject({ code: "account_mismatch" });
    expect(await q("SELECT * FROM google_oauth_grants")).toHaveLength(0);
    expect(fake.calls.some((c) => c.url === "https://oauth2.googleapis.com/revoke")).toBe(true);
  });

  it.each([
    ["nonce", (c: Record<string, unknown>) => ({ ...c, nonce: "attacker-nonce" })],
    ["audience", (c: Record<string, unknown>) => ({ ...c, aud: "other-client" })],
    ["issuer", (c: Record<string, unknown>) => ({ ...c, iss: "https://evil.example" })],
    ["email not verified", (c: Record<string, unknown>) => ({ ...c, email_verified: false })],
    ["expired", (c: Record<string, unknown>) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 })],
  ])("rejects an ID token with a bad %s", async (_label, override) => {
    fake = fakeGoogle({ idTokenOverride: override });
    vi.stubGlobal("fetch", fake.fetch);
    const { state, launch } = await runConsent(fake);
    await expect(completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie })).rejects.toMatchObject({ code: "id_token_invalid" });
    expect(await q("SELECT * FROM google_oauth_grants")).toHaveLength(0);
  });

  it("keeps grants tenant-scoped: tenant B cannot use tenant A's account and nothing falls back", async () => {
    const { state, launch } = await runConsent(fake, "tenant-a");
    await completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie });
    await expect(getGoogleAccessToken("tenant-b", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"]))
      .rejects.toThrow(/not connected via OAuth for this tenant/);
    await expect(getGoogleAccessToken("tenant-b")).rejects.toThrow(/not connected/);

    // A grant row copied into tenant B still cannot be decrypted there.
    await pg.query(`INSERT INTO google_oauth_grants (tenant_id, account_email, google_sub, mode, access_token_ciphertext, access_token_expires_at, refresh_token_ciphertext, granted_scopes, status, connected_by_subject, connected_by_issuer)
      SELECT 'tenant-b', account_email, google_sub, mode, access_token_ciphertext, access_token_expires_at, refresh_token_ciphertext, granted_scopes, status, connected_by_subject, connected_by_issuer FROM google_oauth_grants WHERE tenant_id = 'tenant-a'`);
    await expect(getGoogleAccessToken("tenant-b", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"])).rejects.toThrow();
  });

  it("reports partially granted scopes and refuses jobs needing the missing ones", async () => {
    fake = fakeGoogle({ scope: "openid https://www.googleapis.com/auth/gmail.readonly" });
    vi.stubGlobal("fetch", fake.fetch);
    const { state, launch } = await runConsent(fake);
    const account = await completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie });
    expect(account.missingScopes).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(await getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"])).toMatch(/^ya29\./);
    const err = await getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/drive.readonly"]).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleOAuthScopeError);
    expect(classifyCredentialFailure(err)).not.toBe("permanent");
    // DWD-only scopes are never satisfiable by a user grant.
    await expect(getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.settings.sharing"])).rejects.toBeInstanceOf(GoogleOAuthScopeError);
  });

  it("refreshes an expired token once under concurrency and persists the rotated refresh token", async () => {
    fake = fakeGoogle({ refreshResponses: [{ status: 200, body: { access_token: "ya29.refreshed", refresh_token: "1//rotated", expires_in: 3599 } }] });
    vi.stubGlobal("fetch", fake.fetch);
    const { state, launch } = await runConsent(fake);
    await completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie });
    await pg.query("UPDATE google_oauth_grants SET access_token_expires_at = now() - interval '1 minute'");
    const [before] = await q<{ token_version: string }>("SELECT token_version FROM google_oauth_grants");

    const tokens = await Promise.all([1, 2, 3].map(() => getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"])));
    expect(tokens).toEqual(["ya29.refreshed", "ya29.refreshed", "ya29.refreshed"]);
    expect(fake.tokenCalls("refresh_token")).toHaveLength(1);
    expect(fake.tokenCalls("refresh_token")[0].body!.get("refresh_token")).toBe("1//synthetic-refresh-1");

    const [grant] = await q<Record<string, string>>("SELECT * FROM google_oauth_grants");
    expect(decryptBound(grant.refresh_token_ciphertext, googleGrantAad("tenant-a", "ada@corp.example", "refresh_token"))).toBe("1//rotated");
    expect(Number(grant.token_version)).toBe(Number(before.token_version) + 1);
    // Fresh token is served from storage afterwards.
    await getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(fake.tokenCalls("refresh_token")).toHaveLength(1);
  });

  it("marks the grant reauth_required on invalid_grant and takes only that account out of the roster", async () => {
    fake = fakeGoogle({ refreshResponses: [{ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }] });
    vi.stubGlobal("fetch", fake.fetch);
    const { state, launch } = await runConsent(fake);
    await completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie });
    await pg.query(`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES
      ('tenant-a', 'google', 'ada@corp.example', 'active'), ('tenant-a', 'google', 'other@corp.example', 'active')`);
    await pg.query("UPDATE google_oauth_grants SET access_token_expires_at = now() - interval '1 minute'");

    const err = await getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"]).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleOAuthReauthRequiredError);
    expect(err.message).not.toContain("invalid_grant");
    // Not escalated to a tenant-wide permanent Google failure.
    expect(classifyCredentialFailure(err)).not.toBe("permanent");

    const [grant] = await q<Record<string, unknown>>("SELECT status, reauth_reason, access_token_ciphertext FROM google_oauth_grants");
    expect(grant).toMatchObject({ status: "reauth_required", reauth_reason: "invalid_grant", access_token_ciphertext: null });
    const conns = await q<{ external_account_id: string; status: string }>("SELECT external_account_id, status FROM connections ORDER BY 1");
    expect(conns).toEqual([
      { external_account_id: "ada@corp.example", status: "error" },
      { external_account_id: "other@corp.example", status: "active" },
    ]);

    // Subsequent calls fail fast without hitting Google, and never fall back to another mode.
    await expect(getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"])).rejects.toBeInstanceOf(GoogleOAuthReauthRequiredError);
    expect(fake.tokenCalls("refresh_token")).toHaveLength(1);
    expect(fake.calls.some((c) => c.body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer")).toBe(false);

    // Reconnecting clears the reauth state.
    const again = await runConsent(fake);
    await completeGoogleOAuthCallback({ state: again.state, code: "4/c2", bindingCookie: again.launch.bindingCookie });
    const [restored] = await q<Record<string, unknown>>("SELECT status, reauth_reason FROM google_oauth_grants");
    expect(restored).toMatchObject({ status: "active", reauth_reason: null });
  });

  it("treats refresh 5xx as transient and 429 as a Retry-After cooldown, leaving the grant active", async () => {
    fake = fakeGoogle({
      refreshResponses: [
        { status: 503, body: { error: "backend_error" } },
        { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, headers: { "Retry-After": "42" } },
      ],
    });
    vi.stubGlobal("fetch", fake.fetch);
    const { state, launch } = await runConsent(fake);
    await completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie });
    await pg.query("UPDATE google_oauth_grants SET access_token_expires_at = now() - interval '1 minute'");

    const e1 = await getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"]).catch((e) => e);
    expect(e1).toBeInstanceOf(GoogleOAuthError);
    expect(classifyCredentialFailure(e1)).toBe("transient");
    const e2 = await getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"]).catch((e) => e);
    expect(e2).toBeInstanceOf(GoogleRateLimitError);
    expect(e2.retryAfterSeconds).toBe(42);
    const [grant] = await q<Record<string, unknown>>("SELECT status FROM google_oauth_grants");
    expect(grant.status).toBe("active");
  });

  it("revokes at Google, wipes token material and marks grant + connection revoked", async () => {
    const { state, launch } = await runConsent(fake);
    await completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie });
    await pg.query(`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ('tenant-a', 'google', 'ada@corp.example', 'active')`);
    const result = await revokeGoogleOAuthGrant("tenant-a", "ada@corp.example");
    expect(result).toMatchObject({ revoked: true, providerRevoked: true, mode: "oauth_direct" });
    const revokeCall = fake.calls.find((c) => c.url === "https://oauth2.googleapis.com/revoke")!;
    expect(revokeCall.body!.get("token")).toBe("1//synthetic-refresh-1");
    const [grant] = await q<Record<string, unknown>>("SELECT status, access_token_ciphertext, refresh_token_ciphertext FROM google_oauth_grants");
    expect(grant).toEqual({ status: "revoked", access_token_ciphertext: null, refresh_token_ciphertext: null });
    const [conn] = await q<{ status: string }>("SELECT status FROM connections");
    expect(conn.status).toBe("revoked");
    await expect(getGoogleAccessToken("tenant-a", "ada@corp.example", ["https://www.googleapis.com/auth/gmail.readonly"])).rejects.toBeInstanceOf(GoogleOAuthReauthRequiredError);
  });

  it("tenant-level disconnect revokes every OAuth grant of that tenant only", async () => {
    const ada = await runConsent(fake, "tenant-a");
    await completeGoogleOAuthCallback({ state: ada.state, code: "4/a", bindingCookie: ada.launch.bindingCookie });
    fake = fakeGoogle({ email: "bob@corp.example", sub: "1100000000000000002" });
    vi.stubGlobal("fetch", fake.fetch);
    const bob = await runConsent(fake, "tenant-a", { ...ADA, subject: "user_bob", email: "bob@corp.example" });
    await completeGoogleOAuthCallback({ state: bob.state, code: "4/b", bindingCookie: bob.launch.bindingCookie });
    const other = await runConsent(fake, "tenant-z", { ...ADA, subject: "user_bob", email: "bob@corp.example" });
    await completeGoogleOAuthCallback({ state: other.state, code: "4/z", bindingCookie: other.launch.bindingCookie });

    await disconnectAllGoogleAccounts({ tenantId: "tenant-a" });
    const rows = await q<{ tenant_id: string; account_email: string; status: string; refresh_token_ciphertext: string | null }>(
      "SELECT tenant_id, account_email, status, refresh_token_ciphertext FROM google_oauth_grants ORDER BY tenant_id, account_email",
    );
    expect(rows.map((r) => [r.tenant_id, r.account_email, r.status, r.refresh_token_ciphertext === null])).toEqual([
      ["tenant-a", "ada@corp.example", "revoked", true],
      ["tenant-a", "bob@corp.example", "revoked", true],
      ["tenant-z", "bob@corp.example", "active", false],
    ]);
    expect(fake.calls.filter((c) => c.url === "https://oauth2.googleapis.com/revoke")).toHaveLength(2);
  });

  it("returns a bearer credential with opaque quota attribution for the primary OAuth account", async () => {
    const { state, launch } = await runConsent(fake);
    await completeGoogleOAuthCallback({ state, code: "4/c", bindingCookie: launch.bindingCookie });
    const credential = await getGoogleApiCredential("tenant-a", undefined, ["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(credential).toMatchObject({ kind: "access_token", mode: "oauth_direct", account: "ada@corp.example" });
    expect(credential.quotaUser).toMatch(/^q[0-9a-f]{39}$/);
    expect(credential.quotaUser).not.toContain("ada");
  });
});
