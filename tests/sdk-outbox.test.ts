/**
 * Durable SDK delivery (opt-in outbox): restart-safe continuation against the REAL TraceIngestor over a directory store.
 * "Crash" = drop every in-memory object (recorder + session) without any cleanup, then build a fresh recorder over the
 * same outbox and resume.
 */
import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTraceOutbox, InProcessTraceTransport, MemoryTraceOutbox, TraceOutboxError, TraceRecorder, TraceTransportError, type TraceOutboxStore, type TraceTransport } from "../src/sdk/index.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { materializeCohort, pinDailyManifest, TraceIngestor, type TraceChunk, type TraceEvent } from "../src/traces/index.js";

const NS = "tenant-outbox";
let root: string;
let store: DirectoryObjectStore;
let ingestor: TraceIngestor;
let outboxDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "procmem-outbox-"));
  store = new DirectoryObjectStore(path.join(root, "objects"));
  ingestor = new TraceIngestor(store, { now: () => new Date("2026-10-17T12:00:00Z") });
  outboxDir = path.join(root, "outbox");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Transport whose server ACCEPTS a chunk but the response is lost (network error), once per listed chunkSeq. */
class LostAckTransport implements TraceTransport {
  readonly sent: Array<{ chunkSeq: number; status: string }> = [];
  constructor(private readonly inner: TraceTransport, private readonly loseAckFor: Set<number>) {}
  async sendChunk(chunk: TraceChunk) {
    const ack = await this.inner.sendChunk(chunk);
    this.sent.push({ chunkSeq: chunk.chunkSeq, status: ack.status });
    if (this.loseAckFor.delete(chunk.chunkSeq)) throw new TraceTransportError("socket hang up after the request was written", null, true, "network_error");
    return ack;
  }
  putBlob(sha: string, bytes: Uint8Array, mediaType: string) {
    return this.inner.putBlob(sha, bytes, mediaType);
  }
}

/** No background flushing: chunk boundaries are exactly the explicit flush()/checkpoint()/finish() calls. */
function recorder(transport: TraceTransport, outbox: TraceOutboxStore = new FileTraceOutbox(outboxDir)) {
  return new TraceRecorder({ transport, agent: { id: "agent-durable" }, flushIntervalMs: 0, maxRetries: 0, maxBatchEvents: 100, outbox });
}
const offline: TraceTransport = { sendChunk: async () => Promise.reject(new TraceTransportError("offline", null, true)), putBlob: async () => undefined };

async function storedEvents(sessionId: string): Promise<TraceEvent[]> {
  const pin = await pinDailyManifest(store, NS, "2026-10-17");
  const files = await materializeCohort(store, NS, pin.manifest!);
  return files.get(`sessions/${sessionId}/events.jsonl`)!.trim().split("\n").map((l) => JSON.parse(l) as TraceEvent);
}

