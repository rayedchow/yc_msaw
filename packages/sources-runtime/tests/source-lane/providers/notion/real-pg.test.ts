import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeNotion } from "./fake-notion.js";
import { credentialFor, ID, P1_DIR, PNG, seedWorkspace } from "./seed.js";
import { bindingToken, YcStore } from "./yc-store.js";

/**
 * Notion lane on a real PostgreSQL (SOURCES_TEST_PG_URL, synthetic fixture cluster): the full
 * source-lane migration plan (incl. 9450/9451), journal triggers with ignored bookkeeping
 * columns, bytea chunk round trips, the per-connection sweep lease under real concurrency, and
 * the exporter (default registry) into the real yc_msaw store. Creates and drops its own
 * database; never touches another one.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
const mods: Record<string, Any> = {};

describe.skipIf(!PG)("notion source lane on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `notion_lane_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.sweep = await import("../../../../src/source-lane/providers/notion/sweep.js");
    mods.coverage = await import("../../../../src/source-lane/providers/notion/coverage.js");
    mods.exporter = await import("../../../../src/source-lane/export/exporter.js");
    mods.bindings = await import("../../../../src/source-lane/export/bindings.js");
    mods.registry = await import("../../../../src/source-lane/registry.js");
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await mods.db?.pgClient?.end?.({ timeout: 5 });
    if (adminSql && dbName) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
  });

  const opts = (fake: FakeNotion, extra: Record<string, unknown> = {}) => ({
    clientOptions: { fetchImpl: fake.fetch, credential: credentialFor() },
    maxRequestsPerRun: 10_000,
    minRequestIntervalMs: 0,
    deltaIntervalMs: 0,
    pageSize: 2,
    leaseOwner: "pg-worker",
    sleep: async () => {},
    ...extra,
  });

  it("applies 9450/9451, captures exact bytes, journals only provider-state changes and exports through the default registry", async () => {
    expect(await mods.migrations.pendingSourceLaneMigrations(sql)).toEqual([]);
    const applied = (await sql`SELECT name FROM schema_migrations WHERE name LIKE '945%' ORDER BY name`).map((r: Any) => r.name);
    expect(applied).toEqual(["9450_notion_source_lane.sql", "9451_notion_source_schedules.sql"]);

    const T = "pg-n1";
    const fake = new FakeNotion();
    seedWorkspace(fake);
    for (let i = 0; i < 20; i++) {
      await mods.sweep.runNotionSweep(mods.db.db, T, opts(fake));
      await sql`UPDATE notion_source_work SET not_before = NULL WHERE tenant_id = ${T} AND state = 'pending'`;
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM notion_source_work WHERE tenant_id = ${T} AND state = 'pending'`;
      const [{ phase }] = await sql`SELECT generation_phase AS phase FROM notion_source_sync_state WHERE tenant_id = ${T}`;
      if (n === 0 && phase === "closed") break;
    }
    const st = (await sql`SELECT generation_phase, full_complete_generation FROM notion_source_sync_state WHERE tenant_id = ${T}`)[0];
    expect(st).toMatchObject({ generation_phase: "closed", full_complete_generation: 1 });
    const bytes = (await sql`
      SELECT c.bytes FROM notion_source_chunks c JOIN notion_source_files f ON f.sha256 = c.chunk_sha256 AND f.tenant_id = c.tenant_id
      WHERE f.tenant_id = ${T} AND f.owner_id = ${ID.IMG}`)[0].bytes;
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);

    const before = (await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = ${T}`)[0].n;
    await sql`UPDATE notion_source_nodes SET seen_generation = seen_generation + 1, last_seen_at = now(), walked_at = now(), query_checked_at = now(), updated_at = now() WHERE tenant_id = ${T}`;
    await sql`UPDATE notion_source_files SET attempts = attempts + 1, updated_at = now() WHERE tenant_id = ${T}`;
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = ${T}`)[0].n).toBe(before);

    const yc = await YcStore.create(T);
    await mods.bindings.setTenantBinding(mods.db.db, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, registry: mods.registry.defaultRegistry(), fetchImpl: yc.fetch, log: () => {} });
    for (let i = 0; i < 100; i++) {
      const r = await exporter.runOnce();
      expect(r.deadLettered).toBe(0);
      if (r.claimed === 0) break;
    }
    expect(await yc.text(`${P1_DIR}/page.md`)).toContain("Welcome to the handbook");
    expect((await yc.file(await yc.find("/diagram.png", P1_DIR)))!.bytes.equals(PNG)).toBe(true);
    const cov = await mods.coverage.notionCoverage({ tenantId: T, executor: mods.db.db });
    expect(cov[0].state, cov[0].reason).toBe("complete");
  });

  it("holds one sweep per Notion connection at a time under real concurrency", async () => {
    const T = "pg-n2";
    const fake = new FakeNotion();
    seedWorkspace(fake);
    const slow: typeof fetch = async (input, init) => {
      await new Promise((r) => setTimeout(r, 15));
      return fake.fetch(input, init);
    };
    const [a, b] = await Promise.all([
      mods.sweep.runNotionSweep(mods.db.db, T, opts(fake, { clientOptions: { fetchImpl: slow, credential: credentialFor() }, leaseOwner: "worker-a", maxRequestsPerRun: 30 })),
      (async () => {
        await new Promise((r) => setTimeout(r, 120));
        return mods.sweep.runNotionSweep(mods.db.db, T, opts(fake, { leaseOwner: "worker-b" }));
      })(),
    ]);
    expect(a.outcome).toBe("ran");
    expect(b.outcome).toBe("lease_busy");
    const lease = (await sql`SELECT lease_owner FROM notion_source_quota WHERE quota_key LIKE 'notion:bot:%'`)[0];
    expect(lease.lease_owner).toBeNull();
  });
});
