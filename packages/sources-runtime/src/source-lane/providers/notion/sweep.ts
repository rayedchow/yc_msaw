import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { notionWebhookAffectedDataSourceId, notionWebhookAffectedPageId, type NotionWebhookEvent } from "../../../integrations/notion/webhook.js";
import type { TaskHandler } from "../../../queue/queue.js";
import type { DbExecutor } from "../../core/types.js";
import {
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  isRecord,
  NotionApiError,
  NotionAuthError,
  NotionFileError,
  NotionRateLimitedError,
  NotionSourceClient,
  type JsonObject,
  type NotionResponse,
  type NotionSourceClientOptions,
} from "./api.js";
import {
  blockFiles,
  blockInput,
  commentFiles,
  fileForSlot,
  isoTime,
  nodeFiles,
  nodeInput,
  normId,
  objectType,
  propertiesNeedingHydration,
  redact,
  str,
  syncedFrom,
  walkableChildren,
  type ExtractedFile,
} from "./model.js";
import {
  acquireQuotaLease,
  bumpGenerationCounter,
  ChunkWriter,
  checkpointWork,
  clearRateStreak,
  contentSha,
  deferWork,
  enqueueWork,
  ensureSyncState,
  finishWork,
  getBlock,
  getConnection,
  getNode,
  getSyncState,
  insertRecord,
  listNodes,
  listPageBlocks,
  listPageComments,
  listSyncStates,
  markBlockCommentsChecked,
  markNodeInaccessible,
  missingOpenComments,
  nextWork,
  noteCapability,
  pageWalkItems,
  pendingItems,
  quotaBlockedUntil,
  recordRateLimited,
  recordRunOutcome,
  releaseQuotaLease,
  renewQuotaLease,
  retryWorkLater,
  rowsOf,
  setCommentStatus,
  setConnectionStatus,
  setDeltaWatermark,
  setFileFailed,
  setFileStored,
  setGenerationPhase,
  setNodeFields,
  startGeneration,
  tombstoneFiles,
  tombstoneNode,
  tombstoneUnseenBlocks,
  touchDescendants,
  upsertBlocks,
  upsertComments,
  upsertConnection,
  upsertFileRef,
  upsertNode,
  workState,
  type NodeRow,
  type NodeType,
  type Scope,
  type UpsertNodeResult,
  type WorkItem,
  type WorkRow,
} from "./store.js";

/**
 * Notion deep sweep (task `notion.source_sweep`, one schedule per tenant).
 *
 * The tenant's Notion connection (donor integration_tokens row; connection id = the Notion
 * bot id) runs a bounded slice of a durable work queue (drizzle/9450) per run:
 *
 *   full pass (generation G, every fullScanIntervalMs):
 *     search pages + search data sources (all pages, cursor-checkpointed) ->
 *     every page whose last_edited_time moved (or that is new / restored / not completely
 *     walked yet) is walked: its block tree is listed level by level, every level fully
 *     paginated (`children:<block>` items, no block/depth/request caps), page-level and
 *     block-level comments listed, paginated properties (relation/people/rollup/formula/...
 *     beyond the 25 embedded items) hydrated, Notion-hosted file bytes fetched at once
 *     from the short-lived signed URL; child pages / child databases found in blocks are
 *     fetched as nodes; databases list their data sources; every data source is queried
 *     to exhaustion (created_time windows past the 10,000-result query limit).
 *     When the scan is done, every live node not seen in G is fetched by id: 200 = kept
 *     (possibly moved / trashed), 404 = tombstoned (deleted or unshared; Notion does not
 *     distinguish), 403 = inaccessible (kept). Only then is G closed, and it counts as
 *     complete only with zero failed items.
 *   delta (every deltaIntervalMs): newest-first search back to the stored last_edited_time
 *     watermark (minus an overlap: last_edited_time has minute granularity and search is
 *     eventually consistent); changed pages are re-walked, a page edited within the
 *     minute of its last walk is walked again.
 *
 * A page walk ends with `finalize:<page>`: only when every listing of that walk completed
 * are blocks that were not listed again tombstoned; the page's tree (ordered block and
 * comment content hashes) is appended to the raw ledger when it changed.
 *
 * Rate limits: requests are paced (default 120/min per connection, below Notion's
 * 180/min), a 429/529 stops the run and persists Retry-After on the budget Notion named
 * (connection = bot, workspace, or endpoint), shared by every tenant/worker; a missing
 * header backs off exponentially. Every listing checkpoints its cursor after storing a
 * page of results, so a crash, lease loss, budget end or rate limit resumes exactly
 * there; an expired cursor (400) restarts that listing only.
 */

export const NOTION_SOURCE_SWEEP_TASK = "notion.source_sweep";

export const PRIORITY = {
  delta: 5,
  search: 10,
  node: 15,
  walk: 20,
  children: 25,
  props: 30,
  comments: 35,
  query: 40,
  commentConfirm: 60,
  download: 70,
  confirm: 80,
  finalize: 90,
} as const;

/** Item kinds that belong to a full pass's scan phase (delta and late downloads do not hold a generation open). */
const SCAN_KINDS = ["search", "node", "walk", "children", "props", "comments", "query", "comment_confirm", "finalize"] as const;

