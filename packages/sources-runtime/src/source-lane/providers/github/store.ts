import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../core/types.js";
import { sha256Hex } from "./api.js";

/**
 * Durable state of the GitHub repository content lane (drizzle/9300). Every
 * statement is scoped by tenant_id plus the immutable repository id; nothing is
 * keyed by a value a caller can choose.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;
const INSERT_BATCH = 400;
export const MAX_SNAPSHOT_CHANGES = 2000;

/** Executor with transactions (drizzle node-postgres/postgres-js/pglite all provide it). */
export type GithubDb = DbExecutor & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows) ? ((result as { rows: T[] }).rows ?? []) : [];
}

export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isoOrNull(v: unknown): string | null {
  return toDate(v)?.toISOString() ?? null;
}

function json(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function int(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

export interface RepoScope {
  tenantId: string;
  repoId: string;
}

export interface RefScope extends RepoScope {
  ref: string;
}

/** Journal key of a file row: stable per (repository id, ref, path); identical to the SQL expression in commitScan. */
export function fileRowKey(repoId: string, ref: string, path: string): string {
  return `${repoId}:${sha256Hex(`${ref}\n${path}`)}`;
}

export function refRowKey(repoId: string, ref: string): string {
  return `${repoId}:${sha256Hex(`ref\n${ref}`).slice(0, 40)}`;
}

export function snapshotRowKey(repoId: string, ref: string, generation: number): string {
  return `${refRowKey(repoId, ref)}:g${generation}`;
}

// ------------------------------------------------------------------ quota

export async function quotaBlockedUntil(db: DbExecutor, quotaKey: string): Promise<{ until: Date; kind: string | null } | null> {
  const r = rowsOf<{ blocked_until: unknown; blocked_kind: string | null }>(
    await db.execute(sql`SELECT blocked_until, blocked_kind FROM github_source_quota WHERE quota_key = ${quotaKey} AND blocked_until > now()`),
  )[0];
  const until = toDate(r?.blocked_until);
  return until ? { until, kind: r?.blocked_kind ?? null } : null;
}

/**
 * Persist a cooldown for the GitHub bucket. With a provider deadline (Retry-After or
 * X-RateLimit-Reset) the cooldown is exactly that; a secondary limit without one backs off
 * exponentially per consecutive hit (60s, 120s, ... capped at 1h). Never shortens an existing cooldown.
 */
export async function recordRateLimited(
  db: DbExecutor,
  quotaKey: string,
  input: { retryAfterMs: number | null; status: number; kind: string; reason: string; defaultBackoffMs: number },
): Promise<Date> {
  const r = rowsOf<{ blocked_until: unknown }>(
    await db.execute(sql`
      INSERT INTO github_source_quota (quota_key, blocked_until, blocked_kind, rate_limit_streak, last_status, last_retry_after_ms, last_reason, updated_at)
      VALUES (${quotaKey}, now() + make_interval(secs => ${(input.retryAfterMs ?? input.defaultBackoffMs) / 1000}), ${input.kind}, 1, ${input.status}, ${input.retryAfterMs}, ${input.reason}, now())
      ON CONFLICT (quota_key) DO UPDATE SET
        rate_limit_streak = github_source_quota.rate_limit_streak + 1,
        blocked_until = GREATEST(
          COALESCE(github_source_quota.blocked_until, now()),
          now() + make_interval(secs => ${input.retryAfterMs !== null ? input.retryAfterMs / 1000 : null}::double precision),
          CASE WHEN ${input.retryAfterMs === null} THEN now() + make_interval(secs => LEAST(3600, ${input.defaultBackoffMs / 1000} * power(2, github_source_quota.rate_limit_streak))) END
        ),
        blocked_kind = EXCLUDED.blocked_kind,
        last_status = EXCLUDED.last_status,
        last_retry_after_ms = EXCLUDED.last_retry_after_ms,
        last_reason = EXCLUDED.last_reason,
        updated_at = now()
      RETURNING blocked_until
    `),
  )[0];
  return toDate(r?.blocked_until) ?? new Date(Date.now() + (input.retryAfterMs ?? input.defaultBackoffMs));
}

export async function recordRateObservation(db: DbExecutor, quotaKey: string, rate: { limit: number | null; remaining: number | null; resetAt: Date | null; resource: string | null }): Promise<void> {
  if (rate.remaining === null && rate.limit === null) return;
  await db.execute(sql`
    UPDATE github_source_quota SET rate_limit = ${rate.limit}, rate_remaining = ${rate.remaining}, rate_reset_at = ${rate.resetAt ? rate.resetAt.toISOString() : null}::timestamptz,
      rate_resource = ${rate.resource}, updated_at = now()
    WHERE quota_key = ${quotaKey}
  `);
}

export async function quotaRow(db: DbExecutor, quotaKey: string): Promise<Record<string, unknown> | null> {
  return rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT * FROM github_source_quota WHERE quota_key = ${quotaKey}`))[0] ?? null;
}

export async function clearRateStreak(db: DbExecutor, quotaKey: string): Promise<void> {
  await db.execute(sql`UPDATE github_source_quota SET rate_limit_streak = 0, updated_at = now() WHERE quota_key = ${quotaKey} AND rate_limit_streak <> 0`);
}

/** One active content sweep per GitHub bucket across all workers and tenants. */
export async function acquireQuotaLease(db: DbExecutor, quotaKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
  await db.execute(sql`INSERT INTO github_source_quota (quota_key) VALUES (${quotaKey}) ON CONFLICT (quota_key) DO NOTHING`);
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE github_source_quota SET lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
        WHERE quota_key = ${quotaKey} AND (lease_owner IS NULL OR lease_owner = ${owner} OR lease_until IS NULL OR lease_until < now())
        RETURNING quota_key
      `),
    ).length > 0
  );
}

export async function renewQuotaLease(db: DbExecutor, quotaKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE github_source_quota SET lease_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
        WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}
        RETURNING quota_key
      `),
    ).length > 0
  );
}

export async function releaseQuotaLease(db: DbExecutor, quotaKey: string, owner: string): Promise<void> {
  await db.execute(sql`UPDATE github_source_quota SET lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}`);
}

// ------------------------------------------------------------------ connections

export async function recordConnection(
  db: DbExecutor,
  input: { tenantId: string; connectionId: string; providerConfigKey: string; installationId: string | null; quotaKey: string; status: "ok" | "blocked" | "error"; reason: string | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO github_source_connections (tenant_id, connection_id, provider_config_key, installation_id, quota_key, status, reason, checked_at)
    VALUES (${input.tenantId}, ${input.connectionId}, ${input.providerConfigKey}, ${input.installationId}, ${input.quotaKey}, ${input.status}, ${input.reason}, now())
    ON CONFLICT (tenant_id, connection_id) DO UPDATE SET provider_config_key = EXCLUDED.provider_config_key, installation_id = EXCLUDED.installation_id,
      quota_key = EXCLUDED.quota_key, status = EXCLUDED.status, reason = EXCLUDED.reason, checked_at = now()
  `);
}

