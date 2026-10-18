import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End to end on real PostgreSQL with the REAL runtime (internal + public routes, exporter publish + heartbeat) and
 * the REAL yc_msaw (OIDC with a mock issuer: alice is an admin, bob and carol are plain members of one org).
 * Owner audit F4/F5: DWD mailboxes are connected by the admin; bob proves his own mailbox with the identity-only
 * Google sign-in started through yc_msaw; collection stays DWD; each member reads only their own mailbox and the
 * Google Docs their mailbox sees; an unproven DWD mailbox (legacy) and its Docs stay sealed for everyone.
 * Google itself is a local fake (no network); synthetic data only; own throwaway database.
 */
const PG = process.env.SOURCES_TEST_PG_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const YC_ROOT = path.resolve(here, "../../../../..");
const SERVICE_TOKEN = `svc_${randomBytes(24).toString("hex")}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let dbName: string;
let adminSql: Any;
let sql: Any;
const mods: Record<string, Any> = {};
let yc: Any;
let ycDir: string;
let ycBase: string;
let ycMcp: string;
let runtimeServer: Any;
let runtimeBase: string;
let issuer: Any;
let tenantNs: string;
const tok: Record<string, string> = {};
const clients: Any[] = [];
const realFetch = globalThis.fetch;
let consentAs = "";
let nonce: string | null = null;
let dwdSub = "";
const googleCalls: string[] = [];

const importYc = (rel: string): Promise<Any> => import(pathToFileURL(path.join(YC_ROOT, rel)).href);

/** Google endpoints only (DWD JWT-bearer mint, Gmail profile, OAuth code exchange, revoke); everything else is real. */
async function fakeGoogleFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!/^https:\/\/([a-z0-9-]+\.)?googleapis\.com\//.test(url)) return realFetch(input, init);
  googleCalls.push(url);
  const body = typeof init.body === "string" ? new URLSearchParams(init.body) : init.body instanceof URLSearchParams ? init.body : null;
  if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
    dwdSub = JSON.parse(Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString("utf8")).sub;
    return Response.json({ access_token: "ya29.dwd", expires_in: 3600 });
  }
  if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return Response.json({ emailAddress: dwdSub, historyId: "1" });
  if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "authorization_code") {
    const now = Math.floor(Date.now() / 1000);
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const claims = { iss: "https://accounts.google.com", aud: "e2e-client.apps.googleusercontent.com", sub: `g-${consentAs}`, email: consentAs, email_verified: true, hd: "corp.example", nonce, iat: now, exp: now + 3600 };
    return Response.json({ access_token: "ya29.identity", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/userinfo.email", id_token: `${enc({ alg: "RS256" })}.${enc(claims)}.c2ln` });
  }
  return new Response("not found", { status: 404 });
}

async function call(who: string, name: string, args: Record<string, unknown>): Promise<Any> {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client" as string);
  const c = new Client({ name: `e2e-${who}`, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(ycMcp), { requestInit: { headers: { Authorization: `Bearer ${tok[who]}` } } }));
  clients.push(c);
  const r = await c.callTool({ name, arguments: args });
  return { ...JSON.parse(r.content[0].text), isError: r.isError === true };
}
const yc_ = (method: string, route: string, who: string, body?: unknown) =>
  realFetch(`${ycBase}${route}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

