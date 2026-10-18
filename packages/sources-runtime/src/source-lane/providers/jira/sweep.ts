import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import type { JiraDeepLaneDonorTarget } from "../../../integrations/nango/proxy-details.js";
import type { TaskHandler } from "../../../queue/queue.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import type { DbExecutor } from "../../core/types.js";
import {
  AttachmentTooLargeError,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  isRecord,
  JiraApiError,
  JiraAuthError,
  JiraClient,
  JiraRateLimitedError,
  type JiraClientOptions,
  type JiraTarget,
  type JsonResult,
  type Params,
} from "./api.js";
import { objectRowKey, quotaKeyFor } from "./identity.js";
import {
  acquireQuotaLease,
  bumpChildrenEpoch,
  bumpGenerationCounter,
  changelogCount,
  ChunkWriter,
  checkpointWork,
  clearRateStreak,
  enqueueWork,
  ensureSyncState,
  findObject,
  finishWork,
  getSelection,
  getSyncState,
  insertChangelog,
  insertObservation,
  listObjects,
  listSites,
  markInaccessible,
  markOtherConnectionsRemoved,
  markSitesRemoved,
  nextWork,
  pendingScanItems,
  projectSelected,
  quotaBlockedUntil,
  recordDiscovery,
  recordRateLimited,
  recordRunOutcome,
  releaseQuotaLease,
  renewQuotaLease,
  restoreDependents,
  retryWorkLater,
  rowsOf,
  selectionSha,
  setDeltaWatermark,
  setGenerationPhase,
  setObjectFields,
  setSiteStatus,
  startGeneration,
  syncSiteSelection,
  tombstoneDependents,
  tombstoneObject,
  touchDependents,
  upsertObject,
  upsertSite,
  workState,
  type ObjectRow,
  type Selection,
  type SiteScope,
  type WorkItem,
  type WorkRow,
} from "./store.js";

/**
 * Jira deep sweep (task `jira.sweep`, one schedule per tenant).
 *
 * Per active Nango Jira connection of the tenant (the tenant's own
 * `connections` row; nothing is read from a global key): discover the
 * Atlassian sites the grant reaches (accessible-resources, with scopes), then
 * per site run a bounded slice of a durable work queue (drizzle/9250):
 *
 *   full pass (generation G, every fullScanIntervalMs, or when the project
 *   selection changed):
 *     projects (offset-paged project/search, live + archived; trashed projects
 *     tombstone) -> per SELECTED project a bounded JQL listing
 *     `project = <id> ORDER BY created ASC` with `fields=*all&expand=changelog`
 *     (nextPageToken checkpointed) -> per issue: the full payload, every
 *     changelog history (search embeds a subset; `/issue/{id}/changelog` is
 *     paged whenever the stored count is short of `total`), every comment
 *     (inline when the search returned all of them, else `/issue/{id}/comment`
 *     paged), attachment metadata and exact bytes.
 *     When every scan item finished, issues not seen in G whose project
 *     listing COMPLETED are confirmed one by one; comments/attachments missing
 *     from a complete per-issue set are confirmed too.
 *   delta (every run): `updated >= "-Nm"` relative JQL (timezone independent)
 *     from the stored watermark plus an overlap, restricted to the selected
 *     projects, ascending; the watermark advances to the window start only when
 *     the search is paged to exhaustion, so a missed webhook, crash or rate
 *     limit can never skip an update.
 *
 * Deletion vs. lost access: Jira answers 404 both for a deleted issue and for
 * one the grant may no longer browse. A 404 is a deletion only when the grant
 * still has BROWSE_PROJECTS on the issue's project and the issue carried no
 * security level (comment: no visibility restriction); otherwise the object is
 * kept and marked inaccessible. 403 is always inaccessible.
 *
 * 429/503 stop the run and persist the Retry-After cooldown on the Atlassian
 * bucket (OAuth app x site), shared by all tenants and workers; nothing sleeps
 * while holding a task. Every listing checkpoints its cursor after storing a
 * page, so a crash, lease loss or rate limit resumes exactly there.
 */

export const JIRA_SWEEP_TASK = "jira.sweep";
export const JIRA_PROVIDER = "jira";

export const PRIORITY = {
  delta: 5,
  projects: 10,
  refresh: 15,
  issues: 20,
  comments: 30,
  changelog: 40,
  download: 70,
  confirm: 80,
} as const;

export interface SweepOptions {
  client?: JiraClient;
  clientOptions?: JiraClientOptions;
  /** Upstream requests per site per run (default JIRA_SOURCE_MAX_REQUESTS_PER_RUN or 300). */
  maxRequestsPerSite?: number;
  maxMillisPerSite?: number;
  fullScanIntervalMs?: number;
  deltaIntervalMs?: number;
  deltaOverlapMs?: number;
  siteRefreshMs?: number;
  maxAttachmentBytes?: number;
  maxItemAttempts?: number;
  searchPageSize?: number;
  commentPageSize?: number;
  changelogPageSize?: number;
  projectPageSize?: number;
  leaseOwner?: string;
  leaseSeconds?: number;
  heartbeat?: () => Promise<void>;
}

export interface SiteRunReport {
  connectionId: string;
  cloudId: string;
  outcome: "ran" | "deferred" | "lease_busy" | "blocked" | "error";
  requests: number;
  items: number;
  generation?: number;
  phase?: string;
  deferredUntil?: string;
  error?: string;
}

export interface SweepReport {
  tenantId: string;
  connections: number;
  sites: SiteRunReport[];
  notes: string[];
}

interface Opts {
  maxAttachmentBytes: number;
  maxItemAttempts: number;
  deltaOverlapMs: number;
  searchPageSize: number;
  commentPageSize: number;
  changelogPageSize: number;
  projectPageSize: number;
}

interface Ctx {
  db: DbExecutor;
  scope: SiteScope;
  target: JiraTarget;
  client: JiraClient;
  budget: Budget;
  opts: Opts;
  generation: number;
  selection: Selection;
  /**
   * SOURCE-LANE PATCH (jira-efficiency): set on the tenant's first active connection, the one whose sites the
   * donor `nango.proxy_details` lane covers. Every issue/comment payload fetched here is also written as that
   * lane's issue_detail / issue_comment rows and mirror, so the donor lane no longer pages the same projects.
   */
  donor: JiraDeepLaneDonorTarget | null;
}

type DonorFeed = typeof import("../../../integrations/nango/proxy-details.js");
// Loaded on first use: the donor capture pulls in the mirror materializer (and its db client).
let donorFeedModule: Promise<DonorFeed> | null = null;
function donorFeed(): Promise<DonorFeed> {
  donorFeedModule ??= import("../../../integrations/nango/proxy-details.js");
  return donorFeedModule;
}

class Budget {
  requests = 0;
  readonly #deadline: number;
  constructor(
    readonly maxRequests: number,
    maxMillis: number,
  ) {
    this.#deadline = Date.now() + maxMillis;
  }
  count(): void {
    this.requests += 1;
  }
  get exhausted(): boolean {
    return this.requests >= this.maxRequests || Date.now() >= this.#deadline;
  }
}

