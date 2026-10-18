import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End to end on real PostgreSQL with the REAL runtime (DWD collection, production queue, the gdocs task handler, the
 * donor drive-pdf intake hook, exporter publish + heartbeat, attribution route) and the REAL yc_msaw (OIDC, mock
 * issuer): alice writes a Sheet and owns a PDF; bob may only comment on the Sheet and read the PDF; carol has no Google
 * account. Bob reads exactly the current content and comments Google gives HIS credential; alice keeps her full units.
 * Google is a local fake that mints one DWD token per impersonated mailbox and answers per token; synthetic data only,
 * own throwaway database (dropped).
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

const SHEET = "sheet-q3";
const PDF = "pdf-terms";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const state = { sheetModified: "2026-10-01T10:00:00Z", pdfModified: "2026-10-01T10:00:00Z", pdfDownload: true };
const writers = new Set(["alice@corp.example"]);
const viewers = new Set(["bob@corp.example"]);

const importYc = (rel: string): Promise<Any> => import(pathToFileURL(path.join(YC_ROOT, rel)).href);

/** Google only: DWD JWT mint (one token per impersonated mailbox), identity-only code exchange, Drive/Sheets as that token. */
async function fakeGoogleFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!/^https:\/\/([a-z0-9-]+\.)?(googleapis\.com|docs\.google\.com)\//.test(url)) return realFetch(input, init);
  const body = typeof init.body === "string" ? new URLSearchParams(init.body) : init.body instanceof URLSearchParams ? init.body : null;
  if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
    const sub = JSON.parse(Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString("utf8")).sub as string;
    return Response.json({ access_token: `ya29.dwd.${sub}`, expires_in: 3600 });
  }
  const headers = new Headers(init.headers);
  const as = (headers.get("authorization") ?? "").replace(/^Bearer ya29\.dwd\./, "");
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
  if (!writer && !viewers.has(as)) return Response.json({ error: { code: 404 } }, { status: 404 });
  if (u.hostname === "www.googleapis.com" && u.pathname === "/drive/v3/about") return Response.json({ exportFormats: { [SHEET_MIME]: [XLSX, "application/pdf"] } });
  const m = /^\/drive\/v3\/files\/([^/]+)(\/export|\/comments)?$/.exec(u.pathname);
  if (u.hostname === "www.googleapis.com" && m) {
    const id = decodeURIComponent(m[1]!);
    if (m[2] === "/comments") {
      // Commenters and writers see the thread; a reader does not (the runtime records whatever Google answers).
      if (id === PDF && !writer) return Response.json({ error: { code: 403 } }, { status: 403 });
      return Response.json({ comments: [{ id: "c1", content: `needle-visible-comment-as-${as.split("@")[0]}`, author: { displayName: "Alice", emailAddress: "alice@corp.example" }, replies: [] }] });
    }
    if (m[2] === "/export") return new Response(Buffer.from(`XLSX needle-sheet-bytes-as-${as.split("@")[0]}`), { headers: { "content-type": XLSX } });
    if (u.searchParams.get("alt") === "media") {
      // The donor drive-pdf byte intake (no quota-user header; it would store into S3, absent here) fails at fetch and
      // records a failed_fetch donor row; the account capture (googleFetch, quota-attributed) gets the bytes.
      if (!headers.get("x-goog-quota-user")) return new Response("unavailable", { status: 503 });
      return new Response(Buffer.from(`%PDF needle-pdf-bytes-as-${as.split("@")[0]}`), { headers: { "content-type": "application/pdf" } });
    }
    const sheet = id === SHEET;
    return Response.json({
      id, name: sheet ? "Q3 plan" : "Terms.pdf", mimeType: sheet ? SHEET_MIME : "application/pdf",
      modifiedTime: sheet ? state.sheetModified : state.pdfModified,
      capabilities: { canReadRevisions: writer, canDownload: writer || !sheet ? (writer || state.pdfDownload) : true, canCopy: true, canComment: writer || sheet },
      ...(writer ? { permissions: [{ id: "p", type: "user", role: "commenter", emailAddress: "needle-permission-list@corp.example" }] } : {}),
    });
  }
  if (u.hostname === "sheets.googleapis.com") return Response.json({ spreadsheetId: SHEET, sheets: [{ data: [{ rowData: [{ values: [{ formattedValue: `needle-grid-as-${as.split("@")[0]}` }] }] }] }] });
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

