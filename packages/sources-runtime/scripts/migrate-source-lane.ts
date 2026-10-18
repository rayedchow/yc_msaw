import postgres from "postgres";
import { applySourceLaneMigrations, planMigrations } from "../src/source-lane/core/migrations.js";

/** Apply the source-lane migration plan (donor subset + 9NNN lane files). Usage: DATABASE_URL=... npm run db:migrate */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const local = url.includes("localhost") || url.includes("127.0.0.1");
const sql = postgres(url, { ssl: local ? false : "require", max: 1, onnotice: () => {} });
try {
  const plan = planMigrations();
  for (const e of plan.excluded) console.log(`exclude ${e.file} (${e.reason})`);
  const applied = await applySourceLaneMigrations(sql, undefined, (m) => console.log(m));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : "migrations up to date");
} finally {
  await sql.end();
}
