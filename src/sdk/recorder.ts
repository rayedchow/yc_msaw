import { createHash, randomBytes } from "node:crypto";
import {
  MAX_BLOB_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_EVENTS,
  SESSION_ID_RE,
  TraceEventSchema,
  type AgentInfo,
  type BlobRef,
  type OutcomeStatus,
  type TraceChunk,
  type TraceEvent,
  type TraceEventType,
  type TraceOutcome,
  type TraceUsage,
} from "../traces/schema.js";
import { TraceTransportError, type ChunkAck, type TraceTransport } from "./transport.js";

/**
 * Customer-side trace capture SDK.
 *
 * Data policy: by default the SDK sends EVERYTHING the caller records, in full
 * (payloads are JSON-serialized with standard JSON semantics: undefined/functions
 * are dropped, Dates become ISO strings, bigint becomes a decimal string).
 * Redaction is opt-in and runs in-process before anything leaves the machine:
 *  - `redactKeys`: object keys (case-insensitive, at any depth of `data` and
 *    `outcome.evidence.details`) whose values are replaced by "[REDACTED]".
 *  - `redact(event)`: arbitrary transform of each event, applied after redactKeys.
 * Large payloads (serialized `data` > blobThresholdBytes, default 64 KiB) are
 * uploaded as content-addressed blobs (sha256) before the chunk referencing them;
 * nothing is truncated. Payloads over 32 MiB, or single events that cannot fit
 * in a chunk, throw synchronously from record().
 *
 * Delivery: events are batched into chunks (bounded by maxBatchEvents /
 * maxBatchBytes) with a monotonically assigned chunkSeq. Transient failures
 * (network, 408, 429, 5xx) are retried with exponential backoff using the SAME
 * chunkSeq and content, so the server deduplicates. If retries are exhausted the
 * chunk stays queued and is retried on the next flush. Permanent 4xx failures
 * are surfaced as TraceDeliveryError (thrown from flush()/finish(), pushed to
 * `session.errors` / `recorder.errors`, and passed to onError).
 */

export const REDACTED = "[REDACTED]";

export interface TraceRecorderOptions {
  transport: TraceTransport;
  agent: AgentInfo;
  redact?: (event: TraceEvent) => TraceEvent;
  redactKeys?: string[];
  /** Max events per chunk (default 200, max 1000). */
  maxBatchEvents?: number;
  /** Max JSON bytes per chunk (default 1 MiB, max 2 MiB minus envelope). */
  maxBatchBytes?: number;
  /** Background flush interval; 0 disables the timer (default 2000ms). */
  flushIntervalMs?: number;
  /** Retries per request for transient failures (default 6). */
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Serialized payloads larger than this are sent as blobs (default 64 KiB). */
  blobThresholdBytes?: number;
  now?: () => Date;
  onError?: (error: TraceDeliveryError) => void;
}

export interface RecordExtra {
  usage?: TraceUsage;
  ts?: string | Date;
  /** Per-event agent overrides (e.g. the model actually used for this call). */
  agent?: Partial<AgentInfo>;
}

export interface BeginOptions {
  objective: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface FinishOptions {
  status: OutcomeStatus;
  summary: string;
  evidence?: { source: "client-reported"; details: unknown };
}

export interface FinishResult {
  sessionId: string;
  events: number;
  chunks: number;
  errors: TraceDeliveryError[];
}

export class TraceDeliveryError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly chunkSeq: number,
    readonly permanent: boolean,
    readonly status: number | null,
    readonly firstSeq: number,
    readonly lastSeq: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TraceDeliveryError";
  }
}

interface PendingEvent {
  event: TraceEvent;
  bytes: number;
  blob?: { sha256: string; bytes: Buffer; mediaType: string };
}

interface OutboundChunk {
  chunk: TraceChunk;
  blobs: NonNullable<PendingEvent["blob"]>[];
}

const CHUNK_ENVELOPE_BYTES = 16 * 1024;

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return text === undefined ? null : (JSON.parse(text) as unknown);
}

