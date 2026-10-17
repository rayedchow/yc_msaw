import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectoryObjectStore } from "../src/store/objects.js";
import {
  attachPiTraceCapture,
  HttpTraceTransport,
  InProcessTraceTransport,
  REDACTED,
  TRACE_BLOB_GZIP_CONTENT_TYPE,
  TRACE_CHUNK_GZIP_CONTENT_TYPE,
  TraceDeliveryError,
  TraceRecorder,
  TraceTransportError,
  type ChunkAck,
  type TraceChunk,
  type TraceTransport,
} from "../src/sdk/index.js";
import { handleTraceRequest, materializeCohort, pinDailyManifest, TraceIngestor, type TraceEvent } from "../src/traces/index.js";

const NS = "tenant-sdk";
let root: string;
let store: DirectoryObjectStore;
let ingestor: TraceIngestor;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sdk-test-"));
  store = new DirectoryObjectStore(root);
  ingestor = new TraceIngestor(store, { now: () => new Date("2026-10-17T12:00:00Z") });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function storedEvents(sessionId: string): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  for (const key of await ingestor.listDay(NS, "2026-10-17")) if (key.includes(`/${sessionId}/`)) out.push(...(await ingestor.readChunk(NS, key)).events);
  return out.sort((a, b) => a.seq - b.seq);
}

/** Wraps the in-process transport, injecting transient failures (some after the server already stored the chunk). */
class FlakyTransport implements TraceTransport {
  attempts: { chunkSeq: number; firstSeq: number; ok: boolean }[] = [];
  acks: ChunkAck[] = [];
  blobAttempts = 0;
  #n = 0;
  constructor(private readonly inner: TraceTransport) {}
  async putBlob(sha: string, bytes: Uint8Array, mediaType: string) {
    if (this.blobAttempts++ === 0) throw new TraceTransportError("502 bad gateway", 502, true);
    await this.inner.putBlob(sha, bytes, mediaType);
  }
  async sendChunk(chunk: TraceChunk): Promise<ChunkAck> {
    const n = this.#n++;
    const record = (ok: boolean) => this.attempts.push({ chunkSeq: chunk.chunkSeq, firstSeq: chunk.events[0]!.seq, ok });
    if (n % 3 === 0) {
      record(false);
      throw new TypeError("fetch failed: ECONNRESET");
    }
    if (n % 3 === 1) {
      await this.inner.sendChunk(chunk); // server stored it, but the response was lost
      record(false);
      throw new TraceTransportError("503 upstream timeout", 503, true);
    }
    const ack = await this.inner.sendChunk(chunk);
    record(true);
    this.acks.push(ack);
    return ack;
  }
}

