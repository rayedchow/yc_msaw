import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { quotaKeyFor } from "./identity.js";
import { getDiscovery, isoOrNull, listSites, listSyncStates, quotaBlockedUntil, rowsOf, workCounts } from "./store.js";
import { confluenceConnections } from "./sweep.js";

/**
 * Truthful Confluence coverage per (connection, site), from durable state only.
 *
 * `site:<cloudId>/<connectionId>` (current state: spaces, pages, blog posts,
 * comments, attachments with bytes, permissions/restrictions) is `complete`
 * only when the last full pass finished without failed items, every live
 * attachment's bytes are stored, permissions and restrictions were readable,
 * the delta check is current and the full pass is recent. Anything else is
 * `partial` (with every gap listed) / `pending` / `blocked`.
 *
 * `...:history` is never `complete`: page and blog post version bodies are
 * fetched from the version API (counted), but comment and attachment versions
 * older than the first observation are not retrievable through the APIs this
 * lane uses. `nango-records` reports the donor /records lane, which holds the
 * latest state per record only.
 */

const PROVIDER = "confluence";

export interface CoverageOptions {
  deltaIntervalMs?: number;
  fullScanIntervalMs?: number;
}

export async function confluenceCoverage(ctx: ExportContext, options: CoverageOptions = {}): Promise<CoverageReport[]> {
  const deltaInterval = options.deltaIntervalMs ?? 5 * 60_000;
  const fullInterval = options.fullScanIntervalMs ?? Number(process.env.CONFLUENCE_SOURCE_FULL_SCAN_INTERVAL_MS ?? 24 * 60 * 60_000);
  const reports: CoverageReport[] = [];
  const conns = await confluenceConnections(ctx.executor, ctx.tenantId);
  const states = await listSyncStates(ctx.executor, ctx.tenantId);
  for (const conn of conns) {
    if (conn.status !== "active") {
      reports.push({ provider: PROVIDER, scope: `connection:${conn.connectionId}`, state: "blocked", reason: `Confluence connection is ${conn.status}; captured content is kept, nothing new is fetched` });
      continue;
    }
    const sites = await listSites(ctx.executor, ctx.tenantId, conn.connectionId);
    const discovery = await getDiscovery(ctx.executor, ctx.tenantId, conn.connectionId);
    if (discovery?.status === "blocked") {
      reports.push({ provider: PROVIDER, scope: `connection:${conn.connectionId}`, state: "blocked", reason: discovery.reason ?? "site discovery blocked", lastErrorAt: isoOrNull(discovery.checked_at) ?? undefined, lastError: discovery.reason ?? undefined });
      if (!sites.length) continue;
    }
    if (!sites.length) {
      reports.push({ provider: PROVIDER, scope: `connection:${conn.connectionId}`, state: "pending", reason: discovery?.reason ? `site discovery failed: ${discovery.reason}` : "no Confluence site discovered yet for this connection (deep sweep has not reached accessible-resources)" });
      continue;
    }
    for (const site of sites) {
      const scope = { tenantId: ctx.tenantId, connectionId: conn.connectionId, cloudId: site.cloud_id };
      const st = states.find((s) => s.connection_id === conn.connectionId && s.cloud_id === site.cloud_id) ?? null;
      const name = `site:${site.cloud_id}/${conn.connectionId}`;
      const c = await siteCounts(ctx, scope);
      const work = st ? await workCounts(ctx.executor, scope, st.generation) : { pending: 0, done: 0, failed: 0, inaccessible: 0 };
      const counts: Record<string, number> = { ...c, workPending: work.pending ?? 0, workFailed: work.failed ?? 0, workInaccessible: work.inaccessible ?? 0, generation: st?.generation ?? 0 };
      const common = {
        provider: PROVIDER,
        counts,
        ...(st?.last_success_at ? { lastSuccessAt: isoOrNull(st.last_success_at)! } : {}),
        ...(st?.last_error_at ? { lastErrorAt: isoOrNull(st.last_error_at)!, lastError: st.last_error ?? undefined } : {}),
        ...(st ? { cursor: `generation ${st.generation} ${st.generation_phase}; full complete ${st.full_complete_generation ?? "never"}; delta watermark ${isoOrNull(st.delta_watermark) ?? "none"}` } : {}),
      };
      if (site.status !== "active") {
        reports.push({ ...common, scope: name, state: "blocked", reason: site.status === "removed" ? `site no longer reachable through this grant: ${site.status_reason ?? "removed"}` : `site blocked: ${site.status_reason ?? "authorization failed"}` });
        continue;
      }
      if (st?.blocked_code) {
        reports.push({ ...common, scope: name, state: "blocked", reason: st.blocked_reason ?? st.blocked_code });
        continue;
      }
      if (!st || st.generation === 0) {
        reports.push({ ...common, scope: name, state: "pending", reason: "deep sweep has not started for this site" });
        continue;
      }
      const gaps: string[] = [];
      const cooldown = await quotaBlockedUntil(ctx.executor, quotaKeyFor(conn.providerConfigKey, site.cloud_id));
      if (cooldown) gaps.push(`Atlassian rate limit cooldown until ${cooldown.toISOString()}`);
      if (st.full_complete_generation === null) gaps.push(`initial full inventory in progress (${work.pending ?? 0} work item(s) pending)`);
      else if (st.full_complete_generation < st.generation && st.generation_phase !== "closed") gaps.push(`full pass ${st.generation} in progress; last complete pass ${st.full_complete_generation}`);
      if (st.generation_phase === "closed" && st.full_complete_generation !== st.generation) gaps.push(`full pass ${st.generation} finished with ${st.generation_failed_items} failed item(s); deletions are only confirmed for listings that completed`);
      if ((work.failed ?? 0) > 0) gaps.push(`${work.failed} work item(s) failed after retries`);
      if (c.attachmentsNotStored > 0) gaps.push(`${c.attachmentsNotStored} live attachment(s) without current bytes (${c.attachmentsTooLarge} over the size limit, ${c.attachmentsForbidden} forbidden, ${c.attachmentsPending} pending)`);
      if (c.inaccessible > 0) gaps.push(`${c.inaccessible} object(s) no longer readable by this grant (kept as last captured)`);
      if (c.restrictionsMissing > 0) gaps.push(`page restrictions not captured for ${c.restrictionsMissing} page(s)/blog post(s)`);
      if (c.permissionsMissing > 0) gaps.push(`space permissions not captured for ${c.permissionsMissing} space(s)`);
      const now = Date.now();
      const deltaAt = st.delta_checked_at ? new Date(String(st.delta_checked_at)).getTime() : 0;
      if (now - deltaAt > 3 * deltaInterval) gaps.push(`delta check lags: last completed ${isoOrNull(st.delta_checked_at) ?? "never"}`);
      const fullAt = st.full_complete_at ? new Date(String(st.full_complete_at)).getTime() : 0;
      if (st.full_complete_generation !== null && now - fullAt > 2 * fullInterval) gaps.push(`last complete full pass ${isoOrNull(st.full_complete_at)} is older than twice the full-scan interval (deletions since then may be unconfirmed)`);
      reports.push({
        ...common,
        scope: name,
        state: gaps.length ? "partial" : "complete",
        reason: gaps.length
          ? gaps.join("; ")
          : `current state complete as of full pass ${st.full_complete_generation} (${isoOrNull(st.full_complete_at)}) and delta ${isoOrNull(st.delta_checked_at)}; deletions are confirmed by 404 per object`,
      });
      reports.push({
        provider: PROVIDER,
        scope: `${name}:history`,
        state: "partial",
        counts: { containers: c.containers, containersWithFullHistory: c.containers - c.historyIncomplete, versionBodies: c.versionBodies, observations: c.observations },
        reason:
          `page/blog post version bodies: ${c.containers - c.historyIncomplete}/${c.containers} container(s) have every version v1..current` +
          "; comment and attachment versions are only those observed by sweeps (older versions are not fetched), and edits between two sweeps of the same comment are not visible",
      });
    }
  }
  reports.push(...(await nangoRecordsCoverage(ctx)));
  if (conns.length > 1) {
    reports.push({ provider: PROVIDER, scope: "donor-mirror", state: "partial", reason: "the donor mirror sources/confluence/<spaceId>/<pageId>.md is not site-scoped; with several Confluence connections the same id can collide and export-time stale-file cleanup is disabled (use sources/confluence/_sites/)" });
  }
  return reports;
}

