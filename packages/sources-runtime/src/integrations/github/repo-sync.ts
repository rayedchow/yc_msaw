import { sql } from "drizzle-orm";
import { enqueueGraphDeleteForMirrorFile } from "../../graph/wiring/ingest-hook.js";
import { githubRepoSourceWikiDirectory, materializeSourceWikiIndexes } from "../../mirror/materializer.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import type { NangoClient } from "../nango/client.js";
import type { NangoExecutor } from "../nango/types.js";

/**
 * Per-tenant, per-repo GitHub sync selection (`github_repo_sync`).
 *
 * OPT-IN default: a repo syncs ONLY when it has an explicit selection row with
 * `syncing = true`. No row (or `syncing = false`) = not synced - the proxy
 * sweep lanes (issues, PR details, comments) sweep exactly the enabled set.
 *
 * An explicit dashboard unsync is DESTRUCTIVE for github repos (a deliberate
 * privacy exception to capture-everything): it purges that repo's captured
 * data through `purgeGithubRepoData`. Scheduled reconciliation is different:
 * it appends an out-of-scope tombstone while retaining raw history, then
 * removes only derived mirrors and sweep cursors.
 */

const GITHUB_PER_PAGE = 100;
const MAX_INSTALLATION_REPO_PAGES = 20;

/** `sources/github` - derived from the materializer's path scheme so the two can never drift. */
const GITHUB_MIRROR_ROOT = githubRepoSourceWikiDirectory("owner/repo").split("/").slice(0, -2).join("/");

export interface GithubInstallationRepo {
  fullName: string;
  id: number | null;
  private: boolean | null;
}

export interface GithubCapturedRepo {
  fullName: string;
  lastEventAt: string | null;
}

export interface GithubRepoSyncEntry {
  fullName: string;
  id: number | null;
  private: boolean | null;
  syncing: boolean;
  lastEventAt: string | null;
}