export async function listConnectionStates(db: DbExecutor, tenantId: string): Promise<Array<Record<string, unknown>>> {
  return rowsOf(await db.execute(sql`SELECT * FROM github_source_connections WHERE tenant_id = ${tenantId} ORDER BY connection_id`));
}

// ------------------------------------------------------------------ repositories

export interface RepoRow {
  tenant_id: string;
  row_key: string;
  repo_id: string;
  connection_id: string;
  provider_config_key: string;
  quota_key: string;
  full_name: string;
  selected_name: string;
  default_branch: string | null;
  extra_refs: string[];
  private: boolean | null;
  visibility: string | null;
  archived: boolean | null;
  raw: Record<string, unknown> | null;
  raw_text: string | null;
  raw_sha256: string | null;
  status: string;
  status_reason: string | null;
  path_epoch: number;
  last_checked_at: unknown;
  first_seen_at: unknown;
  updated_at: unknown;
}

function repoRow(r: Record<string, unknown>): RepoRow {
  return { ...(r as unknown as RepoRow), extra_refs: parseJson<string[]>(r.extra_refs, []), raw: parseJson<Record<string, unknown> | null>(r.raw, null), path_epoch: Number(r.path_epoch ?? 0) };
}

export async function getRepo(db: DbExecutor, tenantId: string, repoId: string): Promise<RepoRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT *, raw::text AS raw_text FROM github_source_repos WHERE tenant_id = ${tenantId} AND repo_id = ${repoId}`))[0];
  return r ? repoRow(r) : null;
}

export async function getRepoByRowKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<RepoRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT *, raw::text AS raw_text FROM github_source_repos WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? repoRow(r) : null;
}

export async function listRepos(db: DbExecutor, tenantId: string): Promise<RepoRow[]> {
  return rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT *, raw::text AS raw_text FROM github_source_repos WHERE tenant_id = ${tenantId} ORDER BY lower(full_name), repo_id`)).map(repoRow);
}

/** Repository whose selection name or current full name equals `name` (GitHub names are case-insensitive). */
export async function findRepoByName(db: DbExecutor, tenantId: string, name: string): Promise<RepoRow | null> {
  const r = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT *, raw::text AS raw_text FROM github_source_repos
      WHERE tenant_id = ${tenantId} AND (lower(selected_name) = lower(${name}) OR lower(full_name) = lower(${name}))
      ORDER BY (lower(selected_name) = lower(${name})) DESC, updated_at DESC LIMIT 1
    `),
  )[0];
  return r ? repoRow(r) : null;
}

export interface RepoUpsert {
  tenantId: string;
  repoId: string;
  connectionId: string;
  providerConfigKey: string;
  quotaKey: string;
  fullName: string;
  selectedName: string;
  defaultBranch: string | null;
  private: boolean | null;
  visibility: string | null;
  archived: boolean | null;
  raw: Record<string, unknown>;
}

/** Insert or refresh a repository; a changed full name bumps path_epoch on the repository and every file row (re-export at the new path). */
export async function upsertRepo(db: DbExecutor, input: RepoUpsert): Promise<{ renamedFrom: string | null }> {
  const rawText = json(input.raw);
  const rawSha = sha256Hex(rawText);
  const prev = await getRepo(db, input.tenantId, input.repoId);
  await db.execute(sql`
    INSERT INTO github_source_repos (tenant_id, row_key, repo_id, connection_id, provider_config_key, quota_key, full_name, selected_name, default_branch,
      private, visibility, archived, raw, raw_sha256, status, status_reason, last_checked_at)
    VALUES (${input.tenantId}, ${input.repoId}, ${input.repoId}, ${input.connectionId}, ${input.providerConfigKey}, ${input.quotaKey}, ${input.fullName}, ${input.selectedName},
      ${input.defaultBranch}, ${input.private}, ${input.visibility}, ${input.archived}, ${rawText}::jsonb, ${rawSha}, 'active', NULL, now())
    ON CONFLICT (tenant_id, row_key) DO UPDATE SET
      connection_id = EXCLUDED.connection_id,
      provider_config_key = EXCLUDED.provider_config_key,
      quota_key = EXCLUDED.quota_key,
      full_name = EXCLUDED.full_name,
      selected_name = EXCLUDED.selected_name,
      default_branch = EXCLUDED.default_branch,
      private = EXCLUDED.private,
      visibility = EXCLUDED.visibility,
      archived = EXCLUDED.archived,
      raw = CASE WHEN github_source_repos.raw_sha256 = EXCLUDED.raw_sha256 THEN github_source_repos.raw ELSE EXCLUDED.raw END,
      raw_sha256 = EXCLUDED.raw_sha256,
      status = 'active',
      status_reason = NULL,
      path_epoch = github_source_repos.path_epoch + CASE WHEN github_source_repos.full_name <> EXCLUDED.full_name THEN 1 ELSE 0 END,
      last_checked_at = now(),
      updated_at = now()
  `);
  if (prev && prev.full_name !== input.fullName) {
    await db.execute(sql`UPDATE github_source_files SET path_epoch = path_epoch + 1 WHERE tenant_id = ${input.tenantId} AND repo_id = ${input.repoId}`);
    await db.execute(sql`UPDATE github_source_snapshots SET path_epoch = path_epoch + 1 WHERE tenant_id = ${input.tenantId} AND repo_id = ${input.repoId}`);
    return { renamedFrom: prev.full_name };
  }
  return { renamedFrom: null };
}

export async function setRepoStatus(db: DbExecutor, scope: RepoScope, status: string, reason: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_repos SET status = ${status}, status_reason = ${reason}, last_checked_at = now(), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND (status IS DISTINCT FROM ${status} OR status_reason IS DISTINCT FROM ${reason})
  `);
}

export async function setRepoExtraRefs(db: DbExecutor, scope: RepoScope, refs: readonly string[]): Promise<void> {
  await db.execute(sql`UPDATE github_source_repos SET extra_refs = ${json([...new Set(refs)].sort())}::jsonb, updated_at = now() WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId}`);
}

// ------------------------------------------------------------------ refs

export interface RefRow {
  tenant_id: string;
  row_key: string;
  repo_id: string;
  ref_name: string;
  status: string;
  status_reason: string | null;
  next_generation: number;
  scan_generation: number | null;
  scan_commit_sha: string | null;
  scan_tree_sha: string | null;
  scan_commit_raw: Record<string, unknown> | null;
  scan_phase: string | null;
  scan_started_at: unknown;
  scan_reason: string | null;
  scan_incomplete_prefixes: string[];
  committed_generation: number | null;
  committed_commit_sha: string | null;
  committed_tree_sha: string | null;
  committed_commit_raw: Record<string, unknown> | null;
  committed_commit_raw_text: string | null;
  committed_at: unknown;
  committed_counts: Record<string, number> | null;
  observed_head_sha: string | null;
  observed_head_at: unknown;
  last_success_at: unknown;
  last_error: string | null;
  last_error_at: unknown;
  error_streak: number;
  updated_at: unknown;
}

