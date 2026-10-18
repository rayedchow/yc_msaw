import { sql } from "drizzle-orm";
import { granolaMeetingSourceDirectory } from "../../../mirror/materializer.js";
import { DONOR } from "../../core/donor.js";
import type { ExportContext, ExtraTableExport, JournalInfo, SourceFileChange } from "../../core/types.js";
import type { SourceProviderRegistry } from "../../registry.js";
import { isoOrNull, rowsOf } from "./state.js";

/** uuid primary keys are compared as uuid (casting the key column to text cannot use the index). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Native catalog export (granola_source_notes, maintained from the raw ledger by
 * the 9500 trigger). Per live note, next to the donor projections
 * sources/granola/<Title>-meeting-<hash>/{summary,transcript}.md:
 *
 *  - note.json        identity, timing, calendar link, folders, people (owner,
 *                     attendees, invitees, organiser, transcript speakers exactly as
 *                     labelled) and the index of every captured revision with its raw
 *                     ledger path (sources/granola/_raw/...), deletion state.
 *  - transcript.json  the latest revision's transcript segments exactly as stored
 *                     (post-redaction jsonb: speaker objects, text, start/end times and
 *                     any other segment fields), or null when none was returned.
 *
 * Nothing is summarised or rewritten: every value is copied from the stored rows.
 * A deleted note (newest observation is a tombstone) removes both files; the raw
 * tombstone stays under _raw/ and the store keeps the files' history.
 */

export const GRANOLA_NOTES_TABLE = "granola_source_notes";
const SCHEMA = "procmem.granola.note/v1";

// rawEventPath only asks the registry for the provider directory of `granola` rows.
const GRANOLA_DIR_REGISTRY = { forEventSource: () => ({ id: "granola" }) } as unknown as SourceProviderRegistry;

interface CatalogRow {
  tenant_id: string;
  note_id: string;
  title: string | null;
  note_created_at: string | null;
  latest_updated_at: string | null;
  meeting_start: string | null;
  latest_event_id: string | null;
  latest_source_event_id: string | null;
  latest_captured_at: unknown;
  revision_count: number;
  first_captured_at: unknown;
  transcript_included: boolean | null;
  transcript_segments: number | null;
  deleted_at: unknown;
  deletion_reason: string | null;
  deletion_event_id: string | null;
}

interface LedgerRow {
  id: string;
  event_type: string;
  record_kind: string | null;
  source_namespace: string | null;
  source_object_id: string | null;
  source_event_id: string;
  timestamp: unknown;
  source_updated_at: unknown;
  created_at: unknown;
  updated_at_src: string | null;
  transcript_included: boolean | null;
  transcript_type: string | null;
  transcript_len: number | null;
  transcript_error: string | null;
  api_source: string | null;
  deletion_reason: string | null;
}

