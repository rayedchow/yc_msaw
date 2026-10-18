import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bitbucketCoverage } from "../../../../src/source-lane/providers/bitbucket/coverage.js";
import { setSelection } from "../../../../src/source-lane/providers/bitbucket/store.js";
import { FakeBitbucket, fakeUuid, type FakeRepo } from "./fake-bitbucket.js";
import { codePath, drain, headPath, makeExporter, ROOT, select, sweep, sweepUntilQuiet } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

/**
 * Grants, tenancy and disappearance: per-tenant connections and quota identity, partial
 * permissions that must never read as complete, and deletion/unselection tombstones.
 */

const REPO = "team/api";
const FILES = { "README.md": "# API\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };

let fake: FakeBitbucket;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  fake = new FakeBitbucket();
});

async function coverageOf(tenantId: string, scope: string) {
  return (await bitbucketCoverage({ tenantId, executor: db as never })).find((c) => c.scope === scope);
}

describe("Bitbucket grants and tenancy", () => {
  it("reads each tenant only through its own connection, keeps data per tenant and attributes quota to the Bitbucket account", async () => {
    const accountShared = fakeUuid();
    fake.accounts.set("conn-t1", accountShared);
    fake.accounts.set("conn-t2", fakeUuid());
    fake.accounts.set("conn-t3", accountShared); // a second tenant connecting the SAME Bitbucket account
    const repo = fake.addRepo(REPO, { readers: ["conn-t1", "conn-t2", "conn-t3"] });
    fake.setBranch(repo, "main", fake.commit(FILES));
    for (const [t, c] of [["t1", "conn-t1"], ["t2", "conn-t2"], ["t3", "conn-t3"]] as const) {
      await connect(t, c);
      await select(t, REPO);
    }
    const one = await makeExporter("t1");
    const two = await makeExporter("t2");
    await sweepUntilQuiet(fake, "t1");
    await drain(one.exporter);
    expect(new Set(fake.requests.map((r) => r.connectionId))).toEqual(new Set(["conn-t1"]));
    expect(await one.yc.text(codePath(REPO, "main", "README.md"))).toBe("# API\n");
    await drain(two.exporter);
    expect(await two.yc.paths()).toEqual([]); // nothing of t1 leaks into t2's namespace

    const n = fake.requests.length;
    await sweepUntilQuiet(fake, "t2");
    expect(new Set(fake.requests.slice(n).map((r) => r.connectionId))).toEqual(new Set(["conn-t2"]));
    expect((await query(`SELECT tenant_id, count(*)::int AS n FROM bitbucket_source_files GROUP BY tenant_id ORDER BY tenant_id`)).map((r) => [r.tenant_id, r.n])).toEqual([
      ["t1", 3],
      ["t2", 3],
    ]);
    const keys = await query<{ tenant_id: string; quota_key: string }>(`SELECT tenant_id, quota_key FROM bitbucket_source_connections ORDER BY tenant_id`);
    expect(keys[0]!.quota_key).toBe(`bitbucket:account:${accountShared}`);
    expect(keys[1]!.quota_key).not.toBe(keys[0]!.quota_key);

    // t1's account is rate limited: t3 (same account, different tenant) waits instead of spending the same budget.
    await query(`UPDATE bitbucket_source_quota SET blocked_until = now() + interval '10 minutes', blocked_kind = 'rate_limit' WHERE quota_key = $1`, [keys[0]!.quota_key]);
    const m = fake.requests.length;
    const r3 = await sweep(fake, "t3");
    expect(r3.quotas).toEqual([expect.objectContaining({ quotaKey: `bitbucket:account:${accountShared}`, outcome: "deferred" })]);
    expect(fake.requests.slice(m).map((r) => r.path)).toEqual(["/user"]); // identity lookup only
  });

  it("a grant without source access is blocked, never complete, and captured files are kept", async () => {
    fake.accounts.set("conn-1", fakeUuid());
    const repo = fake.addRepo(REPO, { readers: ["conn-1"] });
    const c1 = fake.commit(FILES);
    fake.setBranch(repo, "main", c1);
    await connect("t", "conn-1");
    await select("t", REPO);
    const { exporter, yc } = await makeExporter("t");
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    expect((await coverageOf("t", `repo:${REPO}@main`))!.state).toBe("complete");

    // The OAuth consumer loses the repository scope for source reads (403 on /src).
    const c2 = fake.commit({ ...FILES, "src/c.ts": "c\n" });
    fake.setBranch(repo, "main", c2);
    fake.failNext((p) => p.includes(`/src/${c2}/`) || p.includes(`/diffstat/`), 403, { times: 999 });
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    const cov = (await coverageOf("t", `repo:${REPO}@main`))!;
    expect(cov.state).toBe("blocked");
    expect(await yc.text(codePath(REPO, "main", "src/a.ts"))).toBe("export const a = 1;\n");

    // Repository-level 403 through every grant: blocked, files kept (access loss is not deletion).
    fake.noAccessStatus = 403;
    fake.revoke("conn-1", repo);
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    expect((await coverageOf("t", `repo:${REPO}`))!).toMatchObject({ state: "blocked" });
    expect(await yc.text(codePath(REPO, "main", "README.md"))).toBe("# API\n");
  });

  it("an unauthorized Nango connection blocks that grant instead of reporting coverage", async () => {
    const repo = fake.addRepo(REPO, { readers: [] });
    fake.setBranch(repo, "main", fake.commit(FILES));
    await connect("t", "conn-gone");
    await select("t", REPO);
    const r = await sweep(fake, "t");
    expect(r.notes.join(" ")).toMatch(/unauthorized/);
    const cov = await bitbucketCoverage({ tenantId: "t", executor: db as never });
    expect(cov).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "connection:conn-gone", state: "blocked" })]));
    expect(cov.some((c) => c.state === "complete")).toBe(false);
  });
});

