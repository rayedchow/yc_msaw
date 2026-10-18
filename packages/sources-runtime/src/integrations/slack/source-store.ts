import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { db } from "../../db/client.js";

/**
 * SQL access to the Slack source-lane tables (drizzle/9400_slack_source_lane.sql).
 * Every tenant-row statement filters by (tenant_id, team_id); tenant ids come from
 * the server-side task/token context, never from a request body.
 */

export type SlackDbExecutor = Pick<typeof db, "execute">;

export const SLACK_CHUNK_BYTES = 8 * 1024 * 1024;

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Opaque quota identity for Slack's per-app, per-workspace, per-method limits. Two tenants
 * connected to the same workspace through the same app share it.
 */
export function slackQuotaKey(teamId: string, appKey = process.env.SLACK_CLIENT_ID?.trim() || "default-app"): string {
  return createHash("sha256").update(`slack-quota\n${appKey}\n${teamId}`).digest("hex").slice(0, 32);
}

// ------------------------------------------------------------------ Slack ts helpers

/** Compare Slack ts strings ("1700000000.000100") numerically; null sorts lowest. */
export function compareSlackTs(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const [as, af = ""] = a.split(".");
  const [bs, bf = ""] = b.split(".");
  const ai = BigInt(as || "0");
  const bi = BigInt(bs || "0");
  if (ai !== bi) return ai < bi ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const an = BigInt((af.padEnd(width, "0")) || "0");
  const bn = BigInt((bf.padEnd(width, "0")) || "0");
  return an === bn ? 0 : an < bn ? -1 : 1;
}

export function maxSlackTs(...values: Array<string | null | undefined>): string | null {
  let out: string | null = null;
  for (const v of values) if (v && compareSlackTs(v, out) > 0) out = v;
  return out;
}

export function minSlackTs(...values: Array<string | null | undefined>): string | null {
  let out: string | null = null;
  for (const v of values) if (v && (out === null || compareSlackTs(v, out) < 0)) out = v;
  return out;
}

export function isSlackTs(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,12}(\.\d{1,9})?$/u.test(value);
}

// ------------------------------------------------------------------ workspaces + leases

export interface SlackWorkspaceRow {
  tenant_id: string;
  team_id: string;
  team_name: string | null;
  quota_key: string;
  discovery_complete_at: unknown;
  discovery_error: string | null;
  discovery_error_at: unknown;
  auth_state: "ok" | "blocked";
  auth_error: string | null;
  auth_error_at: unknown;
  thread_scan_at: unknown;
  last_history_run_at: unknown;
  last_threads_run_at: unknown;
  rate_limited_until: unknown;
}

