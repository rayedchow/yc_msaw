import { createHash } from "node:crypto";
import { fallbackProviderDir, type SourceProviderRegistry } from "../registry.js";
import type { ActivityEventRow, JournalInfo, MirrorFileRow, SourceFileChange } from "../core/types.js";
import { DONOR } from "../core/donor.js";

/**
 * Default mappings from the donor's durable rows to sources/ files.
 *
 *  mirror_files   -> the donor's rendered projection at its exact mirror path
 *                    (sources/<provider>/...), envelope kept as provenance.
 *  activity_events -> the raw ledger row at
 *                    sources/<provider>/_raw/<namespace|_>/<object|_>/<yyyy-mm>/<event key>.json
 *
 * Raw files embed raw_payload as PostgreSQL's own jsonb text (fetched as
 * `raw_payload::text`), so large provider integers and nested values are not
 * re-encoded through JavaScript numbers.
 */

/** Generated cross-provider navigation; MCP `ls $SOURCES` replaces it. */
export const SKIPPED_MIRROR_PATHS = new Set(["sources/index.md"]);
/** Envelopes larger than this are written as a sidecar instead of inline provenance. */
export const MAX_INLINE_ENVELOPE_BYTES = 32 * 1024;
const MAX_SEGMENT_BYTES = 200;

export type RawEventRowText = Pick<
  ActivityEventRow,
  "id" | "source" | "source_namespace" | "source_object_id" | "record_kind" | "event_type" | "timestamp" | "source_updated_at" | "source_event_id" | "created_at" | "raw_payload_text" | "extracted_entities_text"
>;

