import { createHash } from "node:crypto";
import { db } from "../../db/client.js";
import { deriveActivityEventSourceContract } from "../../db/activity-event-source.js";
import {
  activityEvents,
  threadWatermarks,
} from "../../db/schema.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import { eq, and } from "drizzle-orm";
import { getTokenWithMetadata } from "../../vault/tokens.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { activityEventTimes } from "../../lib/activity-event-time.js";
import { materializeSlackChannelDay } from "./materialize.js";
import { captureSlackMessageFiles } from "./files.js";
import { slackThrottle } from "./rate-limit.js";
import { parseRetryAfterSeconds, SlackApiError } from "./web-api.js";
import { recordSlackSkip } from "./skips.js";
import { enqueueSlackChannelWindows } from "./windows.js";

export { slackDayKeyFromTs } from "./materialize.js";

export interface SlackMessage {
  type: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  subtype?: string;
  reactions?: Array<{ name: string; users: string[]; count: number }>;
  files?: unknown[];
  edited?: { user: string; ts: string };
}

const MAX_RETRIES = 3;

async function slackApi(token: string, method: string, params: Record<string, string> = {}, retries = 0): Promise<any> {
  // Buckets are keyed per (workspace token, method) - see rate-limit.ts.
  await slackThrottle(token, method);

  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json();
  if (!data.ok) {
    if (data.error === "ratelimited" && retries < MAX_RETRIES) {
      // Honour Slack's full Retry-After (never a shorter clamp); the source-lane sync uses the
      // durable shared quota in web-api.ts instead of this in-process path.
      const retryAfter = parseRetryAfterSeconds(res.headers.get("retry-after"), retries);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return slackApi(token, method, params, retries + 1);
    }
    throw new SlackApiError(method, String(data.error ?? "unknown_error"), res.status);
  }
  return data;
}

export { SlackApiError };

export async function getSlackToken(userId: string): Promise<string | null> {
  const stored = await getTokenWithMetadata(userId, "slack");
  const workspaceId = stored?.metadata?.slackTeamId;
  if (typeof workspaceId === "string" && workspaceId.trim()) {
    slackWorkspaceIds.set(userId, workspaceId.trim());
  }
  return stored?.token ?? null;
}

const slackWorkspaceIds = new Map<string, string>();

// ─── User Resolution Cache ──────────────────────────────────────────────────

export interface SlackUserInfo {
  id: string;
  name: string;
  realName: string;
  email?: string;
  displayName?: string;
}

type SlackCall = (method: string, params: Record<string, string>) => Promise<any>;

async function loadUserDirectory(token: string, call: SlackCall = (method, params) => slackApi(token, method, params)): Promise<Map<string, SlackUserInfo>> {
  const cache = new Map<string, SlackUserInfo>();
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = { limit: "200" };
    if (cursor) params.cursor = cursor;

    const data = await call("users.list", params);

    for (const user of data.members ?? []) {
      if (user.is_bot || user.id === "USLACKBOT") continue;
      cache.set(user.id, {
        id: user.id,
        name: user.name,
        realName: user.real_name ?? user.name,
        email: user.profile?.email,
        displayName: user.profile?.display_name || user.real_name || user.name,
      });
    }

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return cache;
}

interface SlackUserDirectoryCache {
  users: Map<string, SlackUserInfo>;
  expiresAt: number;
}

const userDirectoryCaches = new Map<string, SlackUserDirectoryCache>();

export function slackUserDirectoryCacheKey(userId: string, token: string): string {
  const tokenFingerprint = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `${userId}:${tokenFingerprint}`;
}

function pruneUserDirectoryCaches(ownerUserId: string, activeCacheKey: string, now: number): void {
  const ownerPrefix = `${ownerUserId}:`;
  for (const [cacheKey, cached] of userDirectoryCaches) {
    if (cacheKey === activeCacheKey) continue;
    if (cached.expiresAt <= now || cacheKey.startsWith(ownerPrefix)) {
      userDirectoryCaches.delete(cacheKey);
    }
  }
}

export async function getUserDirectory(userId: string, token: string, call?: SlackCall): Promise<Map<string, SlackUserInfo>> {
  const cacheKey = slackUserDirectoryCacheKey(userId, token);
  const now = Date.now();
  pruneUserDirectoryCaches(userId, cacheKey, now);
  const cached = userDirectoryCaches.get(cacheKey);
  if (cached && now < cached.expiresAt && cached.users.size > 0) return cached.users;
  try {
    userDirectoryCaches.set(cacheKey, {
      users: await loadUserDirectory(token, call),
      expiresAt: now + 10 * 60 * 1000,
    });
  } catch (err) {
    console.error("Failed to load Slack user directory, using stale cache:", err instanceof Error ? err.message : err);
  }
  return userDirectoryCaches.get(cacheKey)?.users ?? new Map();
}

