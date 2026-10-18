import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Provider callbacks and webhooks into personal owner scopes, end to end on real PostgreSQL, with the REAL runtime
 * (public callback/webhook routes, internal routes, task handlers, exporter) and the REAL yc_msaw (OIDC mock issuer;
 * alice is an admin, bob and carol are plain members of ONE organization). personal-scope-e2e-pg covers Granola by
 * API key and Zoom by OAuth; this file covers the transports it did not exercise:
 *
 * - Granola OAuth/MCP: connect -> PKCE authorize URL with a signed state bound to the caller's scope -> the runtime's
 *   /auth/granola/callback -> token + id_token account in that scope -> MCP backfill -> exported note readable only
 *   by its owner; later refresh keeps the scope and the account identity. Forged, tampered and replayed states fail.
 * - Cursor background agents: per-member connection, signed webhooks on the runtime route land in the URL's own
 *   connection scope; a colleague's secret, a tampered body, a replayed X-Webhook-ID and a revoked connection do not.
 * - Unipile WhatsApp: both members hold the SAME workspace API key; hosted-auth notify attaches only the account
 *   Unipile reports for that member's own link; provider webhooks (Unipile's flat message shape) need that
 *   connection's secret and account.
 * Provider APIs are local fakes at their real hosts (no network, no credentials); synthetic data; own throwaway DB.
 */
const PG = process.env.SOURCES_TEST_PG_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const YC_ROOT = path.resolve(here, "../../../../..");
const SERVICE_TOKEN = `svc_${randomBytes(24).toString("hex")}`;
const PUBLIC = "https://runtime.example.test";
const UNIPILE_BASE = "https://api1.unipile.com:13111/api/v1";
const UNIPILE_KEY = "unipile-workspace-key-shared-by-both"; // one workspace key reaches every linked account
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
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const b64u = (s: string) => Buffer.from(s).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify(claims))}.`;

// ------------------------------------------------------------------ Granola OAuth server + MCP (mcp-auth.granola.ai, mcp.granola.ai)
const granola = {
  registrations: [] as Array<Record<string, unknown>>,
  /** code -> who + PKCE challenge, single use (set from the authorize URL the member's browser would open). */
  codes: new Map<string, { who: string; challenge: string; redirectUri: string }>(),
  tokenBodies: [] as URLSearchParams[],
  /** valid access token -> owner; refresh token -> owner + generation. */
  access: new Map<string, string>(),
  refresh: new Map<string, { who: string; gen: number }>(),
  notes: {} as Record<string, Array<Record<string, unknown>>>,
  mcpBearers: [] as string[],
};
function grantFor(who: string, gen: number, withIdToken: boolean): Record<string, unknown> {
  const at = `gat-${who}-${gen}`;
  const rt = `grt-${who}-${gen}`;
  granola.access.set(at, who);
  granola.refresh.set(rt, { who, gen });
  return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: "Bearer", scope: "openid profile email offline_access",
    ...(withIdToken ? { id_token: idToken({ sub: `granola-sub-${who}`, email: `${who}@acme.test` }) } : {}) };
}
function mcpNote(id: string, at: string, who: string): Record<string, unknown> {
  return {
    id, title: `${who} sync ${id}`, owner_name: who, owner_email: `${who}@acme.test`, created_at: at, updated_at: at,
    summary: `notes of ${who} needle-goauth-${who}-${id}`,
    attendees: [{ name: "Ada", email: "ada@acme.test" }],
    transcript: [
      { id: `${id}-s1`, speaker: { source: "microphone", name: who }, text: `opening needle-gtx-${who}`, start_time: "00:00:01", end_time: "00:00:03", confidence: 0.93 },
      { id: `${id}-s2`, speaker: { source: "speaker", diarization_label: "B" }, text: "reply", start_time: "00:00:04" },
    ],
    meeting_platform: "google_meet",
  };
}
function granolaFetch(url: URL, init: RequestInit): Response {
  if (url.href === "https://mcp-auth.granola.ai/oauth2/register") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    granola.registrations.push(body);
    return Response.json({ client_id: "granola-dyn-client-1", token_endpoint_auth_method: "none", redirect_uris: body.redirect_uris });
  }
  if (url.href === "https://mcp-auth.granola.ai/oauth2/token") {
    const body = new URLSearchParams(String(init.body));
    granola.tokenBodies.push(body);
    if (body.get("client_id") !== "granola-dyn-client-1" || body.get("resource") !== "https://mcp.granola.ai/mcp") return Response.json({ error: "invalid_client" }, { status: 401 });
    if (body.get("grant_type") === "authorization_code") {
      const code = granola.codes.get(body.get("code") ?? "");
      granola.codes.delete(body.get("code") ?? "");
      const verifier = body.get("code_verifier") ?? "";
      if (!code || createHash("sha256").update(verifier).digest("base64url") !== code.challenge || body.get("redirect_uri") !== code.redirectUri) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json(grantFor(code.who, 1, true));
    }
    if (body.get("grant_type") === "refresh_token") {
      const r = granola.refresh.get(body.get("refresh_token") ?? "");
      if (!r) return Response.json({ error: "invalid_grant" }, { status: 400 });
      granola.refresh.delete(body.get("refresh_token")!);
      for (const [at, w] of granola.access) if (w === r.who) granola.access.delete(at); // the old access token stops working
      return Response.json(grantFor(r.who, r.gen + 1, false)); // Granola need not resend an id_token on refresh
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  // MCP (JSON-RPC over streamable HTTP), the tool shapes the donor selector accepts.
  const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  granola.mcpBearers.push(bearer);
  const who = granola.access.get(bearer);
  if (!who) return new Response("unauthorized", { status: 401 });
  const rpc = JSON.parse(String(init.body ?? "{}")) as { id?: string; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers: { "mcp-session-id": `sess-${who}` } });
  if (rpc.method === "initialize") return ok({ protocolVersion: "2025-06-18", capabilities: {} });
  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (rpc.method === "tools/list") return ok({ tools: [{ name: "list_notes", inputSchema: { properties: { cursor: {}, updated_after: {}, page_size: {} } } }, { name: "get_note", inputSchema: { properties: { note_id: {} } } }] });
  const notes = granola.notes[who] ?? [];
  if (rpc.method === "tools/call" && rpc.params?.name === "list_notes") {
    const after = rpc.params.arguments?.updated_after as string | undefined;
    const list = notes.filter((n) => !after || String(n.updated_at) > after).map((n) => ({ id: n.id, title: n.title, created_at: n.created_at, updated_at: n.updated_at }));
    return ok({ structuredContent: { notes: list, hasMore: false, cursor: null } });
  }
  if (rpc.method === "tools/call" && rpc.params?.name === "get_note") return ok({ structuredContent: notes.find((n) => n.id === rpc.params!.arguments?.note_id) ?? null });
  return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { message: "unknown" } });
}

// ------------------------------------------------------------------ Cursor API (api.cursor.com), per API key
const cursor = {
  keys: { "cur_key_bob_0001": "bob", "cur_key_carol_001": "carol" } as Record<string, string>,
  agents: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ who: string; path: string; method: string }>,
};
function cursorAgent(who: string, id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `${who} agent ${id}`, status, source: { repository: "github.com/acme/app", ref: "main" }, target: { url: `https://cursor.com/agents?id=${id}`, branchName: `cursor/${id}`, autoCreatePr: true }, createdAt: "2026-10-10T10:00:00Z", summary: `${who} work needle-cursor-${who}`, ...extra };
}
function cursorFetch(url: URL, init: RequestInit): Response {
  const who = cursor.keys[new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""];
  cursor.calls.push({ who: who ?? "?", path: url.pathname, method: (init.method ?? "GET").toUpperCase() });
  if ((init.method ?? "GET").toUpperCase() !== "GET") return Response.json({ error: "read-only lane" }, { status: 405 });
  if (!who) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (url.pathname === "/v0/agents") return Response.json({ agents: cursor.agents[who] ?? [] });
  const m = /^\/v0\/agents\/([^/]+)\/conversation$/.exec(url.pathname);
  if (m) return Response.json({ id: m[1], messages: [{ id: `${m[1]}-u`, type: "user_message", text: `${who} asks needle-cconv-${who}` }, { id: `${m[1]}-a`, type: "assistant_message", text: "done", toolCalls: [{ name: "edit_file", path: "src/a.ts" }] }] });
  return Response.json({}, { status: 404 });
}

