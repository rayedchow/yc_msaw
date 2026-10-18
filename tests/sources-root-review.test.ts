import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { canonicalJson, sha256 } from "../src/util.js";
import { SourceStore, type PutChange } from "../src/sources/store.js";

const identity = { bindingId: "sb-root-review", providers: ["github"] };
const now = () => new Date("2026-10-17T12:00:00.000Z");
const put = (text: string, capturedAt = "2026-10-17T11:00:00.000Z", sourceUpdatedAt = capturedAt): PutChange => {
  const bytes = Buffer.from(text);
  return { op: "put", path: "sources/github/repo/file.txt", kind: "projection", contentType: "text/plain", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt, sourceUpdatedAt };
};
let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), "sources-root-review-")); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe("source publication durability across independent processes", () => {
  it("keeps __proto__ keys when canonicalizing provider JSON and tree nodes", () => {
    const payload = JSON.parse('{"__proto__":{"value":1},"nested":{"__proto__":"two"}}');
    expect(JSON.parse(canonicalJson(payload))).toEqual(payload);
    expect(Object.keys(JSON.parse(canonicalJson(payload)))).toContain("__proto__");
  });

  it("binds a batch id to its content and rejects a different payload on replay", async () => {
    const store = new DirectoryObjectStore(tmp);
    const a = new SourceStore(store, "tenant-a", { now });
    await a.applyBatch(identity, { batchId: "same-id", changes: [put("first")] });
    const cold = new SourceStore(new DirectoryObjectStore(tmp), "tenant-a", { now });
    await expect(cold.applyBatch(identity, { batchId: "same-id", changes: [put("different")] })).rejects.toThrow();
  });

  it("does not let a later poll overwrite a newer provider revision with old state", async () => {
    const sources = new SourceStore(new DirectoryObjectStore(tmp), "tenant-a", { now });
    await sources.applyBatch(identity, { batchId: "new-version", changes: [put("new", "2026-10-17T10:00:00Z", "2026-10-16T20:00:00Z")] });
    const result = await sources.applyBatch(identity, { batchId: "late-old-version", changes: [put("old", "2026-10-17T11:00:00Z", "2026-10-16T10:00:00Z")] });
    expect(result.results[0]?.outcome).toBe("stale");
    const versions = await sources.history("github/repo/file.txt");
    expect((await sources.readRange(versions.versions[0]!, 0, 3)).toString()).toBe("new");
  });

  it("recovers the original receipt when the publisher dies after CAS before returning", async () => {
    class ReceiptCrashStore extends DirectoryObjectStore {
      crashed = false;
      override async casRef(ns: string, name: string, expectedVersion: number | null, value: unknown) {
        const result = await super.casRef(ns, name, expectedVersion, value);
        if (!this.crashed && name === "sources/head" && result.ok) {
          this.crashed = true;
          throw new Error("simulated process death after committing head but before returning");
        }
        return result;
      }
    }
    const failing = new ReceiptCrashStore(tmp);
    const sources = new SourceStore(failing, "tenant-a", { now });
    const batch = { batchId: "before-crash", changes: [put("first", "2026-10-17T09:00:00Z")] };
    let first: Awaited<ReturnType<SourceStore["applyBatch"]>> | undefined;
    try { first = await sources.applyBatch(identity, batch); } catch { /* crash may be surfaced; committed head still needs recovery */ }
    const committed = await sources.head();
    expect(committed.value.seq).toBe(1);
    const cold = new SourceStore(new DirectoryObjectStore(tmp), "tenant-a", { now });
    await cold.applyBatch(identity, { batchId: "after-crash", changes: [put("second", "2026-10-17T10:00:00Z")] });
    const replay = await cold.applyBatch(identity, batch);
    expect(replay.commitId).toBe(first?.commitId ?? committed.value.commitId);
    expect(replay.seq).toBe(1);
    expect(replay.results[0]?.outcome).toBe("created");
  });

  it("preserves legitimate provider file and directory names that match Object prototype keys", async () => {
    const sources = new SourceStore(new DirectoryObjectStore(tmp), "tenant-a", { now });
    const changes = ["__proto__", "constructor", "toString", "nested/__proto__/file.txt"].map((name) => ({ ...put(name), path: `sources/github/${name}` }));
    const receipt = await sources.applyBatch(identity, { batchId: "prototype-names", changes });
    expect(receipt.results.every((r) => r.outcome === "created")).toBe(true);
    const cold = new SourceStore(new DirectoryObjectStore(tmp), "tenant-a", { now });
    for (const change of changes) {
      const versions = await cold.history(change.path.slice("sources/".length));
      const bytes = await cold.readRange(versions.versions[0]!, 0, change.size);
      expect(bytes.toString()).toBe(Buffer.from(change.inline!, "base64").toString());
    }
  });

  it("keeps tenant namespaces separate even when the same provider path and batch id are used", async () => {
    const store = new DirectoryObjectStore(tmp);
    const a = new SourceStore(store, "tenant-a", { now });
    const b = new SourceStore(store, "tenant-b", { now });
    await a.applyBatch(identity, { batchId: "one", changes: [put("a")] });
    await b.applyBatch(identity, { batchId: "one", changes: [put("b")] });
    const [av, bv] = await Promise.all([a.history("github/repo/file.txt"), b.history("github/repo/file.txt")]);
    expect((await a.readRange(av.versions[0]!, 0, 1)).toString()).toBe("a");
    expect((await b.readRange(bv.versions[0]!, 0, 1)).toString()).toBe("b");
  });
});