/** Upsert the tenant's sync selection for one repo. Callers that stop a repo also purge its data (see `purgeGithubRepoData`). */
export async function setGithubRepoSyncing(
  executor: NangoExecutor,
  tenantId: string,
  repoFullName: string,
  syncing: boolean,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO github_repo_sync (tenant_id, repo_full_name, syncing, updated_at)
    VALUES (${tenantId}, ${repoFullName}, ${syncing}, now())
    ON CONFLICT (tenant_id, repo_full_name)
    DO UPDATE SET syncing = EXCLUDED.syncing, updated_at = now()
  `);
}

/** The tenant's full selection map (repo full name → syncing). Repos absent from the map default to NOT syncing (opt-in). */
export async function githubRepoSyncSelection(executor: NangoExecutor, tenantId: string): Promise<Map<string, boolean>> {
  const rows = rowsFromExecute<{ repo_full_name: string | null; syncing: boolean | null }>(await executor.execute(sql`
    SELECT repo_full_name, syncing
    FROM github_repo_sync
    WHERE tenant_id = ${tenantId}
  `));
  const selection = new Map<string, boolean>();
  for (const row of rows) {
    const fullName = stringValue(row.repo_full_name);
    if (fullName) selection.set(fullName, row.syncing !== false);
  }
  return selection;
}

/** The repos the tenant explicitly enabled (`syncing = true`), sorted - this IS the github sweep set. */
export async function enabledGithubRepos(executor: NangoExecutor, tenantId: string): Promise<string[]> {
  const selection = await githubRepoSyncSelection(executor, tenantId);
  return [...selection.entries()]
    .filter(([, syncing]) => syncing)
    .map(([fullName]) => fullName)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * DELIBERATE DESTRUCTIVE PRIVACY OVERRIDE (github repos only): an explicit
 * user-initiated unsync removes its captured data instead of keeping it.
 * Scheduled scope reconciliation must use `tombstoneGithubRepoOutOfScope`,
 * which never deletes raw history. This user-purge deletes, always scoped to
 * this tenant AND this repo:
 *
 * - `activity_events`: every github event type for the repo. Repo identity is
 *   matched across all the key/payload shapes github events use - repo full
 *   name in the payload (repository records, sync records, PR base repo),
 *   api-url payload fields (proxy issues `repository_url`, comment
 *   `issue_url`/`pull_request_url`), payload `html_url`s under the repo, and
 *   `source_event_id` prefixes for both the full-name and numeric-repo-id key
 *   forms (`github:issue|pr|commit|repo:<key>:` and
 *   `nango:github:pull_request_detail:<owner/repo>#`).
 * - `mirror_files` under `sources/github/<owner>/<repo>/`, then a source-wiki
 *   index refresh so index pages stop linking the removed files.
 * - per-repo proxy sweep cursors in `conversation_watermarks`
 *   (`issues:` / `issue_comments:` / `pr_review_comments:`), so re-adding the
 *   repo recaptures history from scratch.
 *
 * `binary_documents` never stores github rows (its provider CHECK allows only
 * 'drive-pdf'/'upload'), so there is nothing to delete there. Idempotent: a
 * second run matches nothing.
 */
export async function purgeGithubRepoData(
  executor: NangoExecutor,
  tenantId: string,
  repoFullName: string,
): Promise<void> {
  const apiRepoBase = `https://api.github.com/repos/${repoFullName}`;
  const webRepoBase = `https://github.com/${repoFullName}`;

  // Numeric repo ids seen for this full name (sync-record keys prefer the
  // immutable numeric id over owner/repo). Collected BEFORE the delete below
  // removes the repository events that carry them.
  const idRows = rowsFromExecute<{ repo_id: string | null }>(await executor.execute(sql`
    SELECT DISTINCT raw_payload->>'id' AS repo_id
    FROM activity_events
    WHERE user_id = ${tenantId}
      AND source = 'github'
      AND event_type = 'repository'
      AND raw_payload->>'full_name' = ${repoFullName}
      AND raw_payload->>'id' IS NOT NULL
  `));
  const repoKeys = [repoFullName, ...idRows.map((row) => stringValue(row.repo_id)).filter((id): id is string => id != null)];

  const keyPrefixes = repoKeys.flatMap((key) => [
    `github:issue:${key}:`,
    `github:pr:${key}:`,
    `github:commit:${key}:`,
    `github:repo:${key}:`,
  ]);
  keyPrefixes.push(`nango:github:pull_request_detail:${repoFullName}#`);

  // Mirror files under the repo's directory. starts_with (not LIKE) so repo
  // names containing `_` never wildcard-match a sibling repo's directory.
  const repoDirectory = githubRepoSourceWikiDirectory(repoFullName);
  const mirrorRows = rowsFromExecute<{ path: string }>(await executor.execute(sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${tenantId}
      AND starts_with(path, ${`${repoDirectory}/`})
    ORDER BY path ASC
  `));
  for (const row of mirrorRows) {
    await enqueueGraphDeleteForMirrorFile(executor, { tenantId, path: row.path });
  }

  await executor.execute(sql`
    DELETE FROM activity_events
    WHERE user_id = ${tenantId}
      AND source = 'github'
      AND (
        raw_payload->>'full_name' = ${repoFullName}
        OR raw_payload#>>'{repository,full_name}' = ${repoFullName}
        OR raw_payload#>>'{repo,full_name}' = ${repoFullName}
        OR raw_payload#>>'{base,repo,full_name}' = ${repoFullName}
        OR raw_payload->>'repoFullName' = ${repoFullName}
        OR raw_payload->>'repo_full_name' = ${repoFullName}
        OR raw_payload->>'repository_url' = ${apiRepoBase}
        OR starts_with(raw_payload->>'url', ${`${apiRepoBase}/`})
        OR starts_with(raw_payload->>'issue_url', ${`${apiRepoBase}/`})
        OR starts_with(raw_payload->>'pull_request_url', ${`${apiRepoBase}/`})
        OR starts_with(raw_payload->>'html_url', ${`${webRepoBase}/`})
        OR ${sql.join(keyPrefixes.map((prefix) => sql`starts_with(source_event_id, ${prefix})`), sql` OR `)}
      )
  `);

  await executor.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${tenantId}
      AND starts_with(path, ${`${repoDirectory}/`})
  `);
  await materializeSourceWikiIndexes(tenantId);

  // Per-repo proxy sweep cursors, so a re-added repo backfills from scratch.
  const cursorNames = ["issues", "issue_comments", "pr_review_comments"].map((prefix) => `${prefix}:${repoFullName}`);
  await executor.execute(sql`
    DELETE FROM conversation_watermarks
    WHERE user_id = ${tenantId}
      AND provider = 'github'
      AND conversation_type = 'nango_sync_cursor'
      AND conversation_name IN (${sql.join(cursorNames.map((name) => sql`${name}`), sql`, `)})
  `);
}

/**
 * Scheduled selection reconciliation observes that a repo has moved out of
 * sync scope. Preserve the immutable ledger by recording that observation,
 * then remove only the derived mirror and incremental cursor state. The
 * stable source event id makes repeated reconcile passes idempotent.
 */
async function tombstoneGithubRepoOutOfScope(
  executor: NangoExecutor,
  tenantId: string,
  repoFullName: string,
): Promise<void> {
  const detectedAt = new Date().toISOString();
  const sourceEventId = `github:repo_scope:${repoFullName}:moved_out_of_scope`;
  const rows = rowsFromExecute<{ id: string }>(await executor.execute(sql`
    INSERT INTO activity_events (
      user_id,
      source,
      source_namespace,
      source_object_id,
      record_kind,
      event_type,
      timestamp,
      source_updated_at,
      wiki_eligibility_at,
      raw_payload,
      extracted_entities,
      source_event_id,
      processing_status
    )
    VALUES (
      ${tenantId},
      'github',
      NULL,
      NULL,
      'tombstone',
      'repository.moved_out_of_scope',
      ${detectedAt}::timestamptz,
      ${detectedAt}::timestamptz,
      ${detectedAt}::timestamptz,
      ${JSON.stringify({ full_name: repoFullName, scope_change: "moved_out_of_scope", detected_at: detectedAt })}::jsonb,
      NULL,
      ${sourceEventId},
      'collected'
    )
    ON CONFLICT (user_id, source_event_id) DO NOTHING
    RETURNING id
  `));
  const eventId = rows[0]?.id;
  if (eventId) await enqueueCollectedEventForProcessing(eventId, tenantId, "github");

  const repoDirectory = githubRepoSourceWikiDirectory(repoFullName);
  const mirrorRows = rowsFromExecute<{ path: string }>(await executor.execute(sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${tenantId}
      AND starts_with(path, ${`${repoDirectory}/`})
    ORDER BY path ASC
  `));
  for (const row of mirrorRows) {
    await enqueueGraphDeleteForMirrorFile(executor, { tenantId, path: row.path });
  }

  await executor.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${tenantId}
      AND starts_with(path, ${`${repoDirectory}/`})
  `);
  await materializeSourceWikiIndexes(tenantId);

  // A later re-enable starts from the complete history again. This state is
  // derived and disposable; unlike activity_events, it is not raw evidence.
  const cursorNames = ["issues", "issue_comments", "pr_review_comments"].map((prefix) => `${prefix}:${repoFullName}`);
  await executor.execute(sql`
    DELETE FROM conversation_watermarks
    WHERE user_id = ${tenantId}
      AND provider = 'github'
      AND conversation_type = 'nango_sync_cursor'
      AND conversation_name IN (${sql.join(cursorNames.map((name) => sql`${name}`), sql`, `)})
  `);
}

export interface GithubRepoReconcileResult {
  /** Captured repos NOT in the enabled set, tombstoned this run. */
  tombstoned: string[];
  /** Captured repos kept because they are in the enabled set. */
  keptEnabled: string[];
}

/**
 * Makes the opt-in selection truthful at the derived surface: any github repo
 * that has captured data but is NOT enabled (`syncing = true`) gets a
 * `repository.moved_out_of_scope` tombstone, then its mirror/cursors are
 * removed. Raw activity history is retained. This covers repos captured
 * before opt-in shipped and repos never explicitly toggled off. Runs at the
 * start of every github `nango.proxy_issues` sweep (300s).
 *
 * Captured-repo enumeration (cheap, two queries): distinct full names from
 * `repository` events UNION repo directories present under
 * `sources/github/<owner>/<repo>/` in `mirror_files`. Mirror-derived names are
 * path-sanitized, so an enabled repo is also matched by its sanitized mirror
 * directory (never purged just because its name needed sanitizing).
 *
 * Fail-soft: if enumerating the captured set or the enabled set fails, no
 * tombstone or derived-state removal is written. A failed per-repo operation
 * is logged and retried on the next sweep; the scope tombstone is idempotent
 * and always scoped to (tenant, repo).
 */
export async function reconcileGithubRepoSelection(
  executor: NangoExecutor,
  tenantId: string,
): Promise<GithubRepoReconcileResult> {
  let captured: string[];
  let enabled: Set<string>;
  try {
    const eventRepos = (await capturedGithubRepos(executor, tenantId)).map((repo) => repo.fullName);
    const mirrorRepos = await githubMirrorRepoNames(executor, tenantId);
    enabled = new Set(await enabledGithubRepos(executor, tenantId));
    captured = [...new Set([...eventRepos, ...mirrorRepos])];
  } catch (err) {
    console.warn(`[github] repo reconcile: enumeration failed for ${tenantId}; writing nothing this sweep`, err);
    return { tombstoned: [], keptEnabled: [] };
  }

  // GitHub owner/repo is case-insensitive, but the enabled selection is stored
  // as the user typed it while captured names come from the API - so compare
  // case-insensitively. Erring toward KEEPING (never purge on a mere casing
  // difference) is the safe direction for a scope-removal path.
  const enabledLower = new Set([...enabled].map((name) => name.toLowerCase()));
  const enabledDirectories = new Set([...enabled].map((name) => githubRepoSourceWikiDirectory(name)));
  const tombstoned: string[] = [];
  const keptEnabled: string[] = [];
  for (const fullName of captured) {
    if (
      enabled.has(fullName)
      || enabledLower.has(fullName.toLowerCase())
      || enabledDirectories.has(githubRepoSourceWikiDirectory(fullName))
    ) {
      keptEnabled.push(fullName);
      continue;
    }
    try {
      await tombstoneGithubRepoOutOfScope(executor, tenantId, fullName);
      tombstoned.push(fullName);
    } catch (err) {
      console.warn(`[github] repo reconcile: scope tombstone failed for ${tenantId}/${fullName}; will retry next sweep`, err);
    }
  }
  if (tombstoned.length > 0) {
    console.log(
      `[github] repo reconcile ${tenantId}: tombstoned ${tombstoned.length} out-of-scope repo(s) [${tombstoned.join(", ")}], kept ${keptEnabled.length} enabled`,
    );
  }
  return { tombstoned, keptEnabled };
}

/**
 * Repo full names parsed back out of mirror paths
 * (`sources/github/<owner>/<repo>/<file...>`). The depth guard (a non-empty
 * 5th segment) keeps root/owner index pages from parsing as phantom repos.
 */
async function githubMirrorRepoNames(executor: NangoExecutor, tenantId: string): Promise<string[]> {
  const rows = rowsFromExecute<{ owner: string | null; repo: string | null }>(await executor.execute(sql`
    SELECT DISTINCT split_part(path, '/', 3) AS owner, split_part(path, '/', 4) AS repo
    FROM mirror_files
    WHERE user_id = ${tenantId}
      AND starts_with(path, ${`${GITHUB_MIRROR_ROOT}/`})
      AND split_part(path, '/', 5) <> ''
  `));
  const names: string[] = [];
  for (const row of rows) {
    const owner = stringValue(row.owner);
    const repo = stringValue(row.repo);
    if (owner && repo) names.push(`${owner}/${repo}`);
  }
  return names;
}

/**
 * Repos already captured as `repository` events for the tenant, with the
 * latest capture timestamp. This is the fail-soft repo source when the Nango
 * proxy is unavailable.
 */
export async function capturedGithubRepos(executor: NangoExecutor, tenantId: string): Promise<GithubCapturedRepo[]> {
  const rows = rowsFromExecute<{ full_name: string | null; last_event_at: Date | string | null }>(await executor.execute(sql`
    SELECT raw_payload->>'full_name' AS full_name, max(created_at) AS last_event_at
    FROM activity_events
    WHERE user_id = ${tenantId}
      AND source = 'github'
      AND event_type = 'repository'
      AND raw_payload->>'full_name' IS NOT NULL
    GROUP BY raw_payload->>'full_name'
  `));
  const out: GithubCapturedRepo[] = [];
  for (const row of rows) {
    const fullName = stringValue(row.full_name);
    if (!fullName || !fullName.includes("/")) continue;
    out.push({ fullName, lastEventAt: isoValue(row.last_event_at) });
  }
  return out;
}

/**
 * Repos the GitHub App installation can see, via the Nango proxy
 * (`GET /installation/repositories`) - the authoritative available-repos
 * list. Returns null (never throws) on app-permission gaps (401/403/404) so
 * callers fall back to captured repos.
 */
export async function listGithubInstallationRepos(
  client: Pick<NangoClient, "proxy">,
  ctx: { providerConfigKey: string; connectionId: string },
): Promise<GithubInstallationRepo[] | null> {
  const repos: GithubInstallationRepo[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_REPO_PAGES; page += 1) {
    const response = await client.proxy({
      providerConfigKey: ctx.providerConfigKey,
      connectionId: ctx.connectionId,
      endpoint: "/installation/repositories",
      params: { per_page: GITHUB_PER_PAGE, page },
      tolerateStatuses: [401, 403, 404],
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) return null;
    const data = objectValue(response.data);
    const items = Array.isArray(data?.repositories) ? data.repositories.filter(isRecord) : [];
    if (items.length === 0) break;
    for (const repo of items) {
      const fullName = stringValue(repo.full_name);
      if (!fullName) continue;
      repos.push({
        fullName,
        id: numberValue(repo.id),
        private: typeof repo.private === "boolean" ? repo.private : null,
      });
    }
    if (items.length < GITHUB_PER_PAGE) break;
  }
  return repos;
}

/**
 * Union of installation repos (authoritative, may be null when the proxy is
 * unavailable) and captured repos, annotated with the tenant's sync
 * selection. No selection row = NOT syncing (opt-in default).
 */
export function mergeGithubRepoLists(input: {
  installation: GithubInstallationRepo[] | null;
  captured: GithubCapturedRepo[];
  selection: Map<string, boolean>;
}): GithubRepoSyncEntry[] {
  const byName = new Map<string, GithubRepoSyncEntry>();
  for (const repo of input.installation ?? []) {
    byName.set(repo.fullName, {
      fullName: repo.fullName,
      id: repo.id,
      private: repo.private,
      syncing: input.selection.get(repo.fullName) === true,
      lastEventAt: null,
    });
  }
  for (const repo of input.captured) {
    const existing = byName.get(repo.fullName);
    if (existing) {
      existing.lastEventAt = repo.lastEventAt;
    } else {
      byName.set(repo.fullName, {
        fullName: repo.fullName,
        id: null,
        private: null,
        syncing: input.selection.get(repo.fullName) === true,
        lastEventAt: repo.lastEventAt,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function isoValue(value: Date | string | null): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
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
