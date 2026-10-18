import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { enqueueTask } from "../../queue/queue.js";
import { getTokenWithMetadata, mergeTokenMetadata } from "../../vault/tokens.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { foldSlackMessage, loadSlackLedgerObservations, slackComparableHash } from "../../mirror/slack-fold.js";
import { captureSlackFileObject, markSlackFileDeleted, slackFileMaxBytes } from "./files.js";
import { materializeSlackChannelDay } from "./materialize.js";
import { getSlackToken, getUserDirectory, storeMessage, type SlackMessage, type SlackUserInfo } from "./poller.js";
import { SLACK_HISTORY_PAGE_LIMIT } from "./rate-limit.js";
import { appendSlackLedgerEvent } from "./realtime.js";
import { recordSlackSkip } from "./skips.js";
import {
  acquireLease,
  addReconcileSeen,
  clearReconcileSeen,
  compareSlackTs,
  countConversationPage,
  ensureWorkspace,
  getConversation,
  isSlackTs,
  listConversations,
  listFilesDueForRetry,
  maxSlackTs,
  minSlackTs,
  recordConversationError,
  releaseLease,
  rowsOf,
  setConversationAccess,
  setWorkspaceAuth,
  setWorkspaceRateLimited,
  slackQuotaKey,
  updateConversation,
  type SlackConversationRow,
  type SlackDbExecutor,
} from "./source-store.js";
import { enqueueSlackChannelWindows } from "./windows.js";
import {
  SLACK_AUTH_ERRORS,
  SLACK_CONVERSATION_ACCESS_ERRORS,
  SlackApiError,
  SlackDeferredError,
  SlackTransientError,
  SlackWebClient,
} from "./web-api.js";

/**
 * Restart-safe Slack history capture (the source lane's `slack.poll`).
 *
 * Per conversation (slack_source_conversations) three passes, each a fixed
 * conversations.history query whose Slack cursor and lowest stored ts are checkpointed
 * after EVERY page, so a crash, a task timeout or a rate-limit deferral resumes exactly
 * where it stopped (an invalid/expired cursor restarts below the lowest stored ts):
 *
 *   forward    newer than head_ts (freshness floor under Socket Mode, gap-fill after outages)
 *   reconcile  re-reads the recent window (SLACK_RECONCILE_WINDOW_DAYS) once per interval and
 *              appends `message.revision_observed` / `message.absent_observed` ledger rows for
 *              edits, reactions, file changes and deletions made while realtime was down
 *   backward   older than tail_ts down to the history bound; `history_complete_at` is set only
 *              when Slack reports no more messages below an UNBOUNDED walk (or the recorded
 *              bound of a bounded backfill, labelled as such in coverage)
 *
 * Work is round-robin (one page per conversation per round) under the durable shared
 * quota (web-api.ts). Thread replies run separately (syncSlackThreads), with
 * last_reply_ts checkpointed per page and missing threads registered from stored rows.
 */

export interface SlackSyncDeps {
  executor?: SlackDbExecutor;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rpm?: (method: string) => number;
  /** Longest in-process quota/Retry-After wait (default SLACK_MAX_INLINE_WAIT_MS); longer waits end the run and re-queue. */
  maxInlineWaitMs?: number;
  /** Queue a `slack.poll` continuation when work remains (default true). */
  enqueueContinuation?: boolean;
}

export interface SlackHistorySyncOptions extends SlackSyncDeps {
  /** Lower bound of a FRESH backward walk in days (null/undefined = the whole channel). */
  backfillDays?: number | null;
  /** Restart the backward walk from the newest message down to the bound. */
  forceHistorical?: boolean;
  conversationIds?: string[];
  /** Register every thread seen during this run for a full reply fetch. */
  fetchAllThreadReplies?: boolean;
  /** Donor cap on history pages per conversation per run (null/undefined = no cap). */
  maxPagesPerChannel?: number | null;
  budgetMs?: number;
  reconcileWindowDays?: number;
  reconcileIntervalMs?: number;
  pageLimit?: number;
}

export interface SlackHistorySyncResult {
  conversationsSeen: number;
  stored: number;
  cappedConversations: number;
  exhausted: boolean;
  capHit: boolean;
  pages: number;
  revisionsObserved: number;
  absentObserved: number;
  filesRetried: number;
  historyComplete: number;
  historyIncomplete: number;
  accessErrors: Record<string, number>;
  errors: number;
  deferred: boolean;
  rateLimited: boolean;
  deferredUntil: string | null;
  leaseHeld: boolean;
  teamId: string | null;
}

export interface SlackThreadSyncOptions extends SlackSyncDeps {
  channelIds?: string[];
  budgetMs?: number;
  pageLimit?: number;
  maxThreads?: number;
}

export interface SlackThreadSyncResult {
  threadsSeen: number;
  threadsPolled: number;
  repliesStored: number;
  revisionsObserved: number;
  threadsRegistered: number;
  pendingThreads: number;
  deferred: boolean;
  rateLimited: boolean;
  deferredUntil: string | null;
  leaseHeld: boolean;
  errors: number;
}

const DEFAULT_BUDGET_MS = 5 * 60_000;
const DEFAULT_RECONCILE_WINDOW_DAYS = 2;
const DEFAULT_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
const RECONCILE_CLOCK_MARGIN_S = 5 * 60;
const THREAD_INACTIVE_AFTER_MS = 7 * 24 * 60 * 60_000;
const FILE_RETRIES_PER_RUN = 20;
const LEASE_SLACK_MS = 2 * 60_000;

function positiveEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]?.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function slackSyncBudgetMs(): number {
  return positiveEnv("SLACK_POLL_RUN_BUDGET_SECONDS", DEFAULT_BUDGET_MS / 1000) * 1000;
}

export function slackReconcileWindowDays(): number {
  return positiveEnv("SLACK_RECONCILE_WINDOW_DAYS", DEFAULT_RECONCILE_WINDOW_DAYS);
}

export function slackReconcileIntervalMs(): number {
  return positiveEnv("SLACK_RECONCILE_INTERVAL_HOURS", DEFAULT_RECONCILE_INTERVAL_MS / 3_600_000) * 3_600_000;
}

/** Slack ts string for an epoch-ms instant. */
export function slackTsFromMs(ms: number): string {
  return `${Math.floor(ms / 1000)}.000000`;
}

