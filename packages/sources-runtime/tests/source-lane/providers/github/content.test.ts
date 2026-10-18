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
