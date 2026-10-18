import { sql } from "drizzle-orm";
import { buildGenericNangoEventValues, isDeletedNangoRecord, nangoRecordId } from "../../../integrations/nango/capture.js";
import { enqueueCollectedEventForProcessing } from "../../../queue/dispatch.js";
import type { DbExecutor } from "../../core/types.js";
import type { NangoRecordsModel, NangoRecordsSource } from "./config.js";
import { contentHash, deletedAt, isPrunedRecord, lastModifiedAt, namespaceFor, objectIdFor, recordCursor, recordVersion, sourceEventIdFor } from "./identity.js";

/**
 * Capture one Nango record version into the donor raw ledger (activity_events).
 *
 * Redaction: the lane first removes credentials and pre-authenticated download URLs that
 * file/mail providers embed in records (OneDrive/SharePoint `@microsoft.graph.downloadUrl`
 * with `tempauth`, Box `download_url`, OAuth tokens, cookies, operator-listed keys), then the
 * donor's production builder (buildGenericNangoEventValues) applies the shared provider
 * redaction and computes event type, record kind (tombstone for deletes), timestamps and
 * entities. The stored raw_payload is exactly that post-redaction record; nothing about the
 * connection or tenant is written into it — identity lives in source_event_id/namespace.
 */

const CREDENTIAL = "[redacted: credential]";
const EPHEMERAL_URL = "[redacted: ephemeral authenticated URL]";

const CREDENTIAL_KEYS = new Set([
  "access_token", "accesstoken", "refresh_token", "refreshtoken", "id_token", "idtoken", "client_secret", "clientsecret",
  "password", "api_key", "apikey", "secret", "cookie", "cookies", "set-cookie", "authorization", "session_token", "x-api-key",
]);
const DOWNLOAD_URL_KEY = /(^|[@._])(download_?url|downloadurl|temporary_?link)$/iu;
const EPHEMERAL_QUERY_PARAMS = ["tempauth", "sig", "x-amz-signature", "x-goog-signature", "token", "access_token"];

function isEphemeralUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value)) return false;
  try {
    const u = new URL(value);
    return EPHEMERAL_QUERY_PARAMS.some((p) => [...u.searchParams.keys()].some((k) => k.toLowerCase() === p));
  } catch {
    return false;
  }
}

export function redactLaneSecrets(value: unknown, extraKeys: readonly string[] = [], key = ""): unknown {
  if (typeof value === "string") {
    if (key && (CREDENTIAL_KEYS.has(key.toLowerCase()) || extraKeys.includes(key))) return CREDENTIAL;
    if (key && DOWNLOAD_URL_KEY.test(key)) return EPHEMERAL_URL;
    return isEphemeralUrl(value) ? EPHEMERAL_URL : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactLaneSecrets(v, extraKeys, key));
  if (value === null || typeof value !== "object") {
    if (key && value !== null && value !== undefined && (CREDENTIAL_KEYS.has(key.toLowerCase()) || extraKeys.includes(key))) return CREDENTIAL;
    return value;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "_nango_metadata") out[k] = v;
    else if (CREDENTIAL_KEYS.has(k.toLowerCase()) || extraKeys.includes(k)) out[k] = v === null ? null : CREDENTIAL;
    else out[k] = redactLaneSecrets(v, extraKeys, k);
  }
  return { ...out };
}

export interface CaptureInput {
  tenantId: string;
  source: NangoRecordsSource;
  connectionId: string;
  model: NangoRecordsModel;
  record: Record<string, unknown>;
}

export interface CaptureResult {
  stored: boolean;
  pruned: boolean;
  deleted: boolean;
  eventId: string | null;
  sourceEventId: string | null;
  recordId: string | null;
  cursor: string | null;
  lastModifiedAt: string | null;
}

function rows<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];
}

export async function captureNangoRecord(db: DbExecutor, input: CaptureInput): Promise<CaptureResult> {
  const deleted = isDeletedNangoRecord(input.record);
  const cursor = recordCursor(input.record);
  const modified = lastModifiedAt(input.record);
  // A pruned payload is metadata only; storing it would overwrite real content with {}.
  if (isPrunedRecord(input.record) && !deleted) {
    return { stored: false, pruned: true, deleted, eventId: null, sourceEventId: null, recordId: null, cursor, lastModifiedAt: modified };
  }
  const laneRedacted = redactLaneSecrets(input.record, input.source.redactKeys) as Record<string, unknown>;
  const values = buildGenericNangoEventValues({
    tenantId: input.tenantId,
    provider: input.source.source,
    model: input.model.model,
    record: laneRedacted,
    eventType: input.model.eventType,
    ...(deleted && deletedAt(input.record) ? { sourceUpdatedAt: deletedAt(input.record) } : {}),
  });
  const recordId = nangoRecordId(values.rawPayload) ?? `hash-${contentHash(values.rawPayload).slice(0, 24)}`;
  const identity = {
    providerConfigKey: input.source.providerConfigKey,
    connectionId: input.connectionId,
    model: input.model.model,
    recordId,
    version: recordVersion(values.rawPayload),
  };
  const sourceEventId = sourceEventIdFor(identity);
  const inserted = rows<{ id: string }>(
    await db.execute(sql`
      INSERT INTO activity_events (
        user_id, source, source_namespace, source_object_id, record_kind, event_type,
        timestamp, source_updated_at, wiki_eligibility_at, raw_payload, extracted_entities,
        source_event_id, processing_status
      )
      VALUES (
        ${values.userId}, ${values.source}, ${namespaceFor(identity.providerConfigKey, identity.connectionId)},
        ${objectIdFor(identity.model, recordId)}, ${values.recordKind}, ${values.eventType},
        ${values.timestamp.toISOString()}::timestamptz,
        ${values.sourceUpdatedAt ? sql`${values.sourceUpdatedAt.toISOString()}::timestamptz` : sql`NULL`},
        ${values.wikiEligibilityAt.toISOString()}::timestamptz,
        ${JSON.stringify(values.rawPayload)}::jsonb,
        ${values.extractedEntities ? sql`${JSON.stringify(values.extractedEntities)}::jsonb` : sql`NULL`},
        ${sourceEventId}, ${values.processingStatus}
      )
      ON CONFLICT (user_id, source_event_id) DO NOTHING
      RETURNING id
    `),
  );
  const eventId = inserted[0]?.id ?? null;
  if (eventId) await enqueueCollectedEventForProcessing(eventId, input.tenantId, values.source);
  return { stored: eventId !== null, pruned: false, deleted, eventId, sourceEventId, recordId, cursor, lastModifiedAt: modified };
}
