import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "./source-quota.js";

/**
 * Durable Gmail source-lane state (drizzle/9160_gmail_source_lane.sql).
 * Every statement is scoped by (tenant_id, mailbox); nothing reads across tenants.
 * History ids are uint64 decimal strings, compared as SQL numeric (never JS numbers).
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return result && typeof result === "object" && "rows" in result ? ((result as { rows: T[] }).rows ?? []) : [];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Decimal history id or null (rejects anything that is not a non-negative integer string). */
export function historyIdOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^\d{1,20}$/.test(v) ? v.replace(/^0+(?=\d)/, "") : null;
}

export function compareHistoryIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ------------------------------------------------------------------ blobs

export interface StoredBlob {
  sha256: string;
  size: number;
  chunks: Array<{ sha256: string; size: number }>;
}

export async function putBlob(executor: Executor, tenantId: string, bytes: Buffer): Promise<StoredBlob> {
  const sha = sha256Hex(bytes);
  const chunks: Array<{ sha256: string; size: number }> = [];
  for (let i = 0; i < bytes.length || (i === 0 && bytes.length === 0); i += CHUNK_BYTES) {
    const part = bytes.subarray(i, i + CHUNK_BYTES);
    const chunkSha = sha256Hex(part);
    await executor.execute(sql`
      INSERT INTO gmail_source_chunks (tenant_id, chunk_sha256, size, bytes)
      VALUES (${tenantId}, ${chunkSha}, ${part.length}, ${part})
      ON CONFLICT (tenant_id, chunk_sha256) DO NOTHING
    `);
    chunks.push({ sha256: chunkSha, size: part.length });
    if (bytes.length === 0) break;
  }
  await executor.execute(sql`
    INSERT INTO gmail_source_blobs (tenant_id, sha256, size, chunks)
    VALUES (${tenantId}, ${sha}, ${bytes.length}, ${JSON.stringify(chunks)}::jsonb)
    ON CONFLICT (tenant_id, sha256) DO NOTHING
  `);
  return { sha256: sha, size: bytes.length, chunks };
}

export async function getBlob(executor: Executor, tenantId: string, sha: string): Promise<StoredBlob | null> {
  const row = rowsOf<{ sha256: string; size: unknown; chunks: unknown }>(
    await executor.execute(sql`SELECT sha256, size, chunks FROM gmail_source_blobs WHERE tenant_id = ${tenantId} AND sha256 = ${sha}`),
  )[0];
  if (!row) return null;
  const chunks = (typeof row.chunks === "string" ? JSON.parse(row.chunks) : row.chunks) as StoredBlob["chunks"];
  return { sha256: row.sha256, size: Number(row.size), chunks };
}

export async function loadChunk(executor: Executor, tenantId: string, chunkSha: string): Promise<Buffer> {
  const row = rowsOf<{ bytes: Uint8Array | Buffer }>(
    await executor.execute(sql`SELECT bytes FROM gmail_source_chunks WHERE tenant_id = ${tenantId} AND chunk_sha256 = ${chunkSha}`),
  )[0];
  if (!row) throw new Error(`gmail chunk ${chunkSha.slice(0, 12)} is missing for this tenant`);
  return Buffer.from(row.bytes);
}

// ------------------------------------------------------------------ sync state

export interface MailboxSyncState {
  tenantId: string;
  mailbox: string;
  quotaKey: string | null;
  authMode: string | null;
  generation: number;
  generationReason: string | null;
  generationStartedAt: Date | null;
  generationStartHistoryId: string | null;
  listIncludeSpamTrash: boolean | null;
  listPageToken: string | null;
  listPagesDone: number;
  listMessagesSeen: number;
  listExhaustedAt: Date | null;
  lastListProgressAt: Date | null;
  fullCompleteAt: Date | null;
  fullCompleteGeneration: number | null;
  historyId: string | null;
  historyCheckedAt: Date | null;
  historyResets: number;
  continuationSeq: number;
  blockedCode: string | null;
  blockedReason: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  errorStreak: number;
  nextAttemptAt: Date | null;
  lastSuccessAt: Date | null;
}

