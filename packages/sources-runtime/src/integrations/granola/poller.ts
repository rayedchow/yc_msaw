import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { deriveActivityEventSourceContract } from "../../db/activity-event-source.js";
import { activityEvents, conversationWatermarks } from "../../db/schema.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import { getTokenFull, mergeTokenMetadata } from "../../vault/tokens.js";
import { classifyCredentialFailure } from "../../vault/credential-failure.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { env } from "../../env.js";
import { activityEventTimes } from "../../lib/activity-event-time.js";
import {
  deleteGranolaMeetingSourceWiki,
  materializeGranolaMeetingSourceWiki,
} from "../../mirror/materializer.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../../lib/concurrency.js";
import {
  granolaOAuthTokenExpiresSoon,
  isGranolaOAuthTokenMetadata,
  refreshGranolaOAuthToken,
} from "./oauth.js";
import {
  createGranolaMcpClient,
  fetchGranolaNoteWithMcpClient,
  listGranolaNotesWithMcpClient,
  type GranolaMcpClient,
} from "./mcp-client.js";

const GRANOLA_API = "https://public-api.granola.ai/v1";
const RATE_LIMIT_DELAY_MS = 220;
const GRANOLA_DELETION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GRANOLA_DELETION_SWEEP_MAX_PAGES = 200;
const NOTE_CHUNK_TARGET_CHARS = 4_000;
const TRANSCRIPT_WINDOW_TARGET_CHARS = 4_000;
const NOTE_CONCURRENCY = parseConcurrencyEnv("GRANOLA_NOTE_CONCURRENCY", 5, { max: 10 });

export interface GranolaPerson {
  name?: string | null;
  email?: string | null;
}

export interface GranolaTranscriptItem {
  speaker?: {
    source?: string;
    diarization_label?: string;
  };
  text?: string;
  start_time?: string;
  end_time?: string;
}

export interface GranolaNoteListItem {
  id: string;
  title: string | null;
  owner?: GranolaPerson | null;
  created_at: string;
  updated_at: string;
}

export interface GranolaNote extends GranolaNoteListItem {
  object?: "note";
  web_url?: string;
  calendar_event?: {
    event_title?: string | null;
    invitees?: Array<{ email?: string | null }>;
    organiser?: string | null;
    calendar_event_id?: string | null;
    scheduled_start_time?: string | null;
    scheduled_end_time?: string | null;
  } | null;
  attendees?: GranolaPerson[];
  folder_membership?: Array<{
    id: string;
    object?: "folder";
    name?: string | null;
    parent_folder_id?: string | null;
  }>;
  summary_text?: string | null;
  summary_markdown?: string | null;
  transcript?: GranolaTranscriptItem[] | null;
}

export interface GranolaListResponse {
  notes: GranolaNoteListItem[];
  hasMore: boolean;
  cursor: string | null;
}

export interface GranolaIngestionResult {
  listed: number;
  processed: number;
  failed: number;
  stored: number;
  skipped: number;
  /** Previously captured notes observed as deleted (tombstone written). */
  tombstoned: number;
  /** Counted (never silent) skips keyed by reason, e.g. deleted_uncaptured. */
  skips?: Record<string, number>;
  newestUpdatedAt: string | null;
  watermarkAdvancedTo: string | null;
  exhausted: boolean;
  capHit: boolean;
  /** Present when this run also performed a deletion-reconciliation sweep. */
  deletionSweep?: GranolaDeletionSweepResult | null;
  // SOURCE-LANE PATCH (granola): which notes failed (retried by id by the
  // lane), whether a page said hasMore without a cursor (window can never
  // drain), and the run's start (watermark safety bound).
  failures?: GranolaNoteFailure[];
  listingTruncated?: boolean;
}

export type GranolaNoteFailure = { id: string; error: string };

/** Per-page checkpoint of a run: `nextCursor` is where a restarted run resumes (null = listing finished). */
export type GranolaPageCheckpoint = {
  nextCursor: string | null;
  listed: number;
  pageFailures: GranolaNoteFailure[];
};

export type GranolaDeletionSweepResult = {
  tracked: number;
  listedPages: number;
  listingIncomplete: boolean;
  missing: number;
  tombstoned: number;
  confirmFailed: number;
};

export interface GranolaIngestOptions {
  includeTranscript?: boolean;
  folderId?: string;
  maxNotes?: number | null;
  // SOURCE-LANE PATCH (granola): start of the earliest run that listed the
  // current (possibly resumed) window; the watermark never passes it.
  watermarkCeiling?: string | null;
}

export interface GranolaBackfillOptions extends GranolaIngestOptions {
  days?: number | null;
  // SOURCE-LANE PATCH (granola): resumable inventory pass (page checkpoint).
  cursor?: string | null;
  onPage?: (checkpoint: GranolaPageCheckpoint) => Promise<void>;
}

// SOURCE-LANE PATCH (granola): Granola's clock and ours may disagree, and a
// note can be edited while a run is listing; the watermark therefore never
// passes (run start - safety). The overlap costs a re-fetch that dedupes.
export const GRANOLA_WATERMARK_SAFETY_MS = 60_000;

export function clampGranolaWatermark(
  candidate: string | null | undefined,
  ceiling: string | Date,
  floor: string | null | undefined,
): string | null {
  const valid = validIsoDate(candidate);
  if (!valid) return null;
  const ceilingIso = new Date(new Date(ceiling).getTime() - GRANOLA_WATERMARK_SAFETY_MS).toISOString();
  const bounded = valid < ceilingIso ? valid : ceilingIso;
  return maxIsoDate(bounded, floor) ?? bounded;
}

type FetchedGranolaNote = {
  note: GranolaNote;
  transcriptIncluded: boolean;
  transcriptError?: string;
  apiSource?: string;
};

type GranolaNoteWorkItem = {
  item: GranolaNoteListItem;
  listedIndex: number;
};

type GranolaNoteWorkResult = {
  id: string;
  stored: number;
  skipped: number;
  tombstoned: number;
  deletedUncaptured: number;
  updatedAt: string | null;
  newestUpdatedAt: string | null;
  failure?: string;
};

type StoredGranolaToken = {
  token: string;
  refreshToken: string | null;
  metadata: Record<string, unknown> | null;
};

type GranolaResumeMetadata = {
  cursor: string;
  updatedAfter: string;
  maxSeenUpdatedAt: string | null;
};

type GranolaIngestRunResult = GranolaIngestionResult & {
  resumeCursor: string | null;
  maxProcessedUpdatedAt: string | null;
  failures: GranolaNoteFailure[];
  listingTruncated: boolean;
};

