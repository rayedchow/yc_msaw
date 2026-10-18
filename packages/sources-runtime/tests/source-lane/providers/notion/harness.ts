/**
 * Notion lane test harness: in-process PostgreSQL (PGlite) with the real donor source
 * migrations, core 9000-9002 and this provider's 9450/9451 (journal triggers, ON CONFLICT,
 * row-value IN and bytea run for real). The publish target is the real yc_msaw SourceStore
 * (./yc-store.ts). Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { INCLUDED_DONOR_MIGRATIONS, MIGRATIONS_DIR } from "../../../../src/source-lane/core/migrations.js";

export const pg = new PGlite();
export const db = drizzle(pg);

export const LANE_MIGRATIONS = [
  "9000_source_lane_export.sql",
  "9001_source_lane_donor_statements.sql",
  "9002_source_lane_tenant_locks.sql",
  "9450_notion_source_lane.sql",
  "9451_notion_source_schedules.sql",
];

export const ready: Promise<void> = (async () => {
  for (const file of [...INCLUDED_DONOR_MIGRATIONS, ...LANE_MIGRATIONS]) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
})();

export async function query<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

export async function resetAll(): Promise<void> {
  await pg.exec(`
    TRUNCATE notion_source_quota, notion_source_connections, notion_source_sync_state, notion_source_work, notion_source_nodes,
      notion_source_blocks, notion_source_comments, notion_source_files, notion_source_block_versions, notion_source_records,
      notion_source_chunks, notion_source_blobs,
      source_lane_journal, source_lane_exported, source_lane_bindings, source_lane_tenant_locks,
      activity_events, mirror_files, task_queue, task_schedules, connections, source_sync_runs;
  `);
}

export { bindingToken, YcStore, type StoredFile } from "./yc-store.js";
