import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bitbucketCoverage } from "../../../../src/source-lane/providers/bitbucket/coverage.js";
import { mapFileRow } from "../../../../src/source-lane/providers/bitbucket/export-map.js";
import { commitScan, getRef, type BitbucketDb } from "../../../../src/source-lane/providers/bitbucket/store.js";
import { binaryBytes, FakeBitbucket, fakeUuid, type FakeRepo } from "./fake-bitbucket.js";
import { codePath, drain, headPath, makeExporter, ROOT, select, sweep, sweepUntilQuiet } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";
import { BINDING_ID } from "./yc-store.js";

const T = "tenant-bb";
const CONN = "bb-conn-1";
const REPO = "team/api";

function sha256(b: Buffer | string): string {
  return createHash("sha256").update(b).digest("hex");
}

const PNG = binaryBytes(1);
const TREE_A = {
  "README.md": "# API\n\n> quoted line\n\nBody.\n",
  "src/index.ts": "export const x = 1;\n",
  "src/lib/util.ts": "export const util = () => 42;\n",
  "src/lib/more.ts": "export const more = 2;\n",
  "assets/logo.png": PNG,
  "assets/link": { bytes: Buffer.from("../README.md"), attributes: ["link"] },
  "bin/tool.sh": { bytes: Buffer.from("#!/bin/sh\necho hi\n"), attributes: ["executable"] },
  "vendor/sub": { bytes: Buffer.alloc(0), attributes: ["subrepository"] },
  "docs/a.md": "# A\n",
  "docs/b.md": "# B\n",
  "docs/c.md": "# C\n",
};
const TREE_B = {
  ...TREE_A,
  "README.md": "# API v2\n\n> quoted line, edited\n",
  "docs/new.md": "# New\n",
  "src/lib/helpers.ts": "export const util = () => 42;\n",
} as Record<string, unknown>;
delete TREE_B["src/index.ts"];
delete TREE_B["src/lib/util.ts"];

let fake: FakeBitbucket;
let repo: FakeRepo;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  fake = new FakeBitbucket();
  fake.accounts.set(CONN, fakeUuid());
  repo = fake.addRepo(REPO, { readers: [CONN] });
  await connect(T, CONN);
  await select(T, REPO);
});