type GranolaCredential =
  | { mode: "api_key"; token: string }
  | {
      mode: "oauth_mcp";
      userId: string;
      token: string;
      refreshToken: string | null;
      metadata: Record<string, unknown> | null;
      mcpClient?: GranolaMcpClient;
    };

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPageSize(pageSize: number | undefined): number {
  return Math.min(Math.max(pageSize ?? 30, 1), 30);
}

function clampMaxNotes(maxNotes: number | null | undefined): number {
  return maxNotes == null ? Number.POSITIVE_INFINITY : Math.min(Math.max(maxNotes, 1), 100_000);
}

// Granola publishes per-user/workspace limits (25-request burst per 5 s, 5 rps
// sustained; docs.granola.ai/introduction#rate-limits) and answers 429; honor
// Retry-After (delta-seconds or HTTP-date) with a bounded number of retries
// instead of failing the whole poll run immediately.
const GRANOLA_RETRY_MAX_ATTEMPTS = 3;
const GRANOLA_RETRY_MAX_DELAY_MS = 30_000;

function granolaRetryAfterMs(res: Response): number | null {
  return parseGranolaRetryAfter(res.headers.get("retry-after"));
}

// SOURCE-LANE PATCH (granola): shared Retry-After parsing for REST, MCP and the
// durable cooldown (src/source-lane/providers/granola/lane.ts).
export function parseGranolaRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - now) : null;
}

/** Retry-After carried by a surfaced Granola 429 error message (`retry-after=<value>`), in ms. */
export function granolaRetryAfterFromError(err: unknown, now = Date.now()): number | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/\(429\)/.test(message)) return null;
  // HTTP-dates contain ':' but never ': ', which separates the response body.
  const match = /retry-after=(.+?)(?:: |$)/.exec(message);
  return parseGranolaRetryAfter(match?.[1]?.trim(), now) ?? 0;
}

// SOURCE-LANE PATCH (granola): one in-process gate per credential so the
// concurrent note fetchers of a run all pause when any of them sees a 429
// (Granola rate-limits the credential, not the request). Keyed by a token hash.
const granolaRateGates = new Map<string, number>();

export function granolaRateGateKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

/**
 * Waits out a short hold on the credential. A hold longer than the in-request
 * cap is not slept in-process (a worker would idle for the whole Retry-After,
 * and setTimeout fires at once beyond ~24.8 days): the remaining ms are
 * returned, the caller sends nothing and surfaces a 429, and the lane turns it
 * into the durable cooldown. Returns 0 when the request may go out.
 */
export async function waitForGranolaRateGate(token: string): Promise<number> {
  const until = granolaRateGates.get(granolaRateGateKey(token));
  if (until === undefined) return 0;
  const waitMs = until - Date.now();
  if (waitMs > GRANOLA_RETRY_MAX_DELAY_MS) return waitMs;
  if (waitMs > 0) await sleep(waitMs);
  return 0;
}

export function holdGranolaRateGate(token: string, delayMs: number): void {
  const key = granolaRateGateKey(token);
  const until = Date.now() + Math.max(0, delayMs);
  if ((granolaRateGates.get(key) ?? 0) < until) granolaRateGates.set(key, until);
}

async function granolaRequest(
  path: string,
  token: string,
  params: Record<string, string | number | undefined> = {},
): Promise<Response> {
  const url = new URL(`${GRANOLA_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  for (let attempt = 0; ; attempt++) {
    const heldMs = await waitForGranolaRateGate(token);
    if (heldMs > 0) {
      // Nothing is sent: surfaced like Granola's own 429, with the remaining wait.
      return new Response("credential rate gate held", { status: 429, headers: { "retry-after": String(Math.ceil(heldMs / 1000)) } });
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 429) return res;
    const delayMs = granolaRetryAfterMs(res) ?? 1000 * (attempt + 1);
    holdGranolaRateGate(token, delayMs);
    // SOURCE-LANE PATCH (granola): never retry before Retry-After elapses. A
    // wait longer than the in-request cap is surfaced instead of being cut
    // short; the lane turns it into a durable cooldown for the credential.
    if (attempt >= GRANOLA_RETRY_MAX_ATTEMPTS || delayMs > GRANOLA_RETRY_MAX_DELAY_MS) return res;
    await sleep(delayMs);
  }
}

async function parseGranolaJson<T>(res: Response): Promise<T> {
  const body = await res.text();
  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after");
    const suffix = retryAfter ? `; retry-after=${retryAfter}` : "";
    throw new Error(`Granola API failed (${res.status})${suffix}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) as T : {} as T;
}

export async function listGranolaNotes(
  token: string,
  opts: {
    createdAfter?: string;
    updatedAfter?: string;
    folderId?: string;
    cursor?: string;
    pageSize?: number;
  } = {},
): Promise<GranolaListResponse> {
  const res = await granolaRequest("/notes", token, {
    created_after: opts.createdAfter,
    updated_after: opts.updatedAfter,
    folder_id: opts.folderId,
    cursor: opts.cursor,
    page_size: clampPageSize(opts.pageSize),
  });
  return parseGranolaJson<GranolaListResponse>(res);
}

async function listGranolaNotesWithCredential(
  credential: GranolaCredential,
  opts: Parameters<typeof listGranolaNotes>[1] = {},
): Promise<GranolaListResponse> {
  if (credential.mode === "oauth_mcp") {
    const client = credential.mcpClient ?? await createGranolaMcpClient(credential.token);
    return listGranolaNotesWithMcpClient(client, opts);
  }
  return listGranolaNotes(credential.token, opts);
}

export async function fetchGranolaNote(
  token: string,
  noteId: string,
  includeTranscript = true,
): Promise<FetchedGranolaNote> {
  const params = includeTranscript ? { include: "transcript" } : {};
  const res = await granolaRequest(`/notes/${encodeURIComponent(noteId)}`, token, params);
  if (res.ok) {
    const note = await parseGranolaJson<GranolaNote>(res);
    return { note, transcriptIncluded: Array.isArray(note.transcript) };
  }

  if (includeTranscript && (res.status === 400 || res.status === 403)) {
    const failure = await res.text();
    const fallback = await granolaRequest(`/notes/${encodeURIComponent(noteId)}`, token);
    const note = await parseGranolaJson<GranolaNote>(fallback);
    return {
      note: { ...note, transcript: note.transcript ?? null },
      transcriptIncluded: false,
      transcriptError: failure.slice(0, 500),
    };
  }

  await parseGranolaJson<GranolaNote>(res);
  throw new Error("Granola note fetch failed");
}