export async function ensureWorkspace(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  teamName: string | null,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO slack_source_workspaces (tenant_id, team_id, team_name, quota_key)
    VALUES (${tenantId}, ${teamId}, ${teamName}, ${slackQuotaKey(teamId)})
    ON CONFLICT (tenant_id, team_id) DO UPDATE
    SET team_name = COALESCE(EXCLUDED.team_name, slack_source_workspaces.team_name),
        quota_key = EXCLUDED.quota_key,
        updated_at = now()
  `);
}

export async function getWorkspace(executor: SlackDbExecutor, tenantId: string, teamId: string): Promise<SlackWorkspaceRow | null> {
  return rowsOf<SlackWorkspaceRow>(await executor.execute(sql`
    SELECT * FROM slack_source_workspaces WHERE tenant_id = ${tenantId} AND team_id = ${teamId}
  `))[0] ?? null;
}

export async function listWorkspaces(executor: SlackDbExecutor, tenantId: string): Promise<SlackWorkspaceRow[]> {
  return rowsOf<SlackWorkspaceRow>(await executor.execute(sql`
    SELECT * FROM slack_source_workspaces WHERE tenant_id = ${tenantId} ORDER BY team_id
  `));
}

export type SlackLeaseLane = "history" | "threads";

/** Take (or renew) the per-workspace lane lease; false when another live runner holds it. */
export async function acquireLease(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  lane: SlackLeaseLane,
  owner: string,
  until: Date,
  now: Date,
): Promise<boolean> {
  const rows = lane === "history"
    ? rowsOf(await executor.execute(sql`
        UPDATE slack_source_workspaces
        SET history_lease_owner = ${owner}, history_lease_until = ${until.toISOString()}::timestamptz, updated_at = now()
        WHERE tenant_id = ${tenantId} AND team_id = ${teamId}
          AND (history_lease_owner IS NULL OR history_lease_owner = ${owner}
               OR history_lease_until IS NULL OR history_lease_until < ${now.toISOString()}::timestamptz)
        RETURNING 1
      `))
    : rowsOf(await executor.execute(sql`
        UPDATE slack_source_workspaces
        SET threads_lease_owner = ${owner}, threads_lease_until = ${until.toISOString()}::timestamptz, updated_at = now()
        WHERE tenant_id = ${tenantId} AND team_id = ${teamId}
          AND (threads_lease_owner IS NULL OR threads_lease_owner = ${owner}
               OR threads_lease_until IS NULL OR threads_lease_until < ${now.toISOString()}::timestamptz)
        RETURNING 1
      `));
  return rows.length > 0;
}

export async function releaseLease(executor: SlackDbExecutor, tenantId: string, teamId: string, lane: SlackLeaseLane, owner: string): Promise<void> {
  if (lane === "history") {
    await executor.execute(sql`
      UPDATE slack_source_workspaces
      SET history_lease_owner = NULL, history_lease_until = NULL, last_history_run_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND team_id = ${teamId} AND history_lease_owner = ${owner}
    `);
  } else {
    await executor.execute(sql`
      UPDATE slack_source_workspaces
      SET threads_lease_owner = NULL, threads_lease_until = NULL, last_threads_run_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND team_id = ${teamId} AND threads_lease_owner = ${owner}
    `);
  }
}

export async function setWorkspaceAuth(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  state: "ok" | "blocked",
  error: string | null,
): Promise<void> {
  await executor.execute(sql`
    UPDATE slack_source_workspaces
    SET auth_state = ${state},
        auth_error = ${error},
        auth_error_at = CASE WHEN ${state} = 'blocked' THEN now() ELSE auth_error_at END,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND team_id = ${teamId}
  `);
}

export async function setWorkspaceRateLimited(executor: SlackDbExecutor, tenantId: string, teamId: string, until: Date | null): Promise<void> {
  await executor.execute(sql`
    UPDATE slack_source_workspaces
    SET rate_limited_until = ${until ? until.toISOString() : null}::timestamptz, updated_at = now()
    WHERE tenant_id = ${tenantId} AND team_id = ${teamId}
  `);
}

// ------------------------------------------------------------------ conversations

export type SlackAccessState =
  | "listed"
  | "not_listed"
  | "not_in_channel"
  | "channel_not_found"
  | "missing_scope"
  | "access_denied"
  | "error";

export interface SlackConversationRow {
  tenant_id: string;
  team_id: string;
  channel_id: string;
  channel_name: string | null;
  channel_type: string | null;
  is_archived: boolean;
  is_member: boolean | null;
  access_state: SlackAccessState;
  access_reason: string | null;
  head_ts: string | null;
  tail_ts: string | null;
  history_bound_ts: string | null;
  history_started_at: unknown;
  history_complete_at: unknown;
  fwd_oldest: string | null;
  fwd_latest: string | null;
  fwd_cursor: string | null;
  fwd_low_ts: string | null;
  fwd_top_ts: string | null;
  fwd_started_at: unknown;
  bwd_latest: string | null;
  bwd_inclusive: boolean;
  bwd_cursor: string | null;
  rec_oldest: string | null;
  rec_latest: string | null;
  rec_cursor: string | null;
  rec_low_ts: string | null;
  rec_top_ts: string | null;
  rec_started_at: unknown;
  last_reconcile_at: unknown;
  messages_seen: unknown;
  pages_done: unknown;
  last_listed_at: unknown;
  last_forward_at: unknown;
  last_forward_complete_at: unknown;
  last_success_at: unknown;
  last_error: string | null;
  last_error_at: unknown;
  error_streak: number;
  created_at: unknown;
  updated_at: unknown;
}

export async function listConversations(executor: SlackDbExecutor, tenantId: string, teamId?: string): Promise<SlackConversationRow[]> {
  return rowsOf<SlackConversationRow>(await executor.execute(teamId
    ? sql`SELECT * FROM slack_source_conversations WHERE tenant_id = ${tenantId} AND team_id = ${teamId} ORDER BY channel_id`
    : sql`SELECT * FROM slack_source_conversations WHERE tenant_id = ${tenantId} ORDER BY team_id, channel_id`));
}

export async function getConversation(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  channelId: string,
): Promise<SlackConversationRow | null> {
  return rowsOf<SlackConversationRow>(await executor.execute(sql`
    SELECT * FROM slack_source_conversations
    WHERE tenant_id = ${tenantId} AND team_id = ${teamId} AND channel_id = ${channelId}
  `))[0] ?? null;
}

export async function setConversationAccess(
  executor: SlackDbExecutor,
  key: { tenantId: string; teamId: string; channelId: string },
  state: SlackAccessState,
  reason: string | null,
): Promise<void> {
  await executor.execute(sql`
    UPDATE slack_source_conversations
    SET access_state = ${state}, access_reason = ${reason},
        last_error = CASE WHEN ${state} = 'listed' THEN last_error ELSE ${reason} END,
        last_error_at = CASE WHEN ${state} = 'listed' THEN last_error_at ELSE now() END,
        updated_at = now()
    WHERE tenant_id = ${key.tenantId} AND team_id = ${key.teamId} AND channel_id = ${key.channelId}
  `);
}

/** Partial update of pass/progress columns (only the listed keys are written). */
export async function updateConversation(
  executor: SlackDbExecutor,
  key: { tenantId: string; teamId: string; channelId: string },
  patch: Partial<Record<UpdatableConversationColumn, string | number | boolean | Date | null>>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([col]) => UPDATABLE_COLUMNS.has(col as UpdatableConversationColumn));
  if (entries.length === 0) return;
  const sets = entries.map(([col, value]) => {
    const v = value instanceof Date ? value.toISOString() : value;
    if (TIMESTAMP_COLUMNS.has(col)) return sql`${sql.identifier(col)} = ${v}::timestamptz`;
    return sql`${sql.identifier(col)} = ${v}`;
  });
  await executor.execute(sql`
    UPDATE slack_source_conversations
    SET ${sql.join(sets, sql`, `)}, updated_at = now()
    WHERE tenant_id = ${key.tenantId} AND team_id = ${key.teamId} AND channel_id = ${key.channelId}
  `);
}

export type UpdatableConversationColumn =
  | "head_ts" | "tail_ts" | "history_bound_ts" | "history_started_at" | "history_complete_at"
  | "fwd_oldest" | "fwd_latest" | "fwd_cursor" | "fwd_low_ts" | "fwd_top_ts" | "fwd_started_at"
  | "bwd_latest" | "bwd_inclusive" | "bwd_cursor"
  | "rec_oldest" | "rec_latest" | "rec_cursor" | "rec_low_ts" | "rec_top_ts" | "rec_started_at" | "last_reconcile_at"
  | "last_forward_at" | "last_forward_complete_at" | "last_success_at"
  | "last_error" | "last_error_at" | "error_streak";

const UPDATABLE_COLUMNS = new Set<UpdatableConversationColumn>([
  "head_ts", "tail_ts", "history_bound_ts", "history_started_at", "history_complete_at",
  "fwd_oldest", "fwd_latest", "fwd_cursor", "fwd_low_ts", "fwd_top_ts", "fwd_started_at",
  "bwd_latest", "bwd_inclusive", "bwd_cursor",
  "rec_oldest", "rec_latest", "rec_cursor", "rec_low_ts", "rec_top_ts", "rec_started_at", "last_reconcile_at",
  "last_forward_at", "last_forward_complete_at", "last_success_at",
  "last_error", "last_error_at", "error_streak",
]);

const TIMESTAMP_COLUMNS = new Set<string>([
  "history_started_at", "history_complete_at", "fwd_started_at", "rec_started_at", "last_reconcile_at",
  "last_forward_at", "last_forward_complete_at", "last_success_at", "last_error_at",
]);

export async function countConversationPage(
  executor: SlackDbExecutor,
  key: { tenantId: string; teamId: string; channelId: string },
  messages: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE slack_source_conversations
    SET pages_done = pages_done + 1, messages_seen = messages_seen + ${messages}, error_streak = 0, updated_at = now()
    WHERE tenant_id = ${key.tenantId} AND team_id = ${key.teamId} AND channel_id = ${key.channelId}
  `);
}

