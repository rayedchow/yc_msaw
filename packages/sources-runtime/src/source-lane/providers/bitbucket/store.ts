import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../core/types.js";
import { sha256Hex } from "./api.js";

/**
 * Durable state of the Bitbucket repository content lane (drizzle/9350). Every statement
 * is scoped by tenant_id plus the immutable repository UUID; nothing is keyed by a value a
 * caller can choose.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOT_CHANGES = 2000;
const INSERT_BATCH = 200;

/** Executor with transactions (drizzle node-postgres/postgres-js/pglite all provide it). */
export type BitbucketDb = DbExecutor & {
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
  repoUuid: string;
}

export interface RefScope extends RepoScope {
  ref: string;
}

export function refRowKey(repoUuid: string, ref: string): string {
  return `${repoUuid}:${sha256Hex(ref).slice(0, 32)}`;
}

export function snapshotRowKey(repoUuid: string, ref: string, generation: number): string {
  return `${refRowKey(repoUuid, ref)}:g${generation}`;
}

// ------------------------------------------------------------------ quota

export async function quotaBlockedUntil(db: DbExecutor, quotaKey: string, now = new Date()): Promise<{ until: Date; kind: string | null } | null> {
  const r = rowsOf<{ blocked_until: unknown; blocked_kind: string | null }>(
    await db.execute(sql`SELECT blocked_until, blocked_kind FROM bitbucket_source_quota WHERE quota_key = ${quotaKey}`),
  )[0];
  const until = toDate(r?.blocked_until);
  return until && until.getTime() > now.getTime() ? { until, kind: r?.blocked_kind ?? null } : null;
}

/**
 * Persist a cooldown on the quota identity. Retry-After / X-RateLimit-Reset win; without
 * them the backoff doubles with every consecutive rate limit (capped at one hour, Bitbucket's
 * rolling window).
 */
export async function recordRateLimited(
  db: DbExecutor,
  quotaKey: string,
  input: { retryAfterMs: number | null; status: number; kind: string; reason: string; defaultBackoffMs: number },
): Promise<Date> {
  const row = rowsOf<{ rate_limit_streak: number }>(
    await db.execute(sql`
      INSERT INTO bitbucket_source_quota (quota_key, rate_limit_streak, updated_at) VALUES (${quotaKey}, 1, now())
      ON CONFLICT (quota_key) DO UPDATE SET rate_limit_streak = bitbucket_source_quota.rate_limit_streak + 1, updated_at = now()
      RETURNING rate_limit_streak
    `),
  )[0];
  const streak = Math.max(1, Number(row?.rate_limit_streak ?? 1));
  const ms = input.retryAfterMs ?? Math.min(3_600_000, input.defaultBackoffMs * 2 ** (streak - 1));
  const until = new Date(Date.now() + Math.max(1000, ms));
  await db.execute(sql`
    UPDATE bitbucket_source_quota SET blocked_until = ${until.toISOString()}::timestamptz, blocked_kind = ${input.kind}, last_status = ${input.status},
      last_retry_after_ms = ${input.retryAfterMs}, last_reason = ${input.reason.slice(0, 500)}, updated_at = now()
    WHERE quota_key = ${quotaKey}
  `);
  return until;
}

export async function recordRateObservation(db: DbExecutor, quotaKey: string, rate: { limit: number | null; resource: string | null; nearLimit: boolean }): Promise<void> {
  await db.execute(sql`
    INSERT INTO bitbucket_source_quota (quota_key, rate_limit, rate_resource, near_limit, updated_at) VALUES (${quotaKey}, ${rate.limit}, ${rate.resource}, ${rate.nearLimit}, now())
    ON CONFLICT (quota_key) DO UPDATE SET rate_limit = COALESCE(EXCLUDED.rate_limit, bitbucket_source_quota.rate_limit),
      rate_resource = COALESCE(EXCLUDED.rate_resource, bitbucket_source_quota.rate_resource), near_limit = EXCLUDED.near_limit, updated_at = now()
  `);
}

export async function clearRateStreak(db: DbExecutor, quotaKey: string): Promise<void> {
  await db.execute(sql`UPDATE bitbucket_source_quota SET rate_limit_streak = 0, updated_at = now() WHERE quota_key = ${quotaKey} AND rate_limit_streak <> 0`);
}

export async function quotaRow(db: DbExecutor, quotaKey: string): Promise<Record<string, unknown> | null> {
  return rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT * FROM bitbucket_source_quota WHERE quota_key = ${quotaKey}`))[0] ?? null;
}

/** One sweep per quota identity across workers and tenants. */
export async function acquireQuotaLease(db: DbExecutor, quotaKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        INSERT INTO bitbucket_source_quota (quota_key, lease_owner, lease_until, updated_at)
        VALUES (${quotaKey}, ${owner}, now() + make_interval(secs => ${leaseSeconds}), now())
        ON CONFLICT (quota_key) DO UPDATE SET lease_owner = EXCLUDED.lease_owner, lease_until = EXCLUDED.lease_until, updated_at = now()
        WHERE bitbucket_source_quota.lease_owner IS NULL OR bitbucket_source_quota.lease_until IS NULL OR bitbucket_source_quota.lease_until < now()
          OR bitbucket_source_quota.lease_owner = ${owner}
        RETURNING quota_key
      `),
    ).length > 0
  );
}

export async function renewQuotaLease(db: DbExecutor, quotaKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE bitbucket_source_quota SET lease_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
        WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}
        RETURNING quota_key
      `),
    ).length > 0
  );
}

export async function releaseQuotaLease(db: DbExecutor, quotaKey: string, owner: string): Promise<void> {
  await db.execute(sql`UPDATE bitbucket_source_quota SET lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE quota_key = ${quotaKey} AND lease_owner = ${owner}`);
}

// ------------------------------------------------------------------ connections

export interface ConnectionStateRow {
  connection_id: string;
  provider_config_key: string;
  account_uuid: string | null;
  quota_key: string;
  status: string;
  reason: string | null;
  checked_at: unknown;
}

export async function getConnectionState(db: DbExecutor, tenantId: string, connectionId: string): Promise<ConnectionStateRow | null> {
  return rowsOf<ConnectionStateRow>(await db.execute(sql`SELECT * FROM bitbucket_source_connections WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId}`))[0] ?? null;
}

export async function listConnectionStates(db: DbExecutor, tenantId: string): Promise<ConnectionStateRow[]> {
  return rowsOf<ConnectionStateRow>(await db.execute(sql`SELECT * FROM bitbucket_source_connections WHERE tenant_id = ${tenantId} ORDER BY connection_id`));
}

export async function recordConnectionState(
  db: DbExecutor,
  input: { tenantId: string; connectionId: string; providerConfigKey: string; accountUuid: string | null; quotaKey: string; status: string; reason: string | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO bitbucket_source_connections (tenant_id, connection_id, provider_config_key, account_uuid, quota_key, status, reason, checked_at)
    VALUES (${input.tenantId}, ${input.connectionId}, ${input.providerConfigKey}, ${input.accountUuid}, ${input.quotaKey}, ${input.status}, ${input.reason}, now())
    ON CONFLICT (tenant_id, connection_id) DO UPDATE SET provider_config_key = EXCLUDED.provider_config_key,
      account_uuid = COALESCE(EXCLUDED.account_uuid, bitbucket_source_connections.account_uuid), quota_key = EXCLUDED.quota_key,
      status = EXCLUDED.status, reason = EXCLUDED.reason, checked_at = now()
  `);
}

// ------------------------------------------------------------------ selection

export interface SelectionRow {
  repo_key: string;
  full_name: string;
  selected: boolean;
  extra_refs: string[];
  selected_by: string | null;
  updated_at: unknown;
}

