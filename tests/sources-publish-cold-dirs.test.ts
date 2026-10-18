import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceStore } from "../src/sources/store.js";
import { CachedObjectStore, DirectoryObjectStore, type ObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

/**
 * final-performance-check: a batch whose changes land in many EXISTING directories (re-exported Slack raw events,
 * updated Gmail messages, withheld group DMs) loaded each uncached directory and page one round trip at a time on a
 * cold replica of the hosted store (~2 gets per change). They must be read level by level in batches, with outcomes
 * identical to a warm replica (sticky withholding included).
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

const NS = "t-publish-cold-dirs";
const N = 300;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const put = (p: string, body: string, capturedAt: string) => {
  const bytes = Buffer.from(body);
  return { op: "put" as const, path: p, kind: "raw" as const, contentType: "application/json", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt };
};
const del = (p: string, reason: string, at: string) => ({ op: "delete" as const, path: p, deletedAt: at, reason, capturedAt: at });
const raw = (i: number) => `sources/slack/_raw/workspace:T0/message:C0CHAN${String(i % 7).padStart(4, "0")}:17600${String(i).padStart(5, "0")}.000100/2026-10/slack:${i}.json`;
const mail = (i: number) => `sources/gmail/a@acme.test/messages/2026-0${(i % 9) + 1}/m${i}/message.md`;
const dm = (i: number) => `sources/slack/_raw/workspace:T0/message:G0MPIM${String(i).padStart(4, "0")}:1760000000.000100/2026-10/slack:dm${i}.json`;
const B = { bindingId: "sb-seed", providers: ["*"] };
let dir: string;
let authority: DirectoryObjectStore;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "publish-cold-dirs-"));
  authority = new DirectoryObjectStore(path.join(dir, "authority"));
  const seed = new SourceStore(authority, NS);
  // Enough siblings that the shared parents are paged directories.
  for (let s = 0; s < 4; s++) {
    await seed.applyBatch(B, {
      batchId: `s${s}`,
      changes: Array.from({ length: 500 }, (_, j) => s * 500 + j).flatMap((i) => [put(raw(i), `{"i":${i}}`, ago(3_000_000)), put(mail(i), `# ${i}\n`, ago(3_000_000))]),
    });
  }
  await seed.applyBatch(B, { batchId: "dm-put", changes: Array.from({ length: 50 }, (_, i) => put(dm(i), `{"dm":${i}}`, ago(3_000_000))) });
  await seed.applyBatch(B, { batchId: "dm-del", changes: Array.from({ length: 50 }, (_, i) => del(dm(i), "slack_direct_message_withheld", ago(2_000_000))) });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("publish into existing directories on a cold replica", () => {
  it("reads directories in batches and gives the same outcomes as a warm replica", async () => {
    const changes = [
      ...Array.from({ length: N }, (_, i) => put(raw(i * 3), `{"i":${i * 3},"edited":true}`, ago(60_000))),
      ...Array.from({ length: 100 }, (_, i) => del(mail(i * 5 + 1), "message_deleted", ago(60_000))),
      ...Array.from({ length: 50 }, (_, i) => put(dm(i), `{"dm":${i},"replay":true}`, ago(60_000))),
    ];
    const counted = new Counting(authority);
    const cold = new SourceStore(new CachedObjectStore(counted, new DirectoryObjectStore(path.join(dir, "cold-cache"))), NS);
    // A warm replica's answer for the same batch (dry run against its own copy of the authority).
    const warmDir = path.join(dir, "warm-copy");
    await (await import("node:fs/promises")).cp(path.join(dir, "authority"), warmDir, { recursive: true });
    const warm = new SourceStore(new DirectoryObjectStore(warmDir), NS);
    const expected = (await warm.applyBatch(B, { batchId: "edit", changes })).results.map((r: { outcome: string }) => r.outcome);
    const got = (await cold.applyBatch(B, { batchId: "edit", changes })).results.map((r: { outcome: string }) => r.outcome);
    expect(got).toEqual(expected);
    expect(got.slice(N + 100).every((o: string) => o === "stale")).toBe(true); // withheld stays sealed
    expect(got.slice(0, N).every((o: string) => o === "updated")).toBe(true);
    // Unpatched: ~2 sequential gets per change (>= 700 here).
    expect(counted.gets).toBeLessThan(40);
  });
});