describe("TraceRecorder", () => {
  it("retries flaky delivery with stable chunkSeq and loses nothing", async () => {
    const flaky = new FlakyTransport(new InProcessTraceTransport(ingestor, NS));
    const recorder = new TraceRecorder({ transport: flaky, agent: { id: "agent-x" }, flushIntervalMs: 0, maxBatchEvents: 4, retryBaseMs: 1, retryMaxMs: 2 });
    const s = recorder.begin({ objective: "flaky", sessionId: "ses-flaky" });
    for (let i = 0; i < 9; i++) s.note({ i });
    s.toolResult("read", "c1", "q".repeat(200_000));
    await s.finish({ status: "succeeded", summary: "ok" });
    expect(recorder.errors).toEqual([]);
    // each chunkSeq was retried with the same first event seq
    const byChunk = new Map<number, Set<number>>();
    for (const a of flaky.attempts) byChunk.set(a.chunkSeq, (byChunk.get(a.chunkSeq) ?? new Set()).add(a.firstSeq));
    for (const seqs of byChunk.values()) expect(seqs.size).toBe(1);
    expect([...byChunk.keys()]).toEqual([1, 2, 3]);
    expect(flaky.acks.every((a) => a.status === "duplicate")).toBe(true);
    const events = await storedEvents("ses-flaky");
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(events.at(-1)).toMatchObject({ type: "session_end", outcome: { status: "succeeded" } });
    const pin = await pinDailyManifest(store, NS, "2026-10-17");
    const files = await materializeCohort(store, NS, pin.manifest!);
    const lines = files.get("sessions/ses-flaky/events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l) as { data: { $payload?: string } });
    expect(JSON.parse(files.get(`sessions/ses-flaky/${lines[10]!.data.$payload}`)!).result).toBe("q".repeat(200_000));
  });

  it("keeps undelivered chunks after exhausting retries and resends them with the same chunkSeq", async () => {
    let down = true;
    const sent: number[] = [];
    const inner = new InProcessTraceTransport(ingestor, NS);
    const transport: TraceTransport = {
      putBlob: (sha, b, m) => inner.putBlob(sha, b, m),
      sendChunk: async (c) => {
        sent.push(c.chunkSeq);
        if (down) throw new TraceTransportError("429 slow down", 429, true);
        return inner.sendChunk(c);
      },
    };
    const recorder = new TraceRecorder({ transport, agent: { id: "a" }, flushIntervalMs: 0, maxRetries: 2, retryBaseMs: 1 });
    const s = recorder.begin({ objective: "outage", sessionId: "ses-outage" });
    s.note("one");
    const err = await s.flush().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TraceDeliveryError);
    expect((err as TraceDeliveryError).permanent).toBe(false);
    expect(s.undelivered).toEqual({ events: 2, chunks: 1 });
    expect(sent).toEqual([1, 1, 1]);
    down = false;
    s.note("two");
    await s.finish({ status: "succeeded", summary: "recovered" });
    expect(sent.slice(3)).toEqual([1, 2]);
    expect(s.undelivered).toEqual({ events: 0, chunks: 0 });
    expect((await storedEvents("ses-outage")).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("surfaces permanent 4xx rejections to the caller", async () => {
    const seen: TraceDeliveryError[] = [];
    const transport: TraceTransport = {
      putBlob: async () => undefined,
      sendChunk: async () => {
        throw new TraceTransportError("403 forbidden", 403, false, "forbidden");
      },
    };
    const recorder = new TraceRecorder({ transport, agent: { id: "a" }, flushIntervalMs: 0, retryBaseMs: 1, onError: (e) => seen.push(e) });
    const s = recorder.begin({ objective: "x", sessionId: "ses-denied" });
    await expect(s.finish({ status: "failed", summary: "x" })).rejects.toMatchObject({ name: "TraceDeliveryError", permanent: true, status: 403, chunkSeq: 1 });
    expect(recorder.errors).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(s.errors[0]!.message).toMatch(/Permanently rejected/);
  });

  it("sends everything by default; redaction is opt-in", async () => {
    const transport = new InProcessTraceTransport(ingestor, NS);
    const plain = new TraceRecorder({ transport, agent: { id: "a" }, flushIntervalMs: 0 });
    const s1 = plain.begin({ objective: "o", sessionId: "ses-plain" });
    s1.toolCall("http", { url: "https://x", headers: { Authorization: "Bearer abc" }, apiKey: "k-1" }, "c1");
    await s1.finish({ status: "succeeded", summary: "s" });
    expect((await storedEvents("ses-plain"))[1]!.data).toMatchObject({ arguments: { apiKey: "k-1", headers: { Authorization: "Bearer abc" } } });

    const redacting = new TraceRecorder({
      transport,
      agent: { id: "a" },
      flushIntervalMs: 0,
      redactKeys: ["apikey", "authorization"],
      redact: (e) => (e.type === "note" ? { ...e, data: String(e.data).replace(/\d{3}-\d{2}-\d{4}/g, "[SSN]") } : e),
    });
    const s2 = redacting.begin({ objective: "o", sessionId: "ses-redacted" });
    s2.toolCall("http", { url: "https://x", headers: { Authorization: "Bearer abc" }, apiKey: "k-1" }, "c1");
    s2.note("ssn 123-45-6789");
    await s2.finish({ status: "succeeded", summary: "s", evidence: { source: "client-reported", details: { apiKey: "k-2" } } });
    const events = await storedEvents("ses-redacted");
    expect(events[1]!.data).toEqual({ name: "http", callId: "c1", arguments: { url: "https://x", headers: { Authorization: REDACTED }, apiKey: REDACTED } });
    expect(events[2]!.data).toBe("ssn [SSN]");
    expect(events[3]!.outcome?.evidence?.details).toEqual({ apiKey: REDACTED });
    expect(JSON.stringify(events)).not.toContain("k-1");
  });

  it("bounds batches, marks the final chunk, and rejects oversize payloads explicitly", async () => {
    const chunks: TraceChunk[] = [];
    const inner = new InProcessTraceTransport(ingestor, NS);
    const transport: TraceTransport = { putBlob: (s, b, m) => inner.putBlob(s, b, m), sendChunk: (c) => (chunks.push(c), inner.sendChunk(c)) };
    const recorder = new TraceRecorder({ transport, agent: { id: "a" }, flushIntervalMs: 0, maxBatchEvents: 3, maxBatchBytes: 4096 });
    const s = recorder.begin({ objective: "batch", sessionId: "ses-batch" });
    for (let i = 0; i < 8; i++) s.note({ i, pad: "p".repeat(900) });
    expect(() => s.note("z".repeat(33 * 1024 * 1024))).toThrow(/limit is 33554432 bytes/);
    expect(() => s.record("note", null, { agent: { name: "n".repeat(5000) } })).toThrow();
    await s.finish({ status: "succeeded", summary: "done" });
    expect(chunks.every((c) => c.events.length <= 3 && Buffer.byteLength(JSON.stringify(c)) <= 4096 + 1024)).toBe(true);
    expect(chunks.map((c) => c.chunkSeq)).toEqual(chunks.map((_, i) => i + 1));
    expect(chunks.filter((c) => c.final).map((c) => c.chunkSeq)).toEqual([chunks.length]);
    expect(chunks.flatMap((c) => c.events.map((e) => e.seq))).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(() => s.note("after")).toThrow(/finished/);
  });

  it("HttpTraceTransport delivers gzip chunks and blobs through the HTTP handler behind an eager JSON body parser", async () => {
    const seen: { auth: string; contentType: string; encoding: string | null; mediaType: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input as string, init);
      const contentType = req.headers.get("content-type") ?? "";
      seen.push({ auth: req.headers.get("authorization") ?? "", contentType, encoding: req.headers.get("content-encoding"), mediaType: req.headers.get("x-procmem-media-type") });
      // mcp-use 2.10's global jsonBodyMiddleware: any body typed application/json is JSON-parsed before routing.
      if (contentType.includes("application/json")) {
        try {
          await req.clone().json();
        } catch {
          return new Response("Invalid JSON", { status: 400, headers: { "content-type": "text/plain" } });
        }
      }
      if (req.headers.get("authorization") !== "Bearer tok-1") return new Response(JSON.stringify({ error: { code: "unauthorized", message: "bad token" } }), { status: 401 });
      // mcp-use 2.10's node bridge (toWebRequest) decodes every request body as UTF-8 text.
      const text = new TextDecoder().decode(await req.arrayBuffer());
      return handleTraceRequest(new Request(req.url, { method: req.method, headers: req.headers, body: text }), NS, ingestor);
    };
    const transport = new HttpTraceTransport({ baseUrl: "https://memory.example.com/", token: async () => "tok-1", fetch: fetchImpl });
    const recorder = new TraceRecorder({ transport, agent: { id: "a", model: "m" }, flushIntervalMs: 0, maxRetries: 0 });
    const s = recorder.begin({ objective: "http", sessionId: "ses-http-sdk" });
    s.modelOutput({ text: "w".repeat(80_000) }, { usage: { inputTokens: 1, outputTokens: 2 } });
    const result = await s.finish({ status: "succeeded", summary: "ok" });
    expect(result).toMatchObject({ events: 3, chunks: 1, errors: [] });
    expect((await storedEvents("ses-http-sdk")).map((e) => e.type)).toEqual(["session_start", "model_output", "session_end"]);
    expect(seen.map((r) => r.contentType)).toEqual([`${TRACE_BLOB_GZIP_CONTENT_TYPE}; encoding=base64`, `${TRACE_CHUNK_GZIP_CONTENT_TYPE}; encoding=base64`]);
    expect(seen.every((r) => !r.contentType.includes("application/json") && r.encoding === null)).toBe(true);
    expect(seen[0]!.mediaType).toBe("application/json");

    const denied = new TraceRecorder({ transport: new HttpTraceTransport({ baseUrl: "https://memory.example.com", token: "wrong", fetch: fetchImpl }), agent: { id: "a" }, flushIntervalMs: 0 });
    await expect(denied.begin({ objective: "x", sessionId: "ses-denied-http" }).flush()).rejects.toMatchObject({ permanent: true, status: 401 });
  });

  it("handler accepts gzip vendor content types and plain JSON, with bounded decompression", async () => {
    const chunk = { sessionId: "ses-ctype", chunkSeq: 1, events: [{ sessionId: "ses-ctype", seq: 1, ts: "2026-10-17T12:00:00.000Z", type: "note", agent: { id: "a" }, data: "hi" }] };
    const post = (body: Uint8Array<ArrayBuffer>, headers: Record<string, string>) =>
      handleTraceRequest(new Request("https://h/v1/traces/chunks", { method: "POST", body, headers }), NS, ingestor);
    const gz = new Uint8Array(gzipSync(JSON.stringify(chunk)));
    expect((await post(gz, { "content-type": TRACE_CHUNK_GZIP_CONTENT_TYPE })).status).toBe(201);
    expect((await post(new TextEncoder().encode(JSON.stringify(chunk)), { "content-type": "application/json; charset=utf-8" })).status).toBe(200);
    expect((await post(gz, { "content-type": "application/json", "content-encoding": "gzip" })).status).toBe(200);
    const notGzip = await post(new TextEncoder().encode(JSON.stringify(chunk)), { "content-type": TRACE_CHUNK_GZIP_CONTENT_TYPE });
    expect(notGzip.status).toBe(400);
    expect(((await notGzip.json()) as { error: { code: string } }).error.code).toBe("invalid_gzip");
    const bomb = await post(new Uint8Array(gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x20))), { "content-type": TRACE_CHUNK_GZIP_CONTENT_TYPE });
    expect(bomb.status).toBe(413);
    expect((await post(gz, { "content-type": "text/plain" })).status).toBe(415);
    const b64 = (await post(new TextEncoder().encode(Buffer.from(gzipSync(JSON.stringify(chunk))).toString("base64")), { "content-type": `${TRACE_CHUNK_GZIP_CONTENT_TYPE}; encoding=base64` }));
    expect(b64.status).toBe(200);
    const badB64 = await post(new TextEncoder().encode("not*base64"), { "content-type": `${TRACE_CHUNK_GZIP_CONTENT_TYPE}; encoding=base64` });
    expect(((await badB64.json()) as { error: { code: string } }).error.code).toBe("invalid_base64");
    const binary = new HttpTraceTransport({ baseUrl: "https://h", token: "t", bodyEncoding: "binary", fetch: async (input, init) => handleTraceRequest(new Request(input as string, init), NS, ingestor) });
    expect((await binary.sendChunk({ ...chunk, chunkSeq: 2, events: [{ ...chunk.events[0]!, seq: 2 }] } as never)).status).toBe("created");
    const blob = Buffer.from("blob bytes");
    const sha = createHash("sha256").update(blob).digest("hex");
    const put = await handleTraceRequest(new Request(`https://h/v1/traces/blobs/${sha}`, { method: "PUT", body: new Uint8Array(gzipSync(blob)), headers: { "content-type": TRACE_BLOB_GZIP_CONTENT_TYPE } }), NS, ingestor);
    expect(put.status).toBe(201);
  });
});

