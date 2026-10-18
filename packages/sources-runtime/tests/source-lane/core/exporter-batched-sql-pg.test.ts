import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * perf-verification: the exporter's SQL per pass must not grow with the rows it exports (one statement per table
 * per pass, one ownership upsert and one ack per publish), and a tenant backfill must not re-journal keys that are
 * already waiting (provisioning a tenant with captured data exported every row twice). Real PostgreSQL, own
 * throwaway database; yc_msaw is a fake publish endpoint that accepts every change.
 */
const PG = process.env.SOURCES_TEST_PG_URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
let db: Any;
const stmts = { n: 0 };

describe.skipIf(!PG)("exporter SQL is batched per pass (real PostgreSQL)", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `exporter_batched_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    const { applySourceLaneMigrations } = await import("../../../src/source-lane/core/migrations.js");
    await applySourceLaneMigrations(sql);
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const inner = drizzle(sql);
    db = new Proxy(inner, { get: (t, p, r) => (p === "execute" ? (q: Any) => (stmts.n++, t.execute(q)) : Reflect.get(t, p, r)) });
    await sql.unsafe(`
      INSERT INTO activity_events (user_id, source, source_namespace, source_object_id, record_kind, event_type, timestamp, raw_payload, source_event_id)
      SELECT 't-batch', 'notion', 'ws', 'page-' || (g % 50), 'activity', 'edit', now() - (g || ' seconds')::interval, jsonb_build_object('n', g), 'evt:' || g
      FROM generate_series(1, 400) g`);
    await sql.unsafe(`
      INSERT INTO mirror_files (user_id, path, content, content_sha, meta, updated_at)
      SELECT 't-batch', 'sources/notion/ws/p' || g || ', "quoted" \\ page.md', 'body ' || g, md5(g::text), '{}'::jsonb, now() FROM generate_series(1, 100) g`);
    const { setTenantBinding } = await import("../../../src/source-lane/export/bindings.js");
    await setTenantBinding(inner, { tenantId: "t-batch", bindingId: "sb-0123456789abcdef", token: `psb_t-batch.sb-0123456789abcdef.${"A".repeat(43)}`, publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (adminSql && dbName) await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await adminSql?.end({ timeout: 5 });
  });

  it("a tenant backfill does not re-journal keys that are still waiting", async () => {
    const { SourceExporter } = await import("../../../src/source-lane/export/exporter.js");
    const exporter = new SourceExporter({ db, log: () => {} });
    await exporter.enqueueTenantBackfill("t-batch");
    const [{ n, keys }] = await sql`SELECT count(*)::int AS n, count(DISTINCT (table_name, row_key))::int AS keys FROM source_lane_journal WHERE tenant_id = 't-batch'`;
    expect(keys).toBe(500);
    expect(n).toBe(500); // the insert triggers already journalled every row once
  });

  it("exports 500 rows with a bounded number of SQL statements and records every exported path", async () => {
    const published: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { changes: Array<{ path: string }> };
      published.push(...body.changes.map((c) => c.path));
      return Response.json({ results: body.changes.map((c) => ({ path: c.path, outcome: "created", versionId: null })) });
    };
    const { SourceExporter } = await import("../../../src/source-lane/export/exporter.js");
    const exporter = new SourceExporter({ db, fetchImpl, claimLimit: 500, log: () => {} });
    stmts.n = 0;
    const r = await exporter.runOnce();
    expect(r).toMatchObject({ claimed: 500, acked: 500, deadLettered: 0 });
    // Per-row lookups, ownership inserts and acks used to cost ~4 statements per row (~2,000 here).
    expect(stmts.n).toBeLessThan(40);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM source_lane_exported WHERE tenant_id = 't-batch'`;
    expect(n).toBe(published.length);
    expect(published.some((p) => p.includes('"quoted"'))).toBe(true);
    const [{ left }] = await sql`SELECT count(*)::int AS left FROM source_lane_journal WHERE tenant_id = 't-batch'`;
    expect(left).toBe(0);
  }, 60_000);
});