async function fetchGranolaNoteWithCredential(
  credential: GranolaCredential,
  noteId: string,
  includeTranscript = true,
): Promise<FetchedGranolaNote> {
  if (credential.mode === "oauth_mcp") {
    const client = credential.mcpClient ?? await createGranolaMcpClient(credential.token);
    return fetchGranolaNoteWithMcpClient(client, noteId, includeTranscript);
  }
  return fetchGranolaNote(credential.token, noteId, includeTranscript);
}

function validIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function maxIsoDate(a: string | null | undefined, b: string | null | undefined): string | null {
  const validA = validIsoDate(a);
  const validB = validIsoDate(b);
  if (!validA) return validB;
  if (!validB) return validA;
  return validA > validB ? validA : validB;
}

function granolaResumeFromMetadata(metadata: Record<string, unknown>): GranolaResumeMetadata | null {
  const resume = objectOrNull(metadata.granolaResume);
  if (!resume) return null;
  const cursor = stringOrNull(resume.cursor);
  const updatedAfter = stringOrNull(resume.updatedAfter);
  if (!cursor || !updatedAfter || !validIsoDate(updatedAfter)) return null;
  return {
    cursor,
    updatedAfter,
    maxSeenUpdatedAt: validIsoDate(stringOrNull(resume.maxSeenUpdatedAt)),
  };
}

function noteEventTimestamp(note: GranolaNote): Date {
  const scheduled = validIsoDate(note.calendar_event?.scheduled_start_time);
  const created = validIsoDate(note.created_at);
  return new Date(scheduled ?? created ?? Date.now());
}

function noteUpdatedAt(note: GranolaNoteListItem): string | null {
  return validIsoDate(note.updated_at);
}

function compareGranolaNoteListItems(a: GranolaNoteListItem, b: GranolaNoteListItem): number {
  const aUpdatedAt = noteUpdatedAt(a) ?? "";
  const bUpdatedAt = noteUpdatedAt(b) ?? "";
  if (aUpdatedAt !== bUpdatedAt) return aUpdatedAt < bUpdatedAt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function hashGranolaNote(note: GranolaNote): string {
  return createHash("sha256").update(JSON.stringify(note)).digest("hex");
}

// SOURCE-LANE PATCH (granola): content identity of a stored observation. The
// redacted provider payload minus fetch metadata (`api`, `_content_hash`), as
// canonical JSON (sorted keys), so a re-fetch of unchanged content compares equal
// even when per-request signed asset URLs or key order differ.
const GRANOLA_NON_CONTENT_KEYS = new Set(["api", "_content_hash"]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function granolaComparableHash(rawPayload: Record<string, unknown>): string {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawPayload)) {
    if (!GRANOLA_NON_CONTENT_KEYS.has(key)) content[key] = value;
  }
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function granolaLosesTranscript(previous: Record<string, unknown>, fetched: FetchedGranolaNote): boolean {
  if (fetched.transcriptIncluded) return false;
  const next = fetched.note.transcript;
  if (Array.isArray(next) && next.length > 0) return false;
  return Array.isArray(previous.transcript) && previous.transcript.length > 0;
}

async function latestGranolaObservation(
  userId: string,
  baseSourceEventId: string,
): Promise<{ id: string; sourceEventId: string; rawPayload: unknown } | null> {
  const result = await db.execute(sql`
    SELECT id::text AS id, source_event_id, raw_payload FROM activity_events
     WHERE user_id = ${userId} AND source = 'granola'
       AND (source_event_id = ${baseSourceEventId} OR starts_with(source_event_id, ${`${baseSourceEventId}#`}))
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{ id: string; source_event_id: string; raw_payload: unknown }>;
  const row = rows[0];
  return row ? { id: row.id, sourceEventId: row.source_event_id, rawPayload: row.raw_payload } : null;
}

function granolaSourceEventId(note: GranolaNote): string {
  return `granola:${note.id}:${noteUpdatedAt(note) ?? note.updated_at}`;
}

function granolaDeletionSourceEventId(noteId: string): string {
  // A deletion has no provider version; the stable key makes re-observing the
  // same deletion idempotent (ON CONFLICT DO NOTHING).
  return `granola:${noteId}:deleted`;
}

type GranolaNoteFetchFailure = "not_found" | "permanent" | "transient" | "unknown";

/**
 * Taxonomy for a failed note fetch. Order matters: network errors like
 * ENOTFOUND classify as transient BEFORE the not-found text match, and
 * 401/403 classify as permanent (credential teardown path).
 */
export function classifyGranolaNoteFetchFailure(err: unknown): GranolaNoteFetchFailure {
  const credentialClass = classifyCredentialFailure(err);
  if (credentialClass === "transient") return "transient";
  if (credentialClass === "permanent") return "permanent";
  const message = err instanceof Error ? err.message : String(err);
  if (/\(404\)/.test(message)) return "not_found";
  if (/granola/i.test(message) && /\bnot found\b|\bdoes not exist\b|\bno longer exists\b/i.test(message)) {
    return "not_found";
  }
  return "unknown";
}

type GranolaTombstoneOutcome = "tombstoned" | "already_tombstoned" | "uncaptured";

/**
 * Append a `meeting_note.deleted` tombstone for a previously captured note
 * and remove its mirror directory. Never touches prior raw rows. Returns
 * "uncaptured" (and writes nothing) when the note was never captured.
 */
export async function tombstoneGranolaMissingNote(
  userId: string,
  noteId: string,
  reason: "fetch_404" | "missing_from_list",
): Promise<GranolaTombstoneOutcome> {
  const [watermark] = await db
    .select({
      id: conversationWatermarks.id,
      conversationName: conversationWatermarks.conversationName,
      lastSeenTs: conversationWatermarks.lastSeenTs,
    })
    .from(conversationWatermarks)
    .where(and(
      eq(conversationWatermarks.userId, userId),
      eq(conversationWatermarks.provider, "granola"),
      eq(conversationWatermarks.conversationId, noteId),
    ))
    .limit(1);
  if (!watermark) return "uncaptured";

  const detectedAt = new Date();
  const times = activityEventTimes(detectedAt, detectedAt.toISOString());
  const rawPayload = redactProviderPayload("granola", {
    granolaId: noteId,
    deleted: true,
    deletionReason: reason,
    deletionDetectedAt: detectedAt.toISOString(),
    title: watermark.conversationName ?? null,
    lastSeenUpdatedAt: watermark.lastSeenTs ?? null,
  }) as Record<string, unknown>;

  const tombstoneValues = {
    userId,
    source: "granola",
    ...deriveActivityEventSourceContract({ source: "granola", eventType: "meeting_note.deleted", rawPayload }),
    eventType: "meeting_note.deleted",
    timestamp: times.timestamp,
    sourceUpdatedAt: times.sourceUpdatedAt,
    wikiEligibilityAt: times.wikiEligibilityAt,
    rawPayload,
    sourceEventId: granolaDeletionSourceEventId(noteId),
    processingStatus: "received",
    extractedEntities: null,
  };
  let [inserted] = await db
    .insert(activityEvents)
    .values(tombstoneValues)
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  // SOURCE-LANE PATCH (granola): the stable deletion key made a second deletion
  // of a restored note (re-captured after its tombstone with a newer updated_at)
  // a silent no-op that left the restored mirror in place. When the existing
  // tombstone recorded an older last-seen version than the note's current one,
  // this is a new deletion: append it keyed by the version it deleted.
  if (!inserted && watermark.lastSeenTs) {
    const [prior] = await db
      .select({ rawPayload: activityEvents.rawPayload })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.userId, userId),
        eq(activityEvents.sourceEventId, granolaDeletionSourceEventId(noteId)),
      ))
      .limit(1);
    const priorSeen = stringOrNull(objectOrNull(prior?.rawPayload)?.lastSeenUpdatedAt);
    if (prior && priorSeen !== watermark.lastSeenTs) {
      [inserted] = await db
        .insert(activityEvents)
        .values({ ...tombstoneValues, sourceEventId: `${granolaDeletionSourceEventId(noteId)}:${watermark.lastSeenTs}` })
        .onConflictDoNothing()
        .returning({ id: activityEvents.id });
    }
  }

  await db
    .update(conversationWatermarks)
    .set({ isActive: false, lastPolledAt: detectedAt })
    .where(eq(conversationWatermarks.id, watermark.id));

  if (!inserted) return "already_tombstoned";
  await enqueueCollectedEventForProcessing(inserted.id, userId);
  await deleteGranolaMeetingSourceWiki(userId, noteId);
  return "tombstoned";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayOrEmpty<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function granolaNoteFromStoredPayload(rawPayload: unknown): GranolaNote | null {
  const payload = objectOrNull(rawPayload);
  if (!payload) return null;
  const id = stringOrNull(payload.granolaId);
  const createdAt = stringOrNull(payload.createdAt);
  const updatedAt = stringOrNull(payload.updatedAt);
  if (!id || !createdAt || !updatedAt) return null;

  return {
    id,
    title: stringOrNull(payload.title),
    owner: objectOrNull(payload.owner) as GranolaPerson | null,
    created_at: createdAt,
    updated_at: updatedAt,
    web_url: stringOrNull(payload.webUrl) ?? undefined,
    calendar_event: objectOrNull(payload.calendarEvent) as GranolaNote["calendar_event"],
    attendees: arrayOrEmpty<GranolaPerson>(payload.attendees),
    folder_membership: arrayOrEmpty<NonNullable<GranolaNote["folder_membership"]>[number]>(payload.folderMembership),
    summary_text: stringOrNull(payload.summaryText),
    summary_markdown: stringOrNull(payload.summaryMarkdown),
    transcript: Array.isArray(payload.transcript) ? payload.transcript as GranolaTranscriptItem[] : null,
  };
}