function refRow(r: Record<string, unknown>): RefRow {
  return {
    ...(r as unknown as RefRow),
    next_generation: Number(r.next_generation ?? 0),
    scan_generation: int(r.scan_generation),
    committed_generation: int(r.committed_generation),
    error_streak: Number(r.error_streak ?? 0),
    scan_commit_raw: parseJson(r.scan_commit_raw, null),
    committed_commit_raw: parseJson(r.committed_commit_raw, null),
    committed_counts: parseJson(r.committed_counts, null),
    scan_incomplete_prefixes: parseJson<string[]>(r.scan_incomplete_prefixes, []),
  };
}

export async function ensureRef(db: DbExecutor, scope: RefScope): Promise<RefRow> {
  await db.execute(sql`
    INSERT INTO github_source_refs (tenant_id, row_key, repo_id, ref_name) VALUES (${scope.tenantId}, ${refRowKey(scope.repoId, scope.ref)}, ${scope.repoId}, ${scope.ref})
    ON CONFLICT (tenant_id, repo_id, ref_name) DO NOTHING
  `);
  return (await getRef(db, scope))!;
}

export async function getRef(db: DbExecutor, scope: RefScope): Promise<RefRow | null> {
  const r = rowsOf<Record<string, unknown>>(
    await db.execute(sql`SELECT *, committed_commit_raw::text AS committed_commit_raw_text FROM github_source_refs WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}`),
  )[0];
  return r ? refRow(r) : null;
}

export async function getRefByRowKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<RefRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT *, committed_commit_raw::text AS committed_commit_raw_text FROM github_source_refs WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? refRow(r) : null;
}

export async function listRefs(db: DbExecutor, tenantId: string, repoId?: string): Promise<RefRow[]> {
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT *, committed_commit_raw::text AS committed_commit_raw_text FROM github_source_refs
      WHERE tenant_id = ${tenantId} ${repoId !== undefined ? sql`AND repo_id = ${repoId}` : sql``}
      ORDER BY repo_id, ref_name
    `),
  ).map(refRow);
}

export async function setRefStatus(db: DbExecutor, scope: RefScope, status: string, reason: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_refs SET status = ${status}, status_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND (status IS DISTINCT FROM ${status} OR status_reason IS DISTINCT FROM ${reason})
  `);
}

export async function recordHeadObservation(db: DbExecutor, scope: RefScope, headSha: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_refs SET observed_head_sha = ${headSha}, observed_head_at = now(), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
  `);
}

export async function recordRefSuccess(db: DbExecutor, scope: RefScope): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_refs SET last_success_at = now(), error_streak = 0, last_error = NULL, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
  `);
}

export async function recordRefError(db: DbExecutor, scope: RefScope, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_refs SET last_error = ${error.slice(0, 2000)}, last_error_at = now(), error_streak = error_streak + 1, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
  `);
}

/**
 * Start a confirmed scan of `commitSha`: atomically takes the next generation (never reused,
 * independent of commit dates and SHAs) and makes it the scan in progress. Any older scan
 * still running elsewhere is superseded by this assignment and can no longer commit.
 */
export async function beginScan(
  db: DbExecutor,
  scope: RefScope,
  input: { commitSha: string; treeSha: string; commitRaw: Record<string, unknown>; reason: string },
): Promise<number> {
  const r = rowsOf<{ scan_generation: number }>(
    await db.execute(sql`
      UPDATE github_source_refs SET
        next_generation = next_generation + 1,
        scan_generation = next_generation + 1,
        scan_commit_sha = ${input.commitSha},
        scan_tree_sha = ${input.treeSha},
        scan_commit_raw = ${json(input.commitRaw)}::jsonb,
        scan_phase = 'tree',
        scan_started_at = now(),
        scan_reason = ${input.reason},
        scan_incomplete_prefixes = '[]'::jsonb,
        status = 'active',
        status_reason = NULL,
        updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
      RETURNING scan_generation
    `),
  )[0];
  if (!r) throw new Error(`github ref ${scope.repoId}/${scope.ref} is not registered`);
  return Number(r.scan_generation);
}

/** Drop the scan in progress (its commit/tree vanished); the committed state is untouched. */
export async function abandonScan(db: DbExecutor, scope: RefScope, generation: number, reason: string): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_refs SET scan_generation = NULL, scan_commit_sha = NULL, scan_tree_sha = NULL, scan_commit_raw = NULL, scan_phase = NULL,
      scan_started_at = NULL, scan_reason = NULL, scan_incomplete_prefixes = '[]'::jsonb, last_error = ${reason}, last_error_at = now(), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND scan_generation = ${generation}
  `);
  await dropStaging(db, scope, generation);
}

export async function setScanPhase(db: DbExecutor, scope: RefScope, generation: number, phase: "tree" | "blobs" | "ready"): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE github_source_refs SET scan_phase = ${phase}, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND scan_generation = ${generation}
        RETURNING ref_name
      `),
    ).length > 0
  );
}

export async function addIncompletePrefix(db: DbExecutor, scope: RefScope, generation: number, prefix: string): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_refs SET scan_incomplete_prefixes = (
      SELECT COALESCE(jsonb_agg(DISTINCT p ORDER BY p), '[]'::jsonb) FROM (
        SELECT jsonb_array_elements_text(scan_incomplete_prefixes) AS p UNION SELECT ${prefix}
      ) x), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND scan_generation = ${generation}
  `);
}

// ------------------------------------------------------------------ tree traversal

export async function enqueueScanTrees(db: DbExecutor, scope: RefScope, generation: number, trees: ReadonlyArray<{ prefix: string; sha: string }>): Promise<void> {
  for (let i = 0; i < trees.length; i += INSERT_BATCH) {
    const batch = trees.slice(i, i + INSERT_BATCH);
    await db.execute(sql`
      INSERT INTO github_source_scan_trees (tenant_id, repo_id, ref_name, generation, prefix, tree_sha)
      VALUES ${sql.join(batch.map((t) => sql`(${scope.tenantId}, ${scope.repoId}, ${scope.ref}, ${generation}, ${t.prefix}, ${t.sha})`), sql`, `)}
      ON CONFLICT DO NOTHING
    `);
  }
}

export interface ScanTreeRow {
  prefix: string;
  tree_sha: string;
  attempts: number;
}

