import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Wire + storage schema for captured agent traces.
 *
 * Every event carries the full payload the client recorded in `data`. Large
 * payloads are content-addressed: the client uploads the exact bytes to
 * `blobs/<sha256>` first and sets `data` to a {@link BlobRef}. Nothing is ever
 * truncated: anything over a bound is rejected with an explicit error.
 */

/** Session ids are used verbatim as storage path segments, so they are lowercase and bounded. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9_-]{2,95}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Max decoded size of one chunk (JSON body). */
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_CHUNK_EVENTS = 1000;
/** Max size of one content-addressed blob (equals the object store's object limit). */
export const MAX_BLOB_BYTES = 32 * 1024 * 1024;
/**
 * Storage-call alignment. The hosted object store moves ~12 MiB per call, so the
 * trace layer never puts or gets more than STORE_CALL_BYTES in one call:
 * blobs larger than BLOB_PART_BYTES are stored as content-addressed parts
 * (`blobs/<partSha>`) plus a `blob-manifests/<sha>.json` part list, and
 * reconstructed (and digest-verified) in full on read. Gets are batched to
 * <= STORE_GET_KEYS keys and <= STORE_CALL_BYTES estimated bytes.
 */
export const BLOB_PART_BYTES = 8 * 1024 * 1024;
export const STORE_CALL_BYTES = 8 * 1024 * 1024;
export const STORE_GET_KEYS = 64;
/** Default total decoded input budget for one materialized cohort (AEye maxInputBytes). */
export const DEFAULT_COHORT_INPUT_BYTES = 128 * 1024 * 1024;
/** Payloads above this are written as separate files when a cohort is materialized. */
export const INLINE_PAYLOAD_LIMIT = 64 * 1024;

/**
 * Wire content types for gzip bodies. They deliberately do not contain
 * "application/json": hosts such as mcp-use eagerly JSON-parse any
 * application/json request body before routing, which breaks gzip bodies.
 * The type itself declares that the body is gzip (no Content-Encoding needed).
 */
export const TRACE_CHUNK_GZIP_CONTENT_TYPE = "application/vnd.procmem.trace-chunk+gzip";
export const TRACE_BLOB_GZIP_CONTENT_TYPE = "application/vnd.procmem.trace-blob+gzip";

export const TRACE_EVENT_TYPES = [
  "session_start",
  "model_input",
  "model_output",
  "tool_call",
  "tool_result",
  "error",
  "note",
  "session_end",
] as const;
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export const OUTCOME_STATUSES = ["succeeded", "failed", "partial", "abandoned"] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export const SessionIdSchema = z.string().regex(SESSION_ID_RE, "sessionId must match ^[a-z0-9][a-z0-9_-]{2,95}$");

/**
 * Correlation identity (see .context/sdk-conversation-contract.md):
 *  - conversationId: stable logical conversation/thread (customer thread id, native harness session id, or generated).
 *    Never used as a storage path segment (stored under sha256).
 *  - runId: one execution attempt (a retry is a new run in the same conversation).
 *  - turnId / spanId / parentSpanId: per event (user turn; model request / tool call / nested agent span).
 * Calendar days only partition receipt storage and daily windows; they are never conversation boundaries.
 */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,199}$/;
export const TRACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const ConversationIdSchema = z.string().regex(CONVERSATION_ID_RE, "conversationId must be 1-200 chars of [A-Za-z0-9._:@/+=-], starting alphanumeric");
export const TraceIdSchema = z.string().regex(TRACE_ID_RE, "ids (runId/turnId/spanId) must be 1-128 chars of [A-Za-z0-9._:-], starting alphanumeric");
export const CONVERSATION_SOURCES = ["explicit", "harness", "generated"] as const;

/** Session-level correlation: constant for a session, carried on every chunk, bound create-once at first ingest. */
export const CorrelationSchema = z.strictObject({
  conversationId: ConversationIdSchema,
  runId: TraceIdSchema,
  /** How conversationId was obtained: supplied by the host, derived from the harness's native session, or generated. */
  conversationSource: z.enum(CONVERSATION_SOURCES),
  /** Child agent session: the session (same conversation + run) that spawned it, and the span it was spawned from. */
  parentSessionId: SessionIdSchema.optional(),
  parentSpanId: TraceIdSchema.optional(),
  /** A retry/resume attempt: the run it retries. */
  previousRunId: TraceIdSchema.optional(),
});
export type TraceCorrelation = z.infer<typeof CorrelationSchema>;

/** Storage key component for a conversation id (opaque, fixed length, tenant-local). */
export function conversationKey(conversationId: string): string {
  return createHash("sha256").update(conversationId, "utf8").digest("hex").slice(0, 32);
}

export function sessionBindingKey(sessionId: string): string {
  return `trace-sessions/${sessionId}.json`;
}

export function conversationMemberKey(conversationId: string, sessionId: string): string {
  return `conversation-index/${conversationKey(conversationId)}/${sessionId}.json`;
}

