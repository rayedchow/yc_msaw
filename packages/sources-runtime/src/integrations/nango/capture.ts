import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { deriveActivityEventSourceContract, type ActivityEventRecordKind } from "../../db/activity-event-source.js";
import { activityEventTimes, validDate } from "../../lib/activity-event-time.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import type { NangoExecutor, NangoRecord } from "./types.js";

export interface GenericNangoCaptureInput {
  tenantId: string;
  provider: string;
  model: string;
  record: NangoRecord;
  eventType?: string;
  sourceEventId?: string;
  timestamp?: string | Date | null;
  sourceUpdatedAt?: string | Date | null;
  extractedEntities?: Record<string, unknown>[] | null;
}

export interface GenericNangoCaptureResult {
  stored: boolean;
  eventId: string | null;
  sourceEventId: string;
  eventType: string;
  sourceUpdatedAt: Date | null;
}

export async function processGenericNangoRecord(
  executor: NangoExecutor,
  input: GenericNangoCaptureInput,
): Promise<GenericNangoCaptureResult> {
  const values = buildGenericNangoEventValues(input);
  const rows = rowsFromExecute<{ id: string }>(await executor.execute(sql`
    INSERT INTO activity_events (
      user_id,
      source,
      source_namespace,
      source_object_id,
      record_kind,
      event_type,
      timestamp,
      source_updated_at,
      wiki_eligibility_at,
      raw_payload,
      extracted_entities,
      source_event_id,
      processing_status
    )
    VALUES (
      ${values.userId},
      ${values.source},
      ${values.sourceNamespace},
      ${values.sourceObjectId},
      ${values.recordKind},
      ${values.eventType},
      ${values.timestamp.toISOString()}::timestamptz,
      ${values.sourceUpdatedAt ? sql`${values.sourceUpdatedAt.toISOString()}::timestamptz` : sql`NULL`},
      ${values.wikiEligibilityAt.toISOString()}::timestamptz,
      ${JSON.stringify(values.rawPayload)}::jsonb,
      ${values.extractedEntities ? sql`${JSON.stringify(values.extractedEntities)}::jsonb` : sql`NULL`},
      ${values.sourceEventId},
      ${values.processingStatus}
    )
    ON CONFLICT (user_id, source_event_id) DO NOTHING
    RETURNING id
  `));

  const eventId = rows[0]?.id ?? null;
  if (eventId) {
    await enqueueCollectedEventForProcessing(eventId, input.tenantId, values.source);
  }

  return {
    stored: Boolean(eventId),
    eventId,
    sourceEventId: values.sourceEventId,
    eventType: values.eventType,
    sourceUpdatedAt: values.sourceUpdatedAt,
  };
}

export function buildGenericNangoEventValues(input: GenericNangoCaptureInput): {
  userId: string;
  source: string;
  sourceNamespace: string | null;
  sourceObjectId: string | null;
  recordKind: ActivityEventRecordKind;
  eventType: string;
  timestamp: Date;
  sourceUpdatedAt: Date | null;
  wikiEligibilityAt: Date;
  rawPayload: Record<string, unknown>;
  extractedEntities: Record<string, unknown>[] | null;
  sourceEventId: string;
  processingStatus: "collected";
} {
  const source = normalizeSource(input.provider);
  const model = normalizeModel(input.model);
  const redacted = redactProviderPayload(source, input.record) as Record<string, unknown>;
  const deleted = isDeletedNangoRecord(input.record);
  const baseEventType = input.eventType ? normalizeModel(input.eventType) : model;
  const eventType = deleted ? `${baseEventType}.deleted` : baseEventType;
  const sourceUpdatedAt = firstValidDate(input.sourceUpdatedAt) ?? sourceUpdatedAtForNangoRecord(input.record);
  const timestamp = firstValidDate(input.timestamp)
    ?? sourceUpdatedAt
    ?? firstValidDate(input.record.created_at, input.record.createdAt, input.record.created, input.record.timestamp)
    ?? new Date();
  const times = activityEventTimes(timestamp, sourceUpdatedAt);
  const recordId = nangoRecordId(input.record) ?? `hash-${contentHash(redacted).slice(0, 24)}`;
  const version = nangoRecordVersion(input.record, redacted);
  const extractedEntities = input.extractedEntities === undefined
    ? emailEntities(redacted)
    : input.extractedEntities && input.extractedEntities.length > 0
      ? input.extractedEntities
      : null;
  const sourceContract = deriveActivityEventSourceContract({
    source,
    eventType,
    rawPayload: redacted,
    defaultRecordKind: deleted ? "tombstone" : "snapshot",
  });

  return {
    userId: input.tenantId,
    source,
    ...sourceContract,
    eventType,
    timestamp: times.timestamp,
    sourceUpdatedAt: times.sourceUpdatedAt,
    wikiEligibilityAt: times.wikiEligibilityAt,
    rawPayload: redacted,
    extractedEntities,
    sourceEventId: input.sourceEventId ?? [
      "nango",
      encodeSourceEventComponent(source),
      encodeSourceEventComponent(model),
      encodeSourceEventComponent(recordId),
      encodeSourceEventComponent(version),
    ].join(":"),
    processingStatus: "collected",
  };
}

