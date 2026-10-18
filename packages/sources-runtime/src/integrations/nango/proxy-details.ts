import { sql } from "drizzle-orm";
import {
  deleteJiraIssueSourceWiki,
  mergeJiraCommentsIntoIssue,
  materializeBitbucketPullRequestSourceWiki,
  materializeJiraIssueSourceWiki,
  materializeSourceWikiIndexes,
  rematerializeGithubParentSourceWiki,
  type GithubParentSourceRef,
} from "../../mirror/materializer.js";
import { processBitbucketRepositoryRecord } from "../bitbucket/processors.js";
import { processGithubRepositoryRecord } from "../github/processors.js";
import { capturedGithubRepos } from "../github/repo-sync.js";
import { nangoRecordVersion, processGenericNangoRecord } from "./capture.js";
import { NangoClient } from "./client.js";
import { activeConnections, discoverRepos, splitRepoFullName } from "./proxy-issues.js";
import { loadStoredCursor, saveStoredCursor } from "./tasks.js";
import type { NangoExecutor, NangoRecord } from "./types.js";

/**
 * Deep-content capture via the Nango PROXY API - fills what the sync
 * templates omit, live-verified against the configured Nango environment:
 *
 * - jira: the Issue sync model carries the description but NO comments and
 *   only accountIds for people (no emails). This sweep pages the site's
 *   `search/jql` endpoint with `fields=*all&expand=changelog`, capturing the
 *   FULL issue payload (all fields, attachment metadata, reporter/assignee
 *   objects with emails, edit changelog), every comment individually, and
 *   re-materializing the issue mirror file from the full payload.
 * - github: the sync template exposes no comment sync; the repo-wide
 *   `issues/comments` (issue + PR conversation comments) and `pulls/comments`
 *   (review comments) REST endpoints are swept with a `since` cursor. Enabled
 *   repos missing a captured repository record get it re-seeded via
 *   `/installation/repositories` (the template only ships a repositories
 *   action; unselected repos are never captured - opt-in).
 * - bitbucket: the PullRequest sync model is slim (no description, repo, or
 *   author identity) and no comments or activity sync exists. This sweep lists
 *   updated PRs per repo, fetches the full PR detail, captures PR comments,
 *   pages the PR's /activity feed (approvals, requested changes, updates),
 *   and materializes the PR mirror file from the full payload. Repos fall back
 *   to `/workspaces` + `/repositories/{workspace}` discovery when none
 *   captured.
 *
 * All records feed the same generic lossless capture (redaction at persist,
 * append-only versioned keys, ON CONFLICT DO NOTHING); first runs have no
 * stored cursor, so every lane backfills full history. Provider REST APIs do
 * not report deletions, so tombstones for these kinds only come from Nango
 * sync deletion metadata where a sync exists — EXCEPT jira issues: the Nango
 * `issues` sync has no delete tracking at all, so the jira lane additionally
 * runs a watermark-gated deletion reconcile (see
 * maybeReconcileJiraIssueDeletions) that diffs captured issue ids against a
 * cheap full-key listing and 404-confirms each missing issue before
 * tombstoning (`issue.deleted`) and deleting the mirror file.
 */

export const NANGO_PROXY_DETAILS_TASK = "nango.proxy_details";

/** Providers with a deep-content proxy sweep (confluence's Page sync already carries full bodies). */
export const NANGO_PROXY_DETAILS_PROVIDERS = ["jira", "github", "bitbucket"] as const;

const JIRA_SEARCH_PAGE_SIZE = 50;
const MAX_JIRA_SEARCH_PAGES = 200;
const JIRA_COMMENT_PAGE_SIZE = 100;
const MAX_JIRA_COMMENT_PAGES = 50;
/**
 * JQL naive datetimes are interpreted in the API user's Jira timezone, so a
 * UTC-formatted cursor could skip records for users behind UTC. Re-scanning a
 * 26h window (> UTC+14..UTC-12 spread) makes any offset safe; versioned
 * idempotent keys turn the overlap into no-ops.
 */
const JIRA_JQL_LOOKBACK_MS = 26 * 60 * 60 * 1000;

/**
 * Deletion reconcile cadence: the proxy_details task fires every 300s, but a
 * full-key enumeration per run would be wasteful — a conversation_watermarks
 * row (model `issue_deletion_sweep`) gates the reconcile to once an hour,
 * granola-style (baseline on first run, sweep starts one interval later).
 */
const JIRA_DELETION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const JIRA_DELETION_SWEEP_MODEL = "issue_deletion_sweep";
/** ids-only listing is cheap; `search/jql` allows large pages when fields=id. */
const JIRA_DELETION_LISTING_PAGE_SIZE = 1000;
const MAX_JIRA_DELETION_LISTING_PAGES = 100;
/** Bound on per-sweep 404-confirm fetches (deletions are rare; the rest defer). */
const MAX_JIRA_DELETION_CONFIRMS = 500;

const GITHUB_PER_PAGE = 100;
const MAX_GITHUB_COMMENT_PAGES_PER_REPO = 100;
const MAX_GITHUB_REPO_DISCOVERY_PAGES = 20;

const BITBUCKET_PAGELEN = 50;
const MAX_BITBUCKET_PR_PAGES_PER_REPO = 100;
const MAX_BITBUCKET_COMMENT_PAGES = 50;
const MAX_BITBUCKET_REPO_DISCOVERY_PAGES = 20;
const MAX_BITBUCKET_ACTIVITY_PAGES_PER_PR = 20;
const MAX_BITBUCKET_ACTIVITY_LIST_PAGES = 4;
/**
 * Review signals (approve/request-changes) are NOT documented to bump the PR's
 * `updated_on` (Bitbucket's own webhook taxonomy treats reviewer-status changes
 * as a separate category from `pullrequest:updated`), so activity cannot rely
 * on the cursor-filtered PR listing alone. Every sweep ALSO re-scans activity
 * for OPEN PRs plus PRs updated inside this window; deterministic entry keys
 * make the overlap ON CONFLICT no-ops.
 */
const BITBUCKET_ACTIVITY_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** Bitbucket's PR list defaults to OPEN only; the q filter must opt into every state. */
const BITBUCKET_PR_STATES = '(state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")';

export interface NangoProxyDetailsPayload {
  tenantId: string;
  provider: string;
}

export interface NangoProxyDetailsOptions {
  client?: Pick<NangoClient, "proxy">;
}

interface ProxyDetailsCtx {
  tenantId: string;
  providerConfigKey: string;
  connectionId: string;
}

export function isProxyDetailsProvider(provider: string): boolean {
  return (NANGO_PROXY_DETAILS_PROVIDERS as readonly string[]).includes(normalizeProvider(provider));
}

