import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End to end on real PostgreSQL with the REAL runtime (DWD collection, production queue, the gdocs task handlers,
 * exporter publish + heartbeat, attribution route) and the REAL yc_msaw (OIDC, mock issuer): alice writes a Doc,
 * bob may only read it, carol has no Google account. Both prove their DWD mailbox with the identity-only sign-in.
 * Bob reads exactly the current view Google gives HIS credential; alice keeps her full rich unit. Google is a local
 * fake that mints one DWD token per impersonated mailbox and answers per token; synthetic data, own database.
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
const googleCalls: Array<{ url: string; as: string }> = [];

const DOC = "doc-roadmap";
const DOC_MIME = "application/vnd.google-apps.document";
const URI = (who: string) => `https://lh3.googleusercontent.com/docs/${who.toUpperCase()}-REQUESTER-TAGGED`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5]);
const google = { modifiedTime: "2026-10-01T10:00:00Z", revisionId: "rev-1", body: "Roadmap current text" };
const writers = new Set(["alice@corp.example"]);
const readers = new Set(["bob@corp.example"]);

const importYc = (rel: string): Promise<Any> => import(pathToFileURL(path.join(YC_ROOT, rel)).href);

function docJson(as: string, inline: boolean) {
  const elements: unknown[] = [{ textRun: { content: `${google.body} needle-roadmap-current\n` } }];
  if (inline) elements.push({ textRun: { content: "needle-writer-suggestion ", suggestedInsertionIds: ["s1"] } });
  return {
    documentId: DOC, title: "Roadmap", revisionId: google.revisionId, suggestionsViewMode: inline ? "SUGGESTIONS_INLINE" : "PREVIEW_WITHOUT_SUGGESTIONS",
    tabs: [{
      tabProperties: { tabId: "t.0", title: "Main", index: 0 },
      documentTab: {
        body: { content: [{ paragraph: { elements } }, { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: "kix.i" } }] } }] },
        inlineObjects: { "kix.i": { inlineObjectProperties: { embeddedObject: { title: "Chart", imageProperties: { contentUri: URI(as.split("@")[0]!) } } } } },
      },
    }],
  };
}

