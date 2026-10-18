import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJira, NANGO_BASE, NANGO_KEY } from "./fake-jira.js";
import { bindingToken, YcStore } from "./yc-store.js";

/**
 * Jira duplicate-sync fix on real PostgreSQL (jira-efficiency): with both default schedules enabled, the deep lane
 * writes the donor issue_detail / issue_comment rows and the sources/jira/<PROJECT>/<KEY>.md mirror through
 * postgres-js, the gated donor `nango.proxy_details` run makes no search, and the production exporter publishes both
 * the donor projection and the deep lane into the real yc_msaw SourceStore.
 *
 * Needs SOURCES_TEST_PG_URL (a superuser URL on the synthetic fixture cluster). It creates and drops its own database.
 * Synthetic data only.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
const T = "tenant-jeff-pg";
const CONN = "conn-jeff-pg";
const CLOUD = "cloud-jeff-pg";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
const mods: Record<string, Any> = {};

describe.skipIf(!PG)("jira duplicate sync fix on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `jira_eff_${randomBytes(6).toString("hex")}`;
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
    mods.index = await import("../../../../src/source-lane/providers/jira/index.js");
    mods.exporter = await import("../../../../src/source-lane/export/exporter.js");
    mods.bindings = await import("../../../../src/source-lane/export/bindings.js");
    mods.registry = await import("../../../../src/source-lane/registry.js");
    mods.dispatch = await import("../../../../src/queue/dispatch.js");
    mods.details = await import("../../../../src/integrations/nango/proxy-details.js");
    mods.nango = await import("../../../../src/integrations/nango/client.js");
  }, 120_000);

  afterAll(async () => {
    await mods.db?.pgClient?.end?.({ timeout: 5 }).catch(() => {});
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (adminSql && dbName) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await adminSql.end({ timeout: 5 }).catch(() => {});
    }
  });

  it("deep lane feeds every donor output once; the donor lane makes no search; both publish", async () => {
    const fake = new FakeJira();
    fake.site(CONN, CLOUD, "https://pg.atlassian.net");
    fake.projects.push({ id: "20000", key: "PG", name: "Postgres" });
    const comment = (i: number) => ({ id: `90${i}`, created: `2026-01-0${i + 1}T00:00:00.000+0000`, updated: `2026-01-0${i + 1}T00:00:00.000+0000`, authorId: `acct-${i}`, text: `Real PG comment ${i}` });
    fake.issues.push(
      { id: "30001", key: "PG-1", projectId: "20000", summary: "Busy", description: "d", status: "Open", created: "2026-01-01T00:00:00.000+0000", updated: "2026-01-09T00:00:00.000+0000", comments: [0, 1, 2, 3, 4].map(comment), histories: [], attachments: [] },
      { id: "30002", key: "PG-2", projectId: "20000", summary: "Quiet", description: "d", status: "Open", created: "2026-01-01T01:00:00.000+0000", updated: "2026-01-02T00:00:00.000+0000", comments: [], histories: [], attachments: [] },
    );
    await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES (${T}, 'jira', ${CONN}, 'active', ${sql.json({ providerConfigKey: "jira", nangoConnectionId: CONN })})`;
    await mods.dispatch.startNangoPolling(T, "jira");
    const db = mods.db.db;
    const deepCalls: string[] = [];
    const donorCalls: string[] = [];
    const counting = (into: string[]): typeof fetch => async (input, init) => {
      into.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
      return fake.fetch(input, init);
    };
    const opts = { client: new mods.api.JiraClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: counting(deepCalls) }), maxRequestsPerSite: 10_000, deltaIntervalMs: 0, fullScanIntervalMs: 365 * 24 * 3600_000, commentPageSize: 2, leaseOwner: "pg-eff" };
    for (let i = 0; i < 10; i++) {
      await mods.sweep.runJiraSweep(db, T, opts);
      const [p] = await sql`SELECT count(*)::int AS n FROM jira_source_work WHERE tenant_id = ${T} AND state = 'pending' AND (not_before IS NULL OR not_before <= now())`;
      if (p.n === 0) break;
    }
    const donor = new mods.nango.NangoClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: counting(donorCalls), retryDelayMs: 1 });
    const result = await mods.details.handleNangoProxyDetailsTask(db, { tenantId: T, provider: "jira" }, { client: donor });
    expect(result.deepLane).toBe(true);
    expect(donorCalls.filter((p) => p.endsWith("/search/jql") || p.includes("/comment"))).toEqual([]);

    const events = await sql`SELECT event_type, count(*)::int AS n, count(DISTINCT source_event_id)::int AS d FROM activity_events WHERE user_id = ${T} AND source = 'jira' GROUP BY 1 ORDER BY 1`;
    expect(events.map((e: Any) => [e.event_type, e.n, e.d])).toEqual([["issue_comment", 5, 5], ["issue_detail", 2, 2]]);
    const [detail] = await sql`SELECT raw_payload FROM activity_events WHERE user_id = ${T} AND event_type = 'issue_detail' AND raw_payload->>'id' = '30001'`;
    expect(detail.raw_payload.cloudId).toBe(CLOUD);
    expect(detail.raw_payload.web_url).toBe("https://pg.atlassian.net/browse/PG-1");
    const [mirror] = await sql`SELECT content FROM mirror_files WHERE user_id = ${T} AND path = 'sources/jira/PG/PG-1.md'`;
    for (let i = 0; i < 5; i++) expect(mirror.content).toContain(`Real PG comment ${i}`);
    expect(mirror.content).not.toContain("Comments omitted");

    const yc = await YcStore.create(T);
    await mods.bindings.setTenantBinding(db, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db, registry: new mods.registry.SourceProviderRegistry([mods.index.jiraProvider]), fetchImpl: yc.fetch, log: () => {} });
    for (let i = 0; i < 50; i++) {
      const r = await exporter.runOnce();
      expect(r.deadLettered).toBe(0);
      if (r.claimed === 0) break;
    }
    expect(await yc.text("sources/jira/PG/PG-1.md")).toContain("Real PG comment 4");
    expect(await yc.text(`sources/jira/_sites/${CLOUD}/${CONN}/projects/PG/issues/PG-1/issue.md`)).toBeTruthy();
    console.log(`[jira-efficiency pg] deep requests ${deepCalls.length}, donor requests ${donorCalls.length} (${donorCalls.join(", ")})`);
  }, 120_000);
});