/**
 * Scheduled per tenant×provider (jira/github/bitbucket) beside the record-sync
 * floor. No-op (counted log) when the tenant has no active connection.
 */
export async function handleNangoProxyDetailsTask(
  executor: NangoExecutor,
  payload: NangoProxyDetailsPayload,
  options: NangoProxyDetailsOptions = {},
): Promise<Record<string, unknown>> {
  const provider = normalizeProvider(payload.provider);
  if (!isProxyDetailsProvider(provider)) {
    console.warn(`[nango] proxy_details has no deep-content sweep for ${provider}; nothing captured`);
    return { connections: 0, captured: 0 };
  }

  const client = options.client ?? new NangoClient();
  const connections = await activeConnections(executor, payload.tenantId, provider);
  if (connections.length === 0) {
    console.log(`[nango] proxy_details: no active ${provider} connection for ${payload.tenantId}; skipped`);
    return { connections: 0, captured: 0 };
  }

  // One connection per tenant×provider is the norm; versioned dedupe keys make
  // a re-run through another connection a no-op (same as proxy_issues).
  const connection = connections[0]!;
  const ctx: ProxyDetailsCtx = {
    tenantId: payload.tenantId,
    providerConfigKey: connection.providerConfigKey,
    connectionId: connection.connectionId,
  };

  const stats = provider === "jira"
    ? await sweepJiraIssueDetails(executor, client, ctx)
    : provider === "github"
      ? await sweepGithubComments(executor, client, ctx)
      : await sweepBitbucketPullRequests(executor, client, ctx);

  console.log(`[nango] proxy_details ${provider}/${payload.tenantId}: ${JSON.stringify(stats)}`);
  return { connections: connections.length, ...stats, exhausted: true };
}

// --- jira -------------------------------------------------------------------

async function sweepJiraIssueDetails(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
): Promise<Record<string, unknown>> {
  const sites = await jiraAccessibleSites(client, ctx);
  let pages = 0;
  let issues = 0;
  let captured = 0;
  let comments = 0;
  let materialized = 0;

  for (const site of sites) {
    const cursorKey = {
      tenantId: ctx.tenantId,
      provider: "jira",
      connectionId: ctx.connectionId,
      model: `issue_details:${site.cloudId}`,
    };
    const since = await loadStoredCursor(executor, cursorKey);
    // First run: no cursor → backfill from the beginning of time (the same
    // initial-backfill filter the Nango issues sync template uses).
    const jql = `updated >= "${since ? jqlTimestamp(since) : "1970-01-01"}" ORDER BY updated ASC`;
    let nextPageToken: string | null = null;
    let maxUpdated = since;

    for (let page = 0; page < MAX_JIRA_SEARCH_PAGES; page += 1) {
      const response = await client.proxy({
        providerConfigKey: ctx.providerConfigKey,
        connectionId: ctx.connectionId,
        endpoint: `/ex/jira/${site.cloudId}/rest/api/3/search/jql`,
        params: {
          jql,
          fields: "*all",
          expand: "changelog",
          maxResults: JIRA_SEARCH_PAGE_SIZE,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      });
      pages += 1;
      const data = objectValue(response.data);
      const items = Array.isArray(data?.issues) ? data.issues.filter(isRecord) : [];
      for (const issue of items) {
        issues += 1;
        const result = await captureJiraIssueDetail(executor, client, ctx, site, issue);
        captured += result.captured;
        comments += result.comments;
        materialized += result.materialized;
        if (result.updated) maxUpdated = laterTimestamp(maxUpdated, result.updated);
      }
      nextPageToken = stringValue(data?.nextPageToken);
      if (!nextPageToken || items.length === 0) break;
    }

    // ASC ordering means a partially-paged sweep still advances safely.
    if (maxUpdated && maxUpdated !== since) {
      await saveStoredCursor(executor, cursorKey, maxUpdated);
    }
  }

  // Deletion reconcile (watermark-gated; null = gated/baselined this run).
  const deletionReconcile = await maybeReconcileJiraIssueDeletions(executor, client, ctx, sites);

  return { sites: sites.length, pages, issues, captured, comments, materialized, deletionReconcile };
}

async function jiraAccessibleSites(
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
): Promise<Array<{ cloudId: string; url: string | null }>> {
  const response = await client.proxy({
    providerConfigKey: ctx.providerConfigKey,
    connectionId: ctx.connectionId,
    endpoint: "/oauth/token/accessible-resources",
  });
  const rows = Array.isArray(response.data) ? response.data.filter(isRecord) : [];
  const sites: Array<{ cloudId: string; url: string | null }> = [];
  for (const row of rows) {
    const cloudId = stringValue(row.id);
    if (!cloudId) continue;
    sites.push({ cloudId, url: stringValue(row.url) });
  }
  return sites;
}

async function captureJiraIssueDetail(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  site: { cloudId: string; url: string | null },
  issue: NangoRecord,
): Promise<{ captured: number; comments: number; materialized: number; updated: string | null }> {
  const fields = objectValue(issue.fields);
  const updated = stringValue(fields?.updated);
  const issueId = stringValue(issue.id) ?? stringValue(issue.key) ?? "unknown";
  const issueKey = stringValue(issue.key);
  // `cloudId` is authoritative proxy-route context, not a project-key guess.
  // Persist it alongside the full API record so the raw source contract can
  // retain the immutable Atlassian site scope.
  const record: NangoRecord = {
    ...issue,
    cloudId: site.cloudId,
    ...(site.url && issueKey ? { web_url: `${site.url}/browse/${issueKey}` } : {}),
  };

  const result = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "jira",
    model: "IssueDetail",
    record,
    eventType: "issue_detail",
    sourceEventId: `nango:jira:issue_detail:${issueId}:${updated ?? nangoRecordVersion(record)}`,
    sourceUpdatedAt: updated,
  });
  // Already captured this exact issue version → comments/mirror already done.
  if (!result.stored) return { captured: 0, comments: 0, materialized: 0, updated };

  const comments = await captureJiraIssueComments(executor, client, ctx, site, {
    cloudId: site.cloudId,
    issueId,
    issueKey,
    container: objectValue(fields?.comment),
  });
  const file = await materializeJiraIssueSourceWiki(ctx.tenantId, {
    eventId: result.eventId,
    sourceEventId: result.sourceEventId,
    connectionId: ctx.connectionId,
    rawPayload: mergeJiraCommentsIntoIssue(record, comments.records, comments.total),
    commentSourceEvents: comments.sourceEvents,
  });
  return { captured: 1, comments: comments.captured, materialized: file ? 1 : 0, updated };
}

