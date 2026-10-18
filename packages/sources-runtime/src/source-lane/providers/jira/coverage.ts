import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { quotaKeyFor } from "./identity.js";
import { getDiscovery, getSelection, isoOrNull, listSites, listSyncStates, quotaBlockedUntil, rowsOf, workCounts } from "./store.js";
import { jiraConnections } from "./sweep.js";

/**
 * Truthful Jira coverage per (connection, site), from durable state only.
 *
 * `site:<cloudId>/<connectionId>` (current state of the SELECTED projects:
 * issues with all fields, comments, attachment bytes, full changelogs) is
 * `complete` only when the last full pass finished without failed items, every
 * live issue's changelog and comment set is complete, every live attachment's
 * bytes are stored, nothing lost access, the delta check is current and the
 * full pass is recent. Anything else is `partial` (every gap listed) /
 * `pending` / `blocked`.
 *
 * `...:history` is never `complete`: the changelog records every field change
 * (counted), but Jira does not expose earlier bodies of edited comments; only
 * comment versions observed by sweeps are kept. `nango-records` reports the
 * donor lanes (latest state per poll / per proxy sweep).
 */

const PROVIDER = "jira";

export interface CoverageOptions {
  deltaIntervalMs?: number;
  fullScanIntervalMs?: number;
}

export async function jiraCoverage(ctx: ExportContext, options: CoverageOptions = {}): Promise<CoverageReport[]> {
  const deltaInterval = options.deltaIntervalMs ?? 5 * 60_000;
  const fullInterval = options.fullScanIntervalMs ?? Number(process.env.JIRA_SOURCE_FULL_SCAN_INTERVAL_MS ?? 12 * 60 * 60_000);
  const reports: CoverageReport[] = [];
  const conns = await jiraConnections(ctx.executor, ctx.tenantId);
  const states = await listSyncStates(ctx.executor, ctx.tenantId);
  for (const conn of conns) {
    if (conn.status !== "active") {
      reports.push({ provider: PROVIDER, scope: `connection:${conn.connectionId}`, state: "blocked", reason: `Jira connection is ${conn.status}; captured content is kept, nothing new is fetched` });
      continue;
    }
    const sites = await listSites(ctx.executor, ctx.tenantId, conn.connectionId);
    const discovery = await getDiscovery(ctx.executor, ctx.tenantId, conn.connectionId);
    if (discovery?.status === "blocked") {
      reports.push({ provider: PROVIDER, scope: `connection:${conn.connectionId}`, state: "blocked", reason: discovery.reason ?? "site discovery blocked", lastErrorAt: isoOrNull(discovery.checked_at) ?? undefined, lastError: discovery.reason ?? undefined });
      if (!sites.length) continue;
    }
    if (!sites.length) {
      reports.push({ provider: PROVIDER, scope: `connection:${conn.connectionId}`, state: "pending", reason: discovery?.reason ? `site discovery failed: ${discovery.reason}` : "no Jira site discovered yet for this connection (deep sweep has not reached accessible-resources)" });
      continue;
    }
    for (const site of sites) {
      const scope = { tenantId: ctx.tenantId, connectionId: conn.connectionId, cloudId: site.cloud_id };
      const st = states.find((s) => s.connection_id === conn.connectionId && s.cloud_id === site.cloud_id) ?? null;
      const name = `site:${site.cloud_id}/${conn.connectionId}`;
      const c = await siteCounts(ctx, scope);
      const work = st ? await workCounts(ctx.executor, scope, st.generation) : { pending: 0, done: 0, failed: 0, inaccessible: 0 };
      const selection = await getSelection(ctx.executor, scope);
      const counts: Record<string, number> = { ...c, workPending: work.pending ?? 0, workFailed: work.failed ?? 0, workInaccessible: work.inaccessible ?? 0, generation: st?.generation ?? 0 };
      const common = {
        provider: PROVIDER,
        counts,
        ...(st?.last_success_at ? { lastSuccessAt: isoOrNull(st.last_success_at)! } : {}),
        ...(st?.last_error_at ? { lastErrorAt: isoOrNull(st.last_error_at)!, lastError: st.last_error ?? undefined } : {}),
        ...(st ? { cursor: `generation ${st.generation} ${st.generation_phase}; full complete ${st.full_complete_generation ?? "never"}; delta watermark ${isoOrNull(st.delta_watermark) ?? "none"}` } : {}),
      };
      const selected = selection.mode === "all" ? "all projects this grant can browse" : `selected projects only (${selection.projects.join(", ") || "none"})`;
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
      if (cooldown) gaps.push(`Atlassian rate limit cooldown until ${cooldown.toISOString()} (Retry-After honoured)`);
      if (st.full_complete_generation === null) gaps.push(`initial full inventory in progress (${work.pending ?? 0} work item(s) pending)`);
      else if (st.generation_phase !== "closed") gaps.push(`full pass ${st.generation} (${st.generation_reason ?? "scheduled"}) in progress; last complete pass ${st.full_complete_generation}`);
      if (st.generation_phase === "closed" && st.full_complete_generation !== st.generation) gaps.push(`full pass ${st.generation} finished with ${st.generation_failed_items} failed item(s); deletions are only confirmed for listings that completed`);
      if ((work.failed ?? 0) > 0) gaps.push(`${work.failed} work item(s) failed after retries`);
      if (c.changelogIncomplete > 0) gaps.push(`${c.changelogIncomplete} issue(s) without their complete changelog yet`);
      if (c.commentsIncomplete > 0) gaps.push(`${c.commentsIncomplete} issue(s) without their complete comment set yet`);
      if (c.attachmentsNotStored > 0) gaps.push(`${c.attachmentsNotStored} live attachment(s) without bytes (${c.attachmentsTooLarge} over the size limit, ${c.attachmentsForbidden} not readable by this grant, ${c.attachmentsPending} pending)`);
      if (c.inaccessible > 0) gaps.push(`${c.inaccessible} object(s) no longer readable by this grant (kept as last captured, labelled, not deleted)`);
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
          ? `${selected}: ${gaps.join("; ")}`
          : `${selected}: current state complete as of full pass ${st.full_complete_generation} (${isoOrNull(st.full_complete_at)}) and delta ${isoOrNull(st.delta_checked_at)}; deletions confirmed by 404 with project browse permission; comment edits made without an issue update are picked up by the next full pass`,
      });
      reports.push({
        provider: PROVIDER,
        scope: `${name}:history`,
        state: "partial",
        counts: { issues: c.issues, issuesWithCompleteChangelog: c.issues - c.changelogIncomplete, changelogEntries: c.changelogEntries, observations: c.observations },
        reason:
          `field-change history: ${c.issues - c.changelogIncomplete}/${c.issues} issue(s) have every changelog entry (${c.changelogEntries} stored)` +
          "; earlier bodies of edited comments are not exposed by Jira, only comment versions observed by sweeps are kept; attachments are immutable",
      });
    }
  }
  reports.push(...(await donorCoverage(ctx)));
  return reports;
}