/** Path-safe, reversible-enough segment: percent-encodes '/', '%', control and other unsafe bytes; long values are hashed. */
export function encodeSegment(value: string): string {
  let out = "";
  for (const ch of value) {
    if (/^[A-Za-z0-9._~@+=,:!$&'()* -]$/u.test(ch) && ch !== "%") out += ch;
    else out += [...Buffer.from(ch, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  }
  if (out === "" ) out = "%00empty";
  if (out === "." || out === "..") out = out.replace(/\./g, "%2E");
  if (out.startsWith(" ") || out.endsWith(" ")) out = out.replace(/^ | $/g, "%20");
  if (Buffer.byteLength(out, "utf8") > MAX_SEGMENT_BYTES) {
    out = `${out.slice(0, 120)}~${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
  }
  return out;
}

export function contentTypeForMirrorPath(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function providerOfMirrorPath(path: string): string | null {
  const m = /^sources\/([^/]+)\//.exec(path);
  return m ? m[1]! : null;
}

export function rawEventDir(registry: SourceProviderRegistry, row: Pick<ActivityEventRow, "source">): string {
  return registry.forEventSource(row.source)?.id ?? fallbackProviderDir(row.source);
}

export function rawEventPath(registry: SourceProviderRegistry, row: Pick<ActivityEventRow, "source" | "source_namespace" | "source_object_id" | "timestamp" | "source_event_id">): string {
  const provider = rawEventDir(registry, row);
  const ts = iso(row.timestamp) ?? "1970-01-01T00:00:00.000Z";
  return [
    "sources",
    provider,
    "_raw",
    encodeSegment(row.source_namespace ?? "_"),
    encodeSegment(row.source_object_id ?? "_"),
    ts.slice(0, 7),
    `${encodeSegment(row.source_event_id)}.json`,
  ].join("/");
}

/** Raw ledger row as a JSON document (field order fixed; payloads spliced in as stored jsonb text). */
export function rawEventDocument(row: RawEventRowText): Buffer {
  const head = {
    schema: "aqueduct.activity_event/v1",
    id: row.id,
    source: row.source,
    source_namespace: row.source_namespace,
    source_object_id: row.source_object_id,
    record_kind: row.record_kind,
    event_type: row.event_type,
    timestamp: iso(row.timestamp),
    source_updated_at: iso(row.source_updated_at),
    source_event_id: row.source_event_id,
    created_at: iso(row.created_at),
  };
  const prefix = JSON.stringify(head, null, 2).slice(0, -2);
  return Buffer.from(`${prefix},\n  "raw_payload": ${row.raw_payload_text},\n  "extracted_entities": ${row.extracted_entities_text ?? "null"}\n}\n`, "utf8");
}

/** Inserts were observed when the row was created; in-place updates when the journal recorded them. */
export function eventCapturedAt(row: Pick<ActivityEventRow, "created_at">, journal: JournalInfo): string {
  return journal.op === "UPDATE" ? journal.enqueuedAt : iso(row.created_at) ?? journal.enqueuedAt;
}

export function defaultEventChanges(registry: SourceProviderRegistry, row: RawEventRowText, journal: JournalInfo): SourceFileChange[] {
  return [
    {
      op: "put",
      path: rawEventPath(registry, row),
      kind: "raw",
      contentType: "application/json",
      content: rawEventDocument(row),
      sourceUpdatedAt: iso(row.source_updated_at),
      capturedAt: eventCapturedAt(row, journal),
      provenance: {
        donor: `${DONOR.repo}@${DONOR.commit}`,
        table: "activity_events",
        activityEventId: row.id,
        sourceEventId: row.source_event_id,
        recordKind: row.record_kind,
        eventType: row.event_type,
      },
    },
  ];
}

/** Mirror row -> projection put; a missing row -> delete of that path (deletedAt = when the deletion was journaled). */
export function defaultMirrorChanges(path: string, row: MirrorFileRow | null, journaledAt: string): SourceFileChange[] {
  if (SKIPPED_MIRROR_PATHS.has(path)) return [];
  if (!row) {
    return [{ op: "delete", path, deletedAt: journaledAt, reason: "mirror_row_deleted", capturedAt: journaledAt, provenance: { donor: `${DONOR.repo}@${DONOR.commit}`, table: "mirror_files" } }];
  }
  const meta = row.meta ?? null;
  const metaJson = meta ? JSON.stringify(meta) : null;
  const inlineEnvelope = metaJson !== null && Buffer.byteLength(metaJson, "utf8") <= MAX_INLINE_ENVELOPE_BYTES;
  const versionRef = meta && typeof meta.versionRef === "string" && meta.versionRef ? meta.versionRef : null;
  const changes: SourceFileChange[] = [
    {
      op: "put",
      path,
      kind: "projection",
      contentType: contentTypeForMirrorPath(path),
      content: Buffer.from(row.content, "utf8"),
      sourceUpdatedAt: meta && typeof meta.sourceUpdatedAt === "string" ? meta.sourceUpdatedAt : null,
      capturedAt: row.updated_at,
      ...(versionRef ? { sourceVersion: { ref: versionRef } } : {}),
      provenance: {
        donor: `${DONOR.repo}@${DONOR.commit}`,
        table: "mirror_files",
        contentSha: row.content_sha,
        metaSha: row.meta_sha,
        ...(meta && inlineEnvelope ? { envelope: meta } : {}),
        ...(meta && !inlineEnvelope ? { envelopeSidecar: envelopeSidecarPath(path) } : {}),
      },
    },
  ];
  if (meta && !inlineEnvelope) {
    changes.push({
      op: "put",
      path: envelopeSidecarPath(path),
      kind: "projection",
      contentType: "application/json",
      content: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8"),
      sourceUpdatedAt: meta && typeof meta.sourceUpdatedAt === "string" ? meta.sourceUpdatedAt : null,
      capturedAt: row.updated_at,
      provenance: { donor: `${DONOR.repo}@${DONOR.commit}`, table: "mirror_files", envelopeOf: path, metaSha: row.meta_sha },
    });
  }
  return changes;
}

/** sources/<provider>/_meta/<rest of path>.json */
export function envelopeSidecarPath(path: string): string {
  const provider = providerOfMirrorPath(path) ?? "unknown-source";
  return `sources/${provider}/_meta/${path.slice(`sources/${provider}/`.length)}.json`;
}
