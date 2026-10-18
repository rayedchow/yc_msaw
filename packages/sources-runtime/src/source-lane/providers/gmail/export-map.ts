import { sql } from "drizzle-orm";
import { getBlob, historyIdOrNull, loadChunk, rowsOf } from "../../../integrations/gmail/source-store.js";
import type { ExportContext, ExtraTableExport, JournalInfo, SourceChunkedContent, SourceFileChange, SourcePutFile, SourceVersionRef } from "../../core/types.js";
import {
  attachmentContentType,
  attachmentPath,
  folderOf,
  GMAIL_PROJECTION_EXCLUDED_LABELS,
  historyPagePath,
  messagePaths,
  projectionPath,
  threadPath,
} from "./paths.js";
import { parseStoredMessage, renderMessageMarkdown, renderThreadMarkdown, type AttachmentView, type ThreadMember } from "./render.js";

/**
 * Exporters for the Gmail source tables (drizzle/9160). Each map reads the CURRENT row state
 * (tenant-scoped) and returns the complete set of files the row owns; every previously exported
 * path the row no longer produces is deleted explicitly with the Gmail reason (label move,
 * TRASH/SPAM, provider deletion), so projections never keep a stale placement.
 */

const PROVIDER = "gmail";

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function date(v: unknown): Date | null {
  const s = iso(v);
  return s ? new Date(s) : null;
}

function splitKey(rowKey: string, parts: number): string[] | null {
  // mailbox/messageId[/partRef]: the mailbox (an address) and Gmail ids never contain "/".
  const segs = rowKey.split("/");
  if (segs.length < parts) return null;
  const tail = segs.slice(segs.length - (parts - 1));
  const head = segs.slice(0, segs.length - (parts - 1)).join("/");
  return [head, ...tail];
}

function labelsOf(v: unknown): string[] {
  const arr = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").sort() : [];
}

function labelVersion(labelHistoryId: string | null): SourceVersionRef | undefined {
  if (!labelHistoryId) return undefined;
  const n = Number(labelHistoryId);
  return { ref: `gmail-history:${labelHistoryId}`, ...(Number.isSafeInteger(n) ? { ordinal: n } : {}) };
}

function deletesFor(paths: readonly string[], keep: ReadonlySet<string>, reason: string, at: string, provenance: Record<string, unknown>): SourceFileChange[] {
  return paths.filter((p) => !keep.has(p)).map((path) => ({ op: "delete" as const, path, deletedAt: at, reason, capturedAt: at, provenance }));
}