function stateFromRow(r: Record<string, unknown>): MailboxSyncState {
  return {
    tenantId: String(r.tenant_id),
    mailbox: String(r.mailbox),
    quotaKey: str(r.quota_key),
    authMode: str(r.auth_mode),
    generation: Number(r.generation ?? 0),
    generationReason: str(r.generation_reason),
    generationStartedAt: toDate(r.generation_started_at),
    generationStartHistoryId: historyIdOrNull(str(r.generation_start_history_id)),
    listIncludeSpamTrash: r.list_include_spam_trash === null || r.list_include_spam_trash === undefined ? null : r.list_include_spam_trash === true || r.list_include_spam_trash === "t",
    listPageToken: str(r.list_page_token),
    listPagesDone: Number(r.list_pages_done ?? 0),
    listMessagesSeen: Number(r.list_messages_seen ?? 0),
    listExhaustedAt: toDate(r.list_exhausted_at),
    lastListProgressAt: toDate(r.last_list_progress_at),
    fullCompleteAt: toDate(r.full_complete_at),
    fullCompleteGeneration: r.full_complete_generation === null || r.full_complete_generation === undefined ? null : Number(r.full_complete_generation),
    historyId: historyIdOrNull(str(r.history_id)),
    historyCheckedAt: toDate(r.history_checked_at),
    historyResets: Number(r.history_resets ?? 0),
    continuationSeq: Number(r.continuation_seq ?? 0),
    blockedCode: str(r.blocked_code),
    blockedReason: str(r.blocked_reason),
    lastError: str(r.last_error),
    lastErrorAt: toDate(r.last_error_at),
    errorStreak: Number(r.error_streak ?? 0),
    nextAttemptAt: toDate(r.next_attempt_at),
    lastSuccessAt: toDate(r.last_success_at),
  };
}

export async function getSyncState(executor: Executor, tenantId: string, mailbox: string): Promise<MailboxSyncState | null> {
  const row = rowsOf<Record<string, unknown>>(
    await executor.execute(sql`SELECT * FROM gmail_source_sync_state WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox}`),
  )[0];
  return row ? stateFromRow(row) : null;
}

export async function listSyncStates(executor: Executor, tenantId: string): Promise<MailboxSyncState[]> {
  return rowsOf<Record<string, unknown>>(
    await executor.execute(sql`SELECT * FROM gmail_source_sync_state WHERE tenant_id = ${tenantId} ORDER BY mailbox`),
  ).map(stateFromRow);
}

export async function ensureSyncState(executor: Executor, tenantId: string, mailbox: string, quotaKey: string): Promise<MailboxSyncState> {
  await executor.execute(sql`
    INSERT INTO gmail_source_sync_state (tenant_id, mailbox, quota_key)
    VALUES (${tenantId}, ${mailbox}, ${quotaKey})
    ON CONFLICT (tenant_id, mailbox) DO UPDATE SET quota_key = EXCLUDED.quota_key
      WHERE gmail_source_sync_state.quota_key IS DISTINCT FROM EXCLUDED.quota_key
  `);
  return (await getSyncState(executor, tenantId, mailbox))!;
}

/**
 * Starts a full-capture generation. The history cursor moves to the profile
 * historyId read before any listing, so every change after this point arrives
 * through history.list while the listing captures everything that existed.
 */
export async function startGeneration(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  input: { reason: "initial" | "history_expired" | "reset"; startHistoryId: string; includeSpamTrash: boolean },
): Promise<void> {
  await executor.execute(sql`
    UPDATE gmail_source_sync_state SET
      generation = generation + 1,
      generation_reason = ${input.reason},
      generation_started_at = now(),
      generation_start_history_id = ${input.startHistoryId}::numeric,
      list_include_spam_trash = ${input.includeSpamTrash},
      list_page_token = NULL,
      list_pages_done = 0,
      list_messages_seen = 0,
      list_exhausted_at = NULL,
      last_list_progress_at = now(),
      full_complete_at = NULL,
      history_id = ${input.startHistoryId}::numeric,
      history_resets = history_resets + ${input.reason === "initial" ? 0 : 1},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox}
  `);
}

export interface SyncStatePatch {
  authMode?: string | null;
  listIncludeSpamTrash?: boolean;
  listPageToken?: string | null;
  listPagesDoneIncrement?: number;
  listMessagesSeenIncrement?: number;
  listExhausted?: boolean;
  listProgress?: boolean;
  fullComplete?: boolean;
  historyId?: string;
  historyChecked?: boolean;
  blocked?: { code: string; reason: string } | null;
  error?: { message: string; backoffSeconds: number } | null;
  nextAttemptAt?: Date | null;
  success?: boolean;
  continuationSeqIncrement?: boolean;
}