async function siteCounts(ctx: ExportContext, scope: { tenantId: string; connectionId: string; cloudId: string }): Promise<Record<string, number> & {
  issues: number; changelogIncomplete: number; commentsIncomplete: number; attachmentsNotStored: number; attachmentsTooLarge: number; attachmentsForbidden: number;
  attachmentsPending: number; inaccessible: number; changelogEntries: number; observations: number;
}> {
  const r = rowsOf<Record<string, number>>(
    await ctx.executor.execute(sql`
      SELECT
        count(*) FILTER (WHERE content_type = 'project' AND tombstoned_at IS NULL)::int AS projects,
        count(*) FILTER (WHERE content_type = 'issue' AND tombstoned_at IS NULL)::int AS issues,
        count(*) FILTER (WHERE content_type = 'comment' AND tombstoned_at IS NULL)::int AS comments,
        count(*) FILTER (WHERE content_type = 'attachment' AND tombstoned_at IS NULL)::int AS attachments,
        count(*) FILTER (WHERE content_type = 'attachment' AND tombstoned_at IS NULL AND binary_status = 'stored')::int AS "attachmentsStored",
        count(*) FILTER (WHERE content_type = 'attachment' AND tombstoned_at IS NULL AND binary_status = 'too_large')::int AS "attachmentsTooLarge",
        count(*) FILTER (WHERE content_type = 'attachment' AND tombstoned_at IS NULL AND binary_status IN ('forbidden', 'scope_missing', 'missing'))::int AS "attachmentsForbidden",
        count(*) FILTER (WHERE content_type = 'issue' AND tombstoned_at IS NULL AND changelog_status IS DISTINCT FROM 'complete')::int AS "changelogIncomplete",
        count(*) FILTER (WHERE content_type = 'issue' AND tombstoned_at IS NULL AND comments_status IS DISTINCT FROM 'complete')::int AS "commentsIncomplete",
        count(*) FILTER (WHERE tombstoned_at IS NULL AND inaccessible_at IS NOT NULL)::int AS inaccessible,
        count(*) FILTER (WHERE tombstoned_at IS NOT NULL AND tombstone_reason NOT LIKE '%outside_selection')::int AS tombstoned,
        count(*) FILTER (WHERE tombstoned_at IS NOT NULL AND tombstone_reason LIKE '%outside_selection')::int AS "outsideSelection"
      FROM jira_source_objects
      WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
    `),
  )[0] ?? {};
  const rec = rowsOf<{ changelog: number; observations: number }>(
    await ctx.executor.execute(sql`
      SELECT count(*) FILTER (WHERE record_kind = 'changelog')::int AS changelog, count(*) FILTER (WHERE record_kind = 'observation')::int AS observations
      FROM jira_source_records WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId} AND cloud_id = ${scope.cloudId}
    `),
  )[0];
  const n = (k: string) => Number(r[k] ?? 0);
  const attachments = n("attachments");
  const stored = n("attachmentsStored");
  const tooLarge = n("attachmentsTooLarge");
  const forbidden = n("attachmentsForbidden");
  return {
    projects: n("projects"),
    issues: n("issues"),
    comments: n("comments"),
    attachments,
    attachmentsStored: stored,
    attachmentsTooLarge: tooLarge,
    attachmentsForbidden: forbidden,
    attachmentsPending: Math.max(0, attachments - stored - tooLarge - forbidden),
    attachmentsNotStored: attachments - stored,
    changelogIncomplete: n("changelogIncomplete"),
    commentsIncomplete: n("commentsIncomplete"),
    inaccessible: n("inaccessible"),
    tombstoned: n("tombstoned"),
    outsideSelection: n("outsideSelection"),
    changelogEntries: Number(rec?.changelog ?? 0),
    observations: Number(rec?.observations ?? 0),
  };
}