/** Thrown when a listing must stop for budget; its checkpoint is already stored. */
class Yield extends Error {}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function rec(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

/** Donor capture-time redaction (src/vault/redaction.ts, Atlassian rules) before anything is persisted. */
export function redact(payload: Record<string, unknown>): Record<string, unknown> {
  return redactProviderPayload(JIRA_PROVIDER, payload) as Record<string, unknown>;
}

const enc = encodeURIComponent;

// ------------------------------------------------------------------ connections / entry point

export interface JiraConnectionRow {
  connectionId: string;
  providerConfigKey: string;
  status: string;
}

/** The tenant's Jira connection rows (server-written by the donor connect/reconcile flow). */
export async function jiraConnections(db: DbExecutor, tenantId: string): Promise<JiraConnectionRow[]> {
  const rs = rowsOf<{ external_account_id: string | null; nango_connection_id: string | null; provider_config_key: string | null; status: string }>(
    await db.execute(sql`
      SELECT external_account_id, metadata->>'nangoConnectionId' AS nango_connection_id, metadata->>'providerConfigKey' AS provider_config_key, status
      FROM connections WHERE tenant_id = ${tenantId} AND provider = ${JIRA_PROVIDER}
      ORDER BY created_at, id
    `),
  );
  const out: JiraConnectionRow[] = [];
  for (const r of rs) {
    const connectionId = str(r.external_account_id) ?? str(r.nango_connection_id);
    if (!connectionId) continue;
    out.push({ connectionId, providerConfigKey: str(r.provider_config_key) ?? JIRA_PROVIDER, status: r.status });
  }
  return out;
}

export async function runJiraSweep(db: DbExecutor, tenantId: string, options: SweepOptions = {}): Promise<SweepReport> {
  const report: SweepReport = { tenantId, connections: 0, sites: [], notes: [] };
  const all = await jiraConnections(db, tenantId);
  // Sites captured through a connection id the tenant no longer has (reconnect = new Nango id): kept, labelled removed.
  await markOtherConnectionsRemoved(db, tenantId, all.map((c) => c.connectionId), "captured through a Jira connection this tenant no longer has (reconnected or removed); content is kept as last captured");
  const conns = all.filter((c) => c.status === "active");
  report.connections = conns.length;
  if (!conns.length) return report;
  const owner = options.leaseOwner ?? `${hostname().slice(0, 60)}:${process.pid}:${randomBytes(4).toString("hex")}`;
  for (const conn of conns) {
    const donorConnection = conn === conns[0];
    const discoveryClient = options.client ?? new JiraClient(options.clientOptions);
    try {
      const found = await refreshSites(db, discoveryClient, tenantId, conn, options.siteRefreshMs ?? 60 * 60_000);
      if (found !== null) await recordDiscovery(db, tenantId, conn.connectionId, found > 0 ? "ok" : "blocked", found > 0 ? null : "accessible-resources returned no site with a Jira scope for this grant", found);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof JiraAuthError) {
        for (const s of await listSites(db, tenantId, conn.connectionId)) {
          await setSiteStatus(db, { tenantId, connectionId: conn.connectionId, cloudId: s.cloud_id }, "blocked", message);
        }
        await recordDiscovery(db, tenantId, conn.connectionId, "blocked", message, 0);
        report.notes.push(`connection ${conn.connectionId}: ${message}`);
        report.sites.push({ connectionId: conn.connectionId, cloudId: "", outcome: "blocked", requests: 0, items: 0, error: message });
        continue;
      }
      // Rate limit / transient failure on discovery: keep using the known sites this run.
      await recordDiscovery(db, tenantId, conn.connectionId, "error", message, (await listSites(db, tenantId, conn.connectionId)).length);
      report.notes.push(`connection ${conn.connectionId}: site discovery failed: ${message}`);
    }
    for (const site of await listSites(db, tenantId, conn.connectionId)) {
      if (site.status !== "active") continue;
      const donor = donorConnection ? { tenantId, providerConfigKey: conn.providerConfigKey, connectionId: conn.connectionId, cloudId: site.cloud_id, siteUrl: str(site.site_url) } : null;
      report.sites.push(await runSite(db, { tenantId, connectionId: conn.connectionId, cloudId: site.cloud_id }, conn, owner, options, donor));
    }
  }
  return report;
}

/**
 * Atlassian sites whose granted scopes include Jira; removed sites keep their content
 * (lost access is not deletion). Returns the number of Jira sites, or null when the
 * known sites were fresh enough and no request was made.
 */
export async function refreshSites(db: DbExecutor, client: JiraClient, tenantId: string, conn: JiraConnectionRow, refreshMs: number): Promise<number | null> {
  const existing = await listSites(db, tenantId, conn.connectionId);
  const fresh = existing.length > 0 && existing.every((s) => s.status === "active" && Date.now() - new Date(String(s.last_seen_at)).getTime() < refreshMs);
  if (fresh) return null;
  const resources = await client.accessibleResources(conn);
  const keep: string[] = [];
  for (const r of resources) {
    const cloudId = str(r.id);
    if (!cloudId) continue;
    const scopes = Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [];
    if (scopes.length && !scopes.some((s) => s.includes("jira"))) continue;
    keep.push(cloudId);
    await upsertSite(db, { tenantId, connectionId: conn.connectionId, cloudId, providerConfigKey: conn.providerConfigKey, siteUrl: str(r.url), siteName: str(r.name), scopes, status: "active" });
  }
  await syncSiteSelection(db, tenantId, conn.connectionId);
  await markSitesRemoved(db, tenantId, conn.connectionId, keep, "site not returned by accessible-resources for this grant (access removed or app uninstalled); captured content is kept");
  return keep.length;
}

