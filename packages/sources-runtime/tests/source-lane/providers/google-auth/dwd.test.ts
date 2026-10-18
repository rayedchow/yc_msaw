import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const { generateKeyPairSync } = process.getBuiltinModule("node:crypto") as typeof import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON = JSON.stringify({
    client_email: "source-lane-test@example-project.iam.gserviceaccount.com",
    client_id: "100000000000000000001",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  // A process-global mailbox must never be used as a cross-tenant default.
  process.env.GOOGLE_WORKSPACE_USER_EMAIL = "global-admin@acme.example";
  process.env.GOOGLE_DWD_TENANT_APPROVALS = JSON.stringify({
    "tenant-acme": { domains: ["acme.example"], mailboxes: ["contractor@partner.example"], directoryAdmin: "admin@acme.example" },
    "tenant-globex": ["globex.example"],
  });
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
});

vi.mock("../../../../src/db/client.js", async () => {
  const { createGoogleAuthTestDb } = await import("./pglite-db.js");
  const { client, db } = await createGoogleAuthTestDb();
  return { db, pgClient: null, __pglite: client };
});
vi.mock("../../../../src/queue/dispatch.js", () => ({ startGooglePolling: vi.fn(async () => undefined) }));
vi.mock("../../../../src/queue/queue.js", () => ({ enqueueTask: vi.fn(async () => undefined) }));

import * as dbClient from "../../../../src/db/client.js";
import type { PGlite } from "@electric-sql/pglite";
import { connectGoogleWorkspace, disconnectGoogleAccount } from "../../../../src/integrations/google/connect.js";
import { listGoogleMailboxAccounts, listGoogleMailboxes } from "../../../../src/integrations/google/mailboxes.js";
import {
  connectGoogleWorkspaceDelegation,
  getGoogleAccessToken,
  getGoogleApiCredential,
  GOOGLE_DOCS_DELEGATION_SCOPES,
  GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES,
  resolveGoogleAuthMode,
} from "../../../../src/vault/google-auth.js";
import {
  GoogleDwdNotApprovedError,
  isGoogleDwdMailboxApproved,
  parseGoogleDwdPolicy,
} from "../../../../src/vault/google-dwd-policy.js";
import { resetGoogleAuthTables } from "./pglite-db.js";

const pg = (dbClient as unknown as { __pglite: PGlite }).__pglite;

interface Call { url: string; body: URLSearchParams | null; headers: Headers }