async function captureJiraIssueComments(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  site: { cloudId: string },
  input: { cloudId: string; issueId: string; issueKey: string | null; container: Record<string, unknown> | null },
): Promise<{
  captured: number;
  records: NangoRecord[];
  sourceEvents: Array<{ commentId: string; sourceEventId: string }>;
  total: number | null;
}> {
  let captured = 0;
  const sourceEvents = new Map<string, string>();
  const inline = Array.isArray(input.container?.comments) ? input.container.comments.filter(isRecord) : [];
  for (const comment of inline) {
    const result = await captureJiraComment(executor, ctx, input, comment);
    captured += result.captured;
    if (result.sourceEvent) sourceEvents.set(result.sourceEvent.commentId, result.sourceEvent.sourceEventId);
  }

  // The search payload's comment container is truncated for busy issues; page
  // the comment endpoint whenever the reported total exceeds what came inline.
  const total = numberValue(input.container?.total);
  if (total === null || total <= inline.length || input.issueId === "unknown") {
    return {
      captured,
      records: inline,
      sourceEvents: [...sourceEvents].map(([commentId, sourceEventId]) => ({ commentId, sourceEventId })),
      total,
    };
  }

  const paged: NangoRecord[] = [];
  let startAt = 0;
  for (let page = 0; page < MAX_JIRA_COMMENT_PAGES; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: `/ex/jira/${site.cloudId}/rest/api/3/issue/${input.issueId}/comment`,
      params: { startAt, maxResults: JIRA_COMMENT_PAGE_SIZE },
      tolerateStatuses: [404],
    });
    if (response.status === 404) break;
    const data = objectValue(response.data);
    const rows = Array.isArray(data?.comments) ? data.comments.filter(isRecord) : [];
    if (rows.length === 0) break;
    paged.push(...rows);
    for (const comment of rows) {
      const result = await captureJiraComment(executor, ctx, input, comment);
      captured += result.captured;
      if (result.sourceEvent) {
        sourceEvents.set(result.sourceEvent.commentId, result.sourceEvent.sourceEventId);
      }
    }
    startAt += rows.length;
    const pagedTotal = numberValue(data?.total) ?? total;
    if (startAt >= pagedTotal) break;
  }
  return {
    captured,
    records: [...inline, ...paged],
    sourceEvents: [...sourceEvents].map(([commentId, sourceEventId]) => ({ commentId, sourceEventId })),
    total,
  };
}

async function captureJiraComment(
  executor: NangoExecutor,
  ctx: ProxyDetailsCtx,
  input: { cloudId: string; issueId: string; issueKey: string | null },
  comment: NangoRecord,
): Promise<{
  captured: number;
  sourceEvent: { commentId: string; sourceEventId: string } | null;
}> {
  const commentId = stringValue(comment.id);
  const version = stringValue(comment.updated) ?? stringValue(comment.created);
  // Issue context is flattened in so a comment event is self-describing.
  const record: NangoRecord = {
    ...comment,
    cloudId: input.cloudId,
    issueId: input.issueId,
    ...(input.issueKey ? { issueKey: input.issueKey } : {}),
  };
  const result = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "jira",
    model: "IssueComment",
    record,
    eventType: "issue_comment",
    sourceEventId: commentId
      ? `nango:jira:issue_comment:${commentId}:${version ?? nangoRecordVersion(record)}`
      : undefined,
    sourceUpdatedAt: version,
  });
  return {
    captured: result.stored ? 1 : 0,
    sourceEvent: commentId ? { commentId, sourceEventId: result.sourceEventId } : null,
  };
}

// --- jira deletion reconcile --------------------------------------------------

interface CapturedJiraIssue {
  issueId: string;
  issueKey: string | null;
}

interface JiraDeletionReconcileResult {
  tracked: number;
  listedPages: number;
  listingIncomplete: boolean;
  missing: number;
  tombstoned: number;
  mirrorsDeleted: number;
  confirmFailed: number;
  confirmSkipped: number;
}

/**
 * The Nango `issues` sync template has NO delete tracking (unlike every other
 * jira model), so a deleted issue would otherwise never tombstone and its
 * mirror file would persist forever. This reconcile closes that gap:
 * watermark-gated to once an hour, it diffs the captured issue ids against an
 * ids-only full listing of every accessible site and 404-confirms each
 * missing issue before tombstoning. Fail-soft: any enumeration/listing
 * failure logs, backs off a full interval, and tombstones nothing.
 */