async function runSite(db: DbExecutor, scope: SiteScope, conn: JiraConnectionRow, owner: string, options: SweepOptions, donor: JiraDeepLaneDonorTarget | null = null): Promise<SiteRunReport> {
  const quotaKey = quotaKeyFor(conn.providerConfigKey, scope.cloudId);
  const base: SiteRunReport = { connectionId: scope.connectionId, cloudId: scope.cloudId, outcome: "ran", requests: 0, items: 0 };
  await ensureSyncState(db, { ...scope, providerConfigKey: conn.providerConfigKey, quotaKey });
  const blocked = await quotaBlockedUntil(db, quotaKey);
  if (blocked) return { ...base, outcome: "deferred", deferredUntil: blocked.toISOString() };
  const leaseSeconds = options.leaseSeconds ?? 600;
  if (!(await acquireQuotaLease(db, quotaKey, owner, leaseSeconds))) return { ...base, outcome: "lease_busy" };
  const budget = new Budget(options.maxRequestsPerSite ?? envInt("JIRA_SOURCE_MAX_REQUESTS_PER_RUN", 300), options.maxMillisPerSite ?? 4 * 60_000);
  const client = options.client ?? new JiraClient(options.clientOptions);
  const counted = new Proxy(client, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "get" || prop === "download") {
        return (...args: unknown[]) => {
          budget.count();
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
  const target: JiraTarget = { providerConfigKey: conn.providerConfigKey, connectionId: scope.connectionId, cloudId: scope.cloudId };
  let items = 0;
  try {
    const selection = await getSelection(db, scope);
    const selSha = selectionSha(selection);
    let state = (await getSyncState(db, scope))!;
    const fullEvery = options.fullScanIntervalMs ?? envInt("JIRA_SOURCE_FULL_SCAN_INTERVAL_MS", 12 * 60 * 60_000);
    const opts: Opts = {
      maxAttachmentBytes: options.maxAttachmentBytes ?? envInt("JIRA_SOURCE_MAX_ATTACHMENT_BYTES", 256 * 1024 * 1024),
      maxItemAttempts: options.maxItemAttempts ?? 5,
      deltaOverlapMs: options.deltaOverlapMs ?? 10 * 60_000,
      searchPageSize: options.searchPageSize ?? 50,
      commentPageSize: options.commentPageSize ?? 100,
      changelogPageSize: options.changelogPageSize ?? 100,
      projectPageSize: options.projectPageSize ?? 50,
    };
    const ctx: Ctx = { db, scope, target, client: counted, budget, opts, generation: state.generation, selection, donor };
    if (state.generation === 0) {
      await beginGeneration(ctx, "initial", selSha);
    } else if (state.selection_sha !== selSha) {
      await beginGeneration(ctx, "selection_changed", selSha);
    } else if (state.generation_phase === "closed" && Date.now() - new Date(String(state.generation_started_at)).getTime() >= fullEvery) {
      await beginGeneration(ctx, "scheduled", selSha);
    }
    state = (await getSyncState(db, scope))!;
    ctx.generation = state.generation;
    await maybeArmDelta(ctx, state, options.deltaIntervalMs ?? 5 * 60_000);

    for (;;) {
      if (budget.exhausted) break;
      const batch = await nextWork(db, scope, 25);
      if (!batch.length) {
        if (!(await advanceGeneration(ctx))) break;
        continue;
      }
      for (const item of batch) {
        if (budget.exhausted) break;
        items += 1;
        await processItem(ctx, item);
        await options.heartbeat?.();
        if (items % 20 === 0 && !(await renewQuotaLease(db, quotaKey, owner, leaseSeconds))) throw new Error("jira sweep lease lost");
      }
    }
    await recordRunOutcome(db, scope, { ok: true });
    await clearRateStreak(db, quotaKey);
    const after = (await getSyncState(db, scope))!;
    return { ...base, requests: budget.requests, items, generation: after.generation, phase: after.generation_phase };
  } catch (error) {
    if (error instanceof JiraRateLimitedError) {
      const until = await recordRateLimited(db, quotaKey, { retryAfterMs: error.retryAfterMs, status: error.status, reason: error.message, defaultBackoffMs: DEFAULT_RATE_LIMIT_BACKOFF_MS });
      await recordRunOutcome(db, scope, { ok: false, error: `rate limited until ${until.toISOString()}` });
      return { ...base, outcome: "deferred", requests: budget.requests, items, deferredUntil: until.toISOString() };
    }
    if (error instanceof JiraAuthError) {
      await setSiteStatus(db, scope, "blocked", error.message);
      await recordRunOutcome(db, scope, { ok: false, error: error.message, blockedCode: "auth", blockedReason: error.message });
      return { ...base, outcome: "blocked", requests: budget.requests, items, error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    await recordRunOutcome(db, scope, { ok: false, error: message });
    return { ...base, outcome: "error", requests: budget.requests, items, error: message };
  } finally {
    await releaseQuotaLease(db, quotaKey, owner);
  }
}

async function beginGeneration(ctx: Ctx, reason: string, selSha: string): Promise<void> {
  const g = await startGeneration(ctx.db, ctx.scope, reason, selSha);
  ctx.generation = g;
  await applySelection(ctx);
  await enqueueWork(ctx.db, ctx.scope, g, [
    { itemKey: "projects", kind: "projects", priority: PRIORITY.projects, payload: { startAt: 0, status: ["live", "archived"] } },
    { itemKey: "projects-trash", kind: "projects", priority: PRIORITY.projects, payload: { startAt: 0, status: ["deleted"] } },
  ], { restart: true });
}

/** Projects outside the selection (and their issues) stop being live; selecting them again restores them on capture. */
async function applySelection(ctx: Ctx): Promise<void> {
  for (const p of await listObjects(ctx.db, ctx.scope, { types: ["project"], live: true })) {
    if (projectSelected(ctx.selection, p.content_id, p.project_key)) continue;
    await tombstoneObject(ctx.db, ctx.scope.tenantId, p.row_key, "outside_selection");
    for (const issue of await listObjects(ctx.db, ctx.scope, { types: ["issue"], projectId: p.content_id, live: true })) {
      await tombstoneIssue(ctx, issue, "outside_selection");
    }
  }
}

async function maybeArmDelta(ctx: Ctx, state: { delta_watermark: unknown; delta_checked_at: unknown }, intervalMs: number): Promise<void> {
  const current = await workState(ctx.db, ctx.scope, "delta");
  if (current?.state === "pending") return;
  const checked = state.delta_checked_at ? new Date(String(state.delta_checked_at)).getTime() : 0;
  if (Date.now() - checked < intervalMs) return;
  const since = iso(state.delta_watermark) ?? new Date().toISOString();
  await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: "delta", kind: "delta", priority: PRIORITY.delta, payload: { since, startedAt: new Date().toISOString(), cursor: null, jql: null } }], { restart: true });
}

/** scan -> confirm -> closed. Returns true when it enqueued more work. */
async function advanceGeneration(ctx: Ctx): Promise<boolean> {
  const state = (await getSyncState(ctx.db, ctx.scope))!;
  const g = state.generation;
  if (state.generation_phase === "closed") return false;
  if ((await pendingScanItems(ctx.db, ctx.scope, g)) > 0) return false;
  if (state.generation_phase === "scan") {
    const confirms = await missingObjectConfirmations(ctx, g);
    await setGenerationPhase(ctx.db, ctx.scope, g, "confirm", false);
    if (confirms.length) {
      await enqueueWork(ctx.db, ctx.scope, g, confirms, { rearm: true });
      return true;
    }
  }
  const after = (await getSyncState(ctx.db, ctx.scope))!;
  const projects = await workState(ctx.db, ctx.scope, "projects");
  const complete = after.generation_failed_items === 0 && projects?.state === "done" && projects.generation === g;
  await setGenerationPhase(ctx.db, ctx.scope, g, "closed", complete);
  return false;
}

/** Objects not seen in generation g whose enclosing listing COMPLETED in g: deletion candidates, never deleted unconfirmed. */
async function missingObjectConfirmations(ctx: Ctx, g: number): Promise<WorkItem[]> {
  const out: WorkItem[] = [];
  const done = async (key: string): Promise<boolean> => {
    const w = await workState(ctx.db, ctx.scope, key);
    return w?.state === "done" && w.generation === g;
  };
  if (await done("projects")) {
    for (const p of await listObjects(ctx.db, ctx.scope, { types: ["project"], live: true, unseenBefore: g })) {
      if (projectSelected(ctx.selection, p.content_id, p.project_key)) out.push(confirmItem("project", p.content_id));
    }
  }
  for (const p of await listObjects(ctx.db, ctx.scope, { types: ["project"], live: true })) {
    if ((p.seen_generation ?? 0) < g || !(await done(`issues:${p.content_id}`))) continue;
    for (const issue of await listObjects(ctx.db, ctx.scope, { types: ["issue"], projectId: p.content_id, live: true, unseenBefore: g })) out.push(confirmItem("issue", issue.content_id));
  }
  return out;
}

// ------------------------------------------------------------------ item dispatch

async function processItem(ctx: Ctx, item: WorkRow): Promise<void> {
  try {
    const outcome = await runItem(ctx, item);
    if (outcome.state === "inaccessible") await bumpGenerationCounter(ctx.db, ctx.scope, item.generation, "inaccessible");
    await finishWork(ctx.db, ctx.scope, item.item_key, outcome.state, outcome.outcome ?? null);
  } catch (error) {
    if (error instanceof Yield) return;
    if (error instanceof JiraRateLimitedError || error instanceof JiraAuthError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const attempts = await retryWorkLater(ctx.db, ctx.scope, item.item_key, message, Math.min(3600_000, 60_000 * 2 ** item.attempts));
    if (attempts >= ctx.opts.maxItemAttempts) {
      await finishWork(ctx.db, ctx.scope, item.item_key, "failed", null, message);
      await bumpGenerationCounter(ctx.db, ctx.scope, item.generation, "failed");
    }
  }
}

type ItemOutcome = { state: "done" | "inaccessible"; outcome?: Record<string, unknown> };

async function runItem(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const p = item.payload;
  switch (item.kind) {
    case "projects":
      return listProjects(ctx, item);
    case "issues":
      return listIssues(ctx, item);
    case "comments":
      return listComments(ctx, item);
    case "changelog":
      return listChangelog(ctx, item);
    case "download":
      return downloadAttachment(ctx, item);
    case "confirm":
    case "refresh":
      return confirmObject(ctx, String(p.type), String(p.id), p.issueId === undefined ? null : String(p.issueId));
    case "delta":
      return runDelta(ctx, item);
    default:
      throw new Error(`unknown jira work item kind ${item.kind}`);
  }
}

function confirmItem(type: "project" | "issue" | "comment" | "attachment", id: string, issueId?: string): WorkItem {
  return { itemKey: `confirm:${type}:${id}`, kind: "confirm", priority: PRIORITY.confirm, payload: { type, id, ...(issueId !== undefined ? { issueId } : {}) } };
}

function refreshItem(issueId: string): WorkItem {
  return { itemKey: `refresh:issue:${issueId}`, kind: "refresh", priority: PRIORITY.refresh, payload: { type: "issue", id: issueId } };
}

// ------------------------------------------------------------------ projects

/** Offset-paged `project/search` (startAt checkpointed after each stored page). */
async function listProjects(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const statuses = Array.isArray(item.payload.status) ? (item.payload.status as string[]) : ["live", "archived"];
  const trash = statuses.includes("deleted");
  let pages = 0;
  let total = 0;
  for (;;) {
    const startAt = num(item.payload.startAt) ?? 0;
    const r = await ctx.client.get(ctx.target, "/rest/api/3/project/search", { startAt, maxResults: ctx.opts.projectPageSize, expand: "description,lead,issueTypes,url,projectKeys,insight", status: statuses }, [400, 403, 404]);
    // Listing trashed projects needs admin rights; without them it is simply not part of this grant's view.
    if (r.status >= 300) return trash ? { state: "done", outcome: { status: r.status, skipped: "trash listing not permitted" } } : { state: "inaccessible", outcome: { status: r.status } };
    const data = rec(r.data);
    const values = Array.isArray(data?.values) ? data.values.filter(isRecord) : [];
    for (const v of values) await captureProject(ctx, v, "/rest/api/3/project/search", { listing: !trash, trashed: trash });
    pages += 1;
    total += values.length;
    const next = startAt + values.length;
    if (data?.isLast === true || values.length === 0 || (num(data?.total) !== null && next >= num(data?.total)!)) return { state: "done", outcome: { pages, projects: total } };
    item.payload = { ...item.payload, startAt: next };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
    if (ctx.budget.exhausted) throw new Yield();
  }
}

async function captureProject(ctx: Ctx, payload: Record<string, unknown>, endpoint: string, opts: { listing: boolean; trashed?: boolean }): Promise<void> {
  const id = str(payload.id);
  if (!id) return;
  const key = str(payload.key);
  if (!projectSelected(ctx.selection, id, key)) return;
  const raw = redact(payload);
  await insertObservation(ctx.db, ctx.scope, "project", id, raw, endpoint);
  const status = opts.trashed ? "deleted" : payload.archived === true ? "archived" : "live";
  const res = await upsertObject(ctx.db, ctx.scope, { type: "project", id, projectId: id, projectKey: key, status, title: str(payload.name), sourceUpdatedAt: null, raw, tombstoneReason: opts.trashed ? "trashed" : null }, ctx.generation);
  if (opts.trashed) {
    if (res.changed) for (const issue of await listObjects(ctx.db, ctx.scope, { types: ["issue"], projectId: id, live: true })) await tombstoneIssue(ctx, issue, "project_trashed");
    return;
  }
  // Every selected live project is listed every full pass (a renamed project key re-keys its issues).
  if (opts.listing) await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `issues:${id}`, kind: "issues", priority: PRIORITY.issues, payload: { projectId: id, cursor: null, jql: null } }]);
}