describe.skipIf(!PG)("view-only Google native types end to end: real runtime + real yc_msaw + real PostgreSQL", () => {
  beforeAll(async () => {
    const { startMockIssuer } = await importYc("src/auth/testing/mock-issuer.ts");
    issuer = await startMockIssuer();
    tenantNs = (await importYc("src/auth/tenant.ts")).tenantNsFor(issuer.issuer, { organizationId: "org_acme", subject: "x" });
    const postgres = (await import("postgres")).default;
    dbName = `gnv_e2e_${process.pid}_${randomBytes(3).toString("hex")}`;
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
    // Idempotent: the production plan applied twice (9104 and 9105 included).
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../src/db/client.js");
    mods.exporter = await import("../../../src/source-lane/export/exporter.js");
    mods.registry = await import("../../../src/source-lane/registry.js");
    mods.internal = await import("../../../src/source-lane/internal/app.js");
    mods.lifecycle = await import("../../../src/source-lane/providers/google-docs/lifecycle.js");
    mods.paths = await import("../../../src/source-lane/providers/google-docs/paths.js");
    mods.account = await import("../../../src/source-lane/providers/google-docs/account-capture.js");
    mods.sweep = await import("../../../src/source-lane/providers/google-docs/sweep.js");
    mods.files = await import("../../../src/source-lane/providers/google-docs/account-files.js");
    mods.donor = await import("../../../src/polling/_archived-gdocs/gdocs.js");
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
    ycDir = await mkdtemp(path.join(os.tmpdir(), "gnv-e2e-yc-"));
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

  it("bob reads his own current Sheet, PDF and comments (his credential), alice her full units, carol nothing", async () => {
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
    const { resolveGoogleAuthMode } = await import("../../../src/vault/google-auth.js");
    expect(await resolveGoogleAuthMode(tenantNs, "bob@corp.example")).toBe("domain_wide_delegation");

    // Each mailbox's own Drive view: the Sheet through the source-lane lifecycle hook, the PDF through the donor
    // drive-pdf intake (bob's feed) and the same visibility function for alice.
    for (const [mailbox, can] of [["alice@corp.example", true], ["bob@corp.example", false]] as const) {
      await mods.lifecycle.recordLiveChange(tenantNs, { fileId: SHEET, file: { name: "Q3 plan", mimeType: SHEET_MIME, modifiedTime: state.sheetModified, trashed: false, capabilities: { canReadRevisions: can } } }, mailbox);
    }
    await mods.lifecycle.setFileVisibility(tenantNs, PDF, "alice@corp.example", true, undefined, { canReadRevisions: true });
    const pdfChange = (modifiedTime: string) => ({ fileId: PDF, file: { name: "Terms.pdf", mimeType: "application/pdf", modifiedTime, trashed: false, capabilities: { canReadRevisions: false } } });
    await mods.donor.processDrivePdfChanges(tenantNs, [pdfChange(state.pdfModified)], "ya29.dwd.bob@corp.example", "bob@corp.example");
    const queued = await sql`SELECT id, payload, dedupe_key FROM task_queue WHERE tenant_id = ${tenantNs} AND kind = 'gdocs.account-snapshot' AND state = 'queued'`;
    expect(queued.map((t: Any) => [t.payload.docId, t.payload.mailbox]).sort()).toEqual([[PDF, "bob@corp.example"], [SHEET, "bob@corp.example"]]);

    // alice's shared Sheet unit through the production poll sweep (checkpoint mailbox: alice).
    googleCalls.length = 0;
    const shared = await mods.sweep.runGdocsSourceSweep(tenantNs, { maxFiles: 5, budgetMs: 60_000, includeDocs: false });
    expect(shared.results.map((x: Any) => [x.fileId, x.state])).toEqual([[SHEET, "complete"]]);
    expect(new Set(googleCalls.map((c) => c.as))).toEqual(new Set(["alice@corp.example"]));

    // bob's queued tasks through the production handler (recorded as source sync runs).
    googleCalls.length = 0;
    const handler = mods.google.googleIntegration.taskHandlers()["gdocs.account-snapshot"];
    const results = [];
    for (const t of queued) results.push(await handler(t.payload, { task: { id: `t-${t.payload.docId}`, queue: "sync", tenantId: tenantNs } }));
    expect(results.map((x: Any) => [x.status, x.apiCalls]).sort()).toEqual([["complete", 2], ["complete", 5]]);
    expect(new Set(googleCalls.map((c) => c.as))).toEqual(new Set(["bob@corp.example"]));
    expect((await sql`SELECT status FROM source_sync_runs WHERE user_id = ${tenantNs} AND metadata->>'taskKind' = 'gdocs.account-snapshot'`).map((x: Any) => x.status)).toEqual(["completed", "completed"]);
    // What the worker does after a handler returns (so a later change can enqueue a fresh task past the dedupe key).
    await sql`UPDATE task_queue SET state = 'succeeded', finished_at = now() WHERE id IN ${sql(queued.map((t: Any) => t.id))}`;

    for (let i = 0; i < 8 && (await mods.exp.runOnce()).claimed > 0; i++);
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE dead_lettered_at IS NULL`)[0].n).toBe(0);
    expect(await mods.exp.reportStatus(tenantNs)).toBe(true);

    const root = mods.account.accountRoot("bob@corp.example") as string;
    const bobSheet = (mods.files.accountFileDirectory(root, "sheets", SHEET, "Q3 plan") as string).replace(/^sources\//, "");
    const bobPdf = (mods.files.accountFileDirectory(root, "pdf", PDF, "Terms.pdf") as string).replace(/^sources\//, "");
    const sharedSheet = (mods.paths.driveFileDirectory("sheets", SHEET, "Q3 plan") as string).replace(/^sources\//, "");
    // Binary sources are served as base64 byte slices; grep covers textual files only.
    const bytesOf = async (who: string, p: string) => {
      const r = await call(who, "read", { path: `$SOURCES/${p}` });
      return r.code ? r.code as string : Buffer.from(String(r.content), r.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    };
    const grep = async (who: string) => ((await call(who, "grep", { path: "$SOURCES", pattern: "needle-[a-z-]+" })).matches ?? []).map((m: Any) => m.path.replace("$SOURCES/", "")).sort();

    const bobHits = await grep("bob");
    expect(bobHits).toEqual([`${bobSheet}/comments.json`, `${bobSheet}/native.json`]);
    expect(await bytesOf("bob", `${bobSheet}/content/Q3 plan.xlsx`)).toBe("XLSX needle-sheet-bytes-as-bob");
    expect(await bytesOf("bob", `${bobPdf}/content/Terms.pdf`)).toBe("%PDF needle-pdf-bytes-as-bob");
    expect((await call("bob", "read", { path: `$SOURCES/${bobSheet}/comments.json` })).content).toContain("needle-visible-comment-as-bob");
    const bobFiles = [...bobHits, `${bobSheet}/content/Q3 plan.xlsx`, `${bobSheet}/drive.json`, `${bobSheet}/capture.json`, `${bobPdf}/content/Terms.pdf`, `${bobPdf}/drive.json`, `${bobPdf}/capture.json`];
    const bobAll = (await Promise.all(bobFiles.map((p: string) => bytesOf("bob", p)))).join("\n");
    expect(bobAll).not.toContain("not_found");
    expect(bobAll).not.toContain("as-alice");
    expect(bobAll).not.toContain("needle-permission-list");
    for (const p of [`${sharedSheet}/content/Q3 plan.xlsx`, `${sharedSheet}/drive.json`, `${sharedSheet}/native.json`]) {
      expect((await call("bob", "read", { path: `$SOURCES/${p}` })).code, p).toBe("not_found");
    }
    expect((await call("bob", "sources_history", { path: `$SOURCES/${sharedSheet}/content/Q3 plan.xlsx` })).versions).toEqual([]);

    // alice: her full shared unit (her bytes, her permission view); no account view of bob's.
    const aliceHits = await grep("alice");
    expect(aliceHits).toContain(`${sharedSheet}/native.json`);
    expect((await call("alice", "read", { path: `$SOURCES/${sharedSheet}/drive.json` })).content).toContain("needle-permission-list");
    expect(aliceHits.some((p: string) => p.startsWith("google-docs/_accounts/"))).toBe(false);
    expect((await call("alice", "read", { path: `$SOURCES/${bobPdf}/content/Terms.pdf` })).code).toBe("not_found");
    expect(await grep("carol")).toEqual([]);

    const scopes = async (who: string) => ((await call(who, "sources_status", {})).providers.find((p: Any) => p.provider === "google-docs")?.coverage ?? []).map((c: Any) => c.scope);
    expect(await scopes("bob")).toEqual(["account:bob@corp.example"]);
    expect(await scopes("alice")).not.toContain("account:bob@corp.example");
    expect(await scopes("carol")).toEqual([]);

    // The owner restricts downloads of the PDF for readers: bob's copy keeps metadata only; Sheet access is lost.
    state.pdfDownload = false;
    state.pdfModified = "2026-10-02T10:00:00Z";
    await mods.donor.processDrivePdfChanges(tenantNs, [pdfChange(state.pdfModified)], "ya29.dwd.bob@corp.example", "bob@corp.example");
    await mods.lifecycle.recordDeadChange(tenantNs, { fileId: SHEET, removed: true }, "removed", "bob@corp.example");
    const again = await sql`SELECT payload FROM task_queue WHERE tenant_id = ${tenantNs} AND kind = 'gdocs.account-snapshot' AND state = 'queued'`;
    expect(again.map((t: Any) => t.payload.docId)).toEqual([PDF]);
    for (const t of again) await handler(t.payload, { task: { id: "t-again", queue: "sync", tenantId: tenantNs } });
    expect((await mods.account.getAccountCapture(tenantNs, PDF, "bob@corp.example")).state).toBe("blocked");
    for (let i = 0; i < 8 && (await mods.exp.runOnce()).claimed > 0; i++);
    await mods.exp.reportStatus(tenantNs);
    await new Promise((res) => setTimeout(res, 5_100)); // viewer cache TTL
    expect((await call("bob", "read", { path: `$SOURCES/${bobPdf}/content/Terms.pdf` })).code).toBe("not_found");
    expect((await call("bob", "read", { path: `$SOURCES/${bobPdf}/capture.json` })).content).toContain("copy_restricted_for_account");
    expect((await call("bob", "read", { path: `$SOURCES/${bobSheet}/content/Q3 plan.xlsx` })).code).toBe("not_found");
    // His earlier captures stay his own history (captured under his own authority), and alice's unit is untouched.
    expect((await call("bob", "sources_history", { path: `$SOURCES/${bobSheet}/content/Q3 plan.xlsx` })).versions.length).toBeGreaterThan(0);
    expect(await bytesOf("alice", `${sharedSheet}/content/Q3 plan.xlsx`)).toBe("XLSX needle-sheet-bytes-as-alice");
  }, 180_000);
});
