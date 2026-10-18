import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { canonicalJson, sha256 } from "../src/util.js";
import { InProcessTraceTransport, TraceRecorder } from "../src/sdk/index.js";
import {
  encodeEventsJsonl,
  handleTraceRequest,
  listUnprocessedDays,
  loadManifest,
  markDailyStatus,
  materializeCohort,
  pinDailyManifest,
  readSessionBinding,
  TraceIngestError,
  TraceIngestor,
  type TraceChunk,
  type TraceEvent,
} from "../src/traces/index.js";

let root: string;
let store: DirectoryObjectStore;
let clock: { now: Date };
let ingestor: TraceIngestor;
const NS = "tenant-a";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "traces-test-"));
  store = new DirectoryObjectStore(root);
  clock = { now: new Date("2026-10-17T10:00:00Z") };
  ingestor = new TraceIngestor(store, { now: () => clock.now });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ev(sessionId: string, seq: number, type: TraceEvent["type"] = "note", data: unknown = { i: seq }, extra: Partial<TraceEvent> = {}): TraceEvent {
  return { sessionId, seq, ts: new Date(Date.UTC(2026, 9, 17, 9, 0, seq)).toISOString(), type, agent: { id: "agent-a", model: "kimi" }, data, ...extra };
}
function chunk(sessionId: string, chunkSeq: number, seqs: number[], final = false): TraceChunk {
  return { sessionId, chunkSeq, events: seqs.map((s) => ev(sessionId, s)), ...(final ? { final } : {}) };
}
async function expectIngestError(p: Promise<unknown>, status: number, code?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TraceIngestError);
  expect((err as TraceIngestError).status).toBe(status);
  if (code) expect((err as TraceIngestError).code).toBe(code);
  return err as TraceIngestError;
}