export async function patchSyncState(executor: Executor, tenantId: string, mailbox: string, p: SyncStatePatch): Promise<void> {
  const sets = [sql`updated_at = now()`];
  if ("authMode" in p) sets.push(sql`auth_mode = ${p.authMode ?? null}`);
  if ("listPageToken" in p) sets.push(sql`list_page_token = ${p.listPageToken ?? null}`);
  // A generation is only as complete as its least inclusive page.
  if (p.listIncludeSpamTrash !== undefined) sets.push(sql`list_include_spam_trash = (COALESCE(list_include_spam_trash, true) AND ${p.listIncludeSpamTrash})`);
  if (p.listPagesDoneIncrement) sets.push(sql`list_pages_done = list_pages_done + ${p.listPagesDoneIncrement}`);
  if (p.listMessagesSeenIncrement) sets.push(sql`list_messages_seen = list_messages_seen + ${p.listMessagesSeenIncrement}`);
  if (p.listExhausted) sets.push(sql`list_exhausted_at = now()`);
  if (p.listProgress) sets.push(sql`last_list_progress_at = now()`);
  if (p.fullComplete) sets.push(sql`full_complete_at = now()`, sql`full_complete_generation = generation`);
  if (p.historyId !== undefined) sets.push(sql`history_id = ${p.historyId}::numeric`);
  if (p.historyChecked) sets.push(sql`history_checked_at = now()`);
  if (p.blocked !== undefined) {
    sets.push(p.blocked ? sql`blocked_code = ${p.blocked.code}, blocked_reason = ${p.blocked.reason}` : sql`blocked_code = NULL, blocked_reason = NULL`);
  }
  if (p.error !== undefined) {
    sets.push(
      p.error
        ? sql`last_error = ${p.error.message.slice(0, 500)}, last_error_at = now(), error_streak = error_streak + 1, next_attempt_at = now() + make_interval(secs => ${p.error.backoffSeconds})`
        : sql`error_streak = 0, next_attempt_at = NULL`,
    );
  }
  if ("nextAttemptAt" in p && p.error === undefined) sets.push(sql`next_attempt_at = ${p.nextAttemptAt ? p.nextAttemptAt.toISOString() : null}::timestamptz`);
  if (p.success) sets.push(sql`last_success_at = now()`);
  if (p.continuationSeqIncrement) sets.push(sql`continuation_seq = continuation_seq + 1`);
  await executor.execute(sql`UPDATE gmail_source_sync_state SET ${sql.join(sets, sql`, `)} WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox}`);
}

// ------------------------------------------------------------------ messages

export interface StoredMessageRow {
  messageId: string;
  threadId: string | null;
  internalDate: Date | null;
  messageHistoryId: string | null;
  hasRaw: boolean;
  labelIds: string[];
  labelHistoryId: string | null;
  observedHistoryId: string | null;
  rfc822Status: string;
  seenGeneration: number;
  deletedAt: Date | null;
  deletedHistoryId: string | null;
  deletedReason: string | null;
}

function labelsOf(v: unknown): string[] {
  const arr = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
}

function messageFromRow(r: Record<string, unknown>): StoredMessageRow {
  return {
    messageId: String(r.message_id),
    threadId: str(r.thread_id),
    internalDate: toDate(r.internal_date),
    messageHistoryId: historyIdOrNull(str(r.message_history_id)),
    hasRaw: r.has_raw === true || r.has_raw === "t",
    labelIds: labelsOf(r.label_ids),
    labelHistoryId: historyIdOrNull(str(r.label_history_id)),
    observedHistoryId: historyIdOrNull(str(r.observed_history_id)),
    rfc822Status: String(r.rfc822_status),
    seenGeneration: Number(r.seen_generation ?? 0),
    deletedAt: toDate(r.deleted_at),
    deletedHistoryId: historyIdOrNull(str(r.deleted_history_id)),
    deletedReason: str(r.deleted_reason),
  };
}

const MESSAGE_COLUMNS = sql`message_id, thread_id, internal_date, message_history_id, raw_json IS NOT NULL AS has_raw, label_ids,
  label_history_id, observed_history_id, rfc822_status, seen_generation, deleted_at, deleted_history_id, deleted_reason`;

export async function getMessageRow(executor: Executor, tenantId: string, mailbox: string, messageId: string): Promise<StoredMessageRow | null> {
  const row = rowsOf<Record<string, unknown>>(
    await executor.execute(sql`SELECT ${MESSAGE_COLUMNS} FROM gmail_source_messages WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}`),
  )[0];
  return row ? messageFromRow(row) : null;
}