async function maybeReconcileJiraIssueDeletions(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  sites: Array<{ cloudId: string }>,
): Promise<JiraDeletionReconcileResult | null> {
  if (sites.length === 0) return null;
  const cursorKey = {
    tenantId: ctx.tenantId,
    provider: "jira",
    connectionId: ctx.connectionId,
    model: JIRA_DELETION_SWEEP_MODEL,
  };
  const lastSweepAt = await loadStoredCursor(executor, cursorKey);
  if (!lastSweepAt) {
    // Baseline on the first run (the initial backfill is still filling the
    // captured set); the sweep itself starts one interval later.
    await saveStoredCursor(executor, cursorKey, new Date().toISOString());
    return null;
  }
  const lastSweepMs = Date.parse(lastSweepAt);
  if (Number.isFinite(lastSweepMs) && Date.now() - lastSweepMs < JIRA_DELETION_SWEEP_INTERVAL_MS) {
    return null;
  }

  try {
    const result = await reconcileJiraIssueDeletions(executor, client, ctx, sites);
    await saveStoredCursor(executor, cursorKey, new Date().toISOString());
    return result;
  } catch (err) {
    // Fail-soft: a failed enumeration/listing must not fail the capture sweep
    // and must not tombstone; back off a full interval instead of retrying
    // every 300s tick.
    await saveStoredCursor(executor, cursorKey, new Date().toISOString());
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[nango] jira deletion reconcile failed for ${ctx.tenantId}: ${message}`);
    return null;
  }
}

async function reconcileJiraIssueDeletions(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  sites: Array<{ cloudId: string }>,
): Promise<JiraDeletionReconcileResult> {
  const tracked = await capturedJiraIssues(executor, ctx.tenantId);
  const result: JiraDeletionReconcileResult = {
    tracked: tracked.length,
    listedPages: 0,
    listingIncomplete: false,
    missing: 0,
    tombstoned: 0,
    mirrorsDeleted: 0,
    confirmFailed: 0,
    confirmSkipped: 0,
  };
  if (tracked.length === 0) return result;

  // ids-only listing of everything each site still has. A truncated listing
  // stays safe — the 404-confirm below is what authorizes a tombstone; a
  // missing-but-alive issue just costs one extra fetch.
  const listed = new Set<string>();
  for (const site of sites) {
    let nextPageToken: string | null = null;
    for (let page = 0; page < MAX_JIRA_DELETION_LISTING_PAGES; page += 1) {
      const response = await client.proxy({
        providerConfigKey: ctx.providerConfigKey,
        connectionId: ctx.connectionId,
        endpoint: `/ex/jira/${site.cloudId}/rest/api/3/search/jql`,
        params: {
          jql: "ORDER BY created ASC",
          fields: "id",
          maxResults: JIRA_DELETION_LISTING_PAGE_SIZE,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      });
      result.listedPages += 1;
      const data = objectValue(response.data);
      const items = Array.isArray(data?.issues) ? data.issues.filter(isRecord) : [];
      for (const item of items) {
        const id = stringValue(item.id);
        if (id) listed.add(id);
      }
      nextPageToken = stringValue(data?.nextPageToken);
      if (!nextPageToken || items.length === 0) break;
      if (page === MAX_JIRA_DELETION_LISTING_PAGES - 1) result.listingIncomplete = true;
    }
  }

  let confirms = 0;
  for (const issue of tracked) {
    if (listed.has(issue.issueId)) continue;
    result.missing += 1;
    if (confirms >= MAX_JIRA_DELETION_CONFIRMS) {
      result.confirmSkipped += 1;
      continue;
    }
    confirms += 1;
    const verdict = await confirmJiraIssueDeleted(client, ctx, sites, issue.issueId);
    if (verdict === "unknown") {
      // 403/5xx/network on confirm — cannot prove deletion; retry next sweep.
      result.confirmFailed += 1;
      continue;
    }
    if (verdict === "present") continue; // moved/renamed issues still fetch by id

    const detectedAt = new Date().toISOString();
    const tombstone = await processGenericNangoRecord(executor, {
      tenantId: ctx.tenantId,
      provider: "jira",
      model: "Issue",
      record: {
        id: issue.issueId,
        ...(issue.issueKey ? { key: issue.issueKey } : {}),
        deleted: true,
        deletionReason: "reconcile_sweep",
        deletionDetectedAt: detectedAt,
      },
      eventType: "issue", // `.deleted` suffix appended by the deleted-record path
      // Stable (unversioned) key: re-observing the same deletion is an
      // ON CONFLICT DO NOTHING no-op.
      sourceEventId: `nango:jira:issue:${issue.issueId}:deleted`,
      timestamp: detectedAt,
      sourceUpdatedAt: detectedAt,
    });
    if (tombstone.stored) result.tombstoned += 1;
    // Mirror delete runs even when the tombstone row already existed: it is
    // idempotent and covers a prior run that crashed between the two steps.
    if (issue.issueKey) {
      await deleteJiraIssueSourceWiki(ctx.tenantId, issue.issueKey, { refreshIndexes: false });
      result.mirrorsDeleted += 1;
    }
  }
  if (result.mirrorsDeleted > 0) {
    await materializeSourceWikiIndexes(ctx.tenantId);
  }
  return result;
}

/**
 * Distinct captured jira issue ids for the tenant (slim sync `issue` records
 * plus proxy `issue_detail` records), with the latest known issue key for the
 * mirror path, excluding ids that already carry a `.deleted` tombstone.
 * Captured keys hold no cloudId (`nango:jira:issue:<id>:<version>` /
 * `nango:jira:issue_detail:<id>:<updated>`), so the diff and the 404-confirm
 * both span every accessible site.
 */
async function capturedJiraIssues(executor: NangoExecutor, tenantId: string): Promise<CapturedJiraIssue[]> {
  const rows = rowsFromExecute<{ issue_id: string | null; issue_key: string | null; tombstoned: boolean | string | null }>(
    await executor.execute(sql`
      SELECT
        raw_payload->>'id' AS issue_id,
        max(raw_payload->>'key') AS issue_key,
        bool_or(event_type LIKE '%.deleted') AS tombstoned
      FROM activity_events
      WHERE user_id = ${tenantId}
        AND source = 'jira'
        AND event_type IN ('issue', 'issue_detail', 'issue.deleted', 'issue_detail.deleted')
        AND raw_payload->>'id' IS NOT NULL
      GROUP BY raw_payload->>'id'
    `),
  );
  const out: CapturedJiraIssue[] = [];
  for (const row of rows) {
    const issueId = stringValue(row.issue_id);
    if (!issueId) continue;
    const tombstoned = row.tombstoned === true || row.tombstoned === "t" || row.tombstoned === "true";
    if (tombstoned) continue;
    out.push({ issueId, issueKey: stringValue(row.issue_key) });
  }
  return out;
}

/**
 * Only a direct 404 proves deletion. Captured issue ids carry no site, so a
 * multi-site tenant needs a 404 from EVERY site — a 200 anywhere means the
 * issue merely left the listing (or the listing was truncated). Any
 * non-tolerated status (403/5xx) or network failure yields "unknown": skip,
 * never tombstone on ambiguity.
 */
async function confirmJiraIssueDeleted(
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  sites: Array<{ cloudId: string }>,
  issueId: string,
): Promise<"deleted" | "present" | "unknown"> {
  let sawNotFound = false;
  for (const site of sites) {
    try {
      const response = await client.proxy({
        providerConfigKey: ctx.providerConfigKey,
        connectionId: ctx.connectionId,
        endpoint: `/ex/jira/${site.cloudId}/rest/api/3/issue/${issueId}`,
        params: { fields: "id" },
        tolerateStatuses: [404],
      });
      if (response.status === 404) {
        sawNotFound = true;
        continue;
      }
      return "present";
    } catch {
      return "unknown";
    }
  }
  return sawNotFound ? "deleted" : "unknown";
}

/** JQL-safe "yyyy-MM-dd HH:mm" (UTC) with the lookback window applied. */
function jqlTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "1970-01-01";
  const date = new Date(parsed - JIRA_JQL_LOOKBACK_MS);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// --- github -----------------------------------------------------------------

const GITHUB_COMMENT_LANES = [
  // issues/comments covers conversation comments on BOTH issues and PRs.
  { path: "issues/comments", model: "IssueComment", eventType: "issue_comment", cursorPrefix: "issue_comments" },
  { path: "pulls/comments", model: "PullRequestReviewComment", eventType: "pr_review_comment", cursorPrefix: "pr_review_comments" },
] as const;

async function sweepGithubComments(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
): Promise<Record<string, unknown>> {
  // The enabled selection IS the sweep set (see discoverRepos). Enabled repos
  // missing a current `repository` record - its projection was removed while
  // the repo was unselected - get it re-seeded from /installation/repositories:
  // repo.md plus the numeric-repo-id identity for the new current projection.
  // Unselected repos are never captured here (the selection reconcile would
  // tombstone their current projection on the next sweep).
  const repos = await discoverRepos(executor, ctx.tenantId, "github");
  let discoveredRepos = 0;
  let forbidden = 0;
  if (repos.length > 0) {
    const captured = new Set((await capturedGithubRepos(executor, ctx.tenantId)).map((repo) => repo.fullName));
    const missing = new Set(repos.filter((fullName) => !captured.has(fullName)));
    if (missing.size > 0) {
      const discovery = await discoverGithubReposViaProxy(executor, client, ctx, missing);
      discoveredRepos = discovery.captured;
      forbidden += discovery.forbidden;
    }
  }

  let pages = 0;
  let captured = 0;
  let notFound = 0;
  let materialized = 0;
  for (const repoFullName of repos) {
    const changedParents = new Map<string, GithubParentSourceRef>();
    for (const lane of GITHUB_COMMENT_LANES) {
      const result = await sweepGithubRepoCommentLane(executor, client, ctx, repoFullName, lane);
      pages += result.pages;
      captured += result.captured;
      if (result.notFound) notFound += 1;
      for (const parent of result.changedParents) {
        changedParents.set(`${parent.kind}:${parent.number}`, parent);
      }
    }
    for (const parent of changedParents.values()) {
      if (await rematerializeGithubParentSourceWiki(ctx.tenantId, parent, { refreshIndexes: false })) {
        materialized += 1;
      }
    }
  }
  if (materialized > 0) await materializeSourceWikiIndexes(ctx.tenantId);
  return { repos: repos.length, discoveredRepos, forbidden, pages, captured, materialized, notFound };
}

async function sweepGithubRepoCommentLane(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  repoFullName: string,
  lane: (typeof GITHUB_COMMENT_LANES)[number],
): Promise<{ pages: number; captured: number; notFound: boolean; changedParents: GithubParentSourceRef[] }> {
  const [owner, repo] = splitRepoFullName(repoFullName);
  if (!owner || !repo) return { pages: 0, captured: 0, notFound: false, changedParents: [] };

  const cursorKey = {
    tenantId: ctx.tenantId,
    provider: "github",
    connectionId: ctx.connectionId,
    model: `${lane.cursorPrefix}:${repoFullName}`,
  };
  const since = await loadStoredCursor(executor, cursorKey);

  let pages = 0;
  let captured = 0;
  let maxUpdated = since;
  const changedParents = new Map<string, GithubParentSourceRef>();
  for (let page = 1; page <= MAX_GITHUB_COMMENT_PAGES_PER_REPO; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: `/repos/${owner}/${repo}/${lane.path}`,
      params: {
        sort: "updated",
        direction: "asc",
        per_page: GITHUB_PER_PAGE,
        page,
        ...(since ? { since } : {}),
      },
      tolerateStatuses: [404],
    });
    if (response.status === 404) return { pages, captured, notFound: true, changedParents: [...changedParents.values()] };
    const items = Array.isArray(response.data) ? response.data.filter(isRecord) : [];
    if (items.length === 0) break;
    pages += 1;

    for (const comment of items) {
      const commentId = stringValue(comment.id);
      const updated = stringValue(comment.updated_at) ?? stringValue(comment.created_at);
      const result = await processGenericNangoRecord(executor, {
        tenantId: ctx.tenantId,
        provider: "github",
        model: lane.model,
        record: comment,
        eventType: lane.eventType,
        sourceEventId: commentId
          ? `nango:github:${lane.eventType}:${commentId}:${updated ?? nangoRecordVersion(comment)}`
          : undefined,
        sourceUpdatedAt: updated,
      });
      if (result.stored) {
        captured += 1;
        for (const parent of githubCommentParentRefs(comment, lane.eventType, repoFullName)) {
          changedParents.set(`${parent.kind}:${parent.number}`, parent);
        }
      }
      if (updated) maxUpdated = laterTimestamp(maxUpdated, updated);
    }

    if (items.length < GITHUB_PER_PAGE) break;
  }

  if (maxUpdated && maxUpdated !== since) {
    await saveStoredCursor(executor, cursorKey, maxUpdated);
  }
  return { pages, captured, notFound: false, changedParents: [...changedParents.values()] };
}

function githubCommentParentRefs(
  comment: NangoRecord,
  eventType: "issue_comment" | "pr_review_comment",
  repoFullName: string,
): GithubParentSourceRef[] {
  if (eventType === "pr_review_comment") {
    const number = githubUrlParentNumber(comment.pull_request_url, repoFullName, "pulls");
    return number ? [{ kind: "pull_request", repoFullName, number }] : [];
  }

  const issueNumber = githubUrlParentNumber(comment.html_url, repoFullName, "issues");
  if (issueNumber) return [{ kind: "issue", repoFullName, number: issueNumber }];
  const pullNumber = githubUrlParentNumber(comment.html_url, repoFullName, "pull");
  if (pullNumber) return [{ kind: "pull_request", repoFullName, number: pullNumber }];

  // GitHub's issue-comment payload normally has an html_url that distinguishes
  // issue vs PR. If it is absent, issue_url still identifies the number; try
  // both parent kinds and only the captured one will materialize.
  const number = githubUrlParentNumber(comment.issue_url, repoFullName, "issues");
  return number
    ? [
        { kind: "issue", repoFullName, number },
        { kind: "pull_request", repoFullName, number },
      ]
    : [];
}

function githubUrlParentNumber(value: unknown, repoFullName: string, segment: "issues" | "pull" | "pulls"): string | null {
  const raw = stringValue(value);
  const [owner, repo] = splitRepoFullName(repoFullName);
  if (!raw || !owner || !repo) return null;
  try {
    const parts = new URL(raw).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    for (let index = 0; index <= parts.length - 4; index += 1) {
      if (parts[index] === owner && parts[index + 1] === repo && parts[index + 2] === segment) {
        return /^\d+$/u.test(parts[index + 3] ?? "") ? parts[index + 3]! : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * GitHub App installations list their repos on `/installation/repositories`;
 * each one in `captureOnly` (opt-in: the enabled repos being re-seeded) is fed
 * through the registered Repository processor (raw capture + repo.md mirror).
 * 401/403/404 are counted, logged stops (external app-permission gaps), never
 * crashes.
 */
async function discoverGithubReposViaProxy(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  captureOnly: Set<string>,
): Promise<{ repos: string[]; captured: number; forbidden: number }> {
  const repos: string[] = [];
  let captured = 0;
  let forbidden = 0;
  for (let page = 1; page <= MAX_GITHUB_REPO_DISCOVERY_PAGES; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: "/installation/repositories",
      params: { per_page: GITHUB_PER_PAGE, page },
      tolerateStatuses: [401, 403, 404],
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      forbidden += 1;
      console.warn(`[nango] proxy_details github repo discovery got HTTP ${response.status} for ${ctx.tenantId}; skipped`);
      break;
    }
    const data = objectValue(response.data);
    const items = Array.isArray(data?.repositories) ? data.repositories.filter(isRecord) : [];
    if (items.length === 0) break;
    for (const repo of items) {
      const fullName = stringValue(repo.full_name);
      if (fullName) repos.push(fullName);
      if (!fullName || !captureOnly.has(fullName)) continue;
      const result = await processGithubRepositoryRecord(executor, repo, {
        tenantId: ctx.tenantId,
        providerConfigKey: ctx.providerConfigKey,
        connectionId: ctx.connectionId,
      });
      if (result.stored) captured += 1;
    }
    if (items.length < GITHUB_PER_PAGE) break;
  }
  return { repos, captured, forbidden };
}

// --- bitbucket ----------------------------------------------------------------

async function sweepBitbucketPullRequests(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
): Promise<Record<string, unknown>> {
  let repos = await discoverRepos(executor, ctx.tenantId, "bitbucket");
  let discoveredRepos = 0;
  let forbidden = 0;
  if (repos.length === 0) {
    const discovery = await discoverBitbucketReposViaProxy(executor, client, ctx);
    repos = discovery.repos;
    discoveredRepos = discovery.captured;
    forbidden += discovery.forbidden;
  }

  let pages = 0;
  let pullRequests = 0;
  let captured = 0;
  let comments = 0;
  let materialized = 0;
  let notFound = 0;
  const activity = emptyBitbucketActivityStats();
  for (const repoFullName of repos) {
    const result = await sweepBitbucketRepoPullRequests(executor, client, ctx, repoFullName);
    pages += result.pages;
    pullRequests += result.pullRequests;
    captured += result.captured;
    comments += result.comments;
    materialized += result.materialized;
    forbidden += result.forbidden;
    if (result.notFound) notFound += 1;
    addBitbucketActivityStats(activity, result.activity);
  }
  return { repos: repos.length, discoveredRepos, forbidden, pages, pullRequests, captured, comments, materialized, notFound, ...activity };
}

/** Visible per-sweep counters for the PR-activity lane. */
interface BitbucketActivityStats {
  /** PRs whose /activity feed was paged this sweep. */
  activityPrs: number;
  activityPages: number;
  activityCaptured: number;
  /** Comment-type activity entries skipped (the comments lane owns those, with real ids). */
  activityCommentEntries: number;
  /** 403/404 stops on the activity feed or the windowed listing (counted skips). */
  activityForbidden: number;
}

function emptyBitbucketActivityStats(): BitbucketActivityStats {
  return { activityPrs: 0, activityPages: 0, activityCaptured: 0, activityCommentEntries: 0, activityForbidden: 0 };
}

function addBitbucketActivityStats(target: BitbucketActivityStats, source: BitbucketActivityStats): void {
  target.activityPrs += source.activityPrs;
  target.activityPages += source.activityPages;
  target.activityCaptured += source.activityCaptured;
  target.activityCommentEntries += source.activityCommentEntries;
  target.activityForbidden += source.activityForbidden;
}

async function sweepBitbucketRepoPullRequests(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  repoFullName: string,
): Promise<{ pages: number; pullRequests: number; captured: number; comments: number; materialized: number; forbidden: number; notFound: boolean; activity: BitbucketActivityStats }> {
  const activity = emptyBitbucketActivityStats();
  const activitySwept = new Set<string>();
  const [owner, repo] = splitRepoFullName(repoFullName);
  if (!owner || !repo) return { pages: 0, pullRequests: 0, captured: 0, comments: 0, materialized: 0, forbidden: 0, notFound: false, activity };

  const cursorKey = {
    tenantId: ctx.tenantId,
    provider: "bitbucket",
    connectionId: ctx.connectionId,
    model: `pr_details:${repoFullName}`,
  };
  const since = await loadStoredCursor(executor, cursorKey);

  let pages = 0;
  let pullRequests = 0;
  let captured = 0;
  let comments = 0;
  let materialized = 0;
  let maxUpdated = since;
  for (let page = 1; page <= MAX_BITBUCKET_PR_PAGES_PER_REPO; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: `/repositories/${owner}/${repo}/pullrequests`,
      params: {
        pagelen: BITBUCKET_PAGELEN,
        page,
        sort: "updated_on",
        q: since ? `${BITBUCKET_PR_STATES} AND updated_on > "${since}"` : BITBUCKET_PR_STATES,
      },
      tolerateStatuses: [403, 404],
    });
    if (response.status === 403) {
      console.warn(`[nango] proxy_details bitbucket PR sweep got HTTP 403 for ${repoFullName}; skipped (scope gap)`);
      return { pages, pullRequests, captured, comments, materialized, forbidden: 1, notFound: false, activity };
    }
    if (response.status === 404) return { pages, pullRequests, captured, comments, materialized, forbidden: 0, notFound: true, activity };
    const values = isRecord(response.data) && Array.isArray(response.data.values)
      ? response.data.values.filter(isRecord)
      : [];
    if (values.length === 0) break;
    pages += 1;

    for (const item of values) {
      pullRequests += 1;
      const result = await captureBitbucketPullRequestDetail(executor, client, ctx, repoFullName, item, { activity, activitySwept });
      captured += result.captured;
      comments += result.comments;
      materialized += result.materialized;
      const listUpdated = stringValue(item.updated_on);
      if (listUpdated) maxUpdated = laterTimestamp(maxUpdated, listUpdated);
    }

    if (values.length < BITBUCKET_PAGELEN) break;
  }

  if (maxUpdated && maxUpdated !== since) {
    await saveStoredCursor(executor, cursorKey, maxUpdated);
  }

  // Windowed activity re-scan: approvals on PRs whose updated_on did not move
  // never enter the cursor-filtered listing above (see the lookback constant).
  await sweepBitbucketRepoActivityWindow(executor, client, ctx, repoFullName, activitySwept, activity);
  return { pages, pullRequests, captured, comments, materialized, forbidden: 0, notFound: false, activity };
}

/**
 * Pages the repo's OPEN PRs plus any-state PRs updated inside the lookback
 * window (newest first, bounded pages) and sweeps /activity for each PR the
 * main sweep did not already cover this run.
 */
async function sweepBitbucketRepoActivityWindow(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  repoFullName: string,
  activitySwept: Set<string>,
  stats: BitbucketActivityStats,
): Promise<void> {
  const floor = new Date(Date.now() - BITBUCKET_ACTIVITY_LOOKBACK_MS).toISOString();
  // Naming `state` in q opts out of the endpoint's default OPEN-only filter.
  const windowFilter = `(state = "OPEN" OR ((state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED") AND updated_on > "${floor}"))`;
  for (let page = 1; page <= MAX_BITBUCKET_ACTIVITY_LIST_PAGES; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: `/repositories/${repoFullName}/pullrequests`,
      params: { pagelen: BITBUCKET_PAGELEN, page, sort: "-updated_on", q: windowFilter },
      tolerateStatuses: [403, 404],
    });
    if (response.status === 403 || response.status === 404) {
      stats.activityForbidden += 1;
      console.warn(`[nango] proxy_details bitbucket activity window got HTTP ${response.status} for ${repoFullName}; skipped`);
      return;
    }
    const values = isRecord(response.data) && Array.isArray(response.data.values)
      ? response.data.values.filter(isRecord)
      : [];
    if (values.length === 0) break;
    for (const item of values) {
      const pullRequestId = stringValue(item.id);
      if (!pullRequestId || activitySwept.has(pullRequestId)) continue;
      activitySwept.add(pullRequestId);
      await captureBitbucketPullRequestActivity(executor, client, ctx, repoFullName, pullRequestId, stats);
    }
    if (values.length < BITBUCKET_PAGELEN) break;
  }
}

/**
 * Full PR record (description, reviewers, participants - fields both the
 * slim sync model and the list payload can omit), keyed
 * `nango:bitbucket:pull_request_detail:<workspace>/<repo>#<id>:<updated_on>`.
 * A stored (new-version) detail also re-materializes the PR mirror file and
 * pulls the PR's comments.
 */
async function captureBitbucketPullRequestDetail(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  repoFullName: string,
  listItem: NangoRecord,
  activity: { activity: BitbucketActivityStats; activitySwept: Set<string> },
): Promise<{ captured: number; comments: number; materialized: number }> {
  const pullRequestId = stringValue(listItem.id);
  let record: NangoRecord = listItem;
  if (pullRequestId) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: `/repositories/${repoFullName}/pullrequests/${pullRequestId}`,
      tolerateStatuses: [403, 404],
    });
    if (response.status === 200 && isRecord(response.data)) record = response.data;
  }
  const updated = stringValue(record.updated_on) ?? stringValue(listItem.updated_on);

  const result = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "bitbucket",
    model: "PullRequestDetail",
    record,
    eventType: "pull_request_detail",
    sourceEventId: `nango:bitbucket:pull_request_detail:${repoFullName}#${pullRequestId ?? "unknown"}:${updated ?? nangoRecordVersion(record)}`,
    sourceUpdatedAt: updated,
  });
  // Already captured this exact PR version → comments/mirror already done.
  if (!result.stored) return { captured: 0, comments: 0, materialized: 0 };

  const comments = pullRequestId
    ? await captureBitbucketPullRequestComments(executor, client, ctx, repoFullName, pullRequestId)
    : 0;
  // A new PR version means new activity may exist (state changes and content
  // edits show up here as `update` entries); first-run backfill lands the full
  // historical activity feed this way.
  if (pullRequestId && !activity.activitySwept.has(pullRequestId)) {
    activity.activitySwept.add(pullRequestId);
    await captureBitbucketPullRequestActivity(executor, client, ctx, repoFullName, pullRequestId, activity.activity);
  }
  const file = await materializeBitbucketPullRequestSourceWiki(ctx.tenantId, {
    eventId: result.eventId,
    sourceEventId: result.sourceEventId,
    repoFullName,
    pullRequestId: pullRequestId ?? "unknown",
    rawPayload: record,
  });
  return { captured: 1, comments, materialized: file ? 1 : 0 };
}