function exactEmailEntities(note: GranolaNote): Array<{
  type: "email_contact";
  id: string;
  name: string;
  email: string;
}> | null {
  const people = [
    note.owner,
    ...(note.attendees ?? []),
    ...(note.calendar_event?.invitees ?? []).map((invitee) => ({ email: invitee.email ?? null })),
    note.calendar_event?.organiser ? { email: note.calendar_event.organiser } : null,
  ].filter(Boolean) as GranolaPerson[];

  const seen = new Set<string>();
  const entities = people
    .map((person) => ({
      name: person.name?.trim() || person.email?.trim() || "",
      email: person.email?.trim().toLowerCase() ?? "",
    }))
    .filter((person) => person.email.includes("@"))
    .filter((person) => {
      if (seen.has(person.email)) return false;
      seen.add(person.email);
      return true;
    })
    .map((person) => ({
      type: "email_contact" as const,
      id: person.email,
      name: person.name,
      email: person.email,
    }));

  return entities.length > 0 ? entities : null;
}

export function buildGranolaEventValues(
  userId: string,
  fetched: FetchedGranolaNote,
): typeof activityEvents.$inferInsert {
  const { note, transcriptIncluded, transcriptError } = fetched;
  const contentHash = hashGranolaNote(note);
  const times = activityEventTimes(noteEventTimestamp(note), note.updated_at);
  const rawPayload = redactProviderPayload("granola", {
    ...note,
    granolaId: note.id,
    webUrl: note.web_url ?? null,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    calendarEvent: note.calendar_event ?? null,
    folderMembership: note.folder_membership ?? [],
    summaryText: note.summary_text ?? null,
    summaryMarkdown: note.summary_markdown ?? null,
    api: {
      source: fetched.apiSource ?? "granola_public_api",
      fetchedAt: new Date().toISOString(),
      transcriptIncluded,
      transcriptError: transcriptError ?? null,
    },
    _content_hash: contentHash,
  }) as Record<string, unknown>;
  return {
    userId,
    source: "granola",
    ...deriveActivityEventSourceContract({
      source: "granola",
      eventType: "meeting_note",
      rawPayload,
      defaultRecordKind: "snapshot",
    }),
    eventType: "meeting_note",
    timestamp: times.timestamp,
    sourceUpdatedAt: times.sourceUpdatedAt,
    wikiEligibilityAt: times.wikiEligibilityAt,
    rawPayload,
    sourceEventId: granolaSourceEventId(note),
    processingStatus: "received",
    extractedEntities: exactEmailEntities(note),
  };
}

async function trackGranolaNote(userId: string, note: GranolaNote): Promise<void> {
  const [existing] = await db
    .select({ id: conversationWatermarks.id })
    .from(conversationWatermarks)
    .where(and(
      eq(conversationWatermarks.userId, userId),
      eq(conversationWatermarks.provider, "granola"),
      eq(conversationWatermarks.conversationId, note.id),
    ))
    .limit(1);

  const values = {
    conversationType: "meeting_note",
    conversationName: note.title ?? note.id,
    lastSeenTs: note.updated_at,
    lastPolledAt: new Date(),
    isActive: true,
  };

  if (existing) {
    await db
      .update(conversationWatermarks)
      .set(values)
      .where(eq(conversationWatermarks.id, existing.id));
  } else {
    await db
      .insert(conversationWatermarks)
      .values({
        userId,
        provider: "granola",
        conversationId: note.id,
        ...values,
      })
      .onConflictDoNothing();
  }
}

