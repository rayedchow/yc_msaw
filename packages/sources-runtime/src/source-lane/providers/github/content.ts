import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { enabledGithubRepos } from "../../../integrations/github/repo-sync.js";
import type { TaskHandler } from "../../../queue/queue.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import type { DbExecutor } from "../../core/types.js";
import {
  decodeBlobContent,
  DEFAULT_SECONDARY_BACKOFF_MS,
  gitBlobSha,
  GithubApiError,
  GithubAuthError,
  GithubClient,
  GithubRateLimitedError,
  isRecord,
  isTextContent,
  refPath,
  repoEndpoint,
  type GithubClientOptions,
  type GithubConnectionRef,
  type JsonResult,
  type RateLimitObservation,
} from "./api.js";
import {
  abandonScan,
  acquireQuotaLease,
  addIncompletePrefix,
  beginScan,
  clearRateStreak,
  commitRefGone,
  commitScan,
  enqueueScanTrees,
  ensureRef,
  findRepoByName,
  finishScanTree,
  getRef,
  getRepo,
  listRefs,
  listRepos,
  markBlobState,
  nextPendingBlobs,
  nextScanTrees,
  pendingBlobCount,
  pendingScanTrees,
  pruneStaleStaging,
  quotaBlockedUntil,
  recordConnection,
  recordHeadObservation,
  recordRateLimited,
  recordRateObservation,
  recordRefError,
  recordRefSuccess,
  releaseQuotaLease,
  renewQuotaLease,
  retryBlobLater,
  retryScanTree,
  rowsOf,
  setFilesRetired,
  setRefStatus,
  setRepoStatus,
  setScanPhase,
  stageEntries,
  storeBlob,
  upsertRepo,
  type CommitOutcome,
  type GithubDb,
  type RefRow,
  type RefScope,
  type RepoRow,
  type StagedEntry,
} from "./store.js";

/**
 * GitHub repository content sweep (task `github.content_sweep`, one schedule per tenant).
 *
 * For every repository the tenant SELECTED (donor github_repo_sync, opt-in) and per
 * configured ref (default branch + optional extra branches):
 *
 *   resolve   GET /repositories/<id> (rename-safe) and /git/ref/heads/<ref>; a HEAD
 *             equal to the committed commit is a successful no-change check.
 *   begin     GET /git/commits/<sha>, then take the next scan generation (monotonic,
 *             never from commit dates or SHAs; A->B->A is three generations).
 *   tree      GET /git/trees/<tree>?recursive=1; when GitHub reports `truncated`, the
 *             result is discarded and the tree is walked one non-recursive tree per
 *             request through a durable queue. A single directory too large to list
 *             is recorded as an incomplete prefix: nothing under it is ever deleted.
 *   blobs     GET /git/blobs/<sha> for every blob this tenant does not hold yet;
 *             strict base64 decode, git SHA-1 verified, stored as exact bytes.
 *   commit    one transaction; accepted only for the scan in progress and only when
 *             newer than the committed generation (late older scans are refused).
 *
 * Requests run one at a time per quota bucket (GitHub App installation, else the Nango
 * grant) under a lease shared by all workers and tenants. Rate limits (primary reset,
 * secondary Retry-After) and a reserve of the remaining budget stop the run and persist a
 * cooldown; nothing sleeps while holding a task and no checkpoint advances on a failure.
 */

export const GITHUB_CONTENT_TASK = "github.content_sweep";
export const GITHUB_PROVIDER = "github";

export interface ContentSweepOptions {
  client?: GithubClient;
  clientOptions?: Omit<GithubClientOptions, "onRequest" | "onRateLimit">;
  /** Upstream requests per quota bucket per run (default GITHUB_SOURCE_MAX_REQUESTS_PER_RUN or 400). */
  maxRequestsPerQuota?: number;
  maxMillisPerQuota?: number;
  /** Blobs larger than this are not captured (default GITHUB_SOURCE_MAX_BLOB_BYTES or 50 MiB). */
  maxBlobBytes?: number;
  /** Stop when the observed remaining budget falls to this (default max(200, 10% of the limit)): the donor issue/comment lanes share the bucket. */
  reserveRemaining?: number;
  maxItemAttempts?: number;
  leaseOwner?: string;
  leaseSeconds?: number;
  heartbeat?: () => Promise<void>;
}