describe("durable outbox: crash and resume", () => {
  it("a chunk accepted by the server whose ack was lost is resent after a crash and deduplicated (same key and digest)", async () => {
    const lossy = new LostAckTransport(new InProcessTraceTransport(ingestor, NS), new Set([2]));
    const r1 = recorder(lossy);
    const s = r1.begin({ objective: "lost ack", sessionId: "ses-lost-ack", conversationId: "thread-42" });
    s.note({ a: 1 });
    await s.flush(); // chunk 1 delivered and acked
    s.note({ a: 2 });
    s.note({ a: 3 });
    await expect(s.flush()).rejects.toThrow(/Could not deliver/);
    expect(lossy.sent.map((x) => x.chunkSeq)).toEqual([1, 2]);
    const idx2 = await ingestor.getChunkIndex(NS, "ses-lost-ack", 2);
    expect(idx2).toBeTruthy();
    // crash: r1 and s are dropped without cleanup

    const replay = new LostAckTransport(new InProcessTraceTransport(ingestor, NS), new Set());
    const r2 = recorder(replay);
    expect(await r2.pendingSessions()).toEqual(["ses-lost-ack"]);
    const resumed = await r2.resume("ses-lost-ack");
    expect(resumed.correlation.conversationId).toBe("thread-42");
    await resumed.flush();
    expect(replay.sent[0]).toEqual({ chunkSeq: 2, status: "duplicate" }); // same chunkSeq + bytes -> server dedup
    expect(await ingestor.getChunkIndex(NS, "ses-lost-ack", 2)).toEqual(idx2); // same day, key, digest
    resumed.note({ a: 4 });
    await resumed.finish({ status: "succeeded", summary: "done" });
    const events = await storedEvents("ses-lost-ack");
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]); // exactly once, contiguous
    expect(events.filter((e) => e.type === "session_end")).toHaveLength(1);
  });

  it("restart continuation never reuses seq/chunkSeq; events after the last checkpoint are honestly lost", async () => {
    const t = new InProcessTraceTransport(ingestor, NS);
    const r1 = recorder(t);
    const s = r1.begin({ objective: "long", sessionId: "ses-restart", conversationId: "thread-restart" });
    s.note({ step: 1 });
    await s.checkpoint(); // durable now (not sent)
    s.note({ step: "unflushed" }); // in memory only: documented boundary
    // crash

    const r2 = recorder(t);
    const resumed = await r2.resume("ses-restart");
    expect(resumed.eventCount).toBe(2); // session_start + step 1; the unflushed event is gone (never sent, never stored)
    resumed.note({ step: 2 });
    await resumed.finish({ status: "succeeded", summary: "ok" });
    const events = await storedEvents("ses-restart");
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => (e.data as { step?: unknown } | null)?.step ?? e.type)).toEqual(["session_start", 1, 2, "session_end"]);
    expect(events.every((e) => !JSON.stringify(e.data).includes("unflushed"))).toBe(true);
  });

  it("two writers of one session: the stale one fails closed (CAS), and begin() cannot reuse an outbox session id", async () => {
    const t = new InProcessTraceTransport(ingestor, NS);
    const outbox = new FileTraceOutbox(outboxDir);
    const r1 = recorder(t, outbox);
    const s = r1.begin({ objective: "writers", sessionId: "ses-writers" });
    await s.checkpoint();
    const takeover = await recorder(t, outbox).resume("ses-writers");
    s.note({ stale: true });
    await expect(s.flush()).rejects.toMatchObject({ code: "ownership_lost" });
    expect(() => s.note({ again: true })).toThrow(TraceOutboxError); // fenced
    takeover.note({ fresh: true });
    await takeover.finish({ status: "succeeded", summary: "ok" });
    const dup = recorder(t, outbox).begin({ objective: "reuse", sessionId: "ses-writers" });
    await expect(dup.flush()).rejects.toMatchObject({ code: "session_exists" });
    const events = await storedEvents("ses-writers");
    expect(events.some((e) => JSON.stringify(e.data).includes("stale"))).toBe(false);
  });

  it("finalization: a delivered finish leaves a tombstone; a lost final ack replays as duplicate with one session_end", async () => {
    const lossy = new LostAckTransport(new InProcessTraceTransport(ingestor, NS), new Set([2]));
    const outbox = new MemoryTraceOutbox();
    const s = recorder(lossy, outbox).begin({ objective: "final", sessionId: "ses-final" });
    s.note({ x: 1 });
    await s.flush(); // chunk 1 acked; the final chunk will be chunk 2
    await expect(s.finish({ status: "succeeded", summary: "done" })).rejects.toThrow(/Could not deliver/);
    // crash after the server accepted the FINAL chunk but before the ack was persisted
    const t2 = new LostAckTransport(new InProcessTraceTransport(ingestor, NS), new Set());
    const resumed = await recorder(t2, outbox).resume("ses-final");
    expect(resumed.finished).toBe(true);
    expect(() => resumed.note({ more: true })).toThrow(/finished/);
    await resumed.flush();
    expect(t2.sent).toEqual([{ chunkSeq: 2, status: "duplicate" }]);
    expect(resumed.delivered).toBe(true);
    expect(await recorder(t2, outbox).pendingSessions()).toEqual([]); // tombstone only
    expect(outbox.objectKeys()).toEqual([]); // bodies deleted after ack
    const again = await recorder(t2, outbox).resume("ses-final");
    expect(again.delivered).toBe(true);
    await again.flush(); // nothing to send
    expect(t2.sent).toHaveLength(1);
    const events = await storedEvents("ses-final");
    expect(events.filter((e) => e.type === "session_end")).toHaveLength(1);
    expect(await recorder(t2, outbox).begin({ objective: "reuse", sessionId: "ses-final" }).flush().catch((e: unknown) => e)).toMatchObject({ code: "session_exists" });
  });

  it("corrupt or tampered outbox state is rejected, never silently accepted", async () => {
    const outbox = new MemoryTraceOutbox();
    const s = recorder(offline, outbox).begin({ objective: "corrupt", sessionId: "ses-corrupt" });
    s.note({ big: "y".repeat(80_000) }); // forces a blob
    await s.checkpoint();
    const key = outbox.objectKeys().find((k) => k.startsWith("chunk/"))!;
    const original = await outbox.getObject(key);
    await outbox.putObject(key, Buffer.from(Buffer.from(original!).toString("utf8").replace("corrupt", "c0rrupt")));
    await expect(recorder(offline, outbox).resume("ses-corrupt")).rejects.toMatchObject({ code: "corrupt" });
    await outbox.putObject(key, original!);
    const blobKey = outbox.objectKeys().find((k) => k.startsWith("blob/"))!;
    await outbox.putObject(blobKey, Buffer.from("tampered"));
    await expect(recorder(offline, outbox).resume("ses-corrupt")).rejects.toMatchObject({ code: "corrupt" });
    await outbox.casCheckpoint("ses-bad", null, '{"format":"procmem.trace-outbox/v1","revision":1}', 1);
    await expect(recorder(offline, outbox).resume("ses-bad")).rejects.toMatchObject({ code: "corrupt" });
    await expect(recorder(offline, outbox).resume("ses-missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("outbox object safety under racing writers and shared blobs", () => {
  it("a duplicate begin() with different events cannot overwrite the surviving session's pending chunk bodies", async () => {
    const outbox = new FileTraceOutbox(outboxDir);
    const legit = recorder(offline, outbox).begin({ objective: "legit", sessionId: "ses-race" });
    legit.note({ who: "legit", n: 1 });
    await legit.checkpoint(); // chunk 1 = legit events, pending (offline)
    const intruder = recorder(offline, outbox).begin({ objective: "intruder", sessionId: "ses-race" });
    intruder.note({ who: "intruder", n: 1 });
    await expect(intruder.checkpoint()).rejects.toMatchObject({ code: "session_exists" }); // its pre-CAS body write used its own key
    const stale = await recorder(offline, outbox).resume("ses-race"); // takeover by a legitimate restart
    legit.note({ who: "legit-stale", n: 2 });
    await expect(legit.checkpoint()).rejects.toMatchObject({ code: "ownership_lost" });
    void stale;
    // The surviving checkpoint still resumes with every digest intact and delivers ONLY the legitimate events.
    const survivor = await recorder(new InProcessTraceTransport(ingestor, NS), outbox).resume("ses-race");
    await survivor.finish({ status: "succeeded", summary: "ok" });
    const events = await storedEvents("ses-race");
    expect(events.map((e) => (e.data as { who?: string } | null)?.who ?? e.type)).toEqual(["session_start", "legit", "session_end"]);
    expect((events[0]!.data as { objective: string }).objective).toBe("legit");
  });

  it("two sessions with an identical large blob: delivering one never deletes the other's copy", async () => {
    const outbox = new FileTraceOutbox(outboxDir);
    const big = "shared-payload-".repeat(10_000); // > 64 KiB -> content-addressed blob, same sha in both sessions
    const a = recorder(offline, outbox).begin({ objective: "a", sessionId: "ses-blob-a" });
    const b = recorder(offline, outbox).begin({ objective: "b", sessionId: "ses-blob-b" });
    a.note(big);
    b.note(big);
    await a.checkpoint();
    await b.checkpoint();
    const live = new InProcessTraceTransport(ingestor, NS);
    const ra = await recorder(live, outbox).resume("ses-blob-a");
    await ra.finish({ status: "succeeded", summary: "a delivered" }); // acks a's chunks, deletes a's blob copy
    const rb = await recorder(live, outbox).resume("ses-blob-b"); // b's blob must still be there
    await rb.finish({ status: "succeeded", summary: "b delivered" });
    const pin = await pinDailyManifest(store, NS, "2026-10-17");
    const files = await materializeCohort(store, NS, pin.manifest!);
    expect([...files.keys()].filter((k) => k.includes("/payloads/")).length).toBe(2); // one payload file per session
  });
});

describe("FileTraceOutbox hygiene", () => {
  it("keeps raw traces private: 0700 dirs, 0600 files, symlinks refused", async () => {
    const s = recorder(offline).begin({ objective: "perms", sessionId: "ses-perms" });
    s.note({ secretish: "raw trace payload" });
    await s.checkpoint();
    for (const d of [outboxDir, path.join(outboxDir, "sessions"), path.join(outboxDir, "objects")]) expect((await stat(d)).mode & 0o777).toBe(0o700);
    const files = [...(await readdir(path.join(outboxDir, "sessions"))).map((f) => path.join(outboxDir, "sessions", f)), ...(await readdir(path.join(outboxDir, "objects"))).map((f) => path.join(outboxDir, "objects", f))];
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) if (!f.endsWith(".lock")) expect((await lstat(f)).mode & 0o777).toBe(0o600);

    const evil = path.join(root, "evil");
    await mkdir(evil, { recursive: true });
    await writeFile(path.join(evil, "target.json"), "{}", { mode: 0o600 });
    const linkDir = path.join(root, "outbox-link");
    await mkdir(path.join(linkDir, "sessions"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(linkDir, "objects"), { recursive: true, mode: 0o700 });
    await symlink(path.join(evil, "target.json"), path.join(linkDir, "sessions", "ses-link.json"));
    await expect(new FileTraceOutbox(linkDir).readCheckpoint("ses-link")).rejects.toThrow(/symlink/);
    const worldDir = path.join(root, "outbox-world");
    await mkdir(worldDir, { mode: 0o777 });
    await import("node:fs/promises").then((f) => f.chmod(worldDir, 0o777));
    await expect(new FileTraceOutbox(worldDir).listSessions()).rejects.toThrow(/group\/world writable/);
  });
});
