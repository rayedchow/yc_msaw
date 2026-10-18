import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Source runtime against a real PostgreSQL (no pgvector) and the real yc_msaw
 * server: source-only migrations, graph refusal, journal triggers, a signed
 * Nango webhook through the donor route, the donor Nango record task against a
 * local fake Nango API, donor Confluence processors/materializer, the exporter,
 * and reads through yc_msaw's MCP filesystem with a real MCP client.
 *
 * Needs SOURCES_TEST_PG_URL (a superuser URL on a synthetic fixture cluster);
 * each run creates and drops its own database.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const YC_ROOT = path.resolve(here, "../../../../..");
const SERVICE_TOKEN = `svc_${randomBytes(24).toString("hex")}`;
const WEBHOOK_SECRET = "nango-webhook-secret-for-tests";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let dbName: string;
let adminSql: Any;
let sql: Any;
let mods: Record<string, Any> = {};
let yc: Any;
let ycDir: string;
let ycBase: string;
let ycMcp: string;
let keys: { admin: string; reader: string; rival: string };
let fakeNango: Server;
let nangoBase: string;
let nangoPages: Record<string, unknown[]> = {};
let runtimeApp: Any;
let runtimeServer: Any;
let mcpClients: Any[] = [];

async function importYc(rel: string): Promise<Any> {
  return import(pathToFileURL(path.join(YC_ROOT, rel)).href);
}

