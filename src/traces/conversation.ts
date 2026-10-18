import { type ObjectStore } from "../store/objects.js";
import { getBatched, listPages, readSessionBinding, type ChunkIndexRecord, type ConversationMember, type SessionBinding } from "./ingest.js";
import { chunkIndexKey, conversationKey, sessionBindingKey, STORE_CALL_BYTES, STORE_GET_KEYS, type TraceCorrelation } from "./schema.js";

/**
 * Conversation correlation + explicit per-session coverage for daily cohorts.
 *
 * Days only partition receipt storage and daily windows. A session (and a conversation of many sessions/runs) can span
 * any number of receipt days; each daily manifest still pins only NEW immutable chunks, and this module records, per
 * cohort session, exactly which earlier chunks of the same session exist and whether they were already processed by a
 * published manifest. Nothing old is reprocessed; history is reachable read-only through sources/.
 *
 * Every listing is paged and every count is capped. Over a cap the operation FAILS (ConversationLimitError) instead
 * of truncating history silently.
 */

export const DEFAULT_MAX_SESSION_CHUNKS = 100_000;
export const DEFAULT_MAX_CONVERSATION_SESSIONS = 5_000;

/** Min/max of any iterable without spreading it into a call (no argument-count ceiling for large histories). */
export function extent(values: Iterable<number>): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

export class ConversationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationLimitError";
  }
}

export interface CoverageLimits {
  /** Max chunks listed for one session's history (default 100000). */
  maxSessionChunks?: number;
  /** Max sessions listed for one conversation (default 5000). */
  maxConversationSessions?: number;
  listPageSize?: number;
  maxGetKeys?: number;
  maxGetBytes?: number;
}

/** Limits must be finite positive integers: NaN, Infinity, 0, negatives or fractions would silently disable a cap. */
function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new ConversationLimitError(`${name} must be a positive integer (got ${String(value)})`);
  return value;
}

/** Validate host-supplied limits up front (throws ConversationLimitError on NaN/Infinity/non-positive/fractional). */
export function validateCoverageLimits(o: CoverageLimits): void {
  lim(o);
}

function lim(o: CoverageLimits) {
  return {
    maxSessionChunks: positiveInt(o.maxSessionChunks, DEFAULT_MAX_SESSION_CHUNKS, "maxSessionChunks"),
    maxConversationSessions: positiveInt(o.maxConversationSessions, DEFAULT_MAX_CONVERSATION_SESSIONS, "maxConversationSessions"),
    listPageSize: positiveInt(o.listPageSize, 1000, "listPageSize"),
    maxGetKeys: Math.min(positiveInt(o.maxGetKeys, STORE_GET_KEYS, "maxGetKeys"), STORE_GET_KEYS),
    maxGetBytes: Math.min(positiveInt(o.maxGetBytes, STORE_CALL_BYTES, "maxGetBytes"), STORE_CALL_BYTES),
  };
}

/** Immutable coverage of one session in one daily manifest (recorded at pin time). */
export interface SessionCoverage {
  sessionId: string;
  /** Bound correlation (null = legacy session without correlation). */
  correlation: TraceCorrelation | null;
  /** Chunks of this session pinned by THIS manifest (the new material). */
  cohort: { chunkSeqs: number[]; firstSeq: number; lastSeq: number; events: number };
  /**
   * Chunks of this session NOT in this cohort with a lower chunkSeq than the cohort's last chunk (any receipt day).
   * Includes chunks interleaved between cohort chunks (e.g. chunk 2 received on an earlier day than chunks 1 and 3).
   */
  prior: {
    chunks: number;
    firstSeq: number | null;
    lastSeq: number | null;
    days: string[];
    /** Prior chunks contained in a published manifest of their day (already built into memory). */
    processedChunks: number;
    /** Prior chunks NOT yet covered by any published manifest (their own day's build is pending/failed). */
    unprocessedChunkSeqs: number[];
    /** Prior chunks whose chunkSeq lies between this cohort's first and last chunk (interleaved receipt order). */
    interleavedChunkSeqs: number[];
    chunkSeqs: number[];
  };
  /** Chunks of this session with a higher chunkSeq than this cohort (received later, e.g. while catching up). */
  laterChunks: number;
  /** True when the cohort starts at chunk 1 / event seq 1 (a new session, not a continuation). */
  startsSession: boolean;
}

interface DayProcessed {
  load(day: string): Promise<Set<string>>;
}

/** Per-pin cache: chunk keys of every published manifest of a day (each day loaded once). */
export function processedCache(loadPublished: (day: string) => Promise<Set<string>>): DayProcessed {
  const cache = new Map<string, Promise<Set<string>>>();
  return {
    load(day: string) {
      let p = cache.get(day);
      if (!p) {
        p = loadPublished(day);
        cache.set(day, p);
      }
      return p;
    },
  };
}

/** All chunk index records of a session (paged, capped, fail closed). */
export async function sessionChunkRecords(store: ObjectStore, ns: string, sessionId: string, o: CoverageLimits = {}): Promise<ChunkIndexRecord[]> {
  const l = lim(o);
  const keys: string[] = [];
  for await (const page of listPages(store, ns, `trace-index/${sessionId}/`, l.listPageSize)) {
    keys.push(...page);
    if (keys.length > l.maxSessionChunks) {
      throw new ConversationLimitError(`Session ${sessionId} has more than maxSessionChunks=${l.maxSessionChunks} chunks; raise the limit to compute its coverage (history is never truncated)`);
    }
  }
  const raw = await getBatched(store, ns, keys, { maxKeys: l.maxGetKeys, maxBytes: l.maxGetBytes, sizeOf: () => 1024 });
  const out: ChunkIndexRecord[] = [];
  for (const k of keys) {
    const b = raw.get(k);
    if (!b) throw new Error(`Chunk index ${k} disappeared while computing coverage`);
    out.push(JSON.parse(b.toString("utf8")) as ChunkIndexRecord);
  }
  return out.sort((a, b) => a.chunkSeq - b.chunkSeq);
}