async function captureBitbucketPullRequestComments(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  repoFullName: string,
  pullRequestId: string,
): Promise<number> {
  let captured = 0;
  for (let page = 1; page <= MAX_BITBUCKET_COMMENT_PAGES; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: `/repositories/${repoFullName}/pullrequests/${pullRequestId}/comments`,
      params: { pagelen: BITBUCKET_PAGELEN, page },
      tolerateStatuses: [403, 404],
    });
    if (response.status === 403 || response.status === 404) break;
    const values = isRecord(response.data) && Array.isArray(response.data.values)
      ? response.data.values.filter(isRecord)
      : [];
    if (values.length === 0) break;

    for (const comment of values) {
      const commentId = stringValue(comment.id);
      const version = stringValue(comment.updated_on) ?? stringValue(comment.created_on);
      const result = await processGenericNangoRecord(executor, {
        tenantId: ctx.tenantId,
        provider: "bitbucket",
        model: "PullRequestComment",
        record: comment,
        eventType: "pr_comment",
        sourceEventId: commentId
          ? `nango:bitbucket:pr_comment:${repoFullName}#${pullRequestId}#${commentId}:${version ?? nangoRecordVersion(comment)}`
          : undefined,
        sourceUpdatedAt: version,
      });
      if (result.stored) captured += 1;
    }

    if (values.length < BITBUCKET_PAGELEN) break;
  }
  return captured;
}

