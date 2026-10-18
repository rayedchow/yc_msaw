import { sql } from "drizzle-orm";
import { getBlob, isoOrNull, loadChunk, rowsOf, type SlackConversationRow, type SlackFileRow } from "../../../integrations/slack/source-store.js";
import type { ExportContext, ExtraTableExport, JournalInfo, SourceFileChange } from "../../core/types.js";
import { conversationLabelPath, fileBytesPath, fileMetadataPath, PROVIDER, splitSourceKey } from "./paths.js";

/**
 * Exporters for the Slack lane tables (drizzle/9400). Each map reads the CURRENT row
 * (tenant-scoped) and returns every file the row owns; a deleted Slack file becomes
 * deletes of its metadata and bytes with the Slack reason (the store keeps their history).
 */

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function capturedAt(row: { created_at?: unknown; first_captured_at?: unknown } | null, journal: JournalInfo): string {
  if (journal.op === "INSERT") return isoOrNull(row?.created_at ?? row?.first_captured_at) ?? journal.enqueuedAt;
  return journal.enqueuedAt;
}

function deletesFor(paths: readonly string[], keep: ReadonlySet<string>, reason: string, at: string, provenance: Record<string, unknown>): SourceFileChange[] {
  return paths.filter((p) => !keep.has(p)).map((path) => ({ op: "delete" as const, path, deletedAt: at, reason, capturedAt: at, provenance }));
}

function jsonArray(value: unknown): string[] {
  const v = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ------------------------------------------------------------------ conversations

export async function mapConversationRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const key = splitSourceKey(rowKey);
  const row = key
    ? rowsOf<SlackConversationRow>(await ctx.executor.execute(sql`
        SELECT * FROM slack_source_conversations WHERE tenant_id = ${ctx.tenantId} AND team_id = ${key[0]} AND channel_id = ${key[1]}
      `))[0]
    : undefined;
  const provenance = { provider: PROVIDER, table: "slack_source_conversations", rowKey };
  if (!row) return deletesFor(previousPaths, new Set(), "conversation_row_deleted", journal.enqueuedAt, provenance);
  const path = conversationLabelPath(row.team_id, row.channel_id);
  const completeAt = isoOrNull(row.history_complete_at);
  const label = {
    schema: "procmem.slack.conversation/v1",
    team_id: row.team_id,
    channel_id: row.channel_id,
    name: row.channel_name,
    type: row.channel_type,
    is_archived: row.is_archived,
    is_member: row.is_member,
    access: {
      state: row.access_state,
      reason: row.access_reason,
      note: row.access_state === "listed"
        ? "readable by the connected token"
        : "no longer readable by the connected token; previously captured messages are kept and not refreshed",
    },
    history: {
      started_at: isoOrNull(row.history_started_at),
      complete_at: completeAt,
      bound_ts: row.history_bound_ts,
      coverage: !row.history_started_at
        ? "not_started"
        : !completeAt
          ? "in_progress"
          : row.history_bound_ts
            ? "bounded_backfill"
            : "complete_from_channel_start",
    },
    projections: {
      channel_day_files: `sources/slack/${row.channel_id.replace(/[^A-Za-z0-9._-]+/gu, "-")}/<UTC day>.md`,
      raw_ledger: "sources/slack/_raw/workspace:<team>/message:<channel>:<ts>/",
    },
  };
  return [
    {
      op: "put",
      path,
      kind: "projection",
      contentType: "application/json",
      content: jsonBytes(label),
      sourceUpdatedAt: null,
      capturedAt: capturedAt(row, journal),
      provenance,
    },
    ...deletesFor(previousPaths, new Set([path]), "source_path_changed", journal.enqueuedAt, provenance),
  ];
}

// ------------------------------------------------------------------ files