export async function listSelection(db: DbExecutor, tenantId: string): Promise<SelectionRow[]> {
  return rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT * FROM bitbucket_source_selection WHERE tenant_id = ${tenantId} ORDER BY repo_key`)).map((r) => ({
    repo_key: String(r.repo_key),
    full_name: String(r.full_name),
    selected: Boolean(r.selected),
    extra_refs: parseJson<string[]>(r.extra_refs, []),
    selected_by: (r.selected_by as string | null) ?? null,
    updated_at: r.updated_at,
  }));
}

export async function setSelection(db: DbExecutor, input: { tenantId: string; fullName: string; selected: boolean; extraRefs?: readonly string[]; by?: string | null }): Promise<void> {
  const key = input.fullName.toLowerCase();
  await db.execute(sql`
    INSERT INTO bitbucket_source_selection (tenant_id, repo_key, full_name, selected, extra_refs, selected_by, updated_at)
    VALUES (${input.tenantId}, ${key}, ${input.fullName}, ${input.selected}, ${json(input.extraRefs ?? [])}::jsonb, ${input.by ?? null}, now())
    ON CONFLICT (tenant_id, repo_key) DO UPDATE SET full_name = EXCLUDED.full_name, selected = EXCLUDED.selected,
      extra_refs = CASE WHEN ${input.extraRefs === undefined} THEN bitbucket_source_selection.extra_refs ELSE EXCLUDED.extra_refs END,
      selected_by = COALESCE(EXCLUDED.selected_by, bitbucket_source_selection.selected_by), updated_at = now()
  `);
}

export async function deleteSelection(db: DbExecutor, tenantId: string, repoKey: string): Promise<void> {
  await db.execute(sql`DELETE FROM bitbucket_source_selection WHERE tenant_id = ${tenantId} AND repo_key = ${repoKey}`);
}

// ------------------------------------------------------------------ repositories

export interface RepoRow {
  tenant_id: string;
  row_key: string;
  repo_uuid: string;
  workspace_uuid: string | null;
  connection_id: string;
  provider_config_key: string;
  quota_key: string;
  full_name: string;
  selected_key: string;
  main_branch: string | null;
  is_private: boolean | null;
  raw_text: string | null;
  status: string;
  status_reason: string | null;
  not_found_streak: number;
  last_checked_at: unknown;
  first_seen_at: unknown;
  updated_at: unknown;
}

const REPO_COLS = sql`tenant_id, row_key, repo_uuid, workspace_uuid, connection_id, provider_config_key, quota_key, full_name, selected_key, main_branch,
  is_private, raw::text AS raw_text, status, status_reason, not_found_streak, last_checked_at, first_seen_at, updated_at`;

function repoRow(r: Record<string, unknown>): RepoRow {
  return { ...(r as unknown as RepoRow), not_found_streak: Number(r.not_found_streak ?? 0) };
}

export async function getRepo(db: DbExecutor, tenantId: string, repoUuid: string): Promise<RepoRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT ${REPO_COLS} FROM bitbucket_source_repos WHERE tenant_id = ${tenantId} AND repo_uuid = ${repoUuid}`))[0];
  return r ? repoRow(r) : null;
}

export async function getRepoByRowKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<RepoRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT ${REPO_COLS} FROM bitbucket_source_repos WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? repoRow(r) : null;
}

export async function listRepos(db: DbExecutor, tenantId: string): Promise<RepoRow[]> {
  return rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT ${REPO_COLS} FROM bitbucket_source_repos WHERE tenant_id = ${tenantId} ORDER BY full_name, repo_uuid`)).map(repoRow);
}

/** The repository a selection key resolved to (by the key it was selected under, else its current name). */
export async function findRepoBySelection(db: DbExecutor, tenantId: string, repoKey: string): Promise<RepoRow | null> {
  const r = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT ${REPO_COLS} FROM bitbucket_source_repos WHERE tenant_id = ${tenantId} AND (selected_key = ${repoKey} OR lower(full_name) = ${repoKey})
      ORDER BY (selected_key = ${repoKey}) DESC, updated_at DESC LIMIT 1
    `),
  )[0];
  return r ? repoRow(r) : null;
}

export interface RepoUpsert {
  tenantId: string;
  repoUuid: string;
  workspaceUuid: string | null;
  connectionId: string;
  providerConfigKey: string;
  quotaKey: string;
  fullName: string;
  selectedKey: string;
  mainBranch: string | null;
  isPrivate: boolean | null;
  raw: Record<string, unknown>;
}

/** Insert or refresh a resolved repository (status back to active, 404 streak cleared). */
export async function upsertRepo(db: DbExecutor, input: RepoUpsert): Promise<{ renamedFrom: string | null }> {
  const before = await getRepo(db, input.tenantId, input.repoUuid);
  await db.execute(sql`
    INSERT INTO bitbucket_source_repos (tenant_id, row_key, repo_uuid, workspace_uuid, connection_id, provider_config_key, quota_key, full_name, selected_key,
      main_branch, is_private, raw, status, status_reason, not_found_streak, last_checked_at)
    VALUES (${input.tenantId}, ${input.repoUuid}, ${input.repoUuid}, ${input.workspaceUuid}, ${input.connectionId}, ${input.providerConfigKey}, ${input.quotaKey},
      ${input.fullName}, ${input.selectedKey}, ${input.mainBranch}, ${input.isPrivate}, ${json(input.raw)}::jsonb, 'active', NULL, 0, now())
    ON CONFLICT (tenant_id, repo_uuid) DO UPDATE SET workspace_uuid = EXCLUDED.workspace_uuid, connection_id = EXCLUDED.connection_id,
      provider_config_key = EXCLUDED.provider_config_key, quota_key = EXCLUDED.quota_key, full_name = EXCLUDED.full_name, selected_key = EXCLUDED.selected_key,
      main_branch = EXCLUDED.main_branch, is_private = EXCLUDED.is_private, raw = EXCLUDED.raw,
      status = CASE WHEN bitbucket_source_repos.status = 'out_of_scope' THEN 'out_of_scope' ELSE 'active' END,
      status_reason = CASE WHEN bitbucket_source_repos.status = 'out_of_scope' THEN bitbucket_source_repos.status_reason ELSE NULL END,
      not_found_streak = 0, last_checked_at = now(),
      updated_at = CASE WHEN bitbucket_source_repos.raw IS DISTINCT FROM EXCLUDED.raw OR bitbucket_source_repos.full_name <> EXCLUDED.full_name
        OR bitbucket_source_repos.status NOT IN ('active', 'out_of_scope') THEN now() ELSE bitbucket_source_repos.updated_at END
  `);
  return { renamedFrom: before && before.full_name !== input.fullName ? before.full_name : null };
}

export async function setRepoStatus(db: DbExecutor, scope: RepoScope, status: string, reason: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_repos SET status = ${status}, status_reason = ${reason}, last_checked_at = now(), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND (status IS DISTINCT FROM ${status} OR status_reason IS DISTINCT FROM ${reason})
  `);
  await db.execute(sql`UPDATE bitbucket_source_repos SET last_checked_at = now() WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
}

/**
 * Re-export rows whose paths or visibility derive from the repository row: every file,
 * branch manifest and snapshot after a rename (all paths move), the branch manifests after a
 * scope change. The exporter deletes the old paths (source_path_changed).
 */