export interface SweepOptions {
  clientOptions?: NotionSourceClientOptions;
  maxRequestsPerRun?: number;
  maxMillisPerRun?: number;
  /** Minimum spacing of Notion API requests within a run (default 60000 / NOTION_SOURCE_REQUESTS_PER_MINUTE(120)). */
  minRequestIntervalMs?: number;
  fullScanIntervalMs?: number;
  deltaIntervalMs?: number;
  deltaOverlapMs?: number;
  blockComments?: boolean;
  blockCommentRefreshMs?: number;
  maxFileBytes?: number;
  maxItemAttempts?: number;
  maxFileAttempts?: number;
  pageSize?: number;
  leaseSeconds?: number;
  leaseOwner?: string;
  heartbeat?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface SweepReport {
  tenantId: string;
  connectionId: string | null;
  workspaceId: string | null;
  outcome: "ran" | "deferred" | "lease_busy" | "blocked" | "no_connection" | "error";
  requests: number;
  items: number;
  generation?: number;
  phase?: string;
  deferredUntil?: string;
  error?: string;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

class Budget {
  requests = 0;
  readonly #startedAt = Date.now();
  #last = 0;

  constructor(
    readonly maxRequests: number,
    readonly maxMillis: number,
    readonly minIntervalMs: number,
    readonly sleep: (ms: number) => Promise<void>,
  ) {}

  get exhausted(): boolean {
    return this.requests >= this.maxRequests || Date.now() - this.#startedAt >= this.maxMillis;
  }

  async take(): Promise<void> {
    if (this.exhausted) throw new Yield();
    const wait = this.#last + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.#last = Date.now();
    this.requests += 1;
  }
}

/** Stop the current item without finishing it (budget end, or a wait for other items); its checkpoint stays. */
class Yield extends Error {
  constructor() {
    super("yield");
    this.name = "Yield";
  }
}

interface Ctx {
  db: DbExecutor;
  scope: Scope;
  client: NotionSourceClient;
  budget: Budget;
  generation: number;
  connKey: string;
  wsKey: string | null;
  opts: {
    pageSize: number;
    blockComments: boolean;
    blockCommentRefreshMs: number;
    maxFileBytes: number;
    maxItemAttempts: number;
    maxFileAttempts: number;
    deltaOverlapMs: number;
  };
}

async function apiGet(ctx: Ctx, path: string, tolerate: readonly number[] = []): Promise<NotionResponse> {
  await ctx.budget.take();
  return ctx.client.get(path, tolerate);
}

async function apiPost(ctx: Ctx, path: string, body: JsonObject, tolerate: readonly number[] = []): Promise<NotionResponse> {
  await ctx.budget.take();
  return ctx.client.post(path, body, tolerate);
}

// ------------------------------------------------------------------ entry point

export async function runNotionSweep(db: DbExecutor, tenantId: string, options: SweepOptions = {}): Promise<SweepReport> {
  const report: SweepReport = { tenantId, connectionId: null, workspaceId: null, outcome: "ran", requests: 0, items: 0 };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = new Budget(
    options.maxRequestsPerRun ?? envInt("NOTION_SOURCE_MAX_REQUESTS_PER_RUN", 240),
    options.maxMillisPerRun ?? envInt("NOTION_SOURCE_MAX_MILLIS_PER_RUN", 2 * 60_000),
    options.minRequestIntervalMs ?? Math.ceil(60_000 / envInt("NOTION_SOURCE_REQUESTS_PER_MINUTE", 120)),
    sleep,
  );
  const client = new NotionSourceClient(tenantId, options.clientOptions);

  // Which connection: the tenant's stored Notion token (one per tenant in the donor vault).
  let cred;
  try {
    cred = await client.credential();
  } catch (error) {
    report.outcome = "no_connection";
    report.error = error instanceof Error ? error.message : String(error);
    for (const s of await listSyncStates(db, tenantId)) {
      await setConnectionStatus(db, { tenantId, connectionId: s.connection_id }, "blocked", report.error);
    }
    return report;
  }
  const meta = cred.metadata ?? {};
  let botId = str(meta.botId) ?? str(meta.bot_id);
  let workspaceId = str(meta.workspaceId) ?? str(meta.workspace_id);
  let workspaceName = str(meta.workspaceName) ?? str(meta.workspace_name);
  let bot: unknown = null;
  const knownConnectionId = botId ?? workspaceId;
  const known = knownConnectionId ? await getConnection(db, { tenantId, connectionId: knownConnectionId }) : null;
  const stale = !known || !known.workspace_id || Date.now() - new Date(String(known.checked_at)).getTime() > 6 * 3600_000;
  if (knownConnectionId) {
    const early = await blockedUntil(db, `notion:bot:${knownConnectionId}`, workspaceId ? `notion:workspace:${workspaceId}` : null);
    if (early) return { ...report, connectionId: knownConnectionId, workspaceId, outcome: "deferred", deferredUntil: early.toISOString(), requests: 0 };
  }
  if (!botId || !workspaceId || stale) {
    // GET /v1/users/me identifies the bot and its workspace (also validates the token).
    try {
      await budget.take();
      const me = await client.get("/users/me");
      if (isRecord(me.body)) {
        bot = redact(me.body);
        botId = str(me.body.id) ?? botId;
        const b = isRecord(me.body.bot) ? me.body.bot : {};
        workspaceId = str(b.workspace_id) ?? workspaceId;
        workspaceName = str(b.workspace_name) ?? workspaceName;
      }
    } catch (error) {
      const connectionId = knownConnectionId ?? "unknown";
      report.connectionId = connectionId;
      if (error instanceof NotionAuthError) {
        await setConnectionStatus(db, { tenantId, connectionId }, "blocked", error.message);
        report.outcome = "blocked";
        report.error = error.message;
        report.requests = budget.requests;
        return report;
      }
      if (error instanceof NotionRateLimitedError) {
        // Respect the cooldown even before the connection is fully identified.
        let until: Date | null = null;
        if (knownConnectionId) {
          const key = error.scope === "workspace" && workspaceId ? `notion:workspace:${workspaceId}` : error.scope === "endpoint" ? `notion:bot:${knownConnectionId}:endpoint:${error.endpoint}` : `notion:bot:${knownConnectionId}`;
          until = await recordRateLimited(db, key, { retryAfterMs: error.retryAfterMs, status: error.status, reason: error.message, defaultBackoffMs: DEFAULT_RATE_LIMIT_BACKOFF_MS });
        }
        return { ...report, outcome: "deferred", requests: budget.requests, error: error.message, ...(until ? { deferredUntil: until.toISOString() } : {}) };
      }
      if (!knownConnectionId) {
        report.outcome = "error";
        report.error = error instanceof Error ? error.message : String(error);
        report.requests = budget.requests;
        return report;
      }
    }
  }
  const connectionId = botId ?? workspaceId ?? "default";
  const scope: Scope = { tenantId, connectionId };
  report.connectionId = connectionId;
  report.workspaceId = workspaceId;
  await upsertConnection(db, tenantId, {
    connectionId,
    workspaceId,
    workspaceName,
    botId,
    authMode: str(meta.auth_mode),
    owner: meta.owner ?? null,
    bot,
  });

  const connKey = `notion:bot:${connectionId}`;
  const wsKey = workspaceId ? `notion:workspace:${workspaceId}` : null;
  await ensureSyncState(db, scope, connKey, wsKey);
  const blocked = await blockedUntil(db, connKey, wsKey);
  if (blocked) return { ...report, outcome: "deferred", deferredUntil: blocked.toISOString(), requests: budget.requests };
  const owner = options.leaseOwner ?? `${hostname().slice(0, 60)}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const leaseSeconds = options.leaseSeconds ?? 600;
  if (!(await acquireQuotaLease(db, connKey, owner, leaseSeconds))) return { ...report, outcome: "lease_busy", requests: budget.requests };

  let items = 0;
  try {
    let state = (await getSyncState(db, scope))!;
    const fullEvery = options.fullScanIntervalMs ?? envInt("NOTION_SOURCE_FULL_SCAN_INTERVAL_MS", 24 * 3600_000);
    if (state.generation === 0) await beginGeneration(db, scope, "initial");
    else if (state.generation_phase === "closed" && Date.now() - new Date(String(state.generation_started_at)).getTime() >= fullEvery) {
      await beginGeneration(db, scope, "scheduled");
    }
    state = (await getSyncState(db, scope))!;
    const ctx: Ctx = {
      db,
      scope,
      client,
      budget,
      generation: state.generation,
      connKey,
      wsKey,
      opts: {
        pageSize: Math.max(1, Math.min(100, options.pageSize ?? 100)),
        blockComments: options.blockComments ?? process.env.NOTION_SOURCE_BLOCK_COMMENTS !== "0",
        blockCommentRefreshMs: options.blockCommentRefreshMs ?? 7 * 24 * 3600_000,
        maxFileBytes: options.maxFileBytes ?? envInt("NOTION_SOURCE_MAX_FILE_BYTES", 256 * 1024 * 1024),
        maxItemAttempts: options.maxItemAttempts ?? 5,
        maxFileAttempts: options.maxFileAttempts ?? 5,
        deltaOverlapMs: options.deltaOverlapMs ?? 10 * 60_000,
      },
    };
    await maybeArmDelta(ctx, state, options.deltaIntervalMs ?? 60_000);

    for (;;) {
      if (budget.exhausted) break;
      const batch = await nextWork(db, scope, 25);
      if (!batch.length) {
        if (!(await advanceGeneration(ctx))) break;
        continue;
      }
      let progressed = false;
      for (const item of batch) {
        if (budget.exhausted) break;
        items += 1;
        if (await processItem(ctx, item)) progressed = true;
        await options.heartbeat?.();
        if (items % 20 === 0 && !(await renewQuotaLease(db, connKey, owner, leaseSeconds))) throw new Error("notion sweep lease lost");
      }
      // Only deferred finalizers were due: their walks wait for items that are not due yet.
      if (!progressed) break;
    }
    await recordRunOutcome(db, scope, { ok: true });
    await clearRateStreak(db, [connKey, ...(wsKey ? [wsKey] : [])]);
    const after = (await getSyncState(db, scope))!;
    return { ...report, requests: budget.requests, items, generation: after.generation, phase: after.generation_phase };
  } catch (error) {
    if (error instanceof NotionRateLimitedError) {
      const key = error.scope === "workspace" && wsKey ? wsKey : error.scope === "endpoint" ? `${connKey}:endpoint:${error.endpoint}` : connKey;
      const until = await recordRateLimited(db, key, { retryAfterMs: error.retryAfterMs, status: error.status, reason: error.message, defaultBackoffMs: DEFAULT_RATE_LIMIT_BACKOFF_MS });
      await recordRunOutcome(db, scope, { ok: false, error: `rate limited (${error.scope}) until ${until.toISOString()}` });
      return { ...report, outcome: "deferred", requests: budget.requests, items, deferredUntil: until.toISOString() };
    }
    if (error instanceof NotionAuthError) {
      await setConnectionStatus(db, scope, "blocked", error.message);
      await recordRunOutcome(db, scope, { ok: false, error: error.message, blockedCode: error.code ?? "auth", blockedReason: error.message });
      return { ...report, outcome: "blocked", requests: budget.requests, items, error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    await recordRunOutcome(db, scope, { ok: false, error: message });
    return { ...report, outcome: "error", requests: budget.requests, items, error: message };
  } finally {
    await releaseQuotaLease(db, connKey, owner);
  }
}

async function blockedUntil(db: DbExecutor, connKey: string, wsKey: string | null): Promise<Date | null> {
  const direct = await quotaBlockedUntil(db, [connKey, ...(wsKey ? [wsKey] : [])]);
  const endpoint = rowsOf<{ until: unknown }>(await db.execute(sql`
    SELECT max(blocked_until) AS until FROM notion_source_quota WHERE quota_key LIKE ${`${connKey}:endpoint:%`} AND blocked_until > now()
  `))[0];
  const e = endpoint?.until ? new Date(String(endpoint.until)) : null;
  if (!direct) return e;
  if (!e) return direct;
  return direct > e ? direct : e;
}

async function beginGeneration(db: DbExecutor, scope: Scope, reason: string): Promise<void> {
  const g = await startGeneration(db, scope, reason);
  await enqueueWork(db, scope, g, [
    { itemKey: "search:page", kind: "search", priority: PRIORITY.search, payload: { objectType: "page", cursor: null } },
    { itemKey: "search:data_source", kind: "search", priority: PRIORITY.search, payload: { objectType: "data_source", cursor: null } },
  ], { restart: true });
}

async function maybeArmDelta(ctx: Ctx, state: { delta_watermark: unknown; delta_checked_at: unknown; generation: number; full_complete_generation: number | null }, intervalMs: number): Promise<void> {
  // Before the first full pass closed, the full listing itself is the change feed.
  if (state.delta_watermark === null) return;
  const current = await workState(ctx.db, ctx.scope, "delta");
  if (current?.state === "pending") return;
  const checked = state.delta_checked_at ? new Date(String(state.delta_checked_at)).getTime() : 0;
  if (Date.now() - checked < intervalMs) return;
  const since = state.delta_watermark ? new Date(String(state.delta_watermark)).toISOString() : new Date(Date.now() - 24 * 3600_000).toISOString();
  await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: "delta", kind: "delta", priority: PRIORITY.delta, payload: { since, objectType: "page", cursor: null, maxSeen: null } }], { restart: true });
}

/** scan -> confirm -> closed. Returns true when it enqueued more work. */
async function advanceGeneration(ctx: Ctx): Promise<boolean> {
  const state = (await getSyncState(ctx.db, ctx.scope))!;
  const g = state.generation;
  if (state.generation_phase === "closed") return false;
  if ((await pendingItems(ctx.db, ctx.scope, SCAN_KINDS)) > 0) return false;
  if (state.generation_phase === "scan") {
    const missing = await listNodes(ctx.db, ctx.scope, { live: true, unseenBefore: g });
    await setGenerationPhase(ctx.db, ctx.scope, g, "confirm", false);
    if (missing.length) {
      await enqueueWork(ctx.db, ctx.scope, g, missing.map((n) => ({
        itemKey: `confirm:${n.object_type}:${n.object_id}`,
        kind: "confirm",
        priority: PRIORITY.confirm,
        payload: { objectType: n.object_type, id: n.object_id },
      })), { restart: true });
      return true;
    }
  }
  if ((await pendingItems(ctx.db, ctx.scope, [...SCAN_KINDS, "confirm"])) > 0) return false;
  const after = (await getSyncState(ctx.db, ctx.scope))!;
  const searches = await Promise.all(["search:page", "search:data_source"].map((k) => workState(ctx.db, ctx.scope, k)));
  const complete = after.generation_failed_items === 0 && searches.every((w) => w?.state === "done" && w.generation === g);
  await setGenerationPhase(ctx.db, ctx.scope, g, "closed", complete);
  // Changes since the first pass started are the delta's job from now on (even when that pass had failures).
  // Watermark on Notion's clock: the earlier of the pass start and the newest last_edited_time observed.
  if (!after.delta_watermark) {
    const newest = rowsOf<{ t: unknown }>(await ctx.db.execute(sql`
      SELECT max(last_edited_time) AS t FROM notion_source_nodes WHERE tenant_id = ${ctx.scope.tenantId} AND connection_id = ${ctx.scope.connectionId}
    `))[0]?.t;
    const started = new Date(String(after.generation_started_at));
    const observed = newest ? new Date(String(newest)) : started;
    await setDeltaWatermark(ctx.db, ctx.scope, observed < started ? observed : started);
  }
  return false;
}

// ------------------------------------------------------------------ item dispatch

type ItemOutcome = { state: "done" | "inaccessible"; outcome?: Record<string, unknown> } | { state: "deferred" };

/** Returns false when the item only deferred itself (no progress). */
async function processItem(ctx: Ctx, item: WorkRow): Promise<boolean> {
  try {
    const outcome = await runItem(ctx, item);
    if (outcome.state === "deferred") return false;
    if (outcome.state === "inaccessible") await bumpGenerationCounter(ctx.db, ctx.scope, item.generation, "inaccessible");
    await finishWork(ctx.db, ctx.scope, item.item_key, outcome.state, outcome.outcome ?? null);
    return true;
  } catch (error) {
    if (error instanceof Yield) return true;
    if (error instanceof NotionRateLimitedError || error instanceof NotionAuthError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const attempts = await retryWorkLater(ctx.db, ctx.scope, item.item_key, message, Math.min(3600_000, 30_000 * 2 ** item.attempts));
    if (attempts >= ctx.opts.maxItemAttempts) {
      await finishWork(ctx.db, ctx.scope, item.item_key, "failed", null, message);
      await bumpGenerationCounter(ctx.db, ctx.scope, item.generation, "failed");
      if (item.page_id && item.kind !== "finalize") await enqueueFinalize(ctx, item.page_id);
    }
    return true;
  }
}

async function runItem(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const p = item.payload;
  switch (item.kind) {
    case "search":
      return runSearch(ctx, item);
    case "delta":
      return runDelta(ctx, item);
    case "node":
    case "confirm":
      return fetchNode(ctx, p.objectType as NodeType, String(p.id), item.kind === "confirm");
    case "walk":
      return startWalk(ctx, String(p.pageId));
    case "children":
      return listChildren(ctx, item);
    case "comments":
      return listComments(ctx, item);
    case "comment_confirm":
      return confirmComment(ctx, String(p.commentId), String(p.pageId));
    case "props":
      return hydrateProperties(ctx, item);
    case "query":
      return queryDataSource(ctx, item);
    case "download":
      return refetchFile(ctx, item);
    case "finalize":
      return finalizePage(ctx, item);
    default:
      throw new Error(`unknown notion work item kind ${item.kind}`);
  }
}

function resultsOf(body: unknown): JsonObject[] {
  return isRecord(body) && Array.isArray(body.results) ? body.results.filter(isRecord) : [];
}

function nextCursorOf(body: unknown): string | null {
  return isRecord(body) && body.has_more === true && typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : null;
}

function isBadCursor(error: unknown, cursor: string | null): boolean {
  return cursor !== null && error instanceof NotionApiError && error.status === 400 && error.code === "validation_error";
}

/**
 * Page through a cursor listing. `call(cursor)` fetches one page; `onPage` stores it; the
 * cursor is checkpointed after `onPage`, so a yield or crash resumes on the following page.
 * An expired/invalid cursor (400 validation_error) restarts the listing from the start
 * (re-storing is idempotent). Returns false when `call` answered a tolerated status.
 */
async function pageThrough(
  ctx: Ctx,
  item: WorkRow,
  call: (cursor: string | null) => Promise<NotionResponse>,
  onPage: (results: JsonObject[], body: unknown, payload: Record<string, unknown>) => Promise<boolean | void>,
): Promise<{ status: number; pages: number }> {
  let pages = 0;
  for (;;) {
    const cursor = str(item.payload.cursor);
    let res: NotionResponse;
    try {
      res = await call(cursor);
    } catch (error) {
      if (isBadCursor(error, cursor)) {
        item.payload = { ...item.payload, cursor: null, position: 0, restarts: Number(item.payload.restarts ?? 0) + 1 };
        await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
        if (Number(item.payload.restarts) > 3) throw error;
        continue;
      }
      throw error;
    }
    if (res.status >= 300) return { status: res.status, pages };
    pages += 1;
    const stop = await onPage(resultsOf(res.body), res.body, item.payload);
    const next = stop === true ? null : nextCursorOf(res.body);
    item.payload = { ...item.payload, cursor: next };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
    if (!next) return { status: res.status, pages };
  }
}

// ------------------------------------------------------------------ discovery

async function runSearch(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const value = item.payload.objectType === "data_source" ? "data_source" : "page";
  let results = 0;
  await pageThrough(ctx, item, (cursor) => apiPost(ctx, "/search", searchBody(ctx, value, cursor)), async (rows) => {
    for (const raw of rows) {
      results += 1;
      await handleDiscovered(ctx, raw, "search");
    }
  });
  return { state: "done", outcome: { results } };
}

function searchBody(ctx: Ctx, value: string, cursor: string | null): JsonObject {
  return {
    filter: { property: "object", value },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: ctx.opts.pageSize,
    ...(cursor ? { start_cursor: cursor } : {}),
  };
}

/** Newest-first search back to the watermark (minus overlap), pages then data sources. */
async function runDelta(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const since = new Date(String(item.payload.since));
  const floor = since.getTime() - ctx.opts.deltaOverlapMs;
  for (;;) {
    const value = item.payload.objectType === "data_source" ? "data_source" : "page";
    await pageThrough(ctx, item, (cursor) => apiPost(ctx, "/search", searchBody(ctx, value, cursor)), async (rows, _body, payload) => {
      for (const raw of rows) {
        const edited = isoTime(raw.last_edited_time);
        if (edited && new Date(edited).getTime() < floor) return true;
        if (edited && (!payload.maxSeen || edited > String(payload.maxSeen))) payload.maxSeen = edited;
        await handleDiscovered(ctx, raw, "delta");
      }
      return false;
    });
    if (value === "page") {
      item.payload = { ...item.payload, objectType: "data_source", cursor: null };
      await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
      continue;
    }
    break;
  }
  const maxSeen = item.payload.maxSeen ? new Date(String(item.payload.maxSeen)) : since;
  await setDeltaWatermark(ctx.db, ctx.scope, maxSeen);
  return { state: "done", outcome: { watermark: maxSeen.toISOString() } };
}

async function handleDiscovered(ctx: Ctx, raw: JsonObject, via: string): Promise<UpsertNodeResult | null> {
  const type = objectType(raw);
  if (!type || !str(raw.id)) return null;
  if (type === "page") return handlePage(ctx, raw, via);
  if (type === "data_source") return handleDataSource(ctx, raw, via);
  return handleDatabase(ctx, raw);
}

/** Common node capture: files (bytes fetched now), redacted upsert, raw ledger, trash/restore/move bookkeeping. */
async function captureNode(ctx: Ctx, raw: JsonObject): Promise<{ res: UpsertNodeResult; gone: boolean }> {
  const input = nodeInput(raw);
  const res = await upsertNode(ctx.db, ctx.scope, input, ctx.generation);
  if (res.changed) await insertRecord(ctx.db, ctx.scope, input.type, input.id, "observation", input.raw, `/${input.type === "page" ? "pages" : input.type === "data_source" ? "data_sources" : "databases"}/${input.id}`);
  await captureFiles(ctx, nodeFiles(raw), { ownerIds: [input.id], pageId: input.id });
  const gone = input.inTrash || input.isArchived;
  if (gone) {
    const newly = await tombstoneNode(ctx.db, ctx.scope, input.id, input.inTrash ? "notion_trashed" : "notion_archived");
    if (newly) {
      await touchDescendants(ctx.db, ctx.scope, input.id);
      await refreshChildren(ctx, input.id);
    }
  } else if (res.created || res.pathChanged || res.restored) {
    await touchDescendants(ctx.db, ctx.scope, input.id);
  }
  // Placement needs the parent chain: discover unknown parents (404 = not shared, stays top-level).
  const parentNodeType: NodeType | null = input.parentType === "page_id" ? "page" : input.parentType === "data_source_id" ? "data_source" : input.parentType === "database_id" ? "database" : null;
  if (input.parentId && parentNodeType && !(await getNode(ctx.db, ctx.scope, input.parentId))) await enqueueNode(ctx, parentNodeType, input.parentId, "parent");
  // Moved: the old parent lost a child (its child_page / child_database block or row): refresh it
  // even when search does not return it.
  const prev = res.previousParent;
  if (prev?.id) {
    const oldParentPage = prev.type === "block_id" ? (await getBlock(ctx.db, ctx.scope, prev.id))?.page_id ?? null : prev.type === "page_id" ? prev.id : null;
    if (oldParentPage) await enqueueNode(ctx, "page", oldParentPage, "child_moved_away");
    else if (prev.type === "data_source_id") await setNodeFields(ctx.db, ctx.scope, prev.id, { bumpRowsEpoch: true });
  }
  return { res, gone };
}

/** Trash in Notion cascades to subpages / a database's data sources: re-read the direct children now instead of at the next full pass. */
async function refreshChildren(ctx: Ctx, id: string): Promise<void> {
  const kids = rowsOf<{ object_type: NodeType; object_id: string }>(await ctx.db.execute(sql`
    SELECT n.object_type, n.object_id FROM notion_source_nodes n
    WHERE n.tenant_id = ${ctx.scope.tenantId} AND n.connection_id = ${ctx.scope.connectionId} AND n.tombstoned_at IS NULL
      AND (n.parent_id = ${id} OR (n.parent_type = 'block_id' AND n.parent_id IN (
        SELECT b.block_id FROM notion_source_blocks b WHERE b.tenant_id = n.tenant_id AND b.connection_id = n.connection_id AND b.page_id = ${id})))
  `));
  for (const k of kids) await enqueueNode(ctx, k.object_type, k.object_id, "parent_tombstoned");
}

async function handlePage(ctx: Ctx, raw: JsonObject, via: string): Promise<UpsertNodeResult> {
  const { res, gone } = await captureNode(ctx, raw);
  const node = res.row;
  // A data source query bumps its table once at the end; other paths re-export the table per changed row.
  if (via !== "query" && node.parent_type === "data_source_id" && node.parent_id && (res.changed || res.restored)) {
    await setNodeFields(ctx.db, ctx.scope, node.parent_id, { bumpRowsEpoch: true });
  }
  if (gone) return res;
  if (needsWalk(node, res)) {
    await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `walk:${node.object_id}`, kind: "walk", priority: PRIORITY.walk, pageId: null, payload: { pageId: node.object_id, via } }]);
  } else if (via !== "delta" && !(await commentsRefreshedIn(ctx, node))) {
    // Comments do not move last_edited_time: every full pass re-lists page-level comments.
    await enqueueComments(ctx, node.object_id, null, node.walk_epoch);
    await enqueueFinalize(ctx, node.object_id);
  }
  if (res.changed && propertiesNeedingHydration(node.raw).length) {
    await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `props:${node.object_id}`, kind: "props", priority: PRIORITY.props, payload: { pageId: node.object_id, index: 0, cursor: null, collected: {} } }], { restart: true });
  }
  return res;
}

/** Walk when new / edited / restored / not completely walked, or edited within the (minute-granular) window of the last walk. */
export function needsWalk(node: Pick<NodeRow, "walk_status" | "walk_started_at" | "last_edited_time">, res: Pick<UpsertNodeResult, "created" | "edited" | "restored">): boolean {
  if (res.created || res.edited || res.restored) return true;
  if (node.walk_status !== "complete") return node.walk_status !== "walking";
  const started = node.walk_started_at ? new Date(String(node.walk_started_at)).getTime() : 0;
  const edited = node.last_edited_time ? new Date(String(node.last_edited_time)).getTime() : 0;
  return edited + 120_000 > started;
}

async function commentsRefreshedIn(ctx: Ctx, node: NodeRow): Promise<boolean> {
  const w = await workState(ctx.db, ctx.scope, `comments:${node.object_id}:page`);
  return !!w && w.generation >= ctx.generation;
}

async function handleDataSource(ctx: Ctx, raw: JsonObject, via: string): Promise<UpsertNodeResult> {
  const { res, gone } = await captureNode(ctx, raw);
  if (gone) return res;
  const q = await workState(ctx.db, ctx.scope, `query:${res.row.object_id}`);
  const queriedThisPass = !!q && q.generation >= ctx.generation && (q.state === "done" || q.state === "pending");
  if (res.changed || res.restored || res.row.query_status !== "complete" || (via !== "delta" && !queriedThisPass)) {
    await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `query:${res.row.object_id}`, kind: "query", priority: PRIORITY.query, payload: { dataSourceId: res.row.object_id, cursor: null, windowStart: null, changed: false } }], { restart: !queriedThisPass });
  }
  return res;
}

async function handleDatabase(ctx: Ctx, raw: JsonObject): Promise<UpsertNodeResult> {
  const { res, gone } = await captureNode(ctx, raw);
  if (gone) return res;
  for (const ds of Array.isArray(raw.data_sources) ? raw.data_sources.filter(isRecord) : []) {
    const id = str(ds.id);
    if (!id) continue;
    const known = await getNode(ctx.db, ctx.scope, normId(id));
    if (!known || known.tombstoned_at || (known.seen_generation ?? 0) < ctx.generation) await enqueueNode(ctx, "data_source", normId(id), "database");
  }
  return res;
}

async function enqueueNode(ctx: Ctx, type: NodeType, id: string, reason: string): Promise<void> {
  await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `node:${type}:${id}`, kind: "node", priority: PRIORITY.node, payload: { objectType: type, id, reason } }]);
}

async function enqueueComments(ctx: Ctx, pageId: string, blockId: string | null, epoch: number): Promise<void> {
  await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{
    itemKey: `comments:${pageId}:${blockId ?? "page"}`,
    kind: "comments",
    priority: PRIORITY.comments,
    pageId,
    payload: { pageId, blockId, epoch, cursor: null, listed: [] },
  }], { restart: true });
}

async function enqueueFinalize(ctx: Ctx, pageId: string): Promise<void> {
  await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `finalize:${pageId}`, kind: "finalize", priority: PRIORITY.finalize, payload: { pageId } }]);
}

/** GET a node by id. `confirm`: a 404 tombstones it (Notion answers 404 for deleted and for unshared objects). */
async function fetchNode(ctx: Ctx, type: NodeType, id: string, confirm: boolean): Promise<ItemOutcome> {
  const path = type === "page" ? `/pages/${id}` : type === "data_source" ? `/data_sources/${id}` : `/databases/${id}`;
  const res = await apiGet(ctx, path, [404, 403]);
  if (res.status === 200 && isRecord(res.body)) {
    await handleDiscovered(ctx, res.body, confirm ? "confirm" : "node");
    return { state: "done", outcome: { status: 200 } };
  }
  const known = await getNode(ctx.db, ctx.scope, id);
  if (res.status === 404) {
    if (known && !known.tombstoned_at) {
      await tombstoneNode(ctx.db, ctx.scope, id, "notion_not_found_or_unshared");
      await touchDescendants(ctx.db, ctx.scope, id);
      if (known.object_type === "page" && known.parent_type === "data_source_id" && known.parent_id) await setNodeFields(ctx.db, ctx.scope, known.parent_id, { bumpRowsEpoch: true });
    }
    return { state: "done", outcome: { status: 404 } };
  }
  if (known) await markNodeInaccessible(ctx.db, ctx.scope, id, `HTTP ${res.status} ${isRecord(res.body) ? String(res.body.code ?? "") : ""}`.trim());
  return { state: "inaccessible", outcome: { status: res.status } };
}

// ------------------------------------------------------------------ page walk

async function startWalk(ctx: Ctx, pageId: string): Promise<ItemOutcome> {
  const node = await getNode(ctx.db, ctx.scope, pageId);
  if (!node || node.tombstoned_at || node.object_type !== "page") return { state: "done", outcome: { skipped: true } };
  const epoch = node.walk_epoch + 1;
  await setNodeFields(ctx.db, ctx.scope, pageId, { walkEpoch: epoch, walkStartedAt: new Date(), walkStatus: "walking", walkError: null });
  await enqueueWork(ctx.db, ctx.scope, ctx.generation, [
    { itemKey: `children:${pageId}`, kind: "children", priority: PRIORITY.children, pageId, payload: { pageId, parentId: pageId, epoch, depth: 0, cursor: null, position: 0 } },
    { itemKey: `finalize:${pageId}`, kind: "finalize", priority: PRIORITY.finalize, payload: { pageId } },
  ], { restart: true });
  await enqueueComments(ctx, pageId, null, epoch);
  return { state: "done", outcome: { epoch } };
}

async function listChildren(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const p = item.payload;
  const pageId = String(p.pageId);
  const parentId = String(p.parentId);
  const epoch = Number(p.epoch);
  const depth = Number(p.depth ?? 0);
  const page = await getNode(ctx.db, ctx.scope, pageId);
  if (!page || page.tombstoned_at || page.walk_epoch !== epoch) return { state: "done", outcome: { stale: true } };
  let listed = 0;
  const r = await pageThrough(
    ctx,
    item,
    (cursor) => apiGet(ctx, `/blocks/${parentId}/children?page_size=${ctx.opts.pageSize}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`, [404]),
    async (rows, _body, payload) => {
      const base = Number(payload.position ?? 0);
      const inputs = rows.map((raw, i) => blockInput(raw, parentId, base + i, depth));
      const { changed, created } = await upsertBlocks(ctx.db, ctx.scope, pageId, epoch, inputs);
      const changedSet = new Set(changed);
      const follow: WorkItem[] = [];
      for (const raw of rows) {
        const id = normId(String(raw.id));
        const type = str(raw.type) ?? "";
        await captureFiles(ctx, blockFiles(raw, pageId), { ownerIds: [id], pageId });
        if (walkableChildren(raw)) {
          follow.push({ itemKey: `children:${id}`, kind: "children", priority: PRIORITY.children, pageId, payload: { pageId, parentId: id, epoch, depth: depth + 1, cursor: null, position: 0 } });
        }
        if (type === "child_page" || type === "child_database") {
          const childType: NodeType = type === "child_page" ? "page" : "database";
          const known = await getNode(ctx.db, ctx.scope, id);
          if (!known || known.tombstoned_at || (known.seen_generation ?? 0) < ctx.generation || changedSet.has(id)) await enqueueNode(ctx, childType, id, "block");
        }
        if (ctx.opts.blockComments && type !== "child_page" && type !== "child_database") {
          const b = changedSet.has(id) ? null : await getBlock(ctx.db, ctx.scope, id);
          const checked = b?.comments_checked_at ? new Date(String(b.comments_checked_at)).getTime() : 0;
          if (changedSet.has(id) || Date.now() - checked > ctx.opts.blockCommentRefreshMs) {
            follow.push({ itemKey: `comments:${pageId}:${id}`, kind: "comments", priority: PRIORITY.comments, pageId, payload: { pageId, blockId: id, epoch, cursor: null, listed: [] } });
          }
        }
      }
      if (follow.length) await enqueueWork(ctx.db, ctx.scope, ctx.generation, follow, { restart: true });
      payload.position = base + rows.length;
      listed += rows.length;
      void created;
    },
  );
  if (r.status === 404) {
    // The page itself vanished mid-walk: confirm it; a nested block deleted mid-walk simply has no children now.
    if (parentId === pageId) {
      await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `confirm:page:${pageId}`, kind: "confirm", priority: PRIORITY.confirm, payload: { objectType: "page", id: pageId } }], { restart: true });
      return { state: "inaccessible", outcome: { status: 404 } };
    }
    return { state: "done", outcome: { status: 404 } };
  }
  return { state: "done", outcome: { listed } };
}

async function listComments(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const p = item.payload;
  const pageId = String(p.pageId);
  const blockId = str(p.blockId);
  const target = blockId ?? pageId;
  const page = await getNode(ctx.db, ctx.scope, pageId);
  if (!page || page.tombstoned_at) return { state: "done", outcome: { skipped: true } };
  let changedAny = Boolean(p.changedAny);
  const r = await pageThrough(
    ctx,
    item,
    (cursor) => apiGet(ctx, `/comments?block_id=${encodeURIComponent(target)}&page_size=${ctx.opts.pageSize}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`, [403, 404]),
    async (rows, _body, payload) => {
      const listed = new Set<string>(Array.isArray(payload.listed) ? (payload.listed as string[]) : []);
      const inputs = [];
      for (const raw of rows) {
        const id = normId(String(raw.id));
        listed.add(id);
        await captureFiles(ctx, commentFiles(raw, pageId), { ownerIds: [id], pageId });
        const red = redact(raw);
        inputs.push({ id, discussionId: str(raw.discussion_id), createdTime: isoTime(raw.created_time), lastEditedTime: isoTime(raw.last_edited_time), raw: red });
      }
      const changed = await upsertComments(ctx.db, ctx.scope, pageId, blockId, inputs);
      for (const id of changed) {
        const c = inputs.find((x) => x.id === id)!;
        await insertRecord(ctx.db, ctx.scope, "comment", id, "observation", c.raw, `/comments?block_id=${target}`);
      }
      if (changed.length) changedAny = true;
      payload.listed = [...listed];
      payload.changedAny = changedAny;
    },
  );
  if (r.status === 403) {
    await noteCapability(ctx.db, ctx.scope, "comments", "restricted_resource");
    if (!blockId) await setNodeFields(ctx.db, ctx.scope, pageId, { commentsStatus: "forbidden", commentsCheckedAt: new Date() });
    return { state: "inaccessible", outcome: { status: 403 } };
  }
  if (r.status === 404) return { state: "done", outcome: { status: 404 } };
  await noteCapability(ctx.db, ctx.scope, "comments", null);
  const listed = new Set<string>(Array.isArray(item.payload.listed) ? (item.payload.listed as string[]) : []);
  const missing = await missingOpenComments(ctx.db, ctx.scope, pageId, blockId, listed);
  if (missing.length) {
    await enqueueWork(ctx.db, ctx.scope, ctx.generation, missing.map((id) => ({
      itemKey: `comment_confirm:${id}`, kind: "comment_confirm", priority: PRIORITY.commentConfirm, pageId, payload: { commentId: id, pageId },
    })), { restart: true });
  }
  if (blockId) await markBlockCommentsChecked(ctx.db, ctx.scope, blockId);
  else await setNodeFields(ctx.db, ctx.scope, pageId, { commentsStatus: "complete", commentsCheckedAt: new Date() });
  if (changedAny || missing.length) await enqueueFinalize(ctx, pageId);
  return { state: "done", outcome: { listed: listed.size, missing: missing.length } };
}

/** A comment no longer listed: 200 = resolved (List comments returns only open ones), 404 = deleted. */
async function confirmComment(ctx: Ctx, commentId: string, pageId: string): Promise<ItemOutcome> {
  const res = await apiGet(ctx, `/comments/${commentId}`, [404, 403]);
  let changed = false;
  if (res.status === 200 && isRecord(res.body)) {
    const red = redact(res.body);
    changed = await setCommentStatus(ctx.db, ctx.scope, commentId, "resolved", null, red);
    if (changed) await insertRecord(ctx.db, ctx.scope, "comment", commentId, "observation", red, `/comments/${commentId}`);
  } else if (res.status === 404) {
    changed = await setCommentStatus(ctx.db, ctx.scope, commentId, "deleted", "not listed and GET /v1/comments/{id} returned 404");
  } else {
    return { state: "inaccessible", outcome: { status: res.status } };
  }
  if (changed) await enqueueFinalize(ctx, pageId);
  return { state: "done", outcome: { status: res.status } };
}

/**
 * Close a page walk / comment refresh. Waits while listings of the page are pending; tombstones
 * unlisted blocks only when every listing of the current walk completed; appends the page tree
 * to the raw ledger and re-exports the page when its tree changed.
 */
async function finalizePage(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const pageId = String(item.payload.pageId);
  const node = await getNode(ctx.db, ctx.scope, pageId);
  if (!node || node.tombstoned_at) return { state: "done", outcome: { skipped: true } };
  const items = await pageWalkItems(ctx.db, ctx.scope, pageId, node.walk_epoch);
  if (items.pending > 0) {
    await deferWork(ctx.db, ctx.scope, item.item_key, 1_000);
    return { state: "deferred" };
  }
  const walking = node.walk_status === "walking";
  let removed: string[] = [];
  let status = node.walk_status;
  if (walking) {
    if (items.failed === 0) {
      removed = await tombstoneUnseenBlocks(ctx.db, ctx.scope, pageId, node.walk_epoch, "removed_from_page");
      if (removed.length) {
        await tombstoneFiles(ctx.db, ctx.scope, { pageId, ownerIds: removed }, "block_removed");
        // A child page / database whose block vanished was trashed, deleted or moved: re-read it now.
        for (const id of removed) {
          const child = await getNode(ctx.db, ctx.scope, id);
          if (child && !child.tombstoned_at) await enqueueNode(ctx, child.object_type, id, "block_removed");
        }
      }
      status = "complete";
    } else {
      status = "partial";
    }
  }
  const blocks = await listPageBlocks(ctx.db, ctx.scope, pageId);
  const comments = await listPageComments(ctx.db, ctx.scope, pageId);
  const tree = pageTreeStructure(node, blocks, comments);
  const treeSha = contentSha(tree);
  const changed = treeSha !== node.tree_sha256;
  if (changed) await insertRecord(ctx.db, ctx.scope, "page", pageId, "tree", tree, null, treeSha);
  await setNodeFields(ctx.db, ctx.scope, pageId, {
    ...(changed ? { treeSha256: treeSha, bumpContentEpoch: true } : {}),
    ...(walking ? { walkStatus: status, walkedAt: new Date(), walkError: items.failed ? `${items.failed} listing(s) of this walk failed; unlisted blocks were kept` : null } : {}),
  });
  // Pages placed under blocks of this page that were captured only now move under it.
  if (walking) {
    const placed = rowsOf<{ object_id: string }>(await ctx.db.execute(sql`
      SELECT n.object_id FROM notion_source_nodes n JOIN notion_source_blocks b
        ON b.tenant_id = n.tenant_id AND b.connection_id = n.connection_id AND b.block_id = n.parent_id
      WHERE n.tenant_id = ${ctx.scope.tenantId} AND n.connection_id = ${ctx.scope.connectionId} AND n.parent_type = 'block_id'
        AND b.page_id = ${pageId} AND b.first_captured_at >= ${new Date(String(node.walk_started_at ?? new Date(0).toISOString())).toISOString()}::timestamptz
    `));
    for (const p of placed) {
      await ctx.db.execute(sql`UPDATE notion_source_nodes SET path_epoch = path_epoch + 1 WHERE tenant_id = ${ctx.scope.tenantId} AND connection_id = ${ctx.scope.connectionId} AND object_id = ${p.object_id}`);
      await touchDescendants(ctx.db, ctx.scope, p.object_id);
    }
  }
  return { state: "done", outcome: { status, blocks: blocks.length, removed: removed.length, treeChanged: changed } };
}

/** Ordered tree of content hashes: the ledger record of one page state (export composes the exact raws). */
export function pageTreeStructure(node: Pick<NodeRow, "object_id" | "raw_sha256">, blocks: ReadonlyArray<{ block_id: string; parent_id: string; position: number; raw_sha256: string }>, comments: ReadonlyArray<{ comment_id: string; block_id: string | null; raw_sha256: string; status: string }>): Record<string, unknown> {
  const byParent = new Map<string, Array<{ block_id: string; position: number; raw_sha256: string }>>();
  for (const b of blocks) byParent.set(b.parent_id, [...(byParent.get(b.parent_id) ?? []), b]);
  const seen = new Set<string>();
  const build = (parent: string): unknown[] => (byParent.get(parent) ?? [])
    .sort((a, b) => a.position - b.position || a.block_id.localeCompare(b.block_id))
    .filter((b) => !seen.has(b.block_id) && seen.add(b.block_id))
    .map((b) => ({ id: b.block_id, sha: b.raw_sha256, children: build(b.block_id) }));
  return {
    schema: "notion-source/tree@1",
    page: { id: node.object_id, sha: node.raw_sha256 },
    blocks: build(node.object_id),
    comments: comments.map((c) => ({ id: c.comment_id, blockId: c.block_id, sha: c.raw_sha256, status: c.status })),
  };
}

// ------------------------------------------------------------------ properties

/** Paginated property values (GET /pages/{id}/properties/{property_id}), cursor-checkpointed per property. */
async function hydrateProperties(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const pageId = String(item.payload.pageId);
  const node = await getNode(ctx.db, ctx.scope, pageId);
  if (!node || node.tombstoned_at) return { state: "done", outcome: { skipped: true } };
  const props = propertiesNeedingHydration(node.raw);
  const collected = (isRecord(item.payload.collected) ? item.payload.collected : {}) as Record<string, unknown>;
  let failed = 0;
  for (let index = Number(item.payload.index ?? 0); index < props.length; index++) {
    const prop = props[index]!;
    const acc = isRecord(collected[prop.id]) ? collected[prop.id] as JsonObject : { results: [] as unknown[] };
    let status = 0;
    const r = await pageThrough(
      ctx,
      item,
      (cursor) => apiGet(ctx, `/pages/${pageId}/properties/${encodeURIComponent(prop.id)}?page_size=${ctx.opts.pageSize}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`, [400, 403, 404]),
      async (_rows, body) => {
        if (isRecord(body) && Array.isArray(body.results)) {
          acc.results = [...(acc.results as unknown[]), ...body.results.map((x) => redact(x))];
          if (isRecord(body.property_item)) acc.property_item = redact(body.property_item);
        } else if (isRecord(body)) {
          acc.results = [redact(body)];
          acc.property_item = redact(body);
        }
        collected[prop.id] = acc;
        item.payload = { ...item.payload, collected };
      },
    );
    status = r.status;
    if (status >= 300) {
      failed += 1;
      collected[prop.id] = { ...acc, error: status };
    } else {
      collected[prop.id] = { ...acc, complete: true };
    }
    item.payload = { ...item.payload, index: index + 1, cursor: null, collected };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
  }
  await setNodeFields(ctx.db, ctx.scope, pageId, { hydratedProperties: collected, propertiesStatus: failed ? "partial" : "complete" });
  if (node.parent_type === "data_source_id" && node.parent_id) await setNodeFields(ctx.db, ctx.scope, node.parent_id, { bumpRowsEpoch: true });
  return { state: "done", outcome: { properties: props.length, failed } };
}

// ------------------------------------------------------------------ data sources

/**
 * Query a data source to exhaustion, sorted by created_time ascending; when Notion caps a
 * query (request_status incomplete / query_result_limit_reached, 10,000 results) the next
 * window starts at the last row's created_time (duplicates at the boundary are idempotent).
 */
async function queryDataSource(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const dsId = String(item.payload.dataSourceId);
  const ds = await getNode(ctx.db, ctx.scope, dsId);
  if (!ds || ds.tombstoned_at) return { state: "done", outcome: { skipped: true } };
  let rows = 0;
  let unsplittable = false;
  for (;;) {
    let capped = false;
    let lastCreated: string | null = str(item.payload.lastCreated);
    const windowStart = str(item.payload.windowStart);
    const r = await pageThrough(
      ctx,
      item,
      (cursor) => apiPost(ctx, `/data_sources/${dsId}/query`, {
        page_size: ctx.opts.pageSize,
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        ...(windowStart ? { filter: { timestamp: "created_time", created_time: { on_or_after: windowStart } } } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      }, [404, 403]),
      async (results, body, payload) => {
        for (const raw of results) {
          rows += 1;
          const created = isoTime(raw.created_time);
          if (created) lastCreated = created;
          const res = await handleDiscovered(ctx, raw, "query");
          if (res && (res.changed || res.restored)) payload.changed = true;
        }
        if (isRecord(body) && isRecord(body.request_status) && body.request_status.type === "incomplete") {
          capped = true;
          payload.capped = true;
        }
        payload.lastCreated = lastCreated;
      },
    );
    if (r.status === 404 || r.status === 403) {
      await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{ itemKey: `confirm:data_source:${dsId}`, kind: "confirm", priority: PRIORITY.confirm, payload: { objectType: "data_source", id: dsId } }], { restart: true });
      await setNodeFields(ctx.db, ctx.scope, dsId, { queryStatus: `failed:${r.status}` });
      return { state: "inaccessible", outcome: { status: r.status } };
    }
    capped = capped || item.payload.capped === true;
    if (!capped) break;
    if (!lastCreated || lastCreated === windowStart) {
      unsplittable = true;
      break;
    }
    item.payload = { ...item.payload, windowStart: lastCreated, cursor: null, capped: false };
    await checkpointWork(ctx.db, ctx.scope, item.item_key, item.payload);
  }
  await setNodeFields(ctx.db, ctx.scope, dsId, {
    queryStatus: unsplittable ? "partial:query_result_limit_reached_within_one_minute" : "complete",
    queryCheckedAt: new Date(),
    ...(item.payload.changed ? { bumpRowsEpoch: true } : {}),
  });
  return { state: "done", outcome: { rows, unsplittable } };
}

// ------------------------------------------------------------------ files

async function captureFiles(ctx: Ctx, files: readonly ExtractedFile[], owner: { ownerIds: readonly string[]; pageId: string }): Promise<void> {
  for (const f of files) {
    const { url, ...ref } = f;
    const { row, needsFetch } = await upsertFileRef(ctx.db, ctx.scope, ref);
    if (needsFetch && url && row.attempts < ctx.opts.maxFileAttempts) await downloadInto(ctx, row.row_key, row.file_key, url, f);
  }
  await tombstoneFiles(ctx.db, ctx.scope, { pageId: owner.pageId, ownerIds: owner.ownerIds, keepKeys: new Set(files.map((f) => f.fileKey)) }, "file_no_longer_referenced");
}

/** Fetch the bytes now (the signed URL expires after an hour and is never stored). */
async function downloadInto(ctx: Ctx, rowKey: string, fileKey: string, url: string, ref: ExtractedFile): Promise<void> {
  const writer = new ChunkWriter(ctx.db, ctx.scope.tenantId);
  try {
    const got = await ctx.client.downloadFile(url, ctx.opts.maxFileBytes, (piece) => writer.write(piece));
    await writer.finish(got.sha256, got.size, got.mediaType);
    await setFileStored(ctx.db, ctx.scope.tenantId, rowKey, { sha256: got.sha256, size: got.size, mediaType: got.mediaType ?? guessMediaType(ref.name) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof NotionFileError && (error.kind === "too_large" || error.kind === "host_refused" || error.kind === "redirect_refused")) {
      await setFileFailed(ctx.db, ctx.scope.tenantId, rowKey, error.kind === "too_large" ? "too_large" : "host_refused", message);
      return;
    }
    const attempts = await setFileFailed(ctx.db, ctx.scope.tenantId, rowKey, "failed", message);
    if (attempts < ctx.opts.maxFileAttempts) {
      // Retry later with a FRESH signed URL from the owner object (the work item holds no URL).
      await enqueueWork(ctx.db, ctx.scope, ctx.generation, [{
        itemKey: `download:${fileKey}`,
        kind: "download",
        priority: PRIORITY.download,
        payload: { fileKey, ownerType: ref.ownerType, ownerId: ref.ownerId, pageId: ref.pageId, slot: ref.slot },
      }], { restart: true });
      await deferWork(ctx.db, ctx.scope, `download:${fileKey}`, Math.min(3600_000, 30_000 * 2 ** attempts));
    }
  }
}

async function refetchFile(ctx: Ctx, item: WorkRow): Promise<ItemOutcome> {
  const p = item.payload;
  const ownerType = String(p.ownerType);
  const ownerId = String(p.ownerId);
  const pageId = String(p.pageId);
  const path = ownerType === "block" ? `/blocks/${ownerId}` : ownerType === "comment" ? `/comments/${ownerId}` : ownerType === "page" ? `/pages/${ownerId}` : ownerType === "data_source" ? `/data_sources/${ownerId}` : `/databases/${ownerId}`;
  const res = await apiGet(ctx, path, [404, 403]);
  if (res.status !== 200 || !isRecord(res.body)) return { state: "done", outcome: { status: res.status, ownerGone: true } };
  const fresh = fileForSlot(res.body, String(p.slot), pageId);
  if (!fresh) return { state: "done", outcome: { slotGone: true } };
  const { url, ...ref } = fresh;
  const { row, needsFetch } = await upsertFileRef(ctx.db, ctx.scope, ref);
  if (needsFetch && url) await downloadInto(ctx, row.row_key, row.file_key, url, fresh);
  return { state: "done", outcome: { status: 200 } };
}

const EXT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
  txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function guessMediaType(name: string | null): string | null {
  const ext = name?.split(".").pop()?.toLowerCase();
  return ext ? EXT_TYPES[ext] ?? null : null;
}

// ------------------------------------------------------------------ webhook hints

/**
 * Turn a verified Notion webhook event into targeted refresh items for the tenant's active
 * connection(s) and nudge the sweep. Webhooks carry ids only; the sweep re-reads the objects.
 */
export async function enqueueNotionSourceHint(db: DbExecutor, tenantId: string, event: NotionWebhookEvent): Promise<number> {
  const type = typeof event.type === "string" ? event.type : "";
  if (!type) return 0;
  const states = await listSyncStates(db, tenantId);
  let n = 0;
  for (const s of states) {
    const conn = await getConnection(db, { tenantId, connectionId: s.connection_id });
    if (conn && conn.status !== "active") continue;
    const scope = { tenantId, connectionId: s.connection_id };
    const g = Number(s.generation);
    const items: WorkItem[] = [];
    const pageId = notionWebhookAffectedPageId(event);
    const dsId = notionWebhookAffectedDataSourceId(event);
    const entityId = typeof event.entity?.id === "string" ? normId(event.entity.id) : null;
    if (type.startsWith("page.") && pageId) {
      items.push({ itemKey: `node:page:${normId(pageId)}`, kind: "node", priority: PRIORITY.node, payload: { objectType: "page", id: normId(pageId), reason: `webhook:${type}` } });
    } else if (type.startsWith("comment.") && pageId) {
      const pid = normId(pageId);
      const parent = isRecord(event.data?.parent) ? event.data!.parent as JsonObject : {};
      const blockId = parent.type === "block" && typeof parent.id === "string" ? normId(parent.id) : null;
      items.push({ itemKey: `comments:${pid}:${blockId ?? "page"}`, kind: "comments", priority: PRIORITY.comments, pageId: pid, payload: { pageId: pid, blockId, epoch: (await getNode(db, scope, pid))?.walk_epoch ?? 0, cursor: null, listed: [] } });
      if (type === "comment.deleted" && entityId) items.push({ itemKey: `comment_confirm:${entityId}`, kind: "comment_confirm", priority: PRIORITY.commentConfirm, pageId: pid, payload: { commentId: entityId, pageId: pid } });
      items.push({ itemKey: `finalize:${pid}`, kind: "finalize", priority: PRIORITY.finalize, payload: { pageId: pid } });
    } else if ((type.startsWith("data_source.") || type.startsWith("view.")) && dsId) {
      items.push({ itemKey: `node:data_source:${normId(dsId)}`, kind: "node", priority: PRIORITY.node, payload: { objectType: "data_source", id: normId(dsId), reason: `webhook:${type}` } });
    } else if (type.startsWith("database.") && entityId) {
      items.push({ itemKey: `node:database:${entityId}`, kind: "node", priority: PRIORITY.node, payload: { objectType: "database", id: entityId, reason: `webhook:${type}` } });
    }
    if (!items.length) continue;
    await enqueueWork(db, scope, g, items, { restart: true });
    n += items.length;
  }
  if (n > 0) {
    const { enqueueTask } = await import("../../../queue/queue.js");
    await enqueueTask({ queue: "sync", tenantId, kind: NOTION_SOURCE_SWEEP_TASK, payload: { tenantId, reason: "webhook" }, groupKey: `${tenantId}:notion`, dedupeKey: `${tenantId}:notion:source_sweep:hint` }, db);
  }
  return n;
}

// ------------------------------------------------------------------ task handler

export function notionSourceTaskHandlers(options: SweepOptions = {}): Record<string, TaskHandler> {
  return {
    [NOTION_SOURCE_SWEEP_TASK]: async (payload, ctx) => {
      const { db } = await import("../../../db/client.js");
      // Tenant comes from the server-written task row; a payload tenant must agree with it.
      const tenantId = ctx.task.tenantId;
      if (typeof payload.tenantId === "string" && payload.tenantId !== tenantId) throw new Error("notion.source_sweep payload tenant does not match the task tenant");
      const report = await runNotionSweep(db, tenantId, { ...options, heartbeat: async () => ctx.heartbeat() });
      return report as unknown as Record<string, unknown>;
    },
  };
}