async function storeGranolaNoteEvent(
  userId: string,
  fetched: FetchedGranolaNote,
): Promise<"stored" | "skipped"> {
  const values = buildGranolaEventValues(userId, fetched);
  const nextPayload = values.rawPayload as Record<string, unknown>;

  const [existing] = await db
    .select({ id: activityEvents.id, rawPayload: activityEvents.rawPayload })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.userId, userId),
      eq(activityEvents.sourceEventId, values.sourceEventId),
    ))
    .limit(1);

  if (existing) {
    // SOURCE-LANE PATCH (granola): the same updated_at with different content
    // (a transcript or summary that arrived later without an updated_at bump)
    // used to be dropped as a collision. Compare the observation that is latest
    // for this updated_at (base row or a later content revision) with the new
    // one on their redacted provider content (fetch metadata excluded, key order
    // ignored); a real change is appended as an immutable content revision
    // `<source_event_id>#<sha16>`. Prior raw rows are never rewritten.
    await trackGranolaNote(userId, fetched.note);
    const latest = await latestGranolaObservation(userId, values.sourceEventId)
      ?? { ...existing, sourceEventId: values.sourceEventId };
    const latestPayload = latest.rawPayload as Record<string, unknown>;
    const nextComparable = granolaComparableHash(nextPayload);
    if (latestPayload._content_hash === nextPayload._content_hash || granolaComparableHash(latestPayload) === nextComparable) {
      await materializeGranolaMeetingSourceWiki(userId, {
        eventId: latest.id,
        sourceEventId: latest.sourceEventId,
        timestamp: values.timestamp,
        rawPayload: nextPayload,
      });
      return "skipped";
    }
    if (granolaLosesTranscript(latestPayload, fetched)) {
      // A transcript fallback (400/403 on include=transcript) must not replace a
      // captured transcript with an observation that has none.
      return "skipped";
    }
    const revision = { ...values, sourceEventId: `${values.sourceEventId}#${nextComparable.slice(0, 16)}` };
    const [insertedRevision] = await db
      .insert(activityEvents)
      .values(revision)
      .onConflictDoNothing()
      .returning({ id: activityEvents.id });
    if (!insertedRevision) return "skipped";
    await enqueueCollectedEventForProcessing(insertedRevision.id, userId);
    await materializeGranolaMeetingSourceWiki(userId, {
      eventId: insertedRevision.id,
      sourceEventId: revision.sourceEventId,
      timestamp: revision.timestamp,
      rawPayload: nextPayload,
    });
    return "stored";
  }

  const [inserted] = await db
    .insert(activityEvents)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  if (!inserted) return "skipped";
  await enqueueCollectedEventForProcessing(inserted.id, userId);
  await trackGranolaNote(userId, fetched.note);
  await materializeGranolaMeetingSourceWiki(userId, {
    eventId: inserted.id,
    sourceEventId: values.sourceEventId,
    timestamp: values.timestamp,
    rawPayload: nextPayload,
  });
  return "stored";
}

async function ingestGranolaNotes(
  userId: string,
  credential: GranolaCredential,
  opts: GranolaIngestOptions & {
    createdAfter?: string;
    updatedAfter?: string;
    cursor?: string;
    initialMaxSeenUpdatedAt?: string | null;
    onPage?: (checkpoint: GranolaPageCheckpoint) => Promise<void>;
  },
): Promise<GranolaIngestRunResult> {
  const runCredential: GranolaCredential = credential.mode === "oauth_mcp"
    ? { ...credential, mcpClient: await createGranolaMcpClient(credential.token) }
    : credential;
  const includeTranscript = opts.includeTranscript !== false;
  const maxNotes = clampMaxNotes(opts.maxNotes);
  let cursor: string | undefined = opts.cursor;
  let listed = 0;
  let processed = 0;
  let failed = 0;
  let stored = 0;
  let skipped = 0;
  let tombstoned = 0;
  let deletedUncaptured = 0;
  let newestUpdatedAt: string | null = null;
  let maxProcessedUpdatedAt = validIsoDate(opts.initialMaxSeenUpdatedAt);
  let resumeCursor: string | null = null;
  let lastPageHasMore = false;
  let capHit = false;
  const failures: GranolaNoteFailure[] = [];
  let listingTruncated = false;

  do {
    const pageSize = Number.isFinite(maxNotes)
      ? Math.min(30, Math.max(1, maxNotes - listed))
      : 30;
    const page = await listGranolaNotesWithCredential(runCredential, {
      createdAfter: opts.createdAfter,
      updatedAfter: opts.updatedAfter,
      folderId: opts.folderId,
      cursor,
      pageSize,
    });

    const noteItems: GranolaNoteWorkItem[] = [];
    const listedNotes = [...(page.notes ?? [])].sort(compareGranolaNoteListItems);
    let pageCapHit = false;
    for (const item of listedNotes) {
      if (listed >= maxNotes) {
        pageCapHit = true;
        break;
      }
      listed++;
      noteItems.push({ item, listedIndex: listed });
      const itemUpdatedAt = noteUpdatedAt(item);
      if (itemUpdatedAt && (!newestUpdatedAt || itemUpdatedAt > newestUpdatedAt)) {
        newestUpdatedAt = itemUpdatedAt;
      }
    }

    const noteResults = await mapWithConcurrency(noteItems, NOTE_CONCURRENCY, async ({ item }, index): Promise<GranolaNoteWorkResult> => {
      await sleep(RATE_LIMIT_DELAY_MS * (index % NOTE_CONCURRENCY));
      const itemUpdatedAt = noteUpdatedAt(item);
      try {
        const fetched = await fetchGranolaNoteWithCredential(runCredential, item.id, includeTranscript);
        const fullUpdatedAt = noteUpdatedAt(fetched.note) ?? itemUpdatedAt;
        const result = await storeGranolaNoteEvent(userId, fetched);
        return {
          id: item.id,
          stored: result === "stored" ? 1 : 0,
          skipped: result === "stored" ? 0 : 1,
          tombstoned: 0,
          deletedUncaptured: 0,
          updatedAt: itemUpdatedAt,
          newestUpdatedAt: fullUpdatedAt,
        };
      } catch (err) {
        const failure = classifyGranolaNoteFetchFailure(err);
        if (failure === "permanent") {
          // 401/403: credential is dead. Propagate so the task fails and the
          // existing permanent-credential-failure teardown runs.
          throw err;
        }
        if (failure === "not_found") {
          // The note vanished between listing and fetch (deleted). Tombstone
          // previously-captured notes; count never-captured ones visibly.
          const outcome = await tombstoneGranolaMissingNote(userId, item.id, "fetch_404");
          return {
            id: item.id,
            stored: 0,
            skipped: 0,
            tombstoned: outcome === "uncaptured" ? 0 : 1,
            deletedUncaptured: outcome === "uncaptured" ? 1 : 0,
            updatedAt: itemUpdatedAt,
            newestUpdatedAt: null,
          };
        }
        return {
          id: item.id,
          stored: 0,
          skipped: 0,
          tombstoned: 0,
          deletedUncaptured: 0,
          updatedAt: itemUpdatedAt,
          newestUpdatedAt: null,
          failure: err instanceof Error ? err.message : String(err),
        };
      }
    });

    const pageFailures: GranolaNoteFailure[] = [];
    for (const result of noteResults) {
      if (result.failure) {
        failed++;
        pageFailures.push({ id: result.id, error: result.failure.slice(0, 500) });
        console.warn(`[granola] note fetch failed for ${result.id}: ${result.failure}`);
        continue;
      }
      if (result.tombstoned > 0 || result.deletedUncaptured > 0) {
        tombstoned += result.tombstoned;
        deletedUncaptured += result.deletedUncaptured;
        continue;
      }
      processed++;
      stored += result.stored;
      skipped += result.skipped;
      if (result.newestUpdatedAt && (!newestUpdatedAt || result.newestUpdatedAt > newestUpdatedAt)) {
        newestUpdatedAt = result.newestUpdatedAt;
      }
      if (result.newestUpdatedAt) {
        maxProcessedUpdatedAt = maxIsoDate(maxProcessedUpdatedAt, result.newestUpdatedAt);
      }
    }

    const capHitThisPage = pageCapHit || (listed >= maxNotes && page.hasMore);
    if (capHitThisPage && page.cursor) resumeCursor = page.cursor;
    lastPageHasMore = page.hasMore || capHitThisPage;
    const nextCursor = page.hasMore && !capHitThisPage && page.cursor ? page.cursor : undefined;
    capHit ||= capHitThisPage || (page.hasMore && !nextCursor);
    if (page.hasMore && !page.cursor) listingTruncated = true;
    cursor = nextCursor;
    failures.push(...pageFailures);
    await opts.onPage?.({ nextCursor: nextCursor ?? (capHitThisPage ? page.cursor ?? null : null), listed, pageFailures });
  } while (cursor);

  return {
    listed,
    processed,
    failed,
    stored,
    skipped,
    tombstoned,
    ...(deletedUncaptured > 0 ? { skips: { deleted_uncaptured: deletedUncaptured } } : {}),
    newestUpdatedAt,
    watermarkAdvancedTo: null,
    exhausted: !lastPageHasMore && failed === 0,
    capHit,
    resumeCursor,
    maxProcessedUpdatedAt,
    failures,
    listingTruncated,
  };
}

