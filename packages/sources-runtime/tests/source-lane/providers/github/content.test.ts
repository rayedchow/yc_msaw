import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { githubCoverage } from "../../../../src/source-lane/providers/github/coverage.js";
import { FakeGithub, gitBlobId, primaryLimit, secondaryLimit, serverError } from "./fake-github.js";
import { BIN, CODE, CONN, drain, journalCount, MAIN, makeExporter, PNG, REPO, REPO_ID, sweep, sweepUntilQuiet, T } from "./fixtures.js";
import { connect, db, expireBackoffs, expireCooldowns, query, ready, resetAll, select } from "./harness.js";

let fake: FakeGithub;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  fake = new FakeGithub();
  fake.repo(REPO_ID, REPO);
  await connect(T, CONN);
  await select(T, REPO);
});

const BASE_FILES = {
  "README.md": "# Widgets\n",
  "src/index.ts": "export const x = 1;\n",
  "src/lib/util.ts": "export function u() {}\n",
  "assets/logo.png": PNG,
  "assets/raw.bin": BIN,
  "docs/link": { symlink: "../README.md" },
  "vendor/lib": { submodule: "1111111111111111111111111111111111111111" },
};

describe("github content lane: initial capture", () => {
  it("exports the exact bytes of every file at HEAD with commit provenance, a HEAD manifest and a snapshot", async () => {
    const head = fake.commit(REPO_ID, "main", BASE_FILES, { date: "2026-07-01T00:00:00Z" });
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);

    expect(await yc.text(`${MAIN}/files/README.md`)).toBe("# Widgets\n");
    expect(await yc.text(`${MAIN}/files/src/lib/util.ts`)).toBe("export function u() {}\n");
    const png = await yc.file(`${MAIN}/files/assets/logo.png`);
    expect(png?.bytes.equals(PNG)).toBe(true);
    expect(png).toMatchObject({ kind: "binary", contentType: "image/png", ordinal: 1, sourceUpdatedAt: null });
    const bin = await yc.file(`${MAIN}/files/assets/raw.bin`);
    expect(bin?.bytes.equals(BIN)).toBe(true);
    expect(bin).toMatchObject({ kind: "binary", contentType: "application/octet-stream" });
    const readme = await yc.file(`${MAIN}/files/README.md`);
    expect(readme).toMatchObject({ kind: "raw", contentType: "text/markdown; charset=utf-8", ordinal: 1 });
    expect(readme!.provenance).toMatchObject({ repoId: String(REPO_ID), ref: "main", gitPath: "README.md", commitSha: head, generation: 1, blobSha: gitBlobId(Buffer.from("# Widgets\n")) });
    const link = await yc.file(`${MAIN}/files/docs/link`);
    expect(link?.bytes.toString()).toBe("../README.md");
    expect(link!.provenance).toMatchObject({ mode: "120000", symlink: true });
    // Submodules are not files: listed in the HEAD manifest only, never a placeholder.
    expect(await yc.file(`${MAIN}/files/vendor/lib`)).toBeNull();

    const manifest = await yc.json(`${MAIN}/_head.json`);
    expect(manifest).toMatchObject({ schema: "procmem.github-ref-head/v1", ref: "main", generation: 1, commitSha: head, complete: true, treeSha: fake.treeOf(head) });
    expect(manifest.omitted).toEqual([{ path: "vendor/lib", reason: "submodule", mode: "160000", submoduleCommit: "1111111111111111111111111111111111111111" }]);
    expect(manifest.raw.sha).toBe(head);
    expect((await yc.file(`${MAIN}/_head.json`))?.ordinal).toBe(1);

    const repo = await yc.json(`${CODE}/_repo.json`);
    expect(repo).toMatchObject({ repoId: String(REPO_ID), fullName: REPO, defaultBranch: "main", status: "active" });
    expect(repo.raw.full_name).toBe(REPO);

    const snap = await yc.json(`${MAIN}/_snapshots/g00000001.json`);
    expect(snap).toMatchObject({ generation: 1, previousGeneration: null, commitSha: head, complete: true });
    expect(snap.counts).toMatchObject({ added: 7, modified: 0, deleted: 0, renamed: 0, submodules: 1 });

    const cov = await githubCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === `repo:${REPO}@main`)).toMatchObject({ state: "complete", cursor: head });
    expect(cov.find((c) => c.scope === "activity")).toBeUndefined();
  });

  it("never sends a credential, only the Nango secret + connection headers, and keeps no token in any exported byte", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    const everything = (await Promise.all((await yc.paths()).map(async (p) => (await yc.file(p))!.bytes.toString("latin1") + JSON.stringify((await yc.file(p))!.provenance)))).join("\n");
    expect(everything).not.toContain("nango-secret-test-key");
    expect(everything.toLowerCase()).not.toContain("authorization");
  });
});