export async function nextScanTrees(db: DbExecutor, scope: RefScope, generation: number, limit: number): Promise<ScanTreeRow[]> {
  return rowsOf<ScanTreeRow>(
    await db.execute(sql`
      SELECT prefix, tree_sha, attempts FROM github_source_scan_trees
      WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation}
        AND state = 'pending' AND (not_before IS NULL OR not_before <= now())
      ORDER BY prefix LIMIT ${limit}
    `),
  ).map((r) => ({ ...r, attempts: Number(r.attempts) }));
}

export async function pendingScanTrees(db: DbExecutor, scope: RefScope, generation: number): Promise<number> {
  return Number(
    rowsOf<{ n: unknown }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM github_source_scan_trees WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation} AND state = 'pending'`),
    )[0]?.n ?? 0,
  );
}

export async function finishScanTree(db: DbExecutor, scope: RefScope, generation: number, prefix: string, state: "done" | "truncated"): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_scan_trees SET state = ${state}, last_error = NULL
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation} AND prefix = ${prefix}
  `);
}

export async function retryScanTree(db: DbExecutor, scope: RefScope, generation: number, prefix: string, error: string, delayMs: number): Promise<number> {
  const r = rowsOf<{ attempts: number }>(
    await db.execute(sql`
      UPDATE github_source_scan_trees SET attempts = attempts + 1, last_error = ${error.slice(0, 1000)}, not_before = now() + make_interval(secs => ${delayMs / 1000})
      WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation} AND prefix = ${prefix}
      RETURNING attempts
    `),
  )[0];
  return Number(r?.attempts ?? 0);
}

// ------------------------------------------------------------------ staged entries

export interface StagedEntry {
  path: string;
  mode: string;
  type: "blob" | "commit";
  sha: string;
  size: number | null;
}

export async function stageEntries(db: DbExecutor, scope: RefScope, generation: number, entries: readonly StagedEntry[], maxBlobBytes: number): Promise<void> {
  for (let i = 0; i < entries.length; i += INSERT_BATCH) {
    const batch = entries.slice(i, i + INSERT_BATCH);
    await db.execute(sql`
      INSERT INTO github_source_scan_entries (tenant_id, repo_id, ref_name, generation, path, mode, entry_type, blob_sha, size, blob_state, omit_reason)
      VALUES ${sql.join(
        batch.map((e) => {
          const omit = e.type === "commit" ? "submodule" : e.size !== null && e.size > maxBlobBytes ? "too_large" : null;
          return sql`(${scope.tenantId}, ${scope.repoId}, ${scope.ref}, ${generation}, ${e.path}, ${e.mode}, ${e.type}, ${e.sha}, ${e.size}, ${omit ? "omitted" : "pending"}, ${omit})`;
        }),
        sql`, `,
      )}
      ON CONFLICT DO NOTHING
    `);
  }
  // Blobs already held for this tenant (same git object id = same bytes) need no request.
  await db.execute(sql`
    UPDATE github_source_scan_entries s SET blob_state = 'stored'
    FROM github_source_blobs b
    WHERE s.tenant_id = ${scope.tenantId} AND s.repo_id = ${scope.repoId} AND s.ref_name = ${scope.ref} AND s.generation = ${generation}
      AND s.blob_state = 'pending' AND b.tenant_id = s.tenant_id AND b.blob_sha = s.blob_sha
  `);
}

export interface PendingBlob {
  path: string;
  blob_sha: string;
  size: number | null;
  attempts: number;
}

/** Distinct pending blob ids (one request per git object, even when several paths share it). */
export async function nextPendingBlobs(db: DbExecutor, scope: RefScope, generation: number, limit: number): Promise<PendingBlob[]> {
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT DISTINCT ON (blob_sha) path, blob_sha, size, attempts FROM github_source_scan_entries
      WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation}
        AND blob_state = 'pending' AND (not_before IS NULL OR not_before <= now())
      ORDER BY blob_sha, path LIMIT ${limit}
    `),
  ).map((r) => ({ path: String(r.path), blob_sha: String(r.blob_sha), size: int(r.size), attempts: Number(r.attempts) }));
}

export async function pendingBlobCount(db: DbExecutor, scope: RefScope, generation: number): Promise<number> {
  return Number(
    rowsOf<{ n: unknown }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM github_source_scan_entries WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation} AND blob_state = 'pending'`),
    )[0]?.n ?? 0,
  );
}

export async function markBlobState(db: DbExecutor, scope: RefScope, generation: number, blobSha: string, state: "stored" | "omitted", omitReason: string | null = null, error: string | null = null): Promise<void> {
  await db.execute(sql`
    UPDATE github_source_scan_entries SET blob_state = ${state}, omit_reason = ${omitReason}, last_error = ${error}
    WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation} AND blob_sha = ${blobSha} AND blob_state = 'pending'
  `);
}

export async function retryBlobLater(db: DbExecutor, scope: RefScope, generation: number, blobSha: string, error: string, delayMs: number): Promise<number> {
  const r = rowsOf<{ attempts: number }>(
    await db.execute(sql`
      UPDATE github_source_scan_entries SET attempts = attempts + 1, last_error = ${error.slice(0, 1000)}, not_before = now() + make_interval(secs => ${delayMs / 1000})
      WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation} AND blob_sha = ${blobSha} AND blob_state = 'pending'
      RETURNING attempts
    `),
  );
  return Math.max(0, ...r.map((x) => Number(x.attempts)));
}

export async function stagedCounts(db: DbExecutor, scope: RefScope, generation: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of rowsOf<{ blob_state: string; n: unknown }>(
    await db.execute(sql`
      SELECT blob_state, count(*)::int AS n FROM github_source_scan_entries
      WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation = ${generation}
      GROUP BY blob_state
    `),
  )) {
    out[r.blob_state] = Number(r.n);
  }
  return out;
}

async function dropStaging(db: DbExecutor, scope: RefScope, generation: number): Promise<void> {
  await db.execute(sql`DELETE FROM github_source_scan_entries WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation <= ${generation}`);
  await db.execute(sql`DELETE FROM github_source_scan_trees WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND generation <= ${generation}`);
}

/** Staging rows of generations that can never commit any more (superseded / committed past). */
export async function pruneStaleStaging(db: DbExecutor, scope: RefScope): Promise<void> {
  const ref = await getRef(db, scope);
  if (!ref) return;
  await db.execute(sql`
    DELETE FROM github_source_scan_entries WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
      AND generation IS DISTINCT FROM ${ref.scan_generation}
  `);
  await db.execute(sql`
    DELETE FROM github_source_scan_trees WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
      AND generation IS DISTINCT FROM ${ref.scan_generation}
  `);
}

// ------------------------------------------------------------------ blobs

export interface BlobRow {
  blob_sha: string;
  sha256: string;
  size: number;
  chunks: Array<{ sha256: string; size: number }>;
  is_text: boolean;
}