export async function getMessageRows(executor: Executor, tenantId: string, mailbox: string, messageIds: readonly string[]): Promise<Map<string, StoredMessageRow>> {
  const out = new Map<string, StoredMessageRow>();
  if (messageIds.length === 0) return out;
  const rows = rowsOf<Record<string, unknown>>(
    await executor.execute(sql`
      SELECT ${MESSAGE_COLUMNS} FROM gmail_source_messages
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id IN (${sql.join(messageIds.map((id) => sql`${id}`), sql`, `)})
    `),
  );
  for (const r of rows) out.set(String(r.message_id), messageFromRow(r));
  return out;
}

export interface FetchedMessageInput {
  messageId: string;
  threadId: string | null;
  internalDate: Date | null;
  sizeEstimate: number | null;
  historyId: string;
  rawJson: string;
  redactionApplied: boolean;
  labelIds: string[];
  rfc822Status: "pending" | "disabled" | "oversize" | "withheld_redaction";
  seenGeneration: number;
}

/**
 * Stores a messages.get(format=full) observation. The first raw capture is kept
 * (messages are immutable); labels are taken only when this observation is newer
 * (higher historyId) than the stored label state; a provider deletion that is at
 * least as new as this observation is never undone.
 * Returns whether the raw payload was captured by this call and whether the row is (still) deleted.
 */
export async function upsertFetchedMessage(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  m: FetchedMessageInput,
): Promise<{ capturedRaw: boolean; deleted: boolean }> {
  const before = await getMessageRow(executor, tenantId, mailbox, m.messageId);
  const labels = JSON.stringify([...new Set(m.labelIds)].sort());
  const row = rowsOf<{ deleted_at: unknown }>(
    await executor.execute(sql`
      INSERT INTO gmail_source_messages AS g (
        tenant_id, mailbox, message_id, thread_id, internal_date, size_estimate, message_history_id,
        raw_json, raw_sha256, redaction_applied, label_ids, label_history_id, observed_history_id,
        rfc822_status, seen_generation, first_captured_at, updated_at
      ) VALUES (
        ${tenantId}, ${mailbox}, ${m.messageId}, ${m.threadId}, ${m.internalDate ? m.internalDate.toISOString() : null}::timestamptz,
        ${m.sizeEstimate}, ${m.historyId}::numeric, ${m.rawJson}, ${sha256Hex(m.rawJson)}, ${m.redactionApplied},
        ${labels}::jsonb, ${m.historyId}::numeric, ${m.historyId}::numeric, ${m.rfc822Status}, ${m.seenGeneration}, now(), now()
      )
      ON CONFLICT (tenant_id, mailbox, message_id) DO UPDATE SET
        thread_id = COALESCE(g.thread_id, EXCLUDED.thread_id),
        internal_date = COALESCE(g.internal_date, EXCLUDED.internal_date),
        size_estimate = COALESCE(g.size_estimate, EXCLUDED.size_estimate),
        message_history_id = COALESCE(g.message_history_id, EXCLUDED.message_history_id),
        redaction_applied = CASE WHEN g.raw_json IS NULL THEN EXCLUDED.redaction_applied ELSE g.redaction_applied END,
        rfc822_status = CASE WHEN g.raw_json IS NULL THEN EXCLUDED.rfc822_status ELSE g.rfc822_status END,
        raw_sha256 = COALESCE(g.raw_sha256, EXCLUDED.raw_sha256),
        raw_json = COALESCE(g.raw_json, EXCLUDED.raw_json),
        label_ids = CASE WHEN g.label_history_id IS NULL OR EXCLUDED.label_history_id > g.label_history_id THEN EXCLUDED.label_ids ELSE g.label_ids END,
        label_history_id = GREATEST(g.label_history_id, EXCLUDED.label_history_id),
        observed_history_id = GREATEST(g.observed_history_id, EXCLUDED.observed_history_id),
        seen_generation = GREATEST(g.seen_generation, EXCLUDED.seen_generation),
        deleted_at = CASE WHEN g.deleted_reason = 'provider_deleted' AND (g.deleted_history_id IS NULL OR g.deleted_history_id >= EXCLUDED.message_history_id) THEN g.deleted_at ELSE NULL END,
        deleted_history_id = CASE WHEN g.deleted_reason = 'provider_deleted' AND (g.deleted_history_id IS NULL OR g.deleted_history_id >= EXCLUDED.message_history_id) THEN g.deleted_history_id ELSE NULL END,
        deleted_reason = CASE WHEN g.deleted_reason = 'provider_deleted' AND (g.deleted_history_id IS NULL OR g.deleted_history_id >= EXCLUDED.message_history_id) THEN g.deleted_reason ELSE NULL END,
        updated_at = now()
      RETURNING deleted_at
    `),
  )[0];
  const deleted = toDate(row?.deleted_at) !== null;
  return { capturedRaw: !deleted && !(before?.hasRaw ?? false), deleted };
}