async function chunkedBlob(ctx: ExportContext, sha: string): Promise<SourceChunkedContent | null> {
  const blob = await getBlob(ctx.executor, ctx.tenantId, sha);
  if (!blob) return null;
  return {
    sha256: blob.sha256,
    size: blob.size,
    chunks: blob.chunks,
    load: (chunkSha) => loadChunk(ctx.executor, ctx.tenantId, chunkSha),
  };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ------------------------------------------------------------------ messages

interface MessageRow {
  mailbox: string;
  message_id: string;
  thread_id: string | null;
  internal_date: unknown;
  size_estimate: unknown;
  message_history_id: unknown;
  raw_json: string | null;
  raw_sha256: string | null;
  redaction_applied: boolean;
  label_ids: unknown;
  label_history_id: unknown;
  rfc822_status: string;
  rfc822_sha256: string | null;
  rfc822_size: unknown;
  deleted_at: unknown;
  deleted_history_id: unknown;
  deleted_reason: string | null;
  first_captured_at: unknown;
  updated_at: unknown;
}

interface AttachmentRow {
  part_ref: string;
  part_id: string | null;
  filename: string | null;
  mime_type: string | null;
  declared_size: unknown;
  content_id: string | null;
  disposition: string | null;
  status: string;
  sha256: string | null;
  size: unknown;
  capture: string | null;
}

async function loadAttachments(ctx: ExportContext, mailbox: string, messageId: string): Promise<AttachmentRow[]> {
  return rowsOf<AttachmentRow>(
    await ctx.executor.execute(sql`
      SELECT part_ref, part_id, filename, mime_type, declared_size, content_id, disposition, status, sha256, size, capture
      FROM gmail_source_attachments
      WHERE tenant_id = ${ctx.tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId} AND deleted_at IS NULL
      ORDER BY part_ref
    `),
  );
}

export async function mapMessageRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const key = splitKey(rowKey, 2);
  const row = key
    ? rowsOf<MessageRow>(
        await ctx.executor.execute(sql`
          SELECT mailbox, message_id, thread_id, internal_date, size_estimate, message_history_id::text AS message_history_id, raw_json, raw_sha256,
                 redaction_applied, label_ids, label_history_id::text AS label_history_id, rfc822_status, rfc822_sha256, rfc822_size,
                 deleted_at, deleted_history_id::text AS deleted_history_id, deleted_reason, first_captured_at, updated_at
          FROM gmail_source_messages
          WHERE tenant_id = ${ctx.tenantId} AND mailbox = ${key[0]} AND message_id = ${key[1]}
        `),
      )[0]
    : undefined;
  const at = journal.enqueuedAt;
  if (!row || row.raw_json === null) {
    return deletesFor(previousPaths, new Set(), row?.deleted_reason ?? "row_deleted", iso(row?.deleted_at) ?? at, { provider: PROVIDER, table: "gmail_source_messages", rowKey });
  }
  const mailbox = row.mailbox;
  const internalDate = date(row.internal_date);
  const labels = labelsOf(row.label_ids);
  const labelHistoryId = historyIdOrNull(row.label_history_id);
  const capturedAt = iso(row.updated_at) ?? at;
  const paths = messagePaths(mailbox, row.message_id, internalDate);
  const parsed = parseStoredMessage(row.raw_json);
  const attachments = await loadAttachments(ctx, mailbox, row.message_id);
  const deleted = row.deleted_at !== null;
  const excludedBy = deleted ? "deleted" : labels.find((l) => (GMAIL_PROJECTION_EXCLUDED_LABELS as readonly string[]).includes(l)) ?? null;
  const projection = deleted
    ? null
    : projectionPath(mailbox, row.message_id, { internalDate, fromEmail: parsed.fromEmail, fromName: parsed.fromName, subject: parsed.subject, labelIds: labels });
  const provenance = {
    provider: PROVIDER,
    table: "gmail_source_messages",
    mailbox,
    messageId: row.message_id,
    threadId: row.thread_id,
    messageHistoryId: historyIdOrNull(row.message_history_id),
    labelHistoryId,
  };
  const state = {
    schema: "procmem.gmail.message-state/v1",
    mailbox,
    messageId: row.message_id,
    threadId: row.thread_id,
    internalDate: internalDate?.toISOString() ?? null,
    sizeEstimate: row.size_estimate === null ? null : Number(row.size_estimate),
    labelIds: labels,
    labelHistoryId,
    folder: deleted ? null : folderOf(labels),
    projection: projection ? { path: projection } : { path: null, excludedBy },
    deleted: deleted ? { at: iso(row.deleted_at), historyId: historyIdOrNull(row.deleted_history_id), reason: row.deleted_reason } : null,
    raw: { path: deleted ? null : paths.raw, sha256: row.raw_sha256, redactionApplied: row.redaction_applied, firstCapturedAt: iso(row.first_captured_at), format: "messages.get?format=full (attachment part bytes stored separately)" },
    rfc822: { status: row.rfc822_status, path: !deleted && row.rfc822_status === "captured" ? paths.rfc822 : null, sha256: row.rfc822_sha256, size: row.rfc822_size === null ? null : Number(row.rfc822_size) },
    attachments: attachments.map((a) => ({
      partRef: a.part_ref,
      partId: a.part_id,
      filename: a.filename,
      mimeType: a.mime_type,
      declaredSize: a.declared_size === null ? null : Number(a.declared_size),
      contentId: a.content_id,
      disposition: a.disposition,
      status: a.status,
      sha256: a.sha256,
      size: a.size === null ? null : Number(a.size),
      path: !deleted && a.status === "stored" ? attachmentPath(mailbox, row.message_id, internalDate, a.part_ref, a.filename) : null,
    })),
  };
  const version = labelVersion(labelHistoryId);
  const puts: SourcePutFile[] = [
    {
      op: "put",
      path: paths.state,
      kind: "projection",
      contentType: "application/json",
      content: jsonBytes(state),
      sourceUpdatedAt: internalDate?.toISOString() ?? null,
      capturedAt,
      ...(version ? { sourceVersion: version } : {}),
      provenance: { ...provenance, file: "state" },
    },
  ];
  if (!deleted) {
    puts.push({
      op: "put",
      path: paths.raw,
      kind: "raw",
      contentType: "application/json",
      content: Buffer.from(row.raw_json, "utf8"),
      sourceUpdatedAt: internalDate?.toISOString() ?? null,
      capturedAt: iso(row.first_captured_at) ?? capturedAt,
      sourceVersion: { ref: `gmail-message:${row.message_id}@${historyIdOrNull(row.message_history_id) ?? "0"}` },
      provenance: { ...provenance, file: "raw", capture: "messages.get?format=full", redactionApplied: row.redaction_applied, rawSha256: row.raw_sha256 },
    });
    if (row.rfc822_status === "captured" && row.rfc822_sha256) {
      const chunked = await chunkedBlob(ctx, row.rfc822_sha256);
      if (!chunked) throw new Error(`gmail RFC822 blob for ${rowKey} is missing`);
      puts.push({
        op: "put",
        path: paths.rfc822,
        kind: "raw",
        contentType: "message/rfc822",
        content: Buffer.alloc(0),
        chunked,
        sourceUpdatedAt: internalDate?.toISOString() ?? null,
        capturedAt,
        sourceVersion: { ref: `gmail-message:${row.message_id}:rfc822` },
        provenance: { ...provenance, file: "rfc822", capture: "messages.get?format=raw" },
      });
    }
    if (projection) {
      const views: AttachmentView[] = attachments.map((a) => ({
        partRef: a.part_ref,
        filename: a.filename,
        mimeType: a.mime_type,
        declaredSize: a.declared_size === null ? null : Number(a.declared_size),
        status: a.status,
        size: a.size === null ? null : Number(a.size),
      }));
      puts.push({
        op: "put",
        path: projection,
        kind: "projection",
        contentType: "text/markdown; charset=utf-8",
        content: Buffer.from(renderMessageMarkdown(parsed, { mailbox, internalDate, labelIds: labels, rfc822Status: row.rfc822_status, paths: { projection, ...paths } }, views), "utf8"),
        sourceUpdatedAt: internalDate?.toISOString() ?? null,
        capturedAt,
        ...(version ? { sourceVersion: version } : {}),
        provenance: { ...provenance, file: "projection", folder: folderOf(labels), renderer: "providers/gmail/render.ts" },
      });
    }
  }
  const produced = new Set(puts.map((p) => p.path));
  const reason = deleted ? `gmail_${row.deleted_reason ?? "deleted"}` : excludedBy ? `gmail_label_${excludedBy.toLowerCase()}` : "gmail_placement_changed";
  return [...puts, ...deletesFor(previousPaths, produced, reason, deleted ? iso(row.deleted_at) ?? capturedAt : capturedAt, provenance)];
}

