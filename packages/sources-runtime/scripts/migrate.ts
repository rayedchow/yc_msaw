import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Minimal forward-only migration runner: applies every `drizzle/*.sql` file
 * in filename order, exactly once, recording applied files in
 * `schema_migrations`. Each migration runs inside a transaction.
 *
 * Usage: DATABASE_URL=postgres://... npm run db:migrate
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const isLocal = databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1");
const sql = postgres(databaseUrl, { ssl: isLocal ? false : "require", max: 1 });

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  for (const file of files) {
    const [already] = await sql`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
    if (already) {
      console.log(`skip    ${file} (already applied)`);
      continue;
    }
    const ddl = readFileSync(join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`applied ${file}`);
  }

  console.log("migrations up to date");
} finally {
  await sql.end();
}
