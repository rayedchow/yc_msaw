import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { bitbucketConnections } from "./content.js";
import { PROVIDER } from "./paths.js";
import { fileCounts, isoOrNull, listConnectionStates, listRefs, listRepos, listSelection, quotaRow, rowsOf, stagedCounts, toDate, type RefRow, type RepoRow } from "./store.js";

/**
 * Truthful coverage of the Bitbucket provider.
 *
 *  - `repo:<ws>/<repo>@<branch>`: `complete` only when the committed scan is the HEAD observed
 *    at the last successful check, every file of that commit is captured, no listing was
 *    incomplete, nothing is deferred and the check is recent. A scan in progress, a HEAD that
 *    moved past the export, omitted files, LFS pointers, rate-limit deferral or errors are
 *    `partial`; a grant without access is `blocked`; a branch never scanned is `pending`.
 *  - `activity`: the donor Nango lanes (PR/commit/repository records, proxy issues, PR details,
 *    comments, activity) are always `partial` - latest state per poll, bounded comment pages,
 *    no deletion reconcile, slim PR records without a repository.
 */

const STALE_AFTER_MS = 30 * 60_000;

export async function bitbucketCoverage(ctx: ExportContext, now = Date.now()): Promise<CoverageReport[]> {
  const db = ctx.executor;
  const conns = (await bitbucketConnections(db, ctx.tenantId)).filter((c) => c.status === "active");
  const out: CoverageReport[] = [];
  const repos = await listRepos(db, ctx.tenantId);
  if (!conns.length) {
    if (repos.length) out.push({ provider: PROVIDER, scope: "connections", state: "blocked", reason: "no active Bitbucket connection; captured repository content is kept but no longer refreshed" });
    return [...out, ...(await activityCoverage(ctx))];
  }
  for (const c of await listConnectionStates(db, ctx.tenantId)) {
    if (c.status === "blocked") {
      out.push({ provider: PROVIDER, scope: `connection:${c.connection_id}`, state: "blocked", reason: c.reason ?? "Bitbucket grant is not authorized; reconnect", lastErrorAt: isoOrNull(c.checked_at) ?? undefined });
    }
  }
  const selection = (await listSelection(db, ctx.tenantId)).filter((s) => s.selected);
  if (!selection.length) {
    out.push({ provider: PROVIDER, scope: "repositories", state: "pending", reason: "no repository is selected for content capture (opt-in); repository files are not captured until one is" });
  }
  const keys = new Set(selection.map((s) => s.repo_key));
  for (const sel of selection) {
    const known = repos.find((r) => r.selected_key === sel.repo_key || r.full_name.toLowerCase() === sel.repo_key);
    if (!known) out.push({ provider: PROVIDER, scope: `repo:${sel.full_name}`, state: "pending", reason: "selected; not yet resolved through any active connection (first scan pending, or the repository is not readable by the grant)" });
  }
  for (const repo of repos) {
    if (repo.status === "out_of_scope" || !(keys.has(repo.selected_key) || keys.has(repo.full_name.toLowerCase()))) continue;
    const quota = await quotaRow(db, repo.quota_key);
    const refs = (await listRefs(db, ctx.tenantId, repo.repo_uuid)).filter((r) => r.status !== "retired");
    if (repo.status === "inaccessible") {
      out.push({ provider: PROVIDER, scope: `repo:${repo.full_name}`, state: "blocked", reason: repo.status_reason ?? "repository is not readable through its grant; captured files are kept", lastErrorAt: isoOrNull(repo.last_checked_at) ?? undefined });
      continue;
    }
    if (repo.status === "not_found") {
      out.push({ provider: PROVIDER, scope: `repo:${repo.full_name}`, state: "blocked", reason: `${repo.status_reason ?? "repository not found"}; its files were tombstoned (history kept)`, lastErrorAt: isoOrNull(repo.last_checked_at) ?? undefined });
      continue;
    }
    if (!refs.length) {
      out.push({ provider: PROVIDER, scope: `repo:${repo.full_name}@${repo.main_branch ?? "?"}`, state: "pending", reason: repo.main_branch ? "repository resolved; main branch not scanned yet" : "repository has no main branch (empty repository) and no extra branch is configured" });
      continue;
    }
    for (const ref of refs) out.push(await refCoverage(ctx, repo, ref, quota, now));
  }
  return [...out, ...(await activityCoverage(ctx))];
}