// ------------------------------------------------------------------ Unipile (api1.unipile.com), ONE workspace key, accounts per member
const unipile = {
  links: [] as Array<Record<string, unknown>>,
  accounts: {
    acc_bob_wa: { object: "Account", id: "acc_bob_wa", type: "WHATSAPP", name: "Bob WA", connection_params: { im: { phone_number: "+15550000001" } }, sources: [{ id: "acc_bob_wa_MESSAGING", status: "OK" }] },
    acc_carol_wa: { object: "Account", id: "acc_carol_wa", type: "WHATSAPP", name: "Carol WA", connection_params: { im: { phone_number: "+15550000002" } }, sources: [{ id: "acc_carol_wa_MESSAGING", status: "OK" }] },
  } as Record<string, Record<string, unknown>>,
  chats: { acc_bob_wa: [{ id: "chat-bob-1", name: "Bob & Ada", account_id: "acc_bob_wa" }], acc_carol_wa: [{ id: "chat-carol-1", name: "Carol & Ada", account_id: "acc_carol_wa" }] } as Record<string, Array<Record<string, unknown>>>,
  messages: {} as Record<string, Array<Record<string, unknown>>>,
};
function unipileFetch(url: URL, init: RequestInit): Response {
  if (new Headers(init.headers).get("x-api-key") !== UNIPILE_KEY) return Response.json({ title: "Unauthorized" }, { status: 401 });
  const p = url.pathname.replace(/^\/api\/v1/, "");
  if ((init.method ?? "GET").toUpperCase() === "POST") {
    if (p !== "/hosted/accounts/link") return Response.json({ title: "read-only lane" }, { status: 405 });
    unipile.links.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Response.json({ object: "HostedAuthURL", url: `https://account.unipile.com/hosted-${unipile.links.length}` }, { status: 201 });
  }
  let m = /^\/accounts\/([^/]+)$/.exec(p);
  if (m) return unipile.accounts[m[1]!] ? Response.json(unipile.accounts[m[1]!]) : Response.json({ title: "Not found" }, { status: 404 });
  if (p === "/chats") return Response.json({ object: "ChatList", items: unipile.chats[url.searchParams.get("account_id") ?? ""] ?? [], cursor: null });
  m = /^\/chats\/([^/]+)\/messages$/.exec(p);
  if (m) return Response.json({ object: "MessageList", items: unipile.messages[m[1]!] ?? [], cursor: null });
  return Response.json({ title: "Not found" }, { status: 404 });
}

/** Provider endpoints only; yc_msaw and the runtime are real HTTP on loopback. */
async function fakeProviders(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "mcp-auth.granola.ai" || url.hostname === "mcp.granola.ai") return granolaFetch(url, init);
  if (url.hostname === "api.cursor.com") return cursorFetch(url, init);
  if (url.hostname.endsWith(".unipile.com")) return unipileFetch(url, init);
  if (/(^|\.)(granola\.ai|cursor\.com|unipile\.com)$/.test(url.hostname)) return new Response("not found", { status: 404 });
  return realFetch(input, init);
}