/** Store exact bytes (already verified against the git object id by the caller) as <= 8 MiB chunks. */
export async function storeBlob(db: DbExecutor, tenantId: string, blobSha: string, bytes: Buffer, isText: boolean): Promise<BlobRow> {
  const chunks: Array<{ sha256: string; size: number }> = [];
  for (let off = 0; off < bytes.length || (off === 0 && chunks.length === 0); off += CHUNK_BYTES) {
    const piece = bytes.subarray(off, Math.min(bytes.length, off + CHUNK_BYTES));
    const sha = sha256Hex(piece);
    await db.execute(sql`
      INSERT INTO github_source_chunks (tenant_id, chunk_sha256, size, bytes) VALUES (${tenantId}, ${sha}, ${piece.length}, ${piece})
      ON CONFLICT (tenant_id, chunk_sha256) DO NOTHING
    `);
    chunks.push({ sha256: sha, size: piece.length });
    if (bytes.length === 0) break;
  }
  const sha256 = sha256Hex(bytes);
  await db.execute(sql`
    INSERT INTO github_source_blobs (tenant_id, blob_sha, sha256, size, chunks, is_text)
    VALUES (${tenantId}, ${blobSha}, ${sha256}, ${bytes.length}, ${json(chunks)}::jsonb, ${isText})
    ON CONFLICT (tenant_id, blob_sha) DO NOTHING
  `);
  return { blob_sha: blobSha, sha256, size: bytes.length, chunks, is_text: isText };
}

export async function getBlob(db: DbExecutor, tenantId: string, blobSha: string): Promise<BlobRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT blob_sha, sha256, size, chunks, is_text FROM github_source_blobs WHERE tenant_id = ${tenantId} AND blob_sha = ${blobSha}`))[0];
  if (!r) return null;
  const chunks = parseJson<Array<{ sha256: string; size: number }>>(r.chunks, []);
  return { blob_sha: String(r.blob_sha), sha256: String(r.sha256), size: Number(r.size), chunks: chunks.map((c) => ({ sha256: c.sha256, size: Number(c.size) })), is_text: Boolean(r.is_text) };
}

export async function loadChunk(db: DbExecutor, tenantId: string, chunkSha256: string): Promise<Buffer> {
  const r = rowsOf<{ bytes: unknown }>(await db.execute(sql`SELECT bytes FROM github_source_chunks WHERE tenant_id = ${tenantId} AND chunk_sha256 = ${chunkSha256}`))[0];
  if (!r) throw new Error(`github chunk ${chunkSha256} is missing`);
  const b = r.bytes;
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (typeof b === "string" && b.startsWith("\\x")) return Buffer.from(b.slice(2), "hex");
  throw new Error("unexpected bytea encoding");
}

// ------------------------------------------------------------------ files

export interface FileRow {
  tenant_id: string;
  row_key: string;
  repo_id: string;
  ref_name: string;
  path: string;
  mode: string;
  entry_type: string;
  blob_sha: string;
  size: number | null;
  state: "live" | "deleted";
  omit_reason: string | null;
  retired_reason: string | null;
  content_generation: number;
  content_commit_sha: string;
  first_generation: number;
  deleted_generation: number | null;
  deleted_commit_sha: string | null;
  delete_reason: string | null;
  renamed_from: string | null;
  renamed_to: string | null;
  path_epoch: number;
  updated_at: unknown;
}

function fileRow(r: Record<string, unknown>): FileRow {
  return {
    ...(r as unknown as FileRow),
    size: int(r.size),
    content_generation: Number(r.content_generation),
    first_generation: Number(r.first_generation),
    deleted_generation: int(r.deleted_generation),
    path_epoch: Number(r.path_epoch ?? 0),
  };
}

export async function getFileByRowKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<FileRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT * FROM github_source_files WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? fileRow(r) : null;
}

export async function listFiles(db: DbExecutor, scope: RefScope, opts: { state?: "live" | "deleted"; omitted?: boolean; limit?: number } = {}): Promise<FileRow[]> {
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT * FROM github_source_files
      WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
        ${opts.state ? sql`AND state = ${opts.state}` : sql``}
        ${opts.omitted === true ? sql`AND omit_reason IS NOT NULL` : opts.omitted === false ? sql`AND omit_reason IS NULL` : sql``}
      ORDER BY path ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}
    `),
  ).map(fileRow);
}

