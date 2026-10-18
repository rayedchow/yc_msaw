import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceBindings } from "../src/sources/bindings.js";
import { agentToStored, SourceError, wireToStored } from "../src/sources/paths.js";
import { SourceService } from "../src/sources/service.js";
import {
  CHUNK_BYTES,
  MAX_PAGE_ENTRIES,
  SourceNodeCache,
  SourceStore,
  type DeleteChange,
  type PutChange,
  type SourceChange,
} from "../src/sources/store.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

const runtime = { bindingId: "sb-0000000000000001", providers: ["*"] };
let tmp: string;
let objects: DirectoryObjectStore;
let clock = Date.parse("2026-10-17T12:00:00.000Z");
const now = () => new Date(clock);

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "sources-store-"));
  objects = new DirectoryObjectStore(tmp);
  clock = Date.parse("2026-10-17T12:00:00.000Z");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function put(p: string, text: string | Buffer, opts: Partial<PutChange> = {}): PutChange {
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  return {
    op: "put",
    path: p,
    kind: "projection",
    contentType: "text/markdown",
    size: bytes.length,
    sha256: sha256(bytes),
    inline: bytes.toString("base64"),
    capturedAt: "2026-10-17T11:00:00.000Z",
    ...opts,
  };
}

function del(p: string, opts: Partial<DeleteChange> = {}): DeleteChange {
  return { op: "delete", path: p, deletedAt: "2026-10-17T11:30:00.000Z", reason: "provider_deleted", capturedAt: "2026-10-17T11:30:00.000Z", ...opts };
}

let batchSeq = 0;
async function apply(store: SourceStore, changes: SourceChange[], batchId = `b-${++batchSeq}`) {
  return store.applyBatch(runtime, { batchId, changes });
}

async function text(store: SourceStore, stored: string): Promise<string> {
  const r = await store.resolve(stored);
  if (!r || r.type !== "file") throw new Error(`${stored} is not a file`);
  const v = await store.version(r.entry.v);
  return (await store.readRange(v, 0, v.size)).toString("utf8");
}

describe("source paths", () => {
  it("accepts only canonical sources/<provider>/<file> wire paths", () => {
    expect(wireToStored("sources/google-docs/Team Handbook/Tab 1.md")).toEqual({ stored: "google-docs/Team Handbook/Tab 1.md", provider: "google-docs" });
    for (const bad of [
      "google-docs/x.md",
      "sources/google-docs",
      "sources//x.md",
      "sources/google-docs/../gmail/x.md",
      "sources/google-docs/./x.md",
      "sources/google-docs/a//b.md",
      "sources/google-docs/x.md/",
      "sources/Google/x.md",
      "sources/google-docs/a\u0000b",
      "sources/google-docs/a\\b",
      "/sources/google-docs/x.md",
    ]) {
      expect(() => wireToStored(bad), bad).toThrow(SourceError);
    }
  });

  it("normalizes agent paths without allowing traversal outside $SOURCES", () => {
    expect(agentToStored("$SOURCES")).toBe("");
    expect(agentToStored("${SOURCES}/slack//C1/")).toBe("slack/C1");
    for (const bad of ["$SOURCES/../KNOWLEDGE", "$SOURCES/slack/../../x", "$SOURCES/a\u0001", "$KNOWLEDGE/index.md", "sources/slack"]) {
      expect(() => agentToStored(bad), bad).toThrow(SourceError);
    }
  });
});

