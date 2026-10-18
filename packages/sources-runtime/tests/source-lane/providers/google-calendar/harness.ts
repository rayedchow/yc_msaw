/**
 * Test harness for the calendar and contacts lanes: in-process PostgreSQL (PGlite) with
 * the real source-lane migration plan (donor subset + core 9000-9002 + every lane file,
 * including 9175), used as the drizzle `db` of a mocked src/db/client.js so the donor
 * storeCalendarEvent, the materializer, the lane and the exporter all run real SQL.
 * Google is the stateful in-memory fake of fake-google.ts. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";

export const pg = new PGlite();
export const db = drizzle(pg);

export const ready: Promise<void> = (async () => {
  for (const file of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
})();

export async function query<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

const TENANT_TABLES: Array<[string, string]> = [
  // Snapshots before revisions: deleting a snapshot appends a 'removed' revision (trigger).
  ["google_calendar_event_snapshots", "user_id"],
  ["google_calendar_event_revisions", "tenant_id"],
  ["google_calendar_lane_cursors", "tenant_id"],
  ["google_calendar_watch_channels", "user_id"],
  ["google_source_mailbox_status", "tenant_id"],
  ["google_contact_snapshots", "tenant_id"],
  ["google_contact_revisions", "tenant_id"],
  ["google_contact_lane_cursors", "tenant_id"],
  ["google_contact_names", "tenant_id"],
  ["activity_events", "user_id"],
  ["mirror_files", "user_id"],
  ["connections", "tenant_id"],
  ["integration_tokens", "user_id"],
  ["source_lane_journal", "tenant_id"],
  ["source_lane_exported", "tenant_id"],
  ["source_lane_bindings", "tenant_id"],
  ["source_lane_tenant_locks", "tenant_id"],
];

export async function resetTenant(...tenants: string[]): Promise<void> {
  for (const tenant of tenants) {
    for (const [table, column] of TENANT_TABLES) await pg.query(`DELETE FROM ${table} WHERE ${column} = $1`, [tenant]);
  }
}

export async function connectMailbox(tenantId: string, email: string, status = "active"): Promise<void> {
  await pg.query(
    `INSERT INTO connections (tenant_id, provider, status, external_account_id) VALUES ($1, 'google', $2, $3)`,
    [tenantId, status, email],
  );
}

export async function seedDwdAdmin(tenantId: string, adminEmail: string): Promise<void> {
  await pg.query(
    `INSERT INTO integration_tokens (user_id, provider, access_token, metadata) VALUES ($1, 'google', 'enc-placeholder', $2::jsonb)`,
    [tenantId, JSON.stringify({ delegation: true, authMode: "domain_wide_delegation", email: adminEmail })],
  );
}

export * from "./fake-google.js";
