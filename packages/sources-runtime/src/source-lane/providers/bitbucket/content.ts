import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import type { TaskHandler } from "../../../queue/queue.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import type { DbExecutor } from "../../core/types.js";
import {
  BitbucketApiError,
  BitbucketAuthError,
  BitbucketClient,
  BitbucketRateLimitedError,
  BitbucketTooLargeError,
  branchEndpoint,
  DEFAULT_RATE_BACKOFF_MS,
  diffstatEndpoint,
  isBitbucketUuid,
  isCommitSha,
  isRecord,
  isTextContent,
  nextPage,
  parseFullName,
  repoEndpoint,
  repoUuidEndpoint,
  srcEndpoint,
  type BitbucketClientOptions,
  type BitbucketConnectionRef,
  type BytesResult,
  type JsonResult,
  type RateObservation,
} from "./api.js";
import {
  abandonScan,
  acquireQuotaLease,
  addIncompletePrefix,
  advanceDir,
  anyDir,
  beginScan,
  bumpNotFound,
  clearRateStreak,
  commitRefGone,
  commitScan,
  convertScanToFull,
  enqueueDirs,
  ensureRef,
  findRepoBySelection,
  finishDir,
  getConnectionState,
  getRef,
  getRepo,
  listFiles,
  listRefs,
  listRepos,
  listSelection,
  markFetched,
  markOmitted,
  nextDirs,
  nextPendingFetches,
  pendingDirCount,
  pendingFetchCount,
  pruneStaleStaging,
  quotaBlockedUntil,
  recordConnectionState,
  recordHeadObservation,
  recordRateLimited,
  recordRateObservation,
  recordRefError,
  recordRefSuccess,
  releaseQuotaLease,
  renewQuotaLease,
  retryDirLater,
  retryFetchLater,
  rowsOf,
  setEntryMeta,
  setFilesRetired,
  setRefStatus,
  setRepoStatus,
  setScanCursor,
  setScanPhase,
  stagedDeletePaths,
  stageDeletes,
  stagePuts,
  storeBlob,
  toDate,
  upsertRepo,
  type BitbucketDb,
  type CommitOutcome,
  type RefRow,
  type RefScope,
  type RepoRow,
  type SelectionRow,
  type StagedPut,
} from "./store.js";

/**
 * Bitbucket repository content sweep (task `bitbucket.content_sweep`, one schedule per tenant).
 *
 * For every repository the tenant SELECTED (opt-in, bitbucket_source_selection) and per
 * configured branch (main branch + optional extra branches):
 *
 *   resolve   GET /repositories/{ws-uuid}/{repo-uuid} (rename/transfer-safe) and
 *             /refs/branches/<branch> -> the exact HEAD commit. A HEAD equal to the committed
 *             commit is a successful no-change check.
 *   begin     take the next scan generation (monotonic, never from commit dates or SHAs:
 *             A->B->A is three generations, the third one wins).
 *   list      full: walk /src/<commit>/<dir>/ page by page through a durable directory queue
 *                   (each `next` page URL is a checkpoint); a directory that cannot be listed
 *                   is an incomplete prefix under which nothing is deleted.
 *             diff: /diffstat/<new>..<old>?topic=false against the committed commit, page by
 *                   page with a durable cursor; added/modified/renamed/removed paths only.
 *                   Unusable or inconsistent diffstats fall back to a full listing.
 *   files     GET /src/<commit>/<path> as exact bytes (format=meta first in diff mode for
 *             attributes/size); size verified, stored content-addressed per tenant.
 *   commit    one transaction, accepted only for the scan in progress and only when newer
 *             than the committed generation (late older scans are refused).
 *
 * Requests run one at a time per quota identity (the Bitbucket account behind the grant,
 * else the Nango connection) under a lease shared by all workers and tenants. A 429 stops
 * the run and persists Retry-After / X-RateLimit-Reset (else an escalating backoff);
 * `X-RateLimit-NearLimit` stops the run early to leave budget for the donor issue/PR lanes.
 * Nothing sleeps while holding a task, and no checkpoint advances on a failure.
 */

export const BITBUCKET_CONTENT_TASK = "bitbucket.content_sweep";
export const BITBUCKET_PROVIDER = "bitbucket";
const PAGELEN = 100;
const KNOWN_ATTRIBUTES = new Set(["link", "executable", "subrepository", "binary", "lfs"]);

export interface ContentSweepOptions {
  client?: BitbucketClient;
  clientOptions?: BitbucketClientOptions;
  /** Upstream requests per quota identity per run (default BITBUCKET_SOURCE_MAX_REQUESTS_PER_RUN or 300). */
  maxRequestsPerQuota?: number;
  maxMillisPerQuota?: number;
  /** Files larger than this are listed but not captured (default BITBUCKET_SOURCE_MAX_FILE_BYTES or 50 MiB). */
  maxFileBytes?: number;
  maxItemAttempts?: number;
  /** Pages of one directory listing / of one diffstat before giving up on it. */
  maxDirPages?: number;
  maxDiffPages?: number;
  /** Re-verify a branch with a full listing after this long (default 30 days; 0 = only when needed). */
  fullRescanEveryMs?: number;
  /** A scan in progress this old is replaced when the branch moved meanwhile (default 6 h). */
  staleScanMs?: number;
  /** Cooldown after X-RateLimit-NearLimit (default 5 min). */
  nearLimitCooldownMs?: number;
  /** Consecutive "not found through every grant" checks before a repository's files are tombstoned. */
  notFoundConfirmations?: number;
  leaseOwner?: string;
  leaseSeconds?: number;
  heartbeat?: () => Promise<void>;
}

export interface RefRunReport {
  repoUuid: string;
  repository: string;
  ref: string;
  outcome: "unchanged" | "committed" | "superseded" | "in_progress" | "gone" | "error";
  generation?: number;
  commitSha?: string | null;
  mode?: string | null;
  error?: string;
}

export interface QuotaRunReport {
  quotaKey: string;
  outcome: "ran" | "deferred" | "lease_busy" | "blocked" | "error";
  requests: number;
  deferredUntil?: string;
  error?: string;
  refs: RefRunReport[];
}

export interface ContentSweepReport {
  tenantId: string;
  connections: number;
  selected: number;
  quotas: QuotaRunReport[];
  notes: string[];
}