describe("SourceStore versions, tombstones and history", () => {
  it("creates, updates, deletes, restores and keeps the full chain", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    const p = "sources/notion/Projects/Roadmap.md";
    expect((await apply(s, [put(p, "v1", { capturedAt: "2026-10-17T10:00:00Z", sourceUpdatedAt: "2026-10-17T09:00:00Z" })])).results[0]!.outcome).toBe("created");
    expect((await apply(s, [put(p, "v1", { capturedAt: "2026-10-17T10:00:00Z", sourceUpdatedAt: "2026-10-17T09:00:00Z" })])).results[0]!.outcome).toBe("unchanged");
    expect((await apply(s, [put(p, "v2", { capturedAt: "2026-10-17T10:05:00Z", sourceUpdatedAt: "2026-10-17T10:04:00Z" })])).results[0]!.outcome).toBe("updated");
    expect((await apply(s, [del(p, { deletedAt: "2026-10-17T10:10:00Z", capturedAt: "2026-10-17T10:10:00Z" })])).results[0]!.outcome).toBe("deleted");
    expect((await apply(s, [del(p, { deletedAt: "2026-10-17T10:11:00Z", capturedAt: "2026-10-17T10:11:00Z" })])).results[0]!.outcome).toBe("absent");
    // Restore keeps an old provider modification time (e.g. untrash); observation order decides.
    expect((await apply(s, [put(p, "v2", { capturedAt: "2026-10-17T10:20:00Z", sourceUpdatedAt: "2026-10-17T10:04:00Z" })])).results[0]!.outcome).toBe("restored");

    const h = await s.history("notion/Projects/Roadmap.md");
    expect(h.versions.map((v) => v.kind)).toEqual(["projection", "tombstone", "projection", "projection"]);
    expect(h.versions[1]!.deleted).toEqual({ at: "2026-10-17T10:10:00.000Z", reason: "provider_deleted" });
    expect((await s.readRange(h.versions[3]!, 0, 10)).toString()).toBe("v1");
    expect(await text(s, "notion/Projects/Roadmap.md")).toBe("v2");
    // Paging through history.
    const first = await s.history("notion/Projects/Roadmap.md", { limit: 2 });
    const rest = await s.history("notion/Projects/Roadmap.md", { before: first.nextBefore! });
    expect([...first.versions, ...rest.versions].map((v) => v.versionId)).toEqual(h.versions.map((v) => v.versionId));
  });

  it("hides tombstones from listings but keeps them reachable", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    await apply(s, [put("sources/slack/C1/a.md", "a"), put("sources/slack/C1/b.md", "b")]);
    await apply(s, [del("sources/slack/C1/a.md")]);
    expect((await s.list("slack/C1")).entries.map((e) => e.name)).toEqual(["b.md"]);
    expect((await s.list("slack/C1", { includeDeleted: true })).entries.map((e) => [e.name, e.entry.t])).toEqual([["a.md", "x"], ["b.md", "f"]]);
    await apply(s, [del("sources/slack/C1/b.md")]);
    // A directory with only tombstones disappears from its parent's listing.
    expect((await s.list("slack")).entries).toEqual([]);
    expect((await s.list("slack", { includeDeleted: true })).entries.map((e) => e.name)).toEqual(["C1"]);
  });

  it("orders late polls by provider version, then provider time, then capture time", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    const p = "sources/confluence/S1/42.md";
    await apply(s, [put(p, "v7", { sourceVersion: { ref: "v7", ordinal: 7 }, sourceUpdatedAt: "2026-10-17T08:00:00Z", capturedAt: "2026-10-17T08:00:00Z" })]);
    // Older ordinal is stale even with a newer provider time and capture time.
    expect((await apply(s, [put(p, "v6", { sourceVersion: { ref: "v6", ordinal: 6 }, sourceUpdatedAt: "2026-10-17T09:00:00Z", capturedAt: "2026-10-17T09:00:00Z" })])).results[0]!.outcome).toBe("stale");
    // Same version re-rendered applies.
    expect((await apply(s, [put(p, "v7 rerendered", { sourceVersion: { ref: "v7", ordinal: 7 }, sourceUpdatedAt: "2026-10-17T08:00:00Z", capturedAt: "2026-10-17T09:30:00Z" })])).results[0]!.outcome).toBe("updated");

    const q = "sources/gmail/u1/t1.md";
    await apply(s, [put(q, "new", { sourceUpdatedAt: "2026-10-16T20:00:00Z", capturedAt: "2026-10-16T21:00:00Z" })]);
    expect((await apply(s, [put(q, "old", { sourceUpdatedAt: "2026-10-16T10:00:00Z", capturedAt: "2026-10-17T11:00:00Z" })])).results[0]!.outcome).toBe("stale");
    // A delete observed for a time before the last provider change is stale.
    expect((await apply(s, [del(q, { deletedAt: "2026-10-16T19:00:00Z", capturedAt: "2026-10-17T11:01:00Z" })])).results[0]!.outcome).toBe("stale");
    // Without provider times capture order decides.
    const r = "sources/granola/n1.md";
    await apply(s, [put(r, "b", { capturedAt: "2026-10-17T10:00:00Z" })]);
    expect((await apply(s, [put(r, "a", { capturedAt: "2026-10-17T09:00:00Z" })])).results[0]!.outcome).toBe("stale");
    expect(await text(s, "granola/n1.md")).toBe("b");
  });

  it("rejects future capture times and paths outside the binding's providers", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    await expect(apply(s, [put("sources/slack/x.md", "x", { capturedAt: "2026-10-18T12:00:00Z" })])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(s.applyBatch({ bindingId: "sb-0000000000000002", providers: ["imessage"] }, { batchId: "x", changes: [put("sources/slack/x.md", "x")] })).rejects.toMatchObject({
      code: "forbidden_provider",
    });
    await expect(apply(s, [put("sources/slack/x.md", "x"), put("sources/slack/x.md", "y")])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(apply(s, [{ ...put("sources/slack/x.md", "x"), sha256: sha256("other") }])).rejects.toMatchObject({ code: "integrity" });
  });

  it("rejects file/directory shape conflicts per change without blocking the rest of the batch", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    await apply(s, [put("sources/github/repo/README.md", "r")]);
    const r = await apply(s, [put("sources/github/repo/README.md/inner.md", "x"), put("sources/github/repo", "x"), put("sources/github/repo/ok.md", "ok")]);
    expect(r.results.map((x) => x.outcome)).toEqual(["rejected", "rejected", "created"]);
    expect(r.results[0]!.error?.code).toBe("path_conflict");
    expect(await text(s, "github/repo/ok.md")).toBe("ok");
  });

  it("forces the provenance bindingId to the publishing binding", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    await apply(s, [put("sources/jira/P/P-1.md", "x", { provenance: { bindingId: "sb-forged", sourceEventId: "nango:jira:issue:1" } })]);
    const v = (await s.history("jira/P/P-1.md")).versions[0]!;
    expect(v.provenance).toMatchObject({ bindingId: runtime.bindingId, sourceEventId: "nango:jira:issue:1" });
  });
});