describe("trace ingest", () => {
  it("round-trips full payloads including a >64 KiB blob into the materialized cohort", async () => {
    const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(ingestor, NS), agent: { id: "agent-a", name: "A", model: "fireworks/kimi", harness: "pi" }, flushIntervalMs: 0 });
    const s = recorder.begin({ objective: "Fix the flaky deploy", sessionId: "ses-roundtrip", metadata: { repo: "x" } });
    const big = "line of tool output with unicode é世\n".repeat(4000); // > 64 KiB
    const bigJson = { rows: Array.from({ length: 3000 }, (_, i) => ({ i, v: `value-${i}` })) };
    s.modelInput({ messages: [{ role: "user", content: "deploy it" }] });
    s.modelOutput({ text: "calling tool" }, { usage: { inputTokens: 10, outputTokens: 5 } });
    const callSeq = s.toolCall("bash", { cmd: "make deploy" }, "call-1");
    s.toolResult("bash", "call-1", big, false);
    s.toolResult("query", "call-2", bigJson);
    await s.finish({ status: "succeeded", summary: "deployed", evidence: { source: "client-reported", details: { exit: 0 } } });
    expect(recorder.errors).toEqual([]);

    const pin = await pinDailyManifest(store, NS, "2026-10-17", { now: () => clock.now });
    expect(pin.created).toBe(true);
    const files = await materializeCohort(store, NS, pin.manifest!);
    const lines = files.get("sessions/ses-roundtrip/events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(lines[callSeq - 1]!.data).toEqual({ name: "bash", callId: "call-1", arguments: { cmd: "make deploy" } });
    expect(lines[callSeq - 1]!.ref).toBe(`ses-roundtrip#${callSeq}`);
    // the whole tool_result data object was blobbed; the payload file holds its exact JSON
    const payloadRel = lines[4]!.data.$payload as string;
    expect(payloadRel).toMatch(/^payloads\/[0-9a-f]{64}\.json$/);
    expect(lines[4]!.data.mediaType).toBe("application/json");
    const restored = JSON.parse(files.get(`sessions/ses-roundtrip/${payloadRel}`)!);
    expect(restored).toEqual({ name: "bash", callId: "call-1", isError: false, result: big });
    expect(sha256(files.get(`sessions/ses-roundtrip/${payloadRel}`)!)).toBe(payloadRel.slice(9, 73));
    const jsonPayload = JSON.parse(files.get(`sessions/ses-roundtrip/${lines[5]!.data.$payload}`)!);
    expect(jsonPayload.result).toEqual(bigJson);
    const session = JSON.parse(files.get("sessions/ses-roundtrip/session.json")!);
    expect(session).toMatchObject({ objective: "Fix the flaky deploy", model: "fireworks/kimi", eventCount: 7, complete: true, outcome: { status: "succeeded", summary: "deployed" } });
    expect(session.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const manifest = JSON.parse(files.get("manifest.json")!);
    expect(manifest.counts).toEqual({ sessions: 1, chunks: 1, events: 7, payloadFiles: 2 });
  });

  it("inlines payloads <= 64 KiB and writes larger inline payloads to payload files", async () => {
    const huge = "x".repeat(70 * 1024);
    await ingestor.ingestChunk(NS, { sessionId: "ses-inline", chunkSeq: 1, events: [ev("ses-inline", 1, "note", "small"), ev("ses-inline", 2, "note", huge)] });
    const pin = await pinDailyManifest(store, NS, "2026-10-17");
    const files = await materializeCohort(store, NS, pin.manifest!.key);
    const lines = files.get("sessions/ses-inline/events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    expect(lines[0]!.data).toBe("small");
    expect(lines[1]!.data.$payload).toBe(`payloads/${sha256(huge)}.txt`);
    expect(files.get(`sessions/ses-inline/payloads/${sha256(huge)}.txt`)).toBe(huge);
  });

  it("is idempotent: identical resend is a duplicate (even on a later day), conflicting resend is 409", async () => {
    const c = chunk("ses-idem", 1, [1, 2, 3]);
    const first = await ingestor.ingestChunk(NS, c);
    expect(first).toMatchObject({ status: "created", day: "2026-10-17", key: "traces/2026-10-17/ses-idem/chunk-000001.jsonl.gz" });
    expect((await ingestor.ingestChunk(NS, structuredClone(c))).status).toBe("duplicate");
    clock.now = new Date("2026-10-18T01:00:00Z");
    const late = await ingestor.ingestChunk(NS, c);
    expect(late).toMatchObject({ status: "duplicate", day: "2026-10-17", key: first.key });
    expect(await ingestor.listDay(NS, "2026-10-18")).toEqual([]);
    const conflict = chunk("ses-idem", 1, [1, 2, 4]);
    await expectIngestError(ingestor.ingestChunk(NS, conflict), 409, "chunk_conflict");
    // key order differences are not a conflict (canonical digest)
    const reordered = { final: undefined, events: c.events.map((e) => JSON.parse(canonicalJson(e))), chunkSeq: 1, sessionId: "ses-idem" };
    expect((await ingestor.ingestChunk(NS, JSON.parse(JSON.stringify(reordered)))).status).toBe("duplicate");
  });

  it("repairs a claimed chunk whose object write was lost before the crash", async () => {
    const c = chunk("ses-crash", 1, [1, 2]);
    const jsonl = encodeEventsJsonl(c.events);
    const key = "traces/2026-10-16/ses-crash/chunk-000001.jsonl.gz";
    const record = { sessionId: "ses-crash", chunkSeq: 1, day: "2026-10-16", key, sha256: sha256(jsonl), events: 2, firstSeq: 1, lastSeq: 2, final: false, receivedAt: "2026-10-16T23:59:59.000Z" };
    await store.put(NS, [{ key: "trace-index/ses-crash/chunk-000001.json", bytes: Buffer.from(canonicalJson(record)) }]);
    expect(await ingestor.listDay(NS, "2026-10-16")).toEqual([]);
    const res = await ingestor.ingestChunk(NS, c);
    expect(res).toMatchObject({ status: "duplicate", day: "2026-10-16", key });
    expect(await ingestor.listDay(NS, "2026-10-16")).toEqual([key]);
    expect((await ingestor.readChunk(NS, key)).events).toEqual(c.events);
  });

  it("validates chunks with explicit errors and no silent stripping", async () => {
    await expectIngestError(ingestor.ingestChunk(NS, { ...chunk("ses-val", 1, [1]), extra: true }), 400, "invalid_chunk");
    await expectIngestError(ingestor.ingestChunk(NS, { sessionId: "ses-val", chunkSeq: 1, events: [{ ...ev("ses-val", 1), secret: 1 }] }), 400, "invalid_chunk");
    await expectIngestError(ingestor.ingestChunk(NS, chunk("ses-val", 1, [2, 1])), 400, "invalid_chunk");
    await expectIngestError(ingestor.ingestChunk(NS, chunk("SES-Upper", 1, [1])), 400);
    await expectIngestError(ingestor.ingestChunk(NS, { sessionId: "ses-val", chunkSeq: 1, events: [ev("ses-val", 1, "note", null, { outcome: { status: "failed", summary: "x" } })] }), 400);
    await expectIngestError(ingestor.ingestChunk(NS, chunk("ses-val", 1, Array.from({ length: 1001 }, (_, i) => i + 1))), 413, "chunk_too_many_events");
    await expectIngestError(ingestor.ingestChunk(NS, { sessionId: "ses-val", chunkSeq: 1, events: [ev("ses-val", 1, "note", "y".repeat(2 * 1024 * 1024))] }), 413, "chunk_too_large");
    await expectIngestError(ingestor.ingestChunk(NS, { sessionId: "ses-val", chunkSeq: 1, events: [ev("ses-val", 1, "note", { $blob: "a".repeat(64), bytes: 3, mediaType: "text/plain" })] }), 422, "blob_missing");
    await ingestor.ingestChunk(NS, chunk("ses-val", 1, [1, 2, 3]));
    await expectIngestError(ingestor.ingestChunk(NS, chunk("ses-val", 2, [3, 4])), 409, "seq_conflict");
    await expectIngestError(ingestor.putBlob(NS, "b".repeat(64), Buffer.from("nope")), 400, "blob_digest_mismatch");
  });

  it("isolates tenants", async () => {
    const bytes = Buffer.from("tenant a secret payload");
    const sha = sha256(bytes);
    await ingestor.putBlob(NS, sha, bytes);
    await ingestor.ingestChunk(NS, chunk("ses-shared", 1, [1, 2]));
    expect(await ingestor.listDay("tenant-b", "2026-10-17")).toEqual([]);
    expect(await listUnprocessedDays(store, "tenant-b", "2026-12-31")).toEqual([]);
    await expectIngestError(
      ingestor.ingestChunk("tenant-b", { sessionId: "ses-other", chunkSeq: 1, events: [ev("ses-other", 1, "note", { $blob: sha, bytes: bytes.length, mediaType: "text/plain" })] }),
      422,
      "blob_missing",
    );
    // same sessionId/chunkSeq in another tenant is independent (not a conflict)
    expect((await ingestor.ingestChunk("tenant-b", chunk("ses-shared", 1, [1, 2, 3]))).status).toBe("created");
    const pinB = await pinDailyManifest(store, "tenant-b", "2026-10-17");
    const filesB = await materializeCohort(store, "tenant-b", pinB.manifest!);
    expect(JSON.parse(filesB.get("sessions/ses-shared/session.json")!).eventCount).toBe(3);
    await expect(materializeCohort(store, "tenant-b", (await pinDailyManifest(store, NS, "2026-10-17")).manifest!)).rejects.toThrow(/does not match the sha256 pinned/);
  });
});

describe("HTTP handler", () => {
  const url = "https://memory.example.com/v1/traces";
  function post(body: Buffer, headers: Record<string, string> = {}) {
    return handleTraceRequest(new Request(`${url}/chunks`, { method: "POST", body: new Uint8Array(body), headers: { "content-type": "application/json", ...headers } }), NS, ingestor);
  }

  it("accepts gzip chunks and blobs with clear JSON errors", async () => {
    const payload = Buffer.from("x".repeat(100_000));
    const sha = sha256(payload);
    const blobRes = await handleTraceRequest(new Request(`${url}/blobs/${sha}`, { method: "PUT", body: new Uint8Array(gzipSync(payload)), headers: { "content-encoding": "gzip" } }), NS, ingestor);
    expect(blobRes.status).toBe(201);
    const c = { sessionId: "ses-http", chunkSeq: 1, events: [ev("ses-http", 1, "tool_result", { $blob: sha, bytes: payload.length, mediaType: "text/plain" })] };
    const gz = gzipSync(Buffer.from(JSON.stringify(c)));
    const res = await post(gz, { "content-encoding": "gzip" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "created", key: "traces/2026-10-17/ses-http/chunk-000001.jsonl.gz" });
    const again = await post(Buffer.from(JSON.stringify(c)));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("duplicate");

    const bad = await handleTraceRequest(new Request(`${url}/blobs/${"c".repeat(64)}`, { method: "PUT", body: new Uint8Array(payload) }), NS, ingestor);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("blob_digest_mismatch");

    const bomb = gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x20));
    const bombRes = await post(bomb, { "content-encoding": "gzip" });
    expect(bombRes.status).toBe(413);
    const plainTooBig = await post(Buffer.alloc(3 * 1024 * 1024, 0x20));
    expect(plainTooBig.status).toBe(413);
    expect((await post(Buffer.from("{nope"))).status).toBe(400);
    expect((await post(Buffer.from("{}"), { "content-encoding": "br" })).status).toBe(415);
    expect((await handleTraceRequest(new Request(`${url}/chunks`, { method: "GET" }), NS, ingestor)).status).toBe(405);
    expect((await handleTraceRequest(new Request(`${url}/other`, { method: "GET" }), NS, ingestor)).status).toBe(404);
    const conflict = await post(Buffer.from(JSON.stringify({ ...c, events: [ev("ses-http", 1)] })));
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { message: string } }).error.message).toMatch(/different content/);
  });
});

