import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import type { db as Db } from "../../db/client.js";

/**
 * Gmail upstream quota coordination for the source lane.
 *
 * Gmail's per-user limits are charged per mailbox (per Cloud project), so local
 * cooldowns and the single active sync are keyed by the upstream mailbox, never
 * by tenant or connection: two tenants bound to the same mailbox share one budget.
 * The key is an opaque hash; no raw address is used as a key, log line or header.
 *
 * X-Goog-Quota-User (sent by fetchGoogleApi, from the credential's own opaque
 * quotaUser) is attribution only: Google ignores it unless the request's quota
 * project is identified, so nothing here assumes it isolates quota.
 *
 * State is durable (gmail_source_quota) so a cooldown set by one worker is seen
 * by all workers and survives restarts. The donor's in-process cooldown map
 * (vault/google-rate-limit.ts) is still consulted with the same opaque key.
 */

export type Executor = Pick<typeof Db, "execute">;

/** Opaque, bounded, tenant-independent key for one Gmail mailbox. */
export function gmailQuotaKey(mailbox: string): string {
  return `gm${createHash("sha256").update(`gmail-mailbox\n${mailbox.trim().toLowerCase()}`).digest("hex").slice(0, 40)}`;
}

/** In-process cooldown service name for vault/google-rate-limit.ts (opaque; never the address). */
export function gmailCooldownService(quotaKey: string): string {
  return `gmail:${quotaKey}`;
}

export const MAX_COOLDOWN_SECONDS = 3_600;

/**
 * Cooldown after a rate-limit response: never shorter than Google's Retry-After;
 * repeated rate limits back off exponentially (Retry-After floor x 2^streak), capped at 1h.
 */
export function rateLimitCooldownSeconds(retryAfterSeconds: number, previousStreak: number): number {
  const floor = Math.max(1, Math.ceil(retryAfterSeconds));
  const exp = floor * 2 ** Math.min(Math.max(0, previousStreak), 6);
  return Math.min(MAX_COOLDOWN_SECONDS, Math.max(floor, exp));
}

/** Backoff for non-quota errors (5xx, network, transient): 30s, 60s, ... capped at 30 minutes. */
export function errorBackoffSeconds(streak: number): number {
  return Math.min(1_800, 30 * 2 ** Math.min(Math.max(0, streak - 1), 10));
}

export interface QuotaState {
  cooldownUntil: Date | null;
  rateLimitStreak: number;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return result && typeof result === "object" && "rows" in result ? ((result as { rows: T[] }).rows ?? []) : [];
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function readQuotaState(executor: Executor, quotaKey: string): Promise<QuotaState> {
  const row = rowsOf<{ cooldown_until: unknown; rate_limit_streak: number }>(
    await executor.execute(sql`SELECT cooldown_until, rate_limit_streak FROM gmail_source_quota WHERE quota_key = ${quotaKey}`),
  )[0];
  return { cooldownUntil: toDate(row?.cooldown_until), rateLimitStreak: Number(row?.rate_limit_streak ?? 0) };
}

/** Records a rate-limit response; returns the cooldown end actually stored (the later of existing and new). */
export async function recordRateLimit(
  executor: Executor,
  quotaKey: string,
  input: { status: number; reason: string | null; retryAfterSeconds: number },
): Promise<Date> {
  const current = await readQuotaState(executor, quotaKey);
  const seconds = rateLimitCooldownSeconds(input.retryAfterSeconds, current.rateLimitStreak);
  const row = rowsOf<{ cooldown_until: unknown }>(
    await executor.execute(sql`
      INSERT INTO gmail_source_quota (quota_key, cooldown_until, rate_limit_streak, last_status, last_reason, last_retry_after_seconds, updated_at)
      VALUES (${quotaKey}, now() + make_interval(secs => ${seconds}), 1, ${input.status}, ${input.reason}, ${Math.ceil(input.retryAfterSeconds)}, now())
      ON CONFLICT (quota_key) DO UPDATE SET
        cooldown_until = GREATEST(COALESCE(gmail_source_quota.cooldown_until, now()), EXCLUDED.cooldown_until),
        rate_limit_streak = gmail_source_quota.rate_limit_streak + 1,
        last_status = EXCLUDED.last_status,
        last_reason = EXCLUDED.last_reason,
        last_retry_after_seconds = EXCLUDED.last_retry_after_seconds,
        updated_at = now()
      RETURNING cooldown_until
    `),
  )[0];
  return toDate(row?.cooldown_until) ?? new Date(Date.now() + seconds * 1000);
}

/** A slice finished without a rate limit: the exponential streak resets (an active cooldown is kept). */
export async function recordQuotaSuccess(executor: Executor, quotaKey: string): Promise<void> {
  await executor.execute(sql`
    UPDATE gmail_source_quota SET rate_limit_streak = 0, updated_at = now()
    WHERE quota_key = ${quotaKey} AND rate_limit_streak <> 0
  `);
}

export const WORKER_ID = `${hostname().slice(0, 40)}:${process.pid}:${randomBytes(4).toString("hex")}`;

/**
 * Single active sync per upstream mailbox across all tenants and workers.
 * Returns false when another holder's lease is live.
 */
export async function acquireMailboxLease(executor: Executor, quotaKey: string, owner: string, ttlSeconds: number): Promise<boolean> {
  await executor.execute(sql`INSERT INTO gmail_source_quota (quota_key) VALUES (${quotaKey}) ON CONFLICT (quota_key) DO NOTHING`);
  const got = rowsOf<{ quota_key: string }>(
    await executor.execute(sql`
      UPDATE gmail_source_quota
      SET lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${ttlSeconds}), updated_at = now()
      WHERE quota_key = ${quotaKey}
        AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until < now() OR lease_owner = ${owner})
      RETURNING quota_key
    `),
  );
  return got.length === 1;
}

export async function releaseMailboxLease(executor: Executor, quotaKey: string, owner: string): Promise<void> {
  await executor.execute(sql`
    UPDATE gmail_source_quota SET lease_owner = NULL, lease_until = NULL, updated_at = now()
    WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}
  `);
}
