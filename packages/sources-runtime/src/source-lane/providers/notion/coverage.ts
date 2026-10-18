import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { isoOrNull, listConnections, listSyncStates, rowsOf, workCounts, type Scope } from "./store.js";

/**
 * Truthful Notion coverage from durable state only (no static claims):
 *
 *  - `workspace:<ws>/<connection>` (current state of everything the connection can read):
 *      complete only when the last full pass closed with zero failed items and is recent,
 *      the delta poll is current, every live page's last walk completed, every data source
 *      query completed, no paginated property or comment listing failed, comments are
 *      readable, every Notion-hosted file's bytes are stored and no work item failed;
 *      otherwise partial (every gap listed), blocked (auth / token / replaced connection)
 *      or pending (first pass not finished).
 *  - `workspace:<ws>/<connection>:history`: always partial - the Notion API has no page or
 *      block version history; edits are captured as observed (delta poll + webhook hints),
 *      several edits between observations collapse, last_edited_time is minute-granular.
 *  - `donor-lane`: the unchanged donor poll/render lane (sources/notion/<Title>-page-<id>/,
 *      notion activity_events) is bounded (300 pages per poll, walker caps) - partial.
 */

export interface CoverageOptions {
  now?: Date;
  fullScanIntervalMs?: number;
  deltaIntervalMs?: number;
}

function ago(v: unknown, now: number): number {
  const iso = isoOrNull(v);
  return iso ? now - new Date(iso).getTime() : Number.POSITIVE_INFINITY;
}

async function counts(ctx: ExportContext, scope: Scope): Promise<Record<string, number>> {
  const q = async (text: ReturnType<typeof sql>): Promise<Record<string, number>> => {
    const r = rowsOf<Record<string, unknown>>(await ctx.executor.execute(text))[0] ?? {};
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v ?? 0)]));
  };
  const t = scope.tenantId;
  const c = scope.connectionId;
  return {
    ...(await q(sql`
      SELECT count(*) FILTER (WHERE object_type = 'page' AND tombstoned_at IS NULL) AS pages,
             count(*) FILTER (WHERE object_type = 'page' AND tombstoned_at IS NULL AND parent_type = 'data_source_id') AS rows,
             count(*) FILTER (WHERE object_type = 'data_source' AND tombstoned_at IS NULL) AS data_sources,
             count(*) FILTER (WHERE object_type = 'database' AND tombstoned_at IS NULL) AS databases,
             count(*) FILTER (WHERE tombstoned_at IS NOT NULL) AS tombstoned,
             count(*) FILTER (WHERE inaccessible_at IS NOT NULL) AS inaccessible,
             count(*) FILTER (WHERE object_type = 'page' AND tombstoned_at IS NULL AND inaccessible_at IS NULL AND COALESCE(walk_status, '') <> 'complete') AS pages_not_fully_walked,
             count(*) FILTER (WHERE object_type = 'page' AND tombstoned_at IS NULL AND properties_status = 'partial') AS pages_properties_partial,
             count(*) FILTER (WHERE object_type = 'page' AND tombstoned_at IS NULL AND comments_status = 'forbidden') AS pages_comments_forbidden,
             count(*) FILTER (WHERE object_type = 'data_source' AND tombstoned_at IS NULL AND COALESCE(query_status, '') <> 'complete') AS data_sources_not_fully_queried
      FROM notion_source_nodes WHERE tenant_id = ${t} AND connection_id = ${c}`)),
    ...(await q(sql`SELECT count(*) FILTER (WHERE tombstoned_at IS NULL) AS blocks FROM notion_source_blocks WHERE tenant_id = ${t} AND connection_id = ${c}`)),
    ...(await q(sql`
      SELECT count(*) FILTER (WHERE status = 'open') AS comments_open, count(*) FILTER (WHERE status = 'resolved') AS comments_resolved,
             count(*) FILTER (WHERE status = 'deleted') AS comments_deleted
      FROM notion_source_comments WHERE tenant_id = ${t} AND connection_id = ${c}`)),
    ...(await q(sql`
      SELECT count(*) FILTER (WHERE status = 'stored') AS files_stored, count(*) FILTER (WHERE status IN ('pending', 'failed')) AS files_missing,
             count(*) FILTER (WHERE status = 'too_large') AS files_too_large, count(*) FILTER (WHERE status = 'host_refused') AS files_host_refused,
             count(*) FILTER (WHERE status = 'external') AS files_external, count(*) FILTER (WHERE status = 'unsupported') AS files_unsupported
      FROM notion_source_files WHERE tenant_id = ${t} AND connection_id = ${c} AND tombstoned_at IS NULL`)),
    ...(await q(sql`SELECT count(*) AS raw_records FROM notion_source_records WHERE tenant_id = ${t} AND connection_id = ${c}`)),
  };
}

