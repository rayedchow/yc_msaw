import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJira, NANGO_BASE, NANGO_KEY } from "./fake-jira.js";
import { bindingToken, YcStore } from "./yc-store.js";

/**
 * Jira deep lane against a real PostgreSQL (postgres-js + drizzle, every
 * source-lane migration in order, real journal triggers and bytea): sweep a fake
 * Jira through the production client, export with the production exporter into
 * the real yc_msaw SourceStore, then move and delete issues.
 *
 * Needs SOURCES_TEST_PG_URL (a superuser URL on the synthetic fixture cluster);
 * creates and drops its own database. Synthetic data only.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
const T = "tenant-jpg";
const CONN = "conn-jpg";
const CLOUD = "cloud-jpg";
const ROOT = `sources/jira/_sites/${CLOUD}/${CONN}`;
const BYTES = Buffer.concat([Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x89]), randomBytes(9 * 1024 * 1024)]); // > one 8 MiB chunk

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
let mods: Record<string, Any> = {};

describe.skipIf(!PG)("jira deep lane on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `jira_lane_${randomBytes(6).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.sweep = await import("../../../../src/source-lane/providers/jira/sweep.js");
    mods.api = await import("../../../../src/source-lane/providers/jira/api.js");
    mods.coverage = await import("../../../../src/source-lane/providers/jira/coverage.js");
    mods.index = await import("../../../../src/source-lane/providers/jira/index.js");
    mods.exporter = await import("../../../../src/source-lane/export/exporter.js");
    mods.bindings = await import("../../../../src/source-lane/export/bindings.js");
    mods.registry = await import("../../../../src/source-lane/registry.js");
  }, 120_000);

  afterAll(async () => {
    await mods.db?.pgClient?.end?.({ timeout: 5 }).catch(() => {});
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (adminSql && dbName) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await adminSql.end({ timeout: 5 }).catch(() => {});
    }
  });

  it("captures exact multi-chunk bytes, paged changelog and moves/deletes through real SQL", async () => {
    const fake = new FakeJira();
    fake.downloadMode = "direct";
    fake.site(CONN, CLOUD, "https://pg.atlassian.net");
    fake.projects.push({ id: "20000", key: "PG", name: "Postgres" }, { id: "20001", key: "NEW", name: "New home" });
    const hist = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(500000 + i), created: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(), authorId: "acct-1", items: [{ field: "status", fromString: `S${i}`, toString: `S${i + 1}` }] }));
    fake.issues.push(
      { id: "30001", key: "PG-1", projectId: "20000", summary: "Big attachment", description: "d", status: "Open", created: "2026-01-01T00:00:00.000+0000", updated: "2026-01-02T00:00:00.000+0000", comments: [], histories: hist(130), attachments: [{ id: "b1", filename: "dump.bin", mimeType: "application/octet-stream", created: "2026-01-01T00:00:00.000+0000", bytes: BYTES }] },
      { id: "30002", key: "PG-2", projectId: "20000", summary: "Doomed", description: "d", status: "Open", created: "2026-01-01T01:00:00.000+0000", updated: "2026-01-02T00:00:00.000+0000", comments: [], histories: [], attachments: [] },
    );
    await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES (${T}, 'jira', ${CONN}, 'active', ${sql.json({ providerConfigKey: "jira", nangoConnectionId: CONN })})`;
    const db = mods.db.db;
    const opts = { client: new mods.api.JiraClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch }), maxRequestsPerSite: 10_000, deltaIntervalMs: 0, fullScanIntervalMs: 365 * 24 * 3600_000, leaseOwner: "pg-test" };
    const sweep = async (extra: Record<string, unknown> = {}) => {
      for (let i = 0; i < 10; i++) {
        await mods.sweep.runJiraSweep(db, T, { ...opts, ...extra });
        extra = {};
        const [p] = await sql`SELECT count(*)::int AS n FROM jira_source_work WHERE tenant_id = ${T} AND state = 'pending' AND (not_before IS NULL OR not_before <= now())`;
        const [o] = await sql`SELECT count(*)::int AS n FROM jira_source_sync_state WHERE tenant_id = ${T} AND generation_phase <> 'closed'`;
        if (p.n === 0 && o.n === 0) return;
      }
      throw new Error("sweep did not settle");
    };
    await sweep();

    // The 9251 schedule migration ran before the connection existed; the journal triggers fired for real.
    const [journal] = await sql`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = ${T} AND table_name LIKE 'jira_source_%'`;
    expect(journal.n).toBeGreaterThan(0);
    const [chunks] = await sql`SELECT count(*)::int AS n, sum(size)::bigint AS bytes FROM jira_source_chunks WHERE tenant_id = ${T}`;
    expect(chunks).toEqual({ n: 2, bytes: String(BYTES.length) });

    const yc = await YcStore.create(T);
    await mods.bindings.setTenantBinding(db, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db, registry: new mods.registry.SourceProviderRegistry([mods.index.jiraProvider]), fetchImpl: yc.fetch, log: () => {} });
    const drain = async () => {
      for (let i = 0; i < 50; i++) {
        const r = await exporter.runOnce();
        expect(r.deadLettered).toBe(0);
        if (r.claimed === 0) return;
      }
      throw new Error("exporter did not drain");
    };
    await drain();
    const bin = await yc.file(`${ROOT}/projects/PG/issues/PG-1/attachments/b1/dump.bin`);
    expect(bin?.kind).toBe("binary");
    expect(bin?.bytes.equals(BYTES)).toBe(true);
    expect(await yc.text(`${ROOT}/projects/PG/issues/PG-1/changelog.md`)).toContain("- History entries captured: 130 of 130");

    fake.issue("30001").key = "NEW-1";
    fake.issue("30001").projectId = "20001";
    fake.issue("30001").updated = new Date().toISOString();
    fake.issue("30002").deleted = true;
    await sweep({ fullScanIntervalMs: 0 });
    await drain();
    expect((await yc.file(`${ROOT}/projects/NEW/issues/NEW-1/attachments/b1/dump.bin`))?.bytes.equals(BYTES)).toBe(true);
    expect((await yc.tombstone(`${ROOT}/projects/PG/issues/PG-1/issue.md`))?.reason).toBe("jira_issue_moved");
    expect((await yc.tombstone(`${ROOT}/projects/PG/issues/PG-2/issue.md`))?.reason).toBe("jira_not_found");
    const cov = await mods.coverage.jiraCoverage({ tenantId: T, executor: db });
    expect(cov.find((c: Any) => c.scope === `site:${CLOUD}/${CONN}`)?.state).toBe("complete");
  }, 120_000);
});