export async function bumpExportEpoch(db: DbExecutor, scope: RepoScope, what: "rename" | "scope"): Promise<void> {
  await db.execute(sql`UPDATE bitbucket_source_refs SET export_epoch = export_epoch + 1 WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
  if (what === "scope") return;
  await db.execute(sql`UPDATE bitbucket_source_files SET export_epoch = export_epoch + 1 WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
  await db.execute(sql`UPDATE bitbucket_source_snapshots SET export_epoch = export_epoch + 1 WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
}

/** One more consecutive "not found through every grant"; returns the new streak. */
export async function bumpNotFound(db: DbExecutor, scope: RepoScope): Promise<number> {
  const r = rowsOf<{ n: unknown }>(
    await db.execute(sql`
      UPDATE bitbucket_source_repos SET not_found_streak = not_found_streak + 1, last_checked_at = now()
      WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} RETURNING not_found_streak AS n
    `),
  )[0];
  return Number(r?.n ?? 0);
}

// ------------------------------------------------------------------ refs

export interface RefRow {
  tenant_id: string;
  row_key: string;
  repo_uuid: string;
  ref_name: string;
  status: string;
  status_reason: string | null;
  next_generation: number;
  scan_generation: number | null;
  scan_commit_sha: string | null;
  scan_commit_raw: Record<string, unknown> | null;
  scan_mode: "full" | "diff" | null;
  scan_base_commit_sha: string | null;
  scan_phase: "list" | "files" | "ready" | null;
  scan_cursor: string | null;
  scan_pages: number;
  scan_started_at: unknown;
  scan_reason: string | null;
  scan_incomplete_prefixes: string[];
  committed_generation: number | null;
  committed_commit_sha: string | null;
  committed_commit_raw_text: string | null;
  committed_mode: string | null;
  committed_at: unknown;
  committed_counts: Record<string, number> | null;
  last_full_at: unknown;
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
    scan_pages: Number(r.scan_pages ?? 0),
    error_streak: Number(r.error_streak ?? 0),
    scan_incomplete_prefixes: parseJson<string[]>(r.scan_incomplete_prefixes, []),
    scan_commit_raw: parseJson<Record<string, unknown> | null>(r.scan_commit_raw, null),
    committed_counts: parseJson<Record<string, number> | null>(r.committed_counts, null),
  };
}

const REF_COLS = sql`*, committed_commit_raw::text AS committed_commit_raw_text`;

export async function ensureRef(db: DbExecutor, scope: RefScope): Promise<RefRow> {
  await db.execute(sql`
    INSERT INTO bitbucket_source_refs (tenant_id, row_key, repo_uuid, ref_name) VALUES (${scope.tenantId}, ${refRowKey(scope.repoUuid, scope.ref)}, ${scope.repoUuid}, ${scope.ref})
    ON CONFLICT (tenant_id, repo_uuid, ref_name) DO NOTHING
  `);
  return (await getRef(db, scope))!;
}

export async function getRef(db: DbExecutor, scope: RefScope): Promise<RefRow | null> {
  const r = rowsOf<Record<string, unknown>>(
    await db.execute(sql`SELECT ${REF_COLS} FROM bitbucket_source_refs WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}`),
  )[0];
  return r ? refRow(r) : null;
}

export async function getRefByRowKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<RefRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT ${REF_COLS} FROM bitbucket_source_refs WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? refRow(r) : null;
}

export async function listRefs(db: DbExecutor, tenantId: string, repoUuid?: string): Promise<RefRow[]> {
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT ${REF_COLS} FROM bitbucket_source_refs WHERE tenant_id = ${tenantId} ${repoUuid !== undefined ? sql`AND repo_uuid = ${repoUuid}` : sql``}
      ORDER BY repo_uuid, ref_name
    `),
  ).map(refRow);
}

export async function setRefStatus(db: DbExecutor, scope: RefScope, status: string, reason: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_refs SET status = ${status}, status_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND (status IS DISTINCT FROM ${status} OR status_reason IS DISTINCT FROM ${reason})
  `);
}

export async function recordHeadObservation(db: DbExecutor, scope: RefScope, headSha: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_refs SET observed_head_sha = ${headSha}, observed_head_at = now(), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
  `);
}

export async function recordRefSuccess(db: DbExecutor, scope: RefScope): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_refs SET last_success_at = now(), last_error = NULL, error_streak = 0, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
  `);
}

export async function recordRefError(db: DbExecutor, scope: RefScope, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_refs SET last_error = ${error.slice(0, 1000)}, last_error_at = now(), error_streak = error_streak + 1, updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
  `);
}

// ------------------------------------------------------------------ scans

/** Take the next generation for a scan of `commitSha` (monotonic; never derived from dates or SHAs). */
export async function beginScan(
  db: DbExecutor,
  scope: RefScope,
  input: { commitSha: string; commitRaw: Record<string, unknown>; mode: "full" | "diff"; baseCommitSha: string | null; reason: string },
): Promise<number> {
  const r = rowsOf<{ scan_generation: number }>(
    await db.execute(sql`
      UPDATE bitbucket_source_refs SET
        next_generation = next_generation + 1,
        scan_generation = next_generation + 1,
        scan_commit_sha = ${input.commitSha},
        scan_commit_raw = ${json(input.commitRaw)}::jsonb,
        scan_mode = ${input.mode},
        scan_base_commit_sha = ${input.baseCommitSha},
        scan_phase = 'list',
        scan_cursor = NULL,
        scan_pages = 0,
        scan_started_at = now(),
        scan_reason = ${input.reason},
        scan_incomplete_prefixes = '[]'::jsonb,
        updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
      RETURNING scan_generation
    `),
  )[0];
  if (!r) throw new Error(`bitbucket ref ${scope.repoUuid}/${scope.ref} is not registered`);
  return Number(r.scan_generation);
}

/** Restart the scan in progress as a full listing at the same generation (diffstat unusable or inconsistent). */
export async function convertScanToFull(db: DbExecutor, scope: RefScope, generation: number, reason: string): Promise<boolean> {
  const ok =
    rowsOf(
      await db.execute(sql`
        UPDATE bitbucket_source_refs SET scan_mode = 'full', scan_phase = 'list', scan_cursor = NULL, scan_pages = 0, scan_incomplete_prefixes = '[]'::jsonb,
          scan_reason = ${`${reason}`.slice(0, 500)}, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND scan_generation = ${generation}
        RETURNING row_key
      `),
    ).length > 0;
  if (ok) await dropStaging(db, scope, generation);
  return ok;
}

/** Drop the scan in progress (its commit vanished); the committed state is untouched. */
export async function abandonScan(db: DbExecutor, scope: RefScope, generation: number, reason: string): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_refs SET scan_generation = NULL, scan_commit_sha = NULL, scan_commit_raw = NULL, scan_mode = NULL, scan_base_commit_sha = NULL,
      scan_phase = NULL, scan_cursor = NULL, scan_pages = 0, scan_started_at = NULL, scan_reason = NULL, scan_incomplete_prefixes = '[]'::jsonb,
      last_error = ${reason.slice(0, 1000)}, last_error_at = now(), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND scan_generation = ${generation}
  `);
  await dropStaging(db, scope, generation);
}

export async function setScanPhase(db: DbExecutor, scope: RefScope, generation: number, phase: "list" | "files" | "ready"): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE bitbucket_source_refs SET scan_phase = ${phase}, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND scan_generation = ${generation}
        RETURNING row_key
      `),
    ).length > 0
  );
}

/** Durable diffstat page checkpoint: the `next` URL still to read (null = done). */
export async function setScanCursor(db: DbExecutor, scope: RefScope, generation: number, cursor: string | null): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        UPDATE bitbucket_source_refs SET scan_cursor = ${cursor}, scan_pages = scan_pages + 1, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND scan_generation = ${generation}
        RETURNING row_key
      `),
    ).length > 0
  );
}

export async function addIncompletePrefix(db: DbExecutor, scope: RefScope, generation: number, prefix: string): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_refs SET scan_incomplete_prefixes = (
        SELECT COALESCE(jsonb_agg(DISTINCT v ORDER BY v), '[]'::jsonb) FROM jsonb_array_elements_text(scan_incomplete_prefixes || jsonb_build_array(${prefix}::text)) AS x(v)
      ), updated_at = now()
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND scan_generation = ${generation}
  `);
}