describe("Bitbucket repository content capture", () => {
  it("captures every file at the exact HEAD commit through paginated directory listings, with exact binary bytes", async () => {
    const c1 = fake.commit(TREE_A);
    fake.setBranch(repo, "main", c1);
    const { exporter, yc } = await makeExporter(T);
    await sweepUntilQuiet(fake, T);
    await drain(exporter);

    const readme = (await yc.file(codePath(REPO, "main", "README.md")))!;
    expect(readme.bytes.toString("utf8")).toBe(TREE_A["README.md"]);
    expect(readme).toMatchObject({ kind: "raw", contentType: "text/markdown; charset=utf-8", ordinal: 1, versionRef: `${c1}:${sha256(TREE_A["README.md"])}` });
    expect(readme.provenance).toMatchObject({ provider: "bitbucket", repository: REPO, ref: "main", repoPath: "README.md", commitSha: c1, generation: 1 });

    const logo = (await yc.file(codePath(REPO, "main", "assets/logo.png")))!;
    expect(logo.kind).toBe("binary");
    expect(logo.contentType).toBe("image/png");
    expect(logo.bytes.equals(PNG)).toBe(true);
    expect((await yc.file(codePath(REPO, "main", "assets/link")))!.provenance).toMatchObject({ symlink: true, attributes: ["link"] });
    expect((await yc.file(codePath(REPO, "main", "bin/tool.sh")))!.provenance).toMatchObject({ attributes: ["executable"] });
    expect(await yc.text(codePath(REPO, "main", "src/lib/more.ts"))).toBe(TREE_A["src/lib/more.ts"]);
    // A submodule has no bytes: listed as omitted in the manifest, never a placeholder file.
    expect(await yc.file(codePath(REPO, "main", "vendor/sub"))).toBeNull();

    const head = await yc.json(headPath(REPO, "main"));
    expect(head).toMatchObject({ schema: "procmem.bitbucket-ref-head/v1", commitSha: c1, generation: 1, mode: "full", complete: true });
    expect(head.omitted).toEqual([{ path: "vendor/sub", reason: "submodule", size: null, attributes: ["subrepository"] }]);
    expect(head.raw.hash).toBe(c1);
    const snap = await yc.json(`${ROOT}/${REPO}/code/main/_snapshots/g00000001.json`);
    expect(snap).toMatchObject({ generation: 1, previousGeneration: null, commitSha: c1, mode: "full", complete: true });
    expect((await yc.json(`${ROOT}/${REPO}/code/_repo.json`)).raw.uuid).toBe(repo.uuid);

    // Every directory was paged (2 entries per page) and resumed from Bitbucket's own next URLs.
    const root = fake.requestsMatching(new RegExp(`/src/${c1}/$`));
    expect(root.map((r) => r.params.page ?? "1")).toEqual(["1", "2", "3", "4"]);
    expect(fake.requestsMatching(new RegExp(`/src/${c1}/src/lib/$`)).length).toBe(1);
    // Every upstream call went through this tenant's own Nango connection, never a raw token.
    expect(new Set(fake.requests.map((r) => `${r.connectionId}|${r.providerConfigKey}`))).toEqual(new Set([`${CONN}|bitbucket`]));

    const cov = await bitbucketCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === `repo:${REPO}@main`)).toMatchObject({ state: "complete", cursor: c1 });
  });

  it("applies an incremental diffstat: edits, deletes and renames become versions and tombstones; unchanged files are not re-versioned", async () => {
    const c1 = fake.commit(TREE_A);
    fake.setBranch(repo, "main", c1);
    const { exporter, yc } = await makeExporter(T);
    await sweepUntilQuiet(fake, T);
    await drain(exporter);

    const c2 = fake.commit(TREE_B as never);
    fake.setBranch(repo, "main", c2);
    const before = fake.requests.length;
    await sweepUntilQuiet(fake, T);
    await drain(exporter);
    const second = fake.requests.slice(before);
    expect(second.some((r) => r.path.includes(`/diffstat/${c2}..${c1}`) && r.params.topic === "false")).toBe(true);
    expect(second.some((r) => r.path.endsWith(`/src/${c2}/`)), "an incremental scan must not re-list the tree").toBe(false);

    const readme = (await yc.file(codePath(REPO, "main", "README.md")))!;
    expect(readme.bytes.toString()).toBe(TREE_B["README.md"]);
    expect(readme.ordinal).toBe(2);
    expect(await yc.history(codePath(REPO, "main", "README.md"))).toHaveLength(2);
    expect(await yc.tombstone(codePath(REPO, "main", "src/index.ts"))).toMatchObject({ reason: "bitbucket_deleted" });
    expect(await yc.tombstone(codePath(REPO, "main", "src/lib/util.ts"))).toMatchObject({ reason: "bitbucket_renamed" });
    const moved = (await yc.file(codePath(REPO, "main", "src/lib/helpers.ts")))!;
    expect(moved.provenance).toMatchObject({ renamedFrom: "src/lib/util.ts", generation: 2 });
    expect(await yc.text(codePath(REPO, "main", "docs/new.md"))).toBe("# New\n");
    // Unchanged bytes keep their generation: no new version.
    const logo = (await yc.file(codePath(REPO, "main", "assets/logo.png")))!;
    expect(logo.ordinal).toBe(1);
    expect(await yc.history(codePath(REPO, "main", "assets/logo.png"))).toHaveLength(1);

    const snap = await yc.json(`${ROOT}/${REPO}/code/main/_snapshots/g00000002.json`);
    expect(snap).toMatchObject({ generation: 2, previousGeneration: 1, mode: "diff", baseCommitSha: c1, commitSha: c2, complete: true });
    expect(snap.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "renamed", path: "src/lib/helpers.ts", from: "src/lib/util.ts" }),
        expect.objectContaining({ op: "deleted", path: "src/index.ts" }),
        expect.objectContaining({ op: "modified", path: "README.md" }),
        expect.objectContaining({ op: "added", path: "docs/new.md" }),
      ]),
    );
    expect(snap.counts).toMatchObject({ added: 1, modified: 1, renamed: 1, deleted: 1 });
  });

  it("orders by scan generation, not commit dates or SHAs: an A->B->A rollback is a newer state and a late older export is refused", async () => {
    const cA = fake.commit(TREE_A);
    const cB = fake.commit(TREE_B as never);
    const { exporter, yc } = await makeExporter(T);
    fake.setBranch(repo, "main", cA);
    await sweepUntilQuiet(fake, T);
    await drain(exporter);
    fake.setBranch(repo, "main", cB);
    await sweepUntilQuiet(fake, T);
    await drain(exporter);

    // The exporter's own mapping of README at generation 2 (B), held back as a "late" delivery.
    const readmeKey = (await query<{ row_key: string }>(`SELECT row_key FROM bitbucket_source_files WHERE tenant_id = $1 AND path = 'README.md'`, [T]))[0]!.row_key;
    const [lateB] = (await mapFileRow({ tenantId: T, executor: db as never }, readmeKey, { op: "UPDATE", enqueuedAt: new Date().toISOString() }, [])) as any[];
    expect(lateB.sourceVersion.ordinal).toBe(2);
    const lateBytes = await lateB.chunked.load(lateB.chunked.chunks[0].sha256);

    fake.setBranch(repo, "main", cA); // rollback to an older commit (whose author date is older, too)
    await sweepUntilQuiet(fake, T);
    await drain(exporter);
    const readme = (await yc.file(codePath(REPO, "main", "README.md")))!;
    expect(readme.bytes.toString()).toBe(TREE_A["README.md"]);
    expect(readme.ordinal).toBe(3);
    expect(readme.versionRef).toBe(`${cA}:${sha256(TREE_A["README.md"])}`);
    expect((await yc.history(codePath(REPO, "main", "README.md"))).length).toBe(3);
    expect(await yc.text(codePath(REPO, "main", "src/index.ts"))).toBe(TREE_A["src/index.ts"]);
    expect(await yc.tombstone(codePath(REPO, "main", "src/lib/helpers.ts"))).toMatchObject({ reason: "bitbucket_renamed" });
    expect(await yc.json(headPath(REPO, "main"))).toMatchObject({ commitSha: cA, generation: 3 });

    // The held-back generation-2 state arrives after generation 3: the store refuses it as stale.
    const receipt = await yc.store.applyBatch(
      { bindingId: BINDING_ID, providers: ["*"] },
      {
        batchId: "late-b",
        changes: [
          {
            op: "put",
            path: lateB.path,
            kind: lateB.kind,
            contentType: lateB.contentType,
            sha256: sha256(lateBytes),
            size: lateBytes.length,
            inline: lateBytes.toString("base64"),
            sourceUpdatedAt: null,
            capturedAt: new Date(Date.now() + 60_000).toISOString(),
            sourceVersion: lateB.sourceVersion,
            provenance: lateB.provenance,
          },
        ],
      },
    );
    expect(receipt.results[0].outcome).toBe("stale");
    expect((await yc.file(codePath(REPO, "main", "README.md")))!.bytes.toString()).toBe(TREE_A["README.md"]);
  });

  it("refuses a late completion of an older scan generation (worker that lost the race), keeping the newer commit", async () => {
    const cA = fake.commit(TREE_A);
    const cB = fake.commit(TREE_B as never);
    const { exporter, yc } = await makeExporter(T);
    fake.setBranch(repo, "main", cA);
    await sweepUntilQuiet(fake, T);
    // Worker 1 starts scanning B and stalls with a tiny budget (generation 2 stays in progress).
    fake.setBranch(repo, "main", cB);
    const w1 = await sweep(fake, T, { maxRequestsPerQuota: 3, leaseOwner: "worker-1" });
    expect(w1.quotas[0]!.refs[0]).toMatchObject({ outcome: "in_progress" });
    const scope = { tenantId: T, repoUuid: repo.uuid, ref: "main" };
    expect((await getRef(db as never, scope))!.scan_generation).toBe(2);

    // The branch rolls back to A; worker 2 replaces the stale scan and commits generation 3.
    fake.setBranch(repo, "main", cA);
    await sweepUntilQuiet(fake, T, { staleScanMs: 0, leaseOwner: "worker-2" });
    const ref = (await getRef(db as never, scope))!;
    expect(ref).toMatchObject({ committed_generation: 3, committed_commit_sha: cA, scan_generation: null });

    // Worker 1 finally tries to commit generation 2: refused, nothing changes.
    const late = await commitScan(db as unknown as BitbucketDb, scope, 2);
    expect(late.outcome).toBe("superseded");
    await drain(exporter);
    expect(await yc.json(headPath(REPO, "main"))).toMatchObject({ commitSha: cA, generation: 3 });
    expect(await yc.text(codePath(REPO, "main", "README.md"))).toBe(TREE_A["README.md"]);
    expect(await yc.file(codePath(REPO, "main", "docs/new.md"))).toBeNull();
  });

  it("stops on 429 with Retry-After, persists the cooldown and the page checkpoint, then resumes exactly where it stopped", async () => {
    const c1 = fake.commit(TREE_A);
    fake.setBranch(repo, "main", c1);
    fake.failNext((p, q) => p.endsWith(`/src/${c1}/`) && q.page === "3", 429, { headers: { "retry-after": "120" } });
    const { exporter, yc } = await makeExporter(T);
    const t0 = Date.now();
    const first = await sweep(fake, T);
    expect(first.quotas[0]).toMatchObject({ outcome: "deferred" });
    const until = new Date(first.quotas[0]!.deferredUntil!).getTime();
    expect(until - t0).toBeGreaterThanOrEqual(119_000);
    expect(until - t0).toBeLessThan(125_000);
    const dirs = await query(`SELECT path, next_url, pages, state FROM bitbucket_source_scan_dirs WHERE tenant_id = $1 AND path = ''`, [T]);
    expect(dirs[0]).toMatchObject({ pages: 2, state: "pending" });
    expect(dirs[0]!.next_url).toContain("page=3");
    expect((await getRef(db as never, { tenantId: T, repoUuid: repo.uuid, ref: "main" }))!.committed_generation).toBeNull();
    await drain(exporter);
    expect(await yc.paths(`${ROOT}/${REPO}/code/main/files`)).toEqual([]);
    const cov = await bitbucketCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === `repo:${REPO}@main`)).toMatchObject({ state: "pending" });
    expect(cov.find((c) => c.scope === `repo:${REPO}@main`)!.reason).toMatch(/requests paused until/);

    // While cooling down, a sweep makes no request at all.
    const n = fake.requests.length;
    expect((await sweep(fake, T)).quotas[0]).toMatchObject({ outcome: "deferred" });
    expect(fake.requests.length).toBe(n);

    await query(`UPDATE bitbucket_source_quota SET blocked_until = now() - interval '1 second'`);
    await sweepUntilQuiet(fake, T);
    await drain(exporter);
    const root = fake.requestsMatching(new RegExp(`/src/${c1}/$`)).map((r) => r.params.page ?? "1");
    expect(root).toEqual(["1", "2", "3", "3", "4"]); // page 3 failed once and was retried from the checkpoint
    expect(await yc.text(codePath(REPO, "main", "docs/c.md"))).toBe("# C\n");
    expect((await bitbucketCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`)).toMatchObject({ state: "complete" });
  });

  it("escalates the backoff when 429s carry no Retry-After, and honours X-RateLimit-NearLimit by stopping early", async () => {
    const c1 = fake.commit(TREE_A);
    fake.setBranch(repo, "main", c1);
    fake.failNext((p) => p.includes("/refs/branches/"), 429, { times: 2 });
    const r1 = await sweep(fake, T);
    const d1 = new Date(r1.quotas[0]!.deferredUntil!).getTime() - Date.now();
    await query(`UPDATE bitbucket_source_quota SET blocked_until = now() - interval '1 second'`);
    const r2 = await sweep(fake, T);
    const d2 = new Date(r2.quotas[0]!.deferredUntil!).getTime() - Date.now();
    expect(d1).toBeGreaterThan(50_000);
    expect(d2).toBeGreaterThan(d1 * 1.8);
    await query(`UPDATE bitbucket_source_quota SET blocked_until = now() - interval '1 second'`);

    fake.rateHeaders = { ...fake.rateHeaders, "x-ratelimit-nearlimit": "true" };
    const r3 = await sweep(fake, T);
    expect(r3.quotas[0]!.requests).toBeLessThan(4);
    expect(r3.quotas[0]!.deferredUntil).toBeTruthy();
    expect((await query(`SELECT blocked_kind, near_limit FROM bitbucket_source_quota`))[0]).toMatchObject({ blocked_kind: "near_limit", near_limit: true });
  });

  it("a file that keeps failing is omitted (no placeholder), listed in the manifest, and makes coverage partial; a later retry captures it", async () => {
    const c1 = fake.commit(TREE_A);
    fake.setBranch(repo, "main", c1);
    fake.failNext((p, q) => p.endsWith(`/src/${c1}/docs/b.md`) && q.format === undefined, 500, { times: 1 });
    const { exporter, yc } = await makeExporter(T);
    await sweepUntilQuiet(fake, T, { maxItemAttempts: 1 });
    await drain(exporter);
    expect(await yc.file(codePath(REPO, "main", "docs/b.md"))).toBeNull();
    const head = await yc.json(headPath(REPO, "main"));
    expect(head.complete).toBe(false);
    expect(head.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ path: "docs/b.md", reason: "fetch_failed" })]));
    const cov = (await bitbucketCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`)!;
    expect(cov.state).toBe("partial");
    expect(cov.reason).toMatch(/could not be fetched/);

    // An hour later the same commit is re-checked: only the failed file is fetched again.
    await query(`UPDATE bitbucket_source_refs SET committed_at = now() - interval '2 hours'`);
    const before = fake.requests.length;
    await sweepUntilQuiet(fake, T);
    await drain(exporter);
    const again = fake.requests.slice(before).filter((r) => r.path.includes("/src/"));
    expect(new Set(again.map((r) => r.path.split(`/src/${c1}/`)[1]))).toEqual(new Set(["docs/b.md"]));
    expect(await yc.text(codePath(REPO, "main", "docs/b.md"))).toBe("# B\n");
    expect((await bitbucketCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`)).toMatchObject({ state: "complete" });
  });

  it("never deletes under a directory whose listing failed, and reports the scan partial", async () => {
    const c1 = fake.commit(TREE_A);
    fake.setBranch(repo, "main", c1);
    const { exporter, yc } = await makeExporter(T);
    await sweepUntilQuiet(fake, T);
    await drain(exporter);
    const tree2 = { ...TREE_A } as Record<string, unknown>;
    delete tree2["src/lib/more.ts"];
    const c2 = fake.commit(tree2 as never);
    fake.setBranch(repo, "main", c2);
    fake.failNext((p) => p.endsWith(`/src/${c2}/docs/`), 500, { times: 99 });
    // Periodic full verification is due: the branch is re-listed rather than diffed.
    await sweepUntilQuiet(fake, T, { fullRescanEveryMs: 1, maxItemAttempts: 1 });
    await drain(exporter);
    expect(await yc.text(codePath(REPO, "main", "docs/a.md"))).toBe("# A\n");
    expect(await yc.tombstone(codePath(REPO, "main", "src/lib/more.ts"))).toMatchObject({ reason: "bitbucket_deleted" });
    const snap = await yc.json(`${ROOT}/${REPO}/code/main/_snapshots/g00000002.json`);
    expect(snap).toMatchObject({ mode: "full", complete: false });
    expect(snap.incompleteReasons[0]).toMatch(/docs\//);
    const cov = (await bitbucketCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`)!;
    expect(cov.state).toBe("partial");
    expect(cov.reason).toMatch(/could not list every directory/);
  });

  it("verifies diffstat orientation instead of assuming it, falling back to a full listing when it is reversed", async () => {
    const cA = fake.commit(TREE_A);
    const cB = fake.commit(TREE_B as never);
    fake.setBranch(repo, "main", cA);
    const { exporter, yc } = await makeExporter(T);
    await sweepUntilQuiet(fake, T);
    fake.setBranch(repo, "main", cB);
    fake.reverseDiffstat = true;
    await sweepUntilQuiet(fake, T);
    await drain(exporter);
    expect(await yc.json(`${ROOT}/${REPO}/code/main/_snapshots/g00000002.json`)).toMatchObject({ mode: "full", commitSha: cB });
    expect(await yc.tombstone(codePath(REPO, "main", "src/index.ts"))).toMatchObject({ reason: "bitbucket_deleted" });
    expect(await yc.text(codePath(REPO, "main", "docs/new.md"))).toBe("# New\n");
    expect(await yc.text(codePath(REPO, "main", "README.md"))).toBe(TREE_B["README.md"]);
  });

  it("omits files over the capture limit without fetching bodies and says so", async () => {
    const big = Buffer.alloc(4096, 0x61);
    const c1 = fake.commit({ "small.txt": "ok\n", "big.bin": big });
    fake.setBranch(repo, "main", c1);
    const { exporter, yc } = await makeExporter(T);
    await sweepUntilQuiet(fake, T, { maxFileBytes: 1024 });
    await drain(exporter);
    expect(fake.requests.some((r) => r.path.endsWith("/big.bin"))).toBe(false);
    expect(await yc.file(codePath(REPO, "main", "big.bin"))).toBeNull();
    expect((await yc.json(headPath(REPO, "main"))).omitted).toEqual([expect.objectContaining({ path: "big.bin", reason: "too_large", size: 4096 })]);
    expect((await bitbucketCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`)!.state).toBe("partial");
  });
});