export const AgentInfoSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  harness: z.string().max(200).optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const UsageSchema = z.strictObject({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type TraceUsage = z.infer<typeof UsageSchema>;

export const OutcomeSchema = z.strictObject({
  status: z.enum(OUTCOME_STATUSES),
  summary: z.string().max(64 * 1024),
  evidence: z.strictObject({ source: z.literal("client-reported"), details: z.unknown() }).optional(),
});
export type TraceOutcome = z.infer<typeof OutcomeSchema>;

export const BlobRefSchema = z.strictObject({
  $blob: z.string().regex(SHA256_RE),
  bytes: z.number().int().nonnegative().max(MAX_BLOB_BYTES),
  mediaType: z.string().min(1).max(200),
});
export type BlobRef = z.infer<typeof BlobRefSchema>;

export function isBlobRef(value: unknown): value is BlobRef {
  return !!value && typeof value === "object" && !Array.isArray(value) && "$blob" in value && BlobRefSchema.safeParse(value).success;
}

/** Unknown keys are rejected (never silently stripped) so no client data is dropped. */
export const TraceEventSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    seq: z.number().int().min(1),
    ts: z.iso.datetime({ offset: true }),
    type: z.enum(TRACE_EVENT_TYPES),
    agent: AgentInfoSchema,
    data: z.unknown(),
    usage: UsageSchema.optional(),
    outcome: OutcomeSchema.optional(),
    /** User turn this event belongs to. */
    turnId: TraceIdSchema.optional(),
    /** Span (model request, tool call, nested agent) this event belongs to, and its parent span. */
    spanId: TraceIdSchema.optional(),
    parentSpanId: TraceIdSchema.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.data === undefined) ctx.addIssue({ code: "custom", path: ["data"], message: "data is required (use null for no payload)" });
    if (e.outcome && e.type !== "session_end") ctx.addIssue({ code: "custom", path: ["outcome"], message: "outcome is only allowed on session_end" });
    if (e.data && typeof e.data === "object" && !Array.isArray(e.data) && "$blob" in e.data && !BlobRefSchema.safeParse(e.data).success) {
      ctx.addIssue({ code: "custom", path: ["data"], message: "malformed $blob reference: expected {$blob: sha256hex, bytes, mediaType}" });
    }
  });
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const TraceChunkSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    chunkSeq: z.number().int().min(1),
    events: z.array(TraceEventSchema).min(1, "chunk must contain at least one event").max(MAX_CHUNK_EVENTS, `chunk exceeds ${MAX_CHUNK_EVENTS} events`),
    final: z.boolean().optional(),
    /** Session correlation; identical on every chunk of a session (absent = legacy session). */
    correlation: CorrelationSchema.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.correlation?.parentSessionId === c.sessionId) ctx.addIssue({ code: "custom", path: ["correlation", "parentSessionId"], message: "a session cannot be its own parent" });
    let prev = 0;
    c.events.forEach((e, i) => {
      if (e.sessionId !== c.sessionId) ctx.addIssue({ code: "custom", path: ["events", i, "sessionId"], message: `event sessionId ${e.sessionId} does not match chunk sessionId ${c.sessionId}` });
      if (e.seq <= prev) ctx.addIssue({ code: "custom", path: ["events", i, "seq"], message: `event seq ${e.seq} is not strictly increasing (previous ${prev})` });
      prev = e.seq;
    });
  });
export type TraceChunk = z.infer<typeof TraceChunkSchema>;

/** Format a zod error as a bounded, readable message (lists the first issues and counts the rest). */
export function describeZodError(error: z.ZodError, maxIssues = 20): string {
  const issues = error.issues.slice(0, maxIssues).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  const rest = error.issues.length - issues.length;
  return issues.join("; ") + (rest > 0 ? `; (+${rest} more issues)` : "");
}

export function chunkObjectKey(day: string, sessionId: string, chunkSeq: number): string {
  return `traces/${day}/${sessionId}/chunk-${String(chunkSeq).padStart(6, "0")}.jsonl.gz`;
}

export function chunkIndexKey(sessionId: string, chunkSeq: number): string {
  return `trace-index/${sessionId}/chunk-${String(chunkSeq).padStart(6, "0")}.json`;
}

const CHUNK_KEY_RE = /^traces\/(\d{4}-\d{2}-\d{2})\/([a-z0-9][a-z0-9_-]{2,95})\/chunk-(\d{6,})\.jsonl\.gz$/;

export function parseChunkKey(key: string): { day: string; sessionId: string; chunkSeq: number } | null {
  const m = CHUNK_KEY_RE.exec(key);
  if (!m) return null;
  return { day: m[1]!, sessionId: m[2]!, chunkSeq: Number(m[3]) };
}

/** Rejects malformed and non-calendar days (e.g. 2026-02-30) via an ISO round trip. */
export function assertDay(day: string): void {
  const parsed = DAY_RE.test(day) ? new Date(`${day}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid day ${JSON.stringify(day)} (expected a real calendar date YYYY-MM-DD)`);
  }
}

export function blobManifestKey(sha: string): string {
  return `blob-manifests/${sha}.json`;
}
