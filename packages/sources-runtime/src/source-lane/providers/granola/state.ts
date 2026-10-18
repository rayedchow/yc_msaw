import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../core/types.js";
import type { GranolaCredentialIdentity } from "../../../integrations/granola/poller.js";

/**
 * Durable Granola source-lane state (drizzle/9500_granola_source_lane.sql):
 * per-tenant sync state, per-credential Retry-After cooldowns and the note
 * catalog the raw-ledger trigger maintains. Every statement is scoped by the
 * tenant id taken from the server-written task row.
 */

export interface GranolaFailedNote {
  error: string;
  at: string;
  attempts: number;
}

export interface GranolaSourceState {
  tenant_id: string;
  auth_mode: string | null;
  inventory_key: string | null;
  account_label: string | null;
  quota_key: string | null;
  folder_id: string | null;
  include_transcript: boolean | null;
  inventory_generation: number;
  inventory_phase: "none" | "running" | "complete";
  inventory_cursor: string | null;
  inventory_pages: number;
  inventory_listed: number;
  inventory_failed: number;
  inventory_started_at: string | null;
  inventory_finished_at: string | null;
  inventory_listing_complete: boolean;
  inventory_complete_key: string | null;
  inventory_complete_at: string | null;
  poll_watermark: string | null;
  poll_window_started_at: string | null;
  last_poll_at: string | null;
  last_poll_ok_at: string | null;
  last_poll_error_at: string | null;
  last_poll_error: string | null;
  listing_truncated_at: string | null;
  last_sweep_at: string | null;
  last_sweep: Record<string, unknown> | null;
  failed_notes: Record<string, GranolaFailedNote>;
  blocked_code: string | null;
  blocked_reason: string | null;
  updated_at: string;
}

const JSONB_COLUMNS = new Set(["last_sweep", "failed_notes"]);

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return (Array.isArray(rows) ? rows : []) as T[];
}

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function normalizeState(row: Record<string, unknown>): GranolaSourceState {
  const out = { ...row } as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    if (key.endsWith("_at")) out[key] = isoOrNull(out[key]);
  }
  for (const key of ["inventory_generation", "inventory_pages", "inventory_listed", "inventory_failed"]) out[key] = Number(out[key] ?? 0);
  out.last_sweep = jsonValue(row.last_sweep, null);
  out.failed_notes = jsonValue(row.failed_notes, {});
  return out as unknown as GranolaSourceState;
}

/** Which notes the credential can see: auth mode + account + folder scope. A change requires a new inventory pass. */
export function granolaInventoryKey(identity: Pick<GranolaCredentialIdentity, "authMode" | "accountFingerprint" | "folderId">): string {
  return createHash("sha256").update(`${identity.authMode}\n${identity.accountFingerprint}\n${identity.folderId ?? ""}`).digest("hex").slice(0, 32);
}

export async function loadGranolaState(ex: DbExecutor, tenantId: string): Promise<GranolaSourceState | null> {
  const row = rowsOf<Record<string, unknown>>(await ex.execute(sql`SELECT * FROM granola_source_state WHERE tenant_id = ${tenantId}`))[0];
  return row ? normalizeState(row) : null;
}

/**
 * Create or refresh the tenant's state for the current credential. When the
 * inventory key changed (other account, other folder scope, other auth mode)
 * an unfinished pass of the old key is abandoned; completeness is tied to the
 * key, so the old completion no longer counts.
 */
export async function ensureGranolaState(ex: DbExecutor, tenantId: string, identity: GranolaCredentialIdentity): Promise<GranolaSourceState> {
  const key = granolaInventoryKey(identity);
  await ex.execute(sql`
    INSERT INTO granola_source_state (tenant_id, auth_mode, inventory_key, account_label, quota_key, folder_id, include_transcript)
    VALUES (${tenantId}, ${identity.authMode}, ${key}, ${identity.accountLabel}, ${identity.quotaKey}, ${identity.folderId}, ${identity.includeTranscript})
    ON CONFLICT (tenant_id) DO UPDATE SET
      auth_mode = EXCLUDED.auth_mode,
      account_label = EXCLUDED.account_label,
      quota_key = EXCLUDED.quota_key,
      folder_id = EXCLUDED.folder_id,
      include_transcript = EXCLUDED.include_transcript,
      inventory_phase = CASE WHEN granola_source_state.inventory_key IS DISTINCT FROM EXCLUDED.inventory_key
                             THEN 'none' ELSE granola_source_state.inventory_phase END,
      inventory_cursor = CASE WHEN granola_source_state.inventory_key IS DISTINCT FROM EXCLUDED.inventory_key
                              THEN NULL ELSE granola_source_state.inventory_cursor END,
      failed_notes = CASE WHEN granola_source_state.inventory_key IS DISTINCT FROM EXCLUDED.inventory_key
                          THEN '{}'::jsonb ELSE granola_source_state.failed_notes END,
      inventory_key = EXCLUDED.inventory_key,
      updated_at = now()
  `);
  return (await loadGranolaState(ex, tenantId))!;
}