// ------------------------------------------------------------------ attachments

export async function mapAttachmentRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const key = splitKey(rowKey, 3);
  const row = key
    ? rowsOf<AttachmentRow & { mailbox: string; message_id: string; thread_id: string | null; internal_date: unknown; deleted_at: unknown; msg_deleted_at: unknown; captured_at: unknown; updated_at: unknown }>(
        await ctx.executor.execute(sql`
          SELECT a.mailbox, a.message_id, a.part_ref, a.part_id, a.filename, a.mime_type, a.declared_size, a.content_id, a.disposition,
                 a.status, a.sha256, a.size, a.capture, a.deleted_at, a.captured_at, a.updated_at,
                 m.thread_id, m.internal_date, m.deleted_at AS msg_deleted_at
          FROM gmail_source_attachments a
          JOIN gmail_source_messages m ON m.tenant_id = a.tenant_id AND m.mailbox = a.mailbox AND m.message_id = a.message_id
          WHERE a.tenant_id = ${ctx.tenantId} AND a.mailbox = ${key[0]} AND a.message_id = ${key[1]} AND a.part_ref = ${key[2]}
        `),
      )[0]
    : undefined;
  const at = journal.enqueuedAt;
  const base = { provider: PROVIDER, table: "gmail_source_attachments", rowKey };
  if (!row || row.deleted_at !== null || row.msg_deleted_at !== null) {
    return deletesFor(previousPaths, new Set(), "gmail_provider_deleted", iso(row?.deleted_at ?? row?.msg_deleted_at) ?? at, base);
  }
  if (row.status !== "stored" || !row.sha256) return deletesFor(previousPaths, new Set(), `gmail_attachment_${row.status}`, at, base);
  const chunked = await chunkedBlob(ctx, row.sha256);
  if (!chunked) throw new Error(`gmail attachment blob for ${rowKey} is missing`);
  const internalDate = date(row.internal_date);
  const path = attachmentPath(row.mailbox, row.message_id, internalDate, row.part_ref, row.filename);
  const put: SourcePutFile = {
    op: "put",
    path,
    kind: "binary",
    contentType: attachmentContentType(row.mime_type),
    content: Buffer.alloc(0),
    chunked,
    sourceUpdatedAt: internalDate?.toISOString() ?? null,
    capturedAt: iso(row.captured_at) ?? iso(row.updated_at) ?? at,
    sourceVersion: { ref: `gmail-attachment:${row.message_id}:${row.part_ref}` },
    provenance: {
      ...base,
      mailbox: row.mailbox,
      messageId: row.message_id,
      threadId: row.thread_id,
      partRef: row.part_ref,
      partId: row.part_id,
      filename: row.filename,
      mimeType: row.mime_type,
      declaredSize: row.declared_size === null ? null : Number(row.declared_size),
      contentId: row.content_id,
      disposition: row.disposition,
      capture: row.capture,
      sha256: row.sha256,
    },
  };
  return [put, ...deletesFor(previousPaths, new Set([path]), "gmail_placement_changed", put.capturedAt as string, base)];
}

