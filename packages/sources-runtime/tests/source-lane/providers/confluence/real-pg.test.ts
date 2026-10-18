import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeConfluence, NANGO_BASE, NANGO_KEY } from "./fake-confluence.js";
import { CLOUD, CONN, ENG, PNG, ROOT, seedSite } from "./seed.js";
import { bindingToken, YcStore } from "./yc-store.js";

/**
 * Confluence lane on a real PostgreSQL (SOURCES_TEST_PG_URL, synthetic fixture cluster): the
 * full source-lane migration plan (incl. 9200/9201), journal triggers with ignored lifecycle
 * columns, bytea chunk round trips, the cross-tenant Atlassian quota lease under real
 * concurrency, and the exporter into the real yc_msaw store. Creates and drops its own
 * database; never touches another one.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
const mods: Record<string, Any> = {};

describe.skipIf(!PG)("confluence source lane on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `confluence_lane_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.sweep = await import("../../../../src/source-lane/providers/confluence/sweep.js");
    mods.api = await import("../../../../src/source-lane/providers/confluence/api.js");
    mods.coverage = await import("../../../../src/source-lane/providers/confluence/coverage.js");
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

  it("applies 9200/9201, captures and exports exact bytes, and journals only provider-state changes", async () => {
    expect(await mods.migrations.pendingSourceLaneMigrations(sql)).toEqual([]);
    const applied = (await sql`SELECT name FROM schema_migrations WHERE name LIKE '92%' ORDER BY name`).map((r: Any) => r.name);
    expect(applied).toEqual(expect.arrayContaining(["9200_confluence_source_lane.sql", "9201_confluence_sweep_schedules.sql"]));
    const triggers = (await sql`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_source_lane_journal_confluence_%' ORDER BY tgname`).map((r: Any) => r.tgname);
    expect(triggers).toEqual(["trg_source_lane_journal_confluence_objects", "trg_source_lane_journal_confluence_records", "trg_source_lane_journal_confluence_sites"]);

    const T = "pg-t1";
    await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES (${T}, 'confluence', ${CONN}, 'active', ${sql.json({ providerConfigKey: "confluence" })})`;
    const fake = new FakeConfluence();
    seedSite(fake);
    const client = new mods.api.ConfluenceClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch });
    const opts = { client, maxRequestsPerSite: 10_000, deltaIntervalMs: 0, leaseOwner: "pg-worker" };
    for (let i = 0; i < 5; i++) await mods.sweep.runConfluenceSweep(mods.db.db, T, opts);
    const st = (await sql`SELECT generation_phase, full_complete_generation FROM confluence_source_sync_state WHERE tenant_id = ${T}`)[0];
    expect(st).toMatchObject({ generation_phase: "closed", full_complete_generation: 1 });
    const bytes = (await sql`SELECT c.bytes FROM confluence_source_chunks c JOIN confluence_source_objects o ON o.binary_sha256 = c.chunk_sha256 AND o.tenant_id = c.tenant_id WHERE o.content_id = 'att-1'`)[0].bytes;
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);

    // Lifecycle-only updates (seen generation / last seen) never enter the journal.
    const before = (await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = ${T}`)[0].n;
    await sql`UPDATE confluence_source_objects SET seen_generation = seen_generation + 1, last_seen_at = now(), updated_at = now() WHERE tenant_id = ${T}`;
    expect((await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = ${T}`)[0].n).toBe(before);

    const yc = await YcStore.create(T);
    await mods.bindings.setTenantBinding(mods.db.db, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, registry: mods.registry.defaultRegistry(), fetchImpl: yc.fetch, log: () => {} });
    for (let i = 0; i < 50; i++) {
      const r = await exporter.runOnce();
      expect(r.deadLettered).toBe(0);
      if (r.claimed === 0) break;
    }
    expect((await yc.file(`${ROOT}/spaces/${ENG}/pages/1001/attachments/att-1/diagram.png`))?.bytes.equals(PNG)).toBe(true);
    expect(await yc.text(`${ROOT}/spaces/${ENG}/pages/1001/versions/v000001.md`)).toContain("First draft");
    const cov = await exporter.coverage(T);
    expect(cov.find((c: Any) => c.scope === `site:${CLOUD}/${CONN}`)?.state).toBe("complete");
  });

  it("lets exactly one worker sweep an Atlassian bucket at a time, across tenants", async () => {
    const fake = new FakeConfluence();
    seedSite(fake);
    fake.site("conn-b", CLOUD, "https://acme.atlassian.net");
    for (const [t, c] of [["pg-a", CONN], ["pg-b", "conn-b"]]) {
      await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES (${t}, 'confluence', ${c}, 'active', ${sql.json({ providerConfigKey: "confluence" })})`;
    }
    // Slow upstream so both runs overlap.
    const slow: typeof fetch = async (i, init) => {
      await new Promise((r) => setTimeout(r, 15));
      return fake.fetch(i, init);
    };
    const client = new mods.api.ConfluenceClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: slow });
    // Prime site discovery so both runs reach the lease at once.
    await Promise.all(["pg-a", "pg-b"].map((t) => mods.sweep.runConfluenceSweep(mods.db.db, t, { client, maxRequestsPerSite: 1, deltaIntervalMs: 0, leaseOwner: `w-${t}` })));
    const [a, b] = await Promise.all(["pg-a", "pg-b"].map((t) => mods.sweep.runConfluenceSweep(mods.db.db, t, { client, maxRequestsPerSite: 10, deltaIntervalMs: 0, leaseOwner: `w-${t}` })));
    const outcomes = [a.sites[0].outcome, b.sites[0].outcome].sort();
    expect(outcomes).toEqual(["lease_busy", "ran"]);
    const lease = (await sql`SELECT lease_owner FROM confluence_source_quota WHERE quota_key = ${`atlassian:confluence:${CLOUD}`}`)[0];
    expect(lease.lease_owner).toBeNull();
  });
});