export async function mapFileRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const key = splitSourceKey(rowKey);
  const row = key
    ? rowsOf<SlackFileRow>(await ctx.executor.execute(sql`
        SELECT * FROM slack_source_files WHERE tenant_id = ${ctx.tenantId} AND team_id = ${key[0]} AND file_id = ${key[1]}
      `))[0]
    : undefined;
  const provenance = { provider: PROVIDER, table: "slack_source_files", rowKey };
  if (!row) return deletesFor(previousPaths, new Set(), "file_row_deleted", journal.enqueuedAt, provenance);
  if (row.deleted_at) {
    const at = isoOrNull(row.deleted_at) ?? journal.enqueuedAt;
    return deletesFor(previousPaths, new Set(), `slack_${row.deleted_reason ?? "file_deleted"}`, at, { ...provenance, deletedReason: row.deleted_reason });
  }
  let metadata: unknown = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      metadata = null;
    }
  }
  const at = capturedAt(row, journal);
  const ordinal = row.version_ordinal === null || row.version_ordinal === undefined ? undefined : Number(row.version_ordinal);
  const metaPath = fileMetadataPath(row.team_id, row.file_id);
  const changes: SourceFileChange[] = [];
  const keep = new Set<string>([metaPath]);
  const blob = row.sha256 ? await getBlob(ctx.executor, ctx.tenantId, row.sha256) : null;
  let bytesPath: string | null = null;
  if (blob) {
    bytesPath = fileBytesPath(row.team_id, row.file_id, row.name);
    keep.add(bytesPath);
    const storedOrdinal = row.stored_version_ref ? Number(row.stored_version_ref.split(":").pop()) : Number.NaN;
    changes.push({
      op: "put",
      path: bytesPath,
      kind: "binary",
      contentType: row.mimetype || "application/octet-stream",
      content: Buffer.alloc(0),
      chunked: {
        sha256: blob.sha256,
        size: blob.size,
        chunks: blob.chunks,
        load: (chunkSha) => loadChunk(ctx.executor, ctx.tenantId, chunkSha),
      },
      sourceUpdatedAt: Number.isFinite(storedOrdinal) && storedOrdinal > 0 ? new Date(storedOrdinal * 1000).toISOString() : null,
      capturedAt: at,
      ...(row.stored_version_ref
        ? { sourceVersion: { ref: row.stored_version_ref, ...(Number.isSafeInteger(storedOrdinal) && storedOrdinal > 0 ? { ordinal: storedOrdinal } : {}) } }
        : {}),
      provenance: { ...provenance, fileId: row.file_id, sha256: blob.sha256 },
    });
  }
  const document = {
    schema: "procmem.slack.file/v1",
    team_id: row.team_id,
    file_id: row.file_id,
    name: row.name,
    title: row.title,
    mimetype: row.mimetype,
    filetype: row.filetype,
    declared_size: row.declared_size === null ? null : Number(row.declared_size),
    version_ref: row.version_ref,
    channels: jsonArray(row.channel_ids),
    messages: jsonArray(row.message_refs),
    capture: {
      status: row.status,
      reason: row.status_reason,
      last_error: row.last_error,
      next_attempt_at: isoOrNull(row.next_attempt_at),
      bytes_path: bytesPath,
      bytes_version_ref: blob ? row.stored_version_ref : null,
      sha256: blob ? blob.sha256 : null,
      size: blob ? blob.size : null,
      stale_bytes: Boolean(blob && row.stored_version_ref && row.version_ref && row.stored_version_ref !== row.version_ref),
    },
    // Post-redaction Slack file object: url_private*, thumb_* and permalink_public are removed.
    metadata,
  };
  changes.unshift({
    op: "put",
    path: metaPath,
    kind: "projection",
    contentType: "application/json",
    content: jsonBytes(document),
    sourceUpdatedAt: ordinal && ordinal > 0 ? new Date(ordinal * 1000).toISOString() : null,
    capturedAt: at,
    ...(row.version_ref ? { sourceVersion: { ref: row.version_ref, ...(ordinal && Number.isSafeInteger(ordinal) ? { ordinal } : {}) } } : {}),
    provenance: { ...provenance, fileId: row.file_id },
  });
  return [...changes, ...deletesFor(previousPaths, keep, "source_path_changed", journal.enqueuedAt, provenance)];
}

export const SLACK_EXTRA_TABLES: readonly ExtraTableExport[] = [
  { table: "slack_source_conversations", tenantColumn: "tenant_id", keyColumn: "source_key", map: mapConversationRow },
  { table: "slack_source_files", tenantColumn: "tenant_id", keyColumn: "source_key", map: mapFileRow },
];