/** Session bindings for many sessions in batched reads (missing = never bound = legacy). */
export async function readBindings(store: ObjectStore, ns: string, sessionIds: readonly string[], o: CoverageLimits = {}): Promise<Map<string, SessionBinding | null>> {
  const l = lim(o);
  const raw = await getBatched(store, ns, sessionIds.map(sessionBindingKey), { maxKeys: l.maxGetKeys, maxBytes: l.maxGetBytes, sizeOf: () => 2048 });
  const out = new Map<string, SessionBinding | null>();
  for (const sid of sessionIds) {
    const b = raw.get(sessionBindingKey(sid));
    out.set(sid, b ? (JSON.parse(b.toString("utf8")) as SessionBinding) : null);
  }
  return out;
}

export async function computeCoverage(
  store: ObjectStore,
  ns: string,
  cohort: ReadonlyArray<{ key: string; sessionId: string; chunkSeq: number }>,
  processed: DayProcessed,
  o: CoverageLimits = {},
): Promise<SessionCoverage[]> {
  const bySession = new Map<string, Set<number>>();
  for (const c of cohort) (bySession.get(c.sessionId) ?? bySession.set(c.sessionId, new Set()).get(c.sessionId)!).add(c.chunkSeq);
  const sessionIds = [...bySession.keys()].sort();
  const bindings = await readBindings(store, ns, sessionIds, o);
  const out: SessionCoverage[] = [];
  for (const sid of sessionIds) {
    const seqs = bySession.get(sid)!;
    const records = await sessionChunkRecords(store, ns, sid, o);
    const inCohort = records.filter((r) => seqs.has(r.chunkSeq));
    if (inCohort.length !== seqs.size) throw new Error(`Coverage for session ${sid}: ${seqs.size - inCohort.length} cohort chunks have no index record`);
    const { min: minSeq, max: maxSeq } = extent(seqs);
    const prior = records.filter((r) => r.chunkSeq < maxSeq && !seqs.has(r.chunkSeq));
    let processedChunks = 0;
    const unprocessed: number[] = [];
    for (const r of prior) {
      if ((await processed.load(r.day)).has(r.key)) processedChunks++;
      else unprocessed.push(r.chunkSeq);
    }
    out.push({
      sessionId: sid,
      correlation: bindings.get(sid)?.correlation ?? null,
      cohort: {
        chunkSeqs: [...seqs].sort((a, b) => a - b),
        firstSeq: extent(inCohort.map((r) => r.firstSeq)).min,
        lastSeq: extent(inCohort.map((r) => r.lastSeq)).max,
        events: inCohort.reduce((n, r) => n + r.events, 0),
      },
      prior: {
        chunks: prior.length,
        firstSeq: prior.length ? prior[0]!.firstSeq : null,
        lastSeq: prior.length ? prior[prior.length - 1]!.lastSeq : null,
        days: [...new Set(prior.map((r) => r.day))].sort(),
        processedChunks,
        unprocessedChunkSeqs: unprocessed,
        interleavedChunkSeqs: prior.filter((r) => r.chunkSeq > minSeq).map((r) => r.chunkSeq),
        chunkSeqs: prior.map((r) => r.chunkSeq),
      },
      laterChunks: records.filter((r) => r.chunkSeq > maxSeq).length,
      startsSession: minSeq === 1,
    });
  }
  return out;
}

/** Every session of a conversation in this tenant (paged, capped, fail closed). */
export async function conversationMembers(store: ObjectStore, ns: string, conversationId: string, o: CoverageLimits = {}): Promise<ConversationMember[]> {
  const l = lim(o);
  const keys: string[] = [];
  for await (const page of listPages(store, ns, `conversation-index/${conversationKey(conversationId)}/`, l.listPageSize)) {
    keys.push(...page);
    if (keys.length > l.maxConversationSessions) {
      throw new ConversationLimitError(`Conversation has more than maxConversationSessions=${l.maxConversationSessions} sessions; raise the limit (history is never truncated)`);
    }
  }
  const raw = await getBatched(store, ns, keys, { maxKeys: l.maxGetKeys, maxBytes: l.maxGetBytes, sizeOf: () => 1024 });
  const members: ConversationMember[] = [];
  for (const k of keys) {
    const m = JSON.parse(raw.get(k)!.toString("utf8")) as ConversationMember;
    // A hash-prefix collision would be a different conversation: never mix it in.
    if (m.conversationId === conversationId) members.push(m);
  }
  return members.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.sessionId < b.sessionId ? -1 : 1));
}

export type ParentLinkStatus = "none" | "verified" | "pending" | "mismatch";

/**
 * Status of a child's parent link at read time. Children may be delivered before their parent (independent flushes,
 * other processes), so ingest accepts an unknown parent; consistency is evaluated here once the parent is bound.
 */
export function parentLinkStatus(child: TraceCorrelation | null, parent: SessionBinding | null | undefined): ParentLinkStatus {
  if (!child?.parentSessionId) return "none";
  if (!parent) return "pending";
  return parent.correlation?.conversationId === child.conversationId && parent.correlation?.runId === child.runId ? "verified" : "mismatch";
}

export { readSessionBinding };
