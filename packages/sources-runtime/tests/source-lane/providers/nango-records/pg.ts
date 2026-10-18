import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";

/**
 * In-process PostgreSQL (PGlite) with the real source-lane migration plan: the donor source
 * migrations, core 9000-9099 and this lane's 9650-9699 (other agents' ranges are skipped so a
 * concurrent agent's work in progress cannot break these tests). Imported by the db/client
 * mock, so donor code that uses the module-level `db` (outbox writes) hits the same database.
 */
export const pg = new PGlite();
const drizzled = drizzle(pg);

/**
 * Production uses postgres-js, whose execute() resolves to a RowList (an array of rows with
 * `count`); donor queue/outbox code relies on that. PGlite's drizzle resolves to {rows}, so the
 * executor is adapted to the production result shape.
 */
export const db = {
  execute: async (query: Parameters<typeof drizzled.execute>[0]) => {
    const r = (await drizzled.execute(query)) as unknown as { rows: Record<string, unknown>[]; affectedRows?: number };
    return Object.assign([...r.rows], { count: r.affectedRows ?? r.rows.length });
  },
};

const OWN = /^(90\d\d|96[5-9]\d)_/;

export const ready: Promise<void> = (async () => {
  for (const file of planMigrations().apply) {
    if (/^9\d{3}_/.test(file) && !OWN.test(file)) continue;
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
})();
