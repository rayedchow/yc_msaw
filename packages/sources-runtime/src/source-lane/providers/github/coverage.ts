import { sql } from "drizzle-orm";
import { enabledGithubRepos } from "../../../integrations/github/repo-sync.js";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { githubConnections } from "./content.js";
import { PROVIDER } from "./paths.js";
import { fileCounts, isoOrNull, listConnectionStates, listRefs, listRepos, quotaRow, rowsOf, stagedCounts, toDate, type RefRow, type RepoRow } from "./store.js";

/**
 * Truthful coverage of the GitHub provider.
 *
 *  - `repo:<owner>/<repo>@<ref>`: `complete` only when the committed scan is the HEAD
 *    observed at the last successful check, every blob of that tree is captured, no
 *    listing was incomplete and the check is recent. A scan in progress, a HEAD that moved
 *    past the export, omitted blobs, rate-limit deferral or errors are `partial`; a grant
 *    without access is `blocked`; a ref never scanned is `pending`.
 *  - `activity`: the donor Nango lanes (issues, PRs, comments, slim commits) are always
 *    `partial` - latest state per poll, no PR reviews, no GitHub deletion reconcile.
 */

const STALE_AFTER_MS = 30 * 60_000;

export async function githubCoverage(ctx: ExportContext, now = Date.now()): Promise<CoverageReport[]> {
  const db = ctx.executor;
  const conns = (await githubConnections(db, ctx.tenantId)).filter((c) => c.status === "active");
  const out: CoverageReport[] = [];
  if (!conns.length) {
    const any = rowsOf(await db.execute(sql`SELECT 1 FROM github_source_repos WHERE tenant_id = ${ctx.tenantId} LIMIT 1`)).length > 0;
    if (any) out.push({ provider: PROVIDER, scope: "connections", state: "blocked", reason: "no active GitHub connection; captured repository content is kept but no longer refreshed" });
    return [...out, ...(await activityCoverage(ctx))];
  }
  for (const c of await listConnectionStates(db, ctx.tenantId)) {
    if (c.status === "blocked") {
      out.push({ provider: PROVIDER, scope: `connection:${String(c.connection_id)}`, state: "blocked", reason: String(c.reason ?? "GitHub grant is not authorized; reconnect"), lastErrorAt: isoOrNull(c.checked_at) ?? undefined });
    }
  }
  const enabled = await enabledGithubRepos(db, ctx.tenantId);
  if (!enabled.length) {
    out.push({ provider: PROVIDER, scope: "repositories", state: "pending", reason: "no repository is selected for sync (opt-in github_repo_sync); nothing is captured until one is" });
  }
  const repos = await listRepos(db, ctx.tenantId);
  const lowerEnabled = new Set(enabled.map((n) => n.toLowerCase()));
  for (const name of enabled) {
    const known = repos.find((r) => r.selected_name.toLowerCase() === name.toLowerCase() || r.full_name.toLowerCase() === name.toLowerCase());
    if (!known) out.push({ provider: PROVIDER, scope: `repo:${name}`, state: "pending", reason: "selected; not yet resolved through any active connection (first scan pending, or the repository is not readable by the grant)" });
  }
  for (const repo of repos) {
    if (repo.status === "out_of_scope" || !(lowerEnabled.has(repo.selected_name.toLowerCase()) || lowerEnabled.has(repo.full_name.toLowerCase()))) continue;
    const quota = await quotaRow(db, repo.quota_key);
    const refs = (await listRefs(db, ctx.tenantId, repo.repo_id)).filter((r) => r.status !== "retired");
    if (repo.status === "inaccessible" || repo.status === "blocked") {
      out.push({ provider: PROVIDER, scope: `repo:${repo.full_name}`, state: "blocked", reason: repo.status_reason ?? "repository is not readable through its grant; captured files are kept", lastErrorAt: isoOrNull(repo.last_checked_at) ?? undefined });
      continue;
    }
    if (!refs.length) {
      out.push({ provider: PROVIDER, scope: `repo:${repo.full_name}@${repo.default_branch ?? "?"}`, state: "pending", reason: "repository resolved; default branch not scanned yet" });
      continue;
    }
    for (const ref of refs) out.push(await refCoverage(ctx, repo, ref, quota, now));
  }
  return [...out, ...(await activityCoverage(ctx))];
}

