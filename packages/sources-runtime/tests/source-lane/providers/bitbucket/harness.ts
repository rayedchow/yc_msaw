/**
 * Bitbucket lane test harness: in-process PostgreSQL (PGlite) with the real donor source
 * migrations, core 9000-9002 and this provider's 9350/9351 (journal triggers, ON CONFLICT,
 * transactions and bytea run for real). Synthetic data only.
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
  "9350_bitbucket_source_lane.sql",
  "9351_bitbucket_content_schedules.sql",
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
    TRUNCATE bitbucket_source_quota, bitbucket_source_connections, bitbucket_source_selection, bitbucket_source_repos, bitbucket_source_refs,
      bitbucket_source_scan_dirs, bitbucket_source_scan_entries, bitbucket_source_files, bitbucket_source_snapshots, bitbucket_source_chunks,
      bitbucket_source_blobs, source_lane_journal, source_lane_exported, source_lane_bindings, source_lane_tenant_locks,
      activity_events, mirror_files, conversation_watermarks, task_queue, task_schedules, connections;
  `);
}

/** The donor `connections` row Nango connect/reconcile writes (one Bitbucket connection per tenant). */
export async function connect(tenantId: string, connectionId: string, providerConfigKey = "bitbucket", status = "active"): Promise<void> {
  await pg.query(`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES ($1, 'bitbucket', $2, $3, $4::jsonb)`, [
    tenantId,
    connectionId,
    status,
    JSON.stringify({ authMode: "nango", providerConfigKey, nangoConnectionId: connectionId }),
  ]);
}