// ------------------------------------------------------------------ issues

/**
 * Bounded JQL listing of one project (`project = <id>`; enhanced search rejects
 * unbounded queries). The query string is checkpointed with nextPageToken so a
 * resumed listing continues the same query; an expired token restarts it.
 */
async function listIssues(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const projectId = String(item.payload.projectId);
  const project = await findObject(ctx.db, ctx.scope, "project", projectId);
  if (!project || project.tombstoned_at || !projectSelected(ctx.selection, projectId, project.project_key)) return { state: "done", outcome: { skipped: "project not live or not selected" } };
  const jql = str(item.payload.jql) ?? `project = ${projectId} ORDER BY created ASC`;
  let pages = 0;
  let issues = 0;
  for (;;) {
    const cursor = str(item.payload.cursor);
    const r = await ctx.client.get(ctx.target, "/rest/api/3/search/jql", { jql, fields: "*all", expand: "changelog", maxResults: ctx.opts.searchPageSize, ...(cursor ? { nextPageToken: cursor } : {}) }, [400, 403, 404]);
    if (r.status === 400 && cursor) {
      // Expired / invalid page token: restart the same listing (captures are idempotent).
      item.payload = { ...item.payload, cursor: null, jql };
      await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
      continue;
    }
    if (r.status >= 300) {
      await markInaccessible(ctx.db, ctx.scope.tenantId, project.row_key, `issue search for project ${project.project_key ?? projectId} returned HTTP ${r.status}`);
      return { state: "inaccessible", outcome: { status: r.status } };
    }
    const data = rec(r.data);
    const rows = Array.isArray(data?.issues) ? data.issues.filter(isRecord) : [];
    for (const issue of rows) await captureIssue(ctx, issue, "/rest/api/3/search/jql", { listing: true });
    pages += 1;
    issues += rows.length;
    const next = str(data?.nextPageToken);
    if (!next || rows.length === 0 || data?.isLast === true) return { state: "done", outcome: { pages, issues } };
    item.payload = { ...item.payload, cursor: next, jql };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
    if (ctx.budget.exhausted) throw new Yield();
  }
}

export interface IssueCaptureResult {
  id: string;
  changed: boolean;
  moved: boolean;
}

/**
 * Capture a full issue payload (search or GET, `fields=*all&expand=changelog`).
 * Moves (new key / project) re-place every projection; inline changelog,
 * comments and attachments are stored and, when they are complete sets, used
 * to detect deletions; incomplete ones queue paged listings.
 */