/**
 * Applies a history label change (record id `recordId`). Ignored when the stored label
 * state is already at least as new (out-of-order or replayed history), or the message
 * is unknown/deleted (the caller fetches unknown messages).
 */
export async function applyLabelChange(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  messageId: string,
  recordId: string,
  change: { add?: readonly string[]; remove?: readonly string[]; set?: readonly string[] },
): Promise<"applied" | "stale" | "unknown" | "deleted"> {
  const row = await getMessageRow(executor, tenantId, mailbox, messageId);
  if (!row || !row.hasRaw) return row?.deletedAt ? "deleted" : "unknown";
  if (row.deletedAt) return "deleted";
  if (row.labelHistoryId && compareHistoryIds(recordId, row.labelHistoryId) <= 0) return "stale";
  let next: string[];
  if (change.set) next = [...change.set];
  else {
    const set = new Set(row.labelIds);
    for (const l of change.add ?? []) set.add(l);
    for (const l of change.remove ?? []) set.delete(l);
    next = [...set];
  }
  const labels = JSON.stringify([...new Set(next)].sort());
  const updated = rowsOf<{ message_id: string }>(
    await executor.execute(sql`
      UPDATE gmail_source_messages SET
        label_ids = ${labels}::jsonb,
        label_history_id = ${recordId}::numeric,
        observed_history_id = GREATEST(observed_history_id, ${recordId}::numeric),
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}
        AND (label_history_id IS NULL OR label_history_id < ${recordId}::numeric) AND deleted_at IS NULL
      RETURNING message_id
    `),
  );
  return updated.length ? "applied" : "stale";
}

/**
 * Records a deletion. Unknown messages get a payload-less tombstone row so a stale
 * fetch that lands later (lower historyId) cannot resurrect them.
 */
export async function markMessageDeleted(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  messageId: string,
  input: { historyId: string | null; reason: "provider_deleted" | "absent_from_listing" },
): Promise<{ newlyDeleted: boolean; threadId: string | null }> {
  const before = await getMessageRow(executor, tenantId, mailbox, messageId);
  if (before?.deletedAt && (before.deletedReason === "provider_deleted" || input.reason === "absent_from_listing")) {
    return { newlyDeleted: false, threadId: before.threadId };
  }
  await executor.execute(sql`
    INSERT INTO gmail_source_messages AS g (tenant_id, mailbox, message_id, deleted_at, deleted_history_id, deleted_reason, observed_history_id, rfc822_status)
    VALUES (${tenantId}, ${mailbox}, ${messageId}, now(), ${input.historyId}::numeric, ${input.reason}, ${input.historyId}::numeric, 'unavailable')
    ON CONFLICT (tenant_id, mailbox, message_id) DO UPDATE SET
      deleted_at = COALESCE(g.deleted_at, now()),
      deleted_history_id = COALESCE(EXCLUDED.deleted_history_id, g.deleted_history_id),
      deleted_reason = EXCLUDED.deleted_reason,
      observed_history_id = GREATEST(g.observed_history_id, EXCLUDED.observed_history_id),
      updated_at = now()
  `);
  await executor.execute(sql`
    UPDATE gmail_source_attachments SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId} AND deleted_at IS NULL
  `);
  await removePending(executor, tenantId, mailbox, messageId);
  return { newlyDeleted: Boolean(before?.hasRaw), threadId: before?.threadId ?? null };
}

/** Listing saw the message in this generation (cheap path: no fetch). */
export async function markSeen(executor: Executor, tenantId: string, mailbox: string, messageIds: readonly string[], generation: number): Promise<void> {
  if (messageIds.length === 0) return;
  await executor.execute(sql`
    UPDATE gmail_source_messages SET seen_generation = GREATEST(seen_generation, ${generation})
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id IN (${sql.join(messageIds.map((id) => sql`${id}`), sql`, `)})
  `);
}

/** Label refresh from a format=minimal observation during a re-sync (newer-only). */
export async function refreshFromMinimal(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  m: { messageId: string; historyId: string; labelIds: readonly string[]; generation: number },
): Promise<void> {
  const labels = JSON.stringify([...new Set(m.labelIds)].sort());
  await executor.execute(sql`
    UPDATE gmail_source_messages SET
      label_ids = CASE WHEN label_history_id IS NULL OR ${m.historyId}::numeric > label_history_id THEN ${labels}::jsonb ELSE label_ids END,
      label_history_id = GREATEST(label_history_id, ${m.historyId}::numeric),
      observed_history_id = GREATEST(observed_history_id, ${m.historyId}::numeric),
      seen_generation = GREATEST(seen_generation, ${m.generation}),
      deleted_at = CASE WHEN deleted_reason = 'absent_from_listing' THEN NULL ELSE deleted_at END,
      deleted_reason = CASE WHEN deleted_reason = 'absent_from_listing' THEN NULL ELSE deleted_reason END,
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${m.messageId}
  `);
}