export async function recordConversationError(
  executor: SlackDbExecutor,
  key: { tenantId: string; teamId: string; channelId: string },
  error: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE slack_source_conversations
    SET last_error = ${error.slice(0, 500)}, last_error_at = now(), error_streak = error_streak + 1, updated_at = now()
    WHERE tenant_id = ${key.tenantId} AND team_id = ${key.teamId} AND channel_id = ${key.channelId}
  `);
}

// ------------------------------------------------------------------ reconcile seen set

export async function clearReconcileSeen(executor: SlackDbExecutor, key: { tenantId: string; teamId: string; channelId: string }): Promise<void> {
  await executor.execute(sql`
    DELETE FROM slack_source_reconcile_seen
    WHERE tenant_id = ${key.tenantId} AND team_id = ${key.teamId} AND channel_id = ${key.channelId}
  `);
}

export async function addReconcileSeen(
  executor: SlackDbExecutor,
  key: { tenantId: string; teamId: string; channelId: string },
  tsList: readonly string[],
): Promise<void> {
  if (tsList.length === 0) return;
  await executor.execute(sql`
    INSERT INTO slack_source_reconcile_seen (tenant_id, team_id, channel_id, ts)
    SELECT ${key.tenantId}, ${key.teamId}, ${key.channelId}, t
    FROM jsonb_array_elements_text(${JSON.stringify([...tsList])}::jsonb) AS t
    ON CONFLICT DO NOTHING
  `);
}

// ------------------------------------------------------------------ quota

export interface SlackQuotaRow {
  quota_key: string;
  method: string;
  next_slot_at: unknown;
  blocked_until: unknown;
  rate_limit_streak: number;
  last_retry_after_seconds: number | null;
  last_rate_limited_at: unknown;
}

/**
 * Claim the next request slot for (quota, method) if it starts no later than `deadline`.
 * Slots are spaced by `intervalMs` across every worker and never start before the
 * last Retry-After. Returns the slot start, or null (nothing reserved) when it would
 * start after the deadline.
 */
export async function claimQuotaSlot(
  executor: SlackDbExecutor,
  quotaKey: string,
  method: string,
  intervalMs: number,
  now: Date,
  deadline: Date,
): Promise<Date | null> {
  const n = now.toISOString();
  const secs = intervalMs / 1000;
  const row = rowsOf<{ slot_at: unknown }>(await executor.execute(sql`
    INSERT INTO slack_source_quota AS q (quota_key, method, next_slot_at, updated_at)
    VALUES (${quotaKey}, ${method}, ${n}::timestamptz + make_interval(secs => ${secs}), ${n}::timestamptz)
    ON CONFLICT (quota_key, method) DO UPDATE
    SET next_slot_at = GREATEST(q.next_slot_at, ${n}::timestamptz, COALESCE(q.blocked_until, ${n}::timestamptz)) + make_interval(secs => ${secs}),
        updated_at = ${n}::timestamptz
    WHERE GREATEST(q.next_slot_at, ${n}::timestamptz, COALESCE(q.blocked_until, ${n}::timestamptz)) <= ${deadline.toISOString()}::timestamptz
    RETURNING q.next_slot_at - make_interval(secs => ${secs}) AS slot_at
  `))[0];
  if (!row) return null;
  return new Date(isoOrNull(row.slot_at) ?? n);
}

export async function getQuota(executor: SlackDbExecutor, quotaKey: string, method: string): Promise<SlackQuotaRow | null> {
  return rowsOf<SlackQuotaRow>(await executor.execute(sql`
    SELECT * FROM slack_source_quota WHERE quota_key = ${quotaKey} AND method = ${method}
  `))[0] ?? null;
}

export async function listQuota(executor: SlackDbExecutor, quotaKey: string): Promise<SlackQuotaRow[]> {
  return rowsOf<SlackQuotaRow>(await executor.execute(sql`SELECT * FROM slack_source_quota WHERE quota_key = ${quotaKey} ORDER BY method`));
}

export async function recordRateLimited(
  executor: SlackDbExecutor,
  quotaKey: string,
  method: string,
  retryAfterSeconds: number,
  now: Date,
): Promise<Date> {
  const until = new Date(now.getTime() + retryAfterSeconds * 1000);
  await executor.execute(sql`
    INSERT INTO slack_source_quota AS q (quota_key, method, blocked_until, rate_limit_streak, last_retry_after_seconds, last_rate_limited_at, updated_at)
    VALUES (${quotaKey}, ${method}, ${until.toISOString()}::timestamptz, 1, ${Math.ceil(retryAfterSeconds)}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
    ON CONFLICT (quota_key, method) DO UPDATE
    SET blocked_until = GREATEST(COALESCE(q.blocked_until, EXCLUDED.blocked_until), EXCLUDED.blocked_until),
        rate_limit_streak = q.rate_limit_streak + 1,
        last_retry_after_seconds = EXCLUDED.last_retry_after_seconds,
        last_rate_limited_at = EXCLUDED.last_rate_limited_at,
        updated_at = EXCLUDED.updated_at
  `);
  return until;
}

export async function recordQuotaSuccess(executor: SlackDbExecutor, quotaKey: string, method: string): Promise<void> {
  await executor.execute(sql`
    UPDATE slack_source_quota SET rate_limit_streak = 0, updated_at = now()
    WHERE quota_key = ${quotaKey} AND method = ${method} AND rate_limit_streak > 0
  `);
}

// ------------------------------------------------------------------ files + bytes

export interface SlackFileRow {
  tenant_id: string;
  team_id: string;
  file_id: string;
  name: string | null;
  title: string | null;
  mimetype: string | null;
  filetype: string | null;
  declared_size: unknown;
  version_ref: string | null;
  version_ordinal: unknown;
  channel_ids: unknown;
  message_refs: unknown;
  metadata_json: string | null;
  status: string;
  status_reason: string | null;
  sha256: string | null;
  size: unknown;
  stored_version_ref: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: unknown;
  deleted_at: unknown;
  deleted_reason: string | null;
  first_captured_at: unknown;
  updated_at: unknown;
}

export async function getFile(executor: SlackDbExecutor, tenantId: string, teamId: string, fileId: string): Promise<SlackFileRow | null> {
  return rowsOf<SlackFileRow>(await executor.execute(sql`
    SELECT * FROM slack_source_files WHERE tenant_id = ${tenantId} AND team_id = ${teamId} AND file_id = ${fileId}
  `))[0] ?? null;
}

export interface FileObservation {
  name: string | null;
  title: string | null;
  mimetype: string | null;
  filetype: string | null;
  declaredSize: number | null;
  versionRef: string;
  versionOrdinal: number | null;
  channelId: string | null;
  messageRef: string | null;
  metadataJson: string;
}

/** Upsert the metadata of an observed (not deleted) file; channel/message refs accumulate. */
export async function upsertFileMetadata(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  fileId: string,
  obs: FileObservation,
): Promise<void> {
  const channels = JSON.stringify(obs.channelId ? [obs.channelId] : []);
  const refs = JSON.stringify(obs.messageRef ? [obs.messageRef] : []);
  await executor.execute(sql`
    INSERT INTO slack_source_files (tenant_id, team_id, file_id, name, title, mimetype, filetype, declared_size, version_ref, version_ordinal,
                                    channel_ids, message_refs, metadata_json)
    VALUES (${tenantId}, ${teamId}, ${fileId}, ${obs.name}, ${obs.title}, ${obs.mimetype}, ${obs.filetype}, ${obs.declaredSize},
            ${obs.versionRef}, ${obs.versionOrdinal}, ${channels}::jsonb, ${refs}::jsonb, ${obs.metadataJson})
    ON CONFLICT (tenant_id, team_id, file_id) DO UPDATE
    SET name = COALESCE(EXCLUDED.name, slack_source_files.name),
        title = COALESCE(EXCLUDED.title, slack_source_files.title),
        mimetype = COALESCE(EXCLUDED.mimetype, slack_source_files.mimetype),
        filetype = COALESCE(EXCLUDED.filetype, slack_source_files.filetype),
        declared_size = COALESCE(EXCLUDED.declared_size, slack_source_files.declared_size),
        version_ref = CASE
          WHEN slack_source_files.version_ordinal IS NOT NULL AND EXCLUDED.version_ordinal IS NOT NULL
               AND EXCLUDED.version_ordinal < slack_source_files.version_ordinal THEN slack_source_files.version_ref
          ELSE EXCLUDED.version_ref END,
        version_ordinal = GREATEST(slack_source_files.version_ordinal, EXCLUDED.version_ordinal),
        channel_ids = (SELECT COALESCE(jsonb_agg(DISTINCT v ORDER BY v), '[]'::jsonb)
                       FROM jsonb_array_elements_text(slack_source_files.channel_ids || EXCLUDED.channel_ids) AS v),
        message_refs = (SELECT COALESCE(jsonb_agg(DISTINCT v ORDER BY v), '[]'::jsonb)
                        FROM jsonb_array_elements_text(slack_source_files.message_refs || EXCLUDED.message_refs) AS v),
        metadata_json = CASE
          WHEN slack_source_files.version_ordinal IS NOT NULL AND EXCLUDED.version_ordinal IS NOT NULL
               AND EXCLUDED.version_ordinal < slack_source_files.version_ordinal THEN slack_source_files.metadata_json
          ELSE EXCLUDED.metadata_json END,
        updated_at = now()
  `);
}

export async function setFileStatus(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  fileId: string,
  update: { status: string; reason?: string | null; error?: string | null; nextAttemptAt?: Date | null; countAttempt?: boolean },
): Promise<void> {
  await executor.execute(sql`
    UPDATE slack_source_files
    SET status = ${update.status},
        status_reason = ${update.reason ?? null},
        last_error = ${update.error ?? null},
        next_attempt_at = ${update.nextAttemptAt ? update.nextAttemptAt.toISOString() : null}::timestamptz,
        attempts = attempts + ${update.countAttempt ? 1 : 0},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND team_id = ${teamId} AND file_id = ${fileId}
  `);
}

export async function setFileStored(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  fileId: string,
  stored: { sha256: string; size: number; versionRef: string },
): Promise<void> {
  await executor.execute(sql`
    UPDATE slack_source_files
    SET status = 'stored', status_reason = NULL, last_error = NULL, next_attempt_at = NULL,
        sha256 = ${stored.sha256}, size = ${stored.size}, stored_version_ref = ${stored.versionRef},
        attempts = attempts + 1, updated_at = now()
    WHERE tenant_id = ${tenantId} AND team_id = ${teamId} AND file_id = ${fileId}
  `);
}

export async function markFileDeleted(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  fileId: string,
  reason: "file_deleted" | "file_tombstoned" | "file_not_found",
  at: Date,
): Promise<boolean> {
  const rows = rowsOf(await executor.execute(sql`
    INSERT INTO slack_source_files (tenant_id, team_id, file_id, status, deleted_at, deleted_reason)
    VALUES (${tenantId}, ${teamId}, ${fileId}, 'unavailable', ${at.toISOString()}::timestamptz, ${reason})
    ON CONFLICT (tenant_id, team_id, file_id) DO UPDATE
    SET deleted_at = COALESCE(slack_source_files.deleted_at, EXCLUDED.deleted_at),
        deleted_reason = COALESCE(slack_source_files.deleted_reason, EXCLUDED.deleted_reason),
        next_attempt_at = NULL,
        updated_at = now()
    WHERE slack_source_files.deleted_at IS NULL
    RETURNING 1
  `));
  return rows.length > 0;
}

export async function listFilesDueForRetry(
  executor: SlackDbExecutor,
  tenantId: string,
  teamId: string,
  now: Date,
  limit: number,
): Promise<SlackFileRow[]> {
  return rowsOf<SlackFileRow>(await executor.execute(sql`
    SELECT * FROM slack_source_files
    WHERE tenant_id = ${tenantId} AND team_id = ${teamId} AND deleted_at IS NULL
      AND status IN ('pending', 'failed')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()}::timestamptz)
    ORDER BY next_attempt_at NULLS FIRST, file_id
    LIMIT ${limit}
  `));
}

/** Store exact bytes as <= 8 MiB content-addressed chunks for this tenant; returns the whole-blob sha. */
export async function putBlob(executor: SlackDbExecutor, tenantId: string, bytes: Buffer): Promise<{ sha256: string; size: number }> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const chunks: Array<{ sha256: string; size: number }> = [];
  for (let offset = 0; offset < bytes.length || (offset === 0 && chunks.length === 0); offset += SLACK_CHUNK_BYTES) {
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + SLACK_CHUNK_BYTES));
    const chunkSha = createHash("sha256").update(part).digest("hex");
    await executor.execute(sql`
      INSERT INTO slack_source_chunks (tenant_id, chunk_sha256, size, bytes)
      VALUES (${tenantId}, ${chunkSha}, ${part.length}, ${part})
      ON CONFLICT (tenant_id, chunk_sha256) DO NOTHING
    `);
    chunks.push({ sha256: chunkSha, size: part.length });
    if (bytes.length === 0) break;
  }
  await executor.execute(sql`
    INSERT INTO slack_source_blobs (tenant_id, sha256, size, chunks)
    VALUES (${tenantId}, ${sha256}, ${bytes.length}, ${JSON.stringify(chunks)}::jsonb)
    ON CONFLICT (tenant_id, sha256) DO NOTHING
  `);
  return { sha256, size: bytes.length };
}

export async function getBlob(
  executor: SlackDbExecutor,
  tenantId: string,
  sha256: string,
): Promise<{ sha256: string; size: number; chunks: Array<{ sha256: string; size: number }> } | null> {
  const row = rowsOf<{ sha256: string; size: unknown; chunks: unknown }>(await executor.execute(sql`
    SELECT sha256, size, chunks FROM slack_source_blobs WHERE tenant_id = ${tenantId} AND sha256 = ${sha256}
  `))[0];
  if (!row) return null;
  const chunks = typeof row.chunks === "string" ? JSON.parse(row.chunks) : row.chunks;
  return { sha256: row.sha256, size: Number(row.size), chunks: chunks as Array<{ sha256: string; size: number }> };
}

export async function loadChunk(executor: SlackDbExecutor, tenantId: string, chunkSha256: string): Promise<Buffer> {
  const row = rowsOf<{ bytes: Uint8Array | Buffer | string }>(await executor.execute(sql`
    SELECT bytes FROM slack_source_chunks WHERE tenant_id = ${tenantId} AND chunk_sha256 = ${chunkSha256}
  `))[0];
  if (!row) throw new Error(`slack chunk ${chunkSha256} missing for tenant`);
  const b = row.bytes;
  if (typeof b === "string") return Buffer.from(b.startsWith("\\x") ? b.slice(2) : b, "hex");
  return Buffer.from(b);
}