describe("github content lane: truncated recursive tree", () => {
  it("discards a truncated recursive listing and walks every tree one request at a time, resumable mid-walk", async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 6; d++) for (let f = 0; f < 5; f++) files[`dir${d}/sub/f${f}.txt`] = `content ${d}/${f}\n`;
    files["top.txt"] = "top\n";
    fake.recursiveLimit = 10;
    const head = fake.commit(REPO_ID, "main", files);
    // First run stops after a handful of requests: the walk must resume from its durable queue.
    const first = await sweep(fake, { maxRequestsPerQuota: 6 });
    expect(first.quotas[0]!.refs[0]!.outcome).toBe("in_progress");
    const trees = await query(`SELECT prefix, state FROM github_source_scan_trees WHERE tenant_id = $1 ORDER BY prefix`, [T]);
    expect(trees.length).toBeGreaterThan(1);
    expect(trees.find((t) => t.prefix === "")?.state).toBe("done");
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    const paths = (await yc.paths(`${MAIN}/files`)).map((p) => p.slice(`${MAIN}/files/`.length));
    expect(paths).toEqual(Object.keys(files).sort());
    expect(await yc.text(`${MAIN}/files/dir5/sub/f4.txt`)).toBe("content 5/4\n");
    expect(fake.count("recursive=1")).toBe(1);
    // Each tree listed once even though the walk spanned runs; each distinct blob fetched once.
    expect(fake.log.filter((l) => /\/git\/trees\/[0-9a-f]{40}$/u.test(l)).length).toBe(1 + 6 + 6);
    expect(fake.count("/git/blobs/")).toBe(new Set(Object.values(files)).size);
    expect((await yc.json(`${MAIN}/_head.json`))).toMatchObject({ commitSha: head, complete: true });
  });

  it("keeps (never deletes) files under a directory GitHub cannot list completely and reports partial", async () => {
    fake.recursiveLimit = 1;
    const c1 = fake.commit(REPO_ID, "main", { "big/a.txt": "a", "big/b.txt": "b", "small/c.txt": "c" });
    await sweepUntilQuiet(fake);
    // Next commit: same files plus one; the "big" directory listing is truncated by GitHub.
    const c2 = fake.commit(REPO_ID, "main", { "big/a.txt": "a", "big/b.txt": "b2", "small/c.txt": "c", "small/d.txt": "d" });
    fake.truncatedTrees.add(fake.subtreeId(c2, "big"));
    fake.nonRecursiveKeep = 1;
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/big/a.txt`)).toBe("a");
    // b.txt was not listed under the truncated directory: kept at its last captured bytes, not deleted.
    expect(await yc.text(`${MAIN}/files/big/b.txt`)).toBe("b");
    expect(await yc.text(`${MAIN}/files/small/d.txt`)).toBe("d");
    const manifest = await yc.json(`${MAIN}/_head.json`);
    expect(manifest).toMatchObject({ commitSha: c2, complete: false });
    const snap = await yc.json(`${MAIN}/_snapshots/g00000002.json`);
    expect(snap.incompleteReasons[0]).toContain("big/");
    const cov = (await githubCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`);
    expect(cov?.state).toBe("partial");
    void c1;
  });
});

