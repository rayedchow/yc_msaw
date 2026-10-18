import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceStore } from "../src/sources/store.js";
import { CachedObjectStore, DirectoryObjectStore, type ObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

/**
 * perf-verification-2: a put onto a tombstoned path reads that tombstone's version (sticky withholding). On a cold
 * replica of the hosted store that was one sequential authority round trip per restored path; the versions must be
 * read in batches. Withheld paths must stay sealed.
 */
class Counting implements ObjectStore {
  readonly kind = "counting";
  gets = 0;
  constructor(readonly inner: ObjectStore) {}
  put(ns: string, o: Parameters<ObjectStore["put"]>[1]) { return this.inner.put(ns, o); }
  get(ns: string, k: string[]) { this.gets++; return this.inner.get(ns, k); }
  list(ns: string, p: string, o?: { after?: string; limit?: number }) { return this.inner.list(ns, p, o); }
  getRef(ns: string, n: string) { return this.inner.getRef(ns, n); }
  casRef(ns: string, n: string, v: number | null, value: unknown) { return this.inner.casRef(ns, n, v, value); }
}

const NS = "t-restore-batched";
const N = 300;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const put = (p: string, body: string, capturedAt: string) => {
  const bytes = Buffer.from(body);
  return { op: "put" as const, path: p, kind: "projection" as const, contentType: "text/markdown", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt };
};
const del = (p: string, reason: string) => ({ op: "delete" as const, path: p, deletedAt: ago(1_800_000), reason, capturedAt: ago(1_800_000) });
const B = { bindingId: "sb-seed", providers: ["*"] };
let dir: string;
let authority: DirectoryObjectStore;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "restore-batched-"));
  authority = new DirectoryObjectStore(path.join(dir, "authority"));
  const seed = new SourceStore(authority, NS);
  await seed.applyBatch(B, { batchId: "s1", changes: [...Array.from({ length: N }, (_, i) => put(`sources/jira/ACME/ACME-${i}.md`, `# ${i}\n`, ago(3_000_000))), put("sources/slack/D1/2026-10-01.md", "# dm secret\n", ago(3_000_000))] });
  await seed.applyBatch(B, { batchId: "s2", changes: [...Array.from({ length: N }, (_, i) => del(`sources/jira/ACME/ACME-${i}.md`, "deleted_upstream")), del("sources/slack/D1/2026-10-01.md", "slack_direct_message_withheld")] });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("publish onto tombstones", () => {
  it("reads the tombstone versions in batches on a cold replica and keeps withheld paths sealed", async () => {
    const counted = new Counting(authority);
    const cold = new SourceStore(new CachedObjectStore(counted, new DirectoryObjectStore(path.join(dir, "cold-cache"))), NS);
    const r = await cold.applyBatch(B, { batchId: "restore", changes: [...Array.from({ length: N }, (_, i) => put(`sources/jira/ACME/ACME-${i}.md`, `# ${i} back\n`, ago(60_000))), put("sources/slack/D1/2026-10-01.md", "# dm replay\n", ago(60_000))] });
    const outcomes = r.results.map((x: { outcome: string }) => x.outcome);
    expect(outcomes.slice(0, N).every((o: string) => o !== "stale")).toBe(true);
    expect(outcomes[N]).toBe("stale");
    // Unpatched: one get per restored path (> N).
    expect(counted.gets).toBeLessThan(25);
    expect((await cold.resolve("slack/D1/2026-10-01.md"))?.entry?.t).toBe("x");
  });
});