class Budget {
  requests = 0;
  nearLimit: RateObservation | null = null;
  readonly #deadline: number;
  constructor(
    readonly maxRequests: number,
    maxMillis: number,
  ) {
    this.#deadline = Date.now() + maxMillis;
  }
  get exhausted(): boolean {
    return this.nearLimit !== null || this.requests >= this.maxRequests || Date.now() >= this.#deadline;
  }
}

/** Raised when a ref must stop for budget; its durable state is already stored. */
class Yield extends Error {}

/** Counts requests against the run budget and watches X-RateLimit-NearLimit. */
class BudgetedClient {
  lastRate: RateObservation | null = null;
  constructor(
    readonly inner: BitbucketClient,
    readonly budget: Budget,
  ) {}
  #take(): void {
    if (this.budget.exhausted) throw new Yield();
    this.budget.requests += 1;
  }
  #observe(rate: RateObservation): void {
    if (rate.limit !== null || rate.resource !== null || rate.nearLimit) this.lastRate = rate;
    if (rate.nearLimit) this.budget.nearLimit = rate;
  }
  async getJson(conn: BitbucketConnectionRef, endpoint: string, params?: Record<string, string | number | undefined>, tolerate: readonly number[] = []): Promise<JsonResult> {
    this.#take();
    const r = await this.inner.getJson(conn, endpoint, params, tolerate);
    this.#observe(r.rate);
    return r;
  }
  async getBytes(conn: BitbucketConnectionRef, endpoint: string, maxBytes: number, tolerate: readonly number[] = []): Promise<BytesResult> {
    this.#take();
    const r = await this.inner.getBytes(conn, endpoint, maxBytes, tolerate);
    this.#observe(r.rate);
    return r;
  }
}