describe("github content lane: rate limits, failures and resume", () => {
  it("stops on a secondary limit, persists Retry-After on the quota bucket, and resumes without refetching stored blobs", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`f${i}.txt`] = `file ${i}\n`;
    fake.commit(REPO_ID, "main", files);
    let blobCalls = 0;
    fake.fail((p) => p.includes("/git/blobs/") && ++blobCalls === 4, () => secondaryLimit(120), 1);
    const r1 = await sweep(fake);
    expect(r1.quotas[0]).toMatchObject({ outcome: "deferred" });
    const q = (await query(`SELECT blocked_until, blocked_kind, last_status, last_retry_after_ms FROM github_source_quota`))[0]!;
    expect(q).toMatchObject({ blocked_kind: "secondary", last_status: 429 });
    expect(Number(q.last_retry_after_ms)).toBe(120000);
    const ms = new Date(q.blocked_until).getTime() - Date.now();
    expect(ms).toBeGreaterThan(110_000);
    expect(ms).toBeLessThanOrEqual(121_000);
    const stored = (await query(`SELECT count(*)::int AS n FROM github_source_blobs WHERE tenant_id = $1`, [T]))[0]!.n;
    expect(stored).toBe(3);
    // Nothing committed yet, and the deferred bucket makes no request at all.
    expect((await query(`SELECT committed_generation FROM github_source_refs`))[0]!.committed_generation).toBeNull();
    const before = fake.log.length;
    expect((await sweep(fake)).quotas[0]).toMatchObject({ outcome: "deferred" });
    expect(fake.log.length).toBe(before);
    await expireCooldowns();
    await sweepUntilQuiet(fake);
    expect(fake.count("/git/blobs/")).toBe(8 + 1); // the rate-limited request is retried once, nothing else twice
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/f7.txt`)).toBe("file 7\n");
  });

  it("treats 403 + x-ratelimit-remaining: 0 as the primary limit and waits until x-ratelimit-reset", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    const reset = Math.floor(Date.now() / 1000) + 900;
    fake.fail("/git/commits/", () => primaryLimit(reset));
    const r = await sweep(fake);
    expect(r.quotas[0]!.outcome).toBe("deferred");
    const q = (await query(`SELECT blocked_until, blocked_kind FROM github_source_quota`))[0]!;
    expect(q.blocked_kind).toBe("primary");
    expect(Math.abs(new Date(q.blocked_until).getTime() - reset * 1000)).toBeLessThan(5_000);
    // The commit was not fetched, so no generation was assigned.
    expect((await query(`SELECT next_generation FROM github_source_refs`))[0]!.next_generation).toBe(0);
  });

  it("stops before exhausting the bucket the donor issue/comment lanes share (reserve) and defers to the reset", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.txt`] = `r ${i}`;
    fake.commit(REPO_ID, "main", files);
    // Default reserve = max(200, 10% of the 5000 limit) = 500 remaining.
    fake.rateRemaining = 503;
    const r = await sweep(fake, { reserveRemaining: undefined });
    expect(r.quotas[0]!.deferredUntil).toBeTruthy();
    expect(r.quotas[0]!.requests).toBe(3);
    const q = (await query(`SELECT blocked_kind, blocked_until, rate_remaining, rate_limit FROM github_source_quota`))[0]!;
    expect(q).toMatchObject({ blocked_kind: "reserve", rate_limit: 5000, rate_remaining: 500 });
    expect(Math.abs(new Date(q.blocked_until).getTime() - fake.rateReset * 1000)).toBeLessThan(5_000);
    // Nothing was lost: the scan resumes after the reset.
    await expireCooldowns();
    fake.rateRemaining = 5000;
    await sweepUntilQuiet(fake);
    expect((await query(`SELECT committed_generation FROM github_source_refs`))[0]!.committed_generation).toBe(1);
  });

  it("does not advance any checkpoint on HTTP failures: the blob stays pending with backoff, the commit waits", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "aaa", "b.txt": "bbb" });
    const blobB = gitBlobId(Buffer.from("bbb"));
    fake.fail(`/git/blobs/${blobB}`, serverError, 2);
    const r1 = await sweep(fake);
    // Regression: a ref whose only remaining work is backing off is not re-entered within the run
    // (it once re-resolved HEAD on every pass until the bucket was empty).
    expect(r1.quotas[0]!.requests).toBe(6);
    expect(r1.quotas[0]!.refs[0]).toMatchObject({ outcome: "in_progress", yielded: false });
    let e = (await query(`SELECT blob_state, attempts, last_error FROM github_source_scan_entries WHERE path = 'b.txt'`))[0]!;
    expect(e).toMatchObject({ blob_state: "pending", attempts: 1 });
    expect(e.last_error).toContain("502");
    expect((await query(`SELECT committed_generation, scan_phase FROM github_source_refs`))[0]).toMatchObject({ committed_generation: null, scan_phase: "blobs" });
    // Backoff respected: a run before not_before does not refetch it.
    const calls = fake.count(`/git/blobs/${blobB}`);
    expect((await sweep(fake)).quotas[0]!.requests).toBe(2);
    expect(fake.count(`/git/blobs/${blobB}`)).toBe(calls);
    await expireBackoffs();
    await sweep(fake);
    await expireBackoffs();
    await sweepUntilQuiet(fake);
    e = (await query(`SELECT count(*)::int AS n FROM github_source_scan_entries`))[0]!;
    expect(e.n).toBe(0);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/b.txt`)).toBe("bbb");
  });

  it("rejects blob bytes whose git SHA-1 does not match and never stores them", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "good" });
    const id = gitBlobId(Buffer.from("good"));
    fake.fail(`/git/blobs/${id}`, () => Response.json({ sha: id, size: 4, content: Buffer.from("evil").toString("base64"), encoding: "base64" }), 5);
    await sweepUntilQuiet(fake, { maxItemAttempts: 1 });
    expect((await query(`SELECT count(*)::int AS n FROM github_source_blobs`))[0]!.n).toBe(0);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.file(`${MAIN}/files/a.txt`)).toBeNull();
    const manifest = await yc.json(`${MAIN}/_head.json`);
    expect(manifest.complete).toBe(false);
    expect(manifest.omitted).toEqual([expect.objectContaining({ path: "a.txt", reason: "fetch_failed" })]);
  });

  it("blocks (not deletes) on an auth failure and a missing Contents permission", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    await sweepUntilQuiet(fake);
    fake.commit(REPO_ID, "main", { "a.txt": "a2" });
    fake.fail("/git/commits/", () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }), 1);
    await sweep(fake);
    let cov = (await githubCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`);
    expect(cov).toMatchObject({ state: "blocked" });
    fake.fail("/repositories/", () => Response.json({ error: { code: "unknown_connection" } }, { status: 404 }), 1);
    fake.fail("/repositories/", () => new Response("", { status: 401 }), 1);
    expect((await sweep(fake)).quotas[0]!.outcome).toBe("blocked");
    expect((await sweep(fake)).quotas[0]!.outcome).toBe("blocked");
    // A dead grant is not a missing repository: the repository is not marked inaccessible.
    expect((await query(`SELECT status FROM github_source_repos`))[0]!.status).toBe("active");
    expect((await query(`SELECT status FROM github_source_connections`))[0]!.status).toBe("blocked");
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/a.txt`)).toBe("a");
    await sweepUntilQuiet(fake);
    cov = (await githubCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`);
    expect(cov?.state).toBe("complete");
  });
});