describe("daily manifests", () => {
  it("partitions by receipt day and pins catch-up manifests containing only new chunks", async () => {
    clock.now = new Date("2026-10-17T08:00:00Z");
    await ingestor.ingestChunk(NS, chunk("ses-aaa", 1, [1, 2]));
    await ingestor.ingestChunk(NS, chunk("ses-bbb", 1, [1]));
    clock.now = new Date("2026-10-18T00:30:00Z");
    await ingestor.ingestChunk(NS, chunk("ses-ccc", 1, [1]));
    expect(await ingestor.listDay(NS, "2026-10-17")).toHaveLength(2);
    expect(await ingestor.listDay(NS, "2026-10-18")).toEqual(["traces/2026-10-18/ses-ccc/chunk-000001.jsonl.gz"]);
    expect(await listUnprocessedDays(store, NS, "2026-10-17")).toEqual(["2026-10-17"]);

    const p1 = await pinDailyManifest(store, NS, "2026-10-17");
    expect(p1.manifest!.key).toBe("daily/2026-10-17/manifest-0001.json");
    expect(p1.manifest!.chunks.map((c) => c.key)).toHaveLength(2);
    expect(p1.manifest!.sessionIds).toEqual(["ses-aaa", "ses-bbb"]);
    // idempotent re-run before processing returns the same manifest
    expect(await pinDailyManifest(store, NS, "2026-10-17")).toMatchObject({ created: false, reason: "unchanged" });
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: p1.manifest!.key, status: "building", buildId: "b1" });
    expect((await pinDailyManifest(store, NS, "2026-10-17")).reason).toBe("build-in-progress");
    const done = await markDailyStatus(store, NS, "2026-10-17", { manifestKey: p1.manifest!.key, status: "published", revisionId: "rev-1" });
    expect(done).toMatchObject({ status: "published", attempts: 1, processedChunkKeys: 2, buildId: "b1", revisionId: "rev-1" });
    expect(await listUnprocessedDays(store, NS, "2026-10-18")).toEqual(["2026-10-18"]);
    expect(await pinDailyManifest(store, NS, "2026-10-17")).toMatchObject({ created: false, reason: "up-to-date" });

    // Late arrival: claimed on 10-17 (e.g. a crash-repaired chunk) after the day was published.
    clock.now = new Date("2026-10-17T23:59:59Z");
    await ingestor.ingestChunk(NS, chunk("ses-aaa", 2, [3, 4], true));
    expect(await listUnprocessedDays(store, NS, "2026-10-18")).toEqual(["2026-10-17", "2026-10-18"]);
    const p2 = await pinDailyManifest(store, NS, "2026-10-17");
    expect(p2.manifest).toMatchObject({ key: "daily/2026-10-17/manifest-0002.json", basePublishedManifests: [p1.manifest!.key] });
    expect(p2.manifest!.chunks.map((c) => c.key)).toEqual(["traces/2026-10-17/ses-aaa/chunk-000002.jsonl.gz"]);
    const files = await materializeCohort(store, NS, p2.manifest!);
    expect([...files.keys()].sort()).toEqual(["manifest.json", "sessions/ses-aaa/events.jsonl", "sessions/ses-aaa/session.json"]);
    expect(JSON.parse(files.get("manifest.json")!)).toMatchObject({ catchUp: true, counts: { events: 2 } });
    // manifest 1 is immutable and unchanged
    expect((await loadManifest(store, NS, p1.manifest!.key)).chunks).toHaveLength(2);
    await expect(markDailyStatus(store, NS, "2026-10-17", { manifestKey: p1.manifest!.key, status: "failed" })).rejects.toThrow(/superseded/);
  });

  it("supersedes failed or forced manifests with the union of unprocessed chunks", async () => {
    await ingestor.ingestChunk(NS, chunk("ses-f1", 1, [1]));
    const p1 = await pinDailyManifest(store, NS, "2026-10-17");
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: p1.manifest!.key, status: "building" });
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: p1.manifest!.key, status: "failed", error: "model timeout" });
    expect(await pinDailyManifest(store, NS, "2026-10-17")).toMatchObject({ created: false, reason: "unchanged" });
    await ingestor.ingestChunk(NS, chunk("ses-f2", 1, [1]));
    const p2 = await pinDailyManifest(store, NS, "2026-10-17");
    expect(p2.manifest).toMatchObject({ n: 2, supersedes: p1.manifest!.key, basePublishedManifests: [] });
    expect(p2.manifest!.chunks).toHaveLength(2);
    await markDailyStatus(store, NS, "2026-10-17", { manifestKey: p2.manifest!.key, status: "building" });
    const forced = await pinDailyManifest(store, NS, "2026-10-17", { force: true });
    expect(forced.manifest).toMatchObject({ n: 3, supersedes: p2.manifest!.key });
    expect(forced.manifest!.chunks).toHaveLength(2);
    expect(forced.ref).toMatchObject({ status: "pinned", attempts: 0 });
  });

  it("cold cache: a fresh ingestor/materializer over the same store sees everything", async () => {
    const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(ingestor, NS), agent: { id: "agent-a" }, flushIntervalMs: 0, maxBatchEvents: 2 });
    const s = recorder.begin({ objective: "cold", sessionId: "ses-cold" });
    for (let i = 0; i < 5; i++) s.note({ i, blob: i === 2 ? "z".repeat(100_000) : undefined });
    await s.finish({ status: "partial", summary: "half" });

    const coldStore = new DirectoryObjectStore(root);
    const cold = new TraceIngestor(coldStore, { now: () => new Date("2026-10-20T00:00:00Z") });
    expect(await cold.listDay(NS, "2026-10-17")).toHaveLength(4);
    const resend = await coldChunk(cold, "traces/2026-10-17/ses-cold/chunk-000001.jsonl.gz");
    // A replay that drops the session's bound correlation is a mutation, not a duplicate.
    await expect(cold.ingestChunk(NS, resend)).rejects.toMatchObject({ status: 409, code: "correlation_mismatch" });
    const binding = await readSessionBinding(coldStore, NS, "ses-cold");
    expect((await cold.ingestChunk(NS, { ...resend, correlation: binding!.correlation! })).status).toBe("duplicate");
    expect(await listUnprocessedDays(coldStore, NS, "2026-10-20")).toEqual(["2026-10-17"]);
    const pin = await pinDailyManifest(coldStore, NS, "2026-10-17");
    const files = await materializeCohort(coldStore, NS, pin.manifest!);
    const lines = files.get("sessions/ses-cold/events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l) as TraceEvent);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.parse(files.get("sessions/ses-cold/session.json")!)).toMatchObject({ complete: true, chunkSeqs: [1, 2, 3, 4], outcome: { status: "partial" } });
  });
});

