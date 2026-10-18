import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGithub, NANGO_BASE, NANGO_KEY } from "./fake-github.js";
import { bindingToken, YcStore } from "./yc-store.js";

/**
 * GitHub content lane on a real PostgreSQL (SOURCES_TEST_PG_URL, synthetic fixture cluster):
 * the full source-lane migration plan (incl. 9300/9301), journal triggers, bytea chunk round
 * trips, real transactions with SELECT ... FOR UPDATE for the generation-guarded commit, the
 * per-installation quota lease under real concurrency across tenants, and the exporter into the
 * real yc_msaw store. Creates and drops its own database; never touches another one.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
const mods: Record<string, Any> = {};
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

async function connect(t: string, c: string, installationId?: string): Promise<void> {
  await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES (${t}, 'github', ${c}, 'active', ${sql.json({ providerConfigKey: "github", ...(installationId ? { installationId } : {}) })})`;
}

describe.skipIf(!PG)("github content lane on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `github_lane_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.content = await import("../../../../src/source-lane/providers/github/content.js");
    mods.store = await import("../../../../src/source-lane/providers/github/store.js");
    mods.api = await import("../../../../src/source-lane/providers/github/api.js");
    mods.coverage = await import("../../../../src/source-lane/providers/github/coverage.js");
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

  it("applies 9300/9301, captures exact bytes through bytea and exports them with generation ordinals", async () => {
    expect(await mods.migrations.pendingSourceLaneMigrations(sql)).toEqual([]);
    const applied = (await sql`SELECT name FROM schema_migrations WHERE name ~ '^93[0-4][0-9]_' ORDER BY name`).map((r: Any) => r.name);
    expect(applied).toEqual(["9300_github_source_lane.sql", "9301_github_content_schedules.sql"]);
    const triggers = (await sql`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_source_lane_journal_github_%' ORDER BY tgname`).map((r: Any) => r.tgname);
    expect(triggers).toEqual(["trg_source_lane_journal_github_files", "trg_source_lane_journal_github_refs", "trg_source_lane_journal_github_repos", "trg_source_lane_journal_github_snapshots"]);

    const T = "pg-gh1";
    await connect(T, "conn-1");
    await sql`INSERT INTO github_repo_sync (tenant_id, repo_full_name, syncing) VALUES (${T}, 'acme/widgets', true)`;
    const fake = new FakeGithub();
    fake.repo(1, "acme/widgets");
    const big = Buffer.alloc(9 * 1024 * 1024 + 17, 0);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    const A = fake.commit(1, "main", { "logo.png": PNG, "big.bin": big, "a.txt": "A" });
    const client = new mods.api.GithubClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch });
    const opts = { client, maxRequestsPerQuota: 10_000, reserveRemaining: 0, leaseOwner: "pg-worker" };
    for (let i = 0; i < 3; i++) await mods.content.runGithubContentSweep(mods.db.db, T, opts);
    const chunks = (await sql`SELECT size FROM github_source_chunks WHERE tenant_id = ${T} ORDER BY size DESC`).map((r: Any) => r.size);
    expect(chunks[0]).toBe(8 * 1024 * 1024);

    const yc = await YcStore.create(T);
    await mods.bindings.setTenantBinding(mods.db.db, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, registry: mods.registry.defaultRegistry(), fetchImpl: yc.fetch, log: () => {} });
    const drain = async () => {
      for (let i = 0; i < 50; i++) {
        const r = await exporter.runOnce();
        expect(r.deadLettered).toBe(0);
        if (r.claimed === 0) break;
      }
    };
    await drain();
    const M = "sources/github/acme/widgets/code/main";
    expect((await yc.file(`${M}/files/logo.png`))?.bytes.equals(PNG)).toBe(true);
    expect((await yc.file(`${M}/files/big.bin`))?.bytes.equals(big)).toBe(true);

    // A -> B -> A on real PostgreSQL.
    fake.commit(1, "main", { "logo.png": PNG, "big.bin": big, "a.txt": "B" }, { date: "2001-01-01T00:00:00Z" });
    for (let i = 0; i < 2; i++) await mods.content.runGithubContentSweep(mods.db.db, T, opts);
    await drain();
    expect(await yc.text(`${M}/files/a.txt`)).toBe("B");
    fake.setBranch(1, "main", A);
    for (let i = 0; i < 2; i++) await mods.content.runGithubContentSweep(mods.db.db, T, opts);
    await drain();
    expect(await yc.file(`${M}/files/a.txt`)).toMatchObject({ ordinal: 3 });
    expect(await yc.text(`${M}/files/a.txt`)).toBe("A");
    expect((await yc.file(`${M}/files/big.bin`))?.ordinal).toBe(1);
    const cov = await mods.coverage.githubCoverage({ tenantId: T, executor: mods.db.db });
    expect(cov.find((c: Any) => c.scope === "repo:acme/widgets@main")).toMatchObject({ state: "complete", cursor: A });
  });

  it("commits a generation exactly once when two workers race to commit it (row lock), and never an older one", async () => {
    const T = "pg-race";
    await connect(T, "conn-r");
    await sql`INSERT INTO github_repo_sync (tenant_id, repo_full_name, syncing) VALUES (${T}, 'acme/race', true)`;
    const fake = new FakeGithub();
    fake.repo(2, "acme/race", { connections: ["conn-r"] });
    fake.commit(2, "main", { "f.txt": "x" });
    const client = new mods.api.GithubClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch });
    // Stop after repo + HEAD + commit + recursive tree (4 requests): the blob is still pending.
    await mods.content.runGithubContentSweep(mods.db.db, T, { client, maxRequestsPerQuota: 4, reserveRemaining: 0, leaseOwner: "w" });
    const scope = { tenantId: T, repoId: "2", ref: "main" };
    let ref = await mods.store.getRef(mods.db.db, scope);
    expect(ref).toMatchObject({ committed_generation: null, scan_generation: 1, scan_phase: "blobs" });
    const bytes = Buffer.from("x");
    const blobSha = mods.api.gitBlobSha(bytes);
    await mods.store.storeBlob(mods.db.db, T, blobSha, bytes, true);
    await mods.store.markBlobState(mods.db.db, scope, 1, blobSha, "stored");
    await mods.store.setScanPhase(mods.db.db, scope, 1, "ready");
    const results = await Promise.all([mods.store.commitScan(mods.db.db, scope, 1), mods.store.commitScan(mods.db.db, scope, 1)]);
    expect(results.map((r: Any) => r.outcome).sort()).toEqual(["committed", "superseded"]);
    ref = await mods.store.getRef(mods.db.db, scope);
    expect(ref.committed_generation).toBe(1);
    expect((await sql`SELECT count(*)::int AS n FROM github_source_snapshots WHERE tenant_id = ${T}`)[0].n).toBe(1);
    expect((await mods.store.commitScan(mods.db.db, scope, 1)).outcome).toBe("superseded");
  });

  it("lets exactly one worker use a GitHub installation's quota at a time, across tenants", async () => {
    const fake = new FakeGithub();
    for (const [t, c, id, name] of [["pg-ia", "conn-ia", 10, "org/a"], ["pg-ib", "conn-ib", 11, "org/b"]] as const) {
      fake.repo(id, name, { connections: [c] });
      fake.commit(id, "main", { "x.txt": name });
      await connect(t, c, "4242");
      await sql`INSERT INTO github_repo_sync (tenant_id, repo_full_name, syncing) VALUES (${t}, ${name}, true)`;
    }
    const slow: typeof fetch = async (i, init) => {
      await new Promise((r) => setTimeout(r, 20));
      return fake.fetch(i, init);
    };
    const client = new mods.api.GithubClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: slow });
    const [a, b] = await Promise.all(["pg-ia", "pg-ib"].map((t) => mods.content.runGithubContentSweep(mods.db.db, t, { client, maxRequestsPerQuota: 50, reserveRemaining: 0, leaseOwner: `w-${t}` })));
    expect([a.quotas[0].outcome, b.quotas[0].outcome].sort()).toEqual(["lease_busy", "ran"]);
    expect(a.quotas[0].quotaKey).toBe("github:installation:4242");
    const lease = (await sql`SELECT lease_owner FROM github_source_quota WHERE quota_key = 'github:installation:4242'`)[0];
    expect(lease.lease_owner).toBeNull();
  });
});