/** Activity entry kinds keyed by which member the entry carries (entries have NO ids). */
const BITBUCKET_ACTIVITY_KINDS = ["approval", "changes_requested", "update", "comment"] as const;

/**
 * Pages `GET .../pullrequests/{id}/activity` (approve / request-changes /
 * update / comment entries). The endpoint paginates with opaque-`ctx` `next`
 * URLs — numeric `page` is not honored — so pagination follows `next` up to
 * the page cap. 403/404 are counted, logged stops like the other lanes.
 */
async function captureBitbucketPullRequestActivity(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
  repoFullName: string,
  pullRequestId: string,
  stats: BitbucketActivityStats,
): Promise<void> {
  stats.activityPrs += 1;
  let endpoint = `/repositories/${repoFullName}/pullrequests/${pullRequestId}/activity`;
  let params: Record<string, string | number> = { pagelen: BITBUCKET_PAGELEN };
  for (let page = 0; page < MAX_BITBUCKET_ACTIVITY_PAGES_PER_PR; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint,
      params,
      tolerateStatuses: [403, 404],
    });
    if (response.status === 403 || response.status === 404) {
      stats.activityForbidden += 1;
      console.warn(`[nango] proxy_details bitbucket activity got HTTP ${response.status} for ${repoFullName}#${pullRequestId}; skipped`);
      return;
    }
    const data = objectValue(response.data);
    const values = Array.isArray(data?.values) ? data.values.filter(isRecord) : [];
    if (values.length === 0) break;
    stats.activityPages += 1;

    for (const entry of values) {
      const kind = bitbucketActivityKind(entry);
      // The comments lane already captures comment payloads with real ids;
      // re-capturing them here would only duplicate rows.
      if (kind === "comment") {
        stats.activityCommentEntries += 1;
        continue;
      }
      const stored = await captureBitbucketPullRequestActivityEntry(executor, ctx, repoFullName, pullRequestId, kind, entry);
      if (stored) stats.activityCaptured += 1;
    }

    const next = bitbucketNextPage(stringValue(data?.next));
    if (!next) break;
    endpoint = next.endpoint;
    params = next.params;
  }
}