export async function pollGranola(
  userId: string,
  opts: GranolaIngestOptions = {},
): Promise<GranolaIngestionResult> {
  const stored = await getUsableGranolaToken(userId);
  if (!stored) return emptyGranolaIngestionResult();

  const metadata = stored.metadata ?? {};
  const lastUpdatedAt = typeof metadata.lastUpdatedAt === "string" ? metadata.lastUpdatedAt : undefined;
  if (!lastUpdatedAt) {
    const baseline = new Date().toISOString();
    await mergeTokenMetadata(userId, "granola", { lastUpdatedAt: baseline });
    return { ...emptyGranolaIngestionResult(), watermarkAdvancedTo: baseline };
  }

  const resume = granolaResumeFromMetadata(metadata);
  const updatedAfter = resume?.updatedAfter ?? lastUpdatedAt;
  const folderId = opts.folderId ?? (typeof metadata.folderId === "string" ? metadata.folderId : undefined);
  const runStartedAt = new Date();
  const { result: run, credential } = await withGranolaAuthRecovery(userId, stored, (runCredential) => ingestGranolaNotes(userId, runCredential, {
    updatedAfter,
    includeTranscript: opts.includeTranscript ?? (metadata.includeTranscript !== false),
    folderId,
    maxNotes: opts.maxNotes ?? 200,
    cursor: resume?.cursor,
    initialMaxSeenUpdatedAt: resume?.maxSeenUpdatedAt,
  }));

  if (run.failed > 0) {
    await mergeTokenMetadata(userId, "granola", { granolaResume: null });
    return publicGranolaIngestionResult(run, null);
  }

  if (run.capHit && run.resumeCursor) {
    await mergeTokenMetadata(userId, "granola", {
      granolaResume: {
        cursor: run.resumeCursor,
        updatedAfter,
        maxSeenUpdatedAt: run.maxProcessedUpdatedAt,
      },
    });
    return publicGranolaIngestionResult(run, null);
  }

  if (run.capHit) {
    if (resume) await mergeTokenMetadata(userId, "granola", { granolaResume: null });
    return publicGranolaIngestionResult(run, null);
  }

  const windowStart = validIsoDate(opts.watermarkCeiling);
  const ceiling = windowStart && windowStart < runStartedAt.toISOString() ? windowStart : runStartedAt;
  const nextWatermark = clampGranolaWatermark(run.maxProcessedUpdatedAt ?? run.newestUpdatedAt, ceiling, updatedAfter);
  let watermarkAdvancedTo: string | null = null;
  if (nextWatermark) {
    await mergeTokenMetadata(userId, "granola", {
      lastUpdatedAt: nextWatermark,
      granolaResume: null,
    });
    watermarkAdvancedTo = nextWatermark;
  } else if (resume) {
    await mergeTokenMetadata(userId, "granola", { granolaResume: null });
  }

  // Only clean, fully drained runs reach here: safe point to reconcile
  // deletions against the full listing (updated_at polling never re-lists a
  // deleted note, so tombstones need this periodic sweep).
  const deletionSweep = await maybeSweepGranolaDeletions(userId, credential, metadata, { folderId });
  return {
    ...publicGranolaIngestionResult(run, watermarkAdvancedTo),
    deletionSweep,
  };
}