// ------------------------------------------------------------------ threads

export async function mapThreadRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const key = splitKey(rowKey, 2);
  const at = journal.enqueuedAt;
  const base = { provider: PROVIDER, table: "gmail_source_threads", rowKey };
  if (!key) return deletesFor(previousPaths, new Set(), "row_deleted", at, base);
  const [mailbox, threadId] = key as [string, string];
  const thread = rowsOf<{ touched_at: unknown }>(
    await ctx.executor.execute(sql`SELECT touched_at FROM gmail_source_threads WHERE tenant_id = ${ctx.tenantId} AND mailbox = ${mailbox} AND thread_id = ${threadId}`),
  )[0];
  const rows = thread
    ? rowsOf<{ message_id: string; internal_date: unknown; raw_json: string; label_ids: unknown }>(
        await ctx.executor.execute(sql`
          SELECT message_id, internal_date, raw_json, label_ids FROM gmail_source_messages
          WHERE tenant_id = ${ctx.tenantId} AND mailbox = ${mailbox} AND thread_id = ${threadId} AND raw_json IS NOT NULL AND deleted_at IS NULL
          ORDER BY internal_date NULLS LAST, message_id
        `),
      )
    : [];
  if (!thread || rows.length === 0) return deletesFor(previousPaths, new Set(), "gmail_thread_empty", at, base);
  const members: ThreadMember[] = rows.map((r) => {
    const internalDate = date(r.internal_date);
    const labels = labelsOf(r.label_ids);
    const parsed = parseStoredMessage(r.raw_json);
    return {
      parsed,
      internalDate,
      labelIds: labels,
      projection: projectionPath(mailbox, r.message_id, { internalDate, fromEmail: parsed.fromEmail, fromName: parsed.fromName, subject: parsed.subject, labelIds: labels }),
      state: messagePaths(mailbox, r.message_id, internalDate).state,
    };
  });
  const path = threadPath(mailbox, threadId, members[0]!.internalDate);
  // touched_at advances on every member change (including a member's deletion), so it orders thread
  // versions; the newest member date would move backwards when that member is deleted.
  const capturedAt = iso(thread.touched_at) ?? at;
  const put: SourcePutFile = {
    op: "put",
    path,
    kind: "projection",
    contentType: "text/markdown; charset=utf-8",
    content: Buffer.from(renderThreadMarkdown(mailbox, threadId, path, members), "utf8"),
    sourceUpdatedAt: null,
    capturedAt,
    provenance: { ...base, mailbox, threadId, messageIds: rows.map((r) => r.message_id) },
  };
  return [put, ...deletesFor(previousPaths, new Set([path]), "gmail_placement_changed", capturedAt, base)];
}

