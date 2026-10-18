import { sql } from "drizzle-orm";
import {
  materializeBitbucketIssueSourceWiki,
  materializeGithubPullRequestSourceWiki,
} from "../../mirror/materializer.js";
import { materializeCapturedGithubIssueRecord } from "../github/processors.js";
import { enabledGithubRepos, reconcileGithubRepoSelection } from "../github/repo-sync.js";
import { nangoRecordVersion, processGenericNangoRecord } from "./capture.js";
import { NangoClient, NangoRequestError, type NangoProxyResult } from "./client.js";
import { loadStoredCursor, saveStoredCursor } from "./tasks.js";
import type { NangoExecutor, NangoRecord } from "./types.js";

/**
 * Issues capture via the Nango PROXY API.
 *
 * Nango's github-app and bitbucket sync TEMPLATES expose no `issues` sync
 * (github: commits + pull-requests + a repositories action; bitbucket:
 * branches/commits/pipelines/pull-requests/repositories/tags/members/
 * workspaces). Issues are therefore captured by calling the provider REST API
 * through Nango's proxy on our own 300s schedule, feeding the SAME generic
 * capture path as every synced record. Raw lands losslessly in
 * `activity_events`, redacted at persist by `processGenericNangoRecord`.
 *
 * The same sweep also fills two template gaps discovered against the live
 * environment:
 * - github PR items on the issues endpoint (normally filtered as sync
 *   duplicates) trigger a full REST `/pulls/{number}` detail fetch - the
 *   github-app sync template's PR model is slim (no body/number/repo), so the
 *   detail payload is the only complete PR record we can get.
 * - bitbucket issue comments are fetched per updated issue (no comments sync
 *   or repo-wide comments endpoint exists for bitbucket).
 */

export const NANGO_PROXY_ISSUES_TASK = "nango.proxy_issues";

/** Providers whose issues we capture via proxy (no Nango issues sync exists). */
export const NANGO_PROXY_ISSUES_PROVIDERS = ["github", "bitbucket"] as const;

const GITHUB_PER_PAGE = 100;
const BITBUCKET_PAGELEN = 50;
const MAX_ISSUE_PAGES_PER_REPO = 100;
const MAX_COMMENT_PAGES_PER_ISSUE = 40;

export interface NangoProxyIssuesPayload {
  tenantId: string;
  provider: string;
}

export interface NangoProxyIssuesOptions {
  client?: Pick<NangoClient, "proxy">;
}

export function isProxyIssuesProvider(provider: string): boolean {
  return (NANGO_PROXY_ISSUES_PROVIDERS as readonly string[]).includes(normalizeProvider(provider));
}

/**
 * Scheduled per tenant×provider (github/bitbucket). Discovers repos from
 * already-captured repository events, then pages each repo's issues endpoint
 * through the Nango proxy and captures every issue generically. No-op (counted
 * log) when the tenant has no active connection or no captured repos yet.
 */
export async function handleNangoProxyIssuesTask(
  executor: NangoExecutor,
  payload: NangoProxyIssuesPayload,
  options: NangoProxyIssuesOptions = {},
): Promise<Record<string, unknown>> {
  const provider = normalizeProvider(payload.provider);
  if (!isProxyIssuesProvider(provider)) {
    console.warn(`[nango] proxy_issues has no issues endpoint for ${provider}; nothing captured`);
    return { connections: 0, repos: 0, captured: 0, filtered: 0, prDetails: 0, comments: 0, trackersDisabled: 0, notFound: 0 };
  }

  const client = options.client ?? new NangoClient();
  const connections = await activeConnections(executor, payload.tenantId, provider);
  if (connections.length === 0) {
    console.log(`[nango] proxy_issues: no active ${provider} connection for ${payload.tenantId}; skipped`);
    return { connections: 0, repos: 0, captured: 0, filtered: 0, prDetails: 0, comments: 0, trackersDisabled: 0, notFound: 0 };
  }

  // Opt-in truthfulness: BEFORE sweeping, record an out-of-scope tombstone for
  // github repos no longer (or never) in the enabled set, then remove only
  // their derived mirrors/cursors. Raw history stays durable. Runs first so
  // the sweep below ingests the enabled set in the same cycle (a just-enabled
  // repo backfills from scratch because its cursors were cleared). Fail-soft
  // inside: an enumeration error writes nothing.
  const reconciled = provider === "github"
    ? await reconcileGithubRepoSelection(executor, payload.tenantId)
    : { tombstoned: [], keptEnabled: [] };

  const repos = await discoverRepos(executor, payload.tenantId, provider);
  if (repos.length === 0) {
    console.log(`[nango] proxy_issues: no ${provider} repos to sweep for ${payload.tenantId}; skipped`);
    return { connections: connections.length, repos: 0, captured: 0, filtered: 0, prDetails: 0, comments: 0, trackersDisabled: 0, notFound: 0, reconciledTombstoned: reconciled.tombstoned.length };
  }

  let captured = 0;
  let filtered = 0;
  let prDetails = 0;
  let comments = 0;
  let trackersDisabled = 0;
  let notFound = 0;
  let pages = 0;

  // One connection per tenant×provider is the norm; use the first for proxying
  // (dedupe by source_event_id makes a re-run through another connection a no-op).
  const connection = connections[0]!;
  for (const repoFullName of repos) {
    const result = await captureRepoIssues(executor, client, {
      tenantId: payload.tenantId,
      provider,
      providerConfigKey: connection.providerConfigKey,
      connectionId: connection.connectionId,
      repoFullName,
    });
    captured += result.captured;
    filtered += result.filtered;
    prDetails += result.prDetails;
    comments += result.comments;
    pages += result.pages;
    if (result.trackerDisabled) trackersDisabled += 1;
    if (result.notFound) notFound += 1;
  }

  console.log(
    `[nango] proxy_issues ${provider}/${payload.tenantId}: repos=${repos.length} reconciledTombstoned=${reconciled.tombstoned.length} pages=${pages} captured=${captured} prFiltered=${filtered} prDetails=${prDetails} comments=${comments} trackersDisabled=${trackersDisabled} notFound=${notFound}`,
  );
  return { connections: connections.length, repos: repos.length, pages, captured, filtered, prDetails, comments, trackersDisabled, notFound, reconciledTombstoned: reconciled.tombstoned.length, exhausted: true };
}

