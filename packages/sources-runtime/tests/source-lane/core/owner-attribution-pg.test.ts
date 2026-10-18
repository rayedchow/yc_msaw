import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real PostgreSQL (own throwaway database on SOURCES_TEST_PG_URL): the production migrations (incl. 9103 + 9152,
 * applied twice), the production DWD connect, identity-only ownership proof callback, Drive visibility writer and the
 * attribution query. Two members of one tenant, a DWD-only mailbox nobody proved, another tenant.
 */
const PG = process.env.SOURCES_TEST_PG_URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let dbName: string;
let adminSql: Any;
let sql: Any;
const mods: Record<string, Any> = {};
const ISS = "https://auth.example.test";

function fakeGoogleFetch(consentAs: () => string) {
  let nonce: string | null = null;
  let dwdSub = "";
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : init.body instanceof URLSearchParams ? init.body : null;
    if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      dwdSub = JSON.parse(Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString("utf8")).sub;
      return Response.json({ access_token: "ya29.dwd", expires_in: 3600 });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return Response.json({ emailAddress: dwdSub, historyId: "1" });
    if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "authorization_code") {
      const now = Math.floor(Date.now() / 1000);
      const email = consentAs();
      const claims = { iss: "https://accounts.google.com", aud: "pg-client.apps.googleusercontent.com", sub: `g-${email}`, email, email_verified: true, hd: "corp.example", nonce, iat: now, exp: now + 3600 };
      return Response.json({ access_token: "ya29.identity-only", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/userinfo.email", id_token: `${enc({ alg: "RS256" })}.${enc(claims)}.c2ln` });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls, authorize: (u: string) => { nonce = new URL(u).searchParams.get("nonce"); } };
}

describe.skipIf(!PG)("owner attribution on real PostgreSQL (production SQL)", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `orf_owner_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "pg-client.apps.googleusercontent.com";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "pg-client-secret";
    process.env.SOURCES_RUNTIME_PUBLIC_URL = "https://runtime.example.test";
    process.env.GOOGLE_DWD_TENANT_APPROVALS = JSON.stringify({ "t-acme": ["corp.example"] });
    process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON = JSON.stringify({
      client_email: "pg-test@example-project.iam.gserviceaccount.com",
      private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../src/source-lane/core/migrations.js");
    const first = await mods.migrations.applySourceLaneMigrations(sql);
    expect(first).toEqual(expect.arrayContaining(["9103_gdocs_visibility_capabilities.sql", "9152_google_account_owner_proofs.sql"]));
    expect(await mods.migrations.applySourceLaneMigrations(sql)).toEqual([]);
    mods.db = await import("../../../src/db/client.js");
    mods.oauth = await import("../../../src/vault/google-oauth.js");
    mods.auth = await import("../../../src/vault/google-auth.js");
    mods.owners = await import("../../../src/source-lane/providers/google-auth/index.js");
    mods.attr = await import("../../../src/source-lane/providers/google-auth/attribution.js");
    mods.lifecycle = await import("../../../src/source-lane/providers/google-docs/lifecycle.js");
    mods.checkpoints = await import("../../../src/source-lane/providers/google-docs/checkpoints.js");
    mods.paths = await import("../../../src/source-lane/providers/google-docs/paths.js");
  }, 120_000);

  afterAll(async () => {
    await mods.db?.pgClient?.end({ timeout: 5 });
    await sql?.end({ timeout: 5 });
    if (adminSql) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
  });

  it("DWD mailboxes keep DWD collection after their owners prove them; each member reads only their own Google-wide units", async () => {
    const db = mods.db.db;
    let consentAs = "ada@corp.example";
    const fake = fakeGoogleFetch(() => consentAs);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch;
    try {
      // Admin connects three DWD mailboxes (production connect: allowlist, profile check, connections row).
      const { connectGoogleWorkspace } = await import("../../../src/integrations/google/connect.js");
      for (const m of ["ada@corp.example", "bo@corp.example", "legacy@corp.example"]) {
        const r = await connectGoogleWorkspace({ tenantId: "t-acme", body: { userEmail: m } });
        expect(r.status).toBe(200);
      }
      expect((await mods.owners.googleAccountOwners("t-acme", db)).every((o: Any) => o.subject === null)).toBe(true);

      // Ada and Bo (plain members) each prove their own address with the identity-only sign-in.
      for (const [subject, email] of [["user_ada", "ada@corp.example"], ["user_bo", "bo@corp.example"]] as const) {
        consentAs = email;
        const start = await mods.oauth.startGoogleOwnershipProof({ tenantId: "t-acme", principal: { subject, issuer: ISS, email } });
        const state = new URL(start.launchUrl).searchParams.get("state")!;
        const launch = await mods.oauth.launchGoogleAuthorization(state);
        expect(new URL(launch.redirectUrl).searchParams.get("scope")).toBe("openid email");
        fake.authorize(launch.redirectUrl);
        const account = await mods.oauth.completeGoogleOAuthCallback({ state, code: "4/pg", bindingCookie: launch.bindingCookie });
        expect(account).toMatchObject({ email, ownershipProof: true });
      }
      // Bo cannot prove Ada's address (Google returns his own account).
      consentAs = "bo@corp.example";
      const forged = await mods.oauth.startGoogleOwnershipProof({ tenantId: "t-acme", principal: { subject: "user_bo", issuer: ISS }, account: { email: "ada@corp.example" } });
      const fState = new URL(forged.launchUrl).searchParams.get("state")!;
      const fLaunch = await mods.oauth.launchGoogleAuthorization(fState);
      fake.authorize(fLaunch.redirectUrl);
      await expect(mods.oauth.completeGoogleOAuthCallback({ state: fState, code: "4/pg", bindingCookie: fLaunch.bindingCookie })).rejects.toMatchObject({ code: "account_mismatch" });
      expect(fake.calls.filter((u) => u.includes("/revoke"))).toEqual([]);

      const owners = (await mods.owners.googleAccountOwners("t-acme", db)).sort((a: Any, b: Any) => a.account.localeCompare(b.account));
      expect(owners).toEqual([
        { account: "ada@corp.example", subject: "user_ada", issuer: ISS },
        { account: "bo@corp.example", subject: "user_bo", issuer: ISS },
        { account: "legacy@corp.example", subject: null, issuer: null },
      ]);
      // Collection mode is untouched: still DWD, no grant rows, no tokens stored.
      expect(await mods.auth.resolveGoogleAuthMode("t-acme", "ada@corp.example")).toBe("domain_wide_delegation");
      expect((await sql`SELECT count(*)::int AS n FROM google_oauth_grants`)[0].n).toBe(0);
      expect(JSON.stringify(await sql`SELECT * FROM google_account_owner_proofs`)).not.toMatch(/ya29/);
    } finally {
      globalThis.fetch = realFetch;
    }

    // Drive visibility as the changes feed records it (production writer), plus export directories.
    const DOC = "application/vnd.google-apps.document";
    const live = (id: string, canReadRevisions: boolean) => ({ fileId: id, file: { name: id, mimeType: DOC, modifiedTime: "2026-10-01T00:00:00Z", trashed: false, capabilities: { canReadRevisions } } });
    await mods.lifecycle.recordLiveChange("t-acme", live("doc-ada", true), "ada@corp.example");
    await mods.lifecycle.recordLiveChange("t-acme", live("doc-shared", true), "bo@corp.example");
    await mods.lifecycle.recordLiveChange("t-acme", live("doc-shared", false), "ada@corp.example");
    await mods.lifecycle.recordLiveChange("t-acme", live("doc-legacy", true), "legacy@corp.example");
    await mods.lifecycle.setFileVisibility("t-acme", "pdf-ada", "ada@corp.example", true, undefined, { canReadRevisions: true });
    await sql`INSERT INTO binary_documents (tenant_id, provider, external_id, mime_type) VALUES ('t-acme', 'drive-pdf', 'pdf-ada', 'application/pdf')`;
    for (const id of ["doc-ada", "doc-shared", "doc-legacy"]) await mods.checkpoints.setExportDirectory("t-acme", id, mods.paths.docDirectory(id, id));
    // Another tenant with the same file ids and mailbox names sees nothing of t-acme.
    await mods.lifecycle.setFileVisibility("t-other", "doc-ada", "ada@corp.example", true, undefined, { canReadRevisions: true });

    const dir = (id: string) => mods.paths.docDirectory(id, id).replace(/^sources\//, "");
    const view = async (subject: string, tenant = "t-acme") =>
      (await mods.attr.googleAttributionFor(tenant, { subject, issuer: ISS }, db)).units.map((u: Any) => `${u.path}${u.revisions ? "" : " (no revisions)"}`).sort();
    expect(await view("user_ada")).toEqual([
      "binary/drive-pdf/pdf-ada", dir("doc-ada"), `${dir("doc-shared")} (no revisions)`,
      "google-docs/_raw/document:doc-ada", "google-docs/_raw/document:doc-shared (no revisions)",
    ].sort());
    expect(await view("user_bo")).toEqual([dir("doc-shared"), "google-docs/_raw/document:doc-shared"].sort());
    expect(await view("user_carol")).toEqual([]);
    expect(await view("user_ada", "t-other")).toEqual([]);
    // The index serves the per-mailbox lookup.
    const plan = (await sql.unsafe(`EXPLAIN SELECT 1 FROM gdocs_file_visibility WHERE tenant_id = 't-acme' AND mailbox = 'ada@corp.example' AND visible`)).map((r: Any) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/gdocs_file_visibility/);
  }, 60_000);
});
