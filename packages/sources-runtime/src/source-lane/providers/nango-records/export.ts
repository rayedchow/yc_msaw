import { DONOR } from "../../core/donor.js";
import type { ActivityEventRow, JournalInfo, SourceFileChange } from "../../core/types.js";
import { encodeSegment, eventCapturedAt, rawEventDocument } from "../../export/mapping.js";
import { EVENT_ID_PREFIX, parseSourceEventId } from "./identity.js";
import { iso } from "./lane.js";

/**
 * sources/ files for one captured Nango record version (activity_events row of a lane source):
 *
 *   raw         sources/<source>/_raw/<namespace>/<object>/<yyyy-mm>/<source_event_id>.json
 *               The core raw ledger document (stored jsonb text spliced in, no re-encoding),
 *               one immutable file per captured version, tombstones included.
 *   projection  sources/<source>/<integration>/<connection>/<model>/<record id>.json
 *               The latest captured payload, re-indented for reading (token-preserving: numbers
 *               and strings are copied byte for byte from the stored jsonb text). Versions chain
 *               in the store's history; ordering uses Nango's last_modified_at. A deleted record
 *               becomes a tombstone (history kept); a later re-add restores it.
 *
 * Rows whose source_event_id is not a lane identity (e.g. written by older code) keep the
 * core default raw mapping (returning null).
 */

/** Re-indent JSON text without parsing values (big integers, exact float text and escapes survive). */
export function prettyJsonText(text: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  const nl = () => `\n${"  ".repeat(depth)}`;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      let k = i + 1;
      while (k < text.length && /\s/.test(text[k]!)) k += 1;
      if (text[k] === close) {
        out += ch + close;
        i = k + 1;
        continue;
      }
      depth += 1;
      out += ch + nl();
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      out += nl() + ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      out += "," + nl();
      i += 1;
      continue;
    }
    if (ch === ":") {
      out += ": ";
      i += 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s,:{}[\]"]/.test(text[j]!)) j += 1;
    out += text.slice(i, j);
    i = j;
  }
  return out;
}

export function projectionPath(source: string, id: { providerConfigKey: string; connectionId: string; model: string; recordId: string }): string {
  return ["sources", source, encodeSegment(id.providerConfigKey), encodeSegment(id.connectionId), encodeSegment(id.model), `${encodeSegment(id.recordId)}.json`].join("/");
}

export function rawPath(source: string, row: Pick<ActivityEventRow, "source_namespace" | "source_object_id" | "timestamp" | "source_event_id">): string {
  const ts = iso(row.timestamp) ?? "1970-01-01T00:00:00.000Z";
  return ["sources", source, "_raw", encodeSegment(row.source_namespace ?? "_"), encodeSegment(row.source_object_id ?? "_"), ts.slice(0, 7), `${encodeSegment(row.source_event_id)}.json`].join("/");
}

function nangoMeta(text: string): { lastModifiedAt: string | null; deletedAt: string | null; lastAction: string | null } {
  try {
    const m = (JSON.parse(text) as Record<string, unknown>)._nango_metadata as Record<string, unknown> | undefined;
    return { lastModifiedAt: iso(m?.last_modified_at), deletedAt: iso(m?.deleted_at), lastAction: typeof m?.last_action === "string" ? m.last_action : null };
  } catch {
    return { lastModifiedAt: null, deletedAt: null, lastAction: null };
  }
}

export function mapLaneEvent(source: string, row: ActivityEventRow, journal: JournalInfo): SourceFileChange[] | null {
  if (!row.source_event_id.startsWith(`${EVENT_ID_PREFIX}:`)) return null;
  const id = parseSourceEventId(row.source_event_id);
  if (!id) return null;
  const capturedAt = eventCapturedAt(row, journal);
  const raw = rawPath(source, row);
  const meta = nangoMeta(row.raw_payload_text);
  const identity = { providerConfigKey: id.providerConfigKey, connectionId: id.connectionId, model: id.model, recordId: id.recordId, version: id.version };
  const provenance = { donor: `${DONOR.repo}@${DONOR.commit}`, lane: "nango-records", table: "activity_events", activityEventId: row.id, sourceEventId: row.source_event_id, ...identity };
  const changes: SourceFileChange[] = [
    {
      op: "put",
      path: raw,
      kind: "raw",
      contentType: "application/json",
      content: rawEventDocument(row),
      sourceUpdatedAt: iso(row.source_updated_at),
      capturedAt,
      provenance: { ...provenance, recordKind: row.record_kind, eventType: row.event_type },
    },
  ];
  const projection = projectionPath(source, id);
  if (row.record_kind === "tombstone") {
    changes.push({
      op: "delete",
      path: projection,
      deletedAt: meta.deletedAt ?? iso(row.source_updated_at) ?? iso(row.timestamp) ?? capturedAt,
      reason: "nango_record_deleted",
      capturedAt,
      provenance: { ...provenance, rawPath: raw },
    });
    return changes;
  }
  const ordinal = meta.lastModifiedAt ? Date.parse(meta.lastModifiedAt) : NaN;
  changes.push({
    op: "put",
    path: projection,
    kind: "projection",
    contentType: "application/json",
    content: Buffer.from(`${prettyJsonText(row.raw_payload_text)}\n`, "utf8"),
    sourceUpdatedAt: iso(row.source_updated_at),
    capturedAt,
    sourceVersion: { ref: id.version, ...(Number.isFinite(ordinal) ? { ordinal } : {}) },
    provenance: { ...provenance, rawPath: raw, lastAction: meta.lastAction },
  });
  return changes;
}
