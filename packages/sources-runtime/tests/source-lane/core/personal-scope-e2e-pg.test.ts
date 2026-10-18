import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGranola, note } from "../providers/granola/fake-granola.js";

/**
 * Personal owner scopes end to end on real PostgreSQL, with the REAL runtime (internal + public routes, task
 * handlers, exporter publish + heartbeat) and the REAL yc_msaw (OIDC mock issuer; alice is an admin, bob and carol
 * are plain members of ONE organization, so one tenant namespace).
 *
 * - Granola (API key) and Zoom (OAuth with the runtime callback) are connected by two members side by side. Each
 *   account's credential, lane state and rows live in that member's scope tenant; files are published under
 *   sources/<provider>/<member segment>/, readable by that member only. The same provider note or meeting id seen
 *   by both accounts is captured twice, once per owner.
 * - A Granola connection made before owner scopes (organization level) keeps collecting into unsegmented paths.
 *   Those rows stay sealed for everyone: before export, after the members connect, after an exporter backfill
 *   re-journals them with a new capturedAt, and after an operator purge (tombstones keep no readable history).
 * Provider APIs are local fakes (no network); synthetic data only; own throwaway database.
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
let handlers: Record<string, Any>;
const tok: Record<string, string> = {};
const clients = new Map<string, Any>();
const realFetch = globalThis.fetch;
const granola = new FakeGranola();
const VTT = (who: string) => `WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAda: zoom words of ${who} needle-zoom-${who}.\n`;
/** Zoom recordings per access token (an account); `shared-uuid` is visible to both members. */
const zoomMeetings: Record<string, Array<Record<string, unknown>>> = {};

const importYc = (rel: string): Promise<Any> => import(pathToFileURL(path.join(YC_ROOT, rel)).href);

function zoomMeeting(uuid: string, who: string): Record<string, unknown> {
  const start = new Date(Date.now() - 86_400_000).toISOString();
  return {
    uuid, id: 4242, topic: `Sync ${uuid}`, start_time: start, host_email: `${who}@acme.test`, share_url: "https://zoom.us/rec/share/x",
    recording_files: [{ id: `${uuid}-${who}-vtt`, file_type: "TRANSCRIPT", file_extension: "VTT", status: "completed", download_url: `https://zoom.us/rec/download/${uuid}-${who}-vtt`, recording_end: start }],
  };
}

/** Provider endpoints only (Granola public API, Zoom OAuth/API/CDN); yc_msaw and the runtime are real HTTP. */
async function fakeProviders(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.host === "public-api.granola.ai") return granola.fetch(input as Any, init);
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/token") {
    const body = new URLSearchParams(String(init.body));
    const who = (body.get("code") ?? body.get("refresh_token") ?? "").replace(/^(code|rt)-/, "");
    return Response.json({ access_token: `at-${who}`, refresh_token: `rt-${who}`, expires_in: 3600, scope: "cloud_recording:read:list_user_recordings" });
  }
  const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me/recordings") return Response.json({ meetings: zoomMeetings[bearer] ?? [] });
  if (url.hostname === "api.zoom.us" && url.pathname.startsWith("/v2/past_meetings/")) return Response.json({ participants: [] });
  if (url.hostname === "zoom.us" && url.pathname.startsWith("/rec/download/")) {
    const file = url.pathname.split("/").pop()!;
    return new Response(null, { status: 302, headers: { location: `https://cdn.zoomcdn.example/${file}?sig=abc` } });
  }
  if (url.hostname === "cdn.zoomcdn.example") return new Response(VTT(url.pathname.split("-").at(-2)!), { status: 200, headers: { "content-type": "text/vtt" } });
  if (/(^|\.)(granola\.ai|zoom\.us|zoomcdn\.example)$/.test(url.hostname)) return new Response("not found", { status: 404 });
  return realFetch(input, init);
}

