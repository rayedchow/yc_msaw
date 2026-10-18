import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../core/types.js";
import type { RateHeaders } from "./api.js";

/**
 * Database-backed rate limiting shared by every worker process.
 *
 * Quota identity is the bucket the upstream actually enforces:
 *  - `nango-api:<hash>`: Nango limits its API per account (one environment API key),
 *    so every tenant and connection of this runtime draws from the same bucket. The
 *    lane paces requests (min interval), honours Retry-After / X-RateLimit-Reset by
 *    persisting `blocked_until`, and never multiplies the budget by tenant.
 *  - `nango-sync:<providerConfigKey>`: concurrency leases on record syncs per Nango
 *    integration (one provider OAuth app), so a burst of tenants cannot open
 *    unbounded parallel pulls for one integration.
 * /records reads Nango's cache, not the provider API; provider-side quotas are spent
 * by Nango's own sync functions and are not attributable here (stated in coverage).
 */

function rows<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function quotaBlockedUntil(db: DbExecutor, quotaKey: string): Promise<Date | null> {
  const r = rows<{ blocked_until: unknown }>(
    await db.execute(sql`SELECT blocked_until FROM nango_records_quota WHERE quota_key = ${quotaKey} AND blocked_until > now()`),
  )[0];
  return toDate(r?.blocked_until);
}

/** Persist a cooldown (never shortens an existing one). */
export async function recordRateLimited(db: DbExecutor, quotaKey: string, input: { retryAt: Date; status: number; rate?: RateHeaders }): Promise<Date> {
  const retryMs = Math.max(0, input.retryAt.getTime() - Date.now());
  const r = rows<{ blocked_until: unknown }>(
    await db.execute(sql`
      INSERT INTO nango_records_quota (quota_key, blocked_until, last_status, last_retry_after_ms, last_limit, last_remaining, last_reset_at, updated_at)
      VALUES (${quotaKey}, ${input.retryAt.toISOString()}::timestamptz, ${input.status}, ${Math.round(retryMs)},
              ${input.rate?.limit ?? null}, ${input.rate?.remaining ?? null}, ${input.rate?.resetAt?.toISOString() ?? null}::timestamptz, now())
      ON CONFLICT (quota_key) DO UPDATE SET
        blocked_until = GREATEST(COALESCE(nango_records_quota.blocked_until, EXCLUDED.blocked_until), EXCLUDED.blocked_until),
        last_status = EXCLUDED.last_status,
        last_retry_after_ms = EXCLUDED.last_retry_after_ms,
        last_limit = EXCLUDED.last_limit,
        last_remaining = EXCLUDED.last_remaining,
        last_reset_at = EXCLUDED.last_reset_at,
        updated_at = now()
      RETURNING blocked_until
    `),
  )[0];
  return toDate(r?.blocked_until) ?? input.retryAt;
}

/** An exhausted window (X-RateLimit-Remaining: 0) blocks until its reset even before a 429 arrives. */
export async function observeRateHeaders(db: DbExecutor, quotaKey: string, rate: RateHeaders): Promise<void> {
  if (rate.remaining === null || rate.remaining > 0 || !rate.resetAt || rate.resetAt.getTime() <= Date.now()) return;
  await recordRateLimited(db, quotaKey, { retryAt: rate.resetAt, status: 200, rate });
}

export type PaceResult = { ok: true } | { ok: false; retryAt: Date; reason: "blocked" | "paced" };

/**
 * Reserve the next request slot for a quota key: next_allowed_at advances by
 * `minIntervalMs` per request across all workers. Waits in-process only up to
 * `maxWaitMs`; longer waits (or an active cooldown) are returned to the caller to defer.
 */
export async function pace(db: DbExecutor, quotaKey: string, minIntervalMs: number, maxWaitMs = 2_000): Promise<PaceResult> {
  const r = rows<{ start_at: unknown; blocked_until: unknown; now: unknown }>(
    await db.execute(sql`
      INSERT INTO nango_records_quota (quota_key, next_allowed_at, updated_at)
      VALUES (${quotaKey}, now() + make_interval(secs => ${minIntervalMs / 1000}), now())
      ON CONFLICT (quota_key) DO UPDATE SET
        next_allowed_at = CASE
          WHEN nango_records_quota.blocked_until > now() THEN nango_records_quota.next_allowed_at
          ELSE GREATEST(COALESCE(nango_records_quota.next_allowed_at, now()), now()) + make_interval(secs => ${minIntervalMs / 1000})
        END,
        updated_at = now()
      RETURNING next_allowed_at - make_interval(secs => ${minIntervalMs / 1000}) AS start_at, blocked_until, now() AS now
    `),
  )[0];
  const now = toDate(r?.now) ?? new Date();
  const blocked = toDate(r?.blocked_until);
  if (blocked && blocked > now) return { ok: false, retryAt: blocked, reason: "blocked" };
  const start = toDate(r?.start_at) ?? now;
  const wait = start.getTime() - now.getTime();
  if (wait > maxWaitMs) return { ok: false, retryAt: start, reason: "paced" };
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  return { ok: true };
}

/** Take one of `slots` concurrency leases for a key (idempotent for the same holder). Null when all are held. */
export async function acquireSlot(db: DbExecutor, quotaKey: string, slots: number, holder: string, leaseSeconds = 600): Promise<number | null> {
  await db.execute(sql`
    INSERT INTO nango_records_slots (quota_key, slot)
    SELECT ${quotaKey}, g FROM generate_series(0, ${Math.max(1, slots) - 1}) AS g
    ON CONFLICT DO NOTHING
  `);
  const r = rows<{ slot: number }>(
    await db.execute(sql`
      UPDATE nango_records_slots s
      SET holder = ${holder}, lease_until = now() + make_interval(secs => ${leaseSeconds})
      WHERE (s.quota_key, s.slot) = (
        SELECT quota_key, slot FROM nango_records_slots
        WHERE quota_key = ${quotaKey} AND slot < ${slots}
          AND (holder = ${holder} OR lease_until IS NULL OR lease_until < now())
        ORDER BY (holder = ${holder}) DESC NULLS LAST, slot
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING s.slot
    `),
  )[0];
  return r ? Number(r.slot) : null;
}

export async function renewSlot(db: DbExecutor, quotaKey: string, holder: string, leaseSeconds = 600): Promise<void> {
  await db.execute(sql`UPDATE nango_records_slots SET lease_until = now() + make_interval(secs => ${leaseSeconds}) WHERE quota_key = ${quotaKey} AND holder = ${holder}`);
}

export async function releaseSlot(db: DbExecutor, quotaKey: string, holder: string): Promise<void> {
  await db.execute(sql`UPDATE nango_records_slots SET holder = NULL, lease_until = NULL WHERE quota_key = ${quotaKey} AND holder = ${holder}`);
}