// ------------------------------------------------------------------ directory walk (full scans)

export interface ScanDirRow {
  path: string;
  next_url: string | null;
  pages: number;
  attempts: number;
}

export async function enqueueDirs(db: DbExecutor, scope: RefScope, generation: number, paths: readonly string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += INSERT_BATCH) {
    const part = paths.slice(i, i + INSERT_BATCH);
    await db.execute(sql`
      INSERT INTO bitbucket_source_scan_dirs (tenant_id, repo_uuid, ref_name, generation, path)
      VALUES ${sql.join(part.map((p) => sql`(${scope.tenantId}, ${scope.repoUuid}, ${scope.ref}, ${generation}, ${p})`), sql`, `)}
      ON CONFLICT DO NOTHING
    `);
  }
}

export async function nextDirs(db: DbExecutor, scope: RefScope, generation: number, limit: number): Promise<ScanDirRow[]> {
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT path, next_url, pages, attempts FROM bitbucket_source_scan_dirs
      WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation}
        AND state = 'pending' AND (not_before IS NULL OR not_before <= now())
      ORDER BY path LIMIT ${limit}
    `),
  ).map((r) => ({ path: String(r.path), next_url: (r.next_url as string | null) ?? null, pages: Number(r.pages ?? 0), attempts: Number(r.attempts ?? 0) }));
}

export async function pendingDirCount(db: DbExecutor, scope: RefScope, generation: number): Promise<number> {
  return Number(
    rowsOf<{ n: unknown }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM bitbucket_source_scan_dirs
        WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND state = 'pending'
      `),
    )[0]?.n ?? 0,
  );
}

export async function anyDir(db: DbExecutor, scope: RefScope, generation: number): Promise<boolean> {
  return (
    rowsOf(
      await db.execute(sql`
        SELECT 1 FROM bitbucket_source_scan_dirs WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} LIMIT 1
      `),
    ).length > 0
  );
}

/** Record that one page of a directory was staged: the next page URL (checkpoint) or done. */
export async function advanceDir(db: DbExecutor, scope: RefScope, generation: number, path: string, nextUrl: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_scan_dirs SET next_url = ${nextUrl}, pages = pages + 1, state = ${nextUrl ? "pending" : "done"}, attempts = 0, not_before = NULL, last_error = NULL
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND path = ${path}
  `);
}

export async function finishDir(db: DbExecutor, scope: RefScope, generation: number, path: string, state: "done" | "truncated", error: string | null = null): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_scan_dirs SET state = ${state}, last_error = ${error}
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND path = ${path}
  `);
}

export async function retryDirLater(db: DbExecutor, scope: RefScope, generation: number, path: string, error: string, delayMs: number): Promise<number> {
  const r = rowsOf<{ attempts: unknown }>(
    await db.execute(sql`
      UPDATE bitbucket_source_scan_dirs SET attempts = attempts + 1, last_error = ${error.slice(0, 500)}, not_before = now() + make_interval(secs => ${delayMs / 1000})
      WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND path = ${path}
      RETURNING attempts
    `),
  )[0];
  return Number(r?.attempts ?? 0);
}

// ------------------------------------------------------------------ staged entries

export interface StagedPut {
  path: string;
  /** file | link | submodule; null when meta is not known yet (diff mode). */
  entryType: string | null;
  attributes: string[];
  size: number | null;
  metaKnown: boolean;
  renamedFrom?: string | null;
}

/** Stage files present at the scan commit (idempotent: a re-read page overwrites the same rows). */
export async function stagePuts(db: DbExecutor, scope: RefScope, generation: number, entries: readonly StagedPut[], maxBytes: number): Promise<void> {
  for (let i = 0; i < entries.length; i += INSERT_BATCH) {
    const part = entries.slice(i, i + INSERT_BATCH);
    await db.execute(sql`
      INSERT INTO bitbucket_source_scan_entries (tenant_id, repo_uuid, ref_name, generation, path, change, entry_type, attributes, size, meta_known, renamed_from,
        renamed_to, fetch_state, omit_reason)
      VALUES ${sql.join(
        part.map((e) => {
          const omit = omitFor(e, maxBytes);
          return sql`(${scope.tenantId}, ${scope.repoUuid}, ${scope.ref}, ${generation}, ${e.path}, 'put', ${e.entryType}, ${json(e.attributes)}::jsonb, ${e.size},
            ${e.metaKnown}, ${e.renamedFrom ?? null}, NULL, ${omit ? "omitted" : "pending"}, ${omit})`;
        }),
        sql`, `,
      )}
      ON CONFLICT (tenant_id, repo_uuid, ref_name, generation, path) DO UPDATE SET change = 'put', entry_type = EXCLUDED.entry_type, attributes = EXCLUDED.attributes,
        size = EXCLUDED.size, meta_known = EXCLUDED.meta_known, renamed_from = COALESCE(EXCLUDED.renamed_from, bitbucket_source_scan_entries.renamed_from),
        renamed_to = NULL,
        fetch_state = CASE WHEN bitbucket_source_scan_entries.fetch_state = 'stored' AND bitbucket_source_scan_entries.size IS NOT DISTINCT FROM EXCLUDED.size
          AND bitbucket_source_scan_entries.change = 'put' THEN 'stored' ELSE EXCLUDED.fetch_state END,
        omit_reason = CASE WHEN bitbucket_source_scan_entries.fetch_state = 'stored' AND bitbucket_source_scan_entries.size IS NOT DISTINCT FROM EXCLUDED.size
          AND bitbucket_source_scan_entries.change = 'put' THEN NULL ELSE EXCLUDED.omit_reason END
    `);
  }
}

/** Stage explicit removals (diff mode). A path that is also staged as a put keeps the put. */
export async function stageDeletes(db: DbExecutor, scope: RefScope, generation: number, entries: ReadonlyArray<{ path: string; renamedTo: string | null }>): Promise<void> {
  for (let i = 0; i < entries.length; i += INSERT_BATCH) {
    const part = entries.slice(i, i + INSERT_BATCH);
    await db.execute(sql`
      INSERT INTO bitbucket_source_scan_entries (tenant_id, repo_uuid, ref_name, generation, path, change, renamed_to, fetch_state, meta_known)
      VALUES ${sql.join(part.map((e) => sql`(${scope.tenantId}, ${scope.repoUuid}, ${scope.ref}, ${generation}, ${e.path}, 'delete', ${e.renamedTo}, 'none', true)`), sql`, `)}
      ON CONFLICT (tenant_id, repo_uuid, ref_name, generation, path) DO UPDATE SET
        renamed_to = CASE WHEN bitbucket_source_scan_entries.change = 'delete' THEN EXCLUDED.renamed_to ELSE bitbucket_source_scan_entries.renamed_to END
    `);
  }
}

function omitFor(e: StagedPut, maxBytes: number): string | null {
  if (!e.metaKnown) return null;
  if (e.entryType === "submodule") return "submodule";
  if (e.size !== null && e.size > maxBytes && !e.attributes.includes("lfs")) return "too_large";
  return null;
}

export interface PendingFetch {
  path: string;
  entry_type: string | null;
  attributes: string[];
  size: number | null;
  meta_known: boolean;
  attempts: number;
}

export async function nextPendingFetches(db: DbExecutor, scope: RefScope, generation: number, limit: number): Promise<PendingFetch[]> {
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT path, entry_type, attributes, size, meta_known, attempts FROM bitbucket_source_scan_entries
      WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation}
        AND change = 'put' AND fetch_state = 'pending' AND (not_before IS NULL OR not_before <= now())
      ORDER BY path LIMIT ${limit}
    `),
  ).map((r) => ({
    path: String(r.path),
    entry_type: (r.entry_type as string | null) ?? null,
    attributes: parseJson<string[]>(r.attributes, []),
    size: int(r.size),
    meta_known: Boolean(r.meta_known),
    attempts: Number(r.attempts ?? 0),
  }));
}

export async function pendingFetchCount(db: DbExecutor, scope: RefScope, generation: number): Promise<number> {
  return Number(
    rowsOf<{ n: unknown }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM bitbucket_source_scan_entries
        WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND change = 'put' AND fetch_state = 'pending'
      `),
    )[0]?.n ?? 0,
  );
}