describe("Bitbucket deletions, renames and scope", () => {
  let repo: FakeRepo;

  beforeEach(async () => {
    fake.accounts.set("conn-1", fakeUuid());
    repo = fake.addRepo(REPO, { readers: ["conn-1"] });
    fake.setBranch(repo, "main", fake.commit(FILES));
    await connect("t", "conn-1");
    await select("t", REPO, ["release/1.x"]);
  });

  it("tombstones a deleted branch's files at a new generation and recaptures it when it comes back", async () => {
    const rel = fake.commit({ ...FILES, "CHANGELOG.md": "1.0\n" });
    fake.setBranch(repo, "release/1.x", rel);
    const { exporter, yc } = await makeExporter("t");
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    expect(await yc.text(codePath(REPO, "release%2F1.x", "CHANGELOG.md"))).toBe("1.0\n");

    fake.setBranch(repo, "release/1.x", null);
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    expect(await yc.tombstone(codePath(REPO, "release%2F1.x", "CHANGELOG.md"))).toMatchObject({ reason: "bitbucket_branch_deleted" });
    expect(await yc.text(codePath(REPO, "main", "README.md"))).toBe("# API\n");

    fake.setBranch(repo, "release/1.x", rel);
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    expect((await yc.file(codePath(REPO, "release%2F1.x", "CHANGELOG.md")))!.ordinal).toBe(3);
  });

  it("follows a repository rename by UUID and moves its files to the new path", async () => {
    const { exporter, yc } = await makeExporter("t");
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    repo.fullName = "team/api-renamed";
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    expect(await yc.text(codePath("team/api-renamed", "main", "README.md"))).toBe("# API\n");
    expect(await yc.file(codePath(REPO, "main", "README.md"))).toBeNull();
    expect((await yc.json(`${ROOT}/team/api-renamed/code/_repo.json`)).fullName).toBe("team/api-renamed");
    expect(fake.requests.some((r) => decodeURIComponent(r.path) === `/repositories/${repo.workspaceUuid}/${repo.uuid}`)).toBe(true);
  });

  it("tombstones a repository only after repeated not-found checks; a single 404 keeps the files", async () => {
    const { exporter, yc } = await makeExporter("t");
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    fake.repos.splice(fake.repos.indexOf(repo), 1);
    await sweep(fake, "t");
    await drain(exporter);
    expect(await yc.text(codePath(REPO, "main", "README.md"))).toBe("# API\n");
    expect((await coverageOf("t", `repo:${REPO}`))!.state).toBe("blocked");

    await sweep(fake, "t");
    await drain(exporter);
    expect(await yc.tombstone(codePath(REPO, "main", "README.md"))).toMatchObject({ reason: "bitbucket_repository_not_found" });
    expect(await yc.tombstone(`${ROOT}/${REPO}/code/_repo.json`)).toMatchObject({ reason: "bitbucket_repository_not_found" });
    expect((await coverageOf("t", `repo:${REPO}`))!.reason).toMatch(/tombstoned/);
  });

  it("unselecting removes the repository from the current view (history kept); reselecting restores it without refetching", async () => {
    const { exporter, yc } = await makeExporter("t");
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    await setSelection(db as never, { tenantId: "t", fullName: REPO, selected: false });
    await sweep(fake, "t");
    await drain(exporter);
    expect(await yc.tombstone(codePath(REPO, "main", "src/a.ts"))).toMatchObject({ reason: "bitbucket_repo_out_of_scope" });
    expect(await yc.tombstone(headPath(REPO, "main"))).toMatchObject({ reason: "bitbucket_repo_out_of_scope" });
    expect(await yc.history(codePath(REPO, "main", "src/a.ts"))).toHaveLength(2);

    await select("t", REPO);
    const n = fake.requests.length;
    await sweepUntilQuiet(fake, "t");
    await drain(exporter);
    expect(await yc.text(codePath(REPO, "main", "src/a.ts"))).toBe("export const a = 1;\n");
    expect(fake.requests.slice(n).some((r) => r.path.includes("/src/"))).toBe(false);
  });
});