function errText(err: unknown): string {
  if (err instanceof SlackApiError) return `${err.method}: ${err.code}`;
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function conversationType(convo: Record<string, unknown>): string {
  if (convo.is_im) return "im";
  if (convo.is_mpim) return "mpim";
  if (convo.is_group || convo.is_private) return "private_channel";
  return "public_channel";
}

interface RunContext {
  tenantId: string;
  teamId: string;
  token: string;
  client: SlackWebClient;
  executor: SlackDbExecutor;
  now: () => number;
  users: Map<string, SlackUserInfo>;
  pageLimit: number;
  fetchImpl?: typeof fetch;
}

interface Workspace {
  token: string;
  teamId: string;
  teamName: string | null;
}

/** Token + validated workspace of the tenant (team id resolved once through auth.test for legacy tokens). */
async function loadWorkspace(tenantId: string, deps: SlackSyncDeps, deadline: Date): Promise<Workspace> {
  const token = await getSlackToken(tenantId);
  if (!token) throw new Error("No Slack token found for user");
  const stored = await getTokenWithMetadata(tenantId, "slack");
  let teamId = typeof stored?.metadata?.slackTeamId === "string" ? stored.metadata.slackTeamId.trim() : "";
  let teamName = typeof stored?.metadata?.teamName === "string" ? stored.metadata.teamName : null;
  if (!teamId) {
    const client = new SlackWebClient({
      token,
      quotaKey: slackQuotaKey(`token-only:${tenantId}`),
      deadline,
      executor: deps.executor ?? db,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    const identity = await client.call("auth.test");
    teamId = String(identity.team_id ?? "").trim();
    teamName = typeof identity.team === "string" ? identity.team : teamName;
    if (!teamId) throw new SlackApiError("auth.test", "missing_team_id", 200);
    await mergeTokenMetadata(tenantId, "slack", { slackTeamId: teamId, slackUserId: identity.user_id, teamName });
  }
  return { token, teamId, teamName };
}

function newClient(ws: Workspace, deps: SlackSyncDeps, deadline: Date): SlackWebClient {
  return new SlackWebClient({
    token: ws.token,
    quotaKey: slackQuotaKey(ws.teamId),
    deadline,
    executor: deps.executor ?? db,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.rpm ? { rpm: deps.rpm } : {}),
    ...(deps.maxInlineWaitMs !== undefined ? { maxInlineWaitMs: deps.maxInlineWaitMs } : {}),
  });
}

function leaseOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

/** Translate an auth failure into a blocked workspace (and rethrow so the sync run is recorded as failed). */
async function failAuth(ctx: { executor: SlackDbExecutor; tenantId: string; teamId: string }, err: SlackApiError): Promise<never> {
  await setWorkspaceAuth(ctx.executor, ctx.tenantId, ctx.teamId, "blocked", `${err.method}: ${err.code}`);
  throw err;
}

async function syncDonorWatermark(ctx: RunContext, channelId: string, headTs: string | null, active = true): Promise<void> {
  await ctx.executor.execute(sql`
    UPDATE conversation_watermarks
    SET last_seen_ts = CASE
          WHEN ${headTs}::text IS NOT NULL AND (last_seen_ts IS NULL OR last_seen_ts::numeric < ${headTs}::numeric) THEN ${headTs}
          ELSE last_seen_ts END,
        last_polled_at = now(),
        is_active = ${active}
    WHERE user_id = ${ctx.tenantId} AND provider = 'slack' AND conversation_id = ${channelId}
  `);
}

/** Thread registration: new threads get a FULL reply fetch; known threads are re-activated when new replies exist. */
async function registerThread(ctx: RunContext, channelId: string, msg: SlackMessage, fetchAll: boolean): Promise<void> {
  if (!msg.reply_count || msg.reply_count <= 0) return;
  const threadTs = msg.thread_ts ?? msg.ts;
  const latest = msg.latest_reply && isSlackTs(msg.latest_reply) ? msg.latest_reply : null;
  await ctx.executor.execute(sql`
    INSERT INTO thread_watermarks (user_id, channel_id, thread_ts, last_reply_ts, reply_count, is_active)
    VALUES (${ctx.tenantId}, ${channelId}, ${threadTs}, NULL, ${String(msg.reply_count)}, true)
    ON CONFLICT (user_id, channel_id, thread_ts) DO UPDATE
    SET reply_count = EXCLUDED.reply_count,
        last_reply_ts = CASE WHEN ${fetchAll} AND thread_watermarks.last_polled_at IS NULL THEN NULL ELSE thread_watermarks.last_reply_ts END,
        is_active = thread_watermarks.is_active
          OR ${fetchAll}
          OR thread_watermarks.last_reply_ts IS NULL
          OR (${latest}::text IS NOT NULL AND ${latest}::numeric > thread_watermarks.last_reply_ts::numeric),
        updated_at = now()
  `);
}

/**
 * Compare a polled message with the folded current state of its stored base row; append a
 * `message.revision_observed` ledger row when Slack now shows a different version.
 */
async function observeExistingMessage(
  ctx: RunContext,
  channel: { id: string; name: string; type: string },
  msg: SlackMessage,
  observedAtMs: number,
  via: string,
  threadTs?: string,
): Promise<boolean> {
  const base = rowsOf<{ raw_payload: unknown }>(await ctx.executor.execute(sql`
    SELECT raw_payload FROM activity_events
    WHERE user_id = ${ctx.tenantId} AND source = 'slack' AND source_event_id = ${`slack:${channel.id}:${msg.ts}`}
    LIMIT 1
  `))[0];
  if (!base) return false;
  const basePayload = (typeof base.raw_payload === "string" ? JSON.parse(base.raw_payload) : base.raw_payload) as Record<string, unknown>;
  const ledger = await loadSlackLedgerObservations(ctx.executor, ctx.tenantId, channel.id, [msg.ts], ctx.teamId);
  const folded = foldSlackMessage(basePayload, ledger.get(msg.ts) ?? []);
  if (folded.payload._deleted === true && folded.payload._deleted_reason === "message_deleted") return false;
  const observed = redactProviderPayload("slack", msg as unknown as Record<string, unknown>) as Record<string, unknown>;
  const reappeared = folded.payload._deleted === true;
  if (!reappeared && slackComparableHash(folded.payload) === slackComparableHash(observed)) return false;
  // A page fetched before a newer realtime edit must not roll the message back.
  const knownEdit = (folded.payload.edited as { ts?: string } | undefined)?.ts ?? null;
  const seenEdit = (observed.edited as { ts?: string } | undefined)?.ts ?? null;
  if (knownEdit && compareSlackTs(seenEdit, knownEdit) < 0) return false;
  const hash = slackComparableHash(observed);
  const userInfo = msg.user ? ctx.users.get(msg.user) : undefined;
  await appendSlackLedgerEvent({
    userId: ctx.tenantId,
    workspaceId: ctx.teamId,
    eventType: "message.revision_observed",
    sourceEventId: `slack:${channel.id}:${msg.ts}:rev:${hash}:${observedAtMs}`,
    occurredTs: observedAtMs / 1000,
    payload: {
      message: msg,
      _object_ts: msg.ts,
      _channel: channel.id,
      _channel_name: channel.name,
      _channel_type: channel.type,
      ...(threadTs ? { _thread_ts: threadTs } : {}),
      _observed_via: via,
      _observed_at: new Date(observedAtMs).toISOString(),
    },
    extractedEntities: msg.user ? [{ type: "slack_user", id: msg.user, ...(userInfo ? { name: userInfo.displayName } : {}) }] : null,
  });
  await materializeSlackChannelDay(ctx.tenantId, channel.id, msg.ts);
  await enqueueSlackChannelWindows(ctx.tenantId, channel.id);
  return true;
}

interface StoreStats {
  stored: number;
  revisions: number;
}

async function storePage(
  ctx: RunContext,
  convo: SlackConversationRow,
  messages: SlackMessage[],
  observedAtMs: number,
  via: string,
  opts: { fetchAllThreads: boolean },
): Promise<StoreStats> {
  const stats: StoreStats = { stored: 0, revisions: 0 };
  const channel = { id: convo.channel_id, name: convo.channel_name ?? convo.channel_id, type: convo.channel_type ?? "public_channel" };
  for (const msg of messages) {
    if (!msg || !isSlackTs(msg.ts)) continue;
    const userInfo = msg.user ? ctx.users.get(msg.user) : undefined;
    const [inserted] = await storeMessage(ctx.tenantId, ctx.token, msg, channel.id, channel.name, channel.type, msg.subtype ?? "message", undefined, userInfo);
    if (inserted) stats.stored += 1;
    else if (await observeExistingMessage(ctx, channel, msg, observedAtMs, via)) stats.revisions += 1;
    await registerThread(ctx, channel.id, msg, opts.fetchAllThreads);
  }
  return stats;
}

type PassKind = "forward" | "backward" | "reconcile";

interface PageOutcome {
  more: boolean;
  messages: number;
}

/** One conversations.history page of a pass; all checkpoint writes happen after the page is stored. */
async function runPassPage(
  ctx: RunContext,
  key: { tenantId: string; teamId: string; channelId: string },
  kind: PassKind,
  options: SlackHistorySyncOptions,
  result: SlackHistorySyncResult,
): Promise<PageOutcome> {
  const convo = await getConversation(ctx.executor, key.tenantId, key.teamId, key.channelId);
  if (!convo || convo.access_state !== "listed") return { more: false, messages: 0 };
  const params: Record<string, string> = { channel: convo.channel_id, limit: String(ctx.pageLimit) };
  const nowMs = ctx.now();
  let restartCol: { cursor: "fwd_cursor" | "bwd_cursor" | "rec_cursor"; low: string | null } | null = null;

  if (kind === "forward") {
    if (!convo.fwd_started_at) {
      await updateConversation(ctx.executor, key, {
        fwd_oldest: convo.head_ts, fwd_latest: null, fwd_cursor: null, fwd_low_ts: null, fwd_top_ts: null, fwd_started_at: new Date(nowMs),
      });
      convo.fwd_oldest = convo.head_ts;
      convo.fwd_latest = null;
      convo.fwd_cursor = null;
      convo.fwd_low_ts = null;
      convo.fwd_top_ts = null;
    }
    if (convo.fwd_oldest) {
      params.oldest = convo.fwd_oldest;
      params.inclusive = "false";
    }
    if (convo.fwd_latest) params.latest = convo.fwd_latest;
    if (convo.fwd_cursor) params.cursor = convo.fwd_cursor;
    restartCol = { cursor: "fwd_cursor", low: convo.fwd_low_ts };
  } else if (kind === "backward") {
    if (!convo.history_started_at) {
      const bound = options.backfillDays != null ? slackTsFromMs(nowMs - options.backfillDays * 86_400_000) : null;
      const seededHead = convo.head_ts; // legacy donor watermark: re-walk from it (inclusive), duplicates are idempotent
      await updateConversation(ctx.executor, key, {
        history_started_at: new Date(nowMs), history_bound_ts: bound, bwd_latest: seededHead, bwd_inclusive: Boolean(seededHead), bwd_cursor: null,
      });
      convo.history_bound_ts = bound;
      convo.bwd_latest = seededHead;
      convo.bwd_inclusive = Boolean(seededHead);
      convo.bwd_cursor = null;
    }
    if (convo.history_bound_ts) params.oldest = convo.history_bound_ts;
    if (convo.bwd_latest) params.latest = convo.bwd_latest;
    params.inclusive = convo.bwd_inclusive ? "true" : "false";
    if (convo.bwd_cursor) params.cursor = convo.bwd_cursor;
    restartCol = { cursor: "bwd_cursor", low: convo.tail_ts };
  } else {
    if (!convo.rec_started_at) {
      const windowOldest = slackTsFromMs(nowMs - (options.reconcileWindowDays ?? slackReconcileWindowDays()) * 86_400_000);
      await clearReconcileSeen(ctx.executor, key);
      await updateConversation(ctx.executor, key, {
        rec_oldest: windowOldest, rec_latest: null, rec_cursor: null, rec_low_ts: null, rec_top_ts: null, rec_started_at: new Date(nowMs),
      });
      convo.rec_oldest = windowOldest;
      convo.rec_latest = null;
      convo.rec_cursor = null;
      convo.rec_started_at = new Date(nowMs).toISOString();
    }
    params.oldest = convo.rec_oldest!;
    params.inclusive = "false";
    if (convo.rec_latest) params.latest = convo.rec_latest;
    if (convo.rec_cursor) params.cursor = convo.rec_cursor;
    restartCol = { cursor: "rec_cursor", low: convo.rec_low_ts };
  }

  let data: any;
  const fetchedAtMs = ctx.now();
  try {
    data = await ctx.client.call("conversations.history", params);
  } catch (err) {
    if (err instanceof SlackApiError && err.code === "invalid_cursor" && params.cursor) {
      // Expired cursor: restart the same pass below the lowest ts already stored.
      const low = restartCol.low;
      const patch: Parameters<typeof updateConversation>[2] = { [restartCol.cursor]: null };
      if (kind === "forward") patch.fwd_latest = low;
      else if (kind === "backward") {
        patch.bwd_latest = low ?? convo.bwd_latest;
        patch.bwd_inclusive = low ? false : convo.bwd_inclusive;
      } else patch.rec_latest = low;
      await updateConversation(ctx.executor, key, patch);
      return { more: true, messages: 0 };
    }
    throw err;
  }
  result.pages += 1;
  const messages = (Array.isArray(data.messages) ? data.messages : []) as SlackMessage[];
  const page = await storePage(ctx, convo, messages, fetchedAtMs, `conversations.history:${kind}`, {
    fetchAllThreads: kind === "backward" || Boolean(options.fetchAllThreadReplies),
  });
  result.stored += page.stored;
  result.revisionsObserved += page.revisions;
  const tsList = messages.map((m) => m?.ts).filter(isSlackTs);
  const pageMax = maxSlackTs(...tsList);
  const pageMin = minSlackTs(...tsList);
  const nextCursor = typeof data.response_metadata?.next_cursor === "string" && data.response_metadata.next_cursor ? data.response_metadata.next_cursor : null;
  // has_more without a cursor (older responses): continue below the lowest stored ts instead.
  const more = Boolean(nextCursor) || data.has_more === true;
  await countConversationPage(ctx.executor, key, messages.length);

  if (kind === "forward") {
    const top = maxSlackTs(convo.fwd_top_ts, pageMax);
    const low = minSlackTs(convo.fwd_low_ts, pageMin);
    if (more) {
      await updateConversation(ctx.executor, key, {
        fwd_cursor: nextCursor, fwd_top_ts: top, fwd_low_ts: low, last_success_at: new Date(fetchedAtMs),
        ...(nextCursor ? {} : { fwd_latest: low }),
      });
    } else {
      const head = maxSlackTs(convo.head_ts, top);
      await updateConversation(ctx.executor, key, {
        head_ts: head, fwd_oldest: null, fwd_latest: null, fwd_cursor: null, fwd_low_ts: null, fwd_top_ts: null, fwd_started_at: null,
        last_forward_at: new Date(fetchedAtMs), last_forward_complete_at: new Date(fetchedAtMs), last_success_at: new Date(fetchedAtMs),
        last_error: null, error_streak: 0,
      });
      await syncDonorWatermark(ctx, key.channelId, head);
    }
  } else if (kind === "backward") {
    const head = maxSlackTs(convo.head_ts, pageMax);
    const tail = minSlackTs(convo.tail_ts, pageMin);
    if (more) {
      await updateConversation(ctx.executor, key, {
        bwd_cursor: nextCursor, head_ts: head, tail_ts: tail, last_success_at: new Date(fetchedAtMs),
        ...(nextCursor ? {} : { bwd_latest: tail, bwd_inclusive: false }),
      });
    } else {
      await updateConversation(ctx.executor, key, {
        head_ts: head, tail_ts: tail ?? convo.history_bound_ts, bwd_cursor: null, bwd_latest: null, bwd_inclusive: false,
        history_complete_at: new Date(fetchedAtMs), last_success_at: new Date(fetchedAtMs), last_error: null, error_streak: 0,
        ...(convo.last_forward_at ? {} : { last_forward_at: new Date(fetchedAtMs), last_forward_complete_at: new Date(fetchedAtMs) }),
      });
    }
    if (head !== convo.head_ts || !more) await syncDonorWatermark(ctx, key.channelId, head);
  } else {
    await addReconcileSeen(ctx.executor, key, tsList);
    const top = maxSlackTs(convo.rec_top_ts, pageMax);
    const low = minSlackTs(convo.rec_low_ts, pageMin);
    if (more) {
      await updateConversation(ctx.executor, key, {
        rec_cursor: nextCursor, rec_top_ts: top, rec_low_ts: low, last_success_at: new Date(fetchedAtMs),
        ...(nextCursor ? {} : { rec_latest: low }),
      });
    } else {
      result.absentObserved += await finishReconcile(ctx, { ...convo, rec_top_ts: top }, fetchedAtMs);
      await updateConversation(ctx.executor, key, {
        rec_oldest: null, rec_latest: null, rec_cursor: null, rec_low_ts: null, rec_top_ts: null, rec_started_at: null,
        last_reconcile_at: new Date(fetchedAtMs), last_success_at: new Date(fetchedAtMs),
      });
      await clearReconcileSeen(ctx.executor, key);
    }
  }
  return { more, messages: messages.length };
}

/**
 * A complete reconcile sweep saw every top-level message of (rec_oldest, sweep start]; stored
 * top-level messages in that range it did not see are no longer in Slack's history.
 */
async function finishReconcile(ctx: RunContext, convo: SlackConversationRow, completedAtMs: number): Promise<number> {
  const startedMs = new Date(String(convo.rec_started_at instanceof Date ? convo.rec_started_at.toISOString() : convo.rec_started_at)).getTime();
  if (!convo.rec_oldest || !Number.isFinite(startedMs)) return 0;
  const cutoff = `${Math.floor(startedMs / 1000) - RECONCILE_CLOCK_MARGIN_S}.000000`;
  const candidates = rowsOf<{ ts: string }>(await ctx.executor.execute(sql`
    SELECT raw_payload->>'ts' AS ts
    FROM activity_events e
    WHERE e.user_id = ${ctx.tenantId}
      AND e.source = 'slack'
      AND e.event_type = 'message'
      AND e.raw_payload->>'_channel' = ${convo.channel_id}
      AND COALESCE(e.raw_payload->>'_ledger', '') <> 'true'
      AND COALESCE(e.raw_payload->>'_team_id', ${ctx.teamId}) = ${ctx.teamId}
      AND e.raw_payload->>'ts' ~ '^[0-9]+(\\.[0-9]+)?$'
      AND (e.raw_payload->>'ts')::numeric > ${convo.rec_oldest}::numeric
      AND (e.raw_payload->>'ts')::numeric <= ${cutoff}::numeric
      AND e.raw_payload->>'_thread_ts' IS NULL
      AND (e.raw_payload->>'thread_ts' IS NULL OR e.raw_payload->>'thread_ts' = e.raw_payload->>'ts'
           OR e.raw_payload->>'subtype' = 'thread_broadcast')
      AND NOT EXISTS (
        SELECT 1 FROM slack_source_reconcile_seen s
        WHERE s.tenant_id = ${ctx.tenantId} AND s.team_id = ${ctx.teamId} AND s.channel_id = ${convo.channel_id}
          AND s.ts = e.raw_payload->>'ts'
      )
  `)).map((r) => r.ts);
  if (candidates.length === 0) return 0;
  const ledger = await loadSlackLedgerObservations(ctx.executor, ctx.tenantId, convo.channel_id, candidates, ctx.teamId);
  let appended = 0;
  for (const ts of candidates) {
    const obs = ledger.get(ts) ?? [];
    if (obs.some((o) => o.event_type === "message.deleted" || o.event_type === "message.absent_observed")) {
      // Already tombstoned (explicit delete), or already marked absent and not seen since.
      const lastAbsent = obs.filter((o) => o.event_type === "message.absent_observed").at(-1);
      const seenAfter = lastAbsent && obs.some((o) => o.event_type === "message.revision_observed" && new Date(o.timestamp) > new Date(lastAbsent.timestamp));
      if (!seenAfter) continue;
    }
    await appendSlackLedgerEvent({
      userId: ctx.tenantId,
      workspaceId: ctx.teamId,
      eventType: "message.absent_observed",
      sourceEventId: `slack:${convo.channel_id}:${ts}:absent:${startedMs}`,
      occurredTs: completedAtMs / 1000,
      payload: {
        _object_ts: ts,
        _channel: convo.channel_id,
        _channel_name: convo.channel_name ?? convo.channel_id,
        _channel_type: convo.channel_type ?? "public_channel",
        _observed_via: "conversations.history:reconcile",
        _reconcile_window: { oldest: convo.rec_oldest, cutoff, sweep_started_at: new Date(startedMs).toISOString() },
      },
    });
    await materializeSlackChannelDay(ctx.tenantId, convo.channel_id, ts);
    appended += 1;
  }
  if (appended > 0) await enqueueSlackChannelWindows(ctx.tenantId, convo.channel_id);
  return appended;
}

function msOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const t = (value instanceof Date ? value : new Date(String(value))).getTime();
  return Number.isNaN(t) ? null : t;
}

async function seedFromDonorWatermarks(ctx: RunContext, conversationIds: string[] | undefined): Promise<void> {
  // Legacy/donor watermarks (connect before this lane, or the donor discovery path) become lane rows once.
  await ctx.executor.execute(sql`
    INSERT INTO slack_source_conversations (tenant_id, team_id, channel_id, channel_name, channel_type, head_ts)
    SELECT ${ctx.tenantId}, ${ctx.teamId}, w.conversation_id, w.conversation_name, w.conversation_type, w.last_seen_ts
    FROM conversation_watermarks w
    WHERE w.user_id = ${ctx.tenantId} AND w.provider = 'slack' AND w.is_active = true
      AND (${conversationIds ? JSON.stringify(conversationIds) : null}::jsonb IS NULL
           OR w.conversation_id IN (SELECT jsonb_array_elements_text(${conversationIds ? JSON.stringify(conversationIds) : null}::jsonb)))
    ON CONFLICT (tenant_id, team_id, channel_id) DO NOTHING
  `);
}

interface WorkItem {
  key: { tenantId: string; teamId: string; channelId: string };
  pages: number;
  done: boolean;
}

/** Round-robin one page per conversation per round until every item is done, deferred or capped. */
async function runRounds(
  ctx: RunContext,
  kind: PassKind,
  items: WorkItem[],
  options: SlackHistorySyncOptions,
  result: SlackHistorySyncResult,
  capped: Set<string>,
): Promise<"done" | "deferred"> {
  const maxPages = options.maxPagesPerChannel ?? Number.POSITIVE_INFINITY;
  for (;;) {
    const active = items.filter((i) => !i.done);
    if (active.length === 0) return "done";
    for (const item of active) {
      if (item.pages >= maxPages) {
        item.done = true;
        capped.add(item.key.channelId);
        continue;
      }
      try {
        const outcome = await runPassPage(ctx, item.key, kind, options, result);
        item.pages += 1;
        if (!outcome.more) item.done = true;
      } catch (err) {
        if (err instanceof SlackDeferredError) {
          result.deferred = true;
          result.rateLimited = result.rateLimited || err.rateLimited;
          result.deferredUntil = err.until?.toISOString() ?? result.deferredUntil;
          if (err.rateLimited) await setWorkspaceRateLimited(ctx.executor, ctx.tenantId, ctx.teamId, err.until);
          return "deferred";
        }
        if (err instanceof SlackApiError && SLACK_AUTH_ERRORS.has(err.code)) await failAuth(ctx, err);
        item.done = true;
        if (err instanceof SlackApiError && SLACK_CONVERSATION_ACCESS_ERRORS[err.code]) {
          const state = SLACK_CONVERSATION_ACCESS_ERRORS[err.code]!;
          await setConversationAccess(ctx.executor, item.key, state, `conversations.history: ${err.code}`);
          await syncDonorWatermark(ctx, item.key.channelId, null, false);
          result.accessErrors[err.code] = (result.accessErrors[err.code] ?? 0) + 1;
          continue;
        }
        result.errors += 1;
        await recordConversationError(ctx.executor, item.key, errText(err));
        if (!(err instanceof SlackApiError || err instanceof SlackTransientError)) throw err;
      }
    }
  }
}

async function retryFiles(ctx: RunContext, result: SlackHistorySyncResult): Promise<void> {
  const due = await listFilesDueForRetry(ctx.executor, ctx.tenantId, ctx.teamId, new Date(ctx.now()), FILE_RETRIES_PER_RUN);
  for (const row of due) {
    let data: any;
    try {
      data = await ctx.client.call("files.info", { file: row.file_id });
    } catch (err) {
      if (err instanceof SlackDeferredError) return;
      if (err instanceof SlackApiError && (err.code === "file_not_found" || err.code === "file_deleted")) {
        await markSlackFileDeleted({ userId: ctx.tenantId, teamId: ctx.teamId, fileId: row.file_id, reason: err.code === "file_deleted" ? "file_deleted" : "file_not_found", at: new Date(ctx.now()), executor: ctx.executor });
        continue;
      }
      if (err instanceof SlackApiError && SLACK_AUTH_ERRORS.has(err.code)) await failAuth(ctx, err);
      continue;
    }
    if (!data.file || typeof data.file !== "object") continue;
    const channels = Array.isArray(row.channel_ids) ? row.channel_ids : [];
    const skip = await captureSlackFileObject({
      executor: ctx.executor,
      tenantId: ctx.tenantId,
      teamId: ctx.teamId,
      token: ctx.token,
      file: data.file,
      channelId: typeof channels[0] === "string" ? channels[0] : null,
      messageTs: null,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      now: new Date(ctx.now()),
      maxBytes: slackFileMaxBytes(),
    });
    result.filesRetried += 1;
    if (skip) recordSlackSkip(ctx.tenantId, skip);
  }
}

function emptyHistoryResult(): SlackHistorySyncResult {
  return {
    conversationsSeen: 0, stored: 0, cappedConversations: 0, exhausted: true, capHit: false, pages: 0, revisionsObserved: 0,
    absentObserved: 0, filesRetried: 0, historyComplete: 0, historyIncomplete: 0, accessErrors: {}, errors: 0, deferred: false,
    rateLimited: false, deferredUntil: null, leaseHeld: false, teamId: null,
  };
}

async function enqueueContinuation(tenantId: string, kind: "slack.poll", runAt: Date, deps: SlackSyncDeps): Promise<void> {
  if (deps.enqueueContinuation === false) return;
  await enqueueTask({
    queue: "sync",
    tenantId,
    kind,
    payload: { tenantId, continuation: true },
    groupKey: `${tenantId}:slack`,
    dedupeKey: `${tenantId}:${kind}:continue`,
    runAt,
  }, deps.executor ?? db);
}

export async function syncSlackHistory(tenantId: string, options: SlackHistorySyncOptions = {}): Promise<SlackHistorySyncResult> {
  const result = emptyHistoryResult();
  const conversationIds = options.conversationIds === undefined
    ? undefined
    : [...new Set(options.conversationIds.map((id) => id.trim()).filter(Boolean))];
  if (conversationIds && conversationIds.length === 0) return result;

  const now = options.now ?? Date.now;
  const executor = options.executor ?? db;
  const deadline = new Date(now() + (options.budgetMs ?? slackSyncBudgetMs()));
  const ws = await loadWorkspace(tenantId, options, deadline);
  result.teamId = ws.teamId;
  await ensureWorkspace(executor, tenantId, ws.teamId, ws.teamName);
  const owner = leaseOwner();
  if (!(await acquireLease(executor, tenantId, ws.teamId, "history", owner, new Date(deadline.getTime() + LEASE_SLACK_MS), new Date(now())))) {
    return { ...result, leaseHeld: true, exhausted: false, capHit: true };
  }
  const client = newClient(ws, options, deadline);
  try {
    const usersCall = (method: string, params: Record<string, string>) => client.call(method, params);
    let users: Map<string, SlackUserInfo>;
    try {
      users = await getUserDirectory(tenantId, ws.token, usersCall);
    } catch (err) {
      if (err instanceof SlackApiError && SLACK_AUTH_ERRORS.has(err.code)) await failAuth({ executor, tenantId, teamId: ws.teamId }, err);
      users = new Map();
    }
    const ctx: RunContext = {
      tenantId, teamId: ws.teamId, token: ws.token, client, executor, now, users,
      pageLimit: options.pageLimit ?? SLACK_HISTORY_PAGE_LIMIT,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };
    await seedFromDonorWatermarks(ctx, conversationIds);
    if (options.forceHistorical) {
      await executor.execute(sql`
        UPDATE slack_source_conversations
        SET history_started_at = NULL, history_complete_at = NULL, history_bound_ts = NULL, bwd_latest = NULL, bwd_cursor = NULL,
            bwd_inclusive = false, tail_ts = NULL, updated_at = now()
        WHERE tenant_id = ${tenantId} AND team_id = ${ws.teamId}
          AND (${conversationIds ? JSON.stringify(conversationIds) : null}::jsonb IS NULL
               OR channel_id IN (SELECT jsonb_array_elements_text(${conversationIds ? JSON.stringify(conversationIds) : null}::jsonb)))
      `);
    } else if (options.backfillDays === null) {
      // An explicit unbounded request reopens walks that stopped at a recorded bound.
      await executor.execute(sql`
        UPDATE slack_source_conversations
        SET history_complete_at = NULL, history_bound_ts = NULL, bwd_latest = tail_ts, bwd_inclusive = false, bwd_cursor = NULL, updated_at = now()
        WHERE tenant_id = ${tenantId} AND team_id = ${ws.teamId} AND history_bound_ts IS NOT NULL
      `);
    }

    const all = (await listConversations(executor, tenantId, ws.teamId))
      .filter((c) => !conversationIds || conversationIds.includes(c.channel_id));
    const listed = all.filter((c) => c.access_state === "listed");
    result.conversationsSeen = listed.length;
    const keyOf = (c: SlackConversationRow) => ({ tenantId, teamId: ws.teamId, channelId: c.channel_id });
    const memberRank = (c: SlackConversationRow) => (c.channel_type === "im" || c.channel_type === "mpim" || c.is_member !== false ? 0 : 1);
    const capped = new Set<string>();
    let stoppedHistory = false;

    // 1. forward: stalest first; archived channels only while a pass is in progress.
    const forward = listed
      .filter((c) => (c.head_ts || c.history_complete_at) && (c.fwd_started_at || !c.is_archived))
      .sort((a, b) => (a.fwd_started_at ? 0 : 1) - (b.fwd_started_at ? 0 : 1) || memberRank(a) - memberRank(b)
        || (msOf(a.last_forward_at) ?? 0) - (msOf(b.last_forward_at) ?? 0) || a.channel_id.localeCompare(b.channel_id))
      .map((c) => ({ key: keyOf(c), pages: 0, done: false }));
    stoppedHistory = (await runRounds(ctx, "forward", forward, options, result, capped)) === "deferred";

    // 2. reconcile: conversations whose last sweep is older than the interval.
    const interval = options.reconcileIntervalMs ?? slackReconcileIntervalMs();
    const reconcile = stoppedHistory ? [] : listed
      .filter((c) => c.head_ts && c.history_started_at && !c.is_archived
        && (c.rec_started_at || (msOf(c.last_reconcile_at ?? c.history_complete_at ?? c.history_started_at) ?? 0) <= now() - interval))
      .sort((a, b) => (a.rec_started_at ? 0 : 1) - (b.rec_started_at ? 0 : 1) || memberRank(a) - memberRank(b)
        || (msOf(a.last_reconcile_at) ?? 0) - (msOf(b.last_reconcile_at) ?? 0))
      .map((c) => ({ key: keyOf(c), pages: 0, done: false }));
    // Pages already used this run count against the donor per-channel cap.
    for (const item of reconcile) item.pages = forward.find((f) => f.key.channelId === item.key.channelId)?.pages ?? 0;
    if (!stoppedHistory) stoppedHistory = (await runRounds(ctx, "reconcile", reconcile, options, result, capped)) === "deferred";

    // 3. backward history walks (member conversations first, in-progress walks first).
    const fresh = await listConversations(executor, tenantId, ws.teamId);
    const backward = stoppedHistory ? [] : fresh
      .filter((c) => c.access_state === "listed" && !c.history_complete_at && (!conversationIds || conversationIds.includes(c.channel_id)))
      .sort((a, b) => (a.history_started_at ? 0 : 1) - (b.history_started_at ? 0 : 1) || memberRank(a) - memberRank(b) || a.channel_id.localeCompare(b.channel_id))
      .map((c) => ({
        key: keyOf(c),
        pages: (forward.find((f) => f.key.channelId === c.channel_id)?.pages ?? 0) + (reconcile.find((r) => r.key.channelId === c.channel_id)?.pages ?? 0),
        done: false,
      }));
    if (!stoppedHistory) stoppedHistory = (await runRounds(ctx, "backward", backward, options, result, capped)) === "deferred";

    // 4. file byte retries (files.info re-resolves the download URL; separate quota bucket).
    await retryFiles(ctx, result);

    const after = (await listConversations(executor, tenantId, ws.teamId)).filter((c) => !conversationIds || conversationIds.includes(c.channel_id));
    const afterListed = after.filter((c) => c.access_state === "listed");
    result.historyComplete = afterListed.filter((c) => c.history_complete_at).length;
    result.historyIncomplete = afterListed.length - result.historyComplete;
    const remaining = afterListed.filter((c) => !c.history_complete_at || c.fwd_started_at || c.rec_started_at).map((c) => c.channel_id);
    for (const id of remaining) capped.add(id);
    if (stoppedHistory) for (const c of afterListed) if (!c.last_forward_complete_at || c.fwd_started_at) capped.add(c.channel_id);
    result.cappedConversations = capped.size;
    result.exhausted = capped.size === 0 && !stoppedHistory;
    result.capHit = !result.exhausted;
    if (!result.exhausted) {
      const runAt = result.deferredUntil ? new Date(Math.max(now() + 30_000, Date.parse(result.deferredUntil))) : new Date(now() + 30_000);
      await enqueueContinuation(tenantId, "slack.poll", runAt, options);
    }
    if (!stoppedHistory) await setWorkspaceRateLimited(executor, tenantId, ws.teamId, null);
    await setWorkspaceAuth(executor, tenantId, ws.teamId, "ok", null);
    return result;
  } finally {
    await releaseLease(executor, tenantId, ws.teamId, "history", owner);
  }
}

// ------------------------------------------------------------------ threads

interface ThreadRow {
  id: string;
  channel_id: string;
  thread_ts: string;
  last_reply_ts: string | null;
  reply_count: string | null;
  last_polled_at: unknown;
  created_at: unknown;
}

/** Threads whose parent (reply_count > 0) or replies were stored but which have no watermark yet. */
async function registerMissingThreads(ctx: { executor: SlackDbExecutor; tenantId: string; teamId: string }, since: unknown): Promise<number> {
  const sinceIso = since ? new Date(String(since instanceof Date ? since.toISOString() : since)).toISOString() : null;
  const rows = rowsOf(await ctx.executor.execute(sql`
    INSERT INTO thread_watermarks (user_id, channel_id, thread_ts, last_reply_ts, reply_count, is_active)
    SELECT DISTINCT ON (channel_id, thread_ts) ${ctx.tenantId}, channel_id, thread_ts, NULL, reply_count, true
    FROM (
      SELECT e.raw_payload->>'_channel' AS channel_id,
             COALESCE(e.raw_payload->>'_thread_ts', e.raw_payload->>'thread_ts', e.raw_payload->>'ts') AS thread_ts,
             e.raw_payload->>'reply_count' AS reply_count
      FROM activity_events e
      WHERE e.user_id = ${ctx.tenantId}
        AND e.source = 'slack'
        AND e.event_type = 'message'
        AND COALESCE(e.raw_payload->>'_ledger', '') <> 'true'
        AND COALESCE(e.raw_payload->>'_team_id', ${ctx.teamId}) = ${ctx.teamId}
        AND COALESCE(e.raw_payload->>'_channel', '') <> ''
        AND (${sinceIso}::timestamptz IS NULL OR e.created_at > ${sinceIso}::timestamptz)
        AND (
          (e.raw_payload->>'reply_count' ~ '^[0-9]+$' AND (e.raw_payload->>'reply_count')::int > 0)
          OR (COALESCE(e.raw_payload->>'_thread_ts', e.raw_payload->>'thread_ts') IS NOT NULL
              AND COALESCE(e.raw_payload->>'_thread_ts', e.raw_payload->>'thread_ts') <> e.raw_payload->>'ts')
        )
    ) t
    WHERE thread_ts ~ '^[0-9]+(\\.[0-9]+)?$'
    ORDER BY channel_id, thread_ts
    ON CONFLICT (user_id, channel_id, thread_ts) DO NOTHING
    RETURNING 1
  `));
  return rows.length;
}

function emptyThreadResult(): SlackThreadSyncResult {
  return { threadsSeen: 0, threadsPolled: 0, repliesStored: 0, revisionsObserved: 0, threadsRegistered: 0, pendingThreads: 0, deferred: false, rateLimited: false, deferredUntil: null, leaseHeld: false, errors: 0 };
}

export async function syncSlackThreads(tenantId: string, options: SlackThreadSyncOptions = {}): Promise<SlackThreadSyncResult> {
  const result = emptyThreadResult();
  const channelIds = options.channelIds === undefined ? undefined : [...new Set(options.channelIds.map((id) => id.trim()).filter(Boolean))];
  if (channelIds && channelIds.length === 0) return result;
  const now = options.now ?? Date.now;
  const executor = options.executor ?? db;
  const deadline = new Date(now() + (options.budgetMs ?? slackSyncBudgetMs()));
  const ws = await loadWorkspace(tenantId, options, deadline);
  await ensureWorkspace(executor, tenantId, ws.teamId, ws.teamName);
  const owner = leaseOwner();
  if (!(await acquireLease(executor, tenantId, ws.teamId, "threads", owner, new Date(deadline.getTime() + LEASE_SLACK_MS), new Date(now())))) {
    return { ...result, leaseHeld: true };
  }
  const client = newClient(ws, options, deadline);
  try {
    const scanStart = new Date(now());
    const workspace = rowsOf<{ thread_scan_at: unknown }>(await executor.execute(sql`
      SELECT thread_scan_at FROM slack_source_workspaces WHERE tenant_id = ${tenantId} AND team_id = ${ws.teamId}
    `))[0];
    result.threadsRegistered = await registerMissingThreads({ executor, tenantId, teamId: ws.teamId }, workspace?.thread_scan_at ?? null);
    await executor.execute(sql`
      UPDATE slack_source_workspaces SET thread_scan_at = ${scanStart.toISOString()}::timestamptz, updated_at = now()
      WHERE tenant_id = ${tenantId} AND team_id = ${ws.teamId}
    `);

    let users: Map<string, SlackUserInfo>;
    try {
      users = await getUserDirectory(tenantId, ws.token, (method, params) => client.call(method, params));
    } catch (err) {
      if (err instanceof SlackApiError && SLACK_AUTH_ERRORS.has(err.code)) await failAuth({ executor, tenantId, teamId: ws.teamId }, err);
      users = new Map();
    }
    const ctx: RunContext = {
      tenantId, teamId: ws.teamId, token: ws.token, client, executor, now, users,
      pageLimit: options.pageLimit ?? SLACK_HISTORY_PAGE_LIMIT,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };
    const convos = new Map((await listConversations(executor, tenantId, ws.teamId)).map((c) => [c.channel_id, c]));
    const threads = rowsOf<ThreadRow>(await executor.execute(sql`
      SELECT id::text AS id, channel_id, thread_ts, last_reply_ts, reply_count, last_polled_at, created_at
      FROM thread_watermarks
      WHERE user_id = ${tenantId} AND is_active = true
        AND (${channelIds ? JSON.stringify(channelIds) : null}::jsonb IS NULL
             OR channel_id IN (SELECT jsonb_array_elements_text(${channelIds ? JSON.stringify(channelIds) : null}::jsonb)))
      ORDER BY last_polled_at NULLS FIRST, created_at, id
    `));
    result.threadsSeen = threads.length;
    let stop = false;
    for (const tw of threads.slice(0, options.maxThreads ?? threads.length)) {
      if (stop) break;
      const convo = convos.get(tw.channel_id);
      if (convo && convo.access_state !== "listed") continue; // channel no longer readable; replies are kept
      const channel = { id: tw.channel_id, name: convo?.channel_name ?? tw.channel_id, type: convo?.channel_type ?? "public_channel" };
      let lastReplyTs = tw.last_reply_ts;
      let cursor: string | undefined;
      let newReplies = 0;
      let finished = false;
      try {
        do {
          const params: Record<string, string> = { channel: tw.channel_id, ts: tw.thread_ts, limit: String(ctx.pageLimit) };
          if (lastReplyTs && !cursor) {
            params.oldest = lastReplyTs;
            params.inclusive = "false";
          }
          if (cursor) params.cursor = cursor;
          const fetchedAtMs = now();
          const data = await client.call("conversations.replies", params);
          const messages = (Array.isArray(data.messages) ? data.messages : []) as SlackMessage[];
          let pageMax: string | null = null;
          for (const msg of messages) {
            if (!msg || !isSlackTs(msg.ts)) continue;
            const isParent = msg.ts === tw.thread_ts;
            if (!isParent && lastReplyTs && compareSlackTs(msg.ts, lastReplyTs) <= 0) continue;
            const userInfo = msg.user ? users.get(msg.user) : undefined;
            const [inserted] = await storeMessage(tenantId, ws.token, msg, tw.channel_id, channel.name, channel.type, isParent ? "message" : "thread_reply", isParent ? undefined : tw.thread_ts, userInfo);
            if (inserted) {
              if (!isParent) {
                result.repliesStored += 1;
                newReplies += 1;
              }
            } else if (await observeExistingMessage(ctx, channel, msg, fetchedAtMs, "conversations.replies", isParent ? undefined : tw.thread_ts)) {
              result.revisionsObserved += 1;
            }
            if (!isParent) pageMax = maxSlackTs(pageMax, msg.ts);
          }
          if (pageMax) {
            lastReplyTs = maxSlackTs(lastReplyTs, pageMax);
            // Per-page checkpoint: an interrupted thread resumes after the last stored reply.
            await executor.execute(sql`
              UPDATE thread_watermarks SET last_reply_ts = ${lastReplyTs}, updated_at = now() WHERE id = ${tw.id}::uuid
            `);
          }
          cursor = typeof data.response_metadata?.next_cursor === "string" && data.response_metadata.next_cursor ? data.response_metadata.next_cursor : undefined;
        } while (cursor);
        finished = true;
      } catch (err) {
        if (err instanceof SlackDeferredError) {
          result.deferred = true;
          result.rateLimited = result.rateLimited || err.rateLimited;
          result.deferredUntil = err.until?.toISOString() ?? null;
          stop = true;
        } else if (err instanceof SlackApiError && SLACK_AUTH_ERRORS.has(err.code)) {
          await failAuth({ executor, tenantId, teamId: ws.teamId }, err);
        } else if (err instanceof SlackApiError && (err.code === "thread_not_found" || err.code === "channel_not_found" || SLACK_CONVERSATION_ACCESS_ERRORS[err.code])) {
          await executor.execute(sql`UPDATE thread_watermarks SET is_active = false, last_polled_at = now(), updated_at = now() WHERE id = ${tw.id}::uuid`);
          continue;
        } else if (err instanceof SlackApiError && err.code === "invalid_cursor") {
          continue; // checkpoint is last_reply_ts; the next run restarts from it without a cursor
        } else if (err instanceof SlackApiError || err instanceof SlackTransientError) {
          result.errors += 1;
          continue;
        } else {
          throw err;
        }
      }
      if (!finished) break;
      result.threadsPolled += 1;
      const lastReplyMs = lastReplyTs ? Number.parseFloat(lastReplyTs) * 1000 : (msOf(tw.created_at) ?? now());
      const stillActive = newReplies > 0 || lastReplyMs > now() - THREAD_INACTIVE_AFTER_MS;
      await executor.execute(sql`
        UPDATE thread_watermarks
        SET last_reply_ts = COALESCE(${lastReplyTs}, last_reply_ts), last_polled_at = now(), is_active = ${stillActive}, updated_at = now()
        WHERE id = ${tw.id}::uuid
      `);
    }
    result.pendingThreads = rowsOf<{ n: number }>(await executor.execute(sql`
      SELECT count(*)::int AS n FROM thread_watermarks WHERE user_id = ${tenantId} AND is_active = true AND last_polled_at IS NULL
    `))[0]?.n ?? 0;
    if (result.deferred || result.pendingThreads > 0) {
      const runAt = result.deferredUntil ? new Date(Math.max(now() + 30_000, Date.parse(result.deferredUntil))) : new Date(now() + 30_000);
      await enqueueContinuation(tenantId, "slack.poll", runAt, options);
    }
    return result;
  } finally {
    await releaseLease(executor, tenantId, ws.teamId, "threads", owner);
  }
}

// ------------------------------------------------------------------ discovery

export interface SlackDiscoveryResult {
  discovered: number;
  unlisted: string[];
  complete: boolean;
  teamId: string;
  catchUpConversationIds: string[];
  fullThreadCatchUpConversationIds: string[];
}

/**
 * conversations.list (public, private, DM, group DM; archived INCLUDED so their history is
 * captured) into slack_source_conversations and the donor watermarks. Only a complete
 * listing marks missing conversations `not_listed` (access lost; captured data kept).
 */
export async function discoverSlackConversations(tenantId: string, deps: SlackSyncDeps & { budgetMs?: number } = {}): Promise<SlackDiscoveryResult> {
  const now = deps.now ?? Date.now;
  const executor = deps.executor ?? db;
  const deadline = new Date(now() + (deps.budgetMs ?? 2 * 60_000));
  const ws = await loadWorkspace(tenantId, deps, deadline);
  await ensureWorkspace(executor, tenantId, ws.teamId, ws.teamName);
  const client = newClient(ws, deps, deadline);
  const existing = new Map((await listConversations(executor, tenantId, ws.teamId)).map((c) => [c.channel_id, c]));
  const donor = new Map(rowsOf<{ conversation_id: string; last_seen_ts: string | null }>(await executor.execute(sql`
    SELECT conversation_id, last_seen_ts FROM conversation_watermarks WHERE user_id = ${tenantId} AND provider = 'slack'
  `)).map((r) => [r.conversation_id, r]));
  const listed: string[] = [];
  const catchUp: string[] = [];
  const fullThread: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const params: Record<string, string> = { types: "public_channel,private_channel,im,mpim", exclude_archived: "false", limit: "200" };
      if (cursor) params.cursor = cursor;
      const data = await client.call("conversations.list", params);
      for (const convo of (Array.isArray(data.channels) ? data.channels : []) as Array<Record<string, unknown>>) {
        const id = typeof convo.id === "string" ? convo.id : null;
        if (!id || listed.includes(id)) continue;
        listed.push(id);
        const type = conversationType(convo);
        const name = (typeof convo.name === "string" && convo.name) || (typeof convo.user === "string" && convo.user) || id;
        const prior = existing.get(id);
        const donorRow = donor.get(id);
        if (!prior?.history_complete_at) catchUp.push(id);
        if (!prior && !donorRow?.last_seen_ts) fullThread.push(id);
        await executor.execute(sql`
          INSERT INTO slack_source_conversations (tenant_id, team_id, channel_id, channel_name, channel_type, is_archived, is_member, access_state, head_ts, last_listed_at)
          VALUES (${tenantId}, ${ws.teamId}, ${id}, ${name}, ${type}, ${convo.is_archived === true}, ${typeof convo.is_member === "boolean" ? convo.is_member : null}, 'listed', ${donorRow?.last_seen_ts ?? null}, now())
          ON CONFLICT (tenant_id, team_id, channel_id) DO UPDATE
          SET channel_name = EXCLUDED.channel_name, channel_type = EXCLUDED.channel_type, is_archived = EXCLUDED.is_archived,
              is_member = EXCLUDED.is_member,
              -- Listed again (or membership changed, or the history error is a day old): probe history again.
              -- Otherwise a history-side access error (not_in_channel, missing_scope, ...) stands.
              access_state = CASE
                WHEN slack_source_conversations.access_state IN ('listed', 'not_listed')
                  OR EXCLUDED.is_member IS DISTINCT FROM slack_source_conversations.is_member
                  OR slack_source_conversations.last_error_at IS NULL
                  OR slack_source_conversations.last_error_at < now() - interval '24 hours'
                THEN 'listed' ELSE slack_source_conversations.access_state END,
              access_reason = CASE
                WHEN slack_source_conversations.access_state IN ('listed', 'not_listed')
                  OR EXCLUDED.is_member IS DISTINCT FROM slack_source_conversations.is_member
                  OR slack_source_conversations.last_error_at IS NULL
                  OR slack_source_conversations.last_error_at < now() - interval '24 hours'
                THEN NULL ELSE slack_source_conversations.access_reason END,
              last_listed_at = now(), updated_at = now()
        `);
        await executor.execute(sql`
          INSERT INTO conversation_watermarks (user_id, provider, conversation_id, conversation_type, conversation_name, is_active)
          VALUES (${tenantId}, 'slack', ${id}, ${type}, ${name}, true)
          ON CONFLICT (user_id, provider, conversation_id) DO UPDATE
          SET conversation_name = EXCLUDED.conversation_name, conversation_type = EXCLUDED.conversation_type, is_active = true
        `);
      }
      cursor = typeof data.response_metadata?.next_cursor === "string" && data.response_metadata.next_cursor ? data.response_metadata.next_cursor : undefined;
    } while (cursor);
  } catch (err) {
    if (err instanceof SlackApiError && SLACK_AUTH_ERRORS.has(err.code)) await failAuth({ executor, tenantId, teamId: ws.teamId }, err);
    await executor.execute(sql`
      UPDATE slack_source_workspaces SET discovery_error = ${errText(err)}, discovery_error_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND team_id = ${ws.teamId}
    `);
    if (err instanceof SlackDeferredError || err instanceof SlackTransientError) {
      return { discovered: listed.length, unlisted: [], complete: false, teamId: ws.teamId, catchUpConversationIds: catchUp, fullThreadCatchUpConversationIds: fullThread };
    }
    throw err;
  }
  const unlisted = await rowsOf<{ channel_id: string }>(await executor.execute(sql`
    UPDATE slack_source_conversations
    SET access_state = 'not_listed',
        access_reason = 'no longer returned by conversations.list for this token (left, removed or deleted); captured history is kept but not refreshed',
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND team_id = ${ws.teamId} AND access_state = 'listed'
      AND channel_id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(listed)}::jsonb))
    RETURNING channel_id
  `)).map((r) => r.channel_id);
  for (const id of unlisted) {
    await executor.execute(sql`
      UPDATE conversation_watermarks SET is_active = false WHERE user_id = ${tenantId} AND provider = 'slack' AND conversation_id = ${id}
    `);
  }
  await executor.execute(sql`
    UPDATE slack_source_workspaces SET discovery_complete_at = now(), discovery_error = NULL, updated_at = now(), auth_state = 'ok', auth_error = NULL
    WHERE tenant_id = ${tenantId} AND team_id = ${ws.teamId}
  `);
  return { discovered: listed.length, unlisted, complete: true, teamId: ws.teamId, catchUpConversationIds: catchUp, fullThreadCatchUpConversationIds: fullThread };
}