async function mcp(who: string, name: string, args: Record<string, unknown>): Promise<Any> {
  let c = clients.get(who);
  if (!c) {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client" as string);
    c = new Client({ name: `pca-${who}`, version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(ycMcp), { requestInit: { headers: { Authorization: `Bearer ${tok[who]}` } } }));
    clients.set(who, c);
  }
  const r = await c.callTool({ name, arguments: args });
  try {
    return { ...JSON.parse(r.content[0].text), isError: r.isError === true };
  } catch {
    throw new Error(`${who} ${name} ${JSON.stringify(args)} answered ${String(r.content[0]?.text).slice(0, 200)}`);
  }
}
const yc_ = (method: string, route: string, who: string, body?: unknown) =>
  realFetch(`${ycBase}${route}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** Run every due task through the real dequeue/succeed SQL and the production source-lane handlers. */
async function drainTasks(max = 200): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < max; i++) {
    const task = await mods.queue.dequeueTask(["sync", "backfill"], mods.db.db);
    if (!task) break;
    const handler = handlers[task.kind];
    if (!handler) throw new Error(`no handler for ${task.kind}`);
    try {
      await mods.queue.succeedTask(task.id, (await handler(task.payload, { task, heartbeat: async () => {} })) ?? undefined, mods.db.db);
      ran.push(`${task.kind}@${task.tenantId}`);
    } catch (error) {
      await mods.queue.failTask(task.id, String(error), mods.db.db);
      throw error;
    }
  }
  return ran;
}

async function exportAll(): Promise<void> {
  for (let i = 0; i < 20 && (await mods.exp.runOnce()).claimed > 0; i++);
  expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE dead_lettered_at IS NULL`)[0].n).toBe(0);
  expect(await sql`SELECT tenant_id, row_key, last_error FROM source_lane_journal WHERE dead_lettered_at IS NOT NULL LIMIT 3`).toEqual([]);
}

/** The uploader's message shape (gigabrain Messages sender), synthetic. */
function imessage(guid: string, text: string, rowId: number): Record<string, unknown> {
  return {
    messageId: guid, providerMessageGuid: guid, _provider_guid_explicit: true, localRowId: rowId, rowId,
    deviceId: "11111111-1111-4111-8111-111111111111", agentVersion: "0.9.0-test", agentChannel: "test",
    text, service: "iMessage", chatId: "iMessage;-;+15550001111", chatKind: "dm", chatName: null, participant: "+15550001111",
    isFromMe: false, createdAt: "2026-09-10T12:00:00.000Z", deliveredAt: null, readAt: null, editedAt: null, retractedAt: null,
    reaction: null, attachments: [], replyToMessageId: null,
  };
}

const grep = async (who: string, dir = "$SOURCES") => ((await mcp(who, "grep", { path: dir, pattern: "needle-[a-z0-9-]+" })).matches ?? []).map((m: Any) => m.path as string).sort();

