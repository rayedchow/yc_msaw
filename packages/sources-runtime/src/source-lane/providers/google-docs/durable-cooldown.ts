/**
 * Durable Google Retry-After floor for the legacy donor Google Docs tasks.
 *
 * gFetch (polling/_archived-gdocs/gdocs-api.ts) and fetchDocContent (integrations/google/gdocs/content.ts) keep the
 * donor's in-process cooldown map, which a restart or a second worker process does not see. Every rate limit they
 * receive is also written here (migration 10550), keyed exactly like the in-process map, and read before every call,
 * so no process calls Google before the floor. The floor is measured on the database clock and only moves later.
 * The source-lane Docs paths persist their own floors in their checkpoints and do not use this table.
 */
import { sql, type SQL } from "drizzle-orm";
import { GoogleRateLimitError } from "../../../vault/google-rate-limit.js";

interface Executor {
  execute(query: SQL): Promise<unknown>;
}

let defaultDb: Promise<Executor> | null = null;

function dbOf(db?: Executor): Promise<Executor> {
  if (db) return Promise.resolve(db);
  defaultDb ??= import("../../../db/client.js").then((m) => m.db as unknown as Executor);
  return defaultDb;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** Throws a `cooldown` GoogleRateLimitError when any key is held by a floor some process recorded. */
export async function throwIfGoogleCooldownDurable(keys: readonly string[], db?: Executor): Promise<void> {
  if (!keys.length) return;
  const [row] = rowsOf<{ service_key: string; remaining_ms: string | number }>(await (await dbOf(db)).execute(sql`
    SELECT service_key, ceil(extract(epoch FROM blocked_until - now()) * 1000) AS remaining_ms
    FROM google_rate_limit_cooldowns
    WHERE service_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) AND blocked_until > now()
    ORDER BY blocked_until DESC
    LIMIT 1`));
  if (row) throw new GoogleRateLimitError(row.service_key, 429, Math.max(1, Math.ceil(Number(row.remaining_ms) / 1000)), "cooldown");
}

/** Records the floor of a rate limit Google returned (`err.service` is the cooldown key it was raised under). */
export async function recordGoogleCooldownDurable(err: GoogleRateLimitError, db?: Executor): Promise<void> {
  await (await dbOf(db)).execute(sql`
    INSERT INTO google_rate_limit_cooldowns (service_key, blocked_until, last_status, last_reason, last_retry_after_seconds, updated_at)
    VALUES (${err.service}, now() + make_interval(secs => ${err.retryAfterSeconds}::double precision), ${err.status}, ${err.reason}, ${err.retryAfterSeconds}, now())
    ON CONFLICT (service_key) DO UPDATE SET
      blocked_until = GREATEST(google_rate_limit_cooldowns.blocked_until, EXCLUDED.blocked_until),
      last_status = EXCLUDED.last_status,
      last_reason = EXCLUDED.last_reason,
      last_retry_after_seconds = EXCLUDED.last_retry_after_seconds,
      updated_at = now()`);
}
