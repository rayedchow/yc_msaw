/**
 * Gmail source-lane test harness: in-process PostgreSQL (PGlite) with the real donor source
 * migrations, core 9000-9002 and this provider's 9160 (so journal triggers, ON CONFLICT ordering
 * and numeric history-id comparisons run for real), plus a fake yc_msaw publish endpoint that
 * applies the exporter's wire batches to an in-memory file tree. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { INCLUDED_DONOR_MIGRATIONS, MIGRATIONS_DIR } from "../../../../src/source-lane/core/migrations.js";

export const pg = new PGlite();
export const db = drizzle(pg);

const LANE = ["9000_source_lane_export.sql", "9001_source_lane_donor_statements.sql", "9002_source_lane_tenant_locks.sql", "9160_gmail_source_lane.sql"];

export const ready: Promise<void> = (async () => {
  for (const file of [...INCLUDED_DONOR_MIGRATIONS, ...LANE]) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
})();

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

export async function resetAll(): Promise<void> {
  await pg.exec(`
    TRUNCATE gmail_source_quota, gmail_source_sync_state, gmail_source_chunks, gmail_source_blobs, gmail_source_messages,
      gmail_source_attachments, gmail_source_threads, gmail_source_history_pages, gmail_source_pending,
      source_lane_journal, source_lane_exported, source_lane_bindings, source_lane_tenant_locks, task_queue, connections, integration_tokens;
  `);
}

export async function connectMailbox(tenantId: string, mailbox: string, status = "active"): Promise<void> {
  await pg.query(
    `INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ($1, 'google', $2, $3)`,
    [tenantId, mailbox, status],
  );
}

export { FakePublishStore, bindingToken, type PublishedFile } from "./harness-publish.js";
