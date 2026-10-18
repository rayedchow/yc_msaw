import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { DONOR } from "../../core/donor.js";
import type { ExportContext, ExtraTableExport, JournalInfo, SourceFileChange } from "../../core/types.js";
import { isoOrNull, jsonDiff, queryRows } from "./google-lane.js";

/**
 * sources/calendar/accounts/<mailbox>/calendars/<calendarId>/
 *   calendar.json                          calendar-list entry + lane state (tombstoned when deleted/removed)
 *   events/<eventId>.json                  current per-mailbox snapshot (exact post-redaction raw_payload);
 *                                          tombstoned when cancelled or removed
 *   changes/<yyyy-mm>/<observedAt>--<eventId>--r<id>.json
 *                                          append-only revision ledger with raw diff vs the previous revision
 * Next to the donor's shared readable projection sources/calendar/<yyyy>/<mm>/*.md (mirror_files)
 * and raw ledger sources/calendar/_raw/ (activity_events).
 */

export const CALENDAR_ROOT = "sources/calendar";
const MAX_SEGMENT_BYTES = 200;

/** Path segment: keeps the characters Google ids use ([A-Za-z0-9_@.#-]), %-encodes the rest, hashes long values. */
export function laneSegment(value: string): string {
  let out = "";
  for (const ch of value) {
    if (/^[A-Za-z0-9._~@+=,:!$&'()*#_ -]$/u.test(ch)) out += ch;
    else out += [...Buffer.from(ch, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  }
  if (out === "") out = "%00empty";
  if (out === "." || out === "..") out = out.replace(/\./g, "%2E");
  if (out.startsWith(" ") || out.endsWith(" ")) out = out.replace(/^ | $/g, "%20");
  if (Buffer.byteLength(out, "utf8") > MAX_SEGMENT_BYTES) {
    out = `${out.slice(0, 120)}~${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
  }
  return out;
}

export function calendarDir(mailbox: string, calendarId: string): string {
  return `${CALENDAR_ROOT}/accounts/${laneSegment(mailbox)}/calendars/${laneSegment(calendarId)}`;
}

export function calendarEventPath(mailbox: string, calendarId: string, eventId: string): string {
  return `${calendarDir(mailbox, calendarId)}/events/${laneSegment(eventId)}.json`;
}

export function compactTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, "");
}

export function calendarRevisionPath(mailbox: string, calendarId: string, eventId: string, observedAt: string, revisionId: string | number): string {
  return `${calendarDir(mailbox, calendarId)}/changes/${observedAt.slice(0, 7)}/${compactTimestamp(observedAt)}--${laneSegment(eventId)}--r${revisionId}.json`;
}

export function calendarMetaPath(mailbox: string, calendarId: string): string {
  return `${calendarDir(mailbox, calendarId)}/calendar.json`;
}

const PROVENANCE = { donor: `${DONOR.repo}@${DONOR.commit}`, lane: "calendar-contacts" } as const;

/** Splices stored jsonb text verbatim (no JavaScript number re-encoding) into a JSON document. */
export function documentWithRaw(head: Record<string, unknown>, rawKey: string, rawText: string | null, tail: Record<string, unknown> = {}): Buffer {
  const parts = [JSON.stringify(head, null, 2).slice(0, -2)];
  for (const [k, v] of Object.entries(tail)) parts.push(`,\n  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, "\n  ")}`);
  parts.push(`,\n  ${JSON.stringify(rawKey)}: ${rawText ?? "null"}\n}\n`);
  return Buffer.from(parts.join(""), "utf8");
}

function deletes(paths: readonly string[], reason: string, at: string, provenance: Record<string, unknown>): SourceFileChange[] {
  return paths.map((path) => ({ op: "delete" as const, path, deletedAt: at, reason, capturedAt: at, provenance }));
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// google_calendar_event_snapshots -> events/<eventId>.json
// ---------------------------------------------------------------------------

interface SnapshotRow {
  id: string;
  delegated_email: string;
  calendar_id: string;
  event_id: string;
  ical_uid: string | null;
  recurring_event_id: string | null;
  event_type: string | null;
  status: string | null;
  summary: string | null;
  source_updated_at: string | null;
  content_hash: string;
  raw_payload_text: string;
  first_seen_at: string;
  updated_at: string;
}

export async function mapCalendarEventSnapshot(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const [row] = await queryRows<SnapshotRow>(sql`
    SELECT id::text, delegated_email, calendar_id, event_id, ical_uid, recurring_event_id, event_type, status, summary,
           source_updated_at, content_hash, raw_payload::text AS raw_payload_text, first_seen_at, updated_at
    FROM google_calendar_event_snapshots WHERE id = ${rowKey}::uuid AND user_id = ${ctx.tenantId}
  `, ctx.executor);
  if (!row) {
    const [removal] = await queryRows<{ reason: string | null; observed_at: string }>(sql`
      SELECT reason, observed_at FROM google_calendar_event_revisions
      WHERE tenant_id = ${ctx.tenantId} AND snapshot_id = ${rowKey}::uuid AND op = 'removed'
      ORDER BY id DESC LIMIT 1
    `, ctx.executor);
    const at = isoOrNull(removal?.observed_at) ?? journal.enqueuedAt;
    return deletes(previousPaths, removal?.reason ?? "snapshot_deleted", at, { ...PROVENANCE, table: "google_calendar_event_snapshots", snapshotId: rowKey });
  }
  const path = calendarEventPath(row.delegated_email, row.calendar_id, row.event_id);
  const capturedAt = isoOrNull(row.updated_at) ?? journal.enqueuedAt;
  const sourceUpdatedAt = isoOrNull(row.source_updated_at);
  const provenance = {
    ...PROVENANCE,
    table: "google_calendar_event_snapshots",
    snapshotId: row.id,
    externalId: `${row.calendar_id}:${row.event_id}`,
    mailbox: row.delegated_email,
    contentHash: row.content_hash,
  };
  const stale = previousPaths.filter((p) => p !== path);
  if (row.status === "cancelled") {
    return [
      { op: "delete", path, deletedAt: sourceUpdatedAt ?? capturedAt, reason: "cancelled", capturedAt, provenance },
      ...deletes(stale, "source_path_changed", capturedAt, provenance),
    ];
  }
  const raw = parseJson(row.raw_payload_text) as Record<string, unknown> | null;
  const updated = typeof raw?.updated === "string" ? raw.updated : null;
  const updatedMs = updated ? Date.parse(updated) : Number.NaN;
  return [
    {
      op: "put",
      path,
      kind: "raw",
      contentType: "application/json",
      content: documentWithRaw({
        schema: "procmem.google-calendar.event-snapshot/v1",
        mailbox: row.delegated_email,
        calendarId: row.calendar_id,
        eventId: row.event_id,
        iCalUID: row.ical_uid,
        recurringEventId: row.recurring_event_id,
        eventType: row.event_type,
        status: row.status,
        summary: row.summary,
        sourceUpdatedAt,
        contentHash: row.content_hash,
        firstSeenAt: isoOrNull(row.first_seen_at),
        observedAt: capturedAt,
      }, "raw_payload", row.raw_payload_text),
      sourceUpdatedAt,
      capturedAt,
      ...(updated ? { sourceVersion: Number.isFinite(updatedMs) ? { ref: updated, ordinal: updatedMs } : { ref: updated } } : {}),
      provenance,
    },
    ...deletes(stale, "source_path_changed", capturedAt, provenance),
  ];
}

// ---------------------------------------------------------------------------
// google_calendar_event_revisions -> changes/<yyyy-mm>/...json (immutable)
// ---------------------------------------------------------------------------

interface RevisionRow {
  id: string;
  snapshot_id: string;
  mailbox: string;
  calendar_id: string;
  event_id: string;
  op: "created" | "updated" | "removed";
  reason: string | null;
  status: string | null;
  content_hash: string;
  previous_content_hash: string | null;
  source_updated_at: string | null;
  raw_payload_text: string;
  observed_at: string;
}

export async function mapCalendarEventRevision(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const [row] = await queryRows<RevisionRow>(sql`
    SELECT id::text, snapshot_id::text, mailbox, calendar_id, event_id, op, reason, status, content_hash, previous_content_hash,
           source_updated_at, raw_payload::text AS raw_payload_text, observed_at
    FROM google_calendar_event_revisions WHERE id = ${rowKey}::bigint AND tenant_id = ${ctx.tenantId}
  `, ctx.executor);
  if (!row) return deletes(previousPaths, "revision_deleted", journal.enqueuedAt, { ...PROVENANCE, table: "google_calendar_event_revisions" });
  const observedAt = isoOrNull(row.observed_at) ?? journal.enqueuedAt;
  const [prev] = await queryRows<{ id: string; raw_payload_text: string }>(sql`
    SELECT id::text, raw_payload::text AS raw_payload_text FROM google_calendar_event_revisions
    WHERE tenant_id = ${ctx.tenantId} AND mailbox = ${row.mailbox} AND calendar_id = ${row.calendar_id} AND event_id = ${row.event_id}
      AND id < ${row.id}::bigint AND op <> 'removed'
    ORDER BY id DESC LIMIT 1
  `, ctx.executor);
  const removed = row.op === "removed";
  const diff = removed || !prev ? [] : jsonDiff(parseJson(prev.raw_payload_text), parseJson(row.raw_payload_text));
  return [{
    op: "put",
    path: calendarRevisionPath(row.mailbox, row.calendar_id, row.event_id, observedAt, row.id),
    kind: "raw",
    contentType: "application/json",
    content: documentWithRaw({
      schema: "procmem.google-calendar.event-revision/v1",
      revisionId: Number(row.id),
      op: row.op,
      reason: row.reason,
      mailbox: row.mailbox,
      calendarId: row.calendar_id,
      eventId: row.event_id,
      status: row.status,
      contentHash: row.content_hash,
      previousContentHash: row.previous_content_hash,
      previousRevisionId: prev ? Number(prev.id) : null,
      sourceUpdatedAt: isoOrNull(row.source_updated_at),
      observedAt,
    }, "raw_payload", removed ? null : row.raw_payload_text, { diff }),
    sourceUpdatedAt: isoOrNull(row.source_updated_at),
    capturedAt: observedAt,
    sourceVersion: { ref: `r${row.id}`, ordinal: Number(row.id) },
    provenance: { ...PROVENANCE, table: "google_calendar_event_revisions", revisionId: row.id, snapshotId: row.snapshot_id, externalId: `${row.calendar_id}:${row.event_id}` },
  }];
}

// ---------------------------------------------------------------------------
// google_calendar_lane_cursors (events rows) -> calendar.json
// ---------------------------------------------------------------------------

interface CursorRow {
  id: string;
  mailbox: string;
  resource_type: string;
  resource_key: string;
  calendar_text: string | null;
  calendar_state: string;
  updated_at: string;
}

export async function mapCalendarCursor(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const [row] = await queryRows<CursorRow>(sql`
    SELECT id::text, mailbox, resource_type, resource_key, calendar::text AS calendar_text, calendar_state, updated_at
    FROM google_calendar_lane_cursors WHERE id = ${rowKey}::uuid AND tenant_id = ${ctx.tenantId}
  `, ctx.executor);
  const provenance = { ...PROVENANCE, table: "google_calendar_lane_cursors" };
  if (!row) return deletes(previousPaths, "calendar_cursor_deleted", journal.enqueuedAt, provenance);
  if (row.resource_type !== "events") return deletes(previousPaths, "not_exported", journal.enqueuedAt, provenance);
  const path = calendarMetaPath(row.mailbox, row.resource_key);
  const capturedAt = journal.op === "INSERT" ? isoOrNull(row.updated_at) ?? journal.enqueuedAt : journal.enqueuedAt;
  if (row.calendar_state === "deleted" || row.calendar_state === "removed") {
    return deletes([path, ...previousPaths.filter((p) => p !== path)], `calendar_${row.calendar_state}`, capturedAt, { ...provenance, mailbox: row.mailbox, calendarId: row.resource_key });
  }
  return [{
    op: "put",
    path,
    kind: "raw",
    contentType: "application/json",
    content: documentWithRaw({
      schema: "procmem.google-calendar.calendar/v1",
      mailbox: row.mailbox,
      calendarId: row.resource_key,
      state: row.calendar_state,
    }, "calendar_list_entry", row.calendar_text),
    sourceUpdatedAt: null,
    capturedAt,
    provenance: { ...provenance, mailbox: row.mailbox, calendarId: row.resource_key },
  }];
}

export const calendarExtraTables: readonly ExtraTableExport[] = [
  { table: "google_calendar_event_snapshots", tenantColumn: "user_id", keyColumn: "id", map: mapCalendarEventSnapshot },
  { table: "google_calendar_event_revisions", tenantColumn: "tenant_id", keyColumn: "id", map: mapCalendarEventRevision },
  { table: "google_calendar_lane_cursors", tenantColumn: "tenant_id", keyColumn: "id", map: mapCalendarCursor },
];
