import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { binaryBytes, FakeBitbucket, fakeUuid, NANGO_BASE, NANGO_KEY } from "./fake-bitbucket.js";
import { BINDING_ID, bindingToken, YcStore } from "./yc-store.js";

/**
 * Bitbucket content lane against a real PostgreSQL (postgres-js + drizzle, every source-lane
 * migration in order, real journal triggers, transactions and bytea): scan a fake Bitbucket
 * through the production client, export with the production exporter into the real yc_msaw
 * SourceStore, then roll the branch back A->B->A.
 *
 * Needs SOURCES_TEST_PG_URL (a superuser URL on the synthetic fixture cluster); creates and
 * drops its own database. Synthetic data only.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
const T = "tenant-bbpg";
const CONN = "conn-bbpg";
const REPO = "team/pg";
// More than one 8 MiB chunk, with NUL / non-UTF-8 bytes.
const BIG = Buffer.concat([binaryBytes(3, 64), randomBytes(9 * 1024 * 1024)]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
const mods: Record<string, Any> = {};

describe.skipIf(!PG)("bitbucket content lane on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `bitbucket_lane_${randomBytes(6).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.content = await import("../../../../src/source-lane/providers/bitbucket/content.js");
    mods.api = await import("../../../../src/source-lane/providers/bitbucket/api.js");
    mods.store = await import("../../../../src/source-lane/providers/bitbucket/store.js");
    mods.coverage = await import("../../../../src/source-lane/providers/bitbucket/coverage.js");
    mods.index = await import("../../../../src/source-lane/providers/bitbucket/index.js");
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

  it("captures exact multi-chunk bytes and orders an A->B->A rollback by generation through real SQL", async () => {
    const fake = new FakeBitbucket();
    fake.accounts.set(CONN, fakeUuid());
    const repo = fake.addRepo(REPO, { readers: [CONN] });
    const cA = fake.commit({ "README.md": "# A\n", "data/big.bin": BIG, "src/x.ts": "x\n" });
    const cB = fake.commit({ "README.md": "# B\n", "data/big.bin": BIG, "src/y.ts": "x\n" });
    await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES (${T}, 'bitbucket', ${CONN}, 'active', ${sql.json({ providerConfigKey: "bitbucket", nangoConnectionId: CONN })})`;
    const db = mods.db.db;
    await mods.store.setSelection(db, { tenantId: T, fullName: REPO, selected: true });
    const client = new mods.api.BitbucketClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch });
    const sweep = async () => {
      for (let i = 0; i < 20; i++) {
        const r = await mods.content.runBitbucketContentSweep(db, T, { client, leaseOwner: "pg-test" });
        if (!r.quotas.some((q: Any) => q.outcome !== "ran" || q.refs.some((x: Any) => x.outcome === "in_progress"))) return r;
      }
      throw new Error("sweep did not settle");
    };
    const yc = await YcStore.create(T);
    await mods.bindings.setTenantBinding(db, { tenantId: T, bindingId: BINDING_ID, token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const registry = new mods.registry.SourceProviderRegistry([mods.index.bitbucketProvider]);
    const exporter = new mods.exporter.SourceExporter({ db, registry, fetchImpl: yc.fetch, log: () => {} });
    const drain = async () => {
      for (let i = 0; i < 50; i++) {
        const r = await exporter.runOnce();
        expect(r.deadLettered).toBe(0);
        if (r.claimed === 0) return;
      }
      throw new Error("exporter did not drain");
    };
    const file = (p: string) => `sources/bitbucket/${REPO}/code/main/files/${p}`;

    fake.setBranch(repo, "main", cA);
    await sweep();
    await drain();
    const big = (await yc.file(file("data/big.bin")))!;
    expect(big.kind).toBe("binary");
    expect(big.bytes.length).toBe(BIG.length);
    expect(createHash("sha256").update(big.bytes).digest("hex")).toBe(createHash("sha256").update(BIG).digest("hex"));
    const [chunks] = await sql`SELECT jsonb_array_length(chunks) AS n FROM bitbucket_source_blobs WHERE tenant_id = ${T} AND size = ${BIG.length}`;
    expect(chunks.n).toBe(2);

    fake.setBranch(repo, "main", cB);
    await sweep();
    await drain();
    fake.setBranch(repo, "main", cA);
    await sweep();
    await drain();
    const readme = (await yc.file(file("README.md")))!;
    expect(readme.bytes.toString()).toBe("# A\n");
    expect(readme.ordinal).toBe(3);
    expect(await yc.text(file("src/x.ts"))).toBe("x\n");
    expect(await yc.tombstone(file("src/y.ts"))).toMatchObject({ reason: "bitbucket_renamed" });
    expect((await yc.file(file("data/big.bin")))!.ordinal).toBe(1); // unchanged across all three generations
    const [ref] = await sql`SELECT committed_generation, committed_commit_sha, committed_mode FROM bitbucket_source_refs WHERE tenant_id = ${T}`;
    expect(ref).toMatchObject({ committed_generation: 3, committed_commit_sha: cA, committed_mode: "diff" });
    const cov = await mods.coverage.bitbucketCoverage({ tenantId: T, executor: db });
    expect(cov.find((c: Any) => c.scope === `repo:${REPO}@main`)).toMatchObject({ state: "complete" });
  }, 120_000);
});