async function maybeSweepGranolaDeletions(
  userId: string,
  credential: GranolaCredential,
  metadata: Record<string, unknown>,
  opts: { folderId?: string },
): Promise<GranolaDeletionSweepResult | null> {
  const lastSweepAt = validIsoDate(stringOrNull(metadata.granolaDeletionSweepAt));
  const now = new Date();
  if (!lastSweepAt) {
    // Baseline on first clean poll; the sweep itself starts one interval later.
    await mergeTokenMetadata(userId, "granola", { granolaDeletionSweepAt: now.toISOString() });
    return null;
  }
  if (now.getTime() - Date.parse(lastSweepAt) < GRANOLA_DELETION_SWEEP_INTERVAL_MS) return null;

  try {
    const sweep = await sweepGranolaDeletions(userId, credential, opts);
    await mergeTokenMetadata(userId, "granola", { granolaDeletionSweepAt: new Date().toISOString() });
    return sweep;
  } catch (err) {
    if (classifyCredentialFailure(err) === "permanent") throw err;
    // Transient sweep failure must not fail an otherwise clean poll; back off
    // a full interval instead of retrying every poll tick.
    await mergeTokenMetadata(userId, "granola", { granolaDeletionSweepAt: new Date().toISOString() });
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[granola] deletion sweep failed for user ${userId}: ${message}`);
    return null;
  }
}

/**
 * Deletion reconciliation: list every note the credential can currently see
 * and confirm each tracked-but-unlisted note with a direct fetch. Only a
 * confirmed not-found produces a tombstone — a note that merely left the
 * listed scope (e.g. folder move) fetches fine and stays tracked.
 */
async function sweepGranolaDeletions(
  userId: string,
  credential: GranolaCredential,
  opts: { folderId?: string },
): Promise<GranolaDeletionSweepResult> {
  const tracked = await db
    .select({ conversationId: conversationWatermarks.conversationId })
    .from(conversationWatermarks)
    .where(and(
      eq(conversationWatermarks.userId, userId),
      eq(conversationWatermarks.provider, "granola"),
      eq(conversationWatermarks.isActive, true),
    ));

  const result: GranolaDeletionSweepResult = {
    tracked: tracked.length,
    listedPages: 0,
    listingIncomplete: false,
    missing: 0,
    tombstoned: 0,
    confirmFailed: 0,
  };
  if (tracked.length === 0) return result;

  const runCredential: GranolaCredential = credential.mode === "oauth_mcp"
    ? { ...credential, mcpClient: await createGranolaMcpClient(credential.token) }
    : credential;

  const listedIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listGranolaNotesWithCredential(runCredential, {
      folderId: opts.folderId,
      cursor,
      pageSize: 30,
    });
    result.listedPages++;
    for (const item of page.notes ?? []) listedIds.add(item.id);
    cursor = page.hasMore && page.cursor ? page.cursor : undefined;
    if (cursor && result.listedPages >= GRANOLA_DELETION_SWEEP_MAX_PAGES) {
      // Confirmation fetches keep a truncated listing safe (extra fetches,
      // never false tombstones); record the truncation visibly.
      result.listingIncomplete = true;
      cursor = undefined;
    }
    if (cursor) await sleep(RATE_LIMIT_DELAY_MS);
  } while (cursor);

  for (const row of tracked) {
    if (listedIds.has(row.conversationId)) continue;
    result.missing++;
    await sleep(RATE_LIMIT_DELAY_MS);
    try {
      await fetchGranolaNoteWithCredential(runCredential, row.conversationId, false);
      // Still fetchable: not deleted, just outside the listed scope.
    } catch (err) {
      const failure = classifyGranolaNoteFetchFailure(err);
      if (failure === "permanent") throw err;
      if (failure === "not_found") {
        const outcome = await tombstoneGranolaMissingNote(userId, row.conversationId, "missing_from_list");
        if (outcome !== "uncaptured") result.tombstoned++;
      } else {
        result.confirmFailed++;
      }
    }
  }
  return result;
}

export async function backfillGranola(
  userId: string,
  opts: GranolaBackfillOptions = {},
): Promise<GranolaIngestionResult> {
  const stored = await getUsableGranolaToken(userId);
  if (!stored) return emptyGranolaIngestionResult();

  const days = opts.days == null ? null : Math.min(Math.max(opts.days, 1), 3650);
  const createdAfter = days == null
    ? undefined
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const metadata = stored.metadata ?? {};
  const runStartedAt = new Date();

  const { result: run } = await withGranolaAuthRecovery(userId, stored, (credential) => ingestGranolaNotes(userId, credential, {
    createdAfter,
    includeTranscript: opts.includeTranscript ?? (metadata.includeTranscript !== false),
    folderId: opts.folderId ?? (typeof metadata.folderId === "string" ? metadata.folderId : undefined),
    maxNotes: opts.maxNotes,
    cursor: opts.cursor ?? undefined,
    onPage: opts.onPage,
  }));
  // SOURCE-LANE PATCH (granola): a backfill never moves an existing poll
  // watermark. Polls (serialized with it in the same task group) own the
  // watermark; advancing it to the newest note the backfill saw would skip
  // edits made to earlier-listed notes while the backfill ran, and moving it
  // back only re-lists. A missing watermark is seeded at the backfill start.
  const existingWatermark = validIsoDate(stringOrNull(metadata.lastUpdatedAt));
  const newest = run.maxProcessedUpdatedAt ?? run.newestUpdatedAt;
  if (run.failed === 0 && !run.capHit && !existingWatermark && newest) {
    const seeded = clampGranolaWatermark(newest, runStartedAt, null);
    if (seeded) {
      await mergeTokenMetadata(userId, "granola", { lastUpdatedAt: seeded });
      return publicGranolaIngestionResult(run, seeded);
    }
  }
  return publicGranolaIngestionResult(run, null);
}

function emptyGranolaIngestionResult(): GranolaIngestionResult {
  return {
    listed: 0,
    processed: 0,
    failed: 0,
    stored: 0,
    skipped: 0,
    tombstoned: 0,
    newestUpdatedAt: null,
    watermarkAdvancedTo: null,
    exhausted: true,
    capHit: false,
  };
}

function publicGranolaIngestionResult(
  result: GranolaIngestRunResult,
  watermarkAdvancedTo: string | null,
): GranolaIngestionResult {
  return {
    listed: result.listed,
    processed: result.processed,
    failed: result.failed,
    stored: result.stored,
    skipped: result.skipped,
    tombstoned: result.tombstoned,
    ...(result.skips ? { skips: result.skips } : {}),
    newestUpdatedAt: result.newestUpdatedAt,
    watermarkAdvancedTo,
    exhausted: result.exhausted,
    capHit: result.capHit,
    ...(result.failures.length > 0 ? { failures: result.failures } : {}),
    ...(result.listingTruncated ? { listingTruncated: true } : {}),
  };
}

async function getUsableGranolaToken(userId: string): Promise<StoredGranolaToken | null> {
  const stored = await getTokenFull(userId, "granola");
  if (!stored) return null;
  if (isGranolaOAuthTokenMetadata(stored.metadata) && granolaOAuthTokenExpiresSoon(stored.metadata)) {
    try {
      return await refreshGranolaOAuthToken(userId, stored);
    } catch (err) {
      if (classifyCredentialFailure(err) === "permanent") throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[granola] OAuth refresh failed for user ${userId}; skipping this poll: ${message}`);
      try {
        await mergeTokenMetadata(userId, "granola", {
          oauthRefreshError: message,
          oauthRefreshErrorAt: new Date().toISOString(),
        });
      } catch {
        // Best-effort diagnostic metadata should not turn a skipped poll into a failed job.
      }
      return null;
    }
  }
  return stored;
}