interface LatestRow {
  payload: Record<string, unknown>;
  transcript_text: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Same directory the donor materializer renders the meeting into (title as the mirror reads it). */
export function granolaNoteDirectory(noteId: string, title: string | null | undefined): string {
  return granolaMeetingSourceDirectory(noteId, text(title) ?? noteId);
}

// export/mapping.ts imports the registry, which imports this module: load it lazily (no init cycle).
let mapping: Promise<typeof import("../../export/mapping.js")> | null = null;

/** The exact path the default raw mapping exports this ledger row at. */
export async function granolaRawPathOf(row: Pick<LedgerRow, "source_namespace" | "source_object_id" | "timestamp" | "source_event_id">): Promise<string> {
  mapping ??= import("../../export/mapping.js");
  const { rawEventPath } = await mapping;
  return rawEventPath(GRANOLA_DIR_REGISTRY, {
    source: "granola",
    source_namespace: row.source_namespace,
    source_object_id: row.source_object_id,
    timestamp: isoOrNull(row.timestamp) ?? "1970-01-01T00:00:00.000Z",
    source_event_id: row.source_event_id,
  });
}

type Speaker = { source: string | null; diarization_label: string | null; name: string | null; email: string | null; segments: number; firstStart: string | null };

/** Speakers exactly as the stored segments label them (no identity resolution), with segment counts. */
export function granolaSpeakers(transcript: unknown): Speaker[] {
  if (!Array.isArray(transcript)) return [];
  const byKey = new Map<string, Speaker>();
  for (const item of transcript) {
    const segment = obj(item);
    if (!segment) continue;
    const speaker = obj(segment.speaker) ?? {};
    const entry = {
      source: text(speaker.source),
      diarization_label: text(speaker.diarization_label),
      name: text(speaker.name),
      email: text(speaker.email),
    };
    const key = JSON.stringify(entry);
    const existing = byKey.get(key);
    if (existing) existing.segments += 1;
    else byKey.set(key, { ...entry, segments: 1, firstStart: text(segment.start_time) });
  }
  return [...byKey.values()];
}

function people(payload: Record<string, unknown>): Record<string, unknown> {
  const calendar = obj(payload.calendarEvent) ?? obj(payload.calendar_event);
  return {
    owner: obj(payload.owner),
    attendees: Array.isArray(payload.attendees) ? payload.attendees : [],
    calendarInvitees: Array.isArray(calendar?.invitees) ? calendar!.invitees : [],
    calendarOrganiser: calendar?.organiser ?? calendar?.organizer ?? null,
    transcriptSpeakers: granolaSpeakers(payload.transcript),
  };
}

async function loadCatalog(ctx: ExportContext, noteId: string): Promise<CatalogRow | null> {
  return rowsOf<CatalogRow>(await ctx.executor.execute(sql`
    SELECT * FROM granola_source_notes WHERE tenant_id = ${ctx.tenantId} AND note_id = ${noteId}
  `))[0] ?? null;
}

async function loadLedger(ctx: ExportContext, noteId: string): Promise<LedgerRow[]> {
  return rowsOf<LedgerRow>(await ctx.executor.execute(sql`
    SELECT id::text AS id, event_type, record_kind, source_namespace, source_object_id, source_event_id,
           timestamp, source_updated_at, created_at,
           raw_payload ->> 'updatedAt' AS updated_at_src,
           (raw_payload -> 'api' ->> 'transcriptIncluded')::boolean AS transcript_included,
           jsonb_typeof(raw_payload -> 'transcript') AS transcript_type,
           CASE WHEN jsonb_typeof(raw_payload -> 'transcript') = 'array' THEN jsonb_array_length(raw_payload -> 'transcript') END AS transcript_len,
           raw_payload -> 'api' ->> 'transcriptError' AS transcript_error,
           raw_payload -> 'api' ->> 'source' AS api_source,
           raw_payload ->> 'deletionReason' AS deletion_reason
      FROM activity_events
     WHERE user_id = ${ctx.tenantId} AND source = 'granola' AND source_object_id = ${`meeting_note:${noteId}`}
     ORDER BY created_at, id
  `));
}

async function loadLatest(ctx: ExportContext, eventId: string): Promise<LatestRow | null> {
  const row = rowsOf<{ payload: unknown; transcript_text: string | null }>(await ctx.executor.execute(sql`
    SELECT raw_payload AS payload, (raw_payload -> 'transcript')::text AS transcript_text
      FROM activity_events WHERE user_id = ${ctx.tenantId} AND id = ${UUID_RE.test(eventId) ? eventId : null}::uuid
  `))[0];
  if (!row) return null;
  const payload = typeof row.payload === "string" ? (JSON.parse(row.payload) as Record<string, unknown>) : (obj(row.payload) ?? {});
  return { payload, transcript_text: row.transcript_text };
}

async function loadAccount(ctx: ExportContext): Promise<Record<string, unknown> | null> {
  const row = rowsOf<{ auth_mode: string | null; account_label: string | null; folder_id: string | null; include_transcript: boolean | null }>(
    await ctx.executor.execute(sql`SELECT auth_mode, account_label, folder_id, include_transcript FROM granola_source_state WHERE tenant_id = ${ctx.tenantId}`),
  )[0];
  return row ? { authMode: row.auth_mode, label: row.account_label, folderId: row.folder_id, includeTranscript: row.include_transcript } : null;
}

function revisionKind(row: LedgerRow): string {
  if (row.event_type === "meeting_note.deleted") return "deleted";
  return row.source_event_id.includes("#") ? "content_revision" : "snapshot";
}

/** note.json + transcript.json for one catalog row (exported for tests). */
export async function granolaNoteChanges(
  ctx: ExportContext,
  noteId: string,
  journal: JournalInfo,
  previousPaths: readonly string[],
): Promise<SourceFileChange[]> {
  const catalog = await loadCatalog(ctx, noteId);
  const deletes = (reason: string): SourceFileChange[] =>
    previousPaths.map((path) => ({
      op: "delete" as const,
      path,
      deletedAt: isoOrNull(catalog?.deleted_at) ?? journal.enqueuedAt,
      reason,
      capturedAt: journal.enqueuedAt,
      provenance: { donor: `${DONOR.repo}@${DONOR.commit}`, table: GRANOLA_NOTES_TABLE, noteId },
    }));
  if (!catalog) return deletes("granola_catalog_row_removed");
  if (catalog.deleted_at || !catalog.latest_event_id) return deletes(catalog.deletion_reason ? `granola_${catalog.deletion_reason}` : "granola_note_deleted");
  const latest = await loadLatest(ctx, catalog.latest_event_id);
  if (!latest) return deletes("granola_catalog_row_removed");

  const ledger = await loadLedger(ctx, noteId);
  const payload = latest.payload;
  const dir = granolaNoteDirectory(noteId, text(payload.title) ?? catalog.title);
  const latestRow = ledger.find((r) => r.id === catalog.latest_event_id);
  const api = obj(payload.api);
  const sourceUpdatedAt = isoOrNull(catalog.latest_updated_at);
  const version = { ref: catalog.latest_source_event_id ?? catalog.latest_event_id, ordinal: Number(catalog.revision_count) };
  const provenance = {
    donor: `${DONOR.repo}@${DONOR.commit}`,
    table: GRANOLA_NOTES_TABLE,
    noteId,
    activityEventId: catalog.latest_event_id,
    sourceEventId: catalog.latest_source_event_id,
  };

  const note = {
    schema: SCHEMA,
    noteId,
    title: payload.title ?? null,
    createdAt: payload.createdAt ?? null,
    updatedAt: payload.updatedAt ?? null,
    meetingStart: catalog.meeting_start,
    webUrl: payload.webUrl ?? null,
    account: await loadAccount(ctx),
    calendarEvent: payload.calendarEvent ?? null,
    folders: Array.isArray(payload.folderMembership) ? payload.folderMembership : [],
    people: people(payload),
    current: {
      activityEventId: catalog.latest_event_id,
      sourceEventId: catalog.latest_source_event_id,
      capturedAt: isoOrNull(catalog.latest_captured_at),
      raw: latestRow ? await granolaRawPathOf(latestRow) : null,
      apiSource: api?.source ?? null,
      transcriptIncluded: api?.transcriptIncluded ?? null,
      transcriptError: api?.transcriptError ?? null,
      transcriptSegments: catalog.transcript_segments,
      summary: `${dir}/summary.md`,
      transcript: `${dir}/transcript.md`,
      transcriptSegmentsFile: `${dir}/transcript.json`,
    },
    history: {
      revisions: Number(catalog.revision_count),
      firstCapturedAt: isoOrNull(catalog.first_captured_at),
      note: "Granola returns only a note's current state; revisions are the states this runtime observed (polls every 120s, deletion sweep every 6h). Edits between observations collapse.",
    },
    revisions: await Promise.all(ledger.map(async (r) => ({
      kind: revisionKind(r),
      activityEventId: r.id,
      sourceEventId: r.source_event_id,
      updatedAt: r.updated_at_src,
      capturedAt: isoOrNull(r.created_at),
      raw: await granolaRawPathOf(r),
      ...(r.event_type === "meeting_note.deleted"
        ? { deletionReason: r.deletion_reason }
        : { apiSource: r.api_source, transcriptIncluded: r.transcript_included, transcriptSegments: r.transcript_len, transcriptError: r.transcript_error }),
    }))),
  };

  const transcriptBody = latest.transcript_text && latest.transcript_text !== "null" ? latest.transcript_text : "null";
  const transcriptDoc = `{\n  "schema": "procmem.granola.transcript/v1",\n  "noteId": ${JSON.stringify(noteId)},\n  "sourceEventId": ${JSON.stringify(catalog.latest_source_event_id)},\n  "transcriptIncluded": ${JSON.stringify(api?.transcriptIncluded ?? null)},\n  "segments": ${transcriptBody}\n}\n`;

  const common = { kind: "projection" as const, sourceUpdatedAt, capturedAt: journal.enqueuedAt, sourceVersion: version, provenance };
  return [
    { op: "put", path: `${dir}/note.json`, contentType: "application/json", content: Buffer.from(`${JSON.stringify(note, null, 2)}\n`, "utf8"), ...common },
    { op: "put", path: `${dir}/transcript.json`, contentType: "application/json", content: Buffer.from(transcriptDoc, "utf8"), ...common },
  ];
}

export const GRANOLA_EXTRA_TABLES: readonly ExtraTableExport[] = [
  {
    table: GRANOLA_NOTES_TABLE,
    tenantColumn: "tenant_id",
    keyColumn: "note_id",
    map: (ctx, rowKey, journal, previousPaths) => granolaNoteChanges(ctx, rowKey, journal, previousPaths),
  },
];