interface Ctx {
  db: BitbucketDb;
  tenantId: string;
  client: BudgetedClient;
  budget: Budget;
  maxFileBytes: number;
  maxItemAttempts: number;
  maxDirPages: number;
  maxDiffPages: number;
  fullRescanEveryMs: number;
  staleScanMs: number;
  notFoundConfirmations: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function redact(payload: Record<string, unknown>): Record<string, unknown> {
  return redactProviderPayload(BITBUCKET_PROVIDER, payload) as Record<string, unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPassThrough(error: unknown): boolean {
  return error instanceof Yield || error instanceof BitbucketRateLimitedError || error instanceof BitbucketAuthError;
}

// ------------------------------------------------------------------ connections

export interface BitbucketConnectionRow extends BitbucketConnectionRef {
  status: string;
  accountUuid: string | null;
  quotaKey: string;
}

/**
 * The tenant's Bitbucket connections (the donor `connections` row, one per tenant; Nango keeps
 * the token). The quota identity is the Bitbucket account the grant acts as when it has been
 * resolved (GET /user), because Bitbucket's limits are per account: two tenants that connect
 * the same account share one budget. Unresolved, it is the Nango connection.
 */
export async function bitbucketConnections(db: DbExecutor, tenantId: string): Promise<BitbucketConnectionRow[]> {
  const rs = rowsOf<{ external_account_id: string | null; metadata: unknown; status: string }>(
    await db.execute(sql`
      SELECT external_account_id, metadata, status FROM connections
      WHERE tenant_id = ${tenantId} AND provider = ${BITBUCKET_PROVIDER}
      ORDER BY created_at, id
    `),
  );
  const out: BitbucketConnectionRow[] = [];
  for (const r of rs) {
    const meta = isRecord(r.metadata) ? r.metadata : typeof r.metadata === "string" ? (safeParse(r.metadata) ?? {}) : {};
    const connectionId = str(r.external_account_id) ?? str(meta.nangoConnectionId);
    if (!connectionId) continue;
    const providerConfigKey = str(meta.providerConfigKey) ?? BITBUCKET_PROVIDER;
    const state = await getConnectionState(db, tenantId, connectionId);
    const accountUuid = state?.account_uuid && isBitbucketUuid(state.account_uuid) ? state.account_uuid : null;
    out.push({ connectionId, providerConfigKey, status: r.status, accountUuid, quotaKey: quotaKeyFor(providerConfigKey, connectionId, accountUuid) });
  }
  return out;
}

export function quotaKeyFor(providerConfigKey: string, connectionId: string, accountUuid: string | null): string {
  return accountUuid ? `bitbucket:account:${accountUuid}` : `bitbucket:nango:${providerConfigKey}:${connectionId}`;
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** Resolve the account behind a grant once (GET /user); a failure keeps the connection-level key. */
async function resolveAccount(db: DbExecutor, tenantId: string, conn: BitbucketConnectionRow, client: BitbucketClient): Promise<BitbucketConnectionRow> {
  if (conn.accountUuid) return conn;
  if (await quotaBlockedUntil(db, conn.quotaKey)) return conn;
  try {
    const r = await client.getJson(conn, "/user", undefined, [403, 404]);
    const uuid = isRecord(r.data) ? str(r.data.uuid) : null;
    if (r.status !== 200 || !uuid || !isBitbucketUuid(uuid)) return conn;
    const quotaKey = quotaKeyFor(conn.providerConfigKey, conn.connectionId, uuid);
    await recordConnectionState(db, { tenantId, connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey, accountUuid: uuid, quotaKey, status: "ok", reason: null });
    return { ...conn, accountUuid: uuid, quotaKey };
  } catch (error) {
    if (error instanceof BitbucketRateLimitedError) {
      await recordRateLimited(db, conn.quotaKey, { retryAfterMs: error.retryAfterMs, status: error.status, kind: error.kind, reason: error.message, defaultBackoffMs: DEFAULT_RATE_BACKOFF_MS });
    }
    if (error instanceof BitbucketAuthError) {
      await recordConnectionState(db, { tenantId, connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey, accountUuid: null, quotaKey: conn.quotaKey, status: "blocked", reason: error.message });
      return { ...conn, status: "blocked" };
    }
    return conn;
  }
}

// ------------------------------------------------------------------ entry point

export async function runBitbucketContentSweep(db: BitbucketDb, tenantId: string, options: ContentSweepOptions = {}): Promise<ContentSweepReport> {
  const report: ContentSweepReport = { tenantId, connections: 0, selected: 0, quotas: [], notes: [] };
  const selection = (await listSelection(db, tenantId)).filter((s) => s.selected);
  report.selected = selection.length;
  await reconcileScope(db, tenantId, selection);
  const active = (await bitbucketConnections(db, tenantId)).filter((c) => c.status === "active");
  report.connections = active.length;
  if (!active.length || !selection.length) return report;
  const owner = options.leaseOwner ?? `${hostname().slice(0, 60)}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const client = options.client ?? new BitbucketClient(options.clientOptions);
  const conns: BitbucketConnectionRow[] = [];
  for (const c of active) {
    const resolved = await resolveAccount(db, tenantId, c, client);
    if (resolved.status === "active") conns.push(resolved);
  }
  if (!conns.length) {
    report.notes.push("every Bitbucket grant of this tenant is unauthorized; reconnect");
    return report;
  }

  // A known repository runs in the quota identity of the connection that last read it (if still
  // active); an unknown one is offered to every identity in connection order.
  const groups = new Map<string, { conns: BitbucketConnectionRow[]; known: SelectionRow[] }>();
  for (const c of conns) {
    const g = groups.get(c.quotaKey) ?? { conns: [], known: [] };
    g.conns.push(c);
    groups.set(c.quotaKey, g);
  }
  const unresolved = new Map<string, SelectionRow>();
  for (const sel of selection) {
    const known = await findRepoBySelection(db, tenantId, sel.repo_key);
    const conn = known ? conns.find((c) => c.connectionId === known.connection_id) : undefined;
    if (known && conn) groups.get(conn.quotaKey)!.known.push(sel);
    else unresolved.set(sel.repo_key, sel);
  }
  for (const [quotaKey, group] of groups) {
    report.quotas.push(await runQuota(db, tenantId, quotaKey, group.conns, group.known, unresolved, client, owner, options));
  }
  for (const sel of unresolved.values()) report.notes.push(`selected repository ${sel.full_name} is not readable through any active Bitbucket connection (not found, no access, or not yet checked)`);
  for (const conn of conns) {
    const used = report.quotas.find((q) => q.quotaKey === conn.quotaKey);
    const status = used?.outcome === "blocked" ? "blocked" : used?.outcome === "error" ? "error" : used?.outcome === "deferred" ? "deferred" : "ok";
    await recordConnectionState(db, { tenantId, connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey, accountUuid: conn.accountUuid, quotaKey: conn.quotaKey, status, reason: used?.error ?? null });
  }
  return report;
}

/**
 * Repositories no longer selected leave the current view (files retired, `_repo.json`
 * removed); snapshots and stored history are kept. Re-selecting brings them back.
 */
export async function reconcileScope(db: DbExecutor, tenantId: string, selection: readonly SelectionRow[]): Promise<{ outOfScope: string[] }> {
  const keys = new Set(selection.map((s) => s.repo_key));
  const outOfScope: string[] = [];
  for (const repo of await listRepos(db, tenantId)) {
    if (keys.has(repo.selected_key) || keys.has(repo.full_name.toLowerCase()) || repo.status === "out_of_scope") continue;
    await markOutOfScope(db, { tenantId, repoUuid: repo.repo_uuid }, "repository is no longer selected; captured snapshots are kept");
    outOfScope.push(repo.full_name);
  }
  return { outOfScope };
}

export async function markOutOfScope(db: DbExecutor, scope: { tenantId: string; repoUuid: string }, reason: string): Promise<void> {
  await setRepoStatus(db, scope, "out_of_scope", reason);
  await setFilesRetired(db, scope, "bitbucket_repo_out_of_scope", null);
}

async function runQuota(
  db: BitbucketDb,
  tenantId: string,
  quotaKey: string,
  conns: readonly BitbucketConnectionRow[],
  known: readonly SelectionRow[],
  unresolved: Map<string, SelectionRow>,
  baseClient: BitbucketClient,
  owner: string,
  options: ContentSweepOptions,
): Promise<QuotaRunReport> {
  const out: QuotaRunReport = { quotaKey, outcome: "ran", requests: 0, refs: [] };
  if (!known.length && !unresolved.size) return out;
  const blocked = await quotaBlockedUntil(db, quotaKey);
  if (blocked) return { ...out, outcome: "deferred", deferredUntil: blocked.until.toISOString() };
  const leaseSeconds = options.leaseSeconds ?? 600;
  if (!(await acquireQuotaLease(db, quotaKey, owner, leaseSeconds))) return { ...out, outcome: "lease_busy" };
  const budget = new Budget(options.maxRequestsPerQuota ?? envInt("BITBUCKET_SOURCE_MAX_REQUESTS_PER_RUN", 300), options.maxMillisPerQuota ?? 4 * 60_000);
  const client = new BudgetedClient(baseClient, budget);
  const ctx: Ctx = {
    db,
    tenantId,
    client,
    budget,
    maxFileBytes: options.maxFileBytes ?? envInt("BITBUCKET_SOURCE_MAX_FILE_BYTES", 50 * 1024 * 1024),
    maxItemAttempts: options.maxItemAttempts ?? 5,
    maxDirPages: options.maxDirPages ?? 5000,
    maxDiffPages: options.maxDiffPages ?? 200,
    fullRescanEveryMs: options.fullRescanEveryMs ?? envInt("BITBUCKET_SOURCE_FULL_RESCAN_DAYS", 30) * 86_400_000,
    staleScanMs: options.staleScanMs ?? 6 * 3_600_000,
    notFoundConfirmations: options.notFoundConfirmations ?? 2,
  };
  const latest = new Map<string, RefRunReport>();
  try {
    const work: Array<{ repo: RepoRow; ref: string }> = [];
    for (const sel of [...known, ...unresolved.values()]) {
      if (budget.exhausted) break;
      try {
        const repo = await refreshRepo(ctx, sel, conns);
        if (!repo) continue;
        unresolved.delete(sel.repo_key);
        for (const ref of await configuredRefs(ctx, repo, sel)) work.push({ repo, ref });
      } catch (error) {
        if (error instanceof Yield) break;
        if (error instanceof BitbucketRateLimitedError || error instanceof BitbucketAuthError) throw error;
        out.error = `repository ${sel.full_name}: ${message(error)}`;
      }
    }
    // Fair share first (every branch progresses each run), then the rest of the budget in order.
    const share = Math.max(20, Math.floor(budget.maxRequests / Math.max(1, work.length)));
    let pending = work;
    for (let pass = 0; pending.length && !budget.exhausted; pass++) {
      const again: typeof work = [];
      for (const w of pending) {
        if (budget.exhausted) break;
        const r = await syncRef(ctx, w.repo, w.ref, pass === 0 ? budget.requests + share : Number.POSITIVE_INFINITY);
        latest.set(`${r.repoUuid}\n${r.ref}`, r);
        if (r.outcome === "in_progress") again.push(w);
        await options.heartbeat?.();
        if (!(await renewQuotaLease(db, quotaKey, owner, leaseSeconds))) throw new Error("bitbucket content sweep lease lost");
      }
      pending = again;
    }
    out.refs = [...latest.values()];
    if (budget.nearLimit) {
      const until = await recordRateLimited(db, quotaKey, {
        retryAfterMs: options.nearLimitCooldownMs ?? 5 * 60_000,
        status: 200,
        kind: "near_limit",
        reason: "Bitbucket reported X-RateLimit-NearLimit; pausing to leave budget for the issue/pull-request lanes",
        defaultBackoffMs: DEFAULT_RATE_BACKOFF_MS,
      });
      out.deferredUntil = until.toISOString();
    } else {
      await clearRateStreak(db, quotaKey);
    }
    return { ...out, requests: budget.requests };
  } catch (error) {
    out.refs = [...latest.values()];
    if (error instanceof BitbucketRateLimitedError) {
      const until = await recordRateLimited(db, quotaKey, { retryAfterMs: error.retryAfterMs, status: error.status, kind: error.kind, reason: error.message, defaultBackoffMs: DEFAULT_RATE_BACKOFF_MS });
      return { ...out, outcome: "deferred", requests: budget.requests, deferredUntil: until.toISOString(), error: error.message };
    }
    if (error instanceof BitbucketAuthError) return { ...out, outcome: "blocked", requests: budget.requests, error: error.message };
    return { ...out, outcome: "error", requests: budget.requests, error: message(error) };
  } finally {
    if (client.lastRate) await recordRateObservation(db, quotaKey, client.lastRate);
    await releaseQuotaLease(db, quotaKey, owner);
  }
}

// ------------------------------------------------------------------ repository

/**
 * Current repository metadata: by immutable UUIDs when known (follows renames and
 * transfers), else by the selected `workspace/slug`. A known repository that every grant of
 * this identity answers 404 for is tombstoned only after `notFoundConfirmations` consecutive
 * checks; a 403 means access was removed (files kept, coverage blocked).
 */
async function refreshRepo(ctx: Ctx, sel: SelectionRow, conns: readonly BitbucketConnectionRow[]): Promise<RepoRow | null> {
  const known = await findRepoBySelection(ctx.db, ctx.tenantId, sel.repo_key);
  const ordered = known ? [...conns].sort((a, b) => Number(b.connectionId === known.connection_id) - Number(a.connectionId === known.connection_id)) : conns;
  const statuses: number[] = [];
  for (const c of ordered) {
    let r: JsonResult | null = null;
    if (known?.workspace_uuid) {
      r = await ctx.client.getJson(c, repoUuidEndpoint(known.workspace_uuid, known.repo_uuid), undefined, [403, 404]);
    }
    if (!r || r.status !== 200) {
      const byName = await ctx.client.getJson(c, repoEndpoint(known?.full_name ?? sel.full_name), undefined, [403, 404]);
      if (byName.status === 200 && known && isRecord(byName.data) && str(byName.data.uuid) !== known.repo_uuid) {
        // The name now belongs to a different repository: the known one is gone from this name.
        statuses.push(r?.status ?? 404);
        continue;
      }
      r = byName;
    }
    statuses.push(r.status);
    if (r.status !== 200 || !isRecord(r.data)) continue;
    const raw = redact(r.data);
    const repoUuid = str(raw.uuid);
    const fullName = str(raw.full_name);
    const workspace = isRecord(raw.workspace) ? raw.workspace : null;
    if (!repoUuid || !isBitbucketUuid(repoUuid) || !fullName || !parseFullName(fullName)) {
      throw new BitbucketApiError(`repository response for ${sel.full_name} has no uuid/full_name`, r.status, "bad_repo");
    }
    const mainbranch = isRecord(raw.mainbranch) ? str(raw.mainbranch.name) : null;
    if (known && known.repo_uuid !== repoUuid) {
      await markOutOfScope(ctx.db, { tenantId: ctx.tenantId, repoUuid: known.repo_uuid }, `selection ${sel.full_name} now names a different repository; captured snapshots are kept`);
    }
    const previous = await getRepo(ctx.db, ctx.tenantId, repoUuid);
    await upsertRepo(ctx.db, {
      tenantId: ctx.tenantId,
      repoUuid,
      workspaceUuid: workspace && isBitbucketUuid(workspace.uuid) ? String(workspace.uuid) : null,
      connectionId: c.connectionId,
      providerConfigKey: c.providerConfigKey,
      quotaKey: c.quotaKey,
      fullName,
      selectedKey: sel.repo_key,
      mainBranch: mainbranch,
      isPrivate: typeof raw.is_private === "boolean" ? raw.is_private : null,
      raw,
    });
    if (previous?.status === "out_of_scope") {
      await setRepoStatus(ctx.db, { tenantId: ctx.tenantId, repoUuid }, "active", null);
      await setFilesRetired(ctx.db, { tenantId: ctx.tenantId, repoUuid }, null, "bitbucket_repo_out_of_scope");
    }
    return getRepo(ctx.db, ctx.tenantId, repoUuid);
  }
  if (!known) return null;
  const scope = { tenantId: ctx.tenantId, repoUuid: known.repo_uuid };
  if (statuses.length && statuses.every((s) => s === 404)) {
    const streak = await bumpNotFound(ctx.db, scope);
    if (streak >= ctx.notFoundConfirmations && known.status !== "not_found") {
      const reason = `Bitbucket answered 404 for the repository through every grant on ${streak} consecutive checks (deleted, or moved out of reach)`;
      await setRepoStatus(ctx.db, scope, "not_found", reason);
      for (const ref of await listRefs(ctx.db, ctx.tenantId, known.repo_uuid)) {
        if (ref.status === "retired") continue;
        await commitRefGone(ctx.db, { ...scope, ref: ref.ref_name }, "not_found", reason, "bitbucket_repository_not_found");
      }
    } else if (streak < ctx.notFoundConfirmations) {
      await setRepoStatus(ctx.db, scope, "inaccessible", `Bitbucket answered 404 (check ${streak} of ${ctx.notFoundConfirmations} before the files are tombstoned); captured files are kept`);
    }
  } else {
    await setRepoStatus(ctx.db, scope, "inaccessible", `Bitbucket answered HTTP ${statuses.join("/")} for the repository through every grant (access removed or OAuth scope missing); captured files are kept`);
  }
  return null;
}

/** Main branch plus configured extra branches; branches no longer configured are retired (hidden, history kept). */
async function configuredRefs(ctx: Ctx, repo: RepoRow, sel: SelectionRow): Promise<string[]> {
  const wanted = [...new Set([repo.main_branch, ...sel.extra_refs].filter((r): r is string => Boolean(r)))];
  for (const ref of await listRefs(ctx.db, ctx.tenantId, repo.repo_uuid)) {
    const scope = { tenantId: ctx.tenantId, repoUuid: repo.repo_uuid, ref: ref.ref_name };
    if (!wanted.includes(ref.ref_name) && ref.status !== "retired") {
      await setRefStatus(ctx.db, scope, "retired", "branch is no longer the main branch or a configured extra branch; captured snapshots are kept");
      await setFilesRetired(ctx.db, scope, "bitbucket_ref_retired", null);
    } else if (wanted.includes(ref.ref_name) && ref.status === "retired") {
      await setRefStatus(ctx.db, scope, "active", null);
      await setFilesRetired(ctx.db, scope, null, "bitbucket_ref_retired");
    }
  }
  return wanted;
}

// ------------------------------------------------------------------ branch scan

/** Advance one branch as far as the request cap allows. */
export async function syncRef(ctx: Ctx, repo: RepoRow, refName: string, requestCap = Number.POSITIVE_INFINITY): Promise<RefRunReport> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoUuid: repo.repo_uuid, ref: refName };
  const base = { repoUuid: repo.repo_uuid, repository: repo.full_name, ref: refName };
  const conn: BitbucketConnectionRef = { providerConfigKey: repo.provider_config_key, connectionId: repo.connection_id };
  const capped = (): boolean => ctx.budget.exhausted || ctx.budget.requests >= requestCap;
  try {
    let ref = await ensureRef(ctx.db, scope);
    await pruneStaleStaging(ctx.db, scope);
    const head = await resolveHead(ctx, conn, repo.full_name, refName);
    if (head.kind === "gone") {
      await recordHeadObservation(ctx.db, scope, null);
      const live = await listFiles(ctx.db, scope, { state: "live", limit: 1 });
      if (ref.status !== "not_found" || live.length) {
        const g = await commitRefGone(ctx.db, scope, "not_found", head.reason, "bitbucket_branch_deleted");
        return { ...base, outcome: "gone", generation: g, commitSha: null };
      }
      await recordRefSuccess(ctx.db, scope);
      return { ...base, outcome: "unchanged", generation: ref.committed_generation ?? undefined, commitSha: null };
    }
    await recordHeadObservation(ctx.db, scope, head.sha);
    if (ref.scan_generation !== null && head.sha !== ref.scan_commit_sha) {
      const started = toDate(ref.scan_started_at);
      if (started && Date.now() - started.getTime() > ctx.staleScanMs) {
        await abandonScan(ctx.db, scope, ref.scan_generation, `scan of ${ref.scan_commit_sha} ran longer than ${Math.round(ctx.staleScanMs / 60_000)} min while the branch moved to ${head.sha}; replaced`);
        ref = (await getRef(ctx.db, scope))!;
      }
    }
    if (ref.scan_generation === null) {
      const retry = needsRetry(ref);
      if (ref.committed_commit_sha === head.sha && ref.status === "active" && !retry) {
        await recordRefSuccess(ctx.db, scope);
        return { ...base, outcome: "unchanged", generation: ref.committed_generation ?? undefined, commitSha: head.sha, mode: ref.committed_mode };
      }
      if (capped()) return { ...base, outcome: "in_progress", commitSha: head.sha };
      const plan = scanPlan(ctx, ref, head.sha);
      const g = await beginScan(ctx.db, scope, { commitSha: head.sha, commitRaw: head.raw, mode: plan.mode, baseCommitSha: plan.base, reason: plan.reason });
      if (plan.mode === "diff") {
        // Files the committed scan could not fetch are fetched again at the new commit.
        const failed = await listFiles(ctx.db, scope, { state: "live", omitted: "fetch_failed" });
        await stagePuts(ctx.db, scope, g, failed.map((f) => ({ path: f.path, entryType: null, attributes: [], size: null, metaKnown: false })), ctx.maxFileBytes);
        if (plan.base === head.sha) {
          await setScanCursor(ctx.db, scope, g, null);
          await setScanPhase(ctx.db, scope, g, "files");
        }
      }
      ref = (await getRef(ctx.db, scope))!;
    }
    // A scan in progress runs to completion (even if the branch moved again meanwhile), so a busy
    // branch still commits real confirmed states; the next run scans the newer HEAD.
    const outcome = await advanceScan(ctx, conn, repo, ref, capped);
    if (outcome === null) return { ...base, outcome: "in_progress", generation: ref.scan_generation ?? undefined, commitSha: ref.scan_commit_sha, mode: ref.scan_mode };
    if (outcome.outcome === "superseded") return { ...base, outcome: "superseded", generation: outcome.generation, error: outcome.reason };
    const after = await getRef(ctx.db, scope);
    return { ...base, outcome: "committed", generation: outcome.generation, commitSha: after?.committed_commit_sha ?? null, mode: after?.committed_mode ?? null };
  } catch (error) {
    if (error instanceof Yield) return { ...base, outcome: "in_progress" };
    if (error instanceof BitbucketRateLimitedError || error instanceof BitbucketAuthError) throw error;
    await recordRefError(ctx.db, scope, message(error));
    // 403 without a rate-limit signal: the grant cannot read this repository's source.
    if (error instanceof BitbucketApiError && error.status === 403) await setRefStatus(ctx.db, scope, "blocked", message(error));
    return { ...base, outcome: "error", error: message(error) };
  }
}

/** Re-fetch files the committed scan lost to fetch failures (after an hour). */
function needsRetry(ref: RefRow): boolean {
  const failed = Number(ref.committed_counts?.fetch_failed ?? 0);
  if (!failed) return false;
  const at = toDate(ref.committed_at)?.getTime() ?? 0;
  return Date.now() - at > 3_600_000;
}

/**
 * Full listing for the first scan, after an incomplete listing, a branch that was gone, or a
 * periodic re-verification; otherwise a diff against the committed commit.
 */
function scanPlan(ctx: Ctx, ref: RefRow, head: string): { mode: "full" | "diff"; base: string | null; reason: string } {
  if (ref.committed_generation === null || !ref.committed_commit_sha) return { mode: "full", base: null, reason: ref.committed_generation === null ? "initial" : "branch_reappeared" };
  if (ref.status !== "active") return { mode: "full", base: null, reason: `status_${ref.status}` };
  if (Number(ref.committed_counts?.listing_complete ?? 0) !== 1) return { mode: "full", base: null, reason: "previous_listing_incomplete" };
  const lastFull = toDate(ref.last_full_at)?.getTime() ?? 0;
  if (ctx.fullRescanEveryMs > 0 && Date.now() - lastFull > ctx.fullRescanEveryMs) return { mode: "full", base: null, reason: "periodic_full_verification" };
  return { mode: "diff", base: ref.committed_commit_sha, reason: ref.committed_commit_sha === head ? "retry_omissions" : "head_moved" };
}

type Head = { kind: "sha"; sha: string; raw: Record<string, unknown> } | { kind: "gone"; reason: string };

async function resolveHead(ctx: Ctx, conn: BitbucketConnectionRef, fullName: string, ref: string): Promise<Head> {
  const r = await ctx.client.getJson(conn, branchEndpoint(fullName, ref), undefined, [404]);
  if (r.status === 404) return { kind: "gone", reason: `branch ${ref} does not exist (HTTP 404)` };
  const target = isRecord(r.data) && isRecord(r.data.target) ? r.data.target : null;
  const sha = target ? str(target.hash) : null;
  if (!target || !isCommitSha(sha)) throw new BitbucketApiError(`branch ${ref} resolved to no commit`, r.status, "bad_ref");
  return { kind: "sha", sha, raw: redact(target) };
}

/** Returns the commit outcome, or null when the scan must continue in a later run. */
async function advanceScan(ctx: Ctx, conn: BitbucketConnectionRef, repo: RepoRow, ref: RefRow, capped: () => boolean): Promise<CommitOutcome | null> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoUuid: repo.repo_uuid, ref: ref.ref_name };
  const g = ref.scan_generation!;
  for (let restarts = 0; restarts < 3; restarts++) {
    const current = (await getRef(ctx.db, scope))!;
    if (current.scan_generation !== g) return { outcome: "superseded", generation: g, reason: "scan was replaced while it ran" };
    if (current.scan_phase === "list") {
      if (current.scan_mode === "diff") {
        const r = await walkDiffstat(ctx, conn, repo, current, capped);
        if (r === "yield") return null;
        if (r !== "done") {
          await convertScanToFull(ctx.db, scope, g, r.fallback);
          continue;
        }
        const check = await checkDiffOrientation(ctx, conn, repo, current, capped);
        if (check === "yield") return null;
        if (check !== "ok") {
          await convertScanToFull(ctx.db, scope, g, check.fallback);
          continue;
        }
      } else {
        const done = await walkDirs(ctx, conn, repo, current, capped);
        if (!done) return null;
      }
      await setScanPhase(ctx.db, scope, g, "files");
    }
    const now = (await getRef(ctx.db, scope))!;
    if (now.scan_generation !== g) return { outcome: "superseded", generation: g, reason: "scan was replaced while it ran" };
    if (now.scan_phase === "files") {
      const r = await fetchFiles(ctx, conn, repo, now, capped);
      if (r === "yield") return null;
      if (r !== "done") {
        await convertScanToFull(ctx.db, scope, g, r.fallback);
        continue;
      }
      await setScanPhase(ctx.db, scope, g, "ready");
    }
    return commitScan(ctx.db, scope, g);
  }
  throw new BitbucketApiError("scan restarted too often", 0, "scan_restarts");
}

function normalizeAttributes(v: unknown): string[] {
  return [...new Set((Array.isArray(v) ? v : []).filter((a): a is string => typeof a === "string" && KNOWN_ATTRIBUTES.has(a)))].sort();
}

function entryTypeOf(type: unknown, attributes: readonly string[]): "file" | "link" | "submodule" | "directory" | null {
  if (attributes.includes("subrepository")) return "submodule";
  if (type === "commit_directory") return "directory";
  if (type === "commit_file") return attributes.includes("link") ? "link" : "file";
  return null;
}

/** A repository path Bitbucket returned under `dir` (no empty, `.` or `..` segments). */
function validChildPath(path: unknown, dir: string): path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.endsWith("/")) return false;
  if (dir && !path.startsWith(`${dir}/`)) return false;
  return path.split("/").every((s) => s.length > 0 && s !== "." && s !== "..");
}

function validRepoPath(path: unknown): path is string {
  return validChildPath(path, "");
}

function prefixOf(dir: string): string {
  return dir ? `${dir}/` : "";
}

/** Full listing; true when every directory of the generation is listed (or given up as truncated). */
async function walkDirs(ctx: Ctx, conn: BitbucketConnectionRef, repo: RepoRow, ref: RefRow, capped: () => boolean): Promise<boolean> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoUuid: repo.repo_uuid, ref: ref.ref_name };
  const g = ref.scan_generation!;
  const commit = ref.scan_commit_sha!;
  if (!(await anyDir(ctx.db, scope, g))) await enqueueDirs(ctx.db, scope, g, [""]);
  for (;;) {
    const batch = await nextDirs(ctx.db, scope, g, 20);
    if (!batch.length) return (await pendingDirCount(ctx.db, scope, g)) === 0;
    for (const d of batch) {
      if (capped()) return false;
      const endpoint = srcEndpoint(repo.full_name, commit, d.path, true);
      try {
        if (d.pages >= ctx.maxDirPages) {
          await addIncompletePrefix(ctx.db, scope, g, prefixOf(d.path));
          await finishDir(ctx.db, scope, g, d.path, "truncated", `more than ${ctx.maxDirPages} listing pages`);
          continue;
        }
        const page = d.next_url ? nextPage(d.next_url, endpoint) : { endpoint, params: { pagelen: String(PAGELEN) } };
        if (!page) throw new BitbucketApiError("stored listing checkpoint is unusable", 0, "bad_next");
        const r = await ctx.client.getJson(conn, page.endpoint, page.params, [404]);
        if (r.status === 404) {
          if (d.path === "") {
            await abandonScan(ctx.db, scope, g, `commit ${commit} has no listable root (HTTP 404)`);
            throw new BitbucketApiError(`commit ${commit} has no listable root (HTTP 404)`, 404, "commit_gone");
          }
          throw new BitbucketApiError(`directory ${d.path} is not listable at ${commit} (HTTP 404)`, 404, "dir_gone");
        }
        const data = isRecord(r.data) ? r.data : {};
        const values = Array.isArray(data.values) ? data.values.filter(isRecord) : [];
        const puts: StagedPut[] = [];
        const subdirs: string[] = [];
        for (const v of values) {
          if (!validChildPath(v.path, d.path)) throw new BitbucketApiError(`listing of ${d.path || "/"} returned an unexpected path`, r.status, "bad_listing");
          const attributes = normalizeAttributes(v.attributes);
          const type = entryTypeOf(v.type, attributes);
          if (type === "directory") subdirs.push(v.path);
          else if (type) puts.push({ path: v.path, entryType: type, attributes, size: typeof v.size === "number" ? v.size : null, metaKnown: true });
        }
        const next = nextPage(data.next, endpoint) ? String(data.next) : null;
        await stagePuts(ctx.db, scope, g, puts, ctx.maxFileBytes);
        await enqueueDirs(ctx.db, scope, g, subdirs);
        await advanceDir(ctx.db, scope, g, d.path, next);
      } catch (error) {
        if (isPassThrough(error)) throw error;
        if (error instanceof BitbucketApiError && error.code === "commit_gone") throw error;
        if (error instanceof BitbucketApiError && error.status === 403) throw error;
        const attempts = await retryDirLater(ctx.db, scope, g, d.path, message(error), Math.min(3_600_000, 30_000 * 2 ** d.attempts));
        if (attempts >= ctx.maxItemAttempts) {
          // Never delete what could not be listed: everything under this directory is kept as it was.
          await addIncompletePrefix(ctx.db, scope, g, prefixOf(d.path));
          await finishDir(ctx.db, scope, g, d.path, "truncated", message(error));
        }
      }
    }
  }
}

type DiffResult = "done" | "yield" | { fallback: string };

/** Diffstat page walk with a durable cursor; stages the named paths only. */
async function walkDiffstat(ctx: Ctx, conn: BitbucketConnectionRef, repo: RepoRow, ref: RefRow, capped: () => boolean): Promise<DiffResult> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoUuid: repo.repo_uuid, ref: ref.ref_name };
  const g = ref.scan_generation!;
  const head = ref.scan_commit_sha!;
  const baseSha = ref.scan_base_commit_sha!;
  const endpoint = diffstatEndpoint(repo.full_name, head, baseSha);
  for (;;) {
    const cur = (await getRef(ctx.db, scope))!;
    if (cur.scan_generation !== g) return "yield";
    if (cur.scan_pages > 0 && cur.scan_cursor === null) return "done";
    if (cur.scan_pages >= ctx.maxDiffPages) return { fallback: `diffstat longer than ${ctx.maxDiffPages} pages; listing the whole branch instead` };
    if (capped()) return "yield";
    const page = cur.scan_cursor ? nextPage(cur.scan_cursor, endpoint) : { endpoint, params: { pagelen: String(PAGELEN), topic: "false" } };
    if (!page) return { fallback: "stored diffstat checkpoint is unusable" };
    let r: JsonResult;
    try {
      r = await ctx.client.getJson(conn, page.endpoint, page.params, [400, 404, 409, 422, 555]);
    } catch (error) {
      if (isPassThrough(error)) throw error;
      if (error instanceof BitbucketApiError && error.status >= 500) return { fallback: `diffstat failed (${message(error)})` };
      throw error;
    }
    if (r.status !== 200) return { fallback: `diffstat ${baseSha.slice(0, 12)}..${head.slice(0, 12)} unavailable (HTTP ${r.status})` };
    const data = isRecord(r.data) ? r.data : {};
    const values = Array.isArray(data.values) ? data.values.filter(isRecord) : [];
    const puts: StagedPut[] = [];
    const deletes: Array<{ path: string; renamedTo: string | null }> = [];
    for (const v of values) {
      const status = str(v.status);
      const oldPath = isRecord(v.old) ? v.old.path : null;
      const newPath = isRecord(v.new) ? v.new.path : null;
      const orientation = linkOrientation(v, head, baseSha);
      if (orientation === "reversed") return { fallback: "diffstat links point the new side at the older commit" };
      if (status === "added" || status === "modified") {
        if (!validRepoPath(newPath)) return { fallback: `diffstat ${status} entry without a valid new path` };
        puts.push({ path: newPath, entryType: null, attributes: [], size: null, metaKnown: false });
      } else if (status === "removed") {
        if (!validRepoPath(oldPath)) return { fallback: "diffstat removed entry without a valid old path" };
        deletes.push({ path: oldPath, renamedTo: null });
      } else if (status === "renamed") {
        if (!validRepoPath(oldPath) || !validRepoPath(newPath)) return { fallback: "diffstat renamed entry without valid paths" };
        if (oldPath !== newPath) deletes.push({ path: oldPath, renamedTo: newPath });
        puts.push({ path: newPath, entryType: null, attributes: [], size: null, metaKnown: false, renamedFrom: oldPath !== newPath ? oldPath : null });
      } else {
        return { fallback: `diffstat status ${JSON.stringify(status)} is not a plain two-commit change` };
      }
    }
    let next: string | null = null;
    try {
      next = nextPage(data.next, endpoint) ? String(data.next) : null;
    } catch (error) {
      return { fallback: message(error) };
    }
    await stageDeletes(ctx.db, scope, g, deletes);
    await stagePuts(ctx.db, scope, g, puts, ctx.maxFileBytes);
    if (!(await setScanCursor(ctx.db, scope, g, next))) return "yield";
    if (!next) return "done";
  }
}

/** Evidence from `links.self.href` (`.../src/<commit>/<path>`) about which side is which. */
function linkOrientation(v: Record<string, unknown>, head: string, baseSha: string): "ok" | "reversed" | "unknown" {
  const href = (side: unknown): string | null => {
    if (!isRecord(side) || !isRecord(side.links) || !isRecord(side.links.self)) return null;
    return str(side.links.self.href);
  };
  const commitOf = (h: string | null): string | null => (h ? (/\/src\/([0-9a-f]{7,40})\//u.exec(h)?.[1] ?? null) : null);
  const n = commitOf(href(v.new));
  const o = commitOf(href(v.old));
  const isHead = (c: string | null) => c !== null && head.startsWith(c);
  const isBase = (c: string | null) => c !== null && baseSha.startsWith(c);
  if ((n && isBase(n) && !isHead(n)) || (o && isHead(o) && !isBase(o))) return "reversed";
  if (n || o) return "ok";
  return "unknown";
}

/**
 * Removals must really be gone at the new commit: one staged removal is looked up there. A
 * file that still exists means the diffstat was oriented the other way (or is otherwise
 * unusable) and the scan falls back to a full listing. Additions are verified for free by the
 * per-file format=meta lookups in fetchFiles.
 */
async function checkDiffOrientation(ctx: Ctx, conn: BitbucketConnectionRef, repo: RepoRow, ref: RefRow, capped: () => boolean): Promise<"ok" | "yield" | { fallback: string }> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoUuid: repo.repo_uuid, ref: ref.ref_name };
  const sample = (await stagedDeletePaths(ctx.db, scope, ref.scan_generation!, 1))[0];
  if (!sample) return "ok";
  if (capped()) return "yield";
  const r = await ctx.client.getJson(conn, srcEndpoint(repo.full_name, ref.scan_commit_sha!, sample, false), { format: "meta" }, [404]);
  if (r.status === 404) return "ok";
  return { fallback: `diffstat named ${sample} as removed but it exists at ${ref.scan_commit_sha}` };
}

type FetchResult = "done" | "yield" | { fallback: string };

/** Fetch every pending file body; "done" when none is pending. */
async function fetchFiles(ctx: Ctx, conn: BitbucketConnectionRef, repo: RepoRow, ref: RefRow, capped: () => boolean): Promise<FetchResult> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoUuid: repo.repo_uuid, ref: ref.ref_name };
  const g = ref.scan_generation!;
  const commit = ref.scan_commit_sha!;
  for (;;) {
    const batch = await nextPendingFetches(ctx.db, scope, g, 50);
    if (!batch.length) return (await pendingFetchCount(ctx.db, scope, g)) === 0 ? "done" : "yield";
    for (const f of batch) {
      if (capped()) return "yield";
      const endpoint = srcEndpoint(repo.full_name, commit, f.path, false);
      try {
        let attributes = f.attributes;
        let size = f.size;
        if (!f.meta_known) {
          const m = await ctx.client.getJson(conn, endpoint, { format: "meta" }, [404]);
          if (m.status === 404) {
            if (ref.scan_mode === "diff") return { fallback: `diffstat named ${f.path} but it does not exist at ${commit}` };
            throw new BitbucketApiError(`${f.path} is not present at ${commit} (HTTP 404)`, 404, "file_gone");
          }
          const meta = isRecord(m.data) ? m.data : {};
          attributes = normalizeAttributes(meta.attributes);
          const type = entryTypeOf(meta.type, attributes);
          if (type === "directory" || type === null) {
            if (ref.scan_mode === "diff") return { fallback: `diffstat named ${f.path} but it is a ${String(meta.type)} at ${commit}` };
            throw new BitbucketApiError(`${f.path} is not a file at ${commit}`, m.status, "not_a_file");
          }
          size = typeof meta.size === "number" ? meta.size : null;
          const omitted = await setEntryMeta(ctx.db, scope, g, f.path, { entryType: type, attributes, size }, ctx.maxFileBytes);
          if (omitted) continue;
        }
        if (capped()) return "yield";
        let r: BytesResult;
        try {
          r = await ctx.client.getBytes(conn, endpoint, ctx.maxFileBytes, [404]);
        } catch (error) {
          if (error instanceof BitbucketTooLargeError) {
            await markOmitted(ctx.db, scope, g, f.path, "too_large", error.message);
            continue;
          }
          throw error;
        }
        if (r.status !== 200 || !r.bytes) throw new BitbucketApiError(`${f.path} body is not available at ${commit} (HTTP ${r.status})`, r.status, "body_unavailable");
        // LFS-tracked files: Bitbucket's size and served body may describe the pointer or the object.
        if (size !== null && !attributes.includes("lfs") && r.bytes.length !== size) {
          throw new BitbucketApiError(`${f.path} body is ${r.bytes.length} bytes, Bitbucket listed ${size}`, r.status, "size_mismatch");
        }
        const blob = await storeBlob(ctx.db, ctx.tenantId, r.bytes, isTextContent(r.bytes));
        await markFetched(ctx.db, scope, g, f.path, blob.sha256, r.bytes.length);
      } catch (error) {
        if (isPassThrough(error)) throw error;
        if (error instanceof BitbucketApiError && error.status === 403) throw error;
        const attempts = await retryFetchLater(ctx.db, scope, g, f.path, message(error), Math.min(3_600_000, 30_000 * 2 ** f.attempts));
        if (attempts >= ctx.maxItemAttempts) await markOmitted(ctx.db, scope, g, f.path, "fetch_failed", message(error));
      }
    }
  }
}

// ------------------------------------------------------------------ task

export function bitbucketContentTaskHandlers(options: ContentSweepOptions = {}): Record<string, TaskHandler> {
  return {
    [BITBUCKET_CONTENT_TASK]: async (payload, ctx) => {
      const { db } = await import("../../../db/client.js");
      // Tenant comes from the server-written task row; a payload tenant must agree with it.
      const tenantId = ctx.task.tenantId;
      if (typeof payload.tenantId === "string" && payload.tenantId !== tenantId) throw new Error("bitbucket.content_sweep payload tenant does not match the task tenant");
      const report = await runBitbucketContentSweep(db as unknown as BitbucketDb, tenantId, { ...options, heartbeat: async () => ctx.heartbeat() });
      return report as unknown as Record<string, unknown>;
    },
  };
}