export function isDeletedNangoRecord(record: NangoRecord): boolean {
  const metadata = nangoMetadata(record);
  const lastAction = stringValue(metadata?.last_action ?? metadata?.lastAction)?.toUpperCase();
  return lastAction === "DELETED" || record.deleted === true || record._deleted === true;
}

export function nangoRecordId(record: NangoRecord): string | null {
  return stringValue(record.id)
    ?? stringValue(record.uuid)
    ?? stringValue(record.key)
    ?? stringValue(record.pageId)
    ?? stringValue(record.issueId);
}

export function nangoRecordVersion(record: NangoRecord, redactedRecord: Record<string, unknown> = record): string {
  const metadata = nangoMetadata(record);
  const explicit =
    stringValue(metadata?.cursor)
    ?? versionNumber(record)
    ?? stringValue(metadata?.updated_at)
    ?? stringValue(metadata?.updatedAt)
    ?? stringValue(metadata?.last_modified_at)
    ?? stringValue(metadata?.lastModifiedAt)
    ?? versionNumber(record)
    ?? stringValue(record.updated_at)
    ?? stringValue(record.updatedAt)
    ?? stringValue(record.modified_at)
    ?? stringValue(record.lastModified)
    ?? stringValue(record.version)
    ?? stringValue(objectValue(record.version)?.number)
    ?? stringValue(objectValue(record.version)?.when);
  return explicit ? normalizeVersion(explicit) : `sha256-${contentHash(redactedRecord)}`;
}

export function sourceUpdatedAtForNangoRecord(record: NangoRecord): Date | null {
  const metadata = nangoMetadata(record);
  return firstValidDate(
    metadata?.updated_at,
    metadata?.updatedAt,
    metadata?.last_modified_at,
    metadata?.lastModifiedAt,
    record.updated_at,
    record.updatedAt,
    record.modified_at,
    record.lastModified,
    objectValue(record.version)?.when,
  );
}

export function extractEmails(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)) {
        found.add(match[0].toLowerCase());
      }
      return;
    }
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    for (const child of Object.values(item as Record<string, unknown>)) visit(child);
  };
  visit(value);
  return [...found].sort();
}

function emailEntities(value: unknown): Array<{ type: "email_contact"; id: string; email: string }> | null {
  const emails = extractEmails(value);
  return emails.length > 0
    ? emails.map((email) => ({ type: "email_contact" as const, id: email, email }))
    : null;
}

function nangoMetadata(record: NangoRecord): Record<string, unknown> | null {
  return objectValue(record._nango_metadata) ?? objectValue(record._nangoMetadata);
}

function versionNumber(record: NangoRecord): string | null {
  const direct = record.versionNumber ?? record.version_number;
  if (typeof direct === "number" && Number.isFinite(direct)) return `v${direct}`;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim().startsWith("v") ? direct.trim() : `v${direct.trim()}`;
  }
  return null;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/\s+/gu, "_");
}

function normalizeSource(value: string): string {
  return value.trim().toLowerCase().replace(/_/gu, "-");
}

function normalizeModel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_");
}

function encodeSourceEventComponent(value: string): string {
  return value.trim();
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function firstValidDate(...values: unknown[]): Date | null {
  for (const value of values) {
    const date = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? validDate(String(value)) : null;
    if (date) return date;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