interface RepoIssueResult {
  captured: number;
  filtered: number;
  prDetails: number;
  comments: number;
  pages: number;
  trackerDisabled: boolean;
  notFound: boolean;
}

async function captureRepoIssues(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  input: { tenantId: string; provider: string; providerConfigKey: string; connectionId: string; repoFullName: string },
): Promise<RepoIssueResult> {
  const [owner, repo] = splitRepoFullName(input.repoFullName);
  if (!owner || !repo) return { captured: 0, filtered: 0, prDetails: 0, comments: 0, pages: 0, trackerDisabled: false, notFound: false };

  const cursorKey = {
    tenantId: input.tenantId,
    provider: input.provider,
    connectionId: input.connectionId,
    model: `issues:${input.repoFullName}`,
  };
  const since = await loadStoredCursor(executor, cursorKey);

  let captured = 0;
  let filtered = 0;
  let prDetails = 0;
  let comments = 0;
  let pages = 0;
  let maxUpdated = since;

  for (let page = 1; page <= MAX_ISSUE_PAGES_PER_REPO; page += 1) {
    let response: NangoProxyResult;
    try {
      response = await client.proxy({
        providerConfigKey: input.providerConfigKey,
        connectionId: input.connectionId,
        endpoint: issuesEndpoint(input.provider, owner, repo),
        params: issuesParams(input.provider, page, since),
        tolerateStatuses: [404],
      });
    } catch (err) {
      if (err instanceof NangoRequestError && err.status === 404) {
        return { captured, filtered, prDetails, comments, pages, trackerDisabled: input.provider === "bitbucket", notFound: input.provider !== "bitbucket" };
      }
      throw err;
    }

    if (response.status === 404) {
      // Bitbucket: repo has its issue tracker disabled → "no tracker", counted
      // skip, not an error. GitHub: repo gone/no access → counted not-found.
      return { captured, filtered, prDetails, comments, pages, trackerDisabled: input.provider === "bitbucket", notFound: input.provider !== "bitbucket" };
    }

    const items = extractIssues(input.provider, response.data);
    if (items.length === 0) break;
    pages += 1;

    for (const issue of items) {
      const updated = issueUpdatedAt(input.provider, issue);
      // Both true issues and PR items advance the cursor: the PR-detail fetch
      // below is bounded by `since`, so PR-only activity must move it too.
      if (updated && (!maxUpdated || updated > maxUpdated)) maxUpdated = updated;

      // GitHub's issues endpoint returns PRs too; their issue-shaped records
      // are filtered (the PR lane owns them) but each one triggers a full REST
      // detail fetch - the sync template's PR model is slim (no body/number),
      // so `/pulls/{number}` is the only complete PR payload we can capture.
      if (input.provider === "github" && issue.pull_request != null) {
        filtered += 1;
        prDetails += await captureGithubPullRequestDetail(executor, client, input, issue);
        continue;
      }
      const result = await processGenericNangoRecord(executor, {
        tenantId: input.tenantId,
        provider: input.provider,
        model: "issues",
        record: issue,
        eventType: "issue",
        sourceEventId: issueSourceEventId(input.provider, input.repoFullName, issue, updated),
        sourceUpdatedAt: updated,
      });
      if (result.stored) {
        captured += 1;
        if (input.provider === "github") {
          await materializeCapturedGithubIssueRecord(issue, {
            tenantId: input.tenantId,
            eventId: result.eventId,
            sourceEventId: result.sourceEventId,
            repoKey: input.repoFullName,
            repoFullName: input.repoFullName,
          });
        }
      }
      // Bitbucket has no repo-wide comments endpoint and no comments sync, so
      // comments are pulled per updated issue (new-version captures only).
      if (input.provider === "bitbucket" && result.stored) {
        comments += await captureBitbucketIssueComments(executor, client, input, issue);
        const issueId = stringValue(issue.id);
        if (issueId) {
          await materializeBitbucketIssueSourceWiki(input.tenantId, {
            eventId: result.eventId,
            sourceEventId: result.sourceEventId,
            repoFullName: input.repoFullName,
            issueId,
            rawPayload: issue,
          });
        }
      }
    }

    if (items.length < pageSize(input.provider)) break;
  }

  if (maxUpdated && maxUpdated !== since) {
    await saveStoredCursor(executor, cursorKey, maxUpdated);
  }

  return { captured, filtered, prDetails, comments, pages, trackerDisabled: false, notFound: false };
}