export async function captureIssue(ctx: Ctx, payload: Record<string, unknown>, endpoint: string, opts: { listing: boolean }): Promise<IssueCaptureResult | null> {
  const id = str(payload.id);
  if (!id) return null;
  const fields = rec(payload.fields) ?? {};
  const project = rec(fields.project);
  const projectId = str(project?.id);
  const projectKey = str(project?.key) ?? str(payload.key)?.split("-")[0] ?? null;
  const key = str(payload.key);
  const existing = await findObject(ctx.db, ctx.scope, "issue", id);
  if (!projectSelected(ctx.selection, projectId, projectKey)) {
    // Moved out of the selected projects (or never selected): not mirrored, not deleted.
    if (existing && !existing.tombstoned_at) await tombstoneIssue(ctx, existing, "outside_selection");
    return null;
  }
  const raw = redact(payload);
  await insertObservation(ctx.db, ctx.scope, "issue", id, raw, endpoint);
  const res = await upsertObject(
    ctx.db,
    ctx.scope,
    {
      type: "issue",
      id,
      issueKey: key,
      projectId,
      projectKey,
      status: str(rec(fields.status)?.name),
      title: str(fields.summary),
      sourceUpdatedAt: iso(fields.updated),
      restricted: fields.security !== null && fields.security !== undefined,
      raw,
    },
    opts.listing ? ctx.generation : null,
  );
  if (res.moved || res.restored) await touchDependents(ctx.db, ctx.scope, id, { issueKey: key, projectId, projectKey });
  if (res.restored) await restoreDependents(ctx.db, ctx.scope, id);
  let childrenChanged = false;

  // Changelog: store what search embedded; page the rest from /issue/{id}/changelog.
  const changelog = rec(payload.changelog);
  const histories = Array.isArray(changelog?.histories) ? changelog.histories.filter(isRecord) : [];
  for (const h of histories) {
    const hid = str(h.id);
    if (hid && (await insertChangelog(ctx.db, ctx.scope, id, hid, iso(h.created), redact(h), `${endpoint}#changelog`))) childrenChanged = true;
  }
  const issueKey = objectRowKey(ctx.scope, "issue", id);
  const stored = await changelogCount(ctx.db, ctx.scope.tenantId, issueKey);
  const total = num(changelog?.total);
  const clComplete = total !== null && stored >= total;
  await setObjectFields(ctx.db, ctx.scope.tenantId, issueKey, { changelogTotal: total, changelogStored: stored, changelogStatus: clComplete ? "complete" : "pending" });
  if (!clComplete) await enqueueWork(ctx.db, ctx.scope, ctx.generation, [changelogItem(id)], { rearm: true });

  // Comments: the search container is truncated for busy issues.
  const container = rec(fields.comment);
  const inline = Array.isArray(container?.comments) ? container.comments.filter(isRecord) : [];
  for (const c of inline) {
    const r = await captureComment(ctx, id, { issueKey: key, projectId, projectKey }, c, `${endpoint}#comment`);
    if (r?.changed) childrenChanged = true;
  }
  const commentsTotal = num(container?.total);
  if (container && commentsTotal !== null && inline.length >= commentsTotal && (num(container.startAt) ?? 0) === 0) {
    await setObjectFields(ctx.db, ctx.scope.tenantId, issueKey, { commentsTotal, commentsStatus: "complete" });
    await reconcileChildren(ctx, id, "comment", new Set(inline.map((c) => str(c.id)).filter((x): x is string => Boolean(x))));
  } else if (res.updatedChanged || res.created || res.restored || opts.listing || !container) {
    await setObjectFields(ctx.db, ctx.scope.tenantId, issueKey, { commentsTotal, commentsStatus: "pending" });
    await enqueueWork(ctx.db, ctx.scope, ctx.generation, [commentsItem(id)], { rearm: true });
  }

  // Attachments: fields.attachment is the issue's complete attachment list.
  if (Array.isArray(fields.attachment)) {
    const atts = fields.attachment.filter(isRecord);
    for (const a of atts) if (await captureAttachment(ctx, id, { issueKey: key, projectId, projectKey }, a, `${endpoint}#attachment`)) childrenChanged = true;
    await reconcileChildren(ctx, id, "attachment", new Set(atts.map((a) => str(a.id)).filter((x): x is string => Boolean(x))));
  }
  if (childrenChanged) await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", id);
  if (ctx.donor) {
    // Unredacted payload, exactly what the donor sweep passed to its capture (redaction happens at persist there).
    const donor = await (await donorFeed()).recordJiraIssueDetailFromDeepLane(ctx.db as never, ctx.donor, payload);
    if (donor.commentsPending) await enqueueWork(ctx.db, ctx.scope, ctx.generation, [commentsItem(id)], { rearm: true });
  }
  return { id, changed: res.changed, moved: res.moved };
}

/** Live children of an issue absent from a complete provider set are confirmed one by one (never deleted unconfirmed). */
async function reconcileChildren(ctx: Ctx, issueId: string, type: "comment" | "attachment", present: ReadonlySet<string>): Promise<void> {
  const missing = (await listObjects(ctx.db, ctx.scope, { types: [type], containerId: issueId, live: true })).filter((c) => !present.has(c.content_id));
  if (missing.length) await enqueueWork(ctx.db, ctx.scope, ctx.generation, missing.map((c) => confirmItem(type, c.content_id, issueId)), { rearm: true });
}

async function tombstoneIssue(ctx: Ctx, issue: ObjectRow, reason: string): Promise<void> {
  await tombstoneObject(ctx.db, ctx.scope.tenantId, issue.row_key, reason);
  await tombstoneDependents(ctx.db, ctx.scope, issue.content_id, reason);
  await touchDependents(ctx.db, ctx.scope, issue.content_id, { issueKey: issue.issue_key, projectId: issue.project_id, projectKey: issue.project_key });
}

// ------------------------------------------------------------------ changelog

function changelogItem(issueId: string): WorkItem {
  return { itemKey: `changelog:${issueId}`, kind: "changelog", priority: PRIORITY.changelog, payload: { issueId, startAt: 0 } };
}

/**
 * Page `/rest/api/3/issue/{id}/changelog` from the first entry to the last
 * (offset paged, startAt checkpointed). Only queued when the stored history set
 * is short of `total`; histories are immutable and keyed by id, so re-reading an
 * overlap is a no-op. Which subset search embeds is not documented, so no
 * offset is inferred from the stored count.
 */