describe("github content lane: deletes, renames, versions", () => {
  it("tombstones deleted paths, detects renames by blob id, versions modified files and records the snapshot diff", async () => {
    const c1 = fake.commit(REPO_ID, "main", { "keep.txt": "same", "old/name.txt": "moved bytes", "gone.txt": "bye", "edit.txt": "v1" });
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    const c2 = fake.commit(REPO_ID, "main", { "keep.txt": "same", "new/place.txt": "moved bytes", "edit.txt": "v2" });
    const journalBefore = await journalCount();
    await sweepUntilQuiet(fake);
    // Only changed paths journal: keep.txt (unchanged bytes) is not touched by the commit.
    const journaled = await query(`SELECT j.table_name, f.path FROM source_lane_journal j LEFT JOIN github_source_files f ON f.row_key = j.row_key WHERE j.table_name = 'github_source_files' ORDER BY f.path`);
    expect(journaled.map((r) => r.path)).toEqual(["edit.txt", "gone.txt", "new/place.txt", "old/name.txt"]);
    expect(await journalCount()).toBeGreaterThan(journalBefore);
    await drain(exporter);

    expect(await yc.tombstone(`${MAIN}/files/gone.txt`)).toMatchObject({ reason: "github_deleted" });
    const moved = await yc.tombstone(`${MAIN}/files/old/name.txt`);
    expect(moved).toMatchObject({ reason: "github_renamed" });
    expect(moved!.provenance).toMatchObject({ renamedTo: "new/place.txt", deletedGeneration: 2, deletedCommitSha: c2 });
    const placed = await yc.file(`${MAIN}/files/new/place.txt`);
    expect(placed?.bytes.toString()).toBe("moved bytes");
    expect(placed!.provenance).toMatchObject({ renamedFrom: "old/name.txt", generation: 2, commitSha: c2 });
    expect(await yc.file(`${MAIN}/files/edit.txt`)).toMatchObject({ ordinal: 2 });
    expect((await yc.file(`${MAIN}/files/keep.txt`))!.ordinal).toBe(1);
    expect((await yc.file(`${MAIN}/files/keep.txt`))!.provenance).toMatchObject({ commitSha: c1, generation: 1 });
    expect((await yc.history(`${MAIN}/files/edit.txt`)).length).toBe(2);
    expect((await yc.history(`${MAIN}/files/keep.txt`)).length).toBe(1);

    const snap = await yc.json(`${MAIN}/_snapshots/g00000002.json`);
    expect(snap).toMatchObject({ generation: 2, previousGeneration: 1, commitSha: c2 });
    expect(snap.counts).toMatchObject({ added: 0, modified: 1, deleted: 1, renamed: 1 });
    expect(snap.changes.map((c: any) => `${c.op}:${c.path}${c.from ? `<-${c.from}` : ""}`)).toEqual(["modified:edit.txt", "deleted:gone.txt", "renamed:new/place.txt<-old/name.txt"]);
    // Previous snapshot stays.
    expect((await yc.json(`${MAIN}/_snapshots/g00000001.json`)).commitSha).toBe(c1);
  });

  it("re-checks an unchanged HEAD with two requests, no new generation and no journal entries", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    await sweepUntilQuiet(fake);
    const { exporter } = await makeExporter();
    await drain(exporter);
    const before = fake.log.length;
    const r = await sweep(fake);
    expect(r.quotas[0]!.refs[0]).toMatchObject({ outcome: "unchanged", generation: 1 });
    expect(fake.log.slice(before)).toEqual([`/repositories/${REPO_ID}`, `/repos/${REPO}/git/ref/heads/main`]);
    expect(await journalCount()).toBe(0);
  });

  it("does not capture blobs over the size limit and lists them instead of exporting placeholders", async () => {
    fake.commit(REPO_ID, "main", { "small.txt": "s", "huge.bin": Buffer.alloc(4096, 7) });
    await sweepUntilQuiet(fake, { maxBlobBytes: 1024 });
    expect(fake.count(`/git/blobs/${gitBlobId(Buffer.alloc(4096, 7))}`)).toBe(0);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.file(`${MAIN}/files/huge.bin`)).toBeNull();
    const manifest = await yc.json(`${MAIN}/_head.json`);
    expect(manifest.omitted).toEqual([expect.objectContaining({ path: "huge.bin", reason: "too_large", size: 4096 })]);
    expect((await githubCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`)?.state).toBe("partial");
  });
});

describe("github content lane: HEAD rollback and scan ordering", () => {
  it("applies A -> B -> A (force-push rollback, B's commit date older than A's) by scan generation, not dates or SHAs", async () => {
    const A = fake.commit(REPO_ID, "main", { "app.txt": "state A", "only-in-a.txt": "a-only" }, { date: "2026-08-01T00:00:00Z" });
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/app.txt`)).toBe("state A");

    // B claims to be years older (author/committer dates are user-controlled).
    const B = fake.commit(REPO_ID, "main", { "app.txt": "state B" }, { date: "2019-01-01T00:00:00Z", parents: [] });
    await sweepUntilQuiet(fake);
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/app.txt`)).toBe("state B");
    expect(await yc.tombstone(`${MAIN}/files/only-in-a.txt`)).toMatchObject({ reason: "github_deleted" });

    fake.setBranch(REPO_ID, "main", A);
    await sweepUntilQuiet(fake);
    await drain(exporter);
    const app = await yc.file(`${MAIN}/files/app.txt`);
    expect(app?.bytes.toString()).toBe("state A");
    expect(app).toMatchObject({ ordinal: 3, sourceUpdatedAt: null });
    expect(app!.provenance).toMatchObject({ commitSha: A, generation: 3 });
    expect(await yc.text(`${MAIN}/files/only-in-a.txt`)).toBe("a-only");
    const head = await yc.file(`${MAIN}/_head.json`);
    expect(head).toMatchObject({ ordinal: 3, versionRef: A });
    expect(JSON.parse(head!.bytes.toString()).generation).toBe(3);
    expect((await yc.history(`${MAIN}/files/app.txt`)).map((v: any) => v.sourceVersion?.ordinal)).toEqual([3, 2, 1]);
    expect(yc.results.filter((r) => r.outcome === "stale")).toEqual([]);
    const snaps = await query(`SELECT generation, commit_sha FROM github_source_snapshots ORDER BY generation`);
    expect(snaps.map((s) => s.commit_sha)).toEqual([A, B, A]);
    // Blobs of A were fetched once: the rollback re-used the tenant's stored bytes.
    expect(fake.count(`/git/blobs/${gitBlobId(Buffer.from("state A"))}`)).toBe(1);
  });

  it("refuses a late completion of an older scan after a newer generation committed", async () => {
    const store = await import("../../../../src/source-lane/providers/github/store.js");
    const A = fake.commit(REPO_ID, "main", { "f.txt": "A" });
    // Worker 1 resolves HEAD A and finishes its scan up to the commit step, then stalls.
    await sweep(fake, { maxRequestsPerQuota: 3 }); // repo + ref + commit -> generation 1 begun
    const scope = { tenantId: T, repoId: String(REPO_ID), ref: "main" };
    let ref = (await store.getRef(db as never, scope))!;
    expect(ref).toMatchObject({ scan_generation: 1, scan_commit_sha: A });
    // Worker 2 (worker 1's lease expired) abandons generation 1 because HEAD moved and its tree was force-gc'd,
    // starts generation 2 for B and commits it.
    const B = fake.commit(REPO_ID, "main", { "f.txt": "B" });
    await store.abandonScan(db as never, scope, 1, "test: tree gone");
    await sweepUntilQuiet(fake);
    ref = (await store.getRef(db as never, scope))!;
    expect(ref).toMatchObject({ committed_generation: 2, committed_commit_sha: B, scan_generation: null });
    // Worker 1 wakes up and tries to finish generation 1.
    await store.stageEntries(db as never, scope, 1, [{ path: "f.txt", mode: "100644", type: "blob", sha: gitBlobId(Buffer.from("A")), size: 1 }], 1 << 20);
    const late = await store.commitScan(db as never, scope, 1);
    expect(late).toMatchObject({ outcome: "superseded" });
    expect((await store.getRef(db as never, scope))!).toMatchObject({ committed_generation: 2, committed_commit_sha: B });
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/f.txt`)).toBe("B");
  });

  it("an older scan in progress is refused once a newer scan of the same ref took a newer generation", async () => {
    const store = await import("../../../../src/source-lane/providers/github/store.js");
    fake.commit(REPO_ID, "main", { "f.txt": "A" });
    await sweep(fake, { maxRequestsPerQuota: 3 });
    const scope = { tenantId: T, repoId: String(REPO_ID), ref: "main" };
    await store.setScanPhase(db as never, scope, 1, "ready");
    // A second worker begins generation 2 directly (e.g. after its own HEAD check), before worker 1 commits.
    const g2 = await store.beginScan(db as never, scope, { commitSha: "b".repeat(40), treeSha: "c".repeat(40), commitRaw: {}, reason: "test" });
    expect(g2).toBe(2);
    expect(await store.commitScan(db as never, scope, 1)).toMatchObject({ outcome: "superseded" });
    expect((await store.getRef(db as never, scope))!.committed_generation).toBeNull();
  });

  it("finishes a scan in progress even when HEAD moved again, then scans the newer HEAD (no starvation on busy branches)", async () => {
    const A = fake.commit(REPO_ID, "main", { "f.txt": "A", "g.txt": "G" });
    await sweep(fake, { maxRequestsPerQuota: 4 });
    const B = fake.commit(REPO_ID, "main", { "f.txt": "B", "g.txt": "G" });
    const r = await sweep(fake);
    expect(r.quotas[0]!.refs[0]).toMatchObject({ outcome: "committed", generation: 1, commitSha: A });
    let cov = (await githubCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`);
    expect(cov?.state).toBe("partial");
    expect(cov?.reason).toContain(`HEAD moved to ${B}`);
    await sweepUntilQuiet(fake);
    cov = (await githubCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `repo:${REPO}@main`);
    expect(cov).toMatchObject({ state: "complete", cursor: B });
  });
});

describe("github content lane: selection, scope and renames", () => {
  it("captures nothing for unselected repositories and reports pending", async () => {
    await select(T, REPO, false);
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    const r = await sweep(fake);
    expect(r.selected).toBe(0);
    expect(fake.log).toEqual([]);
    const cov = await githubCoverage({ tenantId: T, executor: db as never });
    expect(cov).toEqual([expect.objectContaining({ scope: "repositories", state: "pending" })]);
  });

  it("scope-out retires the current files (history and snapshots kept); re-selecting restores them", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    await select(T, REPO, false);
    await sweep(fake);
    await drain(exporter);
    expect(await yc.tombstone(`${MAIN}/files/a.txt`)).toMatchObject({ reason: "github_repo_out_of_scope" });
    expect(await yc.tombstone(`${CODE}/_repo.json`)).toMatchObject({ reason: "github_repo_out_of_scope" });
    expect(await yc.file(`${MAIN}/_snapshots/g00000001.json`)).not.toBeNull();
    expect((await query(`SELECT count(*)::int AS n FROM github_source_blobs`))[0]!.n).toBe(1);
    await select(T, REPO, true);
    await sweepUntilQuiet(fake);
    await drain(exporter);
    expect(await yc.text(`${MAIN}/files/a.txt`)).toBe("a");
    expect((await yc.history(`${MAIN}/files/a.txt`)).map((v: any) => v.kind)).toEqual(["raw", "tombstone", "raw"]);
  });

  it("follows a repository rename by immutable id and moves every exported path", async () => {
    fake.commit(REPO_ID, "main", { "src/a.txt": "a" });
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    fake.rename(REPO_ID, "acme/gadgets");
    await sweepUntilQuiet(fake);
    await drain(exporter);
    const NEW = "sources/github/acme/gadgets/code/main";
    expect(await yc.text(`${NEW}/files/src/a.txt`)).toBe("a");
    expect(await yc.tombstone(`${MAIN}/files/src/a.txt`)).toMatchObject({ reason: "source_path_changed" });
    expect((await yc.json("sources/github/acme/gadgets/code/_repo.json")).selectedAs).toBe(REPO);
    expect(await yc.file(`${NEW}/_snapshots/g00000001.json`)).not.toBeNull();
    // Still in scope although the selection row holds the old name.
    expect((await githubCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === "repo:acme/gadgets@main")?.state).toBe("complete");
  });

  it("retires a branch that is no longer the default, and removes files of a deleted branch with a new generation", async () => {
    const store = await import("../../../../src/source-lane/providers/github/store.js");
    fake.commit(REPO_ID, "main", { "m.txt": "m" });
    fake.commit(REPO_ID, "dev", { "d.txt": "d" });
    await sweepUntilQuiet(fake);
    await store.setRepoExtraRefs(db as never, { tenantId: T, repoId: String(REPO_ID) }, ["dev"]);
    await sweepUntilQuiet(fake);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text(`${CODE}/dev/files/d.txt`)).toBe("d");
    fake.setBranch(REPO_ID, "dev", null);
    await sweepUntilQuiet(fake);
    await drain(exporter);
    expect(await yc.tombstone(`${CODE}/dev/files/d.txt`)).toMatchObject({ reason: "github_ref_deleted" });
    expect((await yc.json(`${CODE}/dev/_head.json`))).toMatchObject({ status: "not_found", generation: 2 });
    // A second check of the missing branch is a no-op (no new generation).
    await sweepUntilQuiet(fake);
    expect((await store.getRef(db as never, { tenantId: T, repoId: String(REPO_ID), ref: "dev" }))!.next_generation).toBe(2);
    await store.setRepoExtraRefs(db as never, { tenantId: T, repoId: String(REPO_ID) }, []);
    await sweepUntilQuiet(fake);
    await drain(exporter);
    expect(await yc.tombstone(`${CODE}/dev/_head.json`)).toMatchObject({ reason: "github_ref_retired" });
    expect(await yc.text(`${MAIN}/files/m.txt`)).toBe("m");
  });

  it("scopes everything by tenant: another tenant's sweep, rows and coverage never see this tenant's repository", async () => {
    fake.commit(REPO_ID, "main", { "a.txt": "secret" });
    await sweepUntilQuiet(fake);
    await connect("tenant-other", "conn-2");
    fake.visibility.set("conn-2", new Set());
    const r = await sweep(fake, {}, "tenant-other");
    expect(r.selected).toBe(0);
    expect((await query(`SELECT count(*)::int AS n FROM github_source_files WHERE tenant_id = 'tenant-other'`))[0]!.n).toBe(0);
    expect(await githubCoverage({ tenantId: "tenant-other", executor: db as never })).toEqual([expect.objectContaining({ scope: "repositories", state: "pending" })]);
    // Even if the other tenant selects the same name, its own grant cannot read it.
    await select("tenant-other", REPO);
    const r2 = await sweep(fake, {}, "tenant-other");
    expect(r2.notes[0]).toContain("not readable");
    expect((await query(`SELECT count(*)::int AS n FROM github_source_repos WHERE tenant_id = 'tenant-other'`))[0]!.n).toBe(0);
  });

  it("resolves repositories across several installations of one tenant (one bucket per installation)", async () => {
    await connect(T, "conn-org2", { installationId: "777" });
    fake.repo(99, "other-org/tools", { connections: ["conn-org2"] });
    fake.commit(99, "main", { "t.txt": "t" });
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    await select(T, "other-org/tools");
    await sweepUntilQuiet(fake);
    const rows = await query(`SELECT full_name, connection_id, quota_key FROM github_source_repos ORDER BY full_name`);
    expect(rows).toEqual([
      { full_name: REPO, connection_id: CONN, quota_key: "github:nango:github:conn-1" },
      { full_name: "other-org/tools", connection_id: "conn-org2", quota_key: "github:installation:777" },
    ]);
  });
});