export interface RefRunReport {
  repoId: string;
  repository: string;
  ref: string;
  outcome: "unchanged" | "committed" | "superseded" | "in_progress" | "gone" | "error";
  /** in_progress only: true when it stopped on the request cap with more work due now; false while retries back off. */
  yielded?: boolean;
  generation?: number;
  commitSha?: string | null;
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
  reserveHit: RateLimitObservation | null = null;
  readonly #deadline: number;
  constructor(
    readonly maxRequests: number,
    maxMillis: number,
  ) {
    this.#deadline = Date.now() + maxMillis;
  }
  get exhausted(): boolean {
    return this.reserveHit !== null || this.requests >= this.maxRequests || Date.now() >= this.#deadline;
  }
}

/** Raised when a ref must stop for budget; its durable state is already stored. */
class Yield extends Error {}

interface Ctx {
  db: GithubDb;
  tenantId: string;
  client: GithubClient;
  budget: Budget;
  maxBlobBytes: number;
  maxItemAttempts: number;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function redact(payload: Record<string, unknown>): Record<string, unknown> {
  return redactProviderPayload(GITHUB_PROVIDER, payload) as Record<string, unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ connections

export interface GithubConnectionRow extends GithubConnectionRef {
  status: string;
  installationId: string | null;
  quotaKey: string;
}

/**
 * The tenant's GitHub connections. The quota bucket is the GitHub App installation when the
 * connection metadata names it (rate limits are per installation), else the Nango connection
 * (one grant). No credential is read: Nango keeps the token.
 */
export async function githubConnections(db: DbExecutor, tenantId: string): Promise<GithubConnectionRow[]> {
  const rs = rowsOf<{ external_account_id: string | null; metadata: unknown; status: string }>(
    await db.execute(sql`
      SELECT external_account_id, metadata, status FROM connections
      WHERE tenant_id = ${tenantId} AND provider = ${GITHUB_PROVIDER}
      ORDER BY created_at, id
    `),
  );
  const out: GithubConnectionRow[] = [];
  for (const r of rs) {
    const meta = isRecord(r.metadata) ? r.metadata : typeof r.metadata === "string" ? (safeParse(r.metadata) ?? {}) : {};
    const connectionId = str(r.external_account_id) ?? str(meta.nangoConnectionId);
    if (!connectionId) continue;
    const providerConfigKey = str(meta.providerConfigKey) ?? GITHUB_PROVIDER;
    const installationId = installationIdOf(meta);
    out.push({ connectionId, providerConfigKey, status: r.status, installationId, quotaKey: quotaKeyFor(providerConfigKey, connectionId, installationId) });
  }
  return out;
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function installationIdOf(meta: Record<string, unknown>): string | null {
  const cc = isRecord(meta.connectionConfig) ? meta.connectionConfig : isRecord(meta.connection_config) ? meta.connection_config : null;
  const v = str(meta.installationId) ?? str(meta.installation_id) ?? str(meta.githubInstallationId) ?? (cc ? (str(cc.installation_id) ?? str(cc.installationId)) : null);
  return v && /^\d{1,20}$/u.test(v) ? v : null;
}

export function quotaKeyFor(providerConfigKey: string, connectionId: string, installationId: string | null): string {
  return installationId ? `github:installation:${installationId}` : `github:nango:${providerConfigKey}:${connectionId}`;
}

// ------------------------------------------------------------------ entry point

export async function runGithubContentSweep(db: GithubDb, tenantId: string, options: ContentSweepOptions = {}): Promise<ContentSweepReport> {
  const report: ContentSweepReport = { tenantId, connections: 0, selected: 0, quotas: [], notes: [] };
  const conns = (await githubConnections(db, tenantId)).filter((c) => c.status === "active");
  report.connections = conns.length;
  if (!conns.length) return report;
  const enabled = await enabledGithubRepos(db, tenantId);
  report.selected = enabled.length;
  await reconcileScope(db, tenantId, enabled);
  const owner = options.leaseOwner ?? `${hostname().slice(0, 60)}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const client = options.client ?? new GithubClient(options.clientOptions);

  // A known repository runs in the bucket of the connection that last read it (if still active).
  // An unknown one is offered to every bucket in connection order until one grant can read it
  // (a tenant may connect several installations, e.g. two organisations).
  const groups = new Map<string, { conns: GithubConnectionRow[]; known: string[] }>();
  for (const c of conns) {
    const g = groups.get(c.quotaKey) ?? { conns: [], known: [] };
    g.conns.push(c);
    groups.set(c.quotaKey, g);
  }
  const unresolved = new Set<string>();
  for (const name of enabled) {
    const known = await findRepoByName(db, tenantId, name);
    const conn = known ? conns.find((c) => c.connectionId === known.connection_id) : undefined;
    if (known && conn) groups.get(conn.quotaKey)!.known.push(name);
    else unresolved.add(name);
  }
  for (const [quotaKey, group] of groups) {
    report.quotas.push(await runQuota(db, tenantId, quotaKey, group.conns, group.known, unresolved, client, owner, options));
  }
  for (const name of unresolved) report.notes.push(`selected repository ${name} is not readable through any active GitHub connection (not installed, renamed away, or deleted)`);
  for (const conn of conns) {
    const used = report.quotas.find((q) => q.quotaKey === conn.quotaKey);
    const status = used?.outcome === "blocked" ? "blocked" : used?.outcome === "error" ? "error" : "ok";
    await recordConnection(db, { tenantId, connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey, installationId: conn.installationId, quotaKey: conn.quotaKey, status, reason: used?.error ?? null });
  }
  return report;
}

/**
 * Repositories whose selection is gone leave the current view (files retired, `_repo.json`
 * removed); snapshots and stored history are kept, exactly like the donor's scheduled
 * reconcile (out-of-scope tombstone, raw retained). Re-selecting brings them back.
 */
export async function reconcileScope(db: DbExecutor, tenantId: string, enabled: readonly string[]): Promise<{ outOfScope: string[] }> {
  const lower = new Set(enabled.map((n) => n.toLowerCase()));
  const outOfScope: string[] = [];
  for (const repo of await listRepos(db, tenantId)) {
    const inScope = lower.has(repo.selected_name.toLowerCase()) || lower.has(repo.full_name.toLowerCase());
    if (inScope || repo.status === "out_of_scope") continue;
    await markOutOfScope(db, { tenantId, repoId: repo.repo_id });
    outOfScope.push(repo.full_name);
  }
  return { outOfScope };
}

export async function markOutOfScope(db: DbExecutor, scope: { tenantId: string; repoId: string }): Promise<void> {
  await setRepoStatus(db, scope, "out_of_scope", "repository is no longer selected (github_repo_sync); captured snapshots are kept");
  await setFilesRetired(db, scope, "github_repo_out_of_scope", null);
}

async function runQuota(
  db: GithubDb,
  tenantId: string,
  quotaKey: string,
  conns: readonly GithubConnectionRow[],
  known: readonly string[],
  unresolved: Set<string>,
  baseClient: GithubClient,
  owner: string,
  options: ContentSweepOptions,
): Promise<QuotaRunReport> {
  const out: QuotaRunReport = { quotaKey, outcome: "ran", requests: 0, refs: [] };
  if (!known.length && !unresolved.size) return out;
  const blocked = await quotaBlockedUntil(db, quotaKey);
  if (blocked) return { ...out, outcome: "deferred", deferredUntil: blocked.until.toISOString() };
  const leaseSeconds = options.leaseSeconds ?? 600;
  if (!(await acquireQuotaLease(db, quotaKey, owner, leaseSeconds))) return { ...out, outcome: "lease_busy" };
  const budget = new Budget(options.maxRequestsPerQuota ?? envInt("GITHUB_SOURCE_MAX_REQUESTS_PER_RUN", 400), options.maxMillisPerQuota ?? 4 * 60_000);
  let lastRate: RateLimitObservation | null = null;
  const reserveOf = (rate: RateLimitObservation): number => options.reserveRemaining ?? Math.max(200, Math.floor((rate.limit ?? 0) * 0.1));
  const client = new Proxy(baseClient, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== "get" || typeof v !== "function") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return async (...args: unknown[]) => {
        if (budget.exhausted) throw new Yield();
        budget.requests += 1;
        const r = (await (v as (...a: unknown[]) => Promise<JsonResult>).apply(target, args)) as JsonResult;
        if (r.rate.remaining !== null || r.rate.limit !== null) lastRate = r.rate;
        if (r.rate.remaining !== null && r.rate.remaining <= reserveOf(r.rate)) budget.reserveHit = r.rate;
        return r;
      };
    },
  }) as GithubClient;
  const ctx: Ctx = {
    db,
    tenantId,
    client,
    budget,
    maxBlobBytes: options.maxBlobBytes ?? envInt("GITHUB_SOURCE_MAX_BLOB_BYTES", 50 * 1024 * 1024),
    maxItemAttempts: options.maxItemAttempts ?? 5,
  };
  const latest = new Map<string, RefRunReport>();
  try {
    const work: Array<{ repo: RepoRow; ref: string }> = [];
    for (const name of [...known, ...unresolved]) {
      if (budget.exhausted) break;
      try {
        const repo = await refreshRepo(ctx, name, conns, known.includes(name));
        if (!repo) continue;
        unresolved.delete(name);
        for (const ref of await configuredRefs(ctx, repo)) work.push({ repo, ref });
      } catch (error) {
        if (error instanceof Yield) break;
        if (error instanceof GithubRateLimitedError || error instanceof GithubAuthError) throw error;
        out.error = `repository ${name}: ${message(error)}`;
      }
    }
    // Fair share first (every ref progresses each run), then the rest of the budget in order.
    const share = Math.max(25, Math.floor(budget.maxRequests / Math.max(1, work.length)));
    let pending: Array<{ repo: RepoRow; ref: string; head?: Head }> = work;
    for (let pass = 0; pending.length && !budget.exhausted; pass++) {
      const again: typeof pending = [];
      for (const w of pending) {
        if (budget.exhausted) break;
        const { head, ...r } = await syncRef(ctx, w.repo, w.ref, pass === 0 ? budget.requests + share : Number.POSITIVE_INFINITY, w.head ?? null);
        latest.set(`${r.repoId}\n${r.ref}`, r);
        // Only refs stopped by the cap continue this run; refs waiting on a backoff are left for a later run.
        if (r.outcome === "in_progress" && r.yielded) again.push({ ...w, ...(head ? { head } : {}) });
        await options.heartbeat?.();
        if (!(await renewQuotaLease(db, quotaKey, owner, leaseSeconds))) throw new Error("github content sweep lease lost");
      }
      pending = again;
    }
    out.refs = [...latest.values()];
    if (budget.reserveHit) {
      const rate = budget.reserveHit as RateLimitObservation;
      const ms = rate.resetAt ? Math.max(1000, rate.resetAt.getTime() - Date.now()) : DEFAULT_SECONDARY_BACKOFF_MS;
      const until = await recordRateLimited(db, quotaKey, { retryAfterMs: ms, status: 200, kind: "reserve", reason: `remaining budget ${rate.remaining}/${rate.limit} reached the reserve kept for the issue/comment lanes; resumes at reset`, defaultBackoffMs: DEFAULT_SECONDARY_BACKOFF_MS });
      out.deferredUntil = until.toISOString();
    } else {
      await clearRateStreak(db, quotaKey);
    }
    return { ...out, requests: budget.requests };
  } catch (error) {
    out.refs = [...latest.values()];
    if (error instanceof GithubRateLimitedError) {
      const until = await recordRateLimited(db, quotaKey, { retryAfterMs: error.retryAfterMs, status: error.status, kind: error.kind, reason: error.message, defaultBackoffMs: DEFAULT_SECONDARY_BACKOFF_MS });
      return { ...out, outcome: "deferred", requests: budget.requests, deferredUntil: until.toISOString(), error: error.message };
    }
    if (error instanceof GithubAuthError) return { ...out, outcome: "blocked", requests: budget.requests, error: error.message };
    return { ...out, outcome: "error", requests: budget.requests, error: message(error) };
  } finally {
    if (lastRate) await recordRateObservation(db, quotaKey, lastRate);
    await releaseQuotaLease(db, quotaKey, owner);
  }
}

// ------------------------------------------------------------------ repository

/**
 * Current repository metadata, by immutable id when known (`/repositories/<id>` follows
 * renames and transfers), else by the selected name. A known repository the bucket's grants
 * can no longer see is `inaccessible` (captured files kept, never treated as deleted); an
 * unknown name is left for the next bucket.
 */
async function refreshRepo(ctx: Ctx, name: string, conns: readonly GithubConnectionRow[], isKnown: boolean): Promise<RepoRow | null> {
  const known = await findRepoByName(ctx.db, ctx.tenantId, name);
  const ordered = known ? [...conns].sort((a, b) => Number(b.connectionId === known.connection_id) - Number(a.connectionId === known.connection_id)) : conns;
  let lastStatus = 0;
  for (const c of ordered) {
    const r = known
      ? await ctx.client.get(c, `/repositories/${known.repo_id}`, undefined, [301, 302, 307, 403, 404])
      : await ctx.client.get(c, repoEndpoint(name), undefined, [301, 302, 307, 403, 404]);
    lastStatus = r.status;
    if (r.status !== 200 || !isRecord(r.data)) continue;
    const raw = redact(r.data);
    const repoId = str(raw.id);
    const fullName = str(raw.full_name);
    if (!repoId || !fullName || !/^\d+$/u.test(repoId)) throw new GithubApiError(`repository response for ${name} has no id/full_name`, r.status, "bad_repo");
    await upsertRepo(ctx.db, {
      tenantId: ctx.tenantId,
      repoId,
      connectionId: c.connectionId,
      providerConfigKey: c.providerConfigKey,
      quotaKey: c.quotaKey,
      fullName,
      selectedName: known?.selected_name ?? name,
      defaultBranch: str(raw.default_branch),
      private: typeof raw.private === "boolean" ? raw.private : null,
      visibility: str(raw.visibility),
      archived: typeof raw.archived === "boolean" ? raw.archived : null,
      raw,
    });
    if (known?.status === "out_of_scope") await setFilesRetired(ctx.db, { tenantId: ctx.tenantId, repoId }, null, "github_repo_out_of_scope");
    return getRepo(ctx.db, ctx.tenantId, repoId);
  }
  if (known && isKnown) {
    await setRepoStatus(ctx.db, { tenantId: ctx.tenantId, repoId: known.repo_id }, "inaccessible", `GitHub returned HTTP ${lastStatus} for the repository through every grant of its quota bucket (deleted, transferred out of the installation, or access removed); captured files are kept`);
  }
  return null;
}

/** Default branch plus configured extra branches; refs no longer configured are retired (hidden, history kept). */
async function configuredRefs(ctx: Ctx, repo: RepoRow): Promise<string[]> {
  const wanted = [...new Set([repo.default_branch, ...repo.extra_refs].filter((r): r is string => Boolean(r)))];
  for (const ref of await listRefs(ctx.db, ctx.tenantId, repo.repo_id)) {
    const scope = { tenantId: ctx.tenantId, repoId: repo.repo_id, ref: ref.ref_name };
    if (!wanted.includes(ref.ref_name) && ref.status !== "retired") {
      await setRefStatus(ctx.db, scope, "retired", "ref is no longer the default branch or a configured extra ref; captured snapshots are kept");
      await setFilesRetired(ctx.db, scope, "github_ref_retired", null);
    } else if (wanted.includes(ref.ref_name) && ref.status === "retired") {
      await setRefStatus(ctx.db, scope, "active", null);
      await setFilesRetired(ctx.db, scope, null, "github_ref_retired");
    }
  }
  return wanted;
}

// ------------------------------------------------------------------ ref scan

/** Advance one ref as far as the request cap allows. */
export async function syncRef(ctx: Ctx, repo: RepoRow, refName: string, requestCap = Number.POSITIVE_INFINITY, knownHead: Head | null = null): Promise<RefRunReport & { head?: Head }> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoId: repo.repo_id, ref: refName };
  const base = { repoId: repo.repo_id, repository: repo.full_name, ref: refName };
  const conn: GithubConnectionRef = { providerConfigKey: repo.provider_config_key, connectionId: repo.connection_id };
  const capped = (): boolean => ctx.budget.exhausted || ctx.budget.requests >= requestCap;
  let head: Head | null = knownHead;
  try {
    let ref = await ensureRef(ctx.db, scope);
    await pruneStaleStaging(ctx.db, scope);
    // HEAD is resolved once per ref per run; later passes of the same run reuse it.
    head ??= await resolveHead(ctx, conn, repo.full_name, refName);
    if (head.kind === "gone") {
      await recordHeadObservation(ctx.db, scope, null);
      if (ref.status !== head.status) {
        const g = await commitRefGone(ctx.db, scope, head.status, head.reason);
        return { ...base, outcome: "gone", generation: g, commitSha: null };
      }
      await recordRefSuccess(ctx.db, scope);
      return { ...base, outcome: "unchanged", generation: ref.committed_generation ?? undefined, commitSha: null };
    }
    await recordHeadObservation(ctx.db, scope, head.sha);
    if (ref.scan_generation === null) {
      if (ref.committed_commit_sha === head.sha && ref.status === "active" && !needsRetry(ref)) {
        await recordRefSuccess(ctx.db, scope);
        return { ...base, outcome: "unchanged", generation: ref.committed_generation ?? undefined, commitSha: head.sha };
      }
      if (capped()) return { ...base, outcome: "in_progress", yielded: true, commitSha: head.sha, head };
      const commit = await ctx.client.get(conn, repoEndpoint(repo.full_name, `/git/commits/${head.sha}`));
      if (!isRecord(commit.data)) throw new GithubApiError(`commit ${head.sha} response is not an object`, commit.status, "bad_commit");
      const treeSha = isRecord(commit.data.tree) ? str(commit.data.tree.sha) : null;
      if (!treeSha) throw new GithubApiError(`commit ${head.sha} has no tree`, commit.status, "bad_commit");
      const reason = ref.committed_generation === null ? "initial" : ref.committed_commit_sha === head.sha ? "retry_omissions" : "head_moved";
      await beginScan(ctx.db, scope, { commitSha: head.sha, treeSha, commitRaw: redact(commit.data), reason });
      ref = (await getRef(ctx.db, scope))!;
    }
    // A scan in progress always runs to completion (even if HEAD moved again meanwhile), so a busy
    // branch still commits real confirmed states; the next run scans the newer HEAD.
    const outcome = await advanceScan(ctx, conn, repo, ref, capped);
    if (outcome === "yield" || outcome === "wait") return { ...base, outcome: "in_progress", yielded: outcome === "yield", generation: ref.scan_generation ?? undefined, commitSha: ref.scan_commit_sha, head };
    if (outcome.outcome === "superseded") return { ...base, outcome: "superseded", generation: outcome.generation, error: outcome.reason };
    return { ...base, outcome: "committed", generation: outcome.generation, commitSha: ref.scan_commit_sha };
  } catch (error) {
    if (error instanceof Yield) return { ...base, outcome: "in_progress", yielded: true, ...(head ? { head } : {}) };
    if (error instanceof GithubRateLimitedError || error instanceof GithubAuthError) throw error;
    await recordRefError(ctx.db, scope, message(error));
    // 403 without a rate-limit signal: the grant lacks a permission (e.g. the App has no Contents: read).
    if (error instanceof GithubApiError && error.status === 403) await setRefStatus(ctx.db, scope, "blocked", message(error));
    return { ...base, outcome: "error", error: message(error) };
  }
}

/** Re-scan the same commit when the committed snapshot lost blobs to fetch failures (after an hour). */
function needsRetry(ref: RefRow): boolean {
  const failed = Number(ref.committed_counts?.fetch_failed ?? 0);
  if (!failed) return false;
  const at = ref.committed_at ? new Date(String(ref.committed_at)).getTime() : 0;
  return Date.now() - at > 60 * 60_000;
}

type Head = { kind: "sha"; sha: string } | { kind: "gone"; status: "not_found" | "empty"; reason: string };

async function resolveHead(ctx: Ctx, conn: GithubConnectionRef, fullName: string, ref: string): Promise<Head> {
  const r = await ctx.client.get(conn, repoEndpoint(fullName, `/git/ref/heads/${refPath(ref)}`), undefined, [404, 409]);
  if (r.status === 409) return { kind: "gone", status: "empty", reason: "GitHub reports the repository is empty (HTTP 409)" };
  if (r.status === 404) return { kind: "gone", status: "not_found", reason: `branch ${ref} does not exist (HTTP 404)` };
  const obj = isRecord(r.data) && isRecord(r.data.object) ? r.data.object : null;
  const sha = obj ? str(obj.sha) : null;
  if (!sha || !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(sha)) throw new GithubApiError(`ref ${ref} resolved to no commit`, r.status, "bad_ref");
  if (obj && obj.type !== undefined && obj.type !== "commit") throw new GithubApiError(`ref ${ref} points at a ${String(obj.type)}, not a commit`, r.status, "bad_ref");
  return { kind: "sha", sha };
}

type Step = "done" | "yield" | "wait";

/**
 * Returns the commit outcome, "yield" when the request cap stopped it with work due now, or
 * "wait" when only backed-off retries remain (continued by a later run, never spun on).
 */
async function advanceScan(ctx: Ctx, conn: GithubConnectionRef, repo: RepoRow, ref: RefRow, capped: () => boolean): Promise<CommitOutcome | "yield" | "wait"> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoId: repo.repo_id, ref: ref.ref_name };
  const g = ref.scan_generation!;
  if (ref.scan_phase === "tree") {
    const step = await scanTree(ctx, conn, repo, ref, capped);
    if (step !== "done") return step;
    await setScanPhase(ctx.db, scope, g, "blobs");
  }
  const current = (await getRef(ctx.db, scope))!;
  if (current.scan_generation !== g) return { outcome: "superseded", generation: g, reason: "scan was replaced while it ran" };
  if (current.scan_phase === "blobs") {
    const step = await fetchBlobs(ctx, conn, repo, scope, g, capped);
    if (step !== "done") return step;
    await setScanPhase(ctx.db, scope, g, "ready");
  }
  return commitScan(ctx.db, scope, g);
}

/** Tree listing of the generation. */
async function scanTree(ctx: Ctx, conn: GithubConnectionRef, repo: RepoRow, ref: RefRow, capped: () => boolean): Promise<Step> {
  const scope: RefScope = { tenantId: ctx.tenantId, repoId: repo.repo_id, ref: ref.ref_name };
  const g = ref.scan_generation!;
  const treeSha = ref.scan_tree_sha!;
  const anyTree = rowsOf(await ctx.db.execute(sql`SELECT 1 FROM github_source_scan_trees WHERE tenant_id = ${ctx.tenantId} AND repo_id = ${repo.repo_id} AND ref_name = ${ref.ref_name} AND generation = ${g} LIMIT 1`)).length > 0;
  if (!anyTree) {
    if (capped()) return "yield";
    const r = await ctx.client.get(conn, repoEndpoint(repo.full_name, `/git/trees/${treeSha}`), { recursive: 1 }, [404, 409, 422]);
    if (r.status !== 200) {
      await abandonScan(ctx.db, scope, g, `tree ${treeSha} is not available (HTTP ${r.status})`);
      throw new GithubApiError(`tree ${treeSha} is not available (HTTP ${r.status})`, r.status, "tree_gone");
    }
    const data = isRecord(r.data) ? r.data : {};
    if (data.truncated === true) {
      // Too large for one recursive listing: walk it one tree at a time instead (durable queue).
      await enqueueScanTrees(ctx.db, scope, g, [{ prefix: "", sha: treeSha }]);
    } else {
      await stageEntries(ctx.db, scope, g, entriesOf(data.tree, ""), ctx.maxBlobBytes);
      await enqueueScanTrees(ctx.db, scope, g, [{ prefix: "", sha: treeSha }]);
      await finishScanTree(ctx.db, scope, g, "", "done");
      return "done";
    }
  }
  for (;;) {
    const batch = await nextScanTrees(ctx.db, scope, g, 20);
    if (!batch.length) return (await pendingScanTrees(ctx.db, scope, g)) === 0 ? "done" : "wait";
    for (const t of batch) {
      if (capped()) return "yield";
      try {
        const r = await ctx.client.get(conn, repoEndpoint(repo.full_name, `/git/trees/${t.tree_sha}`), undefined, [404, 409, 422]);
        if (r.status !== 200) throw new GithubApiError(`tree ${t.tree_sha} is not available (HTTP ${r.status})`, r.status, "tree_gone");
        const data = isRecord(r.data) ? r.data : {};
        const items = Array.isArray(data.tree) ? data.tree.filter(isRecord) : [];
        await stageEntries(ctx.db, scope, g, entriesOf(items, t.prefix), ctx.maxBlobBytes);
        const subtrees = items.filter((i) => i.type === "tree" && typeof i.path === "string" && typeof i.sha === "string").map((i) => ({ prefix: `${t.prefix}${String(i.path)}/`, sha: String(i.sha) }));
        await enqueueScanTrees(ctx.db, scope, g, subtrees);
        if (data.truncated === true) {
          // One directory GitHub cannot list completely: keep everything under it, never delete there.
          await addIncompletePrefix(ctx.db, scope, g, t.prefix);
          await finishScanTree(ctx.db, scope, g, t.prefix, "truncated");
        } else {
          await finishScanTree(ctx.db, scope, g, t.prefix, "done");
        }
      } catch (error) {
        if (error instanceof Yield || error instanceof GithubRateLimitedError || error instanceof GithubAuthError) throw error;
        const attempts = await retryScanTree(ctx.db, scope, g, t.prefix, message(error), Math.min(3600_000, 60_000 * 2 ** t.attempts));
        if (attempts >= ctx.maxItemAttempts) {
          await addIncompletePrefix(ctx.db, scope, g, t.prefix);
          await finishScanTree(ctx.db, scope, g, t.prefix, "truncated");
        }
      }
    }
  }
}

function entriesOf(tree: unknown, prefix: string): StagedEntry[] {
  const out: StagedEntry[] = [];
  for (const e of Array.isArray(tree) ? tree.filter(isRecord) : []) {
    const path = typeof e.path === "string" ? e.path : null;
    const sha = str(e.sha);
    const mode = str(e.mode);
    if (!path || !sha || !mode) continue;
    if (e.type === "blob") out.push({ path: `${prefix}${path}`, mode, type: "blob", sha, size: typeof e.size === "number" ? e.size : null });
    else if (e.type === "commit") out.push({ path: `${prefix}${path}`, mode, type: "commit", sha, size: null });
  }
  return out;
}

/** Fetch every pending blob of the generation. */
async function fetchBlobs(ctx: Ctx, conn: GithubConnectionRef, repo: RepoRow, scope: RefScope, g: number, capped: () => boolean): Promise<Step> {
  for (;;) {
    const batch = await nextPendingBlobs(ctx.db, scope, g, 50);
    if (!batch.length) return (await pendingBlobCount(ctx.db, scope, g)) === 0 ? "done" : "wait";
    for (const b of batch) {
      if (capped()) return "yield";
      try {
        const r = await ctx.client.get(conn, repoEndpoint(repo.full_name, `/git/blobs/${b.blob_sha}`), undefined, [404, 409, 422]);
        if (r.status !== 200) throw new GithubApiError(`blob ${b.blob_sha} is not available (HTTP ${r.status})`, r.status, "blob_unavailable");
        const declared = isRecord(r.data) && typeof r.data.size === "number" ? r.data.size : null;
        if (declared !== null && declared > ctx.maxBlobBytes) {
          await markBlobState(ctx.db, scope, g, b.blob_sha, "omitted", "too_large");
          continue;
        }
        const bytes = decodeBlobContent(r.data);
        const actual = gitBlobSha(bytes);
        if (actual !== b.blob_sha) throw new GithubApiError(`blob ${b.blob_sha} bytes hash to ${actual}`, r.status, "blob_sha_mismatch");
        await storeBlob(ctx.db, ctx.tenantId, b.blob_sha, bytes, isTextContent(bytes));
        await markBlobState(ctx.db, scope, g, b.blob_sha, "stored");
      } catch (error) {
        if (error instanceof Yield || error instanceof GithubRateLimitedError || error instanceof GithubAuthError) throw error;
        const attempts = await retryBlobLater(ctx.db, scope, g, b.blob_sha, message(error), Math.min(3600_000, 30_000 * 2 ** b.attempts));
        if (attempts >= ctx.maxItemAttempts) await markBlobState(ctx.db, scope, g, b.blob_sha, "omitted", "fetch_failed", message(error));
      }
    }
  }
}

// ------------------------------------------------------------------ task

export function githubContentTaskHandlers(options: ContentSweepOptions = {}): Record<string, TaskHandler> {
  return {
    [GITHUB_CONTENT_TASK]: async (payload, ctx) => {
      const { db } = await import("../../../db/client.js");
      // Tenant comes from the server-written task row; a payload tenant must agree with it.
      const tenantId = ctx.task.tenantId;
      if (typeof payload.tenantId === "string" && payload.tenantId !== tenantId) throw new Error("github.content_sweep payload tenant does not match the task tenant");
      const report = await runGithubContentSweep(db as unknown as GithubDb, tenantId, { ...options, heartbeat: async () => ctx.heartbeat() });
      return report as unknown as Record<string, unknown>;
    },
  };
}