/** Attributes/size from a `format=meta` response (diff mode); applies the size/submodule omissions. */
export async function setEntryMeta(db: DbExecutor, scope: RefScope, generation: number, path: string, meta: { entryType: string; attributes: string[]; size: number | null }, maxBytes: number): Promise<string | null> {
  const omit = omitFor({ path, entryType: meta.entryType, attributes: meta.attributes, size: meta.size, metaKnown: true }, maxBytes);
  await db.execute(sql`
    UPDATE bitbucket_source_scan_entries SET entry_type = ${meta.entryType}, attributes = ${json(meta.attributes)}::jsonb, size = ${meta.size}, meta_known = true,
      fetch_state = ${omit ? "omitted" : "pending"}, omit_reason = ${omit}
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND path = ${path}
  `);
  return omit;
}

export async function markFetched(db: DbExecutor, scope: RefScope, generation: number, path: string, contentSha256: string, size: number): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_scan_entries SET fetch_state = 'stored', content_sha256 = ${contentSha256}, size = ${size}, omit_reason = NULL, last_error = NULL
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND path = ${path}
  `);
}

export async function markOmitted(db: DbExecutor, scope: RefScope, generation: number, path: string, reason: string, error: string | null = null): Promise<void> {
  await db.execute(sql`
    UPDATE bitbucket_source_scan_entries SET fetch_state = 'omitted', omit_reason = ${reason}, content_sha256 = NULL, last_error = ${error ? error.slice(0, 500) : null}
    WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND path = ${path}
  `);
}

export async function retryFetchLater(db: DbExecutor, scope: RefScope, generation: number, path: string, error: string, delayMs: number): Promise<number> {
  const r = rowsOf<{ attempts: unknown }>(
    await db.execute(sql`
      UPDATE bitbucket_source_scan_entries SET attempts = attempts + 1, last_error = ${error.slice(0, 500)}, not_before = now() + make_interval(secs => ${delayMs / 1000})
      WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation} AND path = ${path}
      RETURNING attempts
    `),
  )[0];
  return Number(r?.attempts ?? 0);
}

/** Staged delete paths of a diff scan (for the orientation check). */
export async function stagedDeletePaths(db: DbExecutor, scope: RefScope, generation: number, limit: number): Promise<string[]> {
  return rowsOf<{ path: string }>(
    await db.execute(sql`
      SELECT path FROM bitbucket_source_scan_entries WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
        AND generation = ${generation} AND change = 'delete' ORDER BY path LIMIT ${limit}
    `),
  ).map((r) => r.path);
}

export async function stagedCounts(db: DbExecutor, scope: RefScope, generation: number): Promise<Record<string, number>> {
  const r =
    rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        SELECT count(*) FILTER (WHERE change = 'put')::int AS puts,
               count(*) FILTER (WHERE change = 'delete')::int AS deletes,
               count(*) FILTER (WHERE fetch_state = 'pending')::int AS pending,
               count(*) FILTER (WHERE fetch_state = 'stored')::int AS stored,
               count(*) FILTER (WHERE fetch_state = 'omitted')::int AS omitted,
               (SELECT count(*) FROM bitbucket_source_scan_dirs d WHERE d.tenant_id = ${scope.tenantId} AND d.repo_uuid = ${scope.repoUuid} AND d.ref_name = ${scope.ref}
                  AND d.generation = ${generation} AND d.state = 'pending')::int AS dirs_pending
        FROM bitbucket_source_scan_entries
        WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation}
      `),
    )[0] ?? {};
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v ?? 0)]));
}

/** Staging rows of generations that are not the scan in progress (a crashed or superseded worker's leftovers). */
export async function pruneStaleStaging(db: DbExecutor, scope: RefScope): Promise<void> {
  const ref = await getRef(db, scope);
  if (!ref) return;
  await db.execute(sql`
    DELETE FROM bitbucket_source_scan_entries WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
      AND generation IS DISTINCT FROM ${ref.scan_generation}
  `);
  await db.execute(sql`
    DELETE FROM bitbucket_source_scan_dirs WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
      AND generation IS DISTINCT FROM ${ref.scan_generation}
  `);
}

async function dropStaging(db: DbExecutor, scope: RefScope, generation: number): Promise<void> {
  await db.execute(sql`DELETE FROM bitbucket_source_scan_entries WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation}`);
  await db.execute(sql`DELETE FROM bitbucket_source_scan_dirs WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND generation = ${generation}`);
}

// ------------------------------------------------------------------ blobs

export interface BlobRow {
  sha256: string;
  size: number;
  chunks: Array<{ sha256: string; size: number }>;
  is_text: boolean;
}

/** Store exact bytes as <= 8 MiB chunks, content-addressed per tenant. */
export async function storeBlob(db: DbExecutor, tenantId: string, bytes: Buffer, isText: boolean): Promise<BlobRow> {
  const chunks: Array<{ sha256: string; size: number }> = [];
  for (let off = 0; off < bytes.length || chunks.length === 0; off += CHUNK_BYTES) {
    const piece = bytes.subarray(off, Math.min(bytes.length, off + CHUNK_BYTES));
    const sha = sha256Hex(piece);
    await db.execute(sql`
      INSERT INTO bitbucket_source_chunks (tenant_id, chunk_sha256, size, bytes) VALUES (${tenantId}, ${sha}, ${piece.length}, ${piece})
      ON CONFLICT (tenant_id, chunk_sha256) DO NOTHING
    `);
    chunks.push({ sha256: sha, size: piece.length });
    if (bytes.length === 0) break;
  }
  const sha256 = sha256Hex(bytes);
  await db.execute(sql`
    INSERT INTO bitbucket_source_blobs (tenant_id, sha256, size, chunks, is_text) VALUES (${tenantId}, ${sha256}, ${bytes.length}, ${json(chunks)}::jsonb, ${isText})
    ON CONFLICT (tenant_id, sha256) DO NOTHING
  `);
  return { sha256, size: bytes.length, chunks, is_text: isText };
}

export async function getBlob(db: DbExecutor, tenantId: string, sha256: string): Promise<BlobRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT sha256, size, chunks, is_text FROM bitbucket_source_blobs WHERE tenant_id = ${tenantId} AND sha256 = ${sha256}`))[0];
  if (!r) return null;
  const chunks = parseJson<Array<{ sha256: string; size: number }>>(r.chunks, []);
  return { sha256: String(r.sha256), size: Number(r.size), chunks: chunks.map((c) => ({ sha256: c.sha256, size: Number(c.size) })), is_text: Boolean(r.is_text) };
}

export async function loadChunk(db: DbExecutor, tenantId: string, chunkSha256: string): Promise<Buffer> {
  const r = rowsOf<{ bytes: unknown }>(await db.execute(sql`SELECT bytes FROM bitbucket_source_chunks WHERE tenant_id = ${tenantId} AND chunk_sha256 = ${chunkSha256}`))[0];
  if (!r) throw new Error(`bitbucket chunk ${chunkSha256} is missing`);
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
  repo_uuid: string;
  ref_name: string;
  path: string;
  entry_type: string;
  attributes: string[];
  size: number | null;
  content_sha256: string | null;
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
  updated_at: unknown;
}

function fileRow(r: Record<string, unknown>): FileRow {
  return {
    ...(r as unknown as FileRow),
    attributes: parseJson<string[]>(r.attributes, []),
    size: int(r.size),
    content_generation: Number(r.content_generation),
    first_generation: Number(r.first_generation),
    deleted_generation: int(r.deleted_generation),
  };
}

export async function getFileByRowKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<FileRow | null> {
  const r = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT * FROM bitbucket_source_files WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`))[0];
  return r ? fileRow(r) : null;
}

