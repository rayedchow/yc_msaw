/**
 * Confluence lane test harness: in-process PostgreSQL (PGlite) with the real donor
 * source migrations, core 9000-9002 and this provider's 9200/9201 (journal triggers,
 * ON CONFLICT and bytea run for real); the publish target is the real yc_msaw
 * SourceStore (./yc-store.ts). Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { INCLUDED_DONOR_MIGRATIONS, MIGRATIONS_DIR } from "../../../../src/source-lane/core/migrations.js";

export const pg = new PGlite();
export const db = drizzle(pg);

const LANE = ["9000_source_lane_export.sql", "9001_source_lane_donor_statements.sql", "9002_source_lane_tenant_locks.sql", "9200_confluence_source_lane.sql", "9201_confluence_sweep_schedules.sql"];

export const ready: Promise<void> = (async () => {
  for (const file of [...INCLUDED_DONOR_MIGRATIONS, ...LANE]) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
})();

export async function query<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

export async function resetAll(): Promise<void> {
  await pg.exec(`
    TRUNCATE confluence_source_quota, confluence_source_connections, confluence_source_sites, confluence_source_sync_state, confluence_source_work, confluence_source_objects,
      confluence_source_records, confluence_source_chunks, confluence_source_blobs,
      source_lane_journal, source_lane_exported, source_lane_bindings, source_lane_tenant_locks,
      activity_events, mirror_files, conversation_watermarks, task_queue, task_schedules, connections;
  `);
}

export async function connect(tenantId: string, connectionId: string, providerConfigKey = "confluence", status = "active"): Promise<void> {
  await pg.query(
    `INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES ($1, 'confluence', $2, $3, $4::jsonb)`,
    [tenantId, connectionId, status, JSON.stringify({ providerConfigKey, nangoConnectionId: connectionId })],
  );
}

export { bindingToken, YcStore, type StoredFile } from "./yc-store.js";