/**
 * Full PR record via REST `/repos/{owner}/{repo}/pulls/{number}`, keyed
 * `nango:github:pull_request_detail:<owner>/<repo>#<number>:<updated_at>` -
 * a distinct kind from the slim sync record so both stay in the ledger.
 * A stored (new-version) detail also re-materializes the PR mirror file with
 * the full body/state/merged fields the sync model lacks.
 */
async function captureGithubPullRequestDetail(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  input: { tenantId: string; provider: string; providerConfigKey: string; connectionId: string; repoFullName: string },
  issueItem: NangoRecord,
): Promise<number> {
  const number = stringValue(issueItem.number);
  if (!number) return 0;
  const [owner, repo] = splitRepoFullName(input.repoFullName);
  if (!owner || !repo) return 0;

  const response = await client.proxy({
    providerConfigKey: input.providerConfigKey,
    connectionId: input.connectionId,
    endpoint: `/repos/${owner}/${repo}/pulls/${number}`,
    tolerateStatuses: [404],
  });
  if (response.status === 404 || !isRecord(response.data)) return 0;
  const record = response.data;
  const updated = stringValue(record.updated_at) ?? stringValue(issueItem.updated_at);

  const result = await processGenericNangoRecord(executor, {
    tenantId: input.tenantId,
    provider: "github",
    model: "PullRequestDetail",
    record,
    eventType: "pull_request_detail",
    sourceEventId: `nango:github:pull_request_detail:${input.repoFullName}#${number}:${updated ?? nangoRecordVersion(record)}`,
    sourceUpdatedAt: updated,
  });
  if (!result.stored) return 0;

  const baseRepo = objectValue(objectValue(record.base)?.repo);
  await materializeGithubPullRequestSourceWiki(input.tenantId, {
    eventId: result.eventId,
    sourceEventId: result.sourceEventId,
    repoKey: stringValue(baseRepo?.id) ?? input.repoFullName,
    repoFullName: input.repoFullName,
    number,
    rawPayload: record,
  });
  return 1;
}

/**
 * Bitbucket issue comments, paged per issue and keyed
 * `nango:bitbucket:issue_comment:<workspace>/<repo>#<issue>#<comment>:<updated_on>`.
 * Runs only when the parent issue stored a new version; re-fetch overlap
 * dedupes on the versioned key. 403/404 (scope gap / tracker gone mid-sweep)
 * are tolerated stops, not errors.
 */
async function captureBitbucketIssueComments(
  executor: NangoExecutor,
  client: Pick<NangoClient, "proxy">,
  input: { tenantId: string; providerConfigKey: string; connectionId: string; repoFullName: string },
  issue: NangoRecord,
): Promise<number> {
  const issueId = stringValue(issue.id);
  if (!issueId) return 0;
  const [owner, repo] = splitRepoFullName(input.repoFullName);
  if (!owner || !repo) return 0;

  let captured = 0;
  for (let page = 1; page <= MAX_COMMENT_PAGES_PER_ISSUE; page += 1) {
    const response = await client.proxy({
      providerConfigKey: input.providerConfigKey,
      connectionId: input.connectionId,
      endpoint: `/repositories/${owner}/${repo}/issues/${issueId}/comments`,
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
        tenantId: input.tenantId,
        provider: "bitbucket",
        model: "IssueComment",
        record: comment,
        eventType: "issue_comment",
        sourceEventId: commentId
          ? `nango:bitbucket:issue_comment:${input.repoFullName}#${issueId}#${commentId}:${version ?? nangoRecordVersion(comment)}`
          : undefined,
        sourceUpdatedAt: version,
      });
      if (result.stored) captured += 1;
    }

    if (values.length < BITBUCKET_PAGELEN) break;
  }
  return captured;
}