export async function storeMessage(
  userId: string,
  token: string,
  msg: SlackMessage,
  channelId: string,
  channelName: string,
  channelType: string,
  _eventType: string,
  threadTs?: string,
  userInfo?: SlackUserInfo,
) {
  const sourceId = `slack:${channelId}:${msg.ts}`;
  const occurredAt = new Date(Number.parseFloat(msg.ts) * 1000);
  const editedAt = msg.edited?.ts ? new Date(Number.parseFloat(msg.edited.ts) * 1000) : null;
  const times = activityEventTimes(occurredAt, editedAt);
  const rawPayload = redactSlackPayload({
    ...msg,
    _team_id: slackWorkspaceIds.get(userId),
    _channel: channelId,
    _channel_name: channelName,
    _channel_type: channelType,
    ...(threadTs ? { _thread_ts: threadTs } : {}),
    ...(userInfo ? {
      _user_name: userInfo.displayName,
      _user_real_name: userInfo.realName,
      _user_email: userInfo.email,
    } : {}),
  });

  const inserted = await db
    .insert(activityEvents)
    .values({
      userId,
      source: "slack",
      ...deriveActivityEventSourceContract({
        source: "slack",
        eventType: "message",
        rawPayload,
        defaultRecordKind: "activity",
      }),
      eventType: "message",
      timestamp: times.timestamp,
      sourceUpdatedAt: times.sourceUpdatedAt,
      wikiEligibilityAt: times.wikiEligibilityAt,
      rawPayload,
      sourceEventId: sourceId,
      processingStatus: "collected",
      extractedEntities: slackExtractedEntities(msg.user, userInfo),
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  const [stored] = inserted;
  if (stored) {
    await enqueueCollectedEventForProcessing(stored.id, userId, "slack");
    await materializeSlackChannelDay(userId, channelId, msg.ts);
    await enqueueSlackChannelWindows(userId, channelId);
  }

  // Attachment bytes -> S3 + binary_documents (idempotent per file version, so
  // re-traversals are cheap). Per-file skips surface in the sync-run result.
  if (Array.isArray(msg.files) && msg.files.length > 0) {
    try {
      const fileResult = await captureSlackMessageFiles({
        userId,
        token,
        channelId,
        files: msg.files,
        teamId: slackWorkspaceIds.get(userId) ?? null,
        messageTs: msg.ts,
      });
      for (const [reason, count] of Object.entries(fileResult.skips)) {
        recordSlackSkip(userId, reason, count);
      }
    } catch (err) {
      recordSlackSkip(userId, "file_capture_error");
      console.error(`[slack] file capture failed in ${channelId}:`, err instanceof Error ? err.message : err);
    }
  }

  return inserted;
}

function redactSlackPayload(value: Record<string, unknown>): Record<string, unknown> {
  return redactProviderPayload("slack", value) as Record<string, unknown>;
}

function slackExtractedEntities(
  slackUserId: string | undefined,
  userInfo: SlackUserInfo | undefined,
): Array<Record<string, unknown>> | null {
  const entities: Array<Record<string, unknown>> = [];
  if (slackUserId) {
    entities.push({
      type: "slack_user",
      id: slackUserId,
      ...(userInfo ? {
        name: userInfo.displayName,
        realName: userInfo.realName,
        email: userInfo.email,
      } : {}),
    });
  }
  if (userInfo?.email) {
    entities.push({ type: "email_contact", id: userInfo.email.toLowerCase(), email: userInfo.email.toLowerCase() });
  }
  return entities.length > 0 ? entities : null;
}

// ─── Conversation Discovery ─────────────────────────────────────────────────

export interface SlackConversationDiscoveryResult {
  discovered: number;
  catchUpConversationIds: string[];
  fullThreadCatchUpConversationIds: string[];
}

export async function discoverConversationsDetailed(userId: string): Promise<SlackConversationDiscoveryResult> {
  // Source lane: conversations.list through the durable shared quota (archived conversations
  // included so their history is captured; conversations no longer listed lose access state).
  const { discoverSlackConversations } = await import("./history-sync.js");
  const result = await discoverSlackConversations(userId);
  return {
    discovered: result.discovered,
    catchUpConversationIds: result.catchUpConversationIds,
    fullThreadCatchUpConversationIds: result.fullThreadCatchUpConversationIds,
  };
}

export async function discoverConversations(userId: string): Promise<number> {
  const result = await discoverConversationsDetailed(userId);
  return result.discovered;
}

// ─── Channel Message Polling ────────────────────────────────────────────────

export interface PollOptions {
  backfillDays?: number | null; // null = no limit (fetch all history)
  maxPagesPerChannel?: number | null;
  forceHistorical?: boolean;
  conversationIds?: string[];
  fetchAllThreadReplies?: boolean;
}

export interface SlackPollConversationsResult {
  conversationsSeen: number;
  stored: number;
  cappedConversations: number;
  exhausted: boolean;
  capHit: boolean;
  revisionsObserved?: number;
  absentObserved?: number;
  historyComplete?: number;
  historyIncomplete?: number;
  deferred?: boolean;
  rateLimited?: boolean;
  deferredUntil?: string | null;
  accessErrors?: Record<string, number>;
  leaseHeld?: boolean;
}

export async function pollConversationsDetailed(userId: string, options?: PollOptions): Promise<SlackPollConversationsResult> {
  // Source lane: checkpointed forward / reconcile / backward passes (history-sync.ts).
  // backfillDays bounds only a FRESH walk and is recorded, so coverage never calls it complete history.
  const { syncSlackHistory } = await import("./history-sync.js");
  const result = await syncSlackHistory(userId, {
    ...(options?.backfillDays !== undefined ? { backfillDays: options.backfillDays } : {}),
    ...(options?.maxPagesPerChannel !== undefined ? { maxPagesPerChannel: options.maxPagesPerChannel } : {}),
    ...(options?.forceHistorical ? { forceHistorical: true } : {}),
    ...(options?.conversationIds !== undefined ? { conversationIds: options.conversationIds } : {}),
    ...(options?.fetchAllThreadReplies ? { fetchAllThreadReplies: true } : {}),
  });
  return {
    conversationsSeen: result.conversationsSeen,
    stored: result.stored,
    cappedConversations: result.cappedConversations,
    exhausted: result.exhausted,
    capHit: result.capHit,
    revisionsObserved: result.revisionsObserved,
    absentObserved: result.absentObserved,
    historyComplete: result.historyComplete,
    historyIncomplete: result.historyIncomplete,
    deferred: result.deferred,
    rateLimited: result.rateLimited,
    deferredUntil: result.deferredUntil,
    accessErrors: result.accessErrors,
    leaseHeld: result.leaseHeld,
  };
}

export async function pollConversations(userId: string, options?: PollOptions): Promise<number> {
  const result = await pollConversationsDetailed(userId, options);
  return result.stored;
}

// ─── Thread Reply Polling ───────────────────────────────────────────────────

export interface PollThreadsOptions {
  channelIds?: string[];
}

export async function pollThreads(userId: string, options?: PollThreadsOptions): Promise<number> {
  // Source lane: replies with last_reply_ts checkpointed per page, missing threads registered
  // from stored rows, shared durable quota (history-sync.ts).
  const { syncSlackThreads } = await import("./history-sync.js");
  const result = await syncSlackThreads(userId, options?.channelIds !== undefined ? { channelIds: options.channelIds } : {});
  return result.repliesStored;
}

// ─── Thread Backfill ────────────────────────────────────────────────────────

export async function backfillThreadReplies(userId: string): Promise<number> {
  const token = await getSlackToken(userId);
  if (!token) throw new Error("No Slack token found for user");

  const allSlackEvents = await db
    .select({ rawPayload: activityEvents.rawPayload })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.userId, userId),
        eq(activityEvents.source, "slack"),
      ),
    );

  // Fix #4: More lenient filter - register any message with reply_count > 0
  let threadsRegistered = 0;
  for (const event of allSlackEvents) {
    const payload = event.rawPayload as Record<string, unknown>;
    const replyCount = payload.reply_count as number | undefined;
    const ts = payload.ts as string | undefined;

    if (!replyCount || replyCount === 0 || !ts) continue;

    const channelId = payload._channel as string;
    if (!channelId) continue;

    // Use ts as threadTs (for parent messages, ts === thread_ts)
    const threadTs = (payload.thread_ts as string) ?? ts;

    // Register with NO lastReplyTs so pollThreads fetches ALL replies
    await db
      .insert(threadWatermarks)
      .values({
        userId,
        channelId,
        threadTs,
        lastReplyTs: null,
        replyCount: String(replyCount),
        isActive: true,
      })
      .onConflictDoNothing();

    threadsRegistered++;
  }

  console.log(`Thread backfill: registered ${threadsRegistered} threads, now polling replies...`);

  // Reset existing watermarks so we fetch all replies
  await db
    .update(threadWatermarks)
    .set({ lastReplyTs: null })
    .where(
      and(
        eq(threadWatermarks.userId, userId),
        eq(threadWatermarks.isActive, true),
      ),
    );

  const count = await pollThreads(userId);
  console.log(`Thread backfill: stored ${count} replies for user ${userId}`);
  return count;
}