describe.skipIf(!PG)("owner-only Google end to end: real runtime + real yc_msaw + real PostgreSQL", () => {
  beforeAll(async () => {
    const { startMockIssuer } = await importYc("src/auth/testing/mock-issuer.ts");
    issuer = await startMockIssuer();
    tenantNs = (await importYc("src/auth/tenant.ts")).tenantNsFor(issuer.issuer, { organizationId: "org_acme", subject: "x" });

    const postgres = (await import("postgres")).default;
    dbName = `orf_e2e_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    // Runtime modules read the environment at import time.
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      GOOGLE_OAUTH_CLIENT_ID: "e2e-client.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "e2e-client-secret",
      SOURCES_RUNTIME_PUBLIC_URL: "https://runtime.example.test",
      GOOGLE_DWD_TENANT_APPROVALS: JSON.stringify({ [tenantNs]: ["corp.example"] }),
      GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON: JSON.stringify({
        client_email: "e2e@example-project.iam.gserviceaccount.com",
        private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    });
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../src/db/client.js");
    mods.exporter = await import("../../../src/source-lane/export/exporter.js");
    mods.registry = await import("../../../src/source-lane/registry.js");
    mods.internal = await import("../../../src/source-lane/internal/app.js");
    mods.lifecycle = await import("../../../src/source-lane/providers/google-docs/lifecycle.js");
    mods.checkpoints = await import("../../../src/source-lane/providers/google-docs/checkpoints.js");
    mods.paths = await import("../../../src/source-lane/providers/google-docs/paths.js");
    mods.auth = await import("../../../src/vault/google-auth.js");
    globalThis.fetch = fakeGoogleFetch as typeof fetch;

    const registry = mods.registry.defaultRegistry();
    mods.exp = new mods.exporter.SourceExporter({ db: mods.db.db, registry, log: () => {} });
    const runtimeApp = mods.internal.createRuntimeApp({
      db: mods.db.db, registry, exporter: mods.exp,
      serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"), mountInternal: true,
    });
    const { serve } = await import("@hono/node-server");
    runtimeServer = serve({ fetch: runtimeApp.fetch, port: 0, hostname: "127.0.0.1", overrideGlobalObjects: false });
    await new Promise((r) => setTimeout(r, 50));
    runtimeBase = `http://127.0.0.1:${(runtimeServer.address() as { port: number }).port}`;
    const reservation = createServer();
    await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
    const ycPort = (reservation.address() as { port: number }).port;
    await new Promise<void>((r) => reservation.close(() => r()));
    const resource = `http://127.0.0.1:${ycPort}/mcp`;
    ycDir = await mkdtemp(path.join(os.tmpdir(), "orf-e2e-yc-"));
    const { createApp } = await importYc("src/app.ts");
    const { DirectoryObjectStore } = await importYc("src/store/objects.ts");
    yc = await createApp({
      env: {
        HOST: "127.0.0.1", AUTH_MODE: "oidc", MCP_PUBLIC_URL: resource, OIDC_ISSUER: issuer.issuer,
        PROCMEM_ADMIN_SUBJECTS: "user_alice", PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: ycDir,
        SOURCES_RUNTIME_URL: `${runtimeBase}/internal/v1`, SOURCES_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN, SOURCES_PUBLISH_URL: `http://127.0.0.1:${ycPort}`,
      },
      store: new DirectoryObjectStore(path.join(ycDir, "objects")),
      builder: async () => { throw new Error("no builds"); },
      leaseFactory: async () => { throw new Error("source reads never open a sandbox"); },
      log: () => undefined,
    });
    ({ url: ycBase, mcpUrl: ycMcp } = await yc.listen(ycPort));
    for (const who of ["alice", "bob", "carol"]) tok[who] = await issuer.mint({ sub: `user_${who}`, aud: resource, scope: "openid", claims: { org_id: "org_acme", email: `${who}@corp.example` } });
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await Promise.allSettled(clients.map((c) => c.close()));
    await yc?.close();
    await new Promise((r) => (runtimeServer ? runtimeServer.close(r) : r(undefined)));
    await issuer?.close();
    await mods.db?.pgClient?.end({ timeout: 5 });
    await sql?.end({ timeout: 5 });
    if (adminSql) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
    if (ycDir) await rm(ycDir, { recursive: true, force: true });
  });

  it("DWD collection + identity-only ownership proof + per-mailbox Docs attribution, through the production wiring", async () => {
    // Admin provisions the collector binding and connects three Workspace mailboxes with domain-wide delegation.
    expect((await yc_("POST", "/v1/sources/runtime/provision", "alice", {})).status).toBe(201);
    for (const email of ["alice@corp.example", "bob@corp.example", "legacy@corp.example"]) {
      const r = await yc_("POST", "/v1/sources/google/auth/dwd/mailboxes", "alice", { email });
      expect(r.status, await r.clone().text()).toBe(200);
    }
    // A plain member cannot add DWD mailboxes.
    expect((await yc_("POST", "/v1/sources/google/auth/dwd/mailboxes", "bob", { email: "carol@corp.example" })).status).toBe(403);

    // alice (admin) and bob (plain member) each prove their own address through yc_msaw -> runtime -> Google.
    for (const who of ["alice", "bob"]) {
      consentAs = `${who}@corp.example`;
      const started = await yc_("POST", "/v1/sources/google/auth/ownership/start", who, { account: "self" });
      expect(started.status).toBe(201);
      const { launchUrl } = (await started.json()) as { launchUrl: string };
      const launched = await realFetch(launchUrl.replace("https://runtime.example.test", runtimeBase), { redirect: "manual" });
      expect(launched.status).toBe(302);
      const authorize = new URL(launched.headers.get("location")!);
      expect(authorize.searchParams.get("scope")).toBe("openid email");
      nonce = authorize.searchParams.get("nonce");
      const cookie = launched.headers.get("set-cookie")!.split(";")[0]!;
      const cb = await realFetch(`${runtimeBase}/auth/google/oauth/callback?state=${encodeURIComponent(authorize.searchParams.get("state")!)}&code=4%2Fe2e`, { headers: { cookie } });
      expect(cb.status, await cb.clone().text()).toBe(200);
    }
    expect(await mods.auth.resolveGoogleAuthMode(tenantNs, "bob@corp.example")).toBe("domain_wide_delegation");
    expect((await sql`SELECT count(*)::int AS n FROM google_oauth_grants`)[0].n).toBe(0);
    expect(googleCalls.filter((u) => u.includes("/revoke"))).toEqual([]);

    // Captured data as the donor pollers leave it: per-mailbox mail, Docs in mailbox-less dirs, per-mailbox Drive visibility.
    const docs = { a: "doc-alice", b: "doc-bob", l: "doc-legacy" };
    const dir = (id: string) => mods.paths.docDirectory(id, id) as string;
    for (const [mailbox, id] of [["alice@corp.example", docs.a], ["bob@corp.example", docs.b], ["legacy@corp.example", docs.l]] as const) {
      await sql`INSERT INTO mirror_files (path, user_id, content, updated_at) VALUES (${`sources/gmail/${mailbox}/inbox/m.md`}, ${tenantNs}, ${`mail of ${mailbox}: needle-mail-${mailbox.split("@")[0]}`}, now())`;
      await sql`INSERT INTO mirror_files (path, user_id, content, updated_at) VALUES (${`${dir(id)}/tabs/main.md`}, ${tenantNs}, ${`doc ${id}: needle-${id}`}, now())`;
      await mods.lifecycle.recordLiveChange(tenantNs, { fileId: id, file: { name: id, mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T00:00:00Z", trashed: false, capabilities: { canReadRevisions: true } } }, mailbox);
      await mods.checkpoints.setExportDirectory(tenantNs, id, dir(id));
    }
    // Real exporter: publish over the binding-token protocol, then the heartbeat with account owners.
    for (let i = 0; i < 5 && (await mods.exp.runOnce()).claimed > 0; i++);
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE dead_lettered_at IS NULL`)[0].n).toBe(0);
    expect(await mods.exp.reportStatus(tenantNs)).toBe(true);

    const rel = (id: string) => dir(id).replace(/^sources\//, "");
    const grep = async (who: string) => ((await call(who, "grep", { path: "$SOURCES", pattern: "needle-[a-z-]+" })).matches ?? []).map((m: Any) => m.path).sort();
    expect(await grep("bob")).toEqual([`$SOURCES/gmail/bob@corp.example/inbox/m.md`, `$SOURCES/${rel(docs.b)}/tabs/main.md`]);
    expect(await grep("alice")).toEqual([`$SOURCES/gmail/alice@corp.example/inbox/m.md`, `$SOURCES/${rel(docs.a)}/tabs/main.md`]);
    expect(await grep("carol")).toEqual([]);
    expect((await call("bob", "read", { path: `$SOURCES/${rel(docs.b)}/tabs/main.md` })).content).toContain("needle-doc-bob");
    for (const who of ["alice", "bob", "carol"]) {
      expect((await call(who, "read", { path: `$SOURCES/${rel(docs.l)}/tabs/main.md` })).code).toBe("not_found");
      expect((await call(who, "read", { path: "$SOURCES/gmail/legacy@corp.example/inbox/m.md" })).code).toBe("not_found");
    }
    expect((await call("alice", "read", { path: `$SOURCES/${rel(docs.b)}/tabs/main.md` })).code).toBe("not_found");
  }, 120_000);
});
