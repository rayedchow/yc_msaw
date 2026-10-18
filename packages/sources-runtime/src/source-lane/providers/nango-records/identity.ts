import { createHash } from "node:crypto";

/**
 * Identity of a captured Nango record version.
 *
 * Nango's records cache keeps only the latest payload per (connection, model, id). Two
 * connections of one tenant (two Outlook mailboxes, two HubSpot portals) can return the
 * same record id, so every identifier here is scoped by the exact Nango integration
 * (providerConfigKey) AND connection:
 *
 *   source_event_id  nango-records:<pck>:<connectionId>:<model>:<recordId>:<version>
 *   source_namespace nango:<pck>:<connectionId>
 *   source_object_id <model>:<recordId>
 *
 * Components are percent-encoded (encodeURIComponent) so a ':' inside an id can never
 * make two different tuples produce the same string. The version is
 * `<last_modified_at>~<sha256 of the redacted record incl. _nango_metadata>[:20]`, so a
 * repeated poll of an unchanged record maps to the same event (idempotent insert), while
 * any change — including A→B→A and a delete — yields a new version.
 */

export const EVENT_ID_PREFIX = "nango-records";

export interface RecordIdentity {
  providerConfigKey: string;
  connectionId: string;
  model: string;
  recordId: string;
  version: string;
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

export function sourceEventIdFor(id: RecordIdentity): string {
  return [EVENT_ID_PREFIX, enc(id.providerConfigKey), enc(id.connectionId), enc(id.model), enc(id.recordId), enc(id.version)].join(":");
}

/** Inverse of sourceEventIdFor; null for any other format (donor/legacy rows). */
export function parseSourceEventId(value: string): RecordIdentity | null {
  const parts = value.split(":");
  if (parts.length !== 6 || parts[0] !== EVENT_ID_PREFIX) return null;
  try {
    const [, pck, conn, model, recordId, version] = parts.map((p) => decodeURIComponent(p));
    if (!pck || !conn || !model || !recordId || !version) return null;
    return { providerConfigKey: pck, connectionId: conn, model, recordId, version };
  } catch {
    return null;
  }
}

export function namespaceFor(providerConfigKey: string, connectionId: string): string {
  return `nango:${providerConfigKey}:${connectionId}`;
}

export function objectIdFor(model: string, recordId: string): string {
  return `${model}:${recordId}`;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function nangoMetadata(record: Record<string, unknown>): Record<string, unknown> | null {
  const m = record._nango_metadata;
  return m !== null && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function lastModifiedAt(record: Record<string, unknown>): string | null {
  return isoOrNull(nangoMetadata(record)?.last_modified_at);
}

export function deletedAt(record: Record<string, unknown>): string | null {
  return isoOrNull(nangoMetadata(record)?.deleted_at);
}

export function recordCursor(record: Record<string, unknown>): string | null {
  const c = nangoMetadata(record)?.cursor;
  return typeof c === "string" && c ? c : null;
}

/** Nango prunes payloads of records not updated for 30 days: only metadata remains. */
export function isPrunedRecord(record: Record<string, unknown>): boolean {
  const p = nangoMetadata(record)?.pruned_at;
  return typeof p === "string" && p.length > 0;
}

export function recordVersion(redacted: Record<string, unknown>): string {
  const lm = lastModifiedAt(redacted);
  return `${lm ?? "unmodified"}~${contentHash(redacted).slice(0, 20)}`;
}
