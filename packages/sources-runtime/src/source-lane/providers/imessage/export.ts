import { sql } from "drizzle-orm";
import { DONOR } from "../../core/donor.js";
import type { ActivityEventRow, ExportContext, ExtraTableExport, JournalInfo, MirrorFileRow, SourceFileChange } from "../../core/types.js";
import { encodeSegment, eventCapturedAt, rawEventDocument } from "../../export/mapping.js";
import { IMESSAGE_CONTACTS_PATH, IMESSAGE_PROJECTION_ROOT } from "./render.js";
import { query } from "./util.js";

/**
 * sources/imessage/ layout:
 *   conversations/<name>-chat-<hash>/<yyyy-mm>.md      projection (mirror_files, rendered by projector.ts)
 *   conversations/<name>-chat-<hash>/conversation.json conversation summary (mirror_files)
 *   contacts.json                                       address-book names synced by the Mac (mirror_files)
 *   _raw/<conversation>/<yyyy-mm>/<source event id>.json                 activity_events row (core raw document)
 *   _raw/<conversation>/<yyyy-mm>/_mutations/<source event id>/<at>-<id>.json  previous state before each in-place change
 *   _rejected/<yyyy-mm>/<at>-<id>.json                  uploaded entries the receiver could not store
 * Raw rows of archived duplicates (source imessage_alias) stay at their raw path with the
 * donor's archive markers; nothing is deleted from the raw ledger. A raw row whose
 * conversation was re-normalized moves, and its previous path is deleted (history kept).
 */

const PROVIDER = "imessage";
const DONOR_REF = `${DONOR.repo}@${DONOR.commit}`;
const RECEIVER_DONOR = "askshepherd/gigabrain@5448774e0a121570666adaa0c8ca18570df72be9 brain/src/routes/imessage-ingest.ts";

function iso(v: string | Date): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function conversationOf(namespace: string | null, payload: unknown): string {
  if (namespace?.startsWith("conversation:")) return namespace.slice("conversation:".length);
  const p = payload as Record<string, unknown> | null;
  const conv = p && typeof p._normalized_conversation_id === "string" ? p._normalized_conversation_id : null;
  return conv ?? namespace ?? "_";
}

export function imessageRawPath(row: Pick<ActivityEventRow, "source_namespace" | "raw_payload" | "timestamp" | "source_event_id">): string {
  return `sources/${PROVIDER}/_raw/${encodeSegment(conversationOf(row.source_namespace, row.raw_payload))}/${iso(row.timestamp).slice(0, 7)}/${encodeSegment(row.source_event_id)}.json`;
}

export function imessageMutationPath(m: { conversation: string; eventTimestamp: string | Date; sourceEventId: string; observedAt: string | Date; id: string }): string {
  const at = iso(m.observedAt).replace(/[:.]/gu, "-");
  return `sources/${PROVIDER}/_raw/${encodeSegment(m.conversation)}/${iso(m.eventTimestamp).slice(0, 7)}/_mutations/${encodeSegment(m.sourceEventId)}/${at}-${m.id.slice(0, 8)}.json`;
}

export function imessageRejectionPath(r: { receivedAt: string | Date; id: string }): string {
  const at = iso(r.receivedAt);
  return `sources/${PROVIDER}/_rejected/${at.slice(0, 7)}/${at.replace(/[:.]/gu, "-")}-${r.id.slice(0, 8)}.json`;
}

async function previousPaths(ctx: ExportContext, table: string, rowKey: string): Promise<string[]> {
  return (
    await query<{ path: string }>(ctx.executor, sql`SELECT path FROM source_lane_exported WHERE tenant_id = ${ctx.tenantId} AND table_name = ${table} AND row_key = ${rowKey}`)
  ).map((r) => r.path);
}

/** activity_events (source imessage | imessage_alias) -> raw file; deletes the previous path when the conversation moved. */
export async function mapImessageEvent(row: ActivityEventRow, ctx: ExportContext, journal: JournalInfo): Promise<SourceFileChange[]> {
  const path = imessageRawPath(row);
  const capturedAt = eventCapturedAt(row, journal);
  const changes: SourceFileChange[] = [
    {
      op: "put",
      path,
      kind: "raw",
      contentType: "application/json",
      content: rawEventDocument(row),
      sourceUpdatedAt: row.source_updated_at,
      capturedAt,
      provenance: {
        donor: DONOR_REF,
        receiver: RECEIVER_DONOR,
        table: "activity_events",
        activityEventId: row.id,
        sourceEventId: row.source_event_id,
        recordKind: row.record_kind,
        eventType: row.event_type,
        ...(row.source === "imessage_alias" ? { archivedDuplicate: true } : {}),
      },
    },
  ];
  for (const old of await previousPaths(ctx, "activity_events", row.id)) {
    if (old !== path) changes.push({ op: "delete", path: old, deletedAt: journal.enqueuedAt, reason: "imessage_conversation_renormalized", capturedAt: journal.enqueuedAt, provenance: { table: "activity_events", activityEventId: row.id, movedTo: path } });
  }
  return changes;
}