function redactDeep(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, keys));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = keys.has(k.toLowerCase()) ? REDACTED : redactDeep(v, keys);
    return out;
  }
  return value;
}

export function newSessionId(): string {
  return `ses-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

export class TraceRecorder {
  readonly errors: TraceDeliveryError[] = [];
  readonly opts: Required<Omit<TraceRecorderOptions, "redact" | "redactKeys" | "onError">> & Pick<TraceRecorderOptions, "redact" | "onError">;
  readonly redactKeys: Set<string>;

  constructor(options: TraceRecorderOptions) {
    const maxBatchEvents = options.maxBatchEvents ?? 200;
    const maxBatchBytes = options.maxBatchBytes ?? 1024 * 1024;
    if (!Number.isInteger(maxBatchEvents) || maxBatchEvents < 1 || maxBatchEvents > MAX_CHUNK_EVENTS) throw new Error(`maxBatchEvents must be 1..${MAX_CHUNK_EVENTS}`);
    if (maxBatchBytes < 1024 || maxBatchBytes > MAX_CHUNK_BYTES - CHUNK_ENVELOPE_BYTES) throw new Error(`maxBatchBytes must be 1024..${MAX_CHUNK_BYTES - CHUNK_ENVELOPE_BYTES}`);
    this.opts = {
      transport: options.transport,
      agent: { ...options.agent },
      maxBatchEvents,
      maxBatchBytes,
      flushIntervalMs: options.flushIntervalMs ?? 2000,
      maxRetries: options.maxRetries ?? 6,
      retryBaseMs: options.retryBaseMs ?? 250,
      retryMaxMs: options.retryMaxMs ?? 15_000,
      blobThresholdBytes: Math.min(options.blobThresholdBytes ?? 64 * 1024, maxBatchBytes / 2),
      now: options.now ?? (() => new Date()),
      redact: options.redact,
      onError: options.onError,
    };
    this.redactKeys = new Set((options.redactKeys ?? []).map((k) => k.toLowerCase()));
  }

  begin(options: BeginOptions): TraceSession {
    const sessionId = options.sessionId ?? newSessionId();
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`sessionId must match ${SESSION_ID_RE} (lowercase, 3-96 chars)`);
    const session = new TraceSession(this, sessionId);
    session.record("session_start", { objective: options.objective, ...(options.metadata ? { metadata: options.metadata } : {}) });
    return session;
  }

  /** @internal */
  reportError(error: TraceDeliveryError) {
    this.errors.push(error);
    try {
      this.opts.onError?.(error);
    } catch {
      // a throwing error callback must not break capture
    }
  }
}

export class TraceSession {
  readonly errors: TraceDeliveryError[] = [];
  #seq = 0;
  #chunkSeq = 0;
  #pending: PendingEvent[] = [];
  #pendingBytes = 0;
  #outbox: OutboundChunk[] = [];
  #uploadedBlobs = new Set<string>();
  #chain: Promise<void> = Promise.resolve();
  #finished = false;
  #finalQueued = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly recorder: TraceRecorder, readonly sessionId: string) {
    const interval = recorder.opts.flushIntervalMs;
    if (interval > 0) {
      this.#timer = setInterval(() => {
        if (this.#pending.length || this.#outbox.length) void this.flush().catch(() => undefined);
      }, interval);
      this.#timer.unref?.();
    }
  }

  get finished(): boolean {
    return this.#finished;
  }
  /** Number of events recorded so far (= last assigned seq). */
  get eventCount(): number {
    return this.#seq;
  }
  /** Chunks formed so far (= last assigned chunkSeq). */
  get chunkCount(): number {
    return this.#chunkSeq;
  }
  /** Events/chunks not yet acknowledged by the server. */
  get undelivered(): { events: number; chunks: number } {
    return { events: this.#pending.length + this.#outbox.reduce((n, c) => n + c.chunk.events.length, 0), chunks: this.#outbox.length };
  }

  /** Record one event; returns its seq (usable as evidence ref `<sessionId>#<seq>`). */
  record(type: TraceEventType, data: unknown, extra: RecordExtra = {}, outcome?: TraceOutcome): number {
    if (this.#finished) throw new Error(`Trace session ${this.sessionId} is finished; cannot record ${type}`);
    const o = this.recorder.opts;
    const ts = extra.ts === undefined ? o.now().toISOString() : typeof extra.ts === "string" ? extra.ts : extra.ts.toISOString();
    let event: TraceEvent = {
      sessionId: this.sessionId,
      seq: this.#seq + 1,
      ts,
      type,
      agent: { ...o.agent, ...stripUndefined(extra.agent ?? {}) },
      data: jsonSafe(data),
      ...(extra.usage ? { usage: stripUndefined(extra.usage) } : {}),
      ...(outcome ? { outcome: jsonSafe(outcome) as TraceOutcome } : {}),
    };
    if (this.recorder.redactKeys.size) {
      event = { ...event, data: redactDeep(event.data, this.recorder.redactKeys) };
      if (event.outcome?.evidence) event.outcome = { ...event.outcome, evidence: { ...event.outcome.evidence, details: redactDeep(event.outcome.evidence.details, this.recorder.redactKeys) } };
    }
    if (o.redact) {
      const r = o.redact(event);
      event = { ...r, sessionId: this.sessionId, seq: this.#seq + 1, data: jsonSafe(r.data) };
    }

    let blob: PendingEvent["blob"];
    const isString = typeof event.data === "string";
    const serialized = isString ? (event.data as string) : JSON.stringify(event.data ?? null);
    const dataBytes = Buffer.byteLength(serialized);
    if (dataBytes > o.blobThresholdBytes) {
      if (dataBytes > MAX_BLOB_BYTES) throw new Error(`Trace payload for ${type} is ${dataBytes} bytes; the per-payload limit is ${MAX_BLOB_BYTES} bytes (no truncation is performed)`);
      const bytes = Buffer.from(serialized, "utf8");
      const sha = createHash("sha256").update(bytes).digest("hex");
      const mediaType = isString ? "text/plain; charset=utf-8" : "application/json";
      blob = { sha256: sha, bytes, mediaType };
      const ref: BlobRef = { $blob: sha, bytes: bytes.length, mediaType };
      event = { ...event, data: ref };
    }
    const parsed = TraceEventSchema.safeParse(event);
    if (!parsed.success) throw new Error(`Invalid trace event: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > o.maxBatchBytes) throw new Error(`Trace event ${type} is ${size} bytes outside its payload, over the chunk limit ${o.maxBatchBytes} (no truncation is performed)`);

    this.#seq += 1;
    this.#pending.push({ event, bytes: size, ...(blob ? { blob } : {}) });
    this.#pendingBytes += size;
    if (this.#pending.length >= o.maxBatchEvents || this.#pendingBytes >= o.maxBatchBytes) void this.flush().catch(() => undefined);
    return event.seq;
  }

  modelInput(data: unknown, extra?: RecordExtra): number {
    return this.record("model_input", data, extra);
  }
  modelOutput(data: unknown, extra?: RecordExtra): number {
    return this.record("model_output", data, extra);
  }
  toolCall(name: string, args: unknown, callId: string, extra?: RecordExtra): number {
    return this.record("tool_call", { name, callId, arguments: args }, extra);
  }
  toolResult(name: string, callId: string, result: unknown, isError = false, extra?: RecordExtra): number {
    return this.record("tool_result", { name, callId, isError, result }, extra);
  }
  error(error: unknown, context?: unknown, extra?: RecordExtra): number {
    return this.record("error", { ...describeError(error), ...(context === undefined ? {} : { context }) }, extra);
  }
  note(data: unknown, extra?: RecordExtra): number {
    return this.record("note", data, extra);
  }

  /** Record session_end with the client-reported outcome, then deliver everything (final chunk). */
  async finish(outcome: FinishOptions, extra?: RecordExtra): Promise<FinishResult> {
    this.record("session_end", null, extra, { status: outcome.status, summary: outcome.summary, ...(outcome.evidence ? { evidence: outcome.evidence } : {}) });
    this.#finished = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.flush();
    return { sessionId: this.sessionId, events: this.#seq, chunks: this.#chunkSeq, errors: [...this.errors] };
  }

  /** Deliver all recorded events. Rejects with TraceDeliveryError if a chunk could not be delivered. */
  flush(): Promise<void> {
    const run = async () => {
      this.#formChunks();
      while (this.#outbox.length) {
        const out = this.#outbox[0]!;
        try {
          await this.#deliver(out);
          this.#outbox.shift();
        } catch (cause) {
          const permanent = cause instanceof TraceTransportError ? !cause.retryable : false;
          const status = cause instanceof TraceTransportError ? cause.status : null;
          const events = out.chunk.events;
          const err = new TraceDeliveryError(
            `${permanent ? "Permanently rejected" : "Could not deliver (will retry on next flush)"} trace chunk ${out.chunk.chunkSeq} of ${this.sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`,
            this.sessionId,
            out.chunk.chunkSeq,
            permanent,
            status,
            events[0]!.seq,
            events[events.length - 1]!.seq,
            cause,
          );
          if (permanent) this.#outbox.shift();
          this.errors.push(err);
          this.recorder.reportError(err);
          throw err;
        }
      }
    };
    const p = this.#chain.then(run, run);
    this.#chain = p.catch(() => undefined);
    return p;
  }

  #formChunks() {
    const o = this.recorder.opts;
    while (this.#pending.length) {
      const events: TraceEvent[] = [];
      const blobs: OutboundChunk["blobs"] = [];
      let bytes = 0;
      while (this.#pending.length && events.length < o.maxBatchEvents) {
        const next = this.#pending[0]!;
        if (events.length && bytes + next.bytes > o.maxBatchBytes) break;
        this.#pending.shift();
        this.#pendingBytes -= next.bytes;
        events.push(next.event);
        if (next.blob) blobs.push(next.blob);
        bytes += next.bytes;
      }
      this.#chunkSeq += 1;
      const isFinal = this.#finished && !this.#pending.length && !this.#finalQueued;
      if (isFinal) this.#finalQueued = true;
      this.#outbox.push({ chunk: { sessionId: this.sessionId, chunkSeq: this.#chunkSeq, events, ...(isFinal ? { final: true } : {}) }, blobs });
    }
  }

  async #deliver(out: OutboundChunk): Promise<ChunkAck> {
    const t = this.recorder.opts.transport;
    for (const b of out.blobs) {
      if (this.#uploadedBlobs.has(b.sha256)) continue;
      await this.#retry(() => t.putBlob(b.sha256, b.bytes, b.mediaType));
      this.#uploadedBlobs.add(b.sha256);
    }
    return this.#retry(() => t.sendChunk(out.chunk));
  }

  async #retry<T>(fn: () => Promise<T>): Promise<T> {
    const o = this.recorder.opts;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const retryable = error instanceof TraceTransportError ? error.retryable : true;
        if (!retryable || attempt >= o.maxRetries) throw error;
        const delay = Math.min(o.retryMaxMs, o.retryBaseMs * 2 ** attempt) * (0.5 + Math.random() / 2);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.cause !== undefined ? { cause: error.cause instanceof Error ? describeError(error.cause) : jsonSafe(error.cause) } : {}),
    };
  }
  if (typeof error === "string") return { message: error };
  const value = jsonSafe(error);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // Plain objects keep their own fields verbatim; never "[object Object]".
    const obj = value as Record<string, unknown>;
    return typeof obj.message === "string" ? obj : { ...obj, message: JSON.stringify(obj) };
  }
  return { message: Array.isArray(value) ? JSON.stringify(value) : String(error), value };
}