async function mcp(token: string): Promise<Any> {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client" as string);
  const c = new Client({ name: "runtime-pg", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(ycMcp), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  mcpClients.push(c);
  return c;
}

async function call(client: Any, name: string, args: Record<string, unknown>): Promise<Any> {
  const r = await client.callTool({ name, arguments: args });
  return { ...JSON.parse(r.content[0].text), isError: r.isError === true };
}

function internal(method: string, route: string, body?: unknown, opts: { token?: string | null; tenant?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? SERVICE_TOKEN}`;
  headers["x-procmem-principal"] = JSON.stringify({ tenantNs: opts.tenant ?? "acme", subject: "static:admin", issuer: "urn:procmem:static" });
  return runtimeApp.request(`/internal/v1${route}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function runQueuedTasks(handlers: Record<string, Any>): Promise<string[]> {
  const ran: string[] = [];
  for (;;) {
    const task = await mods.queue.dequeueTask(["sync", "backfill"]);
    if (!task) return ran;
    const handler = handlers[task.kind];
    if (!handler) {
      await mods.queue.failTask(task.id, `no handler ${task.kind}`);
      ran.push(`unhandled:${task.kind}`);
      continue;
    }
    await handler(task.payload, { task, heartbeat: async () => {} });
    await mods.queue.succeedTask(task.id, {});
    ran.push(task.kind);
  }
}

async function drainExporter(exporter: Any): Promise<{ acked: number; dead: number }> {
  let acked = 0;
  let dead = 0;
  for (let i = 0; i < 20; i++) {
    const r = await exporter.runOnce();
    acked += r.acked;
    dead += r.deadLettered;
    if (r.claimed === 0) break;
  }
  return { acked, dead };
}

describe.skipIf(!PG)("source runtime on real PostgreSQL with the real yc_msaw server", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `core_lane_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    // Donor modules read the environment at import time.
    process.env.DATABASE_URL = url.href;
    process.env.NANGO_SECRET_KEY = "nango-secret-for-tests";
    process.env.NANGO_WEBHOOK_SECRET = WEBHOOK_SECRET;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });

    mods.migrations = await import("../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../src/db/client.js");
    mods.queue = await import("../../../src/queue/queue.js");
    mods.dispatch = await import("../../../src/queue/dispatch.js");
    mods.tenants = await import("../../../src/db/tenants.js");
    mods.connections = await import("../../../src/db/connections.js");
    mods.nangoClient = await import("../../../src/integrations/nango/client.js");
    mods.nangoTasks = await import("../../../src/integrations/nango/tasks.js");
    mods.exporter = await import("../../../src/source-lane/export/exporter.js");
    mods.registry = await import("../../../src/source-lane/registry.js");
    mods.internal = await import("../../../src/source-lane/internal/app.js");
    mods.worker = await import("../../../src/source-lane/worker.js");

    // Local fake Nango records API (synthetic records only).
    fakeNango = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/records" && req.headers.authorization === "Bearer nango-secret-for-tests") {
        const model = u.searchParams.get("model") ?? "";
        const records = nangoPages[model] ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ records, next_cursor: null }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => fakeNango.listen(0, "127.0.0.1", r));
    nangoBase = `http://127.0.0.1:${(fakeNango.address() as { port: number }).port}`;

    const registry = mods.registry.defaultRegistry();
    runtimeApp = mods.internal.createRuntimeApp({
      db: mods.db.db,
      registry,
      exporter: new mods.exporter.SourceExporter({ db: mods.db.db, registry, log: () => {} }),
      serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"),
      mountInternal: true,
    });
    const { serve } = await import("@hono/node-server");
    // Keep Node's global Request/Response: yc_msaw runs in this same process.
    runtimeServer = serve({ fetch: runtimeApp.fetch, port: 0, hostname: "127.0.0.1", overrideGlobalObjects: false });
    await new Promise((r) => setTimeout(r, 50));
    const runtimePort = (runtimeServer.address() as { port: number }).port;
    const reservation = createServer();
    await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
    const ycPort = (reservation.address() as { port: number }).port;
    await new Promise<void>((r) => reservation.close(() => r()));

    // Real yc_msaw app (static keys on loopback, directory object store).
    const auth = await importYc("src/auth/static-keys.ts");
    const admin = auth.generateStaticKey("acme", ["memory:build", "memory:read"]);
    const reader = auth.generateStaticKey("acme", ["memory:read"]);
    const rival = auth.generateStaticKey("rival", ["memory:read", "memory:build"]);
    keys = { admin: admin.key, reader: reader.key, rival: rival.key };
    ycDir = await mkdtemp(path.join(os.tmpdir(), "runtime-pg-yc-"));
    const { createApp } = await importYc("src/app.ts");
    const { DirectoryObjectStore } = await importYc("src/store/objects.ts");
    yc = await createApp({
      env: {
        HOST: "127.0.0.1",
        AUTH_MODE: "static",
        PROCMEM_STATIC_KEYS: [admin.entry, reader.entry, rival.entry].join(","),
        PROCMEM_STATIC_KEYS_ON_MCP: "1",
        PROCMEM_STORE: "directory",
        PROCMEM_SANDBOX: "local",
        PROCMEM_DATA_DIR: ycDir,
        SOURCES_RUNTIME_URL: `http://127.0.0.1:${runtimePort}/internal/v1`,
        SOURCES_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN,
        SOURCES_PUBLISH_URL: `http://127.0.0.1:${ycPort}`,
      },
      store: new DirectoryObjectStore(path.join(ycDir, "objects")),
      builder: async () => {
        throw new Error("source export must not run a memory build");
      },
      leaseFactory: async () => {
        throw new Error("source reads must not open a sandbox");
      },
      log: () => undefined,
    });
    const bound = await yc.listen(ycPort);
    ycBase = bound.url;
    ycMcp = bound.mcpUrl;

  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(mcpClients.map((c) => c.close()));
    await yc?.close();
    await new Promise((r) => (runtimeServer ? runtimeServer.close(r) : r(undefined)));
    await new Promise((r) => fakeNango?.close(r));
    await mods.db?.pgClient?.end({ timeout: 5 });
    await sql?.end({ timeout: 5 });
    if (adminSql) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
    if (ycDir) await rm(ycDir, { recursive: true, force: true });
  });

  it("applies the source-only migration plan without pgvector and records every exclusion", async () => {
    const plan = mods.migrations.planMigrations();
    expect(plan.excluded.map((e: Any) => e.file)).toContain("0006_graph_core.sql");
    const applied = (await sql`SELECT name FROM schema_migrations ORDER BY name`).map((r: Any) => r.name);
    expect(applied).toEqual(plan.apply.slice().sort());
    const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    expect(ext).toHaveLength(0);
    const cols = await sql`SELECT table_name, column_name FROM information_schema.columns WHERE (table_name, column_name) IN (('activity_events','source_namespace'),('activity_events','record_kind'),('mirror_files','meta_sha'),('task_schedules','deferred_since'))`;
    expect(cols).toHaveLength(4);
    const graphTables = await sql`SELECT table_name FROM information_schema.tables WHERE table_name IN ('kb_containers','claims','chunk_extractions','entities')`;
    expect(graphTables).toHaveLength(0);
    expect(await mods.migrations.pendingSourceLaneMigrations(sql)).toEqual([]);
  });

  it("refuses graph work at the database and registers no graph handler", async () => {
    await mods.tenants.ensureTenant({ id: "acme", name: "acme" });
    await mods.dispatch.startNangoPolling("acme", "confluence");
    const schedules = (await sql`SELECT kind FROM task_schedules WHERE tenant_id = 'acme' ORDER BY kind`).map((r: Any) => r.kind);
    expect(schedules).toEqual(["confluence.sweep", "nango.poll"]); // confluence request 1
    const refused = (await sql`SELECT kind FROM source_lane_refused_tasks WHERE tenant_id = 'acme'`).map((r: Any) => r.kind);
    expect(refused).toContain("graph.ensure_default_kb");
    expect(await mods.queue.enqueueTask({ queue: "sync", tenantId: "acme", kind: "graph.extract_chunks", payload: {} })).toBeNull();
    const handlers = mods.worker.sourceLaneTaskHandlers(mods.registry.defaultRegistry());
    expect(Object.keys(handlers).filter((k) => /^(graph|wiki)\./.test(k))).toEqual([]);
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(["nango.sync_records", "nango.poll", "gdocs.poll", "slack.poll", "mirror.backfill"]));
  });

  it("journals provider-state changes but not lifecycle bookkeeping", async () => {
    await sql`DELETE FROM source_lane_journal`;
    const [ev] = await sql`
      INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id)
      VALUES ('journal-t', 'granola', 'meeting_note', now(), '{"granolaId":"g1","n":12345678901234567890}'::jsonb, 'granola:g1:1') RETURNING id`;
    await sql`UPDATE activity_events SET processing_status = 'mirrored' WHERE id = ${ev.id}`;
    await sql`INSERT INTO mirror_files (path, user_id, content) VALUES ('sources/granola/a.md', 'journal-t', 'x')`;
    await sql`UPDATE mirror_files SET path = 'sources/granola/b.md' WHERE user_id = 'journal-t'`;
    await sql`DELETE FROM mirror_files WHERE user_id = 'journal-t'`;
    const j = await sql`SELECT table_name, row_key, op FROM source_lane_journal WHERE tenant_id = 'journal-t' ORDER BY id`;
    expect(j.map((r: Any) => `${r.table_name}:${r.op}:${r.table_name === "activity_events" ? "id" : r.row_key}`)).toEqual([
      "activity_events:INSERT:id",
      "mirror_files:INSERT:sources/granola/a.md",
      "mirror_files:UPDATE:sources/granola/b.md",
      "mirror_files:DELETE:sources/granola/a.md",
      "mirror_files:DELETE:sources/granola/b.md",
    ]);
    await sql`DELETE FROM source_lane_journal WHERE tenant_id = 'journal-t'`;
  });

  it("authenticates the internal API with the service token and the forwarded principal", async () => {
    expect((await internal("GET", "/tenants/acme/status", undefined, { token: null })).status).toBe(401);
    expect((await internal("GET", "/tenants/acme/status", undefined, { token: "svc_wrong" })).status).toBe(401);
    expect((await internal("GET", "/tenants/acme/status", undefined, { tenant: "rival" })).status).toBe(403);
    expect((await internal("GET", "/tenants/acme/status")).status).toBe(200);
  });

  it("captures a Confluence page through the donor webhook + record task, exports it, and serves it over MCP", async () => {
    // A reader cannot provision; the admin's tenant comes from its verified key, never the body.
    const auth = (k: string) => ({ Authorization: `Bearer ${k}`, "Content-Type": "application/json" });
    const denied = await fetch(`${ycBase}/v1/sources/runtime/provision`, { method: "POST", headers: auth(keys.reader), body: "{}" });
    expect(denied.status).toBe(403);
    const provisioned = await fetch(`${ycBase}/v1/sources/runtime/provision`, { method: "POST", headers: auth(keys.admin), body: JSON.stringify({ tenantNs: "rival" }) });
    expect(provisioned.status).toBe(201);
    const prov = await provisioned.json();
    expect(prov).not.toHaveProperty("token");
    const binding = prov.binding;
    const stored = await sql`SELECT tenant_id, binding_id, token_ciphertext, publish_url FROM source_lane_bindings`;
    expect(stored.map((r: Any) => r.tenant_id)).toEqual(["acme"]);
    expect(stored[0].binding_id).toBe(binding.bindingId);
    expect(stored[0].token_ciphertext.startsWith("psb_")).toBe(false);
    // Forwarded runtime status and connect use the verified tenant; unknown providers are relayed as 404.
    const rs = await fetch(`${ycBase}/v1/sources/runtime/status`, { headers: { Authorization: `Bearer ${keys.reader}` } });
    const rsBody = await rs.json();
    expect(rs.status, JSON.stringify(rsBody)).toBe(200);
    expect(rsBody.tenantId).toBe("acme");
    expect((await fetch(`${ycBase}/v1/sources/connect/not-a-provider`, { method: "POST", headers: auth(keys.admin), body: "{}" })).status).toBe(404);
    // A binding minted for acme cannot be installed under another tenant, even by the service.
    const minted = await (await fetch(`${ycBase}/v1/sources/bindings`, { method: "POST", headers: auth(keys.admin), body: JSON.stringify({ providers: ["*"] }) })).json();
    expect((await internal("PUT", "/tenants/rival/binding", { bindingId: minted.binding.bindingId, token: minted.token, publishUrl: ycBase }, { tenant: "rival" })).status).toBe(400);
    const token = minted.token;

    await mods.connections.upsertConnection({ tenantId: "acme", provider: "confluence", externalAccountId: "conn-1", status: "active" });
    nangoPages = {
      Page: [{ id: "page-7", title: "Release Runbook", spaceId: "ENG", versionNumber: 7, bodyStorage: "<p>Hello <strong>world</strong></p>", author: { displayName: "Pat Writer" }, _nango_metadata: { updated_at: "2026-10-17T00:00:00.000Z" } }],
    };
    const body = JSON.stringify({ type: "sync", success: true, providerConfigKey: "confluence", connectionId: "conn-1", model: "Page" });
    const unsigned = await runtimeApp.request("/webhooks/nango", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(unsigned.status).toBe(401);
    const signed = await runtimeApp.request("/webhooks/nango", {
      method: "POST",
      headers: { "content-type": "application/json", "x-nango-hmac-sha256": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex") },
      body,
    });
    expect(signed.status).toBe(204);
    mods.worker.sourceLaneTaskHandlers(mods.registry.defaultRegistry()); // registers Atlassian processors
    const handlers = mods.nangoTasks.registerNangoTasks({ client: new mods.nangoClient.NangoClient({ apiKey: "nango-secret-for-tests", baseUrl: nangoBase, retryDelayMs: 1 }) });
    expect(await runQueuedTasks(handlers)).toContain("nango.sync_records");

    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, log: () => {} });
    const drained = await drainExporter(exporter);
    expect(drained.dead).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = 'acme'`)[0].n).toBe(0);
    await exporter.reportStatus("acme");

    const reader = await mcp(keys.reader);
    const page = await call(reader, "read", { path: "$SOURCES/confluence/ENG/page-7.md" });
    expect(page.ok).toBe(true);
    const mirror = await sql`SELECT content FROM mirror_files WHERE user_id = 'acme' AND path = 'sources/confluence/ENG/page-7.md'`;
    expect(page.content).toBe(mirror[0].content.replace(/\n$/, ""));
    expect(page.content).toContain("# Release Runbook");
    expect(page.content).toContain("Hello **world**");
    expect(page.source.capturedAt).toBeTruthy();
    expect(page.provenance).toMatchObject({ table: "mirror_files", bindingId: binding.bindingId });
    const raws = await call(reader, "find", { path: "$SOURCES/confluence/_raw", pattern: "*.json" });
    expect(raws.matches).toHaveLength(1);
    const raw = await call(reader, "read", { path: raws.matches[0] });
    const rawDoc = JSON.parse(raw.content);
    expect(rawDoc.source_event_id).toBe("nango:confluence:page:page-7:v7");
    expect(rawDoc.raw_payload).toMatchObject({ id: "page-7", versionNumber: 7, bodyStorage: "<p>Hello <strong>world</strong></p>" });
    const grep = await call(reader, "grep", { path: "$SOURCES/confluence", pattern: "Release Runbook", literal: true });
    expect(grep.matches.some((m: Any) => m.path === "$SOURCES/confluence/ENG/page-7.md")).toBe(true);
    const status = await call(reader, "sources_status", { provider: "confluence" });
    expect(status.providers[0].files).toBeGreaterThanOrEqual(2);
    expect(status.providers[0].health).toBe("healthy");
    expect(status.providers[0].coverageState).not.toBe("complete"); // the baseline module reports no completeness

    // Another tenant sees nothing.
    const rival = await mcp(keys.rival);
    const rivalLs = await call(rival, "ls", { path: "$SOURCES" });
    expect(rivalLs.entries).toEqual([]);
    expect((await call(rival, "read", { path: "$SOURCES/confluence/ENG/page-7.md" })).isError).toBe(true);
    // A binding token is not an MCP credential.
    await expect(mcp(token)).rejects.toThrow();

    // Provider deletion: tombstone record -> donor removes the mirror file -> store tombstone + history.
    nangoPages = { Page: [{ id: "page-7", spaceId: "ENG", _nango_metadata: { last_action: "DELETED", updated_at: "2026-10-17T01:00:00.000Z" } }] };
    const delBody = JSON.stringify({ type: "sync", success: true, providerConfigKey: "confluence", connectionId: "conn-1", model: "Page", modifiedAfter: "2026-10-17T00:30:00.000Z" });
    expect((await runtimeApp.request("/webhooks/nango", { method: "POST", headers: { "content-type": "application/json", "x-nango-hmac-sha256": createHmac("sha256", WEBHOOK_SECRET).update(delBody).digest("hex") }, body: delBody })).status).toBe(204);
    expect(await runQueuedTasks(handlers)).toContain("nango.sync_records");
    expect((await drainExporter(exporter)).dead).toBe(0);
    const gone = await call(reader, "read", { path: "$SOURCES/confluence/ENG/page-7.md" });
    expect(gone.isError).toBe(true);
    expect(gone.error).toContain("deleted");
    const hist = await call(reader, "sources_history", { path: "$SOURCES/confluence/ENG/page-7.md" });
    expect(hist.versions.map((v: Any) => v.kind)).toEqual(["tombstone", "projection"]);
    const old = await call(reader, "sources_history", { path: "$SOURCES/confluence/ENG/page-7.md", versionId: hist.versions[1].versionId });
    expect(old.content).toContain("Hello **world**");
    // The raw ledger keeps both records (capture is append-only).
    expect((await call(reader, "find", { path: "$SOURCES/confluence/_raw", pattern: "*.json" })).matches).toHaveLength(2);
  });

  it("replays a batch whose response was lost and dead-letters store rejections instead of acknowledging them", async () => {
    const binding = (await sql`SELECT binding_id FROM source_lane_bindings WHERE tenant_id = 'acme'`)[0];
    expect(binding).toBeTruthy();
    // Response lost after the store committed: the exporter must retry and receive the replayed receipt.
    let dropOnce = true;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (dropOnce && String(input).endsWith("/v1/sources/publish")) {
        dropOnce = false;
        throw new Error("socket hang up after commit");
      }
      return res;
    };
    await sql`INSERT INTO mirror_files (path, user_id, content, updated_at) VALUES ('sources/jira/ENG/ENG-1.md', 'acme', '# ENG-1', now())`;
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, fetchImpl: lossy, log: () => {} });
    const first = await exporter.runOnce();
    expect(first.released).toBe(1);
    await sql`UPDATE source_lane_journal SET next_attempt_at = now() WHERE tenant_id = 'acme'`;
    const headBefore = (await (await fetch(`${ycBase}/v1/sources/status`, { headers: { Authorization: `Bearer ${keys.reader}` } })).json()).head.seq;
    const second = await exporter.runOnce();
    expect(second.acked).toBe(1);
    const headAfter = (await (await fetch(`${ycBase}/v1/sources/status`, { headers: { Authorization: `Bearer ${keys.reader}` } })).json()).head.seq;
    expect(headAfter).toBe(headBefore); // replayed receipt: no second commit

    // File/directory conflict: the second row is rejected by the store and dead-lettered with the reason.
    await sql`INSERT INTO mirror_files (path, user_id, content) VALUES ('sources/jira/ENG/ENG-1.md/child.md', 'acme', 'x')`;
    const third = await exporter.runOnce();
    expect(third.deadLettered).toBe(1);
    const dl = await sql`SELECT last_error, dead_lettered_at FROM source_lane_journal WHERE tenant_id = 'acme'`;
    expect(dl).toHaveLength(1);
    expect(dl[0].dead_lettered_at).not.toBeNull();
    expect(dl[0].last_error).toContain("path_conflict");
    const cov = await exporter.coverage("acme");
    expect(cov.find((c: Any) => c.provider === "jira" && c.scope === "export")).toMatchObject({ state: "partial", counts: { deadLettered: 1 } });
    await exporter.reportStatus("acme");
    const reader = await mcp(keys.reader);
    const st = await call(reader, "sources_status", { provider: "jira" });
    expect(st.providers[0].coverageState).toBe("partial");
    await sql`DELETE FROM mirror_files WHERE user_id = 'acme' AND path = 'sources/jira/ENG/ENG-1.md/child.md'`;
    await sql`DELETE FROM source_lane_journal WHERE tenant_id = 'acme'`;
  });

  it("exports raw payload numbers exactly as stored and backfills existing rows on provisioning", async () => {
    await sql`
      INSERT INTO activity_events (user_id, source, source_namespace, source_object_id, record_kind, event_type, timestamp, raw_payload, source_event_id)
      VALUES ('acme', 'granola', 'tenant', 'meeting_note:g9', 'snapshot', 'meeting_note', '2026-10-01T10:00:00Z', '{"granolaId":"g9","big":12345678901234567890,"nested":{"__proto__":{"x":1}}}'::jsonb, 'granola:g9:1')`;
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, log: () => {} });
    await drainExporter(exporter);
    const reader = await mcp(keys.reader);
    const found = await call(reader, "find", { path: "$SOURCES/granola/_raw/tenant", pattern: "*.json" });
    expect(found.matches).toEqual(["$SOURCES/granola/_raw/tenant/meeting_note:g9/2026-10/granola:g9:1.json"]);
    const raw = await call(reader, "read", { path: found.matches[0] });
    expect(raw.content).toContain('"big": 12345678901234567890');
    expect(raw.content).toContain('"__proto__"');

    // Re-provisioning journals every existing row; republishing is idempotent.
    const res = await internal("POST", "/tenants/acme/backfill");
    const counts = (await res.json()).backfill;
    expect(counts.activity_events).toBeGreaterThanOrEqual(3);
    const before = (await (await fetch(`${ycBase}/v1/sources/status`, { headers: { Authorization: `Bearer ${keys.reader}` } })).json()).head.seq;
    const r = await drainExporter(exporter);
    expect(r.dead).toBe(0);
    const after = (await (await fetch(`${ycBase}/v1/sources/status`, { headers: { Authorization: `Bearer ${keys.reader}` } })).json()).head.seq;
    // Batches commit (for idempotency) but every change is unchanged.
    expect(after).toBeGreaterThanOrEqual(before);
    const ls = await call(reader, "ls", { path: "$SOURCES/confluence/ENG" });
    expect(ls.entries.map((e: Any) => e.name)).not.toContain("page-7.md");
  });

  it("executes provider modules: extra-table export with deletes, coverage, and scheduled task handlers", async () => {
    await sql.unsafe(`
      CREATE TABLE core_test_snapshots (tenant_id text NOT NULL, id text PRIMARY KEY, body bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TRIGGER trg_core_test_snapshots AFTER INSERT OR UPDATE OR DELETE ON core_test_snapshots
        FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'id');
    `);
    const { sql: dsql } = await import("drizzle-orm");
    let taskRuns = 0;
    const testModule = {
      id: "core-test",
      eventSources: [],
      mirrorRoots: [],
      extraTables: [
        {
          table: "core_test_snapshots",
          tenantColumn: "tenant_id",
          keyColumn: "id",
          async map(ctx: Any, rowKey: string, journal: Any, previousPaths: readonly string[]) {
            const rows = (await ctx.executor.execute(dsql`SELECT id, body, updated_at FROM core_test_snapshots WHERE tenant_id = ${ctx.tenantId} AND id = ${rowKey}`)) as Any[];
            if (!rows[0]) return previousPaths.map((path) => ({ op: "delete", path, deletedAt: journal.enqueuedAt, reason: "snapshot_deleted", capturedAt: journal.enqueuedAt }));
            return [{ op: "put", path: `sources/core-test/${rowKey}.bin`, kind: "binary", contentType: "application/octet-stream", content: Buffer.from(rows[0].body), sourceUpdatedAt: null, capturedAt: new Date(rows[0].updated_at).toISOString(), sourceVersion: { ref: "v1", ordinal: 1 } }];
          },
        },
      ],
      async coverage() {
        return [{ provider: "core-test", scope: "all", state: "complete", lastSuccessAt: new Date().toISOString() }];
      },
      taskHandlers: () => ({ "core_test.poll": async () => { taskRuns++; return { ok: true }; } }),
    };
    const registry = new mods.registry.SourceProviderRegistry([...mods.registry.defaultRegistry().modules, testModule]);
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, registry, log: () => {} });

    // Binary larger than one chunk travels as uploaded chunks and comes back byte-identical.
    const big = Buffer.alloc(8 * 1024 * 1024 + 4097);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    await sql`INSERT INTO core_test_snapshots (tenant_id, id, body) VALUES ('acme', 'snap-1', ${big})`;
    expect((await drainExporter(exporter)).dead).toBe(0);
    const reader = await mcp(keys.reader);
    const head = await call(reader, "read", { path: "$SOURCES/core-test/snap-1.bin", byteOffset: 8 * 1024 * 1024 - 3, byteLimit: 10 });
    expect(Buffer.from(head.content, "base64").equals(big.subarray(8 * 1024 * 1024 - 3, 8 * 1024 * 1024 + 7))).toBe(true);
    expect(head.source.size).toBe(big.length);

    // Deleting the row exports a delete of exactly the paths it produced.
    await sql`DELETE FROM core_test_snapshots WHERE id = 'snap-1'`;
    expect((await drainExporter(exporter)).dead).toBe(0);
    expect((await call(reader, "read", { path: "$SOURCES/core-test/snap-1.bin" })).error).toContain("snapshot_deleted");
    expect(await sql`SELECT * FROM source_lane_exported WHERE table_name = 'core_test_snapshots'`).toHaveLength(0);

    // Provider coverage is reported through the binding.
    const cov = await exporter.coverage("acme");
    expect(cov).toContainEqual(expect.objectContaining({ provider: "core-test", state: "complete" }));
    await exporter.reportStatus("acme");
    expect((await call(reader, "sources_status", { provider: "core-test" })).providers[0].coverageState).toBe("complete");

    // Scheduler -> queue -> provider task handler, all through the donor queue on PostgreSQL.
    const { upsertTaskSchedule, sweepDueSchedules } = await import("../../../src/queue/sweeper.js");
    await upsertTaskSchedule({ tenantId: "acme", kind: "core_test.poll", frequencySeconds: 60, groupKey: "acme:core-test" });
    // Only this schedule may fire (others would call real provider APIs).
    await sql`UPDATE task_schedules SET enabled = false WHERE kind <> 'core_test.poll'`;
    await sql`DELETE FROM task_queue WHERE state = 'queued'`;
    await sql`UPDATE task_schedules SET due_at = now() - interval '1 second' WHERE kind = 'core_test.poll'`;
    expect(await sweepDueSchedules()).toBe(1);
    const handlers = mods.worker.sourceLaneTaskHandlers(registry);
    const ran = await runQueuedTasks(handlers);
    expect(ran).toContain("core_test.poll");
    expect(taskRuns).toBe(1);
  });

  it("retries a lost-response batch with newer row state under a new batch id without skipping journal rows", async () => {
    await sql`DELETE FROM source_lane_journal WHERE tenant_id = 'acme'`;
    let drop = true;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (drop && String(input).endsWith("/v1/sources/publish")) {
        drop = false;
        throw new Error("connection reset after commit");
      }
      return res;
    };
    await sql`INSERT INTO mirror_files (path, user_id, content, updated_at) VALUES ('sources/notion/Plan.md', 'acme', 'v1', now() - interval '1 minute')`;
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, fetchImpl: lossy, log: () => {} });
    expect((await exporter.runOnce()).released).toBe(1); // v1 committed, response lost
    await sql`UPDATE mirror_files SET content = 'v2', updated_at = now() WHERE user_id = 'acme' AND path = 'sources/notion/Plan.md'`;
    await sql`UPDATE source_lane_journal SET next_attempt_at = now() WHERE tenant_id = 'acme'`;
    const r = await drainExporter(exporter);
    expect(r).toEqual({ acked: 2, dead: 0 });
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = 'acme'`)[0].n).toBe(0);
    const reader = await mcp(keys.reader);
    expect((await call(reader, "read", { path: "$SOURCES/notion/Plan.md" })).content).toBe("v2");
    const hist = await call(reader, "sources_history", { path: "$SOURCES/notion/Plan.md" });
    expect(hist.versions.map((v: Any) => v.size)).toEqual([2, 2]);
    expect((await call(reader, "sources_history", { path: "$SOURCES/notion/Plan.md", versionId: hist.versions[1].versionId })).content).toBe("v1");
  });

  it("serializes a tenant across exporters and a paused exporter past its lease cannot resurrect a moved path", async () => {
    await sql`DELETE FROM source_lane_journal WHERE tenant_id = 'acme'`;
    await sql`INSERT INTO mirror_files (path, user_id, content, updated_at) VALUES ('sources/notion/Moving/A.md', 'acme', 'moving', now() - interval '2 minutes')`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let paused = false;
    const pausing: typeof fetch = async (input, init) => {
      if (!paused && String(input).endsWith("/v1/sources/publish")) {
        paused = true;
        await gate;
      }
      return fetch(input, init);
    };
    const slow = new mods.exporter.SourceExporter({ db: mods.db.db, fetchImpl: pausing, leaseSeconds: 1, owner: "slow-exporter", log: () => {} });
    const fast = new mods.exporter.SourceExporter({ db: mods.db.db, owner: "fast-exporter", log: () => {} });
    const slowRun = slow.runOnce();
    for (let i = 0; i < 200 && !paused; i++) await new Promise((r) => setTimeout(r, 10));
    expect(paused).toBe(true);

    // While slow holds the tenant lease, fast claims another row of the tenant but must not publish it.
    await sql`INSERT INTO mirror_files (path, user_id, content) VALUES ('sources/notion/Other.md', 'acme', 'other')`;
    const blocked = await fast.runOnce();
    expect(blocked).toMatchObject({ claimed: 1, acked: 0, released: 1 });

    // The source moves while slow is paused, and slow's lease lapses.
    await sql`UPDATE mirror_files SET path = 'sources/notion/Moving/B.md', updated_at = now() WHERE user_id = 'acme' AND path = 'sources/notion/Moving/A.md'`;
    await new Promise((r) => setTimeout(r, 1_300));
    await sql`UPDATE source_lane_journal SET next_attempt_at = now() WHERE tenant_id = 'acme'`;
    const took = await drainExporter(fast);
    expect(took.dead).toBe(0);

    // Slow resumes and publishes its old view of A: the store refuses it as stale; it cannot ACK or record.
    release();
    const late = await slowRun;
    expect(late.acked).toBe(0);
    const reader = await mcp(keys.reader);
    const ls = await call(reader, "ls", { path: "$SOURCES/notion/Moving" });
    expect(ls.entries.map((e: Any) => e.name)).toEqual(["B.md"]);
    expect((await call(reader, "read", { path: "$SOURCES/notion/Moving/A.md" })).isError).toBe(true);
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = 'acme'`)[0].n).toBe(0);
    const owned = (await sql`SELECT path FROM source_lane_exported WHERE tenant_id = 'acme' AND path LIKE 'sources/notion/Moving/%'`).map((r: Any) => r.path);
    expect(owned).toEqual(["sources/notion/Moving/B.md"]);
    expect(await sql`SELECT * FROM source_lane_tenant_locks WHERE tenant_id = 'acme'`).toHaveLength(0);
  });
});
