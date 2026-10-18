import { createHash, randomBytes } from "node:crypto";
import {
  ConversationIdSchema,
  CorrelationSchema,
  MAX_BLOB_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_EVENTS,
  SESSION_ID_RE,
  TraceChunkSchema,
  TraceEventSchema,
  TraceIdSchema,
  type AgentInfo,
  type TraceCorrelation,
  type BlobRef,
  type OutcomeStatus,
  type TraceChunk,
  type TraceEvent,
  type TraceEventType,
  type TraceOutcome,
  type TraceUsage,
} from "../traces/schema.js";
import { TraceTransportError, type ChunkAck, type TraceTransport } from "./transport.js";
import { blobObjectKeyFor, chunkObjectKeyFor, OUTBOX_FORMAT, parseCheckpoint, TraceOutboxError, type OutboxCheckpoint, type TraceOutboxStore } from "./outbox.js";

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
 *
 * Correlation (first-class, on every chunk): conversationId (stable logical conversation: host thread id, native
 * harness session id, or generated), runId (one execution attempt; retries are new runs of the same conversation),
 * child sessions (parentSessionId/parentSpanId), and per-event turnId/spanId/parentSpanId. Calendar days never
 * delimit conversations.
 *
 * Durability (opt-in `outbox`): record() is synchronous and IN MEMORY. Events become crash-safe only once a flush()
 * or checkpoint() has persisted them to the outbox (the background timer flushes every flushIntervalMs). Await
 * `session.checkpoint()` at harness boundaries (end of a user turn, before a risky step) to make everything recorded
 * so far durable without waiting for delivery. After a restart, `recorder.resume(sessionId)` continues the session:
 * unacked chunks are resent with the same chunkSeq/bytes (server-deduplicated) and seq/chunkSeq are never reused.
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
  /** Opt-in durable outbox (e.g. new FileTraceOutbox(dir)); see TraceOutboxStore. */
  outbox?: TraceOutboxStore;
}

export interface RecordExtra {
  usage?: TraceUsage;
  ts?: string | Date;
  /** Per-event agent overrides (e.g. the model actually used for this call). */
  agent?: Partial<AgentInfo>;
  /** User turn (defaults to the session's current turn from startTurn()). Pass null to record outside any turn. */
  turnId?: string | null;
  /** Span this event belongs to (model request, tool call, nested agent) and its parent span. */
  spanId?: string;
  parentSpanId?: string;
}

export interface BeginOptions {
  objective: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /** Stable logical conversation (host thread id, native harness session id). Default: a generated id. */
  conversationId?: string;
  /** How conversationId was obtained (default "explicit" when given, "generated" otherwise). */
  conversationSource?: "explicit" | "harness";
  /** This execution attempt (default: generated). Use a NEW runId for a retry; link it with previousRunId. */
  runId?: string;
  previousRunId?: string;
}

export interface ChildOptions {
  objective: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /** Span of the parent session that spawned the child (e.g. the tool call that started a sub-agent). */
  parentSpanId?: string;
  /** Agent overrides for the child session's events. */
  agent?: Partial<AgentInfo>;
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
  /** Outbox entry once persisted (durable sessions). */
  entry?: OutboxCheckpoint["pending"][number];
}

