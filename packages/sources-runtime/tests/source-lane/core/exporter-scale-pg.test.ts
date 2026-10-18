import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * final-audit H1 at realistic size on real PostgreSQL: 120,000 activity_events whose insert triggers journal every
 * row (an initial backfill). The per-tenant coverage backlog is one grouped join and must stay fast, and the
 * exporter's per-row lookup must use the uuid primary key index. Own throwaway database, dropped afterwards.
 */
const PG = process.env.SOURCES_TEST_PG_URL;
const EVENTS = 120_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
let db: Any;

describe.skipIf(!PG)("exporter coverage at 120k journalled events (real PostgreSQL)", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `exporter_scale_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    const { applySourceLaneMigrations } = await import("../../../src/source-lane/core/migrations.js");
    await applySourceLaneMigrations(sql);
    const { drizzle } = await import("drizzle-orm/postgres-js");
    db = drizzle(sql);
    await sql.unsafe(`
      INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id)
      SELECT CASE WHEN g % 10 = 0 THEN 'tenant-other' ELSE 'tenant-scale' END,
             CASE g % 3 WHEN 0 THEN 'gmail' WHEN 1 THEN 'slack' ELSE 'notion' END,
             'message', now() - (g || ' seconds')::interval, jsonb_build_object('n', g), 'evt:' || g
      FROM generate_series(1, ${EVENTS}) g`);
    await sql.unsafe(`ANALYZE activity_events; ANALYZE source_lane_journal;`);
  }, 300_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (adminSql && dbName) await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await adminSql?.end({ timeout: 5 });
  });

  it("journals the backfill and reports its backlog per provider within a bounded time", async () => {
    const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = 'tenant-scale'`);
    expect(n).toBe(EVENTS * 0.9);
    const { SourceExporter } = await import("../../../src/source-lane/export/exporter.js");
    const { defaultRegistry } = await import("../../../src/source-lane/registry.js");
    const exporter = new SourceExporter({ db, registry: defaultRegistry(), log: () => {} });
    const started = performance.now();
    const coverage = await exporter.coverage("tenant-scale");
    const ms = performance.now() - started;
    const backlog = Object.fromEntries(coverage.filter((c) => c.scope === "export").map((c) => [c.provider, c.counts?.backlog]));
    expect(backlog).toMatchObject({ gmail: 36_000, slack: 36_000, notion: 36_000 });
    // The pre-fix correlated subquery took ~15 s at 200k events / 2k journal rows; the grouped join is far below this.
    expect(ms).toBeLessThan(8_000);
    console.log(`coverage(120k journalled events): ${Math.round(ms)} ms`);
  }, 120_000);

  it("looks a journalled row up through the uuid primary key index", async () => {
    const [{ id }] = await sql.unsafe(`SELECT id::text AS id FROM activity_events WHERE user_id = 'tenant-scale' LIMIT 1`);
    const plan = (await sql.unsafe(`EXPLAIN SELECT * FROM activity_events WHERE user_id = 'tenant-scale' AND id = '${id}'::uuid`)).map((r: Any) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index Scan|Index Only Scan/);
    expect(plan).not.toMatch(/Seq Scan/);
  });
});
