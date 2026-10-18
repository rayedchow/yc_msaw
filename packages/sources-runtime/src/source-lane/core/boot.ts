import { pgClient } from "../../db/client.js";
import { pendingSourceLaneMigrations } from "./migrations.js";

/** Entrypoint boot guard: refuse to run against a schema missing any planned source-lane migration. */
export async function assertSourceLaneMigrationsApplied(): Promise<void> {
  const pending = await pendingSourceLaneMigrations(pgClient);
  if (pending.length && process.env.ALLOW_PENDING_MIGRATIONS !== "1") {
    console.error(`[sources-runtime] pending migrations: ${pending.join(", ")} - run: npm run db:migrate`);
    process.exit(1);
  }
}

export function sourceLaneConfig(env: NodeJS.ProcessEnv = process.env) {
  const sha = env.SOURCES_RUNTIME_SERVICE_TOKEN_SHA256?.trim().toLowerCase();
  return {
    serviceTokenSha256: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : undefined,
    internalPort: env.SOURCES_RUNTIME_INTERNAL_PORT ? Number(env.SOURCES_RUNTIME_INTERNAL_PORT) : undefined,
    internalHost: env.SOURCES_RUNTIME_INTERNAL_HOST ?? "127.0.0.1",
  };
}