describe("SourceStore batch idempotency", () => {
  it("returns the committed receipt for a replay and refuses a different request with the same batchId", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    const first = await apply(s, [put("sources/slack/a.md", "a")], "same");
    const replay = await new SourceStore(new DirectoryObjectStore(tmp), "tenant-a", { now }).applyBatch(runtime, { batchId: "same", changes: [put("sources/slack/a.md", "a")] });
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(apply(s, [put("sources/slack/a.md", "different")], "same")).rejects.toMatchObject({ code: "batch_conflict" });
    // The same batchId from another binding is a different batch.
    const other = await s.applyBatch({ bindingId: "sb-0000000000000009", providers: ["*"] }, { batchId: "same", changes: [put("sources/slack/b.md", "b")] });
    expect(other.replayed).toBeUndefined();
  });

  it("commits no-op batches so a late replay cannot reapply old content", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    await apply(s, [put("sources/slack/a.md", "a", { capturedAt: "2026-10-17T09:00:00Z" })], "one");
    const noop = await apply(s, [put("sources/slack/a.md", "a", { capturedAt: "2026-10-17T09:00:00Z" })], "two");
    expect(noop.results[0]!.outcome).toBe("unchanged");
    await apply(s, [put("sources/slack/a.md", "b", { capturedAt: "2026-10-17T10:00:00Z" })], "three");
    const again = await apply(s, [put("sources/slack/a.md", "a", { capturedAt: "2026-10-17T09:00:00Z" })], "two");
    expect(again.replayed).toBe(true);
    expect(await text(s, "slack/a.md")).toBe("b");
  });

  it("resolves concurrent identical requests to one commit and concurrent conflicting requests to one winner", async () => {
    const stores = Array.from({ length: 6 }, () => new SourceStore(new DirectoryObjectStore(tmp), "tenant-a", { now }));
    const same = await Promise.all(stores.map((s) => s.applyBatch(runtime, { batchId: "race", changes: [put("sources/slack/r.md", "r")] })));
    expect(new Set(same.map((r) => r.commitId)).size).toBe(1);
    expect(same.filter((r) => !r.replayed)).toHaveLength(1);

    const mixed = await Promise.allSettled(
      stores.map((s, i) => s.applyBatch(runtime, { batchId: "race-2", changes: [put("sources/slack/m.md", `m${i}`)] })),
    );
    const ok = mixed.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<SourceStore["applyBatch"]>>>[];
    const winners = ok.filter((r) => !r.value.replayed);
    expect(winners).toHaveLength(1);
    for (const r of mixed) if (r.status === "rejected") expect((r.reason as SourceError).code).toBe("batch_conflict");
  });

  it("applies concurrent distinct batches without losing any change", async () => {
    const stores = Array.from({ length: 8 }, () => new SourceStore(new DirectoryObjectStore(tmp), "tenant-a", { now }));
    await Promise.all(stores.map((s, i) => s.applyBatch(runtime, { batchId: `p-${i}`, changes: [put(`sources/github/repo/f${i}.md`, `f${i}`), put(`sources/slack/c/${i}.md`, `${i}`)] })));
    const s = new SourceStore(objects, "tenant-a", { now });
    expect((await s.head()).value.seq).toBe(8);
    expect((await s.list("github/repo")).entries.map((e) => e.name).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `f${i}.md`).sort());
    expect((await s.list("slack/c")).entries).toHaveLength(8);
  });
});

