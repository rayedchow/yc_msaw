import { z } from "zod";
import { AgentInfoSchema, CorrelationSchema, SESSION_ID_RE, SHA256_RE } from "../traces/schema.js";

/**
 * Opt-in durable delivery for the trace SDK (restart-safe outbox).
 *
 * Storage is behind `TraceOutboxStore`, so a customer can back it with IndexedDB, a database or anything with an
 * atomic compare-and-swap; `FileTraceOutbox` (./outbox-file.ts) is the Node filesystem implementation.
 *
 * Per session the store holds:
 *  - a CHECKPOINT (JSON, CAS on `revision`): correlation, agent, last assigned event seq and chunkSeq, finish flags and
 *    the ordered list of chunks that were formed but not yet acknowledged by the server;
 *  - one object per unacked chunk body (`chunk/<sessionId>/<chunkSeq>-<sha256>`, content-addressed) and per referenced
 *    blob (`blob/<sessionId>/<sha256>`, scoped to the session).
 *
 * Protocol (see TraceSession.flush):
 *   form chunks -> put chunk bodies + blobs -> CAS checkpoint -> send in chunkSeq order -> on ack: CAS checkpoint
 *   without that chunk -> delete its body.
 * A crash after the server accepted a chunk but before the ack was persisted makes the resumed session resend the
 * SAME chunkSeq with the SAME bytes, which the server deduplicates. The checkpoint survives full delivery (seq and
 * chunkSeq are never reused after a restart) and remains as a tombstone after an explicit finish() was delivered,
 * so a finished sessionId cannot be begun again from the same outbox.
 *
 * Every write is a CAS on the checkpoint revision: a second writer (e.g. a stale process after another resumed the
 * session) fails closed with TraceOutboxError("ownership_lost").
 */

export interface TraceOutboxStore {
  /** Session ids that have a checkpoint (any state). */
  listSessions(): Promise<string[]>;
  readCheckpoint(sessionId: string): Promise<string | null>;
  /**
   * Atomically replace the checkpoint iff its current revision equals `expectedRevision` (null = must not exist).
   * Returns false (without writing) on mismatch. Must be durable before resolving.
   */
  casCheckpoint(sessionId: string, expectedRevision: number | null, json: string, revision: number): Promise<boolean>;
  /** Create-or-replace an immutable object (chunk body / blob). Durable before resolving. */
  putObject(key: string, bytes: Uint8Array): Promise<void>;
  getObject(key: string): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
}

export type TraceOutboxErrorCode = "ownership_lost" | "session_exists" | "not_found" | "corrupt" | "store_error" | "finished";

export class TraceOutboxError extends Error {
  constructor(readonly code: TraceOutboxErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TraceOutboxError";
  }
}

export const OUTBOX_FORMAT = "procmem.trace-outbox/v1";

export const OutboxChunkEntrySchema = z.strictObject({
  chunkSeq: z.number().int().min(1),
  /** sha256 of the stored chunk body (UTF-8 JSON). */
  sha256: z.string().regex(SHA256_RE),
  firstSeq: z.number().int().min(1),
  lastSeq: z.number().int().min(1),
  events: z.number().int().min(1),
  final: z.boolean(),
  blobs: z.array(z.strictObject({ sha256: z.string().regex(SHA256_RE), mediaType: z.string().min(1).max(200), bytes: z.number().int().nonnegative() })),
});