export async function getFile(db: DbExecutor, scope: RefScope, path: string): Promise<FileRow | null> {
  const r = rowsOf<Record<string, unknown>>(
    await db.execute(sql`SELECT * FROM bitbucket_source_files WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND path = ${path}`),
  )[0];
  return r ? fileRow(r) : null;
}

export async function listFiles(db: DbExecutor, scope: RefScope, opts: { state?: "live" | "deleted"; omitted?: boolean | string; limit?: number } = {}): Promise<FileRow[]> {
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT * FROM bitbucket_source_files
      WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
        ${opts.state ? sql`AND state = ${opts.state}` : sql``}
        ${typeof opts.omitted === "string" ? sql`AND omit_reason = ${opts.omitted}` : opts.omitted === true ? sql`AND omit_reason IS NOT NULL` : opts.omitted === false ? sql`AND omit_reason IS NULL` : sql``}
      ORDER BY path ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}
    `),
  ).map(fileRow);
}

export async function fileCounts(db: DbExecutor, scope: RefScope): Promise<Record<string, number>> {
  const r =
    rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        SELECT count(*) FILTER (WHERE state = 'live')::int AS live,
               count(*) FILTER (WHERE state = 'live' AND omit_reason IS NULL)::int AS exported,
               count(*) FILTER (WHERE state = 'live' AND omit_reason = 'too_large')::int AS too_large,
               count(*) FILTER (WHERE state = 'live' AND omit_reason = 'fetch_failed')::int AS fetch_failed,
               count(*) FILTER (WHERE state = 'live' AND omit_reason = 'submodule')::int AS submodules,
               count(*) FILTER (WHERE state = 'live' AND attributes ? 'lfs')::int AS lfs,
               count(*) FILTER (WHERE state = 'deleted')::int AS deleted,
               COALESCE(sum(size) FILTER (WHERE state = 'live' AND omit_reason IS NULL), 0)::bigint AS bytes
        FROM bitbucket_source_files WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
      `),
    )[0] ?? {};
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v ?? 0)]));
}

/**
 * Hide (reason) or show again (null) files of a repository/branch in the export (out of
 * scope, branch retired). Only rows whose current retired_reason equals `from` change.
 */