describe("SourceStore scale and integrity", () => {
  it("pages large directories instead of rejecting them, and lists/looks up across pages", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    const total = MAX_PAGE_ENTRIES * 2 + 345;
    const names = Array.from({ length: total }, (_, i) => `evt-${String(i).padStart(6, "0")}.json`);
    for (let i = 0; i < total; i += 1_500) {
      await apply(s, names.slice(i, i + 1_500).map((n) => put(`sources/slack/_raw/T1/C1/2026-10/${n}`, n, { kind: "raw", contentType: "application/json" })));
    }
    const dir = await s.resolve("slack/_raw/T1/C1/2026-10");
    expect(dir?.type).toBe("dir");
    expect((await s.node((dir as { sha: string }).sha)).schema).toBe("procmem.source-tree-pages/v1");
    expect((dir as { entry: { files: number } }).entry.files).toBe(total);
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await s.list("slack/_raw/T1/C1/2026-10", { limit: 1_000, ...(after ? { after } : {}) });
      seen.push(...page.entries.map((e) => e.name));
      after = page.nextAfter ?? undefined;
    } while (after);
    expect(seen).toEqual(names);
    expect(await text(s, `slack/_raw/T1/C1/2026-10/${names[total - 1]}`)).toBe(names[total - 1]);
    // Updating one entry rewrites only its page; others stay shared.
    await apply(s, [put(`sources/slack/_raw/T1/C1/2026-10/${names[10]}`, "changed", { kind: "raw", contentType: "application/json", capturedAt: "2026-10-17T11:59:00Z" })]);
    expect(await text(s, `slack/_raw/T1/C1/2026-10/${names[10]}`)).toBe("changed");
    let count = 0;
    for await (const item of s.walk("slack/_raw")) if (item.entry.t === "f") count++;
    expect(count).toBe(total);
  });

  it("bounds the shared metadata cache by bytes across tenants while large pages keep reading correctly", async () => {
    const cache = new SourceNodeCache(2 * 1024 * 1024);
    const writer = new SourceStore(objects, "tenant-a", { now });
    // ~6 pages of ~200-byte names: each page is several hundred KB of JSON.
    const names = Array.from({ length: MAX_PAGE_ENTRIES * 3 }, (_, i) => `${"n".repeat(180)}-${String(i).padStart(6, "0")}.json`);
    for (let i = 0; i < names.length; i += 1_500) {
      await apply(writer, names.slice(i, i + 1_500).map((n) => put(`sources/github/_raw/r/${n}`, n, { kind: "raw", contentType: "application/json" })));
    }
    const a = new SourceStore(objects, "tenant-a", { now, cache });
    const b = new SourceStore(objects, "tenant-b", { now, cache });
    await apply(b, [put("sources/github/_raw/r/only-b.json", "b", { kind: "raw", contentType: "application/json" })]);
    let seen = 0;
    for await (const item of a.walk("github")) if (item.entry.t === "f") seen++;
    expect(seen).toBe(names.length);
    expect(cache.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(cache.size).toBeGreaterThan(0);
    // Evicted pages are re-read and re-verified; tenants never see each other's nodes.
    expect(await text(a, `github/_raw/r/${names[0]}`)).toBe(names[0]);
    expect(await text(a, `github/_raw/r/${names[names.length - 1]}`)).toBe(names[names.length - 1]);
    expect(await b.resolve(`github/_raw/r/${names[0]}`)).toBeNull();
    expect(await text(b, "github/_raw/r/only-b.json")).toBe("b");
    expect(cache.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("stores multi-chunk binaries exactly and detects tampered chunks", async () => {
    const s = new SourceStore(objects, "tenant-a", { now });
    const big = Buffer.alloc(CHUNK_BYTES * 2 + 1234);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    const chunks = [big.subarray(0, CHUNK_BYTES), big.subarray(CHUNK_BYTES, CHUNK_BYTES * 2), big.subarray(CHUNK_BYTES * 2)];
    const change: PutChange = { op: "put", path: "sources/google-docs/d1/file.pdf", kind: "binary", contentType: "application/pdf", size: big.length, sha256: sha256(big), chunks: chunks.map((c) => sha256(c)), capturedAt: "2026-10-17T11:00:00Z" };
    await expect(apply(s, [change])).rejects.toMatchObject({ code: "missing_blobs" });
    for (const c of chunks) await s.putBlob(Buffer.from(c), sha256(c));
    await apply(s, [change]);
    const v = (await s.history("google-docs/d1/file.pdf")).versions[0]!;
    expect(v.chunks.map((c) => c.size)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 1234]);
    const window = await s.readRange(v, CHUNK_BYTES - 5, 20);
    expect(window.equals(big.subarray(CHUNK_BYTES - 5, CHUNK_BYTES + 15))).toBe(true);
    expect((await s.readRange(v, 0, big.length)).equals(big)).toBe(true);
    // Corrupt a stored chunk on disk: reads fail closed instead of serving wrong bytes.
    const victim = path.join(tmp, "tenant-a", "objects", "blobs", v.chunks[2]!.sha256);
    await rm(victim, { force: true });
    await writeFile(victim, Buffer.alloc(1234, 1));
    await expect(s.readRange(v, CHUNK_BYTES * 2, 10)).rejects.toMatchObject({ code: "integrity" });
  });

  it("isolates tenants sharing one object store", async () => {
    const a = new SourceStore(objects, "tenant-a", { now });
    const b = new SourceStore(objects, "tenant-b", { now });
    await apply(a, [put("sources/slack/secret.md", "a-only")]);
    expect(await b.resolve("slack/secret.md")).toBeNull();
    const va = (await a.history("slack/secret.md")).versions[0]!;
    await expect(b.version(va.versionId)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("bindings and status", () => {
  it("verifies only the exact active token of the namespace that created it", async () => {
    const bindings = new SourceBindings(objects);
    const { token, binding } = await bindings.create("tenant-a", { kind: "runtime", providers: ["slack"] }, { subject: "admin", issuer: "iss" });
    expect((await bindings.verify(token))?.tenantNs).toBe("tenant-a");
    const [, ns, rest] = /^psb_([^.]+)\.(.+)$/.exec(token)!;
    expect(ns).toBe("tenant-a");
    expect(await bindings.verify(`psb_tenant-b.${rest}`)).toBeNull();
    expect(await bindings.verify(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(await bindings.verify("psb_garbage")).toBeNull();
    expect((await bindings.list("tenant-a"))[0]).not.toHaveProperty("tokenSha256");
    await bindings.revoke("tenant-a", binding.bindingId);
    expect(await bindings.verify(token)).toBeNull();
    await expect(bindings.create("tenant-a", { kind: "device", providers: ["slack"] }, { subject: "u", issuer: "iss" })).rejects.toMatchObject({ code: "forbidden_provider" });
  });

  it("separates data age, successful checks and collector heartbeat", async () => {
    const service = new SourceService(objects, now);
    const { binding } = await service.bindings.create("tenant-a", { kind: "runtime", providers: ["*"] }, { subject: "admin", issuer: "iss" });
    const record = (await service.bindings.registry("tenant-a")).value.bindings[binding.bindingId]!;
    await service.storeFor("tenant-a").applyBatch({ bindingId: binding.bindingId, providers: ["*"] }, { batchId: "x", changes: [put("sources/notion/p.md", "p", { capturedAt: "2026-10-10T00:00:00Z" })] });
    // A no-change poll succeeded just now: data is old, the collector is healthy.
    await service.reportStatus("tenant-a", record, {
      providers: [{ provider: "notion", scope: "workspace", state: "complete", lastSuccessAt: "2026-10-17T11:59:00.000Z" }],
      runtime: { reportIntervalSeconds: 60 },
    });
    let st = (await service.status("tenant-a")).providers.find((p) => p.provider === "notion")!;
    expect(st.captureAgeSeconds).toBe(7 * 86_400 + 12 * 3_600);
    expect(st.checkAgeSeconds).toBe(60);
    expect(st.health).toBe("healthy");
    expect(st.coverageState).toBe("complete");
    // The collector stops reporting: coverage stays "complete" but health turns stale.
    clock += 10 * 60_000;
    st = (await service.status("tenant-a")).providers.find((p) => p.provider === "notion")!;
    expect(st.coverageState).toBe("complete");
    expect(st.health).toBe("stale");
    expect(st.reportAgeSeconds).toBe(600);
    // Unreported providers are never presented as complete.
    await service.storeFor("tenant-a").applyBatch({ bindingId: binding.bindingId, providers: ["*"] }, { batchId: "y", changes: [put("sources/granola/n.md", "n", { capturedAt: "2026-10-17T12:05:00Z" })] });
    const granola = (await service.status("tenant-a")).providers.find((p) => p.provider === "granola")!;
    expect([granola.coverageState, granola.health]).toEqual(["unreported", "unreported"]);
  });
});