async function siteCounts(ctx: ExportContext, scope: { tenantId: string; connectionId: string; cloudId: string }): Promise<Record<string, number> & {
  containers: number; historyIncomplete: number; attachmentsNotStored: number; attachmentsTooLarge: number; attachmentsForbidden: number; attachmentsPending: number;
  inaccessible: number; restrictionsMissing: number; permissionsMissing: number; versionBodies: number; observations: number;
}> {
  const r = rowsOf<Record<string, number>>(
    await ctx.executor.execute(sql`
      SELECT
        count(*) FILTER (WHERE content_type = 'space' AND tombstoned_at IS NULL)::int AS spaces,
        count(*) FILTER (WHERE content_type = 'page' AND tombstoned_at IS NULL)::int AS pages,
        count(*) FILTER (WHERE content_type = 'blogpost' AND tombstoned_at IS NULL)::int AS blogposts,
        count(*) FILTER (WHERE content_type IN ('footer_comment', 'inline_comment') AND tombstoned_at IS NULL)::int AS comments,
        count(*) FILTER (WHERE content_type = 'attachment' AND tombstoned_at IS NULL)::int AS attachments,
        count(*) FILTER (WHERE content_type = 'attachment' AND tombstoned_at IS NULL AND binary_status = 'stored' AND binary_version IS NOT DISTINCT FROM version_number)::int AS "attachmentsStored",
        count(*) FILTER (WHERE content_type = 'attachment' AND tombstoned_at IS NULL AND binary_status = 'too_large')::int AS "attachmentsTooLarge",
        count(*) FILTER (WHERE content_type = 'attachment' AND tombstoned_at IS NULL AND binary_status IN ('forbidden', 'scope_missing', 'missing'))::int AS "attachmentsForbidden",
        count(*) FILTER (WHERE content_type IN ('page', 'blogpost') AND tombstoned_at IS NULL)::int AS containers,
        count(*) FILTER (WHERE content_type IN ('page', 'blogpost') AND tombstoned_at IS NULL AND version_number IS NOT NULL AND COALESCE(history_through, 0) < version_number)::int AS "historyIncomplete",
        count(*) FILTER (WHERE content_type IN ('page', 'blogpost') AND tombstoned_at IS NULL AND restrictions_status IS DISTINCT FROM 'captured')::int AS "restrictionsMissing",
        count(*) FILTER (WHERE content_type = 'space' AND tombstoned_at IS NULL AND permissions_status IS DISTINCT FROM 'captured')::int AS "permissionsMissing",
        count(*) FILTER (WHERE tombstoned_at IS NULL AND inaccessible_at IS NOT NULL)::int AS inaccessible,
        count(*) FILTER (WHERE tombstoned_at IS NOT NULL)::int AS tombstoned
      FROM confluence_source_objects
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
    `),
  )[0] ?? {};
  const rec = rowsOf<{ versions: number; observations: number }>(
    await ctx.executor.execute(sql`
      SELECT count(*) FILTER (WHERE record_kind = 'version')::int AS versions, count(*) FILTER (WHERE record_kind = 'observation')::int AS observations
      FROM confluence_source_records WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
    `),
  )[0];
  const n = (k: string) => Number(r[k] ?? 0);
  const attachments = n("attachments");
  const stored = n("attachmentsStored");
  const tooLarge = n("attachmentsTooLarge");
  const forbidden = n("attachmentsForbidden");
  return {
    spaces: n("spaces"),
    pages: n("pages"),
    blogposts: n("blogposts"),
    comments: n("comments"),
    attachments,
    attachmentsStored: stored,
    attachmentsTooLarge: tooLarge,
    attachmentsForbidden: forbidden,
    attachmentsPending: Math.max(0, attachments - stored - tooLarge - forbidden),
    attachmentsNotStored: attachments - stored,
    containers: n("containers"),
    historyIncomplete: n("historyIncomplete"),
    restrictionsMissing: n("restrictionsMissing"),
    permissionsMissing: n("permissionsMissing"),
    inaccessible: n("inaccessible"),
    tombstoned: n("tombstoned"),
    versionBodies: Number(rec?.versions ?? 0),
    observations: Number(rec?.observations ?? 0),
  };
}