/** Donor lanes (Nango /records sync + nango.proxy_details sweep): never complete history, and not site-scoped. */
async function donorCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const r = rowsOf<{ event_type: string; n: number }>(
    await ctx.executor.execute(sql`
      SELECT event_type, count(*)::int AS n FROM activity_events
      WHERE user_id = ${ctx.tenantId} AND source = 'jira' GROUP BY event_type ORDER BY event_type
    `),
  );
  const polled = rowsOf<{ at: unknown; cursors: number }>(
    await ctx.executor.execute(sql`
      SELECT max(last_polled_at) AS at, count(*)::int AS cursors FROM conversation_watermarks
      WHERE user_id = ${ctx.tenantId} AND provider = 'jira' AND conversation_type = 'nango_sync_cursor'
    `),
  )[0];
  if (!r.length && !Number(polled?.cursors ?? 0)) return [];
  const counts: Record<string, number> = {};
  for (const x of r) counts[x.event_type] = Number(x.n);
  const sites = rowsOf<{ n: number }>(await ctx.executor.execute(sql`SELECT count(DISTINCT cloud_id)::int AS n FROM jira_source_sites WHERE tenant_id = ${ctx.tenantId}`))[0];
  const multi = Number(sites?.n ?? 0) > 1;
  return [
    {
      provider: PROVIDER,
      scope: "nango-records",
      state: "partial",
      counts,
      ...(polled?.at ? { lastSuccessAt: isoOrNull(polled.at)! } : {}),
      reason:
        "donor Nango lanes: sync records hold the latest state per poll; the proxy-details sweep stores each issue version it sees with the changelog subset search embeds and does not tombstone deleted comments (see the site scopes for paged changelogs, comment deletions and attachment bytes)" +
        (multi ? "; this tenant reaches several Jira sites and the donor mirror sources/jira/<PROJECT>/<KEY>.md is not site-scoped, so keys can collide and export-time stale-file cleanup is disabled (use sources/jira/_sites/)" : ""),
    },
  ];
}