/**
 * Projection rows: the receiver's own layout exports with the core default mapping (null).
 * Anything else under sources/imessage/ is the donor month renderer's layout
 * (mirror/backfill.ts backfillImessage, reachable through the donor `mirror.backfill` task):
 * it renders reaction objects as JSON text and ignores unsends, so it is not exported.
 */
export function mapImessageMirror(path: string, _row: MirrorFileRow | null): SourceFileChange[] | null {
  if (path.startsWith(`${IMESSAGE_PROJECTION_ROOT}/`) || path === IMESSAGE_CONTACTS_PATH) return null;
  return [];
}

interface MutationRow {
  id: string;
  tenant_id: string;
  event_id: string;
  source_event_id: string;
  binding_id: string;
  kinds_text: string;
  previous_payload_text: string;
  next_payload_sha256: string;
  uploaded_text: string;
  event_timestamp: string | Date;
  observed_at: string | Date;
  conversation: string | null;
}

export const imessageMutationsTable: ExtraTableExport = {
  table: "imessage_message_mutations",
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx, rowKey, journal, previous) {
    const row = (
      await query<MutationRow>(
        ctx.executor,
        // The path depends only on immutable columns (the conversation recorded in the previous payload).
        sql`SELECT id::text AS id, tenant_id, event_id::text AS event_id, source_event_id, binding_id, kinds::text AS kinds_text,
                   previous_payload::text AS previous_payload_text, next_payload_sha256, uploaded::text AS uploaded_text, event_timestamp, observed_at,
                   'conversation:' || COALESCE(previous_payload ->> '_normalized_conversation_id', previous_payload ->> 'chatId', '_') AS conversation
            FROM imessage_message_mutations
            WHERE tenant_id = ${ctx.tenantId} AND id::text = ${rowKey}`,
      )
    )[0];
    if (!row) return previous.map((path) => ({ op: "delete" as const, path, deletedAt: journal.enqueuedAt, reason: "mutation_row_deleted", capturedAt: journal.enqueuedAt }));
    const conversation = conversationOf(row.conversation, null);
    const path = imessageMutationPath({ conversation, eventTimestamp: row.event_timestamp, sourceEventId: row.source_event_id, observedAt: row.observed_at, id: row.id });
    const head = JSON.stringify(
      {
        schema: "procmem.imessage.mutation/v1",
        id: row.id,
        activityEventId: row.event_id,
        sourceEventId: row.source_event_id,
        bindingId: row.binding_id,
        observedAt: iso(row.observed_at),
        nextPayloadSha256: row.next_payload_sha256,
      },
      null,
      2,
    ).slice(0, -2);
    const content = Buffer.from(`${head},\n  "kinds": ${row.kinds_text},\n  "previous_payload": ${row.previous_payload_text},\n  "uploaded": ${row.uploaded_text}\n}\n`, "utf8");
    const changes: SourceFileChange[] = [
      { op: "put", path, kind: "raw", contentType: "application/json", content, sourceUpdatedAt: null, capturedAt: iso(row.observed_at), provenance: { receiver: RECEIVER_DONOR, table: "imessage_message_mutations", mutationId: row.id, activityEventId: row.event_id } },
    ];
    for (const old of previous) if (old !== path) changes.push({ op: "delete", path: old, deletedAt: journal.enqueuedAt, reason: "imessage_conversation_renormalized", capturedAt: journal.enqueuedAt });
    return changes;
  },
};

interface RejectionRow {
  id: string;
  binding_id: string;
  reason: string;
  batch_index: number;
  uploaded_text: string | null;
  received_at: string | Date;
}

export const imessageRejectionsTable: ExtraTableExport = {
  table: "imessage_ingest_rejections",
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx, rowKey, journal, previous) {
    const row = (
      await query<RejectionRow>(
        ctx.executor,
        sql`SELECT id::text AS id, binding_id, reason, batch_index, uploaded::text AS uploaded_text, received_at
            FROM imessage_ingest_rejections WHERE tenant_id = ${ctx.tenantId} AND id::text = ${rowKey}`,
      )
    )[0];
    if (!row) return previous.map((path) => ({ op: "delete" as const, path, deletedAt: journal.enqueuedAt, reason: "rejection_row_deleted", capturedAt: journal.enqueuedAt }));
    const head = JSON.stringify(
      { schema: "procmem.imessage.rejected-upload/v1", id: row.id, bindingId: row.binding_id, reason: row.reason, batchIndex: row.batch_index, receivedAt: iso(row.received_at) },
      null,
      2,
    ).slice(0, -2);
    return [
      {
        op: "put",
        path: imessageRejectionPath({ receivedAt: row.received_at, id: row.id }),
        kind: "raw",
        contentType: "application/json",
        content: Buffer.from(`${head},\n  "uploaded": ${row.uploaded_text ?? "null"}\n}\n`, "utf8"),
        sourceUpdatedAt: null,
        capturedAt: iso(row.received_at),
        provenance: { receiver: RECEIVER_DONOR, table: "imessage_ingest_rejections", rejectionId: row.id },
      },
    ];
  },
};