/** Donor Nango /records lane: raw rows journal every observed latest-state record; never complete history. */
async function nangoRecordsCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const r = rowsOf<{ event_type: string; n: number }>(
    await ctx.executor.execute(sql`
      SELECT event_type, count(*)::int AS n FROM activity_events
      WHERE user_id = ${ctx.tenantId} AND source = 'confluence' GROUP BY event_type ORDER BY event_type
    `),
  );
  const polled = rowsOf<{ at: unknown; cursors: number }>(
    await ctx.executor.execute(sql`
      SELECT max(last_polled_at) AS at, count(*)::int AS cursors FROM conversation_watermarks
      WHERE user_id = ${ctx.tenantId} AND provider = 'confluence' AND conversation_type = 'nango_sync_cursor'
    `),
  )[0];
  if (!r.length && !Number(polled?.cursors ?? 0)) return [];
  const counts: Record<string, number> = {};
  for (const x of r) counts[x.event_type] = Number(x.n);
  return [
    {
      provider: PROVIDER,
      scope: "nango-records",
      state: "partial",
      counts,
      ...(polled?.at ? { lastSuccessAt: isoOrNull(polled.at)! } : {}),
      reason:
        "Nango /records keeps only the latest state per record: each poll's distinct record is journaled under sources/confluence/_raw/, but versions edited between polls are not in this lane (see the site :history scope for version-API bodies)",
    },
  ];
}