/**
 * Captured, live messages of this mailbox that the finished listing of `generation` did not
 * see and that nothing observed after the generation's start historyId: they are gone.
 */
export async function messagesAbsentFromGeneration(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  generation: number,
  startHistoryId: string,
  limit: number,
): Promise<Array<{ messageId: string; threadId: string | null }>> {
  return rowsOf<{ message_id: string; thread_id: string | null }>(
    await executor.execute(sql`
      SELECT message_id, thread_id FROM gmail_source_messages
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND deleted_at IS NULL AND raw_json IS NOT NULL
        AND seen_generation < ${generation}
        AND COALESCE(observed_history_id, 0) < ${startHistoryId}::numeric
      ORDER BY message_id
      LIMIT ${limit}
    `),
  ).map((r) => ({ messageId: r.message_id, threadId: r.thread_id }));
}

export async function setRfc822Result(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  messageId: string,
  r: { status: "captured"; sha256: string; size: number } | { status: "failed"; error: string; backoffSeconds: number } | { status: "unavailable" | "oversize" | "disabled" | "withheld_redaction"; error?: string },
): Promise<void> {
  if (r.status === "captured") {
    await executor.execute(sql`
      UPDATE gmail_source_messages SET rfc822_status = 'captured', rfc822_sha256 = ${r.sha256}, rfc822_size = ${r.size}, rfc822_error = NULL,
        rfc822_next_attempt_at = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}
    `);
  } else if (r.status === "failed") {
    await executor.execute(sql`
      UPDATE gmail_source_messages SET rfc822_status = 'failed', rfc822_error = ${r.error.slice(0, 300)}, rfc822_attempts = rfc822_attempts + 1,
        rfc822_next_attempt_at = now() + make_interval(secs => LEAST(86400, ${r.backoffSeconds} * power(2, LEAST(rfc822_attempts, 8)))), updated_at = now()
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}
    `);
  } else {
    await executor.execute(sql`
      UPDATE gmail_source_messages SET rfc822_status = ${r.status}, rfc822_error = ${r.error ?? null}, rfc822_next_attempt_at = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}
    `);
  }
}

export async function dueRfc822Retries(executor: Executor, tenantId: string, mailbox: string, limit: number): Promise<string[]> {
  return rowsOf<{ message_id: string }>(
    await executor.execute(sql`
      SELECT message_id FROM gmail_source_messages
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND deleted_at IS NULL AND raw_json IS NOT NULL
        AND rfc822_status IN ('pending', 'failed') AND (rfc822_next_attempt_at IS NULL OR rfc822_next_attempt_at <= now())
      ORDER BY rfc822_next_attempt_at NULLS FIRST, message_id
      LIMIT ${limit}
    `),
  ).map((r) => r.message_id);
}

export async function getRawJson(executor: Executor, tenantId: string, mailbox: string, messageId: string): Promise<string | null> {
  const row = rowsOf<{ raw_json: string | null }>(
    await executor.execute(sql`SELECT raw_json FROM gmail_source_messages WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}`),
  )[0];
  return row?.raw_json ?? null;
}

// ------------------------------------------------------------------ attachments

export interface AttachmentPartInput {
  partRef: string;
  partId: string | null;
  filename: string | null;
  mimeType: string | null;
  declaredSize: number | null;
  contentId: string | null;
  disposition: string | null;
}

export async function registerAttachmentParts(executor: Executor, tenantId: string, mailbox: string, messageId: string, parts: readonly AttachmentPartInput[]): Promise<void> {
  for (const p of parts) {
    await executor.execute(sql`
      INSERT INTO gmail_source_attachments (tenant_id, mailbox, message_id, part_ref, part_id, filename, mime_type, declared_size, content_id, disposition)
      VALUES (${tenantId}, ${mailbox}, ${messageId}, ${p.partRef}, ${p.partId}, ${p.filename}, ${p.mimeType}, ${p.declaredSize}, ${p.contentId}, ${p.disposition})
      ON CONFLICT (tenant_id, mailbox, message_id, part_ref) DO NOTHING
    `);
  }
}