export async function notionCoverage(ctx: ExportContext, opts: CoverageOptions = {}): Promise<CoverageReport[]> {
  const now = (opts.now ?? new Date()).getTime();
  const fullEvery = opts.fullScanIntervalMs ?? Number(process.env.NOTION_SOURCE_FULL_SCAN_INTERVAL_MS ?? 24 * 3600_000);
  const deltaEvery = opts.deltaIntervalMs ?? 60_000;
  const out: CoverageReport[] = [];
  const conns = new Map((await listConnections(ctx.executor, ctx.tenantId)).map((c) => [c.connection_id, c]));
  for (const s of await listSyncStates(ctx.executor, ctx.tenantId)) {
    const scope = { tenantId: ctx.tenantId, connectionId: s.connection_id };
    const conn = conns.get(s.connection_id);
    const ws = conn?.workspace_id ?? "unknown-workspace";
    const scopeName = `workspace:${ws}/${s.connection_id}`;
    const c = await counts(ctx, scope);
    const work = await workCounts(ctx.executor, scope);
    const all = { ...c, work_pending: work.pending ?? 0, work_failed: work.failed ?? 0, work_inaccessible: work.inaccessible ?? 0, generation: Number(s.generation) };
    const base = {
      provider: "notion",
      scope: scopeName,
      cursor: `generation ${s.generation} ${s.generation_phase}`,
      ...(isoOrNull(s.last_success_at) ? { lastSuccessAt: isoOrNull(s.last_success_at)! } : {}),
      ...(isoOrNull(s.last_error_at) ? { lastErrorAt: isoOrNull(s.last_error_at)!, lastError: s.last_error ?? undefined } : {}),
      counts: all,
    };
    if (conn && conn.status !== "active") {
      out.push({ ...base, state: "blocked", reason: `connection ${conn.status}: ${conn.status_reason ?? "unknown"}; captured content is kept` });
    } else if (s.blocked_code) {
      out.push({ ...base, state: "blocked", reason: `${s.blocked_code}: ${s.blocked_reason ?? ""}`.trim() });
    } else if (s.full_complete_generation === null && (s.generation_phase !== "closed" || Number(s.generation) === 0)) {
      out.push({ ...base, state: "pending", reason: `first full pass in progress (generation ${s.generation}, ${s.generation_phase}; ${all.work_pending} items pending)` });
    } else {
      const gaps: string[] = [];
      const lastFull = Number(s.full_complete_generation ?? 0);
      if (lastFull !== Number(s.generation) || s.generation_phase !== "closed") {
        gaps.push(s.generation_phase !== "closed" ? `full pass ${s.generation} in progress (${s.generation_phase})` : `last full pass ${s.generation} closed with ${s.generation_failed_items} failed item(s)`);
      }
      if (ago(s.full_complete_at, now) > 2 * fullEvery) gaps.push(`last complete full pass is older than ${Math.round((2 * fullEvery) / 3600_000)}h`);
      if (ago(s.delta_checked_at, now) > Math.max(15 * 60_000, 5 * deltaEvery)) gaps.push(`change poll lagging (last check ${isoOrNull(s.delta_checked_at) ?? "never"})`);
      if (c.pages_not_fully_walked) gaps.push(`${c.pages_not_fully_walked} page(s) not completely walked yet`);
      if (c.data_sources_not_fully_queried) gaps.push(`${c.data_sources_not_fully_queried} data source(s) not completely queried`);
      if (c.pages_properties_partial) gaps.push(`${c.pages_properties_partial} page(s) with paginated properties that failed to load`);
      if (c.pages_comments_forbidden || (conn?.capabilities && "comments" in conn.capabilities)) gaps.push("comments are not readable by this connection (read comments capability missing)");
      if (process.env.NOTION_SOURCE_BLOCK_COMMENTS === "0") gaps.push("block-level comments are disabled (NOTION_SOURCE_BLOCK_COMMENTS=0); only page-level comments are captured");
      if (c.files_missing) gaps.push(`${c.files_missing} Notion-hosted file(s) without stored bytes yet`);
      if (c.files_too_large) gaps.push(`${c.files_too_large} file(s) over the byte limit (metadata only)`);
      if (c.files_host_refused) gaps.push(`${c.files_host_refused} file(s) on non-allowlisted hosts (metadata only)`);
      if (all.work_failed) gaps.push(`${all.work_failed} work item(s) failed`);
      if (c.inaccessible) gaps.push(`${c.inaccessible} object(s) answered 403 (kept, not refreshed)`);
      out.push(gaps.length
        ? { ...base, state: "partial", reason: gaps.join("; ") }
        : { ...base, state: "complete", reason: "every page, block, comment, data source row and Notion-hosted file reachable through search and recursive traversal is captured; external file links are recorded, not fetched" });
    }
    out.push({
      provider: "notion",
      scope: `${scopeName}:history`,
      state: "partial",
      reason: "Notion's API exposes no page/block version history: edits are captured as observed (change poll + webhook hints); several edits between observations collapse and last_edited_time has minute granularity",
      ...(isoOrNull(s.last_success_at) ? { lastSuccessAt: isoOrNull(s.last_success_at)! } : {}),
      counts: { raw_records: c.raw_records ?? 0, comments_deleted: c.comments_deleted ?? 0, tombstoned: c.tombstoned ?? 0 },
    });
  }
  // Donor lane (unchanged): bounded latest-state projections.
  const donor = rowsOf<{ last_ok: unknown; last_fail: unknown; err: string | null }>(await ctx.executor.execute(sql`
    SELECT max(completed_at) FILTER (WHERE status = 'completed') AS last_ok, max(failed_at) FILTER (WHERE status = 'failed') AS last_fail,
           (SELECT error_message FROM source_sync_runs WHERE user_id = ${ctx.tenantId} AND provider = 'notion' AND status = 'failed' ORDER BY failed_at DESC NULLS LAST LIMIT 1) AS err
    FROM source_sync_runs WHERE user_id = ${ctx.tenantId} AND provider = 'notion'
  `))[0];
  if (donor && (donor.last_ok || donor.last_fail)) {
    out.push({
      provider: "notion",
      scope: "donor-lane",
      state: "partial",
      reason: "donor notion.poll/notion.render projections (sources/notion/<Title>-page-<id>/) are bounded: 300 pages per poll, 5000 blocks / 100 comments / 500 inline rows per render; the workspace scope above is the complete lane",
      ...(isoOrNull(donor.last_ok) ? { lastSuccessAt: isoOrNull(donor.last_ok)! } : {}),
      ...(isoOrNull(donor.last_fail) ? { lastErrorAt: isoOrNull(donor.last_fail)!, lastError: donor.err ?? undefined } : {}),
    });
  }
  return out;
}
