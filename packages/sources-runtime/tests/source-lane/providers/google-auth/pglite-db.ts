import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { INCLUDED_DONOR_MIGRATIONS, MIGRATIONS_DIR } from "../../../../src/source-lane/core/migrations.js";

/**
 * In-process PostgreSQL (PGlite) with the real source-lane donor migrations plus
 * this agent's 9150 migration, so the production SQL (conditional state
 * consumption, FOR UPDATE refresh, ON CONFLICT upserts) runs for real.
 * Used as the `db` export of a mocked src/db/client.js.
 */
export async function createGoogleAuthTestDb() {
  const client = new PGlite();
  for (const file of [...INCLUDED_DONOR_MIGRATIONS, "9150_google_auth_grants.sql"]) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  const db = drizzle(client);
  return { client, db };
}

export async function resetGoogleAuthTables(client: PGlite): Promise<void> {
  await client.exec(`
    TRUNCATE google_oauth_states, google_oauth_grants, connections, integration_tokens;
  `);
}
