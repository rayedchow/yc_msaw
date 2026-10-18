/**
 * Conversation correlation end to end over the REAL ingestor, daily pinning/materialization and archive (directory
 * store; SDK in-process or through the real HTTP handler + HttpTraceTransport).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpTraceTransport, InProcessTraceTransport, TraceRecorder, type TraceTransport } from "../src/sdk/index.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { canonicalJson, sha256 } from "../src/util.js";
import {
  buildTraceArchive,
  chunkIndexKey,
  chunkObjectKey,
  ConversationLimitError,
  conversationMembers,
  encodeEventsJsonl,
  handleTraceRequest,
  markDailyStatus,
  materializeCohort,
  pinDailyManifest,
  readSessionBinding,
  TraceIngestor,
  type TraceChunk,
  type TraceEvent,
} from "../src/traces/index.js";

const NS = "tenant-conv";
const NS2 = "tenant-other";
let root: string;
let store: DirectoryObjectStore;
let clock: Date;
let ingestor: TraceIngestor;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "procmem-conv-"));
  store = new DirectoryObjectStore(path.join(root, "objects"));
  clock = new Date("2026-10-17T23:50:00Z");
  ingestor = new TraceIngestor(store, { now: () => clock });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function rec(transport: TraceTransport = new InProcessTraceTransport(ingestor, NS)) {
  return new TraceRecorder({ transport, agent: { id: "agent-conv" }, flushIntervalMs: 0, maxRetries: 0, maxBatchEvents: 100, now: () => clock });
}
const json = (files: Map<string, string>, p: string) => JSON.parse(files.get(p)!) as Record<string, any>;
const ev = (sessionId: string, seq: number, extra: Partial<TraceEvent> = {}): TraceEvent => ({ sessionId, seq, ts: "2026-10-17T12:00:00.000Z", type: seq === 1 ? "session_start" : "note", agent: { id: "a" }, data: { seq }, ...extra });
const corr = (conversationId: string, runId: string, extra: Record<string, string> = {}) => ({ conversationId, runId, conversationSource: "explicit" as const, ...extra });

describe("conversation identity across runs and days", () => {
  it("a retry is a new run of the same conversation; inputs and sources link every run", async () => {
    const r = rec();
    const first = r.begin({ objective: "refund o-42", sessionId: "ses-run-1", conversationId: "thread/slack:C1/1700.42", runId: "run-a" });
    first.note({ attempt: 1 });
    await first.finish({ status: "failed", summary: "timeout" });
    const retry = r.begin({ objective: "refund o-42", sessionId: "ses-run-2", conversationId: "thread/slack:C1/1700.42", runId: "run-b", previousRunId: "run-a" });
    await retry.finish({ status: "succeeded", summary: "refunded" });
    expect(first.correlation.conversationId).toBe(retry.correlation.conversationId);
    expect(retry.correlation).toMatchObject({ runId: "run-b", previousRunId: "run-a", conversationSource: "explicit" });

    const members = await conversationMembers(store, NS, "thread/slack:C1/1700.42");
    expect(members.map((m) => [m.sessionId, m.runId, m.previousRunId])).toEqual([["ses-run-1", "run-a", null], ["ses-run-2", "run-b", "run-a"]]);
    const pin = await pinDailyManifest(store, NS, "2026-10-17");
    const files = await materializeCohort(store, NS, pin.manifest!);
    const s2 = json(files, "sessions/ses-run-2/session.json");
    expect(s2.correlation).toMatchObject({ conversationId: "thread/slack:C1/1700.42", runId: "run-b", previousRunId: "run-a" });
    expect(s2.conversation).toMatchObject({ conversationId: "thread/slack:C1/1700.42", sessions: 2, runs: 2 });
    const convIndex = json(files, s2.conversation.index.replace(/^inputs\//, ""));
    expect(convIndex.sessions.map((o: any) => [o.sessionId, o.runId, o.inThisCohort])).toEqual([["ses-run-1", "run-a", true], ["ses-run-2", "run-b", true]]);
    expect(json(files, "manifest.json").conversations).toEqual([{ conversationId: "thread/slack:C1/1700.42", sessionsInCohort: ["ses-run-1", "ses-run-2"], totalSessions: 2, runs: ["run-a", "run-b"] }]);

    const archive = await buildTraceArchive(store, NS);
    const am = JSON.parse(archive.files.get("manifest.json")!);
    expect(am.conversations["thread/slack:C1/1700.42"]).toMatchObject({ sessions: ["ses-run-1", "ses-run-2"], runs: ["run-a", "run-b"] });
    const idx = JSON.parse(archive.files.get(am.conversations["thread/slack:C1/1700.42"].index.replace(/^sources\//, ""))!);
    expect(idx.sessions.map((s: any) => s.sessionId)).toEqual(["ses-run-1", "ses-run-2"]);
  });

  it("a session crossing midnight: day 2 pins only new chunks and records prior coverage explicitly", async () => {
    const r = rec();
    const s = r.begin({ objective: "long task", sessionId: "ses-midnight", conversationId: "conv-midnight" });
    s.startTurn("turn-1");
    s.note({ step: "before midnight" });
    await s.flush(); // chunk 1 received 2026-10-17
    const d1 = await pinDailyManifest(store, NS, "2026-10-17");
    expect(d1.manifest!.coverage![0]).toMatchObject({ sessionId: "ses-midnight", startsSession: true, prior: { chunks: 0 } });

    clock = new Date("2026-10-18T00:10:00Z");
    s.note({ step: "after midnight, unprocessed day 1" });
    await s.flush(); // chunk 2 received 2026-10-18 while day 1 is not yet published
    const early = await pinDailyManifest(store, NS, "2026-10-18");
    expect(early.manifest!.coverage![0]!.prior).toMatchObject({ chunks: 1, processedChunks: 0, unprocessedChunkSeqs: [1], days: ["2026-10-17"] });

    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: d1.manifest!.key, status: "building" });
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: d1.manifest!.key, status: "published", revisionId: "rev-1" });
    s.note({ step: "still the same conversation" });
    await s.finish({ status: "succeeded", summary: "done" });
    const d2 = await pinDailyManifest(store, NS, "2026-10-18");
    expect(d2.manifest!.chunks.map((c) => c.chunkSeq)).toEqual([2, 3]); // only new material; nothing reprocessed
    const cov = d2.manifest!.coverage![0]!;
    expect(cov).toMatchObject({ startsSession: false, cohort: { chunkSeqs: [2, 3], firstSeq: 3 }, prior: { chunks: 1, processedChunks: 1, unprocessedChunkSeqs: [], days: ["2026-10-17"], firstSeq: 1, lastSeq: 2 } });
    const files = await materializeCohort(store, NS, d2.manifest!);
    const sj = json(files, "sessions/ses-midnight/session.json");
    expect(sj.coverage.prior.processedChunks).toBe(1);
    expect(sj.correlation.conversationId).toBe("conv-midnight");
    expect(json(files, "manifest.json").sessions[0]).toMatchObject({ conversationId: "conv-midnight", continuation: true, priorChunks: 1 });
    const events = files.get("sessions/ses-midnight/events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l) as TraceEvent);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(events.every((e) => e.turnId === "turn-1")).toBe(true); // turn continues across midnight
  });
});

describe("interleaved receipt order across days", () => {
  it("chunk 2 received on Oct 16, chunks 1 and 3 on Oct 17: coverage exposes chunk 2, archive accounts for every seq", async () => {
    const c = corr("conv-interleave", "run-1");
    clock = new Date("2026-10-16T10:00:00Z");
    await ingestor.ingestChunk(NS, { sessionId: "ses-inter", chunkSeq: 2, events: [ev("ses-inter", 2)], correlation: c });
    clock = new Date("2026-10-17T10:00:00Z");
    await ingestor.ingestChunk(NS, { sessionId: "ses-inter", chunkSeq: 1, events: [ev("ses-inter", 1)], correlation: c });
    await ingestor.ingestChunk(NS, { sessionId: "ses-inter", chunkSeq: 3, events: [ev("ses-inter", 3, { type: "session_end", outcome: { status: "succeeded", summary: "ok" } })], final: true, correlation: c });

    const d16 = await pinDailyManifest(store, NS, "2026-10-16");
    await markDailyStatus(store, NS, "2026-10-16", { manifestKey: d16.manifest!.key, status: "building" });
    await markDailyStatus(store, NS, "2026-10-16", { manifestKey: d16.manifest!.key, status: "published", revisionId: "r16" });
    const d17 = await pinDailyManifest(store, NS, "2026-10-17");
    const cov = d17.manifest!.coverage![0]!;
    expect(cov.cohort.chunkSeqs).toEqual([1, 3]);
    expect(cov.prior).toMatchObject({ chunks: 1, chunkSeqs: [2], interleavedChunkSeqs: [2], days: ["2026-10-16"], processedChunks: 1, unprocessedChunkSeqs: [] });

    const archive = await buildTraceArchive(store, NS);
    const view = JSON.parse(archive.files.get("manifest.json")!).sessions["ses-inter"];
    expect(view).toMatchObject({ days: ["2026-10-16", "2026-10-17"], events: 3, firstSeq: 1, lastSeq: 3, complete: true });
    const seqs = ["2026-10-16", "2026-10-17"].flatMap((d) => archive.files.get(`traces/${d}/ses-inter/events.jsonl`)!.trim().split("\n").map((l) => (JSON.parse(l) as TraceEvent).seq));
    expect(seqs.sort()).toEqual([1, 2, 3]);
    const inputs = await materializeCohort(store, NS, d17.manifest!);
    expect(inputs.get("sessions/ses-inter/events.jsonl")!.trim().split("\n").map((l) => (JSON.parse(l) as TraceEvent).seq)).toEqual([1, 3]);
  });

  it("interleaved chunk on an UNPUBLISHED day is reported unprocessed; a late same-day chunk inside a published range forms a catch-up", async () => {
    const c = corr("conv-inter-2", "run-1");
    clock = new Date("2026-10-16T10:00:00Z");
    await ingestor.ingestChunk(NS, { sessionId: "ses-inter2", chunkSeq: 2, events: [ev("ses-inter2", 2)], correlation: c });
    clock = new Date("2026-10-17T10:00:00Z");
    await ingestor.ingestChunk(NS, { sessionId: "ses-inter2", chunkSeq: 1, events: [ev("ses-inter2", 1)], correlation: c });
    await ingestor.ingestChunk(NS, { sessionId: "ses-inter2", chunkSeq: 3, events: [ev("ses-inter2", 3)], correlation: c });
    const d17 = await pinDailyManifest(store, NS, "2026-10-17"); // Oct 16 never published
    expect(d17.manifest!.coverage![0]!.prior).toMatchObject({ chunkSeqs: [2], interleavedChunkSeqs: [2], processedChunks: 0, unprocessedChunkSeqs: [2] });
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: d17.manifest!.key, status: "building" });
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: d17.manifest!.key, status: "published", revisionId: "r17" });

    // Same receipt day, session with chunks 1 and 3 already published; chunk 2 arrives late that day.
    const c2 = corr("conv-late", "run-1");
    await ingestor.ingestChunk(NS, { sessionId: "ses-late", chunkSeq: 1, events: [ev("ses-late", 1)], correlation: c2 });
    await ingestor.ingestChunk(NS, { sessionId: "ses-late", chunkSeq: 3, events: [ev("ses-late", 3)], correlation: c2 });
    const first = await pinDailyManifest(store, NS, "2026-10-17");
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: first.manifest!.key, status: "building" });
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: first.manifest!.key, status: "published", revisionId: "r17b" });
    await ingestor.ingestChunk(NS, { sessionId: "ses-late", chunkSeq: 2, events: [ev("ses-late", 2)], correlation: c2 });
    const catchUp = await pinDailyManifest(store, NS, "2026-10-17");
    expect(catchUp.manifest!.chunks.map((x) => [x.sessionId, x.chunkSeq])).toEqual([["ses-late", 2]]);
    expect(catchUp.manifest!.coverage![0]).toMatchObject({ cohort: { chunkSeqs: [2] }, prior: { chunkSeqs: [1], processedChunks: 1 }, laterChunks: 1, startsSession: false });
  });

  it("a larger noncontiguous split (1,4 on day A; 2,3,5 on day B) builds a complete archive", async () => {
    const c = corr("conv-split", "run-1");
    const put = async (day: string, chunkSeq: number) => {
      clock = new Date(`${day}T10:00:00Z`);
      await ingestor.ingestChunk(NS, { sessionId: "ses-split", chunkSeq, events: [ev("ses-split", chunkSeq, chunkSeq === 5 ? { type: "session_end", outcome: { status: "succeeded", summary: "ok" } } : {})], ...(chunkSeq === 5 ? { final: true } : {}), correlation: c });
    };
    for (const [d, n] of [["2026-10-16", 1], ["2026-10-17", 2], ["2026-10-16", 4], ["2026-10-17", 3], ["2026-10-17", 5]] as const) await put(d, n);
    const archive = await buildTraceArchive(store, NS);
    expect(JSON.parse(archive.files.get("manifest.json")!).sessions["ses-split"]).toMatchObject({ days: ["2026-10-16", "2026-10-17"], events: 5, complete: true });
  });

  it("the same event seq stored on two days is still an integrity failure", async () => {
    // Two distinct chunks that both claim seq 2 (only reachable through corrupted/legacy storage): write directly.
    const put = async (day: string, chunkSeq: number, events: TraceEvent[]) => {
      const jsonl = encodeEventsJsonl(events);
      const key = chunkObjectKey(day, "ses-dupseq", chunkSeq);
      const gz = gzipSync(Buffer.from(jsonl, "utf8"));
      await store.put(NS, [
        { key: chunkIndexKey("ses-dupseq", chunkSeq), bytes: Buffer.from(canonicalJson({ sessionId: "ses-dupseq", chunkSeq, day, key, sha256: sha256(jsonl), events: events.length, firstSeq: events[0]!.seq, lastSeq: events.at(-1)!.seq, final: false, receivedAt: `${day}T10:00:00.000Z`, objectBytes: gz.length }), "utf8") },
        { key, bytes: gz },
      ]);
    };
    await put("2026-10-16", 1, [ev("ses-dupseq", 1), ev("ses-dupseq", 2)]);
    await put("2026-10-17", 2, [ev("ses-dupseq", 2, { data: "different" }), ev("ses-dupseq", 3)]);
    await expect(buildTraceArchive(store, NS)).rejects.toThrow(/event seq 2 in two receipt-day partitions/);
  });
});

describe("correlation integrity", () => {
  it("rejects correlation changes on later chunks and on duplicate resends; tenants are isolated", async () => {
    await ingestor.ingestChunk(NS, { sessionId: "ses-bound", chunkSeq: 1, events: [ev("ses-bound", 1)], correlation: corr("conv-a", "run-1") } satisfies TraceChunk);
    await expect(ingestor.ingestChunk(NS, { sessionId: "ses-bound", chunkSeq: 2, events: [ev("ses-bound", 2)], correlation: corr("conv-b", "run-1") })).rejects.toMatchObject({ status: 409, code: "correlation_mismatch" });
    await expect(ingestor.ingestChunk(NS, { sessionId: "ses-bound", chunkSeq: 2, events: [ev("ses-bound", 2)] })).rejects.toMatchObject({ code: "correlation_mismatch" });
    // identical events, retargeted correlation: never acked as a duplicate
    await expect(ingestor.ingestChunk(NS, { sessionId: "ses-bound", chunkSeq: 1, events: [ev("ses-bound", 1)], correlation: corr("conv-a", "run-2") })).rejects.toMatchObject({ code: "correlation_mismatch" });
    expect((await ingestor.ingestChunk(NS, { sessionId: "ses-bound", chunkSeq: 1, events: [ev("ses-bound", 1)], correlation: corr("conv-a", "run-1") })).status).toBe("duplicate");

    // Same ids in another tenant are a different, independent session and conversation.
    await ingestor.ingestChunk(NS2, { sessionId: "ses-bound", chunkSeq: 1, events: [ev("ses-bound", 1)], correlation: corr("conv-a", "run-x") });
    expect((await readSessionBinding(store, NS2, "ses-bound"))!.correlation!.runId).toBe("run-x");
    expect((await conversationMembers(store, NS, "conv-a")).map((m) => m.runId)).toEqual(["run-1"]);
    expect((await conversationMembers(store, NS2, "conv-a")).map((m) => m.runId)).toEqual(["run-x"]);
  });

  it("legacy data stored before bindings: an identical retry with a NEW correlation is rejected, a plain retry migrates to legacy", async () => {
    // Pre-binding fixture: chunk object + index record written directly (exactly what older servers stored).
    const events = [ev("ses-old", 1), ev("ses-old", 2)];
    const jsonl = encodeEventsJsonl(events);
    const key = chunkObjectKey("2026-10-16", "ses-old", 1);
    const gz = gzipSync(Buffer.from(jsonl, "utf8"));
    await store.put(NS, [
      { key: chunkIndexKey("ses-old", 1), bytes: Buffer.from(canonicalJson({ sessionId: "ses-old", chunkSeq: 1, day: "2026-10-16", key, sha256: sha256(jsonl), events: 2, firstSeq: 1, lastSeq: 2, final: false, receivedAt: "2026-10-16T10:00:00.000Z", objectBytes: gz.length }), "utf8") },
      { key, bytes: gz },
    ]);
    await expect(ingestor.ingestChunk(NS, { sessionId: "ses-old", chunkSeq: 1, events, correlation: corr("conv-hijack", "run-1") })).rejects.toMatchObject({ status: 409, code: "correlation_mismatch" });
    expect(await readSessionBinding(store, NS, "ses-old")).toBeNull();
    const dup = await ingestor.ingestChunk(NS, { sessionId: "ses-old", chunkSeq: 1, events });
    expect(dup).toMatchObject({ status: "duplicate", day: "2026-10-16", key });
    expect(await readSessionBinding(store, NS, "ses-old")).toMatchObject({ correlation: null, legacy: true, day: "2026-10-16" });
    await expect(ingestor.ingestChunk(NS, { sessionId: "ses-old", chunkSeq: 2, events: [ev("ses-old", 3)], correlation: corr("conv-hijack", "run-1") })).rejects.toMatchObject({ code: "correlation_mismatch" });
    expect((await ingestor.ingestChunk(NS, { sessionId: "ses-old", chunkSeq: 2, events: [ev("ses-old", 3)] })).status).toBe("created");
  });
});

describe("child sessions delivered before their parent", () => {
  const httpTransport = (ns: string, order: string[]) =>
    new HttpTraceTransport({
      baseUrl: "https://ingest.test",
      token: "test-token",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const req = new Request(url, init);
        const res = await handleTraceRequest(req, ns, ingestor);
        if (res.ok && req.url.endsWith("/v1/traces/chunks")) order.push(((await res.clone().json()) as { sessionId: string }).sessionId);
        return res;
      }) as typeof fetch,
    });

  it("SDK child(): the in-process parent is bound first; spans link child to parent", async () => {
    const order: string[] = [];
    const r = rec(httpTransport(NS, order));
    const parent = r.begin({ objective: "orchestrate", sessionId: "ses-parent", conversationId: "conv-tree" });
    parent.startTurn("turn-1");
    parent.toolCall("spawn_agent", { task: "research" }, "call-7", { spanId: "tool.call-7", parentSpanId: "turn-1.req-1" });
    const child = parent.child({ objective: "research", sessionId: "ses-child", parentSpanId: "tool.call-7" });
    child.note({ found: true });
    await child.finish({ status: "succeeded", summary: "ok" }); // flushes the parent first
    expect(order.slice(0, 2)).toEqual(["ses-parent", "ses-child"]);
    await parent.finish({ status: "succeeded", summary: "done" });
    const files = await materializeCohort(store, NS, (await pinDailyManifest(store, NS, "2026-10-17")).manifest!);
    expect(json(files, "sessions/ses-child/session.json")).toMatchObject({ correlation: { parentSessionId: "ses-parent", parentSpanId: "tool.call-7", runId: parent.correlation.runId }, parentLink: "verified" });
    const pe = files.get("sessions/ses-parent/events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l) as TraceEvent);
    expect(pe.find((e) => e.type === "tool_call")).toMatchObject({ turnId: "turn-1", spanId: "tool.call-7", parentSpanId: "turn-1.req-1" });
  });

  it("child first through the real HTTP handler: accepted, pending, then verified (good parent) or mismatch (bad parent)", async () => {
    const order: string[] = [];
    const t = httpTransport(NS, order);
    // Another process's child arrives before its parent: never lost.
    await t.sendChunk({ sessionId: "ses-kid-good", chunkSeq: 1, events: [ev("ses-kid-good", 1)], correlation: corr("conv-oo", "run-1", { parentSessionId: "ses-dad-good" }) });
    await t.sendChunk({ sessionId: "ses-kid-bad", chunkSeq: 1, events: [ev("ses-kid-bad", 1)], correlation: corr("conv-oo", "run-1", { parentSessionId: "ses-dad-bad" }) });
    let files = await materializeCohort(store, NS, (await pinDailyManifest(store, NS, "2026-10-17")).manifest!);
    expect(json(files, "sessions/ses-kid-good/session.json").parentLink).toBe("pending");
    // Parents arrive later: one consistent, one bound to another conversation.
    await t.sendChunk({ sessionId: "ses-dad-good", chunkSeq: 1, events: [ev("ses-dad-good", 1)], correlation: corr("conv-oo", "run-1") });
    await t.sendChunk({ sessionId: "ses-dad-bad", chunkSeq: 1, events: [ev("ses-dad-bad", 1)], correlation: corr("conv-elsewhere", "run-9") });
    files = await materializeCohort(store, NS, (await pinDailyManifest(store, NS, "2026-10-17")).manifest!);
    expect(json(files, "sessions/ses-kid-good/session.json").parentLink).toBe("verified");
    expect(json(files, "sessions/ses-kid-bad/session.json").parentLink).toBe("mismatch");
    const archive = await buildTraceArchive(store, NS);
    const kidBad = JSON.parse(archive.files.get("traces/2026-10-17/ses-kid-bad/session.json")!);
    expect(kidBad.archive.conversation.parentLink).toBe("mismatch");
    expect(JSON.parse(archive.files.get("traces/2026-10-17/ses-kid-good/session.json")!).archive.conversation.parentLink).toBe("verified");
    // Once the parent is bound, a child naming it from a different run is rejected outright.
    await expect(t.sendChunk({ sessionId: "ses-kid-late", chunkSeq: 1, events: [ev("ses-kid-late", 1)], correlation: corr("conv-oo", "run-2", { parentSessionId: "ses-dad-good" }) })).rejects.toMatchObject({ status: 409, retryable: false });
  });
});

describe("bounds fail closed", () => {
  it("a 150000-event session across two receipt days builds a complete archive (no argument-count ceiling)", async () => {
    const c = corr("conv-huge", "run-1");
    for (let k = 1; k <= 150; k++) {
      clock = new Date(k <= 75 ? "2026-10-16T10:00:00Z" : "2026-10-17T10:00:00Z");
      const events = Array.from({ length: 1000 }, (_, i) => ({ sessionId: "ses-huge", seq: (k - 1) * 1000 + i + 1, ts: "2026-10-16T10:00:00.000Z", type: "note" as const, agent: { id: "x" }, data: null }));
      await ingestor.ingestChunk(NS, { sessionId: "ses-huge", chunkSeq: k, events, correlation: c });
    }
    const archive = await buildTraceArchive(store, NS);
    const view = JSON.parse(archive.files.get("manifest.json")!).sessions["ses-huge"];
    expect(view).toMatchObject({ days: ["2026-10-16", "2026-10-17"], events: 150_000, firstSeq: 1, lastSeq: 150_000 });
    expect(view.paths).toEqual(["sources/traces/2026-10-16/ses-huge/", "sources/traces/2026-10-17/ses-huge/"]);
    const d17 = await pinDailyManifest(store, NS, "2026-10-17");
    expect(d17.manifest!.coverage![0]).toMatchObject({ cohort: { firstSeq: 75_001, lastSeq: 150_000 }, prior: { chunks: 75 } });
  }, 180_000);

  it("generated context is linear and charged to maxInputBytes: 30 sessions of one conversation fail a 10000-byte budget explicitly", async () => {
    for (let i = 0; i < 30; i++) {
      const sid = `ses-review-${String(i).padStart(3, "0")}`;
      await ingestor.ingestChunk(NS, { sessionId: sid, chunkSeq: 1, events: [ev(sid, 1, { data: null })], correlation: corr("same-conv", `run-${i}`) });
    }
    const pin = await pinDailyManifest(store, NS, "2026-10-17");
    await expect(materializeCohort(store, NS, pin.manifest!, { maxInputBytes: 10_000 })).rejects.toThrow(/input budget of 10000/);
    const files = await materializeCohort(store, NS, pin.manifest!);
    const sizes = [...files.entries()].filter(([k]) => k.endsWith("/session.json")).map(([, v]) => Buffer.byteLength(v));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64); // per-session metadata does not grow with the conversation
    const total = [...files.values()].reduce((n, v) => n + Buffer.byteLength(v), 0);
    const index = [...files.keys()].filter((k) => k.startsWith("conversations/"));
    expect(index).toHaveLength(1);
    expect(JSON.parse(files.get(index[0]!)!).sessions).toHaveLength(30); // every session discoverable through ONE index
    expect(total).toBeLessThan(120_000); // linear: was ~356 KB with per-session member lists
    expect(pin.manifest!.chunks).toHaveLength(30); // accounting unchanged: only new chunks are inputs
    const archive = await buildTraceArchive(store, NS);
    const one = JSON.parse(archive.files.get("traces/2026-10-17/ses-review-000/session.json")!);
    expect(one.archive.conversation).toMatchObject({ sessions: 30, runs: 30 });
    expect(one.archive.conversation.index).toMatch(/^sources\/conversations\//);
  });

  it("over maxConversationSessions or with an invalid limit, history is never silently truncated", async () => {
    for (const sid of ["ses-cap-1", "ses-cap-2", "ses-cap-3"]) await ingestor.ingestChunk(NS, { sessionId: sid, chunkSeq: 1, events: [ev(sid, 1)], correlation: corr("conv-cap", `run-${sid}`) });
    const pin = await pinDailyManifest(store, NS, "2026-10-17");
    await expect(materializeCohort(store, NS, pin.manifest!, { maxConversationSessions: 2 })).rejects.toBeInstanceOf(ConversationLimitError);
    for (const bad of [Number.NaN, Infinity, 0, -1, 1.5]) {
      await expect(materializeCohort(store, NS, pin.manifest!, { maxConversationSessions: bad })).rejects.toThrow(/positive integer/);
      await expect(pinDailyManifest(store, NS, "2026-10-17", { force: true, maxSessionChunks: bad })).rejects.toThrow(/positive integer/);
    }
    await expect(materializeCohort(store, NS, pin.manifest!, { maxConversationSessions: 3 })).resolves.toBeTruthy();
  });
});