export async function fileCounts(db: DbExecutor, scope: RefScope): Promise<Record<string, number>> {
  const r = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE state = 'live')::int AS live,
             count(*) FILTER (WHERE state = 'live' AND omit_reason IS NULL)::int AS exported,
             count(*) FILTER (WHERE state = 'live' AND omit_reason = 'too_large')::int AS too_large,
             count(*) FILTER (WHERE state = 'live' AND omit_reason = 'fetch_failed')::int AS fetch_failed,
             count(*) FILTER (WHERE state = 'live' AND omit_reason = 'submodule')::int AS submodules,
             count(*) FILTER (WHERE state = 'deleted')::int AS deleted,
             COALESCE(sum(size) FILTER (WHERE state = 'live' AND omit_reason IS NULL), 0)::bigint AS bytes
      FROM github_source_files WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
    `),
  )[0] ?? {};
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v ?? 0)]));
}

/**
 * Hide (reason) or show again (null) files of a repository/ref in the export: out of scope,
 * ref retired. Only rows whose current retired_reason equals `from` change, so the two
 * reasons never undo each other. Raw snapshots stay.
 */
export async function setFilesRetired(db: DbExecutor, scope: RepoScope & { ref?: string }, reason: string | null, from: string | null): Promise<number> {
  return rowsOf(
    await db.execute(sql`
      UPDATE github_source_files SET retired_reason = ${reason}, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} ${scope.ref !== undefined ? sql`AND ref_name = ${scope.ref}` : sql``}
        AND retired_reason IS NOT DISTINCT FROM ${from}
      RETURNING row_key
    `),
  ).length;
}

// ------------------------------------------------------------------ commit

export type CommitOutcome =
  | { outcome: "committed"; generation: number; counts: Record<string, number>; complete: boolean }
  | { outcome: "superseded"; generation: number; reason: string };

/**
 * Make staged generation `generation` the current file set of the ref, atomically.
 *
 * Accepted only when it is still the scan in progress AND newer than the committed
 * generation: a late completion of an older scan (a worker that lost its lease, a scan
 * superseded by a newer HEAD) is refused and changes nothing. Ordering never consults
 * commit dates or SHAs. Per path: unchanged bytes keep their content_generation (no
 * re-version), changed/re-added paths take this generation, missing paths become
 * `deleted` (or `renamed` when exactly one added path carries the same blob), except
 * under directories whose listing was incomplete (those are kept, never deleted).
 */
export async function commitScan(db: GithubDb, scope: RefScope, generation: number): Promise<CommitOutcome> {
  if (!db.transaction) throw new Error("github commitScan needs a transactional executor");
  return db.transaction(async (tx: DbExecutor) => {
    const t = scope.tenantId;
    const repo = scope.repoId;
    const ref = scope.ref;
    const g = generation;
    const lock = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`SELECT * FROM github_source_refs WHERE tenant_id = ${t} AND repo_id = ${repo} AND ref_name = ${ref} FOR UPDATE`),
    )[0];
    if (!lock) return { outcome: "superseded", generation: g, reason: "ref no longer exists" };
    const row = refRow(lock);
    if (row.scan_generation !== g) return { outcome: "superseded", generation: g, reason: `scan generation ${g} is not the scan in progress (${row.scan_generation ?? "none"})` };
    if (row.committed_generation !== null && row.committed_generation >= g) return { outcome: "superseded", generation: g, reason: `generation ${row.committed_generation} is already committed` };
    if (row.scan_phase !== "ready") return { outcome: "superseded", generation: g, reason: `scan generation ${g} is not ready (${row.scan_phase})` };
    const pending = rowsOf<{ n: unknown }>(
      await tx.execute(sql`
        SELECT (SELECT count(*) FROM github_source_scan_entries WHERE tenant_id = ${t} AND repo_id = ${repo} AND ref_name = ${ref} AND generation = ${g} AND blob_state = 'pending')
             + (SELECT count(*) FROM github_source_scan_trees WHERE tenant_id = ${t} AND repo_id = ${repo} AND ref_name = ${ref} AND generation = ${g} AND state = 'pending') AS n
      `),
    )[0];
    if (Number(pending?.n ?? 0) > 0) return { outcome: "superseded", generation: g, reason: "scan still has pending work" };

    const prefixes = json(row.scan_incomplete_prefixes);
    const commitSha = row.scan_commit_sha!;
    const staged = sql`github_source_scan_entries s WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g}`;
    const liveF = sql`github_source_files f WHERE f.tenant_id = ${t} AND f.repo_id = ${repo} AND f.ref_name = ${ref} AND f.state = 'live'`;
    const keptByPrefix = (col: ReturnType<typeof sql>) => sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${prefixes}::jsonb) p(v) WHERE starts_with(${col}, p.v))`;

    // Renames: a removed path and an added path with the same blob id, both unique within this diff.
    const renames = rowsOf<{ from_path: string; to_path: string }>(
      await tx.execute(sql`
        WITH removed AS (
          SELECT f.path, f.blob_sha FROM ${liveF}
            AND NOT EXISTS (SELECT 1 FROM github_source_scan_entries s WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g} AND s.path = f.path)
            AND NOT ${keptByPrefix(sql`f.path`)}
        ), added AS (
          SELECT s.path, s.blob_sha FROM ${staged} AND s.entry_type = 'blob'
            AND NOT EXISTS (SELECT 1 FROM github_source_files f WHERE f.tenant_id = ${t} AND f.repo_id = ${repo} AND f.ref_name = ${ref} AND f.state = 'live' AND f.path = s.path)
        ), ru AS (SELECT blob_sha FROM removed GROUP BY blob_sha HAVING count(*) = 1),
           au AS (SELECT blob_sha FROM added GROUP BY blob_sha HAVING count(*) = 1)
        SELECT r.path AS from_path, a.path AS to_path FROM removed r JOIN added a ON a.blob_sha = r.blob_sha
        WHERE r.blob_sha IN (SELECT blob_sha FROM ru) AND r.blob_sha IN (SELECT blob_sha FROM au)
        ORDER BY a.path
      `),
    );
    const renameJson = json(renames.map((r) => ({ from_path: r.from_path, to_path: r.to_path })));

    const countRow = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT
          (SELECT count(*) FROM ${staged})::int AS entries,
          (SELECT count(*) FROM ${staged} AND NOT EXISTS (SELECT 1 FROM github_source_files f WHERE f.tenant_id = ${t} AND f.repo_id = ${repo} AND f.ref_name = ${ref} AND f.state = 'live' AND f.path = s.path))::int AS added,
          (SELECT count(*) FROM ${staged} AND EXISTS (SELECT 1 FROM github_source_files f WHERE f.tenant_id = ${t} AND f.repo_id = ${repo} AND f.ref_name = ${ref} AND f.state = 'live' AND f.path = s.path
             AND (f.blob_sha <> s.blob_sha OR f.mode <> s.mode OR f.omit_reason IS DISTINCT FROM s.omit_reason)))::int AS modified,
          (SELECT count(*) FROM ${liveF}
             AND NOT EXISTS (SELECT 1 FROM github_source_scan_entries s WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g} AND s.path = f.path)
             AND NOT ${keptByPrefix(sql`f.path`)})::int AS removed,
          (SELECT count(*) FROM ${liveF}
             AND NOT EXISTS (SELECT 1 FROM github_source_scan_entries s WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g} AND s.path = f.path)
             AND ${keptByPrefix(sql`f.path`)})::int AS kept_incomplete,
          (SELECT count(*) FROM ${staged} AND s.omit_reason = 'too_large')::int AS too_large,
          (SELECT count(*) FROM ${staged} AND s.omit_reason = 'fetch_failed')::int AS fetch_failed,
          (SELECT count(*) FROM ${staged} AND s.omit_reason = 'submodule')::int AS submodules
      `),
    )[0]!;
    const counts: Record<string, number> = Object.fromEntries(Object.entries(countRow).map(([k, v]) => [k, Number(v)]));
    counts.renamed = renames.length;
    counts.deleted = counts.removed! - renames.length;
    counts.added = counts.added! - renames.length;
    delete counts.removed;

    const changeRows = rowsOf<{ op: string; path: string; from_path: string | null; blob_sha: string | null; mode: string | null }>(
      await tx.execute(sql`
        WITH rn AS (SELECT * FROM jsonb_to_recordset(${renameJson}::jsonb) AS x(from_path text, to_path text))
        SELECT * FROM (
          SELECT CASE WHEN rn.to_path IS NOT NULL THEN 'renamed' ELSE 'added' END AS op, s.path, rn.from_path, s.blob_sha, s.mode
            FROM github_source_scan_entries s LEFT JOIN rn ON rn.to_path = s.path
            WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g}
              AND NOT EXISTS (SELECT 1 FROM github_source_files f WHERE f.tenant_id = ${t} AND f.repo_id = ${repo} AND f.ref_name = ${ref} AND f.state = 'live' AND f.path = s.path)
          UNION ALL
          SELECT 'modified', s.path, NULL, s.blob_sha, s.mode FROM github_source_scan_entries s JOIN github_source_files f
            ON f.tenant_id = s.tenant_id AND f.repo_id = s.repo_id AND f.ref_name = s.ref_name AND f.path = s.path AND f.state = 'live'
            WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g}
              AND (f.blob_sha <> s.blob_sha OR f.mode <> s.mode OR f.omit_reason IS DISTINCT FROM s.omit_reason)
          UNION ALL
          SELECT 'deleted', f.path, NULL, NULL, NULL FROM ${liveF}
            AND NOT EXISTS (SELECT 1 FROM github_source_scan_entries s WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g} AND s.path = f.path)
            AND NOT ${keptByPrefix(sql`f.path`)}
            AND f.path NOT IN (SELECT from_path FROM rn)
        ) c ORDER BY path, op LIMIT ${MAX_SNAPSHOT_CHANGES + 1}
      `),
    );
    const truncated = changeRows.length > MAX_SNAPSHOT_CHANGES;
    const changeList = changeRows.slice(0, MAX_SNAPSHOT_CHANGES).map((c) => ({
      op: c.op,
      path: c.path,
      ...(c.from_path ? { from: c.from_path } : {}),
      ...(c.blob_sha ? { blobSha: c.blob_sha, mode: c.mode } : {}),
    }));

    // 1. Changed / re-added paths that already have a row (bytes, mode or omission changed, or the path was deleted before).
    await tx.execute(sql`
      WITH rn AS (SELECT * FROM jsonb_to_recordset(${renameJson}::jsonb) AS x(from_path text, to_path text))
      UPDATE github_source_files f SET mode = s.mode, entry_type = s.entry_type, blob_sha = s.blob_sha, size = s.size, state = 'live', omit_reason = s.omit_reason,
        content_generation = ${g}, content_commit_sha = ${commitSha}, deleted_generation = NULL, deleted_commit_sha = NULL, delete_reason = NULL, renamed_to = NULL,
        renamed_from = (SELECT rn.from_path FROM rn WHERE rn.to_path = s.path), updated_at = now()
      FROM github_source_scan_entries s
      WHERE f.tenant_id = ${t} AND f.repo_id = ${repo} AND f.ref_name = ${ref}
        AND s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g} AND s.path = f.path
        AND (f.state <> 'live' OR f.blob_sha <> s.blob_sha OR f.mode <> s.mode OR f.omit_reason IS DISTINCT FROM s.omit_reason)
    `);
    // 2. Paths never seen before on this ref.
    await tx.execute(sql`
      WITH rn AS (SELECT * FROM jsonb_to_recordset(${renameJson}::jsonb) AS x(from_path text, to_path text))
      INSERT INTO github_source_files (tenant_id, row_key, repo_id, ref_name, path, mode, entry_type, blob_sha, size, state, omit_reason,
        content_generation, content_commit_sha, first_generation, renamed_from, path_epoch)
      SELECT ${t}, ${repo} || ':' || encode(sha256(convert_to(${ref} || E'\n' || s.path, 'UTF8')), 'hex'), ${repo}, ${ref}, s.path, s.mode, s.entry_type, s.blob_sha, s.size,
        'live', s.omit_reason, ${g}, ${commitSha}, ${g}, (SELECT rn.from_path FROM rn WHERE rn.to_path = s.path),
        COALESCE((SELECT path_epoch FROM github_source_repos WHERE tenant_id = ${t} AND repo_id = ${repo}), 0)
      FROM github_source_scan_entries s
      WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g}
        AND NOT EXISTS (SELECT 1 FROM github_source_files f WHERE f.tenant_id = ${t} AND f.repo_id = ${repo} AND f.ref_name = ${ref} AND f.path = s.path)
      ON CONFLICT (tenant_id, repo_id, ref_name, path) DO NOTHING
    `);
    // 3. Paths gone from the tree (never under an incompletely listed directory).
    await tx.execute(sql`
      WITH rn AS (SELECT * FROM jsonb_to_recordset(${renameJson}::jsonb) AS x(from_path text, to_path text))
      UPDATE github_source_files f SET state = 'deleted', deleted_generation = ${g}, deleted_commit_sha = ${commitSha},
        delete_reason = CASE WHEN EXISTS (SELECT 1 FROM rn WHERE rn.from_path = f.path) THEN 'github_renamed' ELSE 'github_deleted' END,
        renamed_to = (SELECT rn.to_path FROM rn WHERE rn.from_path = f.path), updated_at = now()
      WHERE f.tenant_id = ${t} AND f.repo_id = ${repo} AND f.ref_name = ${ref} AND f.state = 'live'
        AND NOT EXISTS (SELECT 1 FROM github_source_scan_entries s WHERE s.tenant_id = ${t} AND s.repo_id = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g} AND s.path = f.path)
        AND NOT ${keptByPrefix(sql`f.path`)}
    `);

    const incompleteReasons: string[] = [];
    if (row.scan_incomplete_prefixes.length) incompleteReasons.push(`tree listing incomplete under: ${row.scan_incomplete_prefixes.map((p) => (p === "" ? "/" : p)).join(", ")}`);
    if (counts.too_large) incompleteReasons.push(`${counts.too_large} file(s) over the blob size limit were not captured`);
    if (counts.fetch_failed) incompleteReasons.push(`${counts.fetch_failed} blob(s) could not be fetched`);
    const complete = incompleteReasons.length === 0;
    const repoEpoch = Number(rowsOf<{ e: unknown }>(await tx.execute(sql`SELECT path_epoch AS e FROM github_source_repos WHERE tenant_id = ${t} AND repo_id = ${repo}`))[0]?.e ?? 0);
    await tx.execute(sql`
      INSERT INTO github_source_snapshots (tenant_id, row_key, repo_id, ref_name, generation, previous_generation, commit_sha, tree_sha, commit_raw, counts, changes,
        changes_truncated, complete, incomplete_reasons, path_epoch)
      VALUES (${t}, ${snapshotRowKey(repo, ref, g)}, ${repo}, ${ref}, ${g}, ${row.committed_generation}, ${commitSha}, ${row.scan_tree_sha},
        ${json(row.scan_commit_raw)}::jsonb, ${json(counts)}::jsonb, ${json(changeList)}::jsonb, ${truncated}, ${complete}, ${json(incompleteReasons)}::jsonb, ${repoEpoch})
      ON CONFLICT (tenant_id, repo_id, ref_name, generation) DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE github_source_refs SET
        committed_generation = ${g}, committed_commit_sha = ${commitSha}, committed_tree_sha = scan_tree_sha, committed_commit_raw = scan_commit_raw,
        committed_at = now(), committed_counts = ${json({ ...counts, complete: complete ? 1 : 0 })}::jsonb,
        scan_generation = NULL, scan_commit_sha = NULL, scan_tree_sha = NULL, scan_commit_raw = NULL, scan_phase = NULL, scan_started_at = NULL,
        scan_reason = NULL, scan_incomplete_prefixes = '[]'::jsonb, status = 'active', status_reason = NULL,
        last_success_at = now(), last_error = NULL, error_streak = 0, updated_at = now()
      WHERE tenant_id = ${t} AND repo_id = ${repo} AND ref_name = ${ref}
    `);
    await dropStaging(tx, scope, g);
    return { outcome: "committed", generation: g, counts, complete };
  });
}

/**
 * The ref no longer exists upstream (or the repository is empty): every live file becomes
 * deleted at a NEW generation, so the deletion is ordered after everything committed before.
 */
export async function commitRefGone(db: GithubDb, scope: RefScope, status: "not_found" | "empty", reason: string): Promise<number> {
  if (!db.transaction) throw new Error("github commitRefGone needs a transactional executor");
  return db.transaction(async (tx: DbExecutor) => {
    const g = Number(
      rowsOf<{ g: unknown }>(
        await tx.execute(sql`
          UPDATE github_source_refs SET next_generation = next_generation + 1, scan_generation = NULL, scan_commit_sha = NULL, scan_tree_sha = NULL,
            scan_commit_raw = NULL, scan_phase = NULL, scan_started_at = NULL, scan_reason = NULL, scan_incomplete_prefixes = '[]'::jsonb,
            committed_generation = next_generation + 1, committed_commit_sha = NULL, committed_tree_sha = NULL, committed_commit_raw = NULL, committed_at = now(),
            committed_counts = '{}'::jsonb, status = ${status}, status_reason = ${reason}, last_success_at = now(), last_error = NULL, error_streak = 0, updated_at = now()
          WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref}
          RETURNING committed_generation AS g
        `),
      )[0]?.g,
    );
    const deleted = rowsOf(
      await tx.execute(sql`
        UPDATE github_source_files SET state = 'deleted', deleted_generation = ${g}, deleted_commit_sha = NULL, delete_reason = ${status === "empty" ? "github_repository_empty" : "github_ref_deleted"},
          renamed_to = NULL, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} AND state = 'live'
        RETURNING row_key
      `),
    ).length;
    await tx.execute(sql`
      INSERT INTO github_source_snapshots (tenant_id, row_key, repo_id, ref_name, generation, previous_generation, commit_sha, tree_sha, commit_raw, counts, changes, complete, incomplete_reasons)
      VALUES (${scope.tenantId}, ${snapshotRowKey(scope.repoId, scope.ref, g)}, ${scope.repoId}, ${scope.ref}, ${g}, NULL, NULL, NULL, NULL,
        ${json({ deleted })}::jsonb, ${json([{ op: status === "empty" ? "repository_empty" : "ref_deleted", reason }])}::jsonb, true, '[]'::jsonb)
      ON CONFLICT (tenant_id, repo_id, ref_name, generation) DO NOTHING
    `);
    await dropStaging(tx, scope, g);
    return g;
  });
}

// ------------------------------------------------------------------ snapshots

export interface SnapshotRow {
  tenant_id: string;
  row_key: string;
  repo_id: string;
  ref_name: string;
  generation: number;
  previous_generation: number | null;
  commit_sha: string | null;
  tree_sha: string | null;
  commit_raw_text: string | null;
  counts: Record<string, number>;
  changes: unknown[];
  changes_truncated: boolean;
  complete: boolean;
  incomplete_reasons: string[];
  path_epoch: number;
  committed_at: unknown;
}

export async function getSnapshotByRowKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<SnapshotRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT *, commit_raw::text AS commit_raw_text FROM github_source_snapshots WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  if (!r) return null;
  return {
    ...(r as unknown as SnapshotRow),
    generation: Number(r.generation),
    previous_generation: int(r.previous_generation),
    counts: parseJson(r.counts, {}),
    changes: parseJson(r.changes, []),
    incomplete_reasons: parseJson(r.incomplete_reasons, []),
    changes_truncated: Boolean(r.changes_truncated),
    complete: Boolean(r.complete),
    path_epoch: Number(r.path_epoch ?? 0),
  };
}

export async function listSnapshots(db: DbExecutor, scope: RefScope): Promise<Array<{ generation: number; commit_sha: string | null; complete: boolean }>> {
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`SELECT generation, commit_sha, complete FROM github_source_snapshots WHERE tenant_id = ${scope.tenantId} AND repo_id = ${scope.repoId} AND ref_name = ${scope.ref} ORDER BY generation`),
  ).map((r) => ({ generation: Number(r.generation), commit_sha: (r.commit_sha as string | null) ?? null, complete: Boolean(r.complete) }));
}

// ------------------------------------------------------------------ purge

/**
 * DESTRUCTIVE user unsync of one repository (mirrors the donor purgeGithubRepoData privacy
 * exception): every content-lane row of (tenant, repository) goes, and blobs/chunks no other
 * repository of the tenant references. Journal DELETEs make the exporter remove the published files.
 */
export async function purgeRepoContent(db: GithubDb, scope: RepoScope): Promise<{ files: number; blobs: number }> {
  const run = async (tx: DbExecutor) => {
    const t = scope.tenantId;
    const repo = scope.repoId;
    const files = rowsOf(await tx.execute(sql`DELETE FROM github_source_files WHERE tenant_id = ${t} AND repo_id = ${repo} RETURNING row_key`)).length;
    await tx.execute(sql`DELETE FROM github_source_snapshots WHERE tenant_id = ${t} AND repo_id = ${repo}`);
    await tx.execute(sql`DELETE FROM github_source_scan_entries WHERE tenant_id = ${t} AND repo_id = ${repo}`);
    await tx.execute(sql`DELETE FROM github_source_scan_trees WHERE tenant_id = ${t} AND repo_id = ${repo}`);
    await tx.execute(sql`DELETE FROM github_source_refs WHERE tenant_id = ${t} AND repo_id = ${repo}`);
    await tx.execute(sql`DELETE FROM github_source_repos WHERE tenant_id = ${t} AND repo_id = ${repo}`);
    const blobs = rowsOf<{ chunks: unknown }>(
      await tx.execute(sql`
        DELETE FROM github_source_blobs b WHERE b.tenant_id = ${t}
          AND NOT EXISTS (SELECT 1 FROM github_source_files f WHERE f.tenant_id = b.tenant_id AND f.blob_sha = b.blob_sha)
          AND NOT EXISTS (SELECT 1 FROM github_source_scan_entries s WHERE s.tenant_id = b.tenant_id AND s.blob_sha = b.blob_sha)
        RETURNING chunks
      `),
    );
    await tx.execute(sql`
      DELETE FROM github_source_chunks c WHERE c.tenant_id = ${t}
        AND NOT EXISTS (SELECT 1 FROM github_source_blobs b, jsonb_array_elements(b.chunks) e WHERE b.tenant_id = c.tenant_id AND e->>'sha256' = c.chunk_sha256)
    `);
    return { files, blobs: blobs.length };
  };
  return db.transaction ? db.transaction(run) : run(db);
}