export async function updateGranolaState(ex: DbExecutor, tenantId: string, patch: Partial<Omit<GranolaSourceState, "tenant_id">>): Promise<void> {
  const sets: SQL[] = [];
  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (JSONB_COLUMNS.has(column)) sets.push(sql`${sql.identifier(column)} = ${value === null ? null : JSON.stringify(value)}::jsonb`);
    else sets.push(sql`${sql.identifier(column)} = ${value}`);
  }
  if (sets.length === 0) return;
  sets.push(sql`updated_at = now()`);
  await ex.execute(sql`UPDATE granola_source_state SET ${sql.join(sets, sql`, `)} WHERE tenant_id = ${tenantId}`);
}

/** Active Retry-After cooldown of a Granola credential, if any. */
export async function granolaCooldownUntil(ex: DbExecutor, quotaKey: string, now: Date): Promise<Date | null> {
  const row = rowsOf<{ blocked_until: unknown }>(await ex.execute(sql`SELECT blocked_until FROM granola_source_quota WHERE quota_key = ${quotaKey}`))[0];
  const until = isoOrNull(row?.blocked_until);
  return until && Date.parse(until) > now.getTime() ? new Date(until) : null;
}

/** Record a 429: every run on this credential (any tenant/worker) waits until `until`; a later cooldown never shortens it. */
export async function recordGranolaRateLimit(ex: DbExecutor, quotaKey: string, until: Date, retryAfterMs: number | null): Promise<void> {
  await ex.execute(sql`
    INSERT INTO granola_source_quota (quota_key, blocked_until, last_status, last_retry_after_ms, rate_limit_count)
    VALUES (${quotaKey}, ${until.toISOString()}::timestamptz, 429, ${retryAfterMs}, 1)
    ON CONFLICT (quota_key) DO UPDATE SET
      blocked_until = GREATEST(COALESCE(granola_source_quota.blocked_until, EXCLUDED.blocked_until), EXCLUDED.blocked_until),
      last_status = 429,
      last_retry_after_ms = EXCLUDED.last_retry_after_ms,
      rate_limit_count = granola_source_quota.rate_limit_count + 1,
      updated_at = now()
  `);
}

export interface GranolaRecheckCandidate {
  note_id: string;
  transcript_recheck_count: number;
}

/**
 * Live notes whose latest captured revision has no (or an empty) transcript,
 * created recently enough that Granola may still attach one, due for another
 * look (backoff 15 min * 2^n, at most `maxChecks` looks per revision).
 */
export async function granolaTranscriptRecheckCandidates(
  ex: DbExecutor,
  tenantId: string,
  now: Date,
  opts: { limit: number; windowDays: number; maxChecks: number },
): Promise<GranolaRecheckCandidate[]> {
  const since = new Date(now.getTime() - opts.windowDays * 86_400_000).toISOString();
  return rowsOf<GranolaRecheckCandidate>(await ex.execute(sql`
    SELECT note_id, transcript_recheck_count FROM granola_source_notes
     WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
       AND (transcript_included IS NOT TRUE OR COALESCE(transcript_segments, 0) = 0)
       AND note_created_at IS NOT NULL AND note_created_at >= ${since}
       AND transcript_recheck_count < ${opts.maxChecks}
       AND (transcript_recheck_at IS NULL
            OR transcript_recheck_at <= ${now.toISOString()}::timestamptz - make_interval(mins => 15 * power(2, transcript_recheck_count)::integer))
     ORDER BY note_created_at DESC
     LIMIT ${opts.limit}
  `)).map((r) => ({ note_id: r.note_id, transcript_recheck_count: Number(r.transcript_recheck_count) }));
}

export async function markGranolaTranscriptRechecked(ex: DbExecutor, tenantId: string, noteId: string, now: Date): Promise<void> {
  await ex.execute(sql`
    UPDATE granola_source_notes SET transcript_recheck_at = ${now.toISOString()}::timestamptz, transcript_recheck_count = transcript_recheck_count + 1
     WHERE tenant_id = ${tenantId} AND note_id = ${noteId}
  `);
}