async function listChangelog(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const issueId = String(item.payload.issueId);
  const issue = await findObject(ctx.db, ctx.scope, "issue", issueId);
  if (!issue || issue.tombstoned_at) return { state: "done", outcome: { skipped: "issue not live" } };
  const endpoint = `/rest/api/3/issue/${enc(issueId)}/changelog`;
  let added = 0;
  let total: number | null = null;
  for (;;) {
    const startAt = num(item.payload.startAt) ?? 0;
    const r = await ctx.client.get(ctx.target, endpoint, { startAt, maxResults: ctx.opts.changelogPageSize }, [403, 404]);
    if (r.status === 403 || r.status === 404) {
      await setObjectFields(ctx.db, ctx.scope.tenantId, issue.row_key, { changelogStatus: r.status === 403 ? "forbidden" : "issue_not_found" });
      if (r.status === 404) await enqueueWork(ctx.db, ctx.scope, ctx.generation, [confirmItem("issue", issueId)]);
      return { state: "inaccessible", outcome: { status: r.status } };
    }
    const data = rec(r.data);
    const values = Array.isArray(data?.values) ? data.values.filter(isRecord) : [];
    total = num(data?.total) ?? total;
    for (const h of values) {
      const hid = str(h.id);
      if (hid && (await insertChangelog(ctx.db, ctx.scope, issueId, hid, iso(h.created), redact(h), endpoint))) added += 1;
    }
    const next = startAt + values.length;
    if (data?.isLast === true || values.length === 0 || (total !== null && next >= total)) break;
    item.payload = { ...item.payload, startAt: next };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
    if (ctx.budget.exhausted) {
      if (added) await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issueId);
      throw new Yield();
    }
  }
  const stored = await changelogCount(ctx.db, ctx.scope.tenantId, issue.row_key);
  const effectiveTotal = total ?? issue.changelog_total;
  // Short of `total` after a full read = histories this grant cannot see (or removed upstream): labelled, never "complete".
  const complete = effectiveTotal === null ? true : stored >= effectiveTotal;
  await setObjectFields(ctx.db, ctx.scope.tenantId, issue.row_key, { changelogTotal: effectiveTotal, changelogStored: stored, changelogStatus: complete ? "complete" : "incomplete" });
  if (added) await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issueId);
  return { state: "done", outcome: { added, stored, total: effectiveTotal } };
}

// ------------------------------------------------------------------ comments

function commentsItem(issueId: string): WorkItem {
  return { itemKey: `comments:${issueId}`, kind: "comments", priority: PRIORITY.comments, payload: { issueId, startAt: 0, seen: [] } };
}

interface Placement {
  issueKey: string | null;
  projectId: string | null;
  projectKey: string | null;
}

async function captureComment(ctx: Ctx, issueId: string, placement: Placement, payload: Record<string, unknown>, endpoint: string): Promise<{ id: string; changed: boolean } | null> {
  const id = str(payload.id);
  if (!id) return null;
  const raw = redact(payload);
  // Every distinct edit is an observation of its own (the body and `updated` change).
  await insertObservation(ctx.db, ctx.scope, "comment", id, raw, endpoint);
  const res = await upsertObject(
    ctx.db,
    ctx.scope,
    { type: "comment", id, issueKey: placement.issueKey, projectId: placement.projectId, projectKey: placement.projectKey, containerId: issueId, status: null, title: null, sourceUpdatedAt: iso(payload.updated ?? payload.created), restricted: rec(payload.visibility) !== null, raw },
    null,
  );
  return { id, changed: res.changed };
}

/** Page every comment of an issue; when exhausted, stored live comments not returned are confirmed. */
async function listComments(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const issueId = String(item.payload.issueId);
  const issue = await findObject(ctx.db, ctx.scope, "issue", issueId);
  if (!issue || issue.tombstoned_at) return { state: "done", outcome: { skipped: "issue not live" } };
  const placement = { issueKey: issue.issue_key, projectId: issue.project_id, projectKey: issue.project_key };
  const endpoint = `/rest/api/3/issue/${enc(issueId)}/comment`;
  const seen = new Set<string>(Array.isArray(item.payload.seen) ? (item.payload.seen as string[]) : []);
  let changed = false;
  let total: number | null = null;
  for (;;) {
    const startAt = num(item.payload.startAt) ?? 0;
    const r = await ctx.client.get(ctx.target, endpoint, { startAt, maxResults: ctx.opts.commentPageSize, orderBy: "created" }, [403, 404]);
    if (r.status === 403 || r.status === 404) {
      await setObjectFields(ctx.db, ctx.scope.tenantId, issue.row_key, { commentsStatus: r.status === 403 ? "forbidden" : "issue_not_found" });
      if (r.status === 404) await enqueueWork(ctx.db, ctx.scope, ctx.generation, [confirmItem("issue", issueId)]);
      return { state: "inaccessible", outcome: { status: r.status } };
    }
    const data = rec(r.data);
    const rows = Array.isArray(data?.comments) ? data.comments.filter(isRecord) : [];
    total = num(data?.total) ?? total;
    for (const c of rows) {
      const res = await captureComment(ctx, issueId, placement, c, endpoint);
      if (res) {
        seen.add(res.id);
        if (res.changed) changed = true;
      }
    }
    if (ctx.donor) await (await donorFeed()).recordJiraIssueCommentsFromDeepLane(ctx.db as never, ctx.donor, { issueId, issueKey: issue.issue_key }, rows);
    const next = startAt + rows.length;
    if (rows.length === 0 || (total !== null && next >= total) || data?.isLast === true) break;
    // The seen set travels with the cursor checkpoint, so a resumed listing still reconciles correctly.
    item.payload = { ...item.payload, startAt: next, seen: [...seen] };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
    if (ctx.budget.exhausted) {
      if (changed) await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issueId);
      throw new Yield();
    }
  }
  await setObjectFields(ctx.db, ctx.scope.tenantId, issue.row_key, { commentsTotal: total ?? seen.size, commentsStatus: "complete" });
  if (ctx.donor) {
    // The donor mirror shows the complete comment set it would have paged itself (an unchanged render is a no-op).
    const listed = (await listObjects(ctx.db, ctx.scope, { types: ["comment"], containerId: issueId })).filter((c) => seen.has(c.content_id)).map((c) => c.raw);
    await (await donorFeed()).rematerializeJiraIssueDetailMirror(ctx.db as never, ctx.donor, issueId, listed, total);
  }
  await reconcileChildren(ctx, issueId, "comment", seen);
  if (changed) await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issueId);
  return { state: "done", outcome: { comments: seen.size, total } };
}

// ------------------------------------------------------------------ attachments

async function captureAttachment(ctx: Ctx, issueId: string, placement: Placement, payload: Record<string, unknown>, endpoint: string): Promise<boolean> {
  const id = str(payload.id);
  if (!id) return false;
  const raw = redact(payload);
  await insertObservation(ctx.db, ctx.scope, "attachment", id, raw, endpoint);
  const res = await upsertObject(
    ctx.db,
    ctx.scope,
    { type: "attachment", id, issueKey: placement.issueKey, projectId: placement.projectId, projectKey: placement.projectKey, containerId: issueId, status: null, title: str(payload.filename), sourceUpdatedAt: iso(payload.created), raw },
    null,
  );
  const current = await findObject(ctx.db, ctx.scope, "attachment", id);
  // Jira attachments are immutable (a new upload is a new id): stored / too_large are final.
  const settled = ["stored", "too_large"].includes(current?.binary_status ?? "");
  if (!settled) {
    if (current?.binary_status === null) await setObjectFields(ctx.db, ctx.scope.tenantId, res.rowKey, { binaryStatus: "pending" });
    await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `download:${id}`, kind: "download", priority: PRIORITY.download, payload: { attachmentId: id, issueId, size: num(payload.size), mimeType: str(payload.mimeType) } }], { rearm: true });
  }
  return res.changed;
}

/**
 * Exact attachment bytes through the authenticated proxy
 * (`/rest/api/3/attachment/content/{id}?redirect=false`), streamed into
 * <= 8 MiB chunks. Over the capture limit -> `too_large`; 401/403 -> the grant
 * may not read attachment content (`forbidden` / `scope_missing`). Both are
 * reported as partial coverage, never silently dropped.
 */