export const OutboxCheckpointSchema = z
  .strictObject({
    format: z.literal(OUTBOX_FORMAT),
    sessionId: z.string().regex(SESSION_ID_RE),
    revision: z.number().int().min(1),
    correlation: CorrelationSchema,
    agent: AgentInfoSchema,
    /** Last assigned event seq / chunkSeq (never reused after a restart). */
    seq: z.number().int().min(0),
    chunkSeq: z.number().int().min(0),
    finished: z.boolean(),
    finalQueued: z.boolean(),
    /** The final chunk (session_end) was accepted by the server. */
    finalAcked: z.boolean(),
    pending: z.array(OutboxChunkEntrySchema),
    /** Chunks the server rejected permanently (kept for diagnosis; never resent). */
    rejected: z.array(z.strictObject({ chunkSeq: z.number().int().min(1), status: z.number().int().nullable(), message: z.string().max(2000) })),
    updatedAt: z.string(),
  })
  .superRefine((c, ctx) => {
    let prev = 0;
    for (const p of c.pending) {
      if (p.chunkSeq <= prev) ctx.addIssue({ code: "custom", message: "pending chunks must be in increasing chunkSeq order" });
      if (p.chunkSeq > c.chunkSeq) ctx.addIssue({ code: "custom", message: `pending chunk ${p.chunkSeq} is beyond the last formed chunkSeq ${c.chunkSeq}` });
      if (p.lastSeq > c.seq) ctx.addIssue({ code: "custom", message: `pending chunk ${p.chunkSeq} has events beyond the last assigned seq ${c.seq}` });
      prev = p.chunkSeq;
    }
    if (c.finalAcked && c.pending.length) ctx.addIssue({ code: "custom", message: "a finally acknowledged session cannot have pending chunks" });
    if (c.finalAcked && !c.finished) ctx.addIssue({ code: "custom", message: "finalAcked requires finished" });
  });
export type OutboxCheckpoint = z.infer<typeof OutboxCheckpointSchema>;

/**
 * Chunk bodies are content-addressed (chunkSeq + sha256 of the body): a racing writer (duplicate begin(), stale
 * process) whose CAS later fails can never overwrite the body a legitimate checkpoint references.
 */
export function chunkObjectKeyFor(sessionId: string, chunkSeq: number, sha256: string): string {
  return `chunk/${sessionId}/${String(chunkSeq).padStart(6, "0")}-${sha256}`;
}

/** Blobs are scoped per session, so deleting one session's acked blob never removes another session's copy. */
export function blobObjectKeyFor(sessionId: string, sha256: string): string {
  return `blob/${sessionId}/${sha256}`;
}

export function parseCheckpoint(raw: string, sessionId: string): OutboxCheckpoint {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new TraceOutboxError("corrupt", `Outbox checkpoint of ${sessionId} is not valid JSON`, error);
  }
  const parsed = OutboxCheckpointSchema.safeParse(json);
  if (!parsed.success) throw new TraceOutboxError("corrupt", `Outbox checkpoint of ${sessionId} is invalid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  if (parsed.data.sessionId !== sessionId) throw new TraceOutboxError("corrupt", `Outbox checkpoint stored for ${sessionId} names session ${parsed.data.sessionId}`);
  return parsed.data;
}

/** In-memory store (tests, short-lived processes, or a template for custom stores). Not durable across processes. */
export class MemoryTraceOutbox implements TraceOutboxStore {
  readonly #checkpoints = new Map<string, { revision: number; json: string }>();
  readonly #objects = new Map<string, Uint8Array>();

  async listSessions(): Promise<string[]> {
    return [...this.#checkpoints.keys()].sort();
  }
  async readCheckpoint(sessionId: string): Promise<string | null> {
    return this.#checkpoints.get(sessionId)?.json ?? null;
  }
  async casCheckpoint(sessionId: string, expectedRevision: number | null, json: string, revision: number): Promise<boolean> {
    const cur = this.#checkpoints.get(sessionId);
    if ((cur?.revision ?? null) !== expectedRevision) return false;
    this.#checkpoints.set(sessionId, { revision, json });
    return true;
  }
  async putObject(key: string, bytes: Uint8Array): Promise<void> {
    this.#objects.set(key, new Uint8Array(bytes));
  }
  async getObject(key: string): Promise<Uint8Array | null> {
    const v = this.#objects.get(key);
    return v ? new Uint8Array(v) : null;
  }
  async deleteObject(key: string): Promise<void> {
    this.#objects.delete(key);
  }
  /** Test helper: keys currently stored. */
  objectKeys(): string[] {
    return [...this.#objects.keys()].sort();
  }
}