export type AttachmentResult =
  | { status: "stored"; sha256: string; size: number; capture: "attachments.get" | "inline" }
  | { status: "skipped_oversize" | "unavailable"; error?: string }
  | { status: "failed"; error: string; backoffSeconds: number };

export async function setAttachmentResult(executor: Executor, tenantId: string, mailbox: string, messageId: string, partRef: string, r: AttachmentResult): Promise<void> {
  if (r.status === "stored") {
    await executor.execute(sql`
      UPDATE gmail_source_attachments SET status = 'stored', sha256 = ${r.sha256}, size = ${r.size}, capture = ${r.capture},
        last_error = NULL, next_attempt_at = NULL, captured_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId} AND part_ref = ${partRef} AND deleted_at IS NULL
    `);
  } else if (r.status === "failed") {
    await executor.execute(sql`
      UPDATE gmail_source_attachments SET status = 'failed', last_error = ${r.error.slice(0, 300)}, attempts = attempts + 1,
        next_attempt_at = now() + make_interval(secs => LEAST(86400, ${r.backoffSeconds} * power(2, LEAST(attempts, 8)))), updated_at = now()
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId} AND part_ref = ${partRef} AND deleted_at IS NULL
    `);
  } else {
    await executor.execute(sql`
      UPDATE gmail_source_attachments SET status = ${r.status}, last_error = ${r.error ?? null}, next_attempt_at = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId} AND part_ref = ${partRef} AND deleted_at IS NULL
    `);
  }
  // The message projection lists attachment status: re-export it.
  await executor.execute(sql`
    UPDATE gmail_source_messages SET attachments_rev = attachments_rev + 1, updated_at = now()
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}
  `);
}

export async function messagesWithDueAttachments(executor: Executor, tenantId: string, mailbox: string, limit: number): Promise<string[]> {
  return rowsOf<{ message_id: string }>(
    await executor.execute(sql`
      SELECT DISTINCT message_id FROM gmail_source_attachments
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND deleted_at IS NULL
        AND status IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY message_id
      LIMIT ${limit}
    `),
  ).map((r) => r.message_id);
}

export async function attachmentStatuses(executor: Executor, tenantId: string, mailbox: string, messageId: string): Promise<Map<string, string>> {
  const rows = rowsOf<{ part_ref: string; status: string }>(
    await executor.execute(sql`SELECT part_ref, status FROM gmail_source_attachments WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}`),
  );
  return new Map(rows.map((r) => [r.part_ref, r.status]));
}

// ------------------------------------------------------------------ threads / history pages

export async function touchThreads(executor: Executor, tenantId: string, mailbox: string, threadIds: Iterable<string | null>): Promise<void> {
  for (const threadId of new Set([...threadIds].filter((t): t is string => Boolean(t)))) {
    await executor.execute(sql`
      INSERT INTO gmail_source_threads (tenant_id, mailbox, thread_id, touched_at) VALUES (${tenantId}, ${mailbox}, ${threadId}, now())
      ON CONFLICT (tenant_id, mailbox, thread_id) DO UPDATE SET touched_at = now()
    `);
  }
}