async function refCoverage(ctx: ExportContext, repo: RepoRow, ref: RefRow, quota: Record<string, unknown> | null, now: number): Promise<CoverageReport> {
  const scope = `repo:${repo.full_name}@${ref.ref_name}`;
  const refScope = { tenantId: ctx.tenantId, repoUuid: repo.repo_uuid, ref: ref.ref_name };
  const files = await fileCounts(ctx.executor, refScope);
  const base: CoverageReport = {
    provider: PROVIDER,
    scope,
    state: "partial",
    cursor: ref.committed_commit_sha ?? undefined,
    lastSuccessAt: isoOrNull(ref.last_success_at) ?? undefined,
    ...(ref.last_error ? { lastError: ref.last_error, lastErrorAt: isoOrNull(ref.last_error_at) ?? undefined } : {}),
    counts: { generation: ref.committed_generation ?? 0, ...files },
  };
  const blockedUntil = toDate(quota?.blocked_until);
  const deferred = blockedUntil && blockedUntil.getTime() > now ? `Bitbucket ${String(quota?.blocked_kind ?? "rate")} limit: requests paused until ${blockedUntil.toISOString()}` : null;
  if (ref.status === "blocked") return { ...base, state: "blocked", reason: ref.status_reason ?? "the grant cannot read this repository's source" };
  if (ref.status === "not_found") {
    return { ...base, state: "complete", reason: `branch ${ref.ref_name} no longer exists; its files were removed from the current view (history kept)` };
  }
  if (ref.committed_generation === null) {
    const staged = ref.scan_generation !== null ? await stagedCounts(ctx.executor, refScope, ref.scan_generation) : {};
    const progress =
      ref.scan_generation !== null
        ? `initial ${ref.scan_mode ?? "full"} scan of ${ref.scan_commit_sha} in phase ${ref.scan_phase}: ${staged.stored ?? 0} files stored, ${staged.pending ?? 0} pending, ${staged.dirs_pending ?? 0} directories pending`
        : "initial scan not started";
    return { ...base, state: "pending", reason: [progress, deferred].filter(Boolean).join("; "), counts: { ...base.counts, ...prefixed("scan_", staged) } };
  }
  const reasons: string[] = [];
  if (ref.scan_generation !== null) {
    const staged = await stagedCounts(ctx.executor, refScope, ref.scan_generation);
    reasons.push(`exported commit ${ref.committed_commit_sha} (generation ${ref.committed_generation}); ${ref.scan_mode} scan of ${ref.scan_commit_sha} (generation ${ref.scan_generation}) in progress, ${staged.pending ?? 0} files pending`);
    base.counts = { ...base.counts, ...prefixed("scan_", staged) };
  } else if (ref.observed_head_sha && ref.observed_head_sha !== ref.committed_commit_sha) {
    reasons.push(`HEAD moved to ${ref.observed_head_sha}; exported commit ${ref.committed_commit_sha} is behind until the next scan`);
  }
  const committed = ref.committed_counts ?? {};
  if (committed.listing_complete !== 1) reasons.push("the last committed scan could not list every directory (content there kept unchanged)");
  if (files.too_large) reasons.push(`${files.too_large} file(s) over the capture size limit are listed in _head.json but not exported`);
  if (files.fetch_failed) reasons.push(`${files.fetch_failed} file(s) could not be fetched and are retried`);
  if (files.lfs) reasons.push(`${files.lfs} LFS-tracked file(s) are exported as Bitbucket's /src endpoint serves them, which may be the LFS pointer rather than the object`);
  if (deferred) reasons.push(deferred);
  if (ref.error_streak > 0 && ref.last_error) reasons.push(`last check failed: ${ref.last_error}`);
  const last = toDate(ref.last_success_at);
  if (!last || now - last.getTime() > STALE_AFTER_MS) reasons.push(`no successful check since ${last ? last.toISOString() : "never"}`);
  if (reasons.length) return { ...base, state: "partial", reason: reasons.join("; ") };
  const how = ref.committed_mode === "diff" ? `incrementally via Bitbucket diffstat (last full listing ${isoOrNull(ref.last_full_at) ?? "never"})` : "by a full listing";
  return { ...base, state: "complete", reason: `every file at HEAD ${ref.committed_commit_sha} is exported (generation ${ref.committed_generation}, ${how})` };
}

function prefixed(prefix: string, counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [`${prefix}${k}`, v]));
}

async function activityCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const rows = rowsOf<{ event_type: string; n: unknown; last: unknown }>(
    await ctx.executor.execute(sql`
      SELECT event_type, count(*)::int AS n, max(created_at) AS last FROM activity_events
      WHERE user_id = ${ctx.tenantId} AND source = 'bitbucket' GROUP BY event_type ORDER BY event_type
    `),
  );
  if (!rows.length) return [];
  const last = rows
    .map((r) => isoOrNull(r.last))
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  return [
    {
      provider: PROVIDER,
      scope: "activity",
      state: "partial",
      reason:
        "pull requests, commits, repositories, issues, comments and PR activity from the donor Nango lanes: latest state per poll (edits between polls are not seen), " +
        "comments re-read only when the parent's version changes and capped per parent, no Bitbucket-side deletion reconcile for issues/PRs, the proxy lanes use only the first connection, " +
        "and slim PR sync records without a repository are kept raw only (their unknown-repo projections are not exported)",
      ...(last ? { cursor: `last-event:${last}` } : {}),
      counts: Object.fromEntries(rows.map((r) => [r.event_type, Number(r.n)])),
    },
  ];
}
