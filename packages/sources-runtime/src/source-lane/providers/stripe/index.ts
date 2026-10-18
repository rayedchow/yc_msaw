/**
 * Stripe source provider. Raw events (activity_events, source `stripe`, one file per event under the
 * default raw layout `sources/stripe/_raw/account:<acct>/<type>:<id>/<yyyy-mm>/<evt>.json`) plus the current
 * object snapshots exported from `stripe_object_snapshots`:
 *
 *   sources/stripe/<acct>/<live|test>/<resource>/<objectId>.json   (exact post-redaction object JSON)
 *
 * A snapshot that was deleted at Stripe (or vanished from a completed listing) becomes a tombstone, and
 * earlier versions stay in history. Collection: src/integrations/stripe/*.
 */
import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourceProviderModule } from "../../core/types.js";
import { DONOR } from "../../core/donor.js";
import { stripeCoverage } from "./coverage.js";

export const STRIPE_SNAPSHOT_TABLE = "stripe_object_snapshots";

interface SnapshotRow {
  id: string;
  account_id: string;
  livemode: boolean;
  resource: string;
  object_id: string;
  payload_text: string;
  source_order: string | number;
  observed_at: string | Date;
  deleted: boolean;
  deleted_reason: string | null;
  connection_id: string;
}

const segment = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");

export function stripeSnapshotPath(row: Pick<SnapshotRow, "account_id" | "livemode" | "resource" | "object_id">): string {
  return `sources/stripe/${segment(row.account_id)}/${row.livemode ? "live" : "test"}/${segment(row.resource)}/${segment(row.object_id)}.json`;
}

const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();

export const stripeSnapshotsExport: ExtraTableExport = {
  table: STRIPE_SNAPSHOT_TABLE,
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
    const result = await ctx.executor.execute(sql`
      SELECT id, account_id, livemode, resource, object_id, payload::text AS payload_text, source_order, observed_at,
             deleted, deleted_reason, connection_id
      FROM stripe_object_snapshots WHERE tenant_id = ${ctx.tenantId} AND id = ${rowKey}
    `);
    const row = ((Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) ?? [])[0] as SnapshotRow | undefined;
    if (!row) {
      return previousPaths.map((path) => ({ op: "delete" as const, path, deletedAt: journal.enqueuedAt, reason: "snapshot_row_deleted", capturedAt: journal.enqueuedAt }));
    }
    const path = stripeSnapshotPath(row);
    const order = Number(row.source_order);
    const provenance = {
      runtime: "stripe source lane",
      donor: `${DONOR.repo}@${DONOR.commit}`,
      port: "askshepherd/gigabrain@5448774e0a121570666adaa0c8ca18570df72be9 brain/src/integrations/stripe",
      externalId: row.object_id,
      account: row.account_id,
      connectionId: row.connection_id,
      resource: row.resource,
    };
    if (row.deleted) {
      return [{ op: "delete", path, deletedAt: new Date(order * 1000).toISOString(), reason: row.deleted_reason ?? "deleted", capturedAt: iso(row.observed_at), provenance }];
    }
    return [{
      op: "put",
      path,
      kind: "raw",
      contentType: "application/json",
      content: Buffer.from(row.payload_text, "utf8"),
      sourceUpdatedAt: new Date(order * 1000).toISOString(),
      capturedAt: iso(row.observed_at),
      sourceVersion: { ref: `order:${order}`, ordinal: order },
      provenance,
    }];
  },
};

export const stripeProvider: SourceProviderModule = {
  id: "stripe",
  eventSources: ["stripe"],
  mirrorRoots: [],
  connectionProviders: ["stripe"],
  extraTables: [stripeSnapshotsExport],
  coverage: (ctx: ExportContext): Promise<CoverageReport[]> => stripeCoverage(ctx),
};
