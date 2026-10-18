/**
 * Backfill `calcom_booking` aliases onto calendar source_documents staged
 * before the mirror envelope learned to extract them.
 *
 * A Cal.com booking creates TWO distinct Google Calendar events for one real
 * meeting (different gcal event ids), but every copy carries the identical
 * cal.com/video|booking URL; its UID is the deterministic join key the v2
 * writer's bindUnambiguousCalcomAlias converges on. This script only adds the
 * alias to the document's `aliases` jsonb — NO graph writes; the next rebuild's
 * extraction/binding performs the actual Meeting convergence.
 *
 * Safe by construction: dry-run by default (prints per-tenant counts only);
 * `--apply` appends the alias ONLY to rows that do not already carry a
 * `calcom_booking` alias. No deletes, no overwrites, idempotent.
 *
 * Usage: npx tsx scripts/backfill-calcom-aliases.ts [--apply] [--tenant <tenant_id>]
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { CALCOM_BOOKING_ALIAS_KIND, calcomBookingUid } from "../src/mirror/calcom.js";

export interface BackfillExecutor {
  execute(query: unknown): Promise<unknown>;
}

export interface BackfillOptions {
  apply: boolean;
  tenantId?: string | null;
}

export interface BackfillReport {
  candidates: number;
  planned: number;
  updated: number;
  skippedByReason: Map<string, number>;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  aliases: unknown;
  content: string;
}

export function parseArgs(argv: readonly string[]): BackfillOptions {
  const apply = argv.includes("--apply");
  const tenantIndex = argv.indexOf("--tenant");
  const tenantId = tenantIndex >= 0 ? argv[tenantIndex + 1] ?? null : null;
  if (tenantIndex >= 0 && !tenantId) throw new Error("--tenant requires a tenant id");
  return { apply, tenantId };
}

export async function runCalcomAliasBackfill(
  executor: BackfillExecutor,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const tenantId = options.tenantId ?? null;
  // The cheap `cal.com/` containment check narrows the scan server-side; the
  // exact CALCOM_BOOKING_URL_PATTERN decision stays in one place (TS below).
  const rows = rowsFromExecute<CandidateRow>(await executor.execute(sql`
    SELECT document.id::text AS id, document.tenant_id, document.aliases, file.content
    FROM source_documents document
    JOIN mirror_files file
      ON file.user_id = document.tenant_id
     AND file.path = document.mirror_path
    WHERE lower(document.provider) = 'calendar'
      AND document.deleted_at IS NULL
      AND document.mirror_path IS NOT NULL
      AND position('cal.com/' in file.content) > 0
      AND (${tenantId}::text IS NULL OR document.tenant_id = ${tenantId})
    ORDER BY document.id
  `));

  const report: BackfillReport = {
    candidates: rows.length,
    planned: 0,
    updated: 0,
    skippedByReason: new Map(),
  };
  for (const row of rows) {
    const uid = calcomBookingUid(row.content);
    if (!uid) {
      skip(report, "no_booking_url_match");
      continue;
    }
    if (hasCalcomAlias(row.aliases)) {
      skip(report, "alias_already_present");
      continue;
    }
    report.planned += 1;
    if (!options.apply) continue;
    const alias = JSON.stringify([{ kind: CALCOM_BOOKING_ALIAS_KIND, value: uid }]);
    await executor.execute(sql`
      UPDATE source_documents
      SET aliases = COALESCE(aliases, '[]'::jsonb) || ${alias}::jsonb
      WHERE id = ${row.id}::uuid
        AND tenant_id = ${row.tenant_id}
        AND NOT (COALESCE(aliases, '[]'::jsonb) @> ${JSON.stringify([{ kind: CALCOM_BOOKING_ALIAS_KIND }])}::jsonb)
    `);
    report.updated += 1;
  }
  return report;
}

/** True when the row already carries ANY calcom_booking alias (never touched). */
export function hasCalcomAlias(aliases: unknown): boolean {
  const entries = Array.isArray(aliases)
    ? aliases
    : typeof aliases === "string"
      ? safeJsonArray(aliases)
      : [];
  return entries.some((entry) =>
    entry != null && typeof entry === "object"
    && (entry as { kind?: unknown }).kind === CALCOM_BOOKING_ALIAS_KIND);
}

function skip(report: BackfillReport, reason: string): void {
  report.skippedByReason.set(reason, (report.skippedByReason.get(reason) ?? 0) + 1);
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray((result as { rows: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { db, pgClient } = await import("../src/db/client.js");
  try {
    const report = await runCalcomAliasBackfill(db as unknown as BackfillExecutor, options);
    console.log(`mode=${options.apply ? "apply" : "dry-run"} tenant=${options.tenantId ?? "all"}`);
    console.log(`candidates=${report.candidates} planned=${report.planned} updated=${report.updated}`);
    for (const [reason, count] of report.skippedByReason) console.log(`skipped ${reason}=${count}`);
  } finally {
    await pgClient.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