/** Google only: DWD JWT mint (one token per impersonated mailbox), identity-only code exchange, Drive/Docs as that token. */
async function fakeGoogleFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://lh3.googleusercontent.com/")) {
    googleCalls.push({ url, as: "contentUri" });
    return new Response(new Uint8Array(PNG), { headers: { "content-type": "image/png" } });
  }
  if (!/^https:\/\/([a-z0-9-]+\.)?(googleapis\.com|docs\.google\.com)\//.test(url)) return realFetch(input, init);
  const body = typeof init.body === "string" ? new URLSearchParams(init.body) : init.body instanceof URLSearchParams ? init.body : null;
  if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
    const sub = JSON.parse(Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString("utf8")).sub as string;
    return Response.json({ access_token: `ya29.dwd.${sub}`, expires_in: 3600 });
  }
  const as = (new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer ya29\.dwd\./, "");
  googleCalls.push({ url, as });
  if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return Response.json({ emailAddress: as, historyId: "1" });
  if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "authorization_code") {
    const now = Math.floor(Date.now() / 1000);
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const claims = { iss: "https://accounts.google.com", aud: "e2e-client.apps.googleusercontent.com", sub: `g-${consentAs}`, email: consentAs, email_verified: true, hd: "corp.example", nonce, iat: now, exp: now + 3600 };
    return Response.json({ access_token: "ya29.identity", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/userinfo.email", id_token: `${enc({ alg: "RS256" })}.${enc(claims)}.c2ln` });
  }
  const u = new URL(url);
  const writer = writers.has(as);
  if (!writer && !readers.has(as)) return Response.json({ error: { code: 404 } }, { status: 404 });
  if (u.hostname === "www.googleapis.com" && u.pathname === `/drive/v3/files/${DOC}`) {
    return Response.json({
      id: DOC, name: "Roadmap", mimeType: DOC_MIME, modifiedTime: google.modifiedTime,
      capabilities: { canReadRevisions: writer, canDownload: true, canCopy: true },
      ...(writer ? { permissions: [{ id: "p", type: "user", role: "reader", emailAddress: "needle-permission-list@corp.example" }] } : {}),
    });
  }
  if (u.hostname === "docs.googleapis.com") {
    const mode = u.searchParams.get("suggestionsViewMode");
    if (mode === "SUGGESTIONS_INLINE" && !writer) return Response.json({ error: { code: 403 } }, { status: 403 });
    const inline = mode === "SUGGESTIONS_INLINE" || (mode === "DEFAULT_FOR_CURRENT_ACCESS" && writer);
    return Response.json(docJson(as, inline));
  }
  if (u.hostname === "docs.google.com") return new Response("", { status: 403 });
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

describe.skipIf(!PG)("view-only Google accounts end to end: real runtime + real yc_msaw + real PostgreSQL", () => {
  beforeAll(async () => {
    const { startMockIssuer } = await importYc("src/auth/testing/mock-issuer.ts");
    issuer = await startMockIssuer();
    tenantNs = (await importYc("src/auth/tenant.ts")).tenantNsFor(issuer.issuer, { organizationId: "org_acme", subject: "x" });
    const postgres = (await import("postgres")).default;
    dbName = `gvc_e2e_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
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
    // Idempotent: the production plan applied twice (9104 included).
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../src/db/client.js");
    mods.exporter = await import("../../../src/source-lane/export/exporter.js");
    mods.registry = await import("../../../src/source-lane/registry.js");
    mods.internal = await import("../../../src/source-lane/internal/app.js");
    mods.lifecycle = await import("../../../src/source-lane/providers/google-docs/lifecycle.js");
    mods.paths = await import("../../../src/source-lane/providers/google-docs/paths.js");
    mods.account = await import("../../../src/source-lane/providers/google-docs/account-capture.js");
    mods.snapshot = await import("../../../src/integrations/google/gdocs/content-snapshot.js");
    mods.google = await import("../../../src/integrations/google/index.js");
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
    ycDir = await mkdtemp(path.join(os.tmpdir(), "gvc-e2e-yc-"));
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

  it("bob reads his own current view (his credential), alice her full unit, carol nothing; through the production wiring", async () => {
    expect((await yc_("POST", "/v1/sources/runtime/provision", "alice", {})).status).toBe(201);
    for (const email of ["alice@corp.example", "bob@corp.example"]) {
      const r = await yc_("POST", "/v1/sources/google/auth/dwd/mailboxes", "alice", { email });
      expect(r.status, await r.clone().text()).toBe(200);
    }
    for (const who of ["alice", "bob"]) {
      consentAs = `${who}@corp.example`;
      const started = await yc_("POST", "/v1/sources/google/auth/ownership/start", who, { account: "self" });
      expect(started.status).toBe(201);
      const { launchUrl } = (await started.json()) as { launchUrl: string };
      const launched = await realFetch(launchUrl.replace("https://runtime.example.test", runtimeBase), { redirect: "manual" });
      const authorize = new URL(launched.headers.get("location")!);
      nonce = authorize.searchParams.get("nonce");
      const cookie = launched.headers.get("set-cookie")!.split(";")[0]!;
      const cb = await realFetch(`${runtimeBase}/auth/google/oauth/callback?state=${encodeURIComponent(authorize.searchParams.get("state")!)}&code=4%2Fe2e`, { headers: { cookie } });
      expect(cb.status, await cb.clone().text()).toBe(200);
    }
    // Collection mode is unchanged by ownership: still DWD for both.
    const { resolveGoogleAuthMode } = await import("../../../src/vault/google-auth.js");
    expect(await resolveGoogleAuthMode(tenantNs, "bob@corp.example")).toBe("domain_wide_delegation");

    // Each mailbox's own Drive view, as the changes feed / inventory record it (production lifecycle hook).
    for (const [mailbox, can] of [["alice@corp.example", true], ["bob@corp.example", false]] as const) {
      await mods.lifecycle.recordLiveChange(tenantNs, { fileId: DOC, file: { name: "Roadmap", mimeType: DOC_MIME, modifiedTime: google.modifiedTime, trashed: false, capabilities: { canReadRevisions: can } } }, mailbox);
    }
    // The hook queued exactly one account snapshot in the production task queue: bob's.
    const queued = await sql`SELECT kind, payload, dedupe_key FROM task_queue WHERE tenant_id = ${tenantNs} AND kind = 'gdocs.account-snapshot'`;
    expect(queued.map((t: Any) => [t.payload.mailbox, t.dedupe_key])).toEqual([["bob@corp.example", `gdocs-account-snapshot:${tenantNs}:${DOC}:bob@corp.example`]]);

    // alice's shared unit through the donor content-snapshot path (tenant default credential).
    googleCalls.length = 0;
    expect((await mods.snapshot.snapshotDocContent(tenantNs, DOC, { modifiedTime: google.modifiedTime })).status).toBe("captured");
    const sharedAs = new Set(googleCalls.filter((c) => c.url.includes("docs.googleapis.com")).map((c) => c.as));
    // bob's queued task through the production handler (recorded as a source sync run).
    googleCalls.length = 0;
    const handler = mods.google.googleIntegration.taskHandlers()["gdocs.account-snapshot"];
    const r = await handler(queued[0].payload, { task: { id: "t-1", queue: "sync", tenantId: tenantNs } });
    // files.get + documents.get + comments.list (google-native-views: the fake refuses bob's comments, nothing is kept).
    expect(r).toMatchObject({ status: "complete", apiCalls: 3, imageFetches: 1 });
    expect(googleCalls.filter((c) => c.as !== "contentUri").map((c) => c.as)).toEqual(["bob@corp.example", "bob@corp.example", "bob@corp.example"]);
    expect(googleCalls.find((c) => c.as === "contentUri")!.url).toBe(URI("bob"));
    expect((await sql`SELECT status FROM source_sync_runs WHERE user_id = ${tenantNs} AND metadata->>'taskKind' = 'gdocs.account-snapshot'`).map((x: Any) => x.status)).toEqual(["completed"]);
    // The donor shared baseline holds only the shared capture's revision rows.
    expect((await sql`SELECT count(DISTINCT revision_id)::int AS n FROM google_doc_tab_snapshots WHERE user_id = ${tenantNs}`)[0].n).toBe(1);

    // Real exporter: publish, then the heartbeat (owners + coverage).
    for (let i = 0; i < 6 && (await mods.exp.runOnce()).claimed > 0; i++);
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE dead_lettered_at IS NULL`)[0].n).toBe(0);
    expect(await mods.exp.reportStatus(tenantNs)).toBe(true);

    const shared = (mods.paths.docDirectory(DOC, "Roadmap") as string).replace(/^sources\//, "");
    const bobView = (mods.account.accountDocDirectory("bob@corp.example", DOC, "Roadmap") as string).replace(/^sources\//, "");
    const grep = async (who: string) => ((await call(who, "grep", { path: "$SOURCES", pattern: "needle-[a-z-]+" })).matches ?? []).map((m: Any) => m.path.replace("$SOURCES/", "")).sort();

    const bobHits = await grep("bob");
    expect(bobHits.length).toBeGreaterThan(0);
    expect(bobHits.every((p: string) => p.startsWith(`${bobView}/`))).toBe(true);
    expect((await call("bob", "read", { path: `$SOURCES/${bobView}/tabs/t.0.md` })).content).toContain("Roadmap current text");
    const bobAll = JSON.stringify(await Promise.all(bobHits.map((p: string) => call("bob", "read", { path: `$SOURCES/${p}` }))));
    expect(bobAll).not.toContain("needle-writer-suggestion");
    expect(bobAll).not.toContain("needle-permission-list");
    for (const p of [`${shared}/native/document.json`, `${shared}/drive.json`, `${shared}/tabs/main.md`]) {
      expect((await call("bob", "read", { path: `$SOURCES/${p}` })).code, p).toBe("not_found");
    }
    expect((await call("bob", "sources_history", { path: `$SOURCES/${shared}/native/document.json` })).versions).toEqual([]);

    // alice: the writer's rich unit, including the suggestion text and the permission list; not bob's view.
    const aliceHits = await grep("alice");
    expect(aliceHits.some((p: string) => p === `${shared}/native/document.json`)).toBe(true);
    expect((await call("alice", "read", { path: `$SOURCES/${shared}/native/document.json` })).content).toContain("needle-writer-suggestion");
    expect(aliceHits.some((p: string) => p.startsWith("google-docs/_accounts/"))).toBe(false);
    expect((await call("alice", "read", { path: `$SOURCES/${bobView}/tabs/t.0.md` })).code).toBe("not_found");
    expect([...sharedAs]).not.toContain("bob@corp.example");

    expect(await grep("carol")).toEqual([]);

    // Coverage: bob sees his own account scope, alice and carol do not see it.
    const scopes = async (who: string) => ((await call(who, "sources_status", {})).providers.find((p: Any) => p.provider === "google-docs")?.coverage ?? []).map((c: Any) => c.scope);
    expect(await scopes("bob")).toEqual(["account:bob@corp.example"]);
    expect(await scopes("alice")).not.toContain("account:bob@corp.example");
    expect(await scopes("carol")).toEqual([]);

    // Role change at Google: bob becomes a writer -> the full unit is his, his copy is retired (history kept for him).
    await mods.lifecycle.recordLiveChange(tenantNs, { fileId: DOC, file: { name: "Roadmap", mimeType: DOC_MIME, modifiedTime: "2026-10-02T10:00:00Z", trashed: false, capabilities: { canReadRevisions: true } } }, "bob@corp.example");
    for (let i = 0; i < 6 && (await mods.exp.runOnce()).claimed > 0; i++);
    await mods.exp.reportStatus(tenantNs);
    await new Promise((res) => setTimeout(res, 5_100)); // viewer cache TTL
    expect((await call("bob", "read", { path: `$SOURCES/${shared}/native/document.json` })).content).toContain("needle-writer-suggestion");
    expect((await call("bob", "read", { path: `$SOURCES/${bobView}/tabs/t.0.md` })).code).toBe("not_found");
    expect((await call("bob", "sources_history", { path: `$SOURCES/${bobView}/tabs/t.0.md` })).versions.length).toBeGreaterThan(0);
  }, 180_000);
});