function fakeDelegation() {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init.body instanceof URLSearchParams ? init.body : typeof init.body === "string" ? new URLSearchParams(init.body) : null;
    calls.push({ url, body, headers: new Headers(init.headers) });
    if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      n += 1;
      return Response.json({ access_token: `ya29.dwd-${n}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return Response.json({ emailAddress: assertionSubjectOfLastMint(calls), historyId: "777" });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls, mints: () => calls.filter((c) => c.body?.get("grant_type")?.endsWith("jwt-bearer")) };
}

function claimsOf(call: Call): Record<string, unknown> {
  const assertion = call.body!.get("assertion")!;
  return JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"));
}

function assertionSubjectOfLastMint(calls: Call[]): string {
  const mints = calls.filter((c) => c.body?.get("grant_type")?.endsWith("jwt-bearer"));
  return String(claimsOf(mints[mints.length - 1]).sub);
}

describe("Google Workspace domain-wide delegation (server-owned allowlist)", () => {
  let fake: ReturnType<typeof fakeDelegation>;

  beforeEach(async () => {
    await resetGoogleAuthTables(pg);
    fake = fakeDelegation();
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  describe("policy", () => {
    it("parses domains, exact mailboxes and the shorthand", () => {
      const policy = parseGoogleDwdPolicy(process.env.GOOGLE_DWD_TENANT_APPROVALS!);
      expect(policy.errors).toEqual([]);
      expect(isGoogleDwdMailboxApproved("tenant-acme", "Jane@ACME.example", policy)).toBe(true);
      expect(isGoogleDwdMailboxApproved("tenant-acme", "contractor@partner.example", policy)).toBe(true);
      expect(isGoogleDwdMailboxApproved("tenant-acme", "other@partner.example", policy)).toBe(false);
      expect(isGoogleDwdMailboxApproved("tenant-globex", "hank@globex.example", policy)).toBe(true);
      expect(isGoogleDwdMailboxApproved("tenant-globex", "jane@acme.example", policy)).toBe(false);
      expect(isGoogleDwdMailboxApproved("tenant-unknown", "jane@acme.example", policy)).toBe(false);
    });

    it("refuses a domain or mailbox approved for two tenants everywhere (fail closed)", () => {
      const policy = parseGoogleDwdPolicy(JSON.stringify({
        "tenant-a": ["shared.example", "solo.example"],
        "tenant-b": ["shared.example", "boss@solo.example"],
      }));
      expect(policy.errors.join("\n")).toMatch(/shared\.example is approved for multiple tenants/);
      expect(policy.errors.join("\n")).toMatch(/boss@solo\.example is approved for multiple tenants/);
      expect(isGoogleDwdMailboxApproved("tenant-a", "x@shared.example", policy)).toBe(false);
      expect(isGoogleDwdMailboxApproved("tenant-b", "x@shared.example", policy)).toBe(false);
      expect(isGoogleDwdMailboxApproved("tenant-b", "boss@solo.example", policy)).toBe(false);
      expect(isGoogleDwdMailboxApproved("tenant-a", "boss@solo.example", policy)).toBe(false);
      expect(isGoogleDwdMailboxApproved("tenant-a", "worker@solo.example", policy)).toBe(true);
    });

    it("rejects consumer domains, malformed entries and invalid JSON", () => {
      const policy = parseGoogleDwdPolicy(JSON.stringify({ "tenant-a": ["gmail.com", "me@icloud.com", "not a domain"], "BAD TENANT": ["x.example"] }));
      expect(policy.errors).toHaveLength(4);
      expect(isGoogleDwdMailboxApproved("tenant-a", "me@gmail.com", policy)).toBe(false);
      expect(parseGoogleDwdPolicy("{nope").errors).toEqual(["GOOGLE_DWD_TENANT_APPROVALS must be valid JSON"]);
    });
  });

  it("mints a delegated token for an approved mailbox with the job's scopes", async () => {
    const token = await getGoogleAccessToken("tenant-acme", "Jane@acme.example", GOOGLE_DOCS_DELEGATION_SCOPES);
    expect(token).toMatch(/^ya29\.dwd-/);
    const claims = claimsOf(fake.mints()[0]);
    expect(claims).toMatchObject({
      iss: "source-lane-test@example-project.iam.gserviceaccount.com",
      sub: "jane@acme.example",
      aud: "https://oauth2.googleapis.com/token",
      scope: GOOGLE_DOCS_DELEGATION_SCOPES.join(" "),
    });
    const credential = await getGoogleApiCredential("tenant-acme", "jane@acme.example", GOOGLE_DOCS_DELEGATION_SCOPES);
    expect(credential).toMatchObject({ kind: "access_token", mode: "domain_wide_delegation", account: "jane@acme.example" });
  });

  it("denies a mailbox outside the tenant's allowlist before any Google call", async () => {
    await expect(getGoogleAccessToken("tenant-acme", "victim@globex.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES))
      .rejects.toBeInstanceOf(GoogleDwdNotApprovedError);
    await expect(getGoogleAccessToken("tenant-unknown", "jane@acme.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES))
      .rejects.toBeInstanceOf(GoogleDwdNotApprovedError);
    expect(fake.calls).toHaveLength(0);
  });

  it("checks the allowlist before the service-account-global token cache", async () => {
    // tenant-globex legitimately warms the cache for its own mailbox...
    await getGoogleAccessToken("tenant-globex", "hank@globex.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES);
    expect(fake.mints()).toHaveLength(1);
    // ...tenant-acme naming that mailbox must not receive the cached token.
    await expect(getGoogleAccessToken("tenant-acme", "hank@globex.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES))
      .rejects.toBeInstanceOf(GoogleDwdNotApprovedError);
  });

  it("never falls back to the process-global GOOGLE_WORKSPACE_USER_EMAIL", async () => {
    await expect(getGoogleAccessToken("tenant-acme")).rejects.toThrow(/not connected for this tenant/);
    expect(fake.calls).toHaveLength(0);
  });

  it("connects an approved mailbox, uses it as the default subject and lists it as a DWD roster member", async () => {
    const result = await connectGoogleWorkspace({ tenantId: "tenant-acme", body: { userEmail: "admin@acme.example" } });
    expect(result).toMatchObject({ status: 200, body: { provider: "google", status: "active", email: "admin@acme.example" } });
    expect(await listGoogleMailboxes("tenant-acme")).toEqual(["admin@acme.example"]);
    expect(await listGoogleMailboxAccounts("tenant-acme")).toEqual([
      { email: "admin@acme.example", authMode: "domain_wide_delegation", status: "active" },
    ]);
    await getGoogleAccessToken("tenant-acme", undefined, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES);
    expect(claimsOf(fake.mints().at(-1)!).sub).toBe("admin@acme.example");
    expect(await resolveGoogleAuthMode("tenant-acme", "admin@acme.example")).toBe("domain_wide_delegation");
    expect(await resolveGoogleAuthMode("tenant-acme", "x@globex.example")).toBeNull();

    const disconnected = await disconnectGoogleAccount({ tenantId: "tenant-acme", email: "admin@acme.example" });
    expect(disconnected.body).toMatchObject({ authMode: "domain_wide_delegation", status: "revoked" });
    expect(await listGoogleMailboxes("tenant-acme")).toEqual([]);
    await expect(getGoogleAccessToken("tenant-acme", undefined, GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES)).rejects.toThrow(/not connected/);
  });

  it("legacy single-mailbox tenants (token metadata only, no connection rows) keep their roster", async () => {
    await pg.query(`INSERT INTO integration_tokens (user_id, provider, access_token, metadata)
      VALUES ('tenant-acme', 'google', 'delegation', '{"email":"admin@acme.example","delegation":true,"authMode":"domain_wide_delegation"}')`);
    expect(await listGoogleMailboxes("tenant-acme")).toEqual(["admin@acme.example"]);
    await pg.query(`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ('tenant-acme', 'google', 'admin@acme.example', 'error')`);
    expect(await listGoogleMailboxes("tenant-acme")).toEqual([]);
  });

  it("returns 403 for an unapproved DWD connect and makes no Google call", async () => {
    const result = await connectGoogleWorkspace({ tenantId: "tenant-acme", body: { userEmail: "ceo@globex.example" } });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("dwd_not_approved");
    await expect(connectGoogleWorkspaceDelegation("tenant-acme", "ceo@globex.example")).rejects.toBeInstanceOf(GoogleDwdNotApprovedError);
    expect(fake.calls).toHaveLength(0);
    expect(await pg.query("SELECT * FROM connections")).toMatchObject({ rows: [] });
  });

  it("refuses to switch an OAuth-connected account to DWD (one explicit mode per account)", async () => {
    await pg.query(`INSERT INTO google_oauth_grants (tenant_id, account_email, google_sub, mode, refresh_token_ciphertext, status, connected_by_subject, connected_by_issuer)
      VALUES ('tenant-acme', 'jane@acme.example', 'sub-1', 'oauth_direct', 'g1:x:y:z', 'active', 's', 'i')`);
    const result = await connectGoogleWorkspace({ tenantId: "tenant-acme", body: { userEmail: "jane@acme.example" } });
    expect(result).toMatchObject({ status: 409, body: { code: "mode_conflict" } });
    expect(fake.calls).toHaveLength(0);
    expect(await resolveGoogleAuthMode("tenant-acme", "jane@acme.example")).toBe("oauth_direct");
  });

  it("an OAuth grant in reauth for a DWD-approved mailbox never silently falls back to DWD", async () => {
    await pg.query(`INSERT INTO google_oauth_grants (tenant_id, account_email, google_sub, mode, status, reauth_reason, connected_by_subject, connected_by_issuer)
      VALUES ('tenant-acme', 'jane@acme.example', 'sub-1', 'oauth_direct', 'reauth_required', 'invalid_grant', 's', 'i')`);
    await expect(getGoogleAccessToken("tenant-acme", "jane@acme.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES)).rejects.toMatchObject({ code: "reauth_required" });
    expect(fake.mints()).toHaveLength(0);
  });

  it("a revoked OAuth grant can be replaced by an approved DWD connection", async () => {
    await pg.query(`INSERT INTO google_oauth_grants (tenant_id, account_email, google_sub, mode, status, connected_by_subject, connected_by_issuer)
      VALUES ('tenant-acme', 'jane@acme.example', 'sub-1', 'oauth_direct', 'revoked', 's', 'i')`);
    const result = await connectGoogleWorkspace({ tenantId: "tenant-acme", body: { userEmail: "jane@acme.example" } });
    expect(result.status).toBe(200);
    expect(await resolveGoogleAuthMode("tenant-acme", "jane@acme.example")).toBe("domain_wide_delegation");
  });
});