export async function setFilesRetired(db: DbExecutor, scope: RepoScope & { ref?: string }, reason: string | null, from: string | null): Promise<number> {
  return rowsOf(
    await db.execute(sql`
      UPDATE bitbucket_source_files SET retired_reason = ${reason}, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} ${scope.ref !== undefined ? sql`AND ref_name = ${scope.ref}` : sql``}
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
 * Make staged generation `generation` the current file set of the branch, atomically.
 *
 * Accepted only while it is still the scan in progress AND newer than the committed
 * generation: a late completion of an older scan (a worker that lost its lease, a scan
 * replaced meanwhile) is refused and changes nothing. Ordering never consults commit dates
 * or SHAs.
 *
 * full mode: every live path not listed at the scan commit is deleted, except under
 *            directories whose listing was incomplete; a removed and an added path with the
 *            same unique content are a rename.
 * diff mode: only the paths the diffstat named change (renames as reported by Bitbucket).
 *
 * Per path: unchanged bytes/attributes keep their content_generation (no re-version);
 * changed or re-added paths take this generation.
 */
export async function commitScan(db: BitbucketDb, scope: RefScope, generation: number): Promise<CommitOutcome> {
  if (!db.transaction) throw new Error("bitbucket commitScan needs a transactional executor");
  return db.transaction(async (tx: DbExecutor) => {
    const t = scope.tenantId;
    const repo = scope.repoUuid;
    const ref = scope.ref;
    const g = generation;
    const lock = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`SELECT ${REF_COLS} FROM bitbucket_source_refs WHERE tenant_id = ${t} AND repo_uuid = ${repo} AND ref_name = ${ref} FOR UPDATE`),
    )[0];
    if (!lock) return { outcome: "superseded", generation: g, reason: "ref no longer exists" };
    const row = refRow(lock);
    if (row.scan_generation !== g) return { outcome: "superseded", generation: g, reason: `scan generation ${g} is not the scan in progress (${row.scan_generation ?? "none"})` };
    if (row.committed_generation !== null && row.committed_generation >= g) return { outcome: "superseded", generation: g, reason: `generation ${row.committed_generation} is already committed` };
    if (row.scan_phase !== "ready") return { outcome: "superseded", generation: g, reason: `scan generation ${g} is not ready (${row.scan_phase})` };
    const pending = Number(
      rowsOf<{ n: unknown }>(
        await tx.execute(sql`
          SELECT (SELECT count(*) FROM bitbucket_source_scan_entries WHERE tenant_id = ${t} AND repo_uuid = ${repo} AND ref_name = ${ref} AND generation = ${g} AND fetch_state = 'pending')
               + (SELECT count(*) FROM bitbucket_source_scan_dirs WHERE tenant_id = ${t} AND repo_uuid = ${repo} AND ref_name = ${ref} AND generation = ${g} AND state = 'pending') AS n
        `),
      )[0]?.n ?? 0,
    );
    if (pending > 0) return { outcome: "superseded", generation: g, reason: "scan still has pending work" };

    const mode = row.scan_mode ?? "full";
    const commitSha = row.scan_commit_sha!;
    const prefixes = json(row.scan_incomplete_prefixes);
    const stagedWhere = sql`s.tenant_id = ${t} AND s.repo_uuid = ${repo} AND s.ref_name = ${ref} AND s.generation = ${g}`;
    const keptByPrefix = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${prefixes}::jsonb) p(v) WHERE starts_with(f.path, p.v))`;

    if (mode === "full") {
      // Live paths absent from the listing become explicit deletes (never under an incomplete directory) ...
      await tx.execute(sql`
        INSERT INTO bitbucket_source_scan_entries (tenant_id, repo_uuid, ref_name, generation, path, change, fetch_state, meta_known)
        SELECT ${t}, ${repo}, ${ref}, ${g}, f.path, 'delete', 'none', true FROM bitbucket_source_files f
        WHERE f.tenant_id = ${t} AND f.repo_uuid = ${repo} AND f.ref_name = ${ref} AND f.state = 'live'
          AND NOT EXISTS (SELECT 1 FROM bitbucket_source_scan_entries s WHERE ${stagedWhere} AND s.path = f.path)
          AND NOT ${keptByPrefix}
        ON CONFLICT DO NOTHING
      `);
      // ... and a removed path + a new path with the same unique content are a rename.
      const renames = rowsOf<{ from_path: string; to_path: string }>(
        await tx.execute(sql`
          WITH removed AS (
            SELECT s.path, f.content_sha256 FROM bitbucket_source_scan_entries s
              JOIN bitbucket_source_files f ON f.tenant_id = s.tenant_id AND f.repo_uuid = s.repo_uuid AND f.ref_name = s.ref_name AND f.path = s.path
            WHERE ${stagedWhere} AND s.change = 'delete' AND f.content_sha256 IS NOT NULL
          ), added AS (
            SELECT s.path, s.content_sha256 FROM bitbucket_source_scan_entries s
            WHERE ${stagedWhere} AND s.change = 'put' AND s.content_sha256 IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM bitbucket_source_files f WHERE f.tenant_id = ${t} AND f.repo_uuid = ${repo} AND f.ref_name = ${ref} AND f.state = 'live' AND f.path = s.path)
          ), ru AS (SELECT content_sha256 FROM removed GROUP BY content_sha256 HAVING count(*) = 1),
             au AS (SELECT content_sha256 FROM added GROUP BY content_sha256 HAVING count(*) = 1)
          SELECT r.path AS from_path, a.path AS to_path FROM removed r JOIN added a ON a.content_sha256 = r.content_sha256
          WHERE r.content_sha256 IN (SELECT content_sha256 FROM ru) AND r.content_sha256 IN (SELECT content_sha256 FROM au)
        `),
      );
      for (const rn of renames) {
        await tx.execute(sql`UPDATE bitbucket_source_scan_entries s SET renamed_from = ${rn.from_path} WHERE ${stagedWhere} AND s.path = ${rn.to_path} AND s.change = 'put'`);
        await tx.execute(sql`UPDATE bitbucket_source_scan_entries s SET renamed_to = ${rn.to_path} WHERE ${stagedWhere} AND s.path = ${rn.from_path} AND s.change = 'delete'`);
      }
    }

    const changedCond = sql`(f.state <> 'live' OR f.content_sha256 IS DISTINCT FROM s.content_sha256 OR f.entry_type IS DISTINCT FROM s.entry_type
      OR f.attributes IS DISTINCT FROM s.attributes OR f.omit_reason IS DISTINCT FROM s.omit_reason)`;
    const changeRows = rowsOf<{ op: string; path: string; other: string | null; content_sha256: string | null; omit_reason: string | null }>(
      await tx.execute(sql`
        SELECT * FROM (
          SELECT CASE WHEN f.path IS NULL OR f.state <> 'live' THEN (CASE WHEN s.renamed_from IS NOT NULL THEN 'renamed' ELSE 'added' END)
                      WHEN ${changedCond} THEN 'modified' ELSE 'unchanged' END AS op,
                 s.path, s.renamed_from AS other, s.content_sha256, s.omit_reason
          FROM bitbucket_source_scan_entries s
            LEFT JOIN bitbucket_source_files f ON f.tenant_id = s.tenant_id AND f.repo_uuid = s.repo_uuid AND f.ref_name = s.ref_name AND f.path = s.path
          WHERE ${stagedWhere} AND s.change = 'put'
          UNION ALL
          SELECT CASE WHEN f.path IS NULL OR f.state <> 'live' THEN 'absent' WHEN s.renamed_to IS NOT NULL THEN 'renamed_away' ELSE 'deleted' END,
                 s.path, s.renamed_to, NULL, NULL
          FROM bitbucket_source_scan_entries s
            LEFT JOIN bitbucket_source_files f ON f.tenant_id = s.tenant_id AND f.repo_uuid = s.repo_uuid AND f.ref_name = s.ref_name AND f.path = s.path
          WHERE ${stagedWhere} AND s.change = 'delete'
        ) c ORDER BY path, op
      `),
    );
    const counts: Record<string, number> = { added: 0, modified: 0, renamed: 0, deleted: 0, unchanged: 0, absent: 0 };
    for (const c of changeRows) {
      const k = c.op === "renamed_away" ? "renamed_away" : c.op;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    delete counts.renamed_away;
    const visible = changeRows.filter((c) => c.op !== "unchanged" && c.op !== "absent" && c.op !== "renamed_away");
    const truncated = visible.length > MAX_SNAPSHOT_CHANGES;
    const changeList = visible.slice(0, MAX_SNAPSHOT_CHANGES).map((c) => ({
      op: c.op,
      path: c.path,
      ...(c.op === "renamed" && c.other ? { from: c.other } : {}),
      ...(c.content_sha256 ? { sha256: c.content_sha256 } : {}),
      ...(c.omit_reason ? { omitted: c.omit_reason } : {}),
    }));

    // 1. Changed / re-added paths that already have a row.
    await tx.execute(sql`
      UPDATE bitbucket_source_files f SET entry_type = s.entry_type, attributes = s.attributes, size = s.size, content_sha256 = s.content_sha256, state = 'live',
        omit_reason = s.omit_reason, content_generation = ${g}, content_commit_sha = ${commitSha}, deleted_generation = NULL, deleted_commit_sha = NULL,
        delete_reason = NULL, renamed_to = NULL, renamed_from = s.renamed_from, updated_at = now()
      FROM bitbucket_source_scan_entries s
      WHERE f.tenant_id = ${t} AND f.repo_uuid = ${repo} AND f.ref_name = ${ref} AND ${stagedWhere} AND s.change = 'put' AND s.path = f.path AND ${changedCond}
    `);
    // 2. Paths never seen before on this branch.
    await tx.execute(sql`
      INSERT INTO bitbucket_source_files (tenant_id, row_key, repo_uuid, ref_name, path, entry_type, attributes, size, content_sha256, state, omit_reason,
        content_generation, content_commit_sha, first_generation, renamed_from)
      SELECT ${t}, ${repo} || ':' || encode(sha256(convert_to(${ref} || E'\n' || s.path, 'UTF8')), 'hex'), ${repo}, ${ref}, s.path, COALESCE(s.entry_type, 'file'),
        s.attributes, s.size, s.content_sha256, 'live', s.omit_reason, ${g}, ${commitSha}, ${g}, s.renamed_from
      FROM bitbucket_source_scan_entries s
      WHERE ${stagedWhere} AND s.change = 'put'
        AND NOT EXISTS (SELECT 1 FROM bitbucket_source_files f WHERE f.tenant_id = ${t} AND f.repo_uuid = ${repo} AND f.ref_name = ${ref} AND f.path = s.path)
      ON CONFLICT (tenant_id, repo_uuid, ref_name, path) DO NOTHING
    `);
    // 3. Removed / renamed-away paths.
    await tx.execute(sql`
      UPDATE bitbucket_source_files f SET state = 'deleted', deleted_generation = ${g}, deleted_commit_sha = ${commitSha},
        delete_reason = CASE WHEN s.renamed_to IS NOT NULL THEN 'bitbucket_renamed' ELSE 'bitbucket_deleted' END, renamed_to = s.renamed_to, updated_at = now()
      FROM bitbucket_source_scan_entries s
      WHERE f.tenant_id = ${t} AND f.repo_uuid = ${repo} AND f.ref_name = ${ref} AND f.state = 'live' AND ${stagedWhere} AND s.change = 'delete' AND s.path = f.path
    `);

    const omitted = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT count(*) FILTER (WHERE omit_reason = 'too_large')::int AS too_large, count(*) FILTER (WHERE omit_reason = 'fetch_failed')::int AS fetch_failed,
               count(*) FILTER (WHERE omit_reason = 'submodule')::int AS submodules
        FROM bitbucket_source_files WHERE tenant_id = ${t} AND repo_uuid = ${repo} AND ref_name = ${ref} AND state = 'live'
      `),
    )[0]!;
    for (const [k, v] of Object.entries(omitted)) counts[k] = Number(v ?? 0);
    const incompleteReasons: string[] = [];
    if (row.scan_incomplete_prefixes.length) incompleteReasons.push(`directory listing incomplete under: ${row.scan_incomplete_prefixes.map((p) => (p === "" ? "/" : p)).join(", ")}`);
    if (counts.too_large) incompleteReasons.push(`${counts.too_large} file(s) over the capture size limit are not exported`);
    if (counts.fetch_failed) incompleteReasons.push(`${counts.fetch_failed} file(s) could not be fetched and are retried`);
    const complete = incompleteReasons.length === 0;
    const listingComplete = row.scan_incomplete_prefixes.length === 0;
    await tx.execute(sql`
      INSERT INTO bitbucket_source_snapshots (tenant_id, row_key, repo_uuid, ref_name, generation, previous_generation, commit_sha, base_commit_sha, mode, commit_raw,
        counts, changes, changes_truncated, complete, incomplete_reasons)
      VALUES (${t}, ${snapshotRowKey(repo, ref, g)}, ${repo}, ${ref}, ${g}, ${row.committed_generation}, ${commitSha}, ${row.scan_base_commit_sha}, ${mode},
        ${json(row.scan_commit_raw)}::jsonb, ${json(counts)}::jsonb, ${json(changeList)}::jsonb, ${truncated}, ${complete}, ${json(incompleteReasons)}::jsonb)
      ON CONFLICT (tenant_id, repo_uuid, ref_name, generation) DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE bitbucket_source_refs SET
        committed_generation = ${g}, committed_commit_sha = ${commitSha}, committed_commit_raw = scan_commit_raw, committed_mode = ${mode}, committed_at = now(),
        committed_counts = ${json({ ...counts, complete: complete ? 1 : 0, listing_complete: listingComplete ? 1 : 0 })}::jsonb,
        last_full_at = CASE WHEN ${mode} = 'full' AND ${listingComplete} THEN now() ELSE last_full_at END,
        scan_generation = NULL, scan_commit_sha = NULL, scan_commit_raw = NULL, scan_mode = NULL, scan_base_commit_sha = NULL, scan_phase = NULL, scan_cursor = NULL,
        scan_pages = 0, scan_started_at = NULL, scan_reason = NULL, scan_incomplete_prefixes = '[]'::jsonb, status = 'active', status_reason = NULL,
        last_success_at = now(), last_error = NULL, error_streak = 0, updated_at = now()
      WHERE tenant_id = ${t} AND repo_uuid = ${repo} AND ref_name = ${ref}
    `);
    await dropStaging(tx, scope, g);
    return { outcome: "committed", generation: g, counts, complete };
  });
}

/**
 * The branch is gone upstream (deleted, repository emptied, or the repository itself
 * confirmed not found): every live file becomes deleted at a NEW generation, ordered after
 * everything committed before.
 */
export async function commitRefGone(db: BitbucketDb, scope: RefScope, status: "not_found" | "empty", reason: string, deleteReason: string): Promise<number> {
  if (!db.transaction) throw new Error("bitbucket commitRefGone needs a transactional executor");
  return db.transaction(async (tx: DbExecutor) => {
    const prev = await getRef(tx, scope);
    const g = Number(
      rowsOf<{ g: unknown }>(
        await tx.execute(sql`
          UPDATE bitbucket_source_refs SET next_generation = next_generation + 1, scan_generation = NULL, scan_commit_sha = NULL, scan_commit_raw = NULL,
            scan_mode = NULL, scan_base_commit_sha = NULL, scan_phase = NULL, scan_cursor = NULL, scan_pages = 0, scan_started_at = NULL, scan_reason = NULL,
            scan_incomplete_prefixes = '[]'::jsonb, committed_generation = next_generation + 1, committed_commit_sha = NULL, committed_commit_raw = NULL,
            committed_mode = NULL, committed_at = now(), committed_counts = '{"complete":1,"listing_complete":0}'::jsonb, status = ${status}, status_reason = ${reason},
            last_success_at = now(), last_error = NULL, error_streak = 0, updated_at = now()
          WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}
          RETURNING committed_generation AS g
        `),
      )[0]?.g,
    );
    const deleted = rowsOf(
      await tx.execute(sql`
        UPDATE bitbucket_source_files SET state = 'deleted', deleted_generation = ${g}, deleted_commit_sha = NULL, delete_reason = ${deleteReason}, renamed_to = NULL, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref} AND state = 'live'
        RETURNING row_key
      `),
    ).length;
    await tx.execute(sql`
      INSERT INTO bitbucket_source_snapshots (tenant_id, row_key, repo_uuid, ref_name, generation, previous_generation, commit_sha, mode, counts, changes, complete)
      VALUES (${scope.tenantId}, ${snapshotRowKey(scope.repoUuid, scope.ref, g)}, ${scope.repoUuid}, ${scope.ref}, ${g}, ${prev?.committed_generation ?? null}, NULL, 'gone',
        ${json({ deleted })}::jsonb, ${json([{ op: status === "empty" ? "repository_empty" : "ref_gone", reason }])}::jsonb, true)
      ON CONFLICT (tenant_id, repo_uuid, ref_name, generation) DO NOTHING
    `);
    await tx.execute(sql`DELETE FROM bitbucket_source_scan_entries WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}`);
    await tx.execute(sql`DELETE FROM bitbucket_source_scan_dirs WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} AND ref_name = ${scope.ref}`);
    return g;
  });
}

// ------------------------------------------------------------------ snapshots

export interface SnapshotRow {
  tenant_id: string;
  row_key: string;
  repo_uuid: string;
  ref_name: string;
  generation: number;
  previous_generation: number | null;
  commit_sha: string | null;
  base_commit_sha: string | null;
  mode: string | null;
  commit_raw_text: string | null;
  counts: Record<string, number>;
  changes: unknown[];
  changes_truncated: boolean;
  complete: boolean;
  incomplete_reasons: string[];
  committed_at: unknown;
}

export async function getSnapshotByRowKey(db: DbExecutor, tenantId: string, rowKey: string): Promise<SnapshotRow | null> {
  const r = rowsOf<Record<string, unknown>>(
    await db.execute(sql`SELECT *, commit_raw::text AS commit_raw_text FROM bitbucket_source_snapshots WHERE tenant_id = ${tenantId} AND row_key = ${rowKey}`),
  )[0];
  if (!r) return null;
  return {
    ...(r as unknown as SnapshotRow),
    generation: Number(r.generation),
    previous_generation: int(r.previous_generation),
    counts: parseJson<Record<string, number>>(r.counts, {}),
    changes: parseJson<unknown[]>(r.changes, []),
    incomplete_reasons: parseJson<string[]>(r.incomplete_reasons, []),
    changes_truncated: Boolean(r.changes_truncated),
    complete: Boolean(r.complete),
  };
}

// ------------------------------------------------------------------ purge

/** Destructive removal of one repository's content-lane rows (explicit purge only). */
export async function purgeRepoContent(db: BitbucketDb, scope: RepoScope): Promise<{ files: number }> {
  const run = async (tx: DbExecutor) => {
    const files = rowsOf(await tx.execute(sql`DELETE FROM bitbucket_source_files WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid} RETURNING row_key`)).length;
    await tx.execute(sql`DELETE FROM bitbucket_source_snapshots WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
    await tx.execute(sql`DELETE FROM bitbucket_source_scan_entries WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
    await tx.execute(sql`DELETE FROM bitbucket_source_scan_dirs WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
    await tx.execute(sql`DELETE FROM bitbucket_source_refs WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
    await tx.execute(sql`DELETE FROM bitbucket_source_repos WHERE tenant_id = ${scope.tenantId} AND repo_uuid = ${scope.repoUuid}`);
    // Blobs no other file of this tenant references.
    await tx.execute(sql`
      DELETE FROM bitbucket_source_blobs b WHERE b.tenant_id = ${scope.tenantId}
        AND NOT EXISTS (SELECT 1 FROM bitbucket_source_files f WHERE f.tenant_id = b.tenant_id AND f.content_sha256 = b.sha256)
        AND NOT EXISTS (SELECT 1 FROM bitbucket_source_scan_entries s WHERE s.tenant_id = b.tenant_id AND s.content_sha256 = b.sha256)
    `);
    await tx.execute(sql`
      DELETE FROM bitbucket_source_chunks c WHERE c.tenant_id = ${scope.tenantId}
        AND NOT EXISTS (SELECT 1 FROM bitbucket_source_blobs b, jsonb_array_elements(b.chunks) e WHERE b.tenant_id = c.tenant_id AND e->>'sha256' = c.chunk_sha256)
    `);
    return { files };
  };
  return db.transaction ? db.transaction(run) : run(db);
}