async function downloadAttachment(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const id = String(item.payload.attachmentId);
  const declared = num(item.payload.size);
  const current = await findObject(ctx.db, ctx.scope, "attachment", id);
  if (!current || current.tombstoned_at) return { state: "done", outcome: { skipped: "attachment no longer live" } };
  const key = current.row_key;
  if (declared !== null && declared > ctx.opts.maxAttachmentBytes) {
    await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: "too_large", binaryError: `declared ${declared} bytes > limit ${ctx.opts.maxAttachmentBytes}` });
    return { state: "done", outcome: { tooLarge: declared } };
  }
  const writer = new ChunkWriter(ctx.db, ctx.scope.tenantId);
  try {
    const r = await ctx.client.download(ctx.target, id, (piece) => writer.write(piece), ctx.opts.maxAttachmentBytes, [401, 403, 404]);
    if (r.status === 401 || r.status === 403) {
      await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: r.status === 401 ? "scope_missing" : "forbidden", binaryError: `HTTP ${r.status}` });
      return { state: "inaccessible", outcome: { status: r.status } };
    }
    if (r.status === 404) {
      await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: "missing", binaryError: "HTTP 404" });
      await enqueueWork(ctx.db, ctx.scope, ctx.generation, [confirmItem("attachment", id, current.container_id ?? undefined)]);
      return { state: "inaccessible", outcome: { status: 404 } };
    }
    if (declared !== null && declared !== r.size) throw new JiraApiError(`attachment ${id}: received ${r.size} bytes, metadata says ${declared}`, r.status, "size_mismatch");
    const blob = await writer.finish(r.sha256, r.size, r.mediaType);
    await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: "stored", binarySha256: blob.sha256, binarySize: blob.size, binaryMediaType: str(current.raw.mimeType) ?? r.mediaType, binaryError: null });
    if (current.container_id) await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", current.container_id);
    return { state: "done", outcome: { size: blob.size, via: r.via } };
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) {
      await setObjectFields(ctx.db, ctx.scope.tenantId, key, { binaryStatus: "too_large", binaryError: error.message });
      return { state: "done", outcome: { tooLarge: error.size } };
    }
    throw error;
  }
}

// ------------------------------------------------------------------ confirmation / refresh

/** Whether the grant can still browse a project (Jira's own permission answer, not an inference). */
async function canBrowseProject(ctx: Ctx, projectId: string | null): Promise<boolean> {
  if (!projectId) return false;
  const r = await ctx.client.get(ctx.target, "/rest/api/3/mypermissions", { projectId, permissions: "BROWSE_PROJECTS" }, [400, 403, 404]);
  if (r.status !== 200) return false;
  const perms = rec(rec(r.data)?.permissions);
  return rec(perms?.BROWSE_PROJECTS)?.havePermission === true;
}

async function confirmObject(ctx: Ctx, type: string, id: string, issueId: string | null): Promise<ItemOutcome> {
  switch (type) {
    case "issue":
      return confirmIssue(ctx, id);
    case "comment":
      return confirmComment(ctx, id, issueId);
    case "attachment":
      return confirmAttachment(ctx, id);
    case "project":
      return confirmProject(ctx, id);
    default:
      throw new Error(`unknown jira object type ${type}`);
  }
}

/**
 * GET one issue by its stable id. 200 -> re-capture (handles moves, re-keys,
 * edits); 403 -> inaccessible; 404 -> deleted only if the grant can still
 * browse the issue's project and the issue had no security level, otherwise
 * inaccessible (lost access is not deletion).
 */
async function confirmIssue(ctx: Ctx, id: string): Promise<ItemOutcome> {
  const endpoint = `/rest/api/3/issue/${enc(id)}`;
  const r = await ctx.client.get(ctx.target, endpoint, { fields: "*all", expand: "changelog" }, [403, 404]);
  const existing = await findObject(ctx.db, ctx.scope, "issue", id);
  if (r.status === 403) {
    if (existing) await markInaccessible(ctx.db, ctx.scope.tenantId, existing.row_key, "HTTP 403 for this connection");
    return { state: "inaccessible", outcome: { status: 403 } };
  }
  if (r.status === 404) {
    if (!existing) return { state: "done", outcome: { status: 404, known: false } };
    if (!(await canBrowseProject(ctx, existing.project_id))) {
      await markInaccessible(ctx.db, ctx.scope.tenantId, existing.row_key, `issue not found and project ${existing.project_key ?? existing.project_id ?? "?"} is no longer browsable by this grant (deleted project, or access removed)`);
      return { state: "inaccessible", outcome: { status: 404, projectBrowsable: false } };
    }
    if (existing.restricted) {
      await markInaccessible(ctx.db, ctx.scope.tenantId, existing.row_key, "issue not found; it had an issue security level, so this may be lost access rather than deletion");
      return { state: "inaccessible", outcome: { status: 404, restricted: true } };
    }
    await tombstoneIssue(ctx, existing, "not_found");
    return { state: "done", outcome: { status: 404, tombstoned: true } };
  }
  if (!isRecord(r.data)) throw new JiraApiError(`issue ${id} returned no object`, r.status, "bad_payload");
  await captureIssue(ctx, r.data, endpoint, { listing: false });
  return { state: "done", outcome: { status: 200 } };
}

async function confirmComment(ctx: Ctx, id: string, issueIdHint: string | null): Promise<ItemOutcome> {
  const existing = await findObject(ctx.db, ctx.scope, "comment", id);
  const issueId = existing?.container_id ?? issueIdHint;
  if (!existing || !issueId) return { state: "done", outcome: { known: false } };
  const endpoint = `/rest/api/3/issue/${enc(issueId)}/comment/${enc(id)}`;
  const r = await ctx.client.get(ctx.target, endpoint, {}, [403, 404]);
  if (r.status === 403) {
    await markInaccessible(ctx.db, ctx.scope.tenantId, existing.row_key, "HTTP 403 for this connection");
    await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issueId);
    return { state: "inaccessible", outcome: { status: 403 } };
  }
  if (r.status === 404) {
    const issue = await findObject(ctx.db, ctx.scope, "issue", issueId);
    if (existing.restricted || !issue || issue.tombstoned_at || issue.inaccessible_at) {
      await markInaccessible(ctx.db, ctx.scope.tenantId, existing.row_key, existing.restricted ? "comment not found; it had restricted visibility, so this may be lost access rather than deletion" : "comment not found while its issue is not readable");
      await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issueId);
      return { state: "inaccessible", outcome: { status: 404 } };
    }
    await tombstoneObject(ctx.db, ctx.scope.tenantId, existing.row_key, "not_found");
    await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issueId);
    return { state: "done", outcome: { status: 404, tombstoned: true } };
  }
  if (!isRecord(r.data)) throw new JiraApiError(`comment ${id} returned no object`, r.status, "bad_payload");
  const res = await captureComment(ctx, issueId, { issueKey: existing.issue_key, projectId: existing.project_id, projectKey: existing.project_key }, r.data, endpoint);
  if (res?.changed) await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issueId);
  return { state: "done", outcome: { status: 200 } };
}