// SOURCE-LANE PATCH (granola): reactive OAuth refresh. The proactive refresh
// above only covers tokens whose expiry we know; a 401 mid-run (revoked or
// early-expired access token) refreshes once and re-runs (stores dedupe).
// Only a failed refresh or a second 401 reaches the credential teardown.
async function withGranolaAuthRecovery<T>(
  userId: string,
  stored: StoredGranolaToken,
  run: (credential: GranolaCredential) => Promise<T>,
): Promise<{ result: T; credential: GranolaCredential }> {
  const credential = granolaCredential(userId, stored);
  try {
    return { result: await run(credential), credential };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isGranolaOAuthTokenMetadata(stored.metadata) || !stored.refreshToken || !/\(401\)/.test(message)) throw err;
    const refreshed = await refreshGranolaOAuthToken(userId, stored);
    const next = granolaCredential(userId, refreshed);
    return { result: await run(next), credential: next };
  }
}

function granolaCredential(userId: string, stored: StoredGranolaToken): GranolaCredential {
  if (isGranolaOAuthTokenMetadata(stored.metadata)) {
    return {
      mode: "oauth_mcp",
      userId,
      token: stored.token,
      refreshToken: stored.refreshToken,
      metadata: stored.metadata,
    };
  }
  return { mode: "api_key", token: stored.token };
}

// SOURCE-LANE PATCH (granola): lane helpers (src/source-lane/providers/granola/lane.ts).

/** Credential identity without secrets: what Granola rate-limits and which notes it can see. */
export type GranolaCredentialIdentity = {
  authMode: "api_key" | "oauth_mcp";
  /** sha256 over the identity Granola scopes access by; never the token itself. */
  accountFingerprint: string;
  /** Account e-mail/subject from the OAuth id_token when known; never an API key. */
  accountLabel: string | null;
  folderId: string | null;
  includeTranscript: boolean;
  quotaKey: string;
};

export async function granolaCredentialIdentity(userId: string): Promise<GranolaCredentialIdentity | null> {
  const stored = await getTokenFull(userId, "granola");
  if (!stored) return null;
  const metadata = stored.metadata ?? {};
  const folderId = stringOrNull(metadata.folderId);
  const includeTranscript = metadata.includeTranscript !== false;
  if (isGranolaOAuthTokenMetadata(metadata)) {
    // Access tokens rotate on refresh; the account is the id_token subject when
    // Granola returned one, else this tenant's OAuth grant (each reconnect is a
    // new grant, so an unidentifiable reconnect gets a fresh inventory pass).
    const subject = stringOrNull(metadata.account_subject);
    const identity = subject
      ? `oauth:sub:${subject}`
      : `oauth:grant:${userId}:${stringOrNull(metadata.client_id) ?? ""}:${stringOrNull(metadata.oauth_granted_at) ?? stringOrNull(metadata.connectedAt) ?? ""}`;
    const fingerprint = createHash("sha256").update(identity).digest("hex").slice(0, 32);
    return {
      authMode: "oauth_mcp",
      accountFingerprint: fingerprint,
      accountLabel: stringOrNull(metadata.account_email) ?? (subject ? `oauth subject ${subject}` : null),
      folderId,
      includeTranscript,
      quotaKey: `granola:oauth:${fingerprint}`,
    };
  }
  const fingerprint = createHash("sha256").update(`api_key:${stored.token}`).digest("hex").slice(0, 32);
  return {
    authMode: "api_key",
    accountFingerprint: fingerprint,
    accountLabel: null,
    folderId,
    includeTranscript,
    quotaKey: `granola:api_key:${fingerprint}`,
  };
}

export type GranolaRefetchOutcome = {
  id: string;
  outcome: "stored" | "unchanged" | "tombstoned" | "deleted_uncaptured" | "failed";
  transcriptIncluded?: boolean;
  error?: string;
};

/**
 * Re-fetch specific notes by id (notes whose fetch failed in an earlier run,
 * or whose transcript was missing): the same fetch/store/tombstone taxonomy as
 * a poll. 401/403 propagate (credential teardown); 429 stops the batch.
 */
export async function refetchGranolaNotes(
  userId: string,
  noteIds: readonly string[],
  opts: { includeTranscript?: boolean } = {},
): Promise<GranolaRefetchOutcome[]> {
  const stored = await getUsableGranolaToken(userId);
  if (!stored || noteIds.length === 0) return [];
  const includeTranscript = opts.includeTranscript ?? ((stored.metadata ?? {}).includeTranscript !== false);
  const { result } = await withGranolaAuthRecovery(userId, stored, async (credential) => {
    const runCredential: GranolaCredential = credential.mode === "oauth_mcp"
      ? { ...credential, mcpClient: await createGranolaMcpClient(credential.token) }
      : credential;
    const outcomes: GranolaRefetchOutcome[] = [];
    for (const id of noteIds) {
      try {
        const fetched = await fetchGranolaNoteWithCredential(runCredential, id, includeTranscript);
        const storedAs = await storeGranolaNoteEvent(userId, fetched);
        outcomes.push({ id, outcome: storedAs === "stored" ? "stored" : "unchanged", transcriptIncluded: fetched.transcriptIncluded });
      } catch (err) {
        const failure = classifyGranolaNoteFetchFailure(err);
        if (failure === "permanent") throw err;
        if (failure === "not_found") {
          const outcome = await tombstoneGranolaMissingNote(userId, id, "fetch_404");
          outcomes.push({ id, outcome: outcome === "uncaptured" ? "deleted_uncaptured" : "tombstoned" });
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        outcomes.push({ id, outcome: "failed", error: message.slice(0, 500) });
        if (/\(429\)/.test(message)) break;
      }
      await sleep(RATE_LIMIT_DELAY_MS);
    }
    return outcomes;
  });
  return result;
}

export function resetGranolaRateGatesForTests(): void {
  granolaRateGates.clear();
}