// ------------------------------------------------------------------ history pages

export async function mapHistoryPageRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const at = journal.enqueuedAt;
  const base = { provider: PROVIDER, table: "gmail_source_history_pages", rowKey };
  const row = /^\d+$/.test(rowKey)
    ? rowsOf<{ mailbox: string; start_history_id: string; response_history_id: string | null; first_record_id: string | null; last_record_id: string | null; record_count: number; raw_json: string; captured_at: unknown }>(
        await ctx.executor.execute(sql`
          SELECT mailbox, start_history_id::text AS start_history_id, response_history_id::text AS response_history_id,
                 first_record_id::text AS first_record_id, last_record_id::text AS last_record_id, record_count, raw_json, captured_at
          FROM gmail_source_history_pages WHERE tenant_id = ${ctx.tenantId} AND id = ${rowKey}::bigint
        `),
      )[0]
    : undefined;
  if (!row) return deletesFor(previousPaths, new Set(), "row_deleted", at, base);
  const capturedAt = iso(row.captured_at) ?? at;
  const path = historyPagePath(row.mailbox, row.start_history_id, new Date(capturedAt));
  const put: SourcePutFile = {
    op: "put",
    path,
    kind: "raw",
    contentType: "application/json",
    content: Buffer.from(row.raw_json, "utf8"),
    sourceUpdatedAt: null,
    capturedAt,
    ...(row.last_record_id ? { sourceVersion: labelVersion(row.last_record_id)! } : {}),
    provenance: {
      ...base,
      mailbox: row.mailbox,
      capture: "history.list",
      startHistoryId: row.start_history_id,
      responseHistoryId: row.response_history_id,
      firstRecordId: row.first_record_id,
      lastRecordId: row.last_record_id,
      recordCount: Number(row.record_count),
    },
  };
  return [put, ...deletesFor(previousPaths, new Set([path]), "gmail_placement_changed", capturedAt, base)];
}

export const GMAIL_EXTRA_TABLES: readonly ExtraTableExport[] = [
  { table: "gmail_source_messages", tenantColumn: "tenant_id", keyColumn: "source_key", map: mapMessageRow },
  { table: "gmail_source_attachments", tenantColumn: "tenant_id", keyColumn: "source_key", map: mapAttachmentRow },
  { table: "gmail_source_threads", tenantColumn: "tenant_id", keyColumn: "source_key", map: mapThreadRow },
  { table: "gmail_source_history_pages", tenantColumn: "tenant_id", keyColumn: "id", map: mapHistoryPageRow },
];