async function captureBitbucketPullRequestActivityEntry(
  executor: NangoExecutor,
  ctx: ProxyDetailsCtx,
  repoFullName: string,
  pullRequestId: string,
  kind: (typeof BITBUCKET_ACTIVITY_KINDS)[number] | null,
  entry: NangoRecord,
): Promise<boolean> {
  const detail = kind ? objectValue(entry[kind]) : null;
  // approval/changes_requested carry `user`; update entries carry `author`.
  const actor = bitbucketActorRef(detail?.user ?? detail?.author);
  const timestamp = stringValue(detail?.date) ?? stringValue(detail?.updated_on) ?? stringValue(detail?.created_on);
  // PR context is flattened in so an activity event is self-describing (the
  // raw entry keeps the kind member so downstream can split approval vs
  // changes_requested vs update; `activity_kind` mirrors it for SQL filters).
  const record: NangoRecord = {
    ...entry,
    repo_full_name: repoFullName,
    pull_request_id: pullRequestId,
    activity_kind: kind ?? "unknown",
  };
  const result = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "bitbucket",
    model: "pr_activity",
    record,
    eventType: "pr_activity",
    // Entries have no ids: kind+actor+date is deterministic (windowed re-scans
    // dedupe to no-ops). Entries missing any component fall back to the
    // generic content-hash key — still deterministic over the redacted record.
    sourceEventId: kind && actor && timestamp
      ? `nango:bitbucket:pr_activity:${repoFullName}#${pullRequestId}:${kind}:${actor}:${timestamp}`
      : undefined,
    sourceUpdatedAt: timestamp,
  });
  return result.stored;
}