interface SessionInit {
  parent: TraceSession | null;
  agent: AgentInfo;
  resumed?: { checkpoint: OutboxCheckpoint; chunks: OutboundChunk[] };
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

/** Fresh id with a time prefix and 48 random bits (never reused across restarts). */
export function newTraceId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function checkId(value: string, what: string): string {
  const r = TraceIdSchema.safeParse(value);
  if (!r.success) throw new Error(`${what} ${JSON.stringify(value)} is invalid: ${r.error.issues[0]?.message ?? "invalid"}`);
  return value;
}

export class TraceRecorder {
  readonly errors: TraceDeliveryError[] = [];
  readonly opts: Required<Omit<TraceRecorderOptions, "redact" | "redactKeys" | "onError" | "outbox">> & Pick<TraceRecorderOptions, "redact" | "onError" | "outbox">;
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
      outbox: options.outbox,
    };
    this.redactKeys = new Set((options.redactKeys ?? []).map((k) => k.toLowerCase()));
  }

  begin(options: BeginOptions): TraceSession {
    const sessionId = options.sessionId ?? newSessionId();
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`sessionId must match ${SESSION_ID_RE} (lowercase, 3-96 chars)`);
    if (options.conversationId !== undefined) {
      const r = ConversationIdSchema.safeParse(options.conversationId);
      if (!r.success) throw new Error(`conversationId ${JSON.stringify(options.conversationId)} is invalid: ${r.error.issues[0]?.message ?? "invalid"}`);
    }
    const correlation: TraceCorrelation = {
      conversationId: options.conversationId ?? newTraceId("cv"),
      runId: checkId(options.runId ?? newTraceId("run"), "runId"),
      conversationSource: options.conversationId === undefined ? "generated" : (options.conversationSource ?? "explicit"),
      ...(options.previousRunId ? { previousRunId: checkId(options.previousRunId, "previousRunId") } : {}),
    };
    return this.#start(sessionId, correlation, options.objective, options.metadata, null);
  }

  /** @internal */
  startChild(parent: TraceSession, options: ChildOptions): TraceSession {
    const sessionId = options.sessionId ?? newSessionId();
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`sessionId must match ${SESSION_ID_RE} (lowercase, 3-96 chars)`);
    if (sessionId === parent.sessionId) throw new Error("a child session needs its own sessionId");
    const correlation: TraceCorrelation = {
      conversationId: parent.correlation.conversationId,
      runId: parent.correlation.runId,
      conversationSource: parent.correlation.conversationSource,
      parentSessionId: parent.sessionId,
      ...(options.parentSpanId ? { parentSpanId: checkId(options.parentSpanId, "parentSpanId") } : {}),
    };
    return this.#start(sessionId, correlation, options.objective, options.metadata, parent, options.agent);
  }

  #start(sessionId: string, correlation: TraceCorrelation, objective: string, metadata: Record<string, unknown> | undefined, parent: TraceSession | null, agent?: Partial<AgentInfo>): TraceSession {
    const parsed = CorrelationSchema.safeParse(correlation);
    if (!parsed.success) throw new Error(`Invalid correlation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const session = new TraceSession(this, sessionId, parsed.data, { parent, agent: agent ? { ...this.opts.agent, ...stripUndefined(agent) } : { ...this.opts.agent } });
    session.record("session_start", { objective, ...(metadata ? { metadata } : {}) });
    return session;
  }

  /** Sessions with a checkpoint in the outbox that still have undelivered chunks or were never finished. */
  async pendingSessions(): Promise<string[]> {
    const outbox = this.#requireOutbox();
    const out: string[] = [];
    for (const sid of await outbox.listSessions()) {
      const raw = await outbox.readCheckpoint(sid);
      if (raw === null) continue;
      const c = parseCheckpoint(raw, sid);
      if (!c.finalAcked) out.push(sid);
    }
    return out;
  }

  /**
   * Continue a session from the durable outbox after a restart. Verifies the checkpoint and every pending chunk/blob
   * against its digest, takes ownership (a stale writer of the same session then fails closed), and returns a session
   * that resends unacked chunks on flush() and keeps assigning seq/chunkSeq after the last persisted values.
   * A session whose finish() was fully delivered is returned finished (nothing to send, nothing more to record).
   */
  async resume(sessionId: string): Promise<TraceSession> {
    const outbox = this.#requireOutbox();
    const raw = await outbox.readCheckpoint(sessionId);
    if (raw === null) throw new TraceOutboxError("not_found", `No outbox checkpoint for session ${sessionId}`);
    const cp = parseCheckpoint(raw, sessionId);
    const chunks: OutboundChunk[] = [];
    for (const entry of cp.pending) {
      const body = await outbox.getObject(chunkObjectKeyFor(sessionId, entry.chunkSeq, entry.sha256));
      if (!body) throw new TraceOutboxError("corrupt", `Outbox is missing the body of chunk ${entry.chunkSeq} of ${sessionId}`);
      if (createHash("sha256").update(body).digest("hex") !== entry.sha256) throw new TraceOutboxError("corrupt", `Chunk ${entry.chunkSeq} of ${sessionId} does not match its checkpoint digest`);
      const parsed = TraceChunkSchema.safeParse(JSON.parse(Buffer.from(body).toString("utf8")));
      if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.chunkSeq !== entry.chunkSeq || JSON.stringify(parsed.data.correlation) !== JSON.stringify(cp.correlation)) {
        throw new TraceOutboxError("corrupt", `Chunk ${entry.chunkSeq} of ${sessionId} in the outbox is invalid or does not match the session`);
      }
      const blobs: OutboundChunk["blobs"] = [];
      for (const b of entry.blobs) {
        const bytes = await outbox.getObject(blobObjectKeyFor(sessionId, b.sha256));
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== b.sha256) throw new TraceOutboxError("corrupt", `Blob ${b.sha256} of ${sessionId} is missing or corrupt in the outbox`);
        blobs.push({ sha256: b.sha256, bytes: Buffer.from(bytes), mediaType: b.mediaType });
      }
      chunks.push({ chunk: parsed.data, blobs, entry });
    }
    const next: OutboxCheckpoint = { ...cp, revision: cp.revision + 1, updatedAt: this.opts.now().toISOString() };
    if (!(await outbox.casCheckpoint(sessionId, cp.revision, JSON.stringify(next), next.revision))) {
      throw new TraceOutboxError("ownership_lost", `Session ${sessionId} was changed by another writer while resuming; retry resume()`);
    }
    return new TraceSession(this, sessionId, cp.correlation, { parent: null, agent: cp.agent, resumed: { checkpoint: next, chunks } });
  }

  #requireOutbox(): TraceOutboxStore {
    if (!this.opts.outbox) throw new Error("This TraceRecorder has no outbox; pass { outbox } to use durable sessions");
    return this.opts.outbox;
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
  readonly correlation: TraceCorrelation;
  #seq = 0;
  #chunkSeq = 0;
  #pending: PendingEvent[] = [];
  #pendingBytes = 0;
  #outbox: OutboundChunk[] = [];
  #uploadedBlobs = new Set<string>();
  #chain: Promise<void> = Promise.resolve();
  #finished = false;
  #finalQueued = false;
  #finalAcked = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #turnId: string | null = null;
  readonly #agent: AgentInfo;
  readonly #parent: TraceSession | null;
  /** Durable state (when the recorder has an outbox). */
  #checkpoint: OutboxCheckpoint | null = null;
  #created = false;
  #fenced: TraceOutboxError | null = null;
  #rejected: OutboxCheckpoint["rejected"] = [];
  /** Resolves once the server accepted this session's first chunk (children wait for it). */
  #bound = false;

  constructor(private readonly recorder: TraceRecorder, readonly sessionId: string, correlation: TraceCorrelation, init: SessionInit) {
    this.correlation = correlation;
    this.#agent = init.agent;
    this.#parent = init.parent;
    if (init.resumed) {
      const cp = init.resumed.checkpoint;
      this.#checkpoint = cp;
      this.#created = true;
      this.#seq = cp.seq;
      this.#chunkSeq = cp.chunkSeq;
      this.#finished = cp.finished;
      this.#finalQueued = cp.finalQueued;
      this.#finalAcked = cp.finalAcked;
      this.#rejected = [...cp.rejected];
      this.#outbox = init.resumed.chunks;
      this.#bound = cp.chunkSeq > cp.pending.length; // some chunk was acked before
    }
    const interval = recorder.opts.flushIntervalMs;
    if (interval > 0 && !this.#finalAcked) {
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
  /** Current user turn (from startTurn), or null. */
  get turnId(): string | null {
    return this.#turnId;
  }
  /** True once finish() was delivered in full (durable sessions: persisted as a tombstone). */
  get delivered(): boolean {
    return this.#finalAcked;
  }

  /** Begin a user turn; subsequent events carry this turnId until endTurn()/the next startTurn(). Returns the id. */
  startTurn(turnId?: string): string {
    this.#turnId = checkId(turnId ?? newTraceId("turn"), "turnId");
    return this.#turnId;
  }
  endTurn(): void {
    this.#turnId = null;
  }

  /**
   * Child agent session in the same conversation and run (parentSessionId = this session). Before the child's first
   * chunk is sent, this session is flushed so its correlation is bound first; if that is impossible (e.g. offline),
   * the child is still delivered and its parent link is validated once the parent arrives.
   */
  child(options: ChildOptions): TraceSession {
    return this.recorder.startChild(this, options);
  }

  /** Record one event; returns its seq (usable as evidence ref `<sessionId>#<seq>`). */
  record(type: TraceEventType, data: unknown, extra: RecordExtra = {}, outcome?: TraceOutcome): number {
    if (this.#finished) throw new Error(`Trace session ${this.sessionId} is finished; cannot record ${type}`);
    if (this.#fenced) throw this.#fenced;
    const o = this.recorder.opts;
    const ts = extra.ts === undefined ? o.now().toISOString() : typeof extra.ts === "string" ? extra.ts : extra.ts.toISOString();
    const turnId = extra.turnId === undefined ? this.#turnId : extra.turnId;
    let event: TraceEvent = {
      sessionId: this.sessionId,
      seq: this.#seq + 1,
      ts,
      type,
      agent: { ...this.#agent, ...stripUndefined(extra.agent ?? {}) },
      data: jsonSafe(data),
      ...(extra.usage ? { usage: stripUndefined(extra.usage) } : {}),
      ...(outcome ? { outcome: jsonSafe(outcome) as TraceOutcome } : {}),
      ...(turnId ? { turnId } : {}),
      ...(extra.spanId ? { spanId: extra.spanId } : {}),
      ...(extra.parentSpanId ? { parentSpanId: extra.parentSpanId } : {}),
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

  /**
   * Durable sessions: form chunks from everything recorded so far and persist them to the outbox WITHOUT sending.
   * After it resolves, those events survive a crash (resume() resends them). Without an outbox it only forms chunks.
   */
  checkpoint(): Promise<void> {
    const run = async () => {
      this.#formChunks();
      await this.#persistFormed();
    };
    const p = this.#chain.then(run, run);
    this.#chain = p.catch(() => undefined);
    return p;
  }

  /** Deliver all recorded events. Rejects with TraceDeliveryError if a chunk could not be delivered. */
  flush(): Promise<void> {
    const run = async () => {
      if (this.#fenced) throw this.#fenced;
      this.#formChunks();
      await this.#persistFormed();
      if (this.#parent && !this.#bound && this.#outbox.length) {
        // Bind the parent first (best effort): its correlation must reach the server before a child's when possible.
        await this.#parent.flush().catch(() => undefined);
      }
      while (this.#outbox.length) {
        const out = this.#outbox[0]!;
        try {
          await this.#deliver(out);
          this.#outbox.shift();
          this.#bound = true;
          if (out.chunk.final) this.#finalAcked = true;
          await this.#persistAck(out);
        } catch (cause) {
          if (cause instanceof TraceOutboxError) throw cause;
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
          if (permanent) {
            this.#outbox.shift();
            this.#rejected.push({ chunkSeq: out.chunk.chunkSeq, status, message: err.message.slice(0, 2000) });
            await this.#persistAck(out);
          }
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
      this.#outbox.push({ chunk: { sessionId: this.sessionId, chunkSeq: this.#chunkSeq, events, ...(isFinal ? { final: true } : {}), correlation: this.correlation }, blobs });
    }
  }

  // ---------------------------------------------------------------- durable outbox

  #state(): OutboxCheckpoint {
    return {
      format: OUTBOX_FORMAT,
      sessionId: this.sessionId,
      revision: (this.#checkpoint?.revision ?? 0) + 1,
      correlation: this.correlation,
      agent: this.#agent,
      seq: this.#outbox.reduce((m, c) => (c.entry ? Math.max(m, c.chunk.events[c.chunk.events.length - 1]!.seq) : m), this.#lastPersistedSeq()),
      chunkSeq: this.#outbox.reduce((m, c) => (c.entry ? Math.max(m, c.chunk.chunkSeq) : m), this.#checkpoint?.chunkSeq ?? 0),
      finished: this.#finalQueued,
      finalQueued: this.#finalQueued,
      finalAcked: this.#finalAcked,
      pending: this.#outbox.filter((c) => c.entry).map((c) => c.entry!),
      rejected: this.#rejected,
      updatedAt: this.recorder.opts.now().toISOString(),
    };
  }

  #lastPersistedSeq(): number {
    return this.#checkpoint?.seq ?? 0;
  }

  async #cas(next: OutboxCheckpoint): Promise<void> {
    const outbox = this.recorder.opts.outbox!;
    const expected = this.#created ? this.#checkpoint!.revision : null;
    let ok: boolean;
    try {
      ok = await outbox.casCheckpoint(this.sessionId, expected, JSON.stringify(next), next.revision);
    } catch (error) {
      throw error instanceof TraceOutboxError ? error : new TraceOutboxError("store_error", `Outbox write for ${this.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    if (!ok) {
      this.#fenced = expected === null
        ? new TraceOutboxError("session_exists", `Session ${this.sessionId} already exists in the outbox; use recorder.resume() instead of begin() (session ids are never reused)`)
        : new TraceOutboxError("ownership_lost", `Session ${this.sessionId} was taken over by another writer (resumed elsewhere); this instance stops writing (fail closed)`);
      throw this.#fenced;
    }
    this.#checkpoint = next;
    this.#created = true;
  }

  /** Persist newly formed chunk bodies + blobs, then the checkpoint that references them. */
  async #persistFormed(): Promise<void> {
    const outbox = this.recorder.opts.outbox;
    if (!outbox) return;
    if (this.#fenced) throw this.#fenced;
    const fresh = this.#outbox.filter((c) => !c.entry);
    if (!fresh.length && this.#created) return;
    for (const c of fresh) {
      for (const b of c.blobs) await outbox.putObject(blobObjectKeyFor(this.sessionId, b.sha256), b.bytes);
      const body = Buffer.from(JSON.stringify(c.chunk), "utf8");
      const bodySha = createHash("sha256").update(body).digest("hex");
      await outbox.putObject(chunkObjectKeyFor(this.sessionId, c.chunk.chunkSeq, bodySha), body);
      c.entry = {
        chunkSeq: c.chunk.chunkSeq,
        sha256: bodySha,
        firstSeq: c.chunk.events[0]!.seq,
        lastSeq: c.chunk.events[c.chunk.events.length - 1]!.seq,
        events: c.chunk.events.length,
        final: c.chunk.final === true,
        blobs: c.blobs.map((b) => ({ sha256: b.sha256, mediaType: b.mediaType, bytes: b.bytes.length })),
      };
    }
    try {
      await this.#cas(this.#state());
    } catch (error) {
      // Not persisted: forget the entries so the next attempt writes them again (bodies are idempotent).
      for (const c of fresh) delete c.entry;
      throw error;
    }
  }

  /** After the server acked (or permanently rejected) a chunk: drop it from the checkpoint, then delete its body. */
  async #persistAck(out: OutboundChunk): Promise<void> {
    const outbox = this.recorder.opts.outbox;
    if (!outbox || !out.entry) return;
    await this.#cas(this.#state());
    await outbox.deleteObject(chunkObjectKeyFor(this.sessionId, out.chunk.chunkSeq, out.entry.sha256)).catch(() => undefined);
    // Blobs are scoped to this session; delete one only when no pending chunk OF THIS SESSION still references it.
    const still = new Set(this.#outbox.flatMap((c) => c.blobs.map((b) => b.sha256)));
    for (const b of out.blobs) if (!still.has(b.sha256)) await outbox.deleteObject(blobObjectKeyFor(this.sessionId, b.sha256)).catch(() => undefined);
    if (this.#finalAcked && this.#timer) clearInterval(this.#timer);
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