async function mcp(who: string, name: string, args: Record<string, unknown>): Promise<Any> {
  let c = clients.get(who);
  if (!c) {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client" as string);
    c = new Client({ name: `ftq-${who}`, version: "1" });
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
/** A provider's delivery to a public URL the runtime handed out: same path, on this test's runtime listener. */
const deliver = (publicUrl: string, init: RequestInit) => {
  const u = new URL(publicUrl);
  expect(u.origin).toBe(PUBLIC);
  return realFetch(`${runtimeBase}${u.pathname}${u.search}`, init);
};

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
  expect(await sql`SELECT tenant_id, row_key, last_error FROM source_lane_journal WHERE dead_lettered_at IS NOT NULL LIMIT 3`).toEqual([]);
  expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal`)[0].n).toBe(0);
}
const grepText = async (who: string, dir: string, pattern: string) => JSON.stringify(await mcp(who, "grep", { path: dir, pattern }));
/** Matched paths only (the grep answer echoes its pattern, so absence is asserted on matches). */
const hits = async (who: string, dir: string, pattern: string): Promise<string[]> => ((await mcp(who, "grep", { path: dir, pattern })).matches ?? []).map((m: Any) => m.path as string);
const seg = (who: string) => mods.scope.personalSegment({ tenantNs, issuer: issuer.issuer, subject: `user_${who}` }) as string;
const scopeOf = (who: string) => mods.scope.scopeTenantIdOf(tenantNs, seg(who)) as string;

describe.skipIf(!PG)("provider callbacks and webhooks into owner scopes: real runtime + real yc_msaw + real PostgreSQL", () => {
  beforeAll(async () => {
    const { startMockIssuer } = await importYc("src/auth/testing/mock-issuer.ts");
    issuer = await startMockIssuer();
    tenantNs = (await importYc("src/auth/tenant.ts")).tenantNsFor(issuer.issuer, { organizationId: "org_acme", subject: "x" });
    const postgres = (await import("postgres")).default;
    dbName = `ftq_e2e_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    // Granola's donor redirect comes from WEBHOOK_BASE_URL (or GRANOLA_REDIRECT_URI); the others from SOURCES_RUNTIME_PUBLIC_URL.
    Object.assign(process.env, { DATABASE_URL: url.href, SOURCES_RUNTIME_PUBLIC_URL: PUBLIC, WEBHOOK_BASE_URL: PUBLIC, UNIPILE_PERSONAL_CONNECTORS_ENABLED: "1" });
    delete process.env.GRANOLA_CLIENT_ID; // exercise Granola's dynamic client registration (the donor default)
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../src/db/client.js");
    mods.queue = await import("../../../src/queue/queue.js");
    mods.exporter = await import("../../../src/source-lane/export/exporter.js");
    mods.registry = await import("../../../src/source-lane/registry.js");
    mods.internal = await import("../../../src/source-lane/internal/app.js");
    mods.worker = await import("../../../src/source-lane/worker.js");
    mods.scope = await import("../../../src/source-lane/core/personal-scope.js");
    mods.vault = await import("../../../src/vault/tokens.js");
    globalThis.fetch = fakeProviders as typeof fetch;

    const registry = mods.registry.defaultRegistry();
    handlers = mods.worker.sourceLaneTaskHandlers(registry);
    mods.exp = new mods.exporter.SourceExporter({ db: mods.db.db, registry, log: () => {} });
    const runtimeApp = mods.internal.createRuntimeApp({ db: mods.db.db, registry, exporter: mods.exp, serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"), mountInternal: true });
    const { serve } = await import("@hono/node-server");
    runtimeServer = serve({ fetch: runtimeApp.fetch, port: 0, hostname: "127.0.0.1", overrideGlobalObjects: false });
    await new Promise((r) => setTimeout(r, 50));
    runtimeBase = `http://127.0.0.1:${(runtimeServer.address() as { port: number }).port}`;
    const reservation = createServer();
    await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
    const ycPort = (reservation.address() as { port: number }).port;
    await new Promise<void>((r) => reservation.close(() => r()));
    const resource = `http://127.0.0.1:${ycPort}/mcp`;
    ycDir = await mkdtemp(path.join(os.tmpdir(), "ftq-e2e-yc-"));
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
    expect((await yc_("POST", "/v1/sources/runtime/provision", "alice", {})).status).toBe(201);
    await drainTasks();
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

  it("Granola OAuth/MCP: each member's signed state, callback, token, refresh and notes stay in that member's own scope", async () => {
    granola.notes.bob = [mcpNote("gn-bob-1", ago(3), "bob")];
    granola.notes.carol = [mcpNote("gn-carol-1", ago(2), "carol")];
    const states: Record<string, string> = {};
    for (const who of ["bob", "carol"]) {
      const r = await yc_("POST", "/v1/sources/connect/granola", who, { mode: "oauth" });
      expect(r.status, await r.clone().text()).toBe(200);
      const authorize = new URL(((await r.json()) as Any).authorizeUrl);
      expect(authorize.origin + authorize.pathname).toBe("https://mcp-auth.granola.ai/oauth2/authorize");
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        response_type: "code", client_id: "granola-dyn-client-1", redirect_uri: `${PUBLIC}/auth/granola/callback`,
        code_challenge_method: "S256", resource: "https://mcp.granola.ai/mcp", scope: "openid profile email offline_access",
      });
      states[who] = authorize.searchParams.get("state")!;
      // The member signs in at Granola, which redirects the browser back with a code bound to this PKCE challenge.
      granola.codes.set(`gcode-${who}`, { who, challenge: authorize.searchParams.get("code_challenge")!, redirectUri: authorize.searchParams.get("redirect_uri")! });
    }
    // Dynamic registration ran once (cached per redirect URI), with the runtime's own callback.
    expect(granola.registrations.map((r) => r.redirect_uris)).toEqual([[`${PUBLIC}/auth/granola/callback`]]);
    // The pending state rows name each caller's own scope tenant (server-side; the state string carries only a nonce).
    const pending = await sql`SELECT metadata FROM integration_tokens WHERE provider = 'granola_oauth_state'`;
    expect(pending.map((r: Any) => r.metadata.userId).sort()).toEqual([scopeOf("bob"), scopeOf("carol")].sort());
    for (const s of Object.values(states)) expect(JSON.parse(Buffer.from(s.split(".")[1]!, "base64url").toString())).not.toHaveProperty("userId");

    // Forged states: a re-signed payload without the server key, a swapped signature, a missing state. Nothing is stored.
    const [v, payload, sig] = states.bob!.split(".");
    const forgedPayload = b64u(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), nonce: "attacker-nonce" }));
    const forged = [
      `${v}.${forgedPayload}.${createHmac("sha256", "not-the-server-key").update(`${v}.${forgedPayload}`).digest("base64url")}`,
      `${v}.${payload}.${states.carol!.split(".")[2]}`,
      `${v}.${payload}.${sig}.extra`,
    ];
    for (const s of forged) {
      const cb = await deliver(`${PUBLIC}/auth/granola/callback?code=gcode-bob&state=${encodeURIComponent(s)}`, {});
      expect(cb.status).toBe(500);
    }
    expect((await deliver(`${PUBLIC}/auth/granola/callback?code=gcode-bob`, {})).status).toBe(400);
    expect((await deliver(`${PUBLIC}/auth/granola/callback?error=access_denied&state=${encodeURIComponent(states.bob!)}`, {})).status).toBe(400);
    expect((await sql`SELECT count(*)::int AS n FROM integration_tokens WHERE provider = 'granola'`)[0].n).toBe(0);
    expect(granola.tokenBodies).toHaveLength(0); // refused before contacting Granola

    for (const who of ["bob", "carol"]) {
      const cb = await deliver(`${PUBLIC}/auth/granola/callback?code=gcode-${who}&state=${encodeURIComponent(states[who]!)}`, {});
      expect(cb.status, await cb.clone().text()).toBe(200);
    }
    // Replay: the state is single use, even with a fresh valid code; bob's grant is unchanged.
    granola.codes.set("gcode-bob-again", { who: "carol", challenge: "x", redirectUri: `${PUBLIC}/auth/granola/callback` });
    expect((await deliver(`${PUBLIC}/auth/granola/callback?code=gcode-bob-again&state=${encodeURIComponent(states.bob!)}`, {})).status).toBe(500);
    expect((await sql`SELECT count(*)::int AS n FROM integration_tokens WHERE provider = 'granola_oauth_state'`)[0].n).toBe(0);

    const stored = Object.fromEntries(await Promise.all(["bob", "carol"].map(async (who) => [who, await mods.vault.getTokenFull(scopeOf(who), "granola")])));
    for (const who of ["bob", "carol"]) {
      expect(stored[who]).toMatchObject({ token: `gat-${who}-1`, refreshToken: `grt-${who}-1` });
      expect(stored[who].metadata).toMatchObject({ auth_mode: "oauth_mcp", client_id: "granola-dyn-client-1", account_subject: `granola-sub-${who}`, account_email: `${who}@acme.test` });
      expect(JSON.stringify(stored[who].metadata)).not.toContain("grt-"); // refresh token is not in plaintext metadata
    }
    expect((await sql`SELECT user_id FROM integration_tokens WHERE provider = 'granola' ORDER BY user_id`).map((r: Any) => r.user_id)).toEqual([scopeOf("bob"), scopeOf("carol")].sort());
    expect((await sql`SELECT tenant_id, status, metadata FROM connections WHERE provider = 'granola' ORDER BY tenant_id`).map((r: Any) => `${r.tenant_id}:${r.status}:${r.metadata.authMode}`)).toEqual(
      [`${scopeOf("bob")}:active:oauth_mcp`, `${scopeOf("carol")}:active:oauth_mcp`].sort(),
    );
    // The PKCE verifier from the state row reached Granola (the fake checks sha256(verifier) == challenge).
    expect(granola.tokenBodies.filter((b) => b.get("grant_type") === "authorization_code").map((b) => b.get("code"))).toEqual(["gcode-bob", "gcode-carol"]);

    const ran = await drainTasks();
    expect(ran).toEqual(expect.arrayContaining([`granola.backfill@${scopeOf("bob")}`, `granola.backfill@${scopeOf("carol")}`]));
    // Per-account rate-limit identity: the OAuth subject, distinct per member.
    const st = await sql`SELECT tenant_id, auth_mode, account_label, quota_key FROM granola_source_state ORDER BY tenant_id`;
    expect(st.map((r: Any) => [r.tenant_id, r.auth_mode, r.account_label])).toEqual([[scopeOf("bob"), "oauth_mcp", "bob@acme.test"], [scopeOf("carol"), "oauth_mcp", "carol@acme.test"]].sort());
    expect(new Set(st.map((r: Any) => r.quota_key)).size).toBe(2);
    const raws = await sql`SELECT user_id, source_object_id, raw_payload FROM activity_events WHERE source = 'granola' ORDER BY user_id`;
    expect(raws.map((r: Any) => [r.user_id, r.source_object_id])).toEqual([[scopeOf("bob"), "meeting_note:gn-bob-1"], [scopeOf("carol"), "meeting_note:gn-carol-1"]].sort());

    await exportAll();
    expect(await mods.exp.reportStatus(tenantNs)).toBe(true);
    const bobText = await grepText("bob", "$SOURCES/granola", "needle-g[a-z]+-[a-z]+");
    expect(bobText).toContain("needle-goauth-bob");
    expect(bobText).toContain("needle-gtx-bob");
    expect(bobText).not.toContain("carol");
    expect(await hits("carol", "$SOURCES", "needle-g[a-z]+-bob")).toEqual([]);
    expect(((await mcp("alice", "grep", { path: "$SOURCES", pattern: "needle-g[a-z]+-" })).matches ?? [])).toEqual([]);
    // Rich capture: the published transcript keeps every segment field the MCP returned; the raw keeps the MCP source tag.
    const files = (await mcp("bob", "find", { path: "$SOURCES/granola", pattern: "**/transcript.json" })).matches as string[];
    expect(files).toHaveLength(1);
    expect(files[0]!.startsWith(`$SOURCES/granola/${seg("bob")}/`)).toBe(true);
    const transcript = (await mcp("bob", "read", { path: files[0]! })).content as string;
    const segments = JSON.parse(transcript).segments;
    expect(segments[0]).toMatchObject({ id: "gn-bob-1-s1", text: "opening needle-gtx-bob", confidence: 0.93, start_time: "00:00:01", end_time: "00:00:03", speaker: { source: "microphone", name: "bob" } });
    expect(segments[1]).toMatchObject({ id: "gn-bob-1-s2", speaker: { source: "speaker", diarization_label: "B" } });
    expect((await mcp("carol", "read", { path: files[0]! })).code).toBe("not_found");
    expect((await mcp("carol", "sources_history", { path: files[0]! })).versions).toEqual([]);
    const note = JSON.parse((await mcp("bob", "read", { path: files[0]!.replace(/transcript\.json$/, "note.json") })).content);
    expect(note.current.raw.startsWith(`sources/granola/${seg("bob")}/_raw/`)).toBe(true);
    const rawPublished = JSON.parse((await mcp("bob", "read", { path: `$SOURCES/${note.current.raw.slice(8)}` })).content);
    expect(JSON.stringify(rawPublished)).toContain("granola_oauth_mcp");
    expect(JSON.stringify(rawPublished)).toContain("google_meet");

    // Refresh: bob's access token expires. The poll refreshes with bob's own refresh token and the registered client,
    // stores the rotated grant in bob's scope, keeps the id_token account (Granola sent none on refresh), and the
    // new note is captured for bob only. Carol's grant is untouched.
    await sql`UPDATE integration_tokens SET metadata = jsonb_set(metadata, '{expires_at}', to_jsonb(${Date.now() - 1000}::bigint)) WHERE user_id = ${scopeOf("bob")} AND provider = 'granola'`;
    granola.notes.bob!.push(mcpNote("gn-bob-2", new Date().toISOString(), "bob"));
    const bearersBefore = granola.mcpBearers.length;
    await handlers["granola.poll"]({ tenantId: scopeOf("bob") }, { task: { id: randomBytes(8).toString("hex"), tenantId: scopeOf("bob"), queue: "sync", kind: "granola.poll", payload: {} }, heartbeat: async () => {} });
    const refreshes = granola.tokenBodies.filter((b) => b.get("grant_type") === "refresh_token");
    expect(refreshes.map((b) => [b.get("refresh_token"), b.get("client_id"), b.get("resource")])).toEqual([["grt-bob-1", "granola-dyn-client-1", "https://mcp.granola.ai/mcp"]]);
    expect(new Set(granola.mcpBearers.slice(bearersBefore))).toEqual(new Set(["gat-bob-2"])); // never carol's, never the stale one
    const bobAfter = await mods.vault.getTokenFull(scopeOf("bob"), "granola");
    expect(bobAfter).toMatchObject({ token: "gat-bob-2", refreshToken: "grt-bob-2" });
    expect(bobAfter.metadata).toMatchObject({ account_subject: "granola-sub-bob", account_email: "bob@acme.test", client_id: "granola-dyn-client-1" });
    expect(bobAfter.metadata.expires_at).toBeGreaterThan(Date.now());
    expect(await mods.vault.getTokenFull(scopeOf("carol"), "granola")).toMatchObject({ token: "gat-carol-1", refreshToken: "grt-carol-1" });
    expect((await sql`SELECT quota_key FROM granola_source_state WHERE tenant_id = ${scopeOf("bob")}`)[0].quota_key).toBe(st.find((r: Any) => r.tenant_id === scopeOf("bob")).quota_key);
    await drainTasks();
    await exportAll();
    expect(await grepText("bob", "$SOURCES/granola", "needle-goauth-bob-gn-bob-2")).toContain(`granola/${seg("bob")}/`);
    expect(await hits("carol", "$SOURCES", "needle-goauth-bob-gn-bob-2")).toEqual([]);
    expect((await sql`SELECT user_id FROM activity_events WHERE source_object_id = 'meeting_note:gn-bob-2'`).map((r: Any) => r.user_id)).toEqual([scopeOf("bob")]);
  }, 180_000);

  it("Cursor: signed webhooks reach only the URL's own connection scope; forged, tampered, replayed and revoked deliveries do not", async () => {
    cursor.agents.bob = [cursorAgent("bob", "bc_shared", "RUNNING"), cursorAgent("bob", "bc_bob", "RUNNING")];
    cursor.agents.carol = [cursorAgent("carol", "bc_shared", "RUNNING")]; // the same agent id seen by both accounts
    const hooks: Record<string, { url: string; secret: string; id: string }> = {};
    for (const [who, key] of [["bob", "cur_key_bob_0001"], ["carol", "cur_key_carol_001"]] as const) {
      const r = await yc_("POST", "/v1/sources/connect/cursor_background_agents", who, { apiKey: key });
      expect(r.status, await r.clone().text()).toBe(201);
      const b = (await r.json()) as Any;
      hooks[who] = { url: b.webhook.url, secret: b.webhook.secret, id: b.connection.id };
      expect(b.connection.tenantId).toBe(scopeOf(who));
    }
    // A caller-supplied tenant is not a connect field; the scope came from the verified principal.
    expect((await yc_("POST", "/v1/sources/connect/cursor_background_agents", "carol", { apiKey: "cur_key_bob_0001", tenantId: scopeOf("bob") })).status).toBe(400);
    expect((await sql`SELECT id, tenant_id FROM cursor_agents_connections ORDER BY tenant_id`).map((r: Any) => r.tenant_id)).toEqual([scopeOf("bob"), scopeOf("carol")].sort());
    await drainTasks();
    await exportAll(); // the RUNNING state is published before the webhook announces the change
    expect(cursor.calls.every((c) => c.method === "GET")).toBe(true);
    expect((await sql`SELECT tenant_id FROM cursor_agents_snapshots WHERE agent_id = 'bc_shared' ORDER BY tenant_id`).map((r: Any) => r.tenant_id)).toEqual([scopeOf("bob"), scopeOf("carol")].sort());

    // Cursor's documented delivery: X-Webhook-Signature sha256=HMAC(secret, raw body), X-Webhook-ID, X-Webhook-Event.
    const body = JSON.stringify({ event: "statusChange", timestamp: "2026-10-18T10:00:00Z", id: "bc_bob", status: "FINISHED", source: { repository: "github.com/acme/app", ref: "main" }, target: { url: "https://cursor.com/agents?id=bc_bob", branchName: "cursor/bc_bob", prUrl: "https://github.com/acme/app/pull/77" }, summary: "bob finished needle-cwh-bob" });
    const sign = (secret: string, raw = body) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const send = (url: string, sig: string | null, raw = body, id = "wh-bob-1") => deliver(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Cursor-Agent-Webhook/1.0", "x-webhook-id": id, "x-webhook-event": "statusChange", ...(sig ? { "x-webhook-signature": sig } : {}) }, body: raw });
    const cursorRaws = async () => (await sql`SELECT user_id, source_event_id FROM activity_events WHERE source = 'cursor_background_agents' AND event_type = 'background_agent_webhook' ORDER BY source_event_id`).map((r: Any) => `${r.user_id}:${r.source_event_id}`);
    expect((await send(hooks.bob!.url, sign(hooks.carol!.secret))).status).toBe(401); // a colleague's secret
    expect((await send(hooks.carol!.url, sign(hooks.bob!.secret))).status).toBe(401); // bob's signature, carol's URL
    expect((await send(hooks.bob!.url, sign(hooks.bob!.secret), body.replace("pull/77", "pull/78"))).status).toBe(401); // tampered body
    expect((await send(hooks.bob!.url, null)).status).toBe(401);
    expect((await send(`${PUBLIC}/webhooks/cursor-agents/ca_${"0".repeat(24)}`, sign(hooks.bob!.secret))).status).toBe(401);
    expect(await cursorRaws()).toEqual([]);
    const ok = await send(hooks.bob!.url, sign(hooks.bob!.secret));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ received: true, duplicate: false, webhookEvent: "statusChange" });
    expect(await (await send(hooks.bob!.url, sign(hooks.bob!.secret))).json()).toMatchObject({ received: true, duplicate: true }); // replay
    expect(await cursorRaws()).toEqual([`${scopeOf("bob")}:cursor_background_agents:webhook:wh-bob-1`]);
    const [whRaw] = await sql`SELECT raw_payload FROM activity_events WHERE source_event_id = 'cursor_background_agents:webhook:wh-bob-1'`;
    expect(whRaw.raw_payload.rawBody).toBe(body); // exact delivery bytes kept
    // The delivery queued a sync in bob's scope only; it picks up the provider state the webhook announced.
    expect((await sql`SELECT tenant_id FROM task_queue WHERE kind = 'cursor_agents.sync' AND dedupe_key LIKE '%:webhook' AND state = 'queued'`).map((r: Any) => r.tenant_id)).toEqual([scopeOf("bob")]);
    cursor.agents.bob![1] = cursorAgent("bob", "bc_bob", "FINISHED", { target: { url: "https://cursor.com/agents?id=bc_bob", branchName: "cursor/bc_bob", prUrl: "https://github.com/acme/app/pull/77" } });
    const ran = await drainTasks();
    expect(ran).toEqual([`cursor_agents.sync@${scopeOf("bob")}`]);
    await exportAll();

    const agentPath = `$SOURCES/cursor-agents/${seg("bob")}/${hooks.bob!.id}/bc_bob/agent.json`;
    const agent = JSON.parse((await mcp("bob", "read", { path: agentPath })).content);
    expect(agent).toMatchObject({ id: "bc_bob", status: "FINISHED", target: { prUrl: "https://github.com/acme/app/pull/77" } });
    expect((await mcp("bob", "sources_history", { path: agentPath })).versions.length).toBe(2); // RUNNING then FINISHED
    const conv = JSON.parse((await mcp("bob", "read", { path: agentPath.replace(/agent\.json$/, "conversation.json") })).content);
    expect(conv.messages[1].toolCalls).toEqual([{ name: "edit_file", path: "src/a.ts" }]);
    const bobText = await grepText("bob", "$SOURCES/cursor-agents", "needle-c[a-z]+-[a-z]+");
    expect(bobText).toContain("needle-cwh-bob"); // the raw webhook delivery is published under bob's segment
    expect(bobText).toContain("needle-cconv-bob");
    expect(bobText).not.toContain("carol");
    expect((await mcp("carol", "read", { path: agentPath })).code).toBe("not_found");
    expect(await hits("carol", "$SOURCES", "needle-c[a-z]+-bob")).toEqual([]);
    expect(await grepText("carol", "$SOURCES/cursor-agents", "needle-cursor-carol")).toContain(`cursor-agents/${seg("carol")}/`);
    expect(((await mcp("alice", "grep", { path: "$SOURCES", pattern: "needle-c[a-z]+-" })).matches ?? [])).toEqual([]);

    // Revocation: bob disconnects his own; his URL stops accepting even correctly signed deliveries, carol's still works.
    expect((await yc_("DELETE", "/v1/sources/connections/cursor_background_agents", "bob")).status).toBe(200);
    expect((await send(hooks.bob!.url, sign(hooks.bob!.secret), body, "wh-bob-2")).status).toBe(401);
    const carolBody = JSON.stringify({ event: "statusChange", timestamp: "2026-10-18T11:00:00Z", id: "bc_shared", status: "FINISHED" });
    expect((await send(hooks.carol!.url, sign(hooks.carol!.secret, carolBody), carolBody, "wh-carol-1")).status).toBe(200);
    expect(await cursorRaws()).toEqual([`${scopeOf("bob")}:cursor_background_agents:webhook:wh-bob-1`, `${scopeOf("carol")}:cursor_background_agents:webhook:wh-carol-1`]);
    expect((await sql`SELECT tenant_id, status FROM cursor_agents_connections ORDER BY tenant_id`).map((r: Any) => `${r.tenant_id}:${r.status}`)).toEqual([`${scopeOf("bob")}:revoked`, `${scopeOf("carol")}:active`].sort());
  }, 180_000);

  it("Unipile WhatsApp: one workspace key, but hosted-auth notify and provider webhooks bind only each member's own account", async () => {
    // A workspace key plus a colleague's account id is refused through the real yc_msaw -> runtime relay.
    const direct = await yc_("POST", "/v1/sources/connect/whatsapp_personal", "carol", { apiKey: UNIPILE_KEY, apiBase: UNIPILE_BASE, accountId: "acc_bob_wa" });
    expect(direct.status).toBe(400);
    expect(await direct.json()).toMatchObject({ error: { code: "hosted_auth_required" } });
    const start = async (who: string) => {
      const r = await yc_("POST", "/v1/sources/connect/whatsapp_personal", who, { apiKey: UNIPILE_KEY, apiBase: UNIPILE_BASE });
      expect(r.status, await r.clone().text()).toBe(201);
      const b = (await r.json()) as Any;
      const req = unipile.links.at(-1)!;
      expect(req).toMatchObject({ type: "create", providers: ["WHATSAPP"], api_url: "https://api1.unipile.com:13111", notify_url: `${PUBLIC}/webhooks/whatsapp-personal/hosted/${b.link.id}` });
      expect(String(req.name)).not.toContain(b.link.id);
      return { linkId: b.link.id as string, notifyUrl: String(req.notify_url), name: String(req.name), hook: b.webhook as { url: string; header: string; secret: string } };
    };
    const notify = (l: { notifyUrl: string }, payload: Record<string, unknown>) => deliver(l.notifyUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const bob = await start("bob");
    let carol = await start("carol");
    expect((await sql`SELECT tenant_id FROM unipile_personal_hosted_links ORDER BY tenant_id`).map((r: Any) => r.tenant_id)).toEqual([scopeOf("bob"), scopeOf("carol")].sort());

    // Forged notifies: no name, carol's name on bob's link, bob's name on the wrong lane. Nothing attaches.
    expect((await notify(bob, { status: "CREATION_SUCCESS", account_id: "acc_bob_wa" })).status).toBe(401);
    expect((await notify(bob, { status: "CREATION_SUCCESS", account_id: "acc_carol_wa", name: carol.name })).status).toBe(401);
    expect((await deliver(bob.notifyUrl.replace("/whatsapp-personal/", "/instagram-personal/"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "CREATION_SUCCESS", account_id: "acc_bob_wa", name: bob.name }) })).status).toBe(404);
    expect((await sql`SELECT count(*)::int AS n FROM whatsapp_personal_connections`)[0].n).toBe(0);
    // Unipile's real notify for bob's own link attaches the account Unipile reports, into bob's scope.
    expect(await (await notify(bob, { status: "CREATION_SUCCESS", account_id: "acc_bob_wa", name: bob.name })).json()).toMatchObject({ connected: true });
    expect((await notify(bob, { status: "CREATION_SUCCESS", account_id: "acc_bob_wa", name: bob.name })).status).toBe(409); // replay
    // Carol's own link naming bob's already-connected account cannot take it.
    expect(await (await notify(carol, { status: "CREATION_SUCCESS", account_id: "acc_bob_wa", name: carol.name })).json()).toMatchObject({ connected: false, failure: "account_connected_by_another_member" });
    carol = await start("carol");
    expect(await (await notify(carol, { status: "CREATION_SUCCESS", account_id: "acc_carol_wa", name: carol.name })).json()).toMatchObject({ connected: true });
    const conns = await sql`SELECT id, tenant_id, account_id FROM whatsapp_personal_connections ORDER BY tenant_id`;
    expect(conns.map((r: Any) => `${r.tenant_id}:${r.account_id}`)).toEqual([`${scopeOf("bob")}:acc_bob_wa`, `${scopeOf("carol")}:acc_carol_wa`].sort());
    // Link status is readable only by the member who started it.
    expect((await yc_("POST", "/v1/sources/connect/whatsapp_personal", "carol", { linkId: bob.linkId })).status).toBe(404);
    expect(await (await yc_("POST", "/v1/sources/connect/whatsapp_personal", "bob", { linkId: bob.linkId })).json()).toMatchObject({ link: { status: "connected" }, connection: { accountId: "acc_bob_wa" } });

    // Backfill through the runtime task handlers (Unipile's message objects, with fields the lane does not interpret).
    unipile.messages["chat-bob-1"] = [{ object: "Message", id: "m-bob-1", provider_id: "3EB0BOB1", chat_id: "chat-bob-1", account_id: "acc_bob_wa", text: "hi bob needle-wa-bob", sender_id: "+15550000009", sender_attendee_id: "att-ada", timestamp: "2026-10-17T09:00:00.000Z", is_sender: 0, quoted: { id: "m-bob-0", text: "earlier" }, reactions: [{ value: "👍", sender_id: "+15550000001" }], seen: 1, attachments: [] }];
    unipile.messages["chat-carol-1"] = [{ object: "Message", id: "m-carol-1", chat_id: "chat-carol-1", account_id: "acc_carol_wa", text: "hi carol needle-wa-carol", sender_id: "+15550000009", timestamp: "2026-10-17T09:30:00.000Z", attachments: [] }];
    const ran = await drainTasks();
    expect(ran).toEqual(expect.arrayContaining([`whatsapp_personal.sync@${scopeOf("bob")}`, `whatsapp_personal.sync@${scopeOf("carol")}`]));

    // Provider webhooks, Unipile's flat message_received shape, on each connection's own URL + secret header.
    const flat = (who: string, id: string, account: string) => ({
      account_id: account, account_type: "WHATSAPP", account_info: { type: "WHATSAPP", feature: "classic", user_id: `${who}-wa-user` }, event: "message_received",
      chat_id: `chat-${who}-1`, timestamp: "2026-10-18T08:00:00.000Z", webhook_name: "procmem", message_id: id, message: `webhook text needle-wawh-${who}`,
      sender: { attendee_id: "att-ada", attendee_name: "Ada", attendee_provider_id: "15550000009@s.whatsapp.net" }, attendees: [], attachments: [],
      provider_chat_id: `${who}@s.whatsapp.net`, provider_message_id: `3EB0${id}`, is_event: 0, is_group: false,
    });
    const hook = (url: string, secret: string, payload: unknown) => deliver(url, { method: "POST", headers: { "content-type": "application/json", "x-unipile-secret": secret }, body: JSON.stringify(payload) });
    expect(bob.hook.url).toBe(`${PUBLIC}/webhooks/whatsapp-personal/${conns.find((r: Any) => r.account_id === "acc_bob_wa").id}`);
    expect(bob.hook.header).toBe("x-unipile-secret");
    expect((await hook(bob.hook.url, carol.hook.secret, flat("bob", "w-bob-1", "acc_bob_wa"))).status).toBe(401); // a colleague's secret
    expect((await hook(carol.hook.url, bob.hook.secret, flat("carol", "w-carol-x", "acc_carol_wa"))).status).toBe(401);
    expect((await hook(bob.hook.url, bob.hook.secret, flat("carol", "w-carol-x", "acc_carol_wa"))).status).toBe(401); // carol's account on bob's URL
    expect(await (await hook(bob.hook.url, bob.hook.secret, flat("bob", "w-bob-1", "acc_bob_wa"))).json()).toEqual({ received: true, stored: true });
    expect(await (await hook(bob.hook.url, bob.hook.secret, flat("bob", "w-bob-1", "acc_bob_wa"))).json()).toEqual({ received: true, stored: false }); // replay
    expect(await (await hook(carol.hook.url, carol.hook.secret, flat("carol", "w-carol-1", "acc_carol_wa"))).json()).toEqual({ received: true, stored: true });
    const waRaw = await sql`SELECT user_id, source_event_id FROM activity_events WHERE source = 'whatsapp_personal' ORDER BY source_event_id`;
    expect(waRaw.map((r: Any) => `${r.user_id}:${r.source_event_id}`)).toEqual([
      `${scopeOf("bob")}:whatsapp_personal:chat-bob-1:m-bob-1`, `${scopeOf("bob")}:whatsapp_personal:chat-bob-1:w-bob-1`,
      `${scopeOf("carol")}:whatsapp_personal:chat-carol-1:m-carol-1`, `${scopeOf("carol")}:whatsapp_personal:chat-carol-1:w-carol-1`,
    ]);
    await exportAll();

    // Owner reads: polled message keeps Unipile's own fields; the webhook text is readable; nothing crosses owners.
    const polled = `$SOURCES/whatsapp-personal/${seg("bob")}/acc_bob_wa/chat-bob-1/2026-10/m-bob-1.json`;
    const m = JSON.parse((await mcp("bob", "read", { path: polled })).content);
    expect(m).toMatchObject({ id: "m-bob-1", provider_id: "3EB0BOB1", quoted: { id: "m-bob-0" }, reactions: [{ value: "👍" }], sender_attendee_id: "att-ada" });
    expect((await mcp("carol", "read", { path: polled })).code).toBe("not_found");
    expect((await mcp("alice", "read", { path: polled })).code).toBe("not_found");
    const bobText = await grepText("bob", "$SOURCES/whatsapp-personal", "needle-wa[a-z]*-[a-z]+");
    expect(bobText).toContain("needle-wa-bob");
    expect(bobText).toContain("needle-wawh-bob");
    expect(bobText).not.toContain("carol");
    const carolText = await grepText("carol", "$SOURCES", "needle-wa[a-z]*-[a-z]+");
    expect(carolText).toContain("needle-wawh-carol");
    expect(carolText).not.toContain("needle-wa-bob");
    expect(carolText).not.toContain("needle-wawh-bob");
    expect(((await mcp("alice", "grep", { path: "$SOURCES", pattern: "needle-wa" })).matches ?? [])).toEqual([]);
    const rs = (await (await yc_("GET", "/v1/sources/runtime/status", "bob")).json()) as Any;
    expect(rs.personal.segment).toBe(seg("bob"));
    expect(rs.personal.connections.map((c: Any) => `${c.provider}:${c.external_account_id ?? ""}`)).toContain("whatsapp_personal:acc_bob_wa");
    expect(JSON.stringify(rs)).not.toContain("acc_carol_wa");
    expect(JSON.stringify(rs)).not.toContain(seg("carol"));

    // Revocation: bob's disconnect closes his webhook URL; carol's keeps working.
    expect((await yc_("DELETE", "/v1/sources/connections/whatsapp_personal", "bob")).status).toBe(200);
    expect((await hook(bob.hook.url, bob.hook.secret, flat("bob", "w-bob-2", "acc_bob_wa"))).status).toBe(401);
    expect(await (await hook(carol.hook.url, carol.hook.secret, flat("carol", "w-carol-2", "acc_carol_wa"))).json()).toEqual({ received: true, stored: true });
  }, 180_000);
});

function importYc(rel: string): Promise<Any> {
  return import(pathToFileURL(path.join(YC_ROOT, rel)).href);
}