describe.skipIf(!PG)("personal owner scopes end to end: real runtime + real yc_msaw + real PostgreSQL", () => {
  beforeAll(async () => {
    const { startMockIssuer } = await importYc("src/auth/testing/mock-issuer.ts");
    issuer = await startMockIssuer();
    tenantNs = (await importYc("src/auth/tenant.ts")).tenantNsFor(issuer.issuer, { organizationId: "org_acme", subject: "x" });

    const postgres = (await import("postgres")).default;
    dbName = `pca_e2e_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      SOURCES_RUNTIME_PUBLIC_URL: "https://runtime.example.test",
      ZOOM_CLIENT_ID: "zoom-e2e-client",
      ZOOM_CLIENT_SECRET: "zoom-e2e-secret",
    });
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    // Idempotent: the runtime re-applies its plan on every boot.
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../src/db/client.js");
    mods.queue = await import("../../../src/queue/queue.js");
    mods.exporter = await import("../../../src/source-lane/export/exporter.js");
    mods.registry = await import("../../../src/source-lane/registry.js");
    mods.internal = await import("../../../src/source-lane/internal/app.js");
    mods.worker = await import("../../../src/source-lane/worker.js");
    mods.scope = await import("../../../src/source-lane/core/personal-scope.js");
    mods.granolaConnect = await import("../../../src/integrations/granola/connect.js");
    mods.granolaJobs = await import("../../../src/integrations/granola/jobs.js");
    globalThis.fetch = fakeProviders as typeof fetch;

    const registry = mods.registry.defaultRegistry();
    handlers = mods.worker.sourceLaneTaskHandlers(registry);
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
    ycDir = await mkdtemp(path.join(os.tmpdir(), "pca-e2e-yc-"));
    const { createApp } = await importYc("src/app.ts");
    const { DirectoryObjectStore } = await importYc("src/store/objects.ts");
    yc = await createApp({
      env: {
        HOST: "127.0.0.1", AUTH_MODE: "oidc", MCP_PUBLIC_URL: resource, OIDC_ISSUER: issuer.issuer,
        PROCMEM_ADMIN_SUBJECTS: "user_alice", PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: ycDir,
        SOURCES_RUNTIME_URL: `${runtimeBase}/internal/v1`, SOURCES_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN, SOURCES_PUBLISH_URL: `http://127.0.0.1:${ycPort}`,
        SOURCES_DEVICE_API_URL: runtimeBase,
      },
      store: new DirectoryObjectStore(path.join(ycDir, "objects")),
      builder: async () => { throw new Error("no builds"); },
      leaseFactory: async () => { throw new Error("source reads never open a sandbox"); },
      log: () => undefined,
    });
    ({ url: ycBase, mcpUrl: ycMcp } = await yc.listen(ycPort));
    for (const who of ["alice", "bob", "carol"]) tok[who] = await issuer.mint({ sub: `user_${who}`, aud: resource, scope: "openid", claims: { org_id: "org_acme" } });
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await Promise.allSettled([...clients.values()].map((c) => c.close()));
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

  it("two members connect their own Granola and Zoom side by side; legacy organization data stays sealed throughout", async () => {
    const { personalSegment: ycSegment } = await importYc("src/sources/access.ts");
    const seg = (who: string) => mods.scope.personalSegment({ tenantNs, issuer: issuer.issuer, subject: `user_${who}` }) as string;
    const scopeOf = (who: string) => mods.scope.scopeTenantIdOf(tenantNs, seg(who)) as string;
    // The two sides derive the same segment from the same verified principal (the cross-package contract).
    for (const who of ["alice", "bob", "carol"]) expect(seg(who)).toBe(ycSegment(tenantNs, { subject: `user_${who}`, issuer: issuer.issuer }));
    expect(new Set(["alice", "bob", "carol"].map(seg)).size).toBe(3);

    expect((await yc_("POST", "/v1/sources/runtime/provision", "alice", {})).status).toBe(201);
    await drainTasks();

    // Legacy: an organization-level Granola account connected before owner scopes, captured but not yet exported.
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    granola.account("grn_legacy_key");
    granola.account("grn_bob_key");
    granola.account("grn_carol_key");
    const shared = note("n-shared", day(3), { title: "Planning", summary_markdown: "shared planning needle-granola-shared" });
    granola.put("grn_legacy_key", note("n-legacy", day(9), { title: "Old board", summary_markdown: "legacy board needle-legacy-granola" }));
    granola.put("grn_legacy_key", shared);
    granola.put("grn_bob_key", shared);
    granola.put("grn_bob_key", note("n-bob", day(2), { title: "Bob one-on-one", summary_markdown: "bob private needle-granola-bob" }));
    granola.put("grn_carol_key", shared);
    granola.put("grn_carol_key", note("n-carol", day(1), { title: "Carol interview", summary_markdown: "carol private needle-granola-carol" }));
    expect((await mods.granolaConnect.connectGranolaWithToken(tenantNs, "grn_legacy_key", { startIngestion: false })).success).toBe(true);
    await mods.granolaJobs.runGranolaBackfill(tenantNs);

    // Two plain members connect their own accounts through yc_msaw (no first claimer: both succeed).
    for (const [who, key] of [["bob", "grn_bob_key"], ["carol", "grn_carol_key"]] as const) {
      const r = await yc_("POST", "/v1/sources/connect/granola", who, { apiKey: key });
      expect(r.status, await r.clone().text()).toBe(200);
    }
    const ran = await drainTasks();
    expect(ran).toContain(`granola.backfill@${scopeOf("bob")}`);
    expect(ran).toContain(`granola.backfill@${scopeOf("carol")}`);
    // Per-member credentials and rows: three tokens, three raw-id spaces (the shared note is captured once per owner).
    expect((await sql`SELECT user_id FROM integration_tokens WHERE provider = 'granola' ORDER BY user_id`).map((r: Any) => r.user_id).sort()).toEqual([tenantNs, scopeOf("bob"), scopeOf("carol")].sort());
    const perTenant = await sql`SELECT user_id, count(*)::int AS n FROM activity_events WHERE source = 'granola' AND source_object_id = 'meeting_note:n-shared' GROUP BY user_id ORDER BY user_id`;
    expect(perTenant.map((r: Any) => r.user_id).sort()).toEqual([tenantNs, scopeOf("bob"), scopeOf("carol")].sort());

    await exportAll();
    expect(await mods.exp.reportStatus(tenantNs)).toBe(true);

    const bobGranola = await grep("bob", "$SOURCES/granola");
    expect(bobGranola.length).toBeGreaterThan(0);
    expect(bobGranola.every((p: string) => p.startsWith(`$SOURCES/granola/${seg("bob")}/`))).toBe(true);
    const bobText = JSON.stringify(await mcp("bob", "grep", { path: "$SOURCES/granola", pattern: "needle-[a-z0-9-]+" }));
    expect(bobText).toContain("needle-granola-bob");
    expect(bobText).toContain("needle-granola-shared");
    expect(bobText).not.toContain("needle-granola-carol");
    expect(bobText).not.toContain("needle-legacy-granola");
    const carolText = JSON.stringify(await mcp("carol", "grep", { path: "$SOURCES", pattern: "needle-[a-z0-9-]+" }));
    expect(carolText).toContain("needle-granola-carol");
    expect(carolText).not.toContain("needle-granola-bob");
    expect(carolText).not.toContain("needle-legacy-granola");
    expect(await grep("alice")).toEqual([]); // an admin with no Granola of her own reads none
    expect((await mcp("bob", "ls", { path: "$SOURCES/granola" })).entries.map((e: Any) => e.name)).toEqual([`${seg("bob")}/`]);
    expect((await mcp("alice", "ls", { path: "$SOURCES" })).entries.map((e: Any) => e.name)).not.toContain("granola/");

    // note.json names where its own files are published (the owner's segment), and those paths are readable.
    const notes = (await mcp("bob", "find", { path: "$SOURCES/granola", pattern: "**/note.json" })).matches as string[];
    expect(notes.length).toBe(2);
    const bobNote = JSON.parse((await mcp("bob", "read", { path: notes.find((p) => !p.includes("Planning"))! })).content);
    expect(bobNote.current.raw.startsWith(`sources/granola/${seg("bob")}/_raw/`)).toBe(true);
    expect(bobNote.current.summary.startsWith(`sources/granola/${seg("bob")}/`)).toBe(true);
    expect((await mcp("bob", "read", { path: `$SOURCES/${bobNote.current.raw.slice(8)}` })).content).toContain("needle-granola-bob");
    expect((await mcp("carol", "read", { path: `$SOURCES/${bobNote.current.raw.slice(8)}` })).code).toBe("not_found");
    // Every published version names its owner segment in its provenance.
    const versions = (await mcp("bob", "sources_history", { path: `$SOURCES/${bobNote.current.raw.slice(8)}` })).versions;
    expect(versions.length).toBe(1);
    expect(versions[0].provenance.ownerSegment).toBe(seg("bob"));
    expect((await mcp("carol", "sources_history", { path: `$SOURCES/${bobNote.current.raw.slice(8)}` })).versions).toEqual([]);

    // Legacy (unsegmented) Granola files exist, and nobody reads them or their history.
    const legacyPaths = (await sql`SELECT path FROM source_lane_exported WHERE tenant_id = ${tenantNs} AND path LIKE 'sources/granola/%' ORDER BY path`).map((r: Any) => r.path as string);
    expect(legacyPaths.length).toBeGreaterThan(0);
    expect(legacyPaths.every((p: string) => !p.includes("@u-"))).toBe(true);
    const legacyNote = legacyPaths.find((p: string) => p.endsWith("/note.json"))!;
    const sealed = async () => {
      for (const who of ["alice", "bob", "carol"]) {
        expect((await mcp(who, "read", { path: `$SOURCES/${legacyNote.slice(8)}` })).code).toBe("not_found");
        expect((await mcp(who, "sources_history", { path: `$SOURCES/${legacyNote.slice(8)}` })).versions).toEqual([]);
        expect((await mcp(who, "grep", { path: "$SOURCES", pattern: "needle-legacy-granola" })).matches ?? []).toEqual([]);
      }
    };
    await sealed();

    // An exporter backfill re-journals legacy rows with a new capturedAt (E6): still sealed.
    const counts = await mods.exp.enqueueTenantBackfill(tenantNs);
    expect(counts.activity_events).toBeGreaterThan(0);
    await exportAll();
    await sealed();
    // An operator purge of the legacy rows publishes ordinary deletes: the earlier versions stay sealed too.
    await sql`DELETE FROM mirror_files WHERE user_id = ${tenantNs} AND path LIKE 'sources/granola/%'`;
    await sql`DELETE FROM granola_source_notes WHERE tenant_id = ${tenantNs}`;
    await sql`DELETE FROM activity_events WHERE user_id = ${tenantNs} AND source = 'granola'`;
    await exportAll();
    await sealed();
    expect((await mcp("bob", "grep", { path: "$SOURCES/granola", pattern: "needle-granola-bob" })).matches.length).toBeGreaterThan(0);

    // Coverage and the runtime status: each member sees only their own scope's reports and connections.
    const bobStatus = await mcp("bob", "sources_status", {});
    const bobCov = bobStatus.providers.find((p: Any) => p.provider === "granola");
    expect(bobCov.coverage.length).toBeGreaterThan(0);
    expect(bobCov.coverage.every((c: Any) => c.scope.startsWith(`owner:${seg("bob")}/`))).toBe(true);
    expect(JSON.stringify(bobStatus)).not.toContain(seg("carol"));
    expect(bobCov.files).toBeGreaterThan(0);
    const rs = (await (await yc_("GET", "/v1/sources/runtime/status", "bob")).json()) as Any;
    expect(rs.personal.segment).toBe(seg("bob"));
    expect(rs.personal.connections.map((c: Any) => c.provider)).toEqual(["granola"]);
    expect(rs.connections.map((c: Any) => c.provider)).not.toContain("granola"); // the organization-level legacy one
    expect(JSON.stringify(rs)).not.toContain(seg("carol"));

    // Zoom: OAuth through yc_msaw and the runtime's own callback; each member's grant lands in their own scope.
    zoomMeetings["at-bob"] = [zoomMeeting("shared-uuid", "bob"), zoomMeeting("bob-uuid", "bob")];
    zoomMeetings["at-carol"] = [zoomMeeting("shared-uuid", "carol"), zoomMeeting("carol-uuid", "carol")];
    for (const who of ["bob", "carol"]) {
      const started = await yc_("POST", "/v1/sources/connect/zoom", who, { mode: "oauth" });
      expect(started.status, await started.clone().text()).toBe(200);
      const authorize = new URL(((await started.json()) as Any).authorizeUrl);
      expect(authorize.host).toBe("zoom.us");
      const cb = await realFetch(`${runtimeBase}/auth/zoom/callback?code=code-${who}&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`);
      expect(cb.status, await cb.clone().text()).toBe(200);
    }
    expect((await sql`SELECT tenant_id FROM connections WHERE provider = 'zoom' ORDER BY tenant_id`).map((r: Any) => r.tenant_id).sort()).toEqual([scopeOf("bob"), scopeOf("carol")].sort());
    for (const who of ["bob", "carol"]) await handlers["zoom.poll"]({}, { task: { id: randomBytes(8).toString("hex"), tenantId: scopeOf(who), queue: "sync", kind: "zoom.poll", payload: {} }, heartbeat: async () => {} });
    await exportAll();
    const bobZoom = await grep("bob", "$SOURCES/zoom");
    expect(bobZoom.length).toBeGreaterThan(0);
    expect(bobZoom.every((p: string) => p.startsWith(`$SOURCES/zoom/${seg("bob")}/`))).toBe(true);
    const bobZoomText = JSON.stringify(await mcp("bob", "grep", { path: "$SOURCES/zoom", pattern: "needle-zoom-[a-z]+" }));
    expect(bobZoomText).toContain("needle-zoom-bob");
    expect(bobZoomText).not.toContain("needle-zoom-carol");
    expect(JSON.stringify(await mcp("carol", "grep", { path: "$SOURCES/zoom", pattern: "needle-zoom-[a-z]+" }))).not.toContain("needle-zoom-bob");
    // The meeting both accounts recorded is two rows, one per owner (no raw-id collision between members).
    expect((await sql`SELECT tenant_id FROM zoom_meetings WHERE meeting_uuid = 'shared-uuid' ORDER BY tenant_id`).map((r: Any) => r.tenant_id).sort()).toEqual([scopeOf("bob"), scopeOf("carol")].sort());

    // Disconnect stops only the caller's own account; bob's data and connection stay.
    expect((await yc_("DELETE", "/v1/sources/connections/granola", "carol")).status).toBe(200);
    expect((await sql`SELECT tenant_id, status FROM connections WHERE provider = 'granola' ORDER BY tenant_id`).map((r: Any) => `${r.tenant_id}:${r.status}`).sort()).toEqual(
      [`${tenantNs}:active`, `${scopeOf("bob")}:active`, `${scopeOf("carol")}:revoked`].sort(),
    );
    expect((await yc_("DELETE", "/v1/sources/connections/granola", "alice")).status).toBe(404); // alice has no Granola of her own
    // Members cannot stop the organization-level legacy connection; an admin can, explicitly.
    expect((await yc_("DELETE", "/v1/sources/connections/granola?legacy=organization", "bob")).status).toBe(403);
    expect((await yc_("DELETE", "/v1/sources/connections/granola?legacy=organization", "alice")).status).toBe(200);
    expect((await sql`SELECT status FROM connections WHERE provider = 'granola' AND tenant_id = ${tenantNs}`)[0].status).toBe("revoked");
    expect((await mcp("carol", "grep", { path: "$SOURCES/granola", pattern: "needle-granola-carol" })).matches.length).toBeGreaterThan(0);

    // A scope tenant is not addressable through the internal API (its id fails the tenant grammar).
    const direct = await realFetch(`${runtimeBase}/internal/v1/tenants/${scopeOf("bob")}/status`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "x-procmem-principal": JSON.stringify({ tenantNs: scopeOf("bob"), subject: "user_bob", issuer: issuer.issuer }) },
    });
    expect(direct.status).toBe(400);
  }, 180_000);

  it("two members' own Macs (iMessage, coding sessions) write into their own owner scopes; the same GUID never collides", async () => {
    const seg = (who: string) => mods.scope.personalSegment({ tenantNs, issuer: issuer.issuer, subject: `user_${who}` }) as string;
    const scopeOf = (who: string) => mods.scope.scopeTenantIdOf(tenantNs, seg(who)) as string;
    const macs: Record<string, Any> = {};
    for (const who of ["bob", "carol"]) {
      const r = await yc_("POST", "/v1/sources/devices/imessage/setup", who, { label: `${who}'s Mac` });
      expect(r.status, await r.clone().text()).toBe(201);
      macs[who] = ((await r.json()) as Any).messagesConfig;
      // The same message (both sides of one conversation share its GUID), as each member's own Mac sees it.
      const up = await realFetch(`${macs[who].apiUrl}/api/imessage/ingest`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": macs[who].agentToken },
        body: JSON.stringify({ userId: tenantNs, messages: [imessage("G-SHARED-1", `as seen by ${who}: needle-imsg-${who}`, 1)] }),
      });
      expect(up.status, await up.clone().text()).toBe(200);
      const cs = await yc_("POST", "/v1/sources/devices/coding-sessions/setup", who, {});
      expect(cs.status, await cs.clone().text()).toBe(201);
      const cfg = ((await cs.json()) as Any).codingSessionsConfig ?? ((await cs.clone().json()) as Any);
      const token = cfg.agentToken as string;
      const session = { provider: "codex", sessionId: "sess-same-id", startedAt: "2026-10-01T10:00:00Z", lastUpdatedAt: "2026-10-01T10:30:00Z", status: "completed", title: `${who} work`, repo: { fullName: "acme/app", branch: "main" }, userMessages: [{ order: 0, text: `please fix it needle-code-${who}`, timestamp: "2026-10-01T10:00:00Z" }], agentResponses: [{ order: 1, text: "Fixed.", phase: "final_answer" }] };
      const sent = await realFetch(`${cfg.apiUrl}/api/coding-sessions/ingest`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": token }, body: JSON.stringify({ sessions: [session] }) });
      expect(sent.status, await sent.clone().text()).toBe(200);
    }
    // One row per owner for the shared GUID and the same session id; none in the organization tenant.
    expect((await sql`SELECT user_id FROM activity_events WHERE source = 'imessage' ORDER BY user_id`).map((r: Any) => r.user_id).sort()).toEqual([scopeOf("bob"), scopeOf("carol")].sort());
    expect((await sql`SELECT tenant_id FROM coding_sessions WHERE session_id = 'sess-same-id'`).map((r: Any) => r.tenant_id).sort()).toEqual([scopeOf("bob"), scopeOf("carol")].sort());
    await drainTasks();
    await exportAll();
    expect(await mods.exp.reportStatus(tenantNs)).toBe(true);
    for (const [who, other] of [["bob", "carol"], ["carol", "bob"]] as const) {
      const hits = await grep(who, "$SOURCES/imessage");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((p: string) => p.startsWith(`$SOURCES/imessage/${seg(who)}/`))).toBe(true);
      const text = JSON.stringify(await mcp(who, "grep", { path: "$SOURCES", pattern: "needle-(imsg|code)-[a-z]+" }));
      expect(text).toContain(`needle-imsg-${who}`);
      expect(text).toContain(`needle-code-${who}`);
      expect(text).not.toContain(`needle-imsg-${other}`);
      expect(text).not.toContain(`needle-code-${other}`);
      expect((await grep(who, "$SOURCES/coding-sessions")).every((p: string) => p.startsWith(`$SOURCES/coding-sessions/${seg(who)}/`))).toBe(true);
    }
    expect((await mcp("alice", "grep", { path: "$SOURCES", pattern: "needle-(imsg|code)-[a-z]+" })).matches ?? []).toEqual([]);
    // Each owner's device status (coverage) is theirs; commands reach only their own Mac.
    const bobStatus = await mcp("bob", "sources_status", {});
    const im = bobStatus.providers.find((p: Any) => p.provider === "imessage");
    expect(im.coverage.length).toBeGreaterThan(0);
    expect(im.coverage.every((c: Any) => c.scope.startsWith(`owner:${seg("bob")}/`))).toBe(true);
    const bobBinding = macs.bob.agentToken.split(".")[1];
    expect((await yc_("POST", `/v1/sources/devices/imessage/${bobBinding}/commands`, "carol", { type: "messages_source_sync", coverageFrom: null })).status).toBe(403);
    const cmd = await yc_("POST", `/v1/sources/devices/imessage/${bobBinding}/commands`, "bob", { type: "messages_source_sync", coverageFrom: null });
    expect(cmd.status, await cmd.clone().text()).toBeLessThan(300);
    expect((await sql`SELECT tenant_id FROM imessage_device_commands WHERE binding_id = ${bobBinding}`).map((r: Any) => r.tenant_id)).toEqual([scopeOf("bob")]);
    // Revoking bob's Mac in yc_msaw revokes it in his scope; carol's keeps working.
    const bindings = ((await (await yc_("GET", "/v1/sources/bindings", "alice")).json()) as Any).bindings ?? [];
    expect(bindings.length).toBeGreaterThan(0);
    expect((await yc_("DELETE", `/v1/sources/bindings/${bobBinding}`, "bob")).status).toBe(200);
    expect((await sql`SELECT status FROM imessage_devices WHERE binding_id = ${bobBinding}`)[0].status).toBe("revoked");
    const after = await realFetch(`${macs.bob.apiUrl}/api/imessage/ingest`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": macs.bob.agentToken }, body: JSON.stringify({ messages: [imessage("G-AFTER", "after revoke", 2)] }) });
    expect(after.status).toBe(401);
    const carolMore = await realFetch(`${macs.carol.apiUrl}/api/imessage/ingest`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": macs.carol.agentToken }, body: JSON.stringify({ messages: [imessage("G-CAROL-2", "carol later needle-imsg-carol2", 2)] }) });
    expect(carolMore.status).toBe(200);
  }, 180_000);
});