async function coldChunk(ing: TraceIngestor, key: string): Promise<TraceChunk> {
  const { events } = await ing.readChunk(NS, key);
  return { sessionId: events[0]!.sessionId, chunkSeq: 1, events };
}

/** Enforces the hosted store's per-call transfer limits (~12 MiB) and records call shapes. */
class CallBudgetStore extends DirectoryObjectStore {
  static readonly LIMIT = 12 * 1024 * 1024;
  calls: { op: "get" | "put" | "list"; keys: number; bytes: number; limit?: number }[] = [];
  override async put(ns: string, objects: { key: string; bytes: Buffer }[]) {
    const bytes = objects.reduce((n, o) => n + o.bytes.length, 0);
    this.calls.push({ op: "put", keys: objects.length, bytes });
    if (bytes > CallBudgetStore.LIMIT) throw new Error(`put of ${bytes} bytes exceeds the per-call limit`);
    return super.put(ns, objects);
  }
  override async get(ns: string, keys: string[]) {
    const out = await super.get(ns, keys);
    const bytes = [...out.values()].reduce((n, b) => n + b.length, 0);
    this.calls.push({ op: "get", keys: keys.length, bytes });
    if (bytes > CallBudgetStore.LIMIT) throw new Error(`get of ${bytes} bytes exceeds the per-call limit`);
    return out;
  }
  override async list(ns: string, prefix: string, opts: { after?: string; limit?: number } = {}) {
    const out = await super.list(ns, prefix, opts);
    this.calls.push({ op: "list", keys: out.length, bytes: 0, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
    return out;
  }
}

describe("scale and limits", () => {
  it("round-trips a >12 MiB high-entropy payload SDK -> ingest -> materialize within per-call store limits", async () => {
    const budgetStore = new CallBudgetStore(root);
    const ing = new TraceIngestor(budgetStore, { now: () => clock.now });
    const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(ing, NS), agent: { id: "agent-a" }, flushIntervalMs: 0 });
    const s = recorder.begin({ objective: "big", sessionId: "ses-big" });
    const big = randomBytes(10 * 1024 * 1024).toString("base64"); // ~13.3 MiB, incompressible text
    expect(Buffer.byteLength(big)).toBeGreaterThan(12 * 1024 * 1024);
    s.toolResult("dump", "c1", "ok");
    s.note(big);
    await s.finish({ status: "succeeded", summary: "done" });
    expect(recorder.errors).toEqual([]);
    expect(await budgetStore.list(NS, `blob-manifests/${sha256(big)}`)).toHaveLength(1);

    const pin = await pinDailyManifest(budgetStore, NS, "2026-10-17");
    const files = await materializeCohort(budgetStore, NS, pin.manifest!);
    const lines = files.get("sessions/ses-big/events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    expect(lines[2]!.data).toMatchObject({ $payload: `payloads/${sha256(big)}.txt`, bytes: Buffer.byteLength(big) });
    const restored = files.get(`sessions/ses-big/payloads/${sha256(big)}.txt`)!;
    expect(restored.length).toBe(big.length);
    expect(restored === big).toBe(true);
    expect(budgetStore.calls.every((c) => c.bytes <= 8 * 1024 * 1024 + 1024)).toBe(true);
  });

  it("pins and materializes days larger than one list page / get batch, with explicit budget errors", async () => {
    const budgetStore = new CallBudgetStore(root);
    const ing = new TraceIngestor(budgetStore, { now: () => clock.now });
    for (let i = 0; i < 70; i++) await ing.ingestChunk(NS, { sessionId: `ses-many-${String(i).padStart(3, "0")}`, chunkSeq: 1, events: [ev(`ses-many-${String(i).padStart(3, "0")}`, 1, "note", { i })] });
    budgetStore.calls = [];
    const pin = await pinDailyManifest(budgetStore, NS, "2026-10-17", { listPageSize: 25 });
    expect(pin.manifest!.chunks).toHaveLength(70);
    expect(budgetStore.calls.filter((c) => c.op === "list").every((c) => c.limit !== undefined && c.limit <= 25)).toBe(true);
    expect(budgetStore.calls.filter((c) => c.op === "list" && c.keys === 25).length).toBeGreaterThanOrEqual(2);
    expect(budgetStore.calls.filter((c) => c.op === "get").every((c) => c.keys <= 64)).toBe(true);
    expect(budgetStore.calls.filter((c) => c.op === "get" && c.keys > 1).length).toBeGreaterThanOrEqual(2);

    budgetStore.calls = [];
    const files = await materializeCohort(budgetStore, NS, pin.manifest!, { maxGetKeys: 16 });
    expect(JSON.parse(files.get("manifest.json")!).counts).toMatchObject({ sessions: 70, chunks: 70, events: 70 });
    const gets = budgetStore.calls.filter((c) => c.op === "get" && c.keys > 1);
    // 70 chunks in batches of <= 16 keys (5 gets) + 70 session-binding records in batches of <= 16 (5 gets).
    expect(gets.length).toBe(10);
    expect(gets.every((c) => c.keys <= 16)).toBe(true);

    await expect(materializeCohort(budgetStore, NS, pin.manifest!, { maxInputBytes: 1000 })).rejects.toThrow(/input budget of 1000/);
    await ing.ingestChunk(NS, chunk("ses-late", 1, [1]));
    await expect(pinDailyManifest(budgetStore, NS, "2026-10-17", { maxInputBytes: 100 })).rejects.toThrow(/over the input budget of 100 bytes/);
  });

  it("rejects non-calendar days", async () => {
    await expect(ingestor.listDay(NS, "2026-02-30")).rejects.toThrow(/calendar/);
    await expect(pinDailyManifest(store, NS, "2026-13-01")).rejects.toThrow(/calendar/);
    await expect(listUnprocessedDays(store, NS, "2026-04-31")).rejects.toThrow(/calendar/);
    expect(await ingestor.listDay(NS, "2024-02-29")).toEqual([]);
  });
});