export async function storeHistoryPage(
  executor: Executor,
  tenantId: string,
  mailbox: string,
  page: { startHistoryId: string; responseHistoryId: string | null; firstRecordId: string | null; lastRecordId: string | null; recordCount: number; rawJson: string },
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO gmail_source_history_pages (tenant_id, mailbox, start_history_id, response_history_id, first_record_id, last_record_id, record_count, raw_json)
    VALUES (${tenantId}, ${mailbox}, ${page.startHistoryId}::numeric, ${page.responseHistoryId}::numeric, ${page.firstRecordId}::numeric,
            ${page.lastRecordId}::numeric, ${page.recordCount}, ${page.rawJson})
    ON CONFLICT (tenant_id, mailbox, start_history_id) DO UPDATE SET
      response_history_id = EXCLUDED.response_history_id,
      first_record_id = EXCLUDED.first_record_id,
      last_record_id = EXCLUDED.last_record_id,
      record_count = EXCLUDED.record_count,
      raw_json = EXCLUDED.raw_json,
      captured_at = now()
    WHERE gmail_source_history_pages.raw_json IS DISTINCT FROM EXCLUDED.raw_json
  `);
}

// ------------------------------------------------------------------ pending fetches

export async function addPending(executor: Executor, tenantId: string, mailbox: string, messageId: string, reason: string, error: string, backoffSeconds: number): Promise<void> {
  await executor.execute(sql`
    INSERT INTO gmail_source_pending (tenant_id, mailbox, message_id, reason, attempts, last_error, next_attempt_at)
    VALUES (${tenantId}, ${mailbox}, ${messageId}, ${reason}, 1, ${error.slice(0, 300)}, now() + make_interval(secs => ${backoffSeconds}))
    ON CONFLICT (tenant_id, mailbox, message_id) DO UPDATE SET
      attempts = gmail_source_pending.attempts + 1,
      last_error = EXCLUDED.last_error,
      next_attempt_at = now() + make_interval(secs => LEAST(86400, ${backoffSeconds} * power(2, LEAST(gmail_source_pending.attempts, 8)))),
      updated_at = now()
  `);
}

export async function removePending(executor: Executor, tenantId: string, mailbox: string, messageId: string): Promise<void> {
  await executor.execute(sql`DELETE FROM gmail_source_pending WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND message_id = ${messageId}`);
}

export async function duePending(executor: Executor, tenantId: string, mailbox: string, limit: number): Promise<string[]> {
  return rowsOf<{ message_id: string }>(
    await executor.execute(sql`
      SELECT message_id FROM gmail_source_pending
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND next_attempt_at <= now()
      ORDER BY next_attempt_at, message_id LIMIT ${limit}
    `),
  ).map((r) => r.message_id);
}

export interface MailboxCounts {
  messages: number;
  deleted: number;
  pendingFetches: number;
  attachmentsStored: number;
  attachmentsPending: number;
  attachmentsFailed: number;
  attachmentsOversize: number;
  attachmentsUnavailable: number;
  rfc822Captured: number;
  rfc822Pending: number;
  rfc822Failed: number;
  rfc822Withheld: number;
  rfc822Oversize: number;
  rfc822Disabled: number;
  historyPages: number;
}

export async function mailboxCounts(executor: Executor, tenantId: string, mailbox: string): Promise<MailboxCounts> {
  const m = rowsOf<Record<string, unknown>>(
    await executor.execute(sql`
      SELECT
        count(*) FILTER (WHERE raw_json IS NOT NULL AND deleted_at IS NULL)::int AS messages,
        count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted,
        count(*) FILTER (WHERE deleted_at IS NULL AND rfc822_status = 'captured')::int AS rfc822_captured,
        count(*) FILTER (WHERE deleted_at IS NULL AND raw_json IS NOT NULL AND rfc822_status = 'pending')::int AS rfc822_pending,
        count(*) FILTER (WHERE deleted_at IS NULL AND rfc822_status = 'failed')::int AS rfc822_failed,
        count(*) FILTER (WHERE deleted_at IS NULL AND rfc822_status = 'withheld_redaction')::int AS rfc822_withheld,
        count(*) FILTER (WHERE deleted_at IS NULL AND rfc822_status = 'oversize')::int AS rfc822_oversize,
        count(*) FILTER (WHERE deleted_at IS NULL AND rfc822_status = 'disabled')::int AS rfc822_disabled
      FROM gmail_source_messages WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox}
    `),
  )[0] ?? {};
  const a = rowsOf<Record<string, unknown>>(
    await executor.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'stored')::int AS stored,
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'skipped_oversize')::int AS oversize,
        count(*) FILTER (WHERE status = 'unavailable')::int AS unavailable
      FROM gmail_source_attachments WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND deleted_at IS NULL
    `),
  )[0] ?? {};
  const p = rowsOf<{ n: number }>(await executor.execute(sql`SELECT count(*)::int AS n FROM gmail_source_pending WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox}`))[0];
  const h = rowsOf<{ n: number }>(await executor.execute(sql`SELECT count(*)::int AS n FROM gmail_source_history_pages WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox}`))[0];
  const n = (v: unknown) => Number(v ?? 0);
  return {
    messages: n(m.messages),
    deleted: n(m.deleted),
    pendingFetches: n(p?.n),
    attachmentsStored: n(a.stored),
    attachmentsPending: n(a.pending),
    attachmentsFailed: n(a.failed),
    attachmentsOversize: n(a.oversize),
    attachmentsUnavailable: n(a.unavailable),
    rfc822Captured: n(m.rfc822_captured),
    rfc822Pending: n(m.rfc822_pending),
    rfc822Failed: n(m.rfc822_failed),
    rfc822Withheld: n(m.rfc822_withheld),
    rfc822Oversize: n(m.rfc822_oversize),
    rfc822Disabled: n(m.rfc822_disabled),
    historyPages: n(h?.n),
  };
}