function issuesEndpoint(provider: string, owner: string, repo: string): string {
  return provider === "github"
    ? `/repos/${owner}/${repo}/issues`
    : `/repositories/${owner}/${repo}/issues`;
}

function issuesParams(provider: string, page: number, since: string | null): Record<string, string | number | undefined> {
  if (provider === "github") {
    return {
      state: "all",
      per_page: GITHUB_PER_PAGE,
      page,
      sort: "updated",
      direction: "asc",
      ...(since ? { since } : {}),
    };
  }
  return {
    pagelen: BITBUCKET_PAGELEN,
    page,
    sort: "updated_on",
    ...(since ? { q: `updated_on > "${since}"` } : {}),
  };
}

function pageSize(provider: string): number {
  return provider === "github" ? GITHUB_PER_PAGE : BITBUCKET_PAGELEN;
}

function extractIssues(provider: string, data: unknown): NangoRecord[] {
  if (provider === "github") {
    return Array.isArray(data) ? data.filter(isRecord) : [];
  }
  const values = isRecord(data) ? data.values : null;
  return Array.isArray(values) ? values.filter(isRecord) : [];
}

function issueUpdatedAt(provider: string, issue: NangoRecord): string | null {
  return provider === "github"
    ? stringValue(issue.updated_at)
    : stringValue(issue.updated_on);
}

/**
 * `nango:<provider>:issues:<id>:<version>` - the same versioned key shape the
 * generic capture builds. GitHub issue ids are globally unique; Bitbucket issue
 * ids are only per-repo, so the id component is repo-qualified to avoid
 * cross-repo collisions. Version = updated_at (github) / updated_on (bitbucket),
 * so a re-fetch of an unchanged issue dedupes and an edit appends a new version.
 */
export function issueSourceEventId(
  provider: string,
  repoFullName: string,
  issue: NangoRecord,
  updated: string | null,
): string {
  const version = updated ?? nangoRecordVersion(issue);
  const id = stringValue(issue.id) ?? stringValue(issue.uuid) ?? stringValue(issue.number);
  const idComponent = provider === "github"
    ? (id ?? "unknown")
    : `${repoFullName}#${id ?? "unknown"}`;
  return `nango:${provider}:issues:${idComponent}:${version}`;
}

export async function activeConnections(
  executor: NangoExecutor,
  tenantId: string,
  provider: string,
): Promise<Array<{ connectionId: string; providerConfigKey: string }>> {
  const rows = rowsFromExecute<{
    external_account_id: string | null;
    nango_connection_id: string | null;
    provider_config_key: string | null;
  }>(await executor.execute(sql`
    SELECT
      external_account_id,
      metadata->>'nangoConnectionId' AS nango_connection_id,
      metadata->>'providerConfigKey' AS provider_config_key
    FROM connections
    WHERE tenant_id = ${tenantId}
      AND provider = ${provider}
      AND status = 'active'
  `));

  const out: Array<{ connectionId: string; providerConfigKey: string }> = [];
  for (const row of rows) {
    const connectionId = stringValue(row.external_account_id) ?? stringValue(row.nango_connection_id);
    if (!connectionId) continue;
    out.push({ connectionId, providerConfigKey: stringValue(row.provider_config_key) ?? provider });
  }
  return out;
}

/**
 * The repos both proxy sweep lanes iterate. GitHub is OPT-IN and the
 * `github_repo_sync` selection is authoritative: the enabled rows ARE the
 * sweep set - deliberately NOT derived from captured `repository` events,
 * because the selection reconcile removes unselected repos' current
 * projections and a just-enabled repo must sweep (backfill) before any
 * current record exists.
 * A selected repo the installation lost access to 404s as a counted skip.
 * Bitbucket keeps event-based discovery (no selection table): repos flow from
 * already-captured `repository` events, never new discovery here.
 */
export async function discoverRepos(executor: NangoExecutor, tenantId: string, provider: string): Promise<string[]> {
  if (provider === "github") {
    return enabledGithubRepos(executor, tenantId);
  }
  const rows = rowsFromExecute<{ full_name: string | null }>(await executor.execute(sql`
    SELECT DISTINCT raw_payload->>'full_name' AS full_name
    FROM activity_events
    WHERE user_id = ${tenantId}
      AND source = ${provider}
      AND event_type = 'repository'
      AND raw_payload->>'full_name' IS NOT NULL
  `));
  return rows
    .map((row) => stringValue(row.full_name))
    .filter((name): name is string => Boolean(name && name.includes("/")));
}

export function splitRepoFullName(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  if (slash < 0) return [fullName, ""];
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
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

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