async function refCoverage(ctx: ExportContext, repo: RepoRow, ref: RefRow, quota: Record<string, unknown> | null, now: number): Promise<CoverageReport> {
  const scope = `repo:${repo.full_name}@${ref.ref_name}`;
  const refScope = { tenantId: ctx.tenantId, repoId: repo.repo_id, ref: ref.ref_name };
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
  const deferred = blockedUntil && blockedUntil.getTime() > now ? `GitHub ${String(quota?.blocked_kind ?? "rate")} limit: requests paused until ${blockedUntil.toISOString()}` : null;
  const reasons: string[] = [];
  if (ref.status === "blocked") return { ...base, state: "blocked", reason: ref.status_reason ?? "the grant cannot read this repository's contents" };
  if (ref.status === "not_found" || ref.status === "empty") {
    return { ...base, state: "complete", reason: ref.status === "empty" ? "repository is empty" : `branch ${ref.ref_name} no longer exists; its files were removed from the current view (history kept)` };
  }
  if (ref.committed_generation === null) {
    const staged = ref.scan_generation !== null ? await stagedCounts(ctx.executor, refScope, ref.scan_generation) : {};
    const progress = ref.scan_generation !== null ? `initial scan of ${ref.scan_commit_sha} in phase ${ref.scan_phase}: ${staged.stored ?? 0} blobs stored, ${staged.pending ?? 0} pending` : "initial scan not started";
    return { ...base, state: "pending", reason: [progress, deferred].filter(Boolean).join("; "), counts: { ...base.counts, ...prefixed("scan_", staged) } };
  }
  if (ref.scan_generation !== null) {
    const staged = await stagedCounts(ctx.executor, refScope, ref.scan_generation);
    reasons.push(`exported commit ${ref.committed_commit_sha} (generation ${ref.committed_generation}); scanning ${ref.scan_commit_sha} (generation ${ref.scan_generation}, ${staged.pending ?? 0} blobs pending)`);
    base.counts = { ...base.counts, ...prefixed("scan_", staged) };
  } else if (ref.observed_head_sha && ref.observed_head_sha !== ref.committed_commit_sha) {
    reasons.push(`HEAD moved to ${ref.observed_head_sha}; exported commit ${ref.committed_commit_sha} is behind until the next scan`);
  }
  const committed = ref.committed_counts ?? {};
  if (committed.complete !== 1) {
    if (files.too_large) reasons.push(`${files.too_large} file(s) over the capture size limit are listed in _head.json but not exported`);
    if (files.fetch_failed) reasons.push(`${files.fetch_failed} blob(s) could not be fetched and are retried`);
    if (!files.too_large && !files.fetch_failed) reasons.push("the last committed scan could not list every directory (kept unchanged there)");
  }
  if (deferred) reasons.push(deferred);
  if (ref.error_streak > 0 && ref.last_error) reasons.push(`last check failed: ${ref.last_error}`);
  const last = toDate(ref.last_success_at);
  if (!last || now - last.getTime() > STALE_AFTER_MS) reasons.push(`no successful check since ${last ? last.toISOString() : "never"}`);
  if (reasons.length) return { ...base, state: "partial", reason: reasons.join("; ") };
  return { ...base, state: "complete", reason: `every file at HEAD ${ref.committed_commit_sha} is exported (generation ${ref.committed_generation})` };
}

function prefixed(prefix: string, counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [`${prefix}${k}`, v]));
}

async function activityCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const rows = rowsOf<{ event_type: string; n: unknown; last: unknown }>(
    await ctx.executor.execute(sql`
      SELECT event_type, count(*)::int AS n, max(created_at) AS last FROM activity_events
      WHERE user_id = ${ctx.tenantId} AND source = 'github' GROUP BY event_type ORDER BY event_type
    `),
  );
  if (!rows.length) return [];
  const last = rows.map((r) => isoOrNull(r.last)).filter((v): v is string => Boolean(v)).sort().at(-1);
  return [
    {
      provider: PROVIDER,
      scope: "activity",
      state: "partial",
      reason:
        "issues, pull requests, comments and slim commits from the donor Nango lanes: latest state per poll (edits between polls are not seen), no PR review bodies, no GitHub-side deletion reconcile for proxy-swept issues/comments, and slim template records are not gated by repository selection",
      // The last captured event is not a provider check, so it is not reported as lastSuccessAt.
      ...(last ? { cursor: `last-event:${last}` } : {}),
      counts: Object.fromEntries(rows.map((r) => [r.event_type, Number(r.n)])),
    },
  ];
}