function bitbucketActivityKind(entry: NangoRecord): (typeof BITBUCKET_ACTIVITY_KINDS)[number] | null {
  for (const kind of BITBUCKET_ACTIVITY_KINDS) {
    if (isRecord(entry[kind])) return kind;
  }
  return null;
}

/** Stable actor reference for key building: uuid > account_id > nickname > display_name. */
function bitbucketActorRef(value: unknown): string | null {
  const record = objectValue(value);
  if (!record) return null;
  return stringValue(record.uuid)
    ?? stringValue(record.account_id)
    ?? stringValue(record.nickname)
    ?? stringValue(record.display_name);
}

/** Split a Bitbucket `next` page URL into a proxy endpoint + params. */
function bitbucketNextPage(next: string | null): { endpoint: string; params: Record<string, string> } | null {
  if (!next) return null;
  try {
    const url = new URL(next);
    const endpoint = url.pathname.replace(/^\/2\.0(?=\/)/u, "");
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) params[key] = value;
    return { endpoint, params };
  } catch {
    return null;
  }
}

/**
 * Workspace-walk repo discovery for connections whose repositories sync has
 * not delivered records yet: `/workspaces` → `/repositories/{workspace}`.
 * Each repo feeds the registered Repository processor (raw capture + repo.md),
 * seeding both proxy lanes' discovery. 403/404 are counted, logged stops
 * (the dev connection currently lacks the repository OAuth scope - external).
 */
async function discoverBitbucketReposViaProxy(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  ctx: ProxyDetailsCtx,
): Promise<{ repos: string[]; captured: number; forbidden: number }> {
  const repos: string[] = [];
  let captured = 0;
  let forbidden = 0;

  const workspaces: string[] = [];
  for (let page = 1; page <= MAX_BITBUCKET_REPO_DISCOVERY_PAGES; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: "/workspaces",
      params: { pagelen: BITBUCKET_PAGELEN, page },
      tolerateStatuses: [403, 404],
    });
    if (response.status === 403 || response.status === 404) {
      forbidden += 1;
      console.warn(`[nango] proxy_details bitbucket workspace discovery got HTTP ${response.status} for ${ctx.tenantId}; skipped`);
      break;
    }
    const values = isRecord(response.data) && Array.isArray(response.data.values)
      ? response.data.values.filter(isRecord)
      : [];
    if (values.length === 0) break;
    for (const workspace of values) {
      const slug = stringValue(workspace.slug);
      if (slug) workspaces.push(slug);
    }
    if (values.length < BITBUCKET_PAGELEN) break;
  }

  for (const workspace of workspaces) {
    for (let page = 1; page <= MAX_BITBUCKET_REPO_DISCOVERY_PAGES; page += 1) {
      const response = await client.proxy({
        providerConfigKey: ctx.providerConfigKey,
        connectionId: ctx.connectionId,
        endpoint: `/repositories/${workspace}`,
        params: { pagelen: BITBUCKET_PAGELEN, page },
        tolerateStatuses: [403, 404],
      });
      if (response.status === 403 || response.status === 404) {
        forbidden += 1;
        console.warn(`[nango] proxy_details bitbucket repo discovery got HTTP ${response.status} for ${workspace}; skipped`);
        break;
      }
      const values = isRecord(response.data) && Array.isArray(response.data.values)
        ? response.data.values.filter(isRecord)
        : [];
      if (values.length === 0) break;
      for (const repo of values) {
        const fullName = stringValue(repo.full_name);
        const result = await processBitbucketRepositoryRecord(executor, repo, {
          tenantId: ctx.tenantId,
          providerConfigKey: ctx.providerConfigKey,
          connectionId: ctx.connectionId,
        });
        if (result.stored) captured += 1;
        if (fullName) repos.push(fullName);
      }
      if (values.length < BITBUCKET_PAGELEN) break;
    }
  }

  return { repos, captured, forbidden };
}

// --- shared helpers -----------------------------------------------------------

/** Later of two provider timestamps (parseable dates compared as instants). */
function laterTimestamp(current: string | null, candidate: string): string {
  if (!current) return candidate;
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  if (Number.isFinite(currentMs) && Number.isFinite(candidateMs)) {
    return candidateMs > currentMs ? candidate : current;
  }
  return candidate > current ? candidate : current;
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase().replace(/_/gu, "-");
}

function isRecord(value: unknown): value is NangoRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
