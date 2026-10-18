import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceViewer } from "../src/sources/access.js";
import { SourceFs } from "../src/sources/fs.js";
import { SourceService } from "../src/sources/service.js";
import { SourceStore } from "../src/sources/store.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

/**
 * perf-verification-2: `ls` of a partly readable directory (google-docs root, the gmail container) pages over the raw
 * entries and filters afterwards. The cursor was the last raw name, so it named other members' Docs and mailboxes,
 * and a member with few units got near-empty pages (one call per `limit` raw entries). The listing must count only
 * readable entries towards `limit`, and its cursor must be a readable name.
 */
const NS = "t-ls-mixed";
const ISS = "https://issuer.test";
const DOCS = 300;
let dir: string;
let fs: SourceFs;
const docName = (i: number) => `board-plan-${String(i).padStart(4, "0")}-doc-${(i * 2654435761 >>> 0).toString(16)}`;
// Alice's mailboxes see every 10th Doc; everything else is Bob's.
const aliceDocs = new Set(Array.from({ length: DOCS }, (_, i) => i).filter((i) => i % 10 === 3).map(docName));
const accounts = [
  { account: "alice@acme.test", subject: "user_alice", issuer: ISS },
  { account: "bob@acme.test", subject: "user_bob", issuer: ISS },
];
const alice = new SourceViewer({ subject: "user_alice", issuer: ISS }, {
  providerOwners: new Map(),
  googleAccounts: accounts,
  googleUnits: [...aliceDocs].map((d) => ({ path: `google-docs/${d}`, revisions: true })),
});
const put = (p: string, body: string) => {
  const bytes = Buffer.from(body);
  return { op: "put" as const, path: p, kind: "projection" as const, contentType: "text/markdown", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt: new Date(Date.now() - 60_000).toISOString() };
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ls-mixed-"));
  const objects = new DirectoryObjectStore(dir);
  const changes = [
    put("sources/gmail/alice@acme.test/messages/2026-10/m1/message.md", "# a\n"),
    put("sources/gmail/bob@acme.test/messages/2026-10/m1/message.md", "# b\n"),
    put("sources/gmail/carol@acme.test/messages/2026-10/m1/message.md", "# c\n"),
    ...Array.from({ length: DOCS }, (_, i) => put(`sources/google-docs/${docName(i)}/document.md`, `# doc ${i}\n`)),
  ];
  await new SourceStore(objects, NS).applyBatch({ bindingId: "sb-seed", providers: ["*"] }, { batchId: "seed", changes });
  fs = new SourceFs(new SourceService(objects));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function lsAll(viewer: SourceViewer, p: string, limit: number) {
  const seen: string[] = [];
  const cursors: string[] = [];
  let after: string | undefined;
  let calls = 0;
  for (;;) {
    const r = (await fs.run(NS, viewer, "ls", { path: p, limit, ...(after ? { after } : {}) })) as { entries: Array<{ name: string }>; nextAfter?: string };
    calls++;
    seen.push(...r.entries.map((e) => e.name.replace(/\/$/, "")));
    if (!r.nextAfter) break;
    cursors.push(r.nextAfter);
    after = r.nextAfter;
    if (calls > DOCS + 5) throw new Error("no progress");
  }
  return { seen, cursors, calls };
}

describe("ls of a partly readable directory", () => {
  it("never names another member's Doc in the cursor and fills each page with readable entries", async () => {
    const { seen, cursors, calls } = await lsAll(alice, "$SOURCES/google-docs", 10);
    expect(new Set(seen)).toEqual(aliceDocs);
    for (const c of cursors) expect(aliceDocs.has(c)).toBe(true);
    // 30 readable Docs at 10 per page: 3 calls (unfiltered paging over 300 raw entries took 30).
    expect(calls).toBe(3);
  });

  it("never names another member's mailbox in the gmail container cursor", async () => {
    const { seen, cursors } = await lsAll(alice, "$SOURCES/gmail", 1);
    expect(seen).toEqual(["alice@acme.test"]);
    expect(cursors.filter((c) => c !== "alice@acme.test")).toEqual([]);
  });
});