describe("Pi adapter", () => {
  it("captures prompts, assistant messages, tool executions and errors", async () => {
    const listeners: ((e: AgentSessionEvent) => void)[] = [];
    const fakeSession = {
      subscribe(l: (e: AgentSessionEvent) => void) {
        listeners.push(l);
        return () => listeners.splice(listeners.indexOf(l), 1);
      },
    };
    const emit = (e: unknown) => listeners.forEach((l) => l(e as AgentSessionEvent));
    const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(ingestor, NS), agent: { id: "pi-agent", harness: "pi" }, flushIntervalMs: 0 });
    const ts = recorder.begin({ objective: "fix tests", sessionId: "ses-pi" });
    const off = attachPiTraceCapture(fakeSession, ts);
    const usage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({ type: "message_end", message: { role: "user", content: "fix the tests", timestamp: 1 } });
    emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta" } });
    const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "running" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }], api: "openai-completions", provider: "fireworks", model: "kimi-k2", usage, stopReason: "toolUse", timestamp: 2 };
    emit({ type: "message_end", message: assistant });
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
    emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "1 failed" }] }, isError: true, durationMs: 42 });
    emit({ type: "message_end", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "1 failed" }], isError: true, timestamp: 3 } });
    emit({ type: "message_end", message: { ...assistant, content: [], stopReason: "error", errorMessage: "rate limited" } });
    emit({ type: "agent_end", messages: [1, 2, 3], willRetry: false });
    off();
    emit({ type: "agent_start" });
    await ts.finish({ status: "failed", summary: "tests still failing" });

    const events = await storedEvents("ses-pi");
    expect(events.map((e) => e.type)).toEqual(["session_start", "note", "model_input", "model_output", "tool_call", "tool_result", "model_input", "model_output", "error", "note", "session_end"]);
    const out = events[3]!;
    expect(out.agent).toMatchObject({ id: "pi-agent", model: "fireworks/kimi-k2", harness: "pi" });
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 125, costUsd: 0.01 });
    expect((out.data as { message: unknown }).message).toEqual(assistant);
    expect(events[4]!.data).toEqual({ name: "bash", callId: "t1", arguments: { command: "npm test" } });
    expect(events[5]!.data).toMatchObject({ name: "bash", callId: "t1", isError: true, durationMs: 42 });
    expect(events[8]!.data).toMatchObject({ name: "ModelError", message: "rate limited" });
  });
});

describe("error events", () => {
  it("describes Errors, plain objects and primitives without [object Object]", async () => {
    const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(ingestor, NS), agent: { id: "a" }, flushIntervalMs: 0 });
    const s = recorder.begin({ objective: "errors", sessionId: "ses-errors" });
    s.error(new Error("boom", { cause: new TypeError("inner") }));
    s.error({ name: "ModelError", message: "rate limited" }, { turn: 2 });
    s.error({ code: 7, detail: { a: 1 } });
    s.error(42);
    await s.finish({ status: "failed", summary: "x" });
    const errs = (await storedEvents("ses-errors")).filter((e) => e.type === "error").map((e) => e.data as Record<string, any>);
    expect(errs[0]).toMatchObject({ name: "Error", message: "boom", cause: { name: "TypeError", message: "inner" } });
    expect(errs[1]).toEqual({ name: "ModelError", message: "rate limited", context: { turn: 2 } });
    expect(errs[2]).toEqual({ code: 7, detail: { a: 1 }, message: '{"code":7,"detail":{"a":1}}' });
    expect(errs[3]).toEqual({ message: "42", value: 42 });
    expect(JSON.stringify(errs)).not.toContain("[object Object]");
  });
});