async function confirmAttachment(ctx: Ctx, id: string): Promise<ItemOutcome> {
  const existing = await findObject(ctx.db, ctx.scope, "attachment", id);
  if (!existing) return { state: "done", outcome: { known: false } };
  const r = await ctx.client.get(ctx.target, `/rest/api/3/attachment/${enc(id)}`, {}, [403, 404]);
  if (r.status === 403) {
    await markInaccessible(ctx.db, ctx.scope.tenantId, existing.row_key, "HTTP 403 for this connection");
    return { state: "inaccessible", outcome: { status: 403 } };
  }
  if (r.status === 404) {
    const issue = existing.container_id ? await findObject(ctx.db, ctx.scope, "issue", existing.container_id) : null;
    if (!issue || issue.tombstoned_at || issue.inaccessible_at) {
      await markInaccessible(ctx.db, ctx.scope.tenantId, existing.row_key, "attachment not found while its issue is not readable");
      return { state: "inaccessible", outcome: { status: 404 } };
    }
    // Attachments have no permissions of their own: missing from a readable issue = deleted.
    await tombstoneObject(ctx.db, ctx.scope.tenantId, existing.row_key, "not_found");
    await bumpChildrenEpoch(ctx.db, ctx.scope, "issue", issue.content_id);
    return { state: "done", outcome: { status: 404, tombstoned: true } };
  }
  return { state: "done", outcome: { status: r.status, present: true } };
}

/** Projects: 404/403 cannot be told apart from lost browse permission, so they are kept and marked inaccessible. */
async function confirmProject(ctx: Ctx, id: string): Promise<ItemOutcome> {
  const existing = await findObject(ctx.db, ctx.scope, "project", id);
  const endpoint = `/rest/api/3/project/${enc(id)}`;
  const r = await ctx.client.get(ctx.target, endpoint, { expand: "description,lead,issueTypes,url,projectKeys,insight" }, [403, 404]);
  if (r.status === 403 || r.status === 404) {
    if (existing) await markInaccessible(ctx.db, ctx.scope.tenantId, existing.row_key, `project not returned for this grant (HTTP ${r.status}: deleted, or browse access removed); last captured state kept`);
    return { state: "inaccessible", outcome: { status: r.status } };
  }
  if (!isRecord(r.data)) throw new JiraApiError(`project ${id} returned no object`, r.status, "bad_payload");
  await captureProject(ctx, r.data, endpoint, { listing: false });
  return { state: "done", outcome: { status: 200 } };
}

// ------------------------------------------------------------------ delta

/** JQL clause restricting the delta to the selected projects (by captured id, so a stale key can never fail the query). */
async function selectionClause(ctx: Ctx): Promise<string | null> {
  if (ctx.selection.mode === "all") return "";
  const ids = (await listObjects(ctx.db, ctx.scope, { types: ["project"], live: true })).filter((p) => projectSelected(ctx.selection, p.content_id, p.project_key)).map((p) => p.content_id).filter((x) => /^\d+$/u.test(x));
  return ids.length ? `project in (${ids.join(", ")}) AND ` : null;
}

/**
 * Relative-time JQL delta (`updated >= "-Nm"` is evaluated by Jira against its
 * own clock, so the user's timezone cannot shift the window). The exact JQL is
 * checkpointed with the page token; the watermark moves to `startedAt` only
 * after the last page. Issues returned carry full fields + changelog and are
 * captured directly (no second fetch).
 */
async function runDelta(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const clause = await selectionClause(ctx);
  if (clause === null) return { state: "done", outcome: { skipped: "no selected project captured yet; the full pass covers it" } };
  let pages = 0;
  let issues = 0;
  let builtHere = false;
  for (;;) {
    let jql = str(item.payload.jql);
    if (!jql) {
      const since = new Date(String(item.payload.since));
      const startedAt = new Date(String(item.payload.startedAt));
      const minutes = Math.max(1, Math.ceil((startedAt.getTime() - since.getTime() + ctx.opts.deltaOverlapMs) / 60_000));
      jql = `${clause}updated >= "-${minutes}m" ORDER BY updated ASC`;
      item.payload = { ...item.payload, jql };
      builtHere = true;
    }
    const cursor = str(item.payload.cursor);
    const r = await ctx.client.get(ctx.target, "/rest/api/3/search/jql", { jql, fields: "*all", expand: "changelog", maxResults: ctx.opts.searchPageSize, ...(cursor ? { nextPageToken: cursor } : {}) }, [400]);
    if (r.status === 400) {
      // A query resumed from a checkpoint can go stale (expired page token, selection changed under it): re-run the
      // window from `since` with a fresh start instant. A query built in this run that is rejected is a real failure.
      if (builtHere) throw new JiraApiError(`delta JQL rejected: ${JSON.stringify(r.data).slice(0, 300)}`, 400, "bad_jql");
      item.payload = { ...item.payload, startedAt: new Date().toISOString(), cursor: null, jql: null };
      await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
      continue;
    }
    const data = rec(r.data);
    const rows = Array.isArray(data?.issues) ? data.issues.filter(isRecord) : [];
    for (const issue of rows) await captureIssue(ctx, issue, "/rest/api/3/search/jql", { listing: false });
    pages += 1;
    issues += rows.length;
    const next = str(data?.nextPageToken);
    if (!next || rows.length === 0 || data?.isLast === true) break;
    item.payload = { ...item.payload, cursor: next };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
    if (ctx.budget.exhausted) throw new Yield();
  }
  await setDeltaWatermark(ctx.db, ctx.scope, new Date(String(item.payload.startedAt)));
  return { state: "done", outcome: { pages, issues, jql: item.payload.jql } };
}

// ------------------------------------------------------------------ hints (webhooks)

/**
 * A provider/Nango webhook named an issue: queue a refresh of it by id on every
 * active site of the tenant's connection. The webhook body is only a hint (the
 * issue is re-read from Jira), the tenant comes from the server-side connection
 * mapping, and the periodic delta still covers anything a lost webhook missed.
 */
export async function enqueueJiraIssueHint(db: DbExecutor, tenantId: string, hint: { connectionId: string; issueId: string; cloudId?: string | null }): Promise<number> {
  if (!/^\d{1,20}$/u.test(hint.issueId)) return 0;
  let n = 0;
  for (const site of await listSites(db, tenantId, hint.connectionId)) {
    if (site.status !== "active" || (hint.cloudId && site.cloud_id !== hint.cloudId)) continue;
    const scope = { tenantId, connectionId: hint.connectionId, cloudId: site.cloud_id };
    const st = await getSyncState(db, scope);
    if (!st || st.generation === 0) continue;
    await enqueueWork(db, scope, st.generation, [refreshItem(hint.issueId)], { rearm: true });
    n += 1;
  }
  return n;
}

// ------------------------------------------------------------------ task handler

export function jiraTaskHandlers(options: SweepOptions = {}): Record<string, TaskHandler> {
  return {
    [JIRA_SWEEP_TASK]: async (payload, ctx) => {
      const { db } = await import("../../../db/client.js");
      // Tenant comes from the server-written task row; a payload tenant must agree with it.
      const tenantId = ctx.task.tenantId;
      if (typeof payload.tenantId === "string" && payload.tenantId !== tenantId) throw new Error("jira.sweep payload tenant does not match the task tenant");
      const report = await runJiraSweep(db, tenantId, { ...options, heartbeat: async () => ctx.heartbeat() });
      return report as unknown as Record<string, unknown>;
    },
  };
}

export type { JsonResult, Params };
