import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pgClient } from "./client.js";

/**
 * Boot guard: fail fast if any `drizzle/*.sql` migration hasn't been recorded
 * in `schema_migrations`. Prevents deploying app code against a stale schema
 * (e.g. a new table's job silently erroring per row). Every entrypoint calls
 * this before serving/consuming.
 *
 * Connection-class failures (timeouts, refused, DNS) are retried with backoff
 * before giving up: a briefly-overloaded database must not crash-loop every
 * entrypoint (observed live 2026-07-10: RDS burst-credit exhaustion turned
 * CONNECT_TIMEOUT into "migrations pending" exits and a sustained 503). Only
 * an actual missing `schema_migrations` relation means "never migrated".
 *
 * Set ALLOW_PENDING_MIGRATIONS=1 to downgrade to a loud warning instead of
 * aborting - for the rare case where you must boot ahead of a migration.
 */
const CONNECT_RETRY_ATTEMPTS = 6;
const CONNECT_RETRY_BASE_MS = 2_000;
const CONNECT_RETRY_CAP_MS = 30_000;

export async function assertMigrationsApplied(): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set<string>();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const rows = await pgClient<{ name: string }[]>`SELECT name FROM schema_migrations`;
      for (const row of rows) applied.add(row.name);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMissingRelationError(err)) {
        // schema_migrations itself missing means nothing has ever been migrated.
        fail([`schema_migrations table not found (${message}) - run: npm run db:migrate`]);
        return;
      }
      if (!isConnectionError(err)) {
        fail([`migration check failed (${message})`]);
        return;
      }
      if (attempt >= CONNECT_RETRY_ATTEMPTS) {
        fail([`database unreachable while checking migrations after ${attempt} attempts (${message})`]);
        return;
      }
      const delayMs = Math.min(CONNECT_RETRY_BASE_MS * 2 ** (attempt - 1), CONNECT_RETRY_CAP_MS);
      console.warn(
        `migration check: database unreachable (${message}) - retry ${attempt}/${CONNECT_RETRY_ATTEMPTS - 1} in ${Math.round(delayMs / 1000)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(`migrations up to date (${files.length} applied)`);
    return;
  }
  fail([
    `${pending.length} pending migration(s) not applied:`,
    ...pending.map((f) => `  - ${f}`),
    "Run: npm run db:migrate",
  ]);
}

/** Connection-class failures worth retrying: transport errors and Postgres "try again" states. */
function isConnectionError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && [
    "CONNECT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
    "57P03", // cannot_connect_now (startup/shutdown)
    "53300", // too_many_connections
  ].includes(code)) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /connect|timeout|timed out|refused|reset|unreachable/i.test(message);
}

/** Postgres 42P01 undefined_table - the only error that means "never migrated". */
function isMissingRelationError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "42P01") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /relation "schema_migrations" does not exist/i.test(message);
}

function fail(lines: string[]): void {
  const banner = ["", "!!! DATABASE MIGRATIONS PENDING - refusing to start !!!", ...lines, ""].join("\n");
  if (process.env.ALLOW_PENDING_MIGRATIONS === "1") {
    console.warn(banner + "\n(ALLOW_PENDING_MIGRATIONS=1 set - continuing anyway)");
    return;
  }
  console.error(banner);
  process.exit(1);
}
