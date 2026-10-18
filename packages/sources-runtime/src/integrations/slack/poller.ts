import { createHash } from "node:crypto";
import { db } from "../../db/client.js";
import { deriveActivityEventSourceContract } from "../../db/activity-event-source.js";
import {
  activityEvents,
  conversationWatermarks,
  threadWatermarks,
} from "../../db/schema.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import { eq, and, inArray } from "drizzle-orm";
import { getTokenWithMetadata } from "../../vault/tokens.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { activityEventTimes } from "../../lib/activity-event-time.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../../lib/concurrency.js";
import { materializeSlackChannelDay } from "./materialize.js";
import { captureSlackMessageFiles } from "./files.js";
import { SLACK_HISTORY_PAGE_LIMIT, slackThrottle } from "./rate-limit.js";
import { recordSlackSkip } from "./skips.js";
import { enqueueSlackChannelWindows } from "./windows.js";

export { slackDayKeyFromTs } from "./materialize.js";

interface SlackMessage {
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

interface SlackConversation {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_archived?: boolean;
  user?: string;
}

interface SlackConversationWatermarkSnapshot {
  conversationId: string;
  lastSeenTs: string | null;
  lastPolledAt: Date | null;
  isActive: boolean;
}

const MAX_RETRIES = 3;
const SLACK_CONVERSATION_CONCURRENCY = parseConcurrencyEnv("SLACK_CONVERSATION_CONCURRENCY", 5, { max: 10 });
const SLACK_THREAD_CONCURRENCY = parseConcurrencyEnv("SLACK_THREAD_CONCURRENCY", 5, { max: 10 });

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
      const retryAfter = Math.min(Number(res.headers.get("retry-after") ?? 5), 60);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return slackApi(token, method, params, retries + 1);
    }
    throw new SlackApiError(method, String(data.error ?? "unknown_error"), res.status);
  }
  return data;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(`Slack API ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

function getConversationType(convo: SlackConversation): string {
  if (convo.is_im) return "im";
  if (convo.is_mpim) return "mpim";
  if (convo.is_group) return "private_channel";
  return "public_channel";
}

async function getSlackToken(userId: string): Promise<string | null> {
  const stored = await getTokenWithMetadata(userId, "slack");
  const workspaceId = stored?.metadata?.slackTeamId;
  if (typeof workspaceId === "string" && workspaceId.trim()) {
    slackWorkspaceIds.set(userId, workspaceId.trim());
  }
  return stored?.token ?? null;
}

const slackWorkspaceIds = new Map<string, string>();

function normalizeIds(ids: string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function needsInitialCatchUp(existing: SlackConversationWatermarkSnapshot | undefined): boolean {
  return !existing || !existing.isActive || (!existing.lastSeenTs && !existing.lastPolledAt);
}

function needsFullThreadCatchUp(existing: SlackConversationWatermarkSnapshot | undefined): boolean {
  return !existing || (!existing.lastSeenTs && !existing.lastPolledAt);
}

// ─── User Resolution Cache ──────────────────────────────────────────────────

interface SlackUserInfo {
  id: string;
  name: string;
  realName: string;
  email?: string;
  displayName?: string;
}

async function loadUserDirectory(token: string): Promise<Map<string, SlackUserInfo>> {
  const cache = new Map<string, SlackUserInfo>();
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = { limit: "200" };
    if (cursor) params.cursor = cursor;

    const data = await slackApi(token, "users.list", params);

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

async function getUserDirectory(userId: string, token: string): Promise<Map<string, SlackUserInfo>> {
  const cacheKey = slackUserDirectoryCacheKey(userId, token);
  const now = Date.now();
  pruneUserDirectoryCaches(userId, cacheKey, now);
  const cached = userDirectoryCaches.get(cacheKey);
  if (cached && now < cached.expiresAt && cached.users.size > 0) return cached.users;
  try {
    userDirectoryCaches.set(cacheKey, {
      users: await loadUserDirectory(token),
      expiresAt: now + 10 * 60 * 1000,
    });
  } catch (err) {
    console.error("Failed to load Slack user directory, using stale cache:", err instanceof Error ? err.message : err);
  }
  return userDirectoryCaches.get(cacheKey)?.users ?? new Map();
}

async function storeMessage(
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
  const token = await getSlackToken(userId);
  if (!token) throw new Error("No Slack token found for user");

  const existingRows = await db
    .select({
      conversationId: conversationWatermarks.conversationId,
      lastSeenTs: conversationWatermarks.lastSeenTs,
      lastPolledAt: conversationWatermarks.lastPolledAt,
      isActive: conversationWatermarks.isActive,
    })
    .from(conversationWatermarks)
    .where(
      and(
        eq(conversationWatermarks.userId, userId),
        eq(conversationWatermarks.provider, "slack"),
      ),
    );
  const existingByConversationId = new Map<string, SlackConversationWatermarkSnapshot>(
    existingRows.map((row) => [row.conversationId, row]),
  );
  const catchUpConversationIds: string[] = [];
  const catchUpSeen = new Set<string>();
  const fullThreadCatchUpConversationIds: string[] = [];
  const fullThreadCatchUpSeen = new Set<string>();

  let cursor: string | undefined;
  let discovered = 0;

  do {
    const params: Record<string, string> = {
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: "true",
      limit: "200",
    };
    if (cursor) params.cursor = cursor;

    const data = await slackApi(token, "conversations.list", params);

    for (const convo of data.channels as SlackConversation[]) {
      const existing = existingByConversationId.get(convo.id);
      if (needsInitialCatchUp(existing) && !catchUpSeen.has(convo.id)) {
        catchUpConversationIds.push(convo.id);
        catchUpSeen.add(convo.id);
      }
      if (needsFullThreadCatchUp(existing) && !fullThreadCatchUpSeen.has(convo.id)) {
        fullThreadCatchUpConversationIds.push(convo.id);
        fullThreadCatchUpSeen.add(convo.id);
      }
      await db
        .insert(conversationWatermarks)
        .values({
          userId,
          provider: "slack",
          conversationId: convo.id,
          conversationType: getConversationType(convo),
          conversationName: convo.name ?? convo.user ?? convo.id,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [
            conversationWatermarks.userId,
            conversationWatermarks.provider,
            conversationWatermarks.conversationId,
          ],
          set: {
            conversationName: convo.name ?? convo.user ?? convo.id,
            conversationType: getConversationType(convo),
            isActive: true,
          },
        });
      existingByConversationId.set(convo.id, {
        conversationId: convo.id,
        lastSeenTs: existing?.lastSeenTs ?? null,
        lastPolledAt: existing?.lastPolledAt ?? null,
        isActive: true,
      });
      discovered++;
    }

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { discovered, catchUpConversationIds, fullThreadCatchUpConversationIds };
}

export async function discoverConversations(userId: string): Promise<number> {
  const result = await discoverConversationsDetailed(userId);
  return result.discovered;
}

// ─── Channel Message Polling ────────────────────────────────────────────────

export interface PollOptions {
  backfillDays?: number; // null = no limit (fetch all history)
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
}

export async function pollConversationsDetailed(userId: string, options?: PollOptions): Promise<SlackPollConversationsResult> {
  const token = await getSlackToken(userId);
  if (!token) throw new Error("No Slack token found for user");

  const conversationIds = normalizeIds(options?.conversationIds);
  if (options?.conversationIds !== undefined && conversationIds?.length === 0) {
    return {
      conversationsSeen: 0,
      stored: 0,
      cappedConversations: 0,
      exhausted: true,
      capHit: false,
    };
  }

  const users = await getUserDirectory(userId, token);

  const watermarkConditions = [
    eq(conversationWatermarks.userId, userId),
    eq(conversationWatermarks.provider, "slack"),
    eq(conversationWatermarks.isActive, true),
  ];
  if (conversationIds) {
    watermarkConditions.push(inArray(conversationWatermarks.conversationId, conversationIds));
  }

  const watermarks = await db
    .select()
    .from(conversationWatermarks)
    .where(and(...watermarkConditions));

  const backfillDays = options?.backfillDays;
  const maxPages = options?.maxPagesPerChannel ?? Number.POSITIVE_INFINITY;

  // Calculate oldest timestamp for first backfill
  const oldestBackfillTs = backfillDays != null
    ? String(Math.floor((Date.now() - backfillDays * 24 * 60 * 60 * 1000) / 1000)) + ".000000"
    : undefined; // undefined = no limit, fetch everything

  const storedByConversation = await mapWithConcurrency(watermarks, SLACK_CONVERSATION_CONCURRENCY, async (wm) => {
    let storedForConversation = 0;
    const oldest = options?.forceHistorical ? oldestBackfillTs : (wm.lastSeenTs ?? oldestBackfillTs);
    let cursor: string | undefined;
    let maxTs = wm.lastSeenTs ?? "0";
    let hasRealMessages = false;
    let pagesProcessed = 0;

    do {
      const params: Record<string, string> = {
        channel: wm.conversationId,
        // 15 messages/request under the 2025 non-Marketplace regime; more
        // pages instead, each paced by the conversations.history bucket.
        limit: String(SLACK_HISTORY_PAGE_LIMIT),
      };
      if (oldest && !cursor) {
        params.oldest = oldest;
        params.inclusive = "false";
      }
      if (cursor) {
        params.cursor = cursor;
      }

      let data: any;
      try {
        data = await slackApi(token, "conversations.history", params);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("channel_not_found") || msg.includes("not_in_channel")) {
          await db
            .update(conversationWatermarks)
            .set({ isActive: false })
            .where(eq(conversationWatermarks.id, wm.id));
          break;
        }
        throw err;
      }

      const messages = (data.messages as SlackMessage[]) ?? [];
      if (messages.length === 0) break;

      for (const msg of messages) {
        // Max capture: channel_join/channel_leave (and every other subtype)
        // are stored - they're real channel-timeline messages.
        hasRealMessages = true;

        const userInfo = msg.user ? users.get(msg.user) : undefined;

        const [stored] = await storeMessage(
          userId,
          token,
          msg,
          wm.conversationId,
          wm.conversationName ?? wm.conversationId,
          wm.conversationType ?? "public_channel",
          msg.subtype ?? "message",
          undefined,
          userInfo,
        );

        if (stored) storedForConversation++;
        if (msg.ts > maxTs) maxTs = msg.ts;

        if (msg.reply_count && msg.reply_count > 0) {
          const fetchAllThreadReplies = options?.fetchAllThreadReplies || options?.forceHistorical || !wm.lastSeenTs;
          const lastReplyTs = fetchAllThreadReplies ? null : (msg.latest_reply ?? null);
          await db
            .insert(threadWatermarks)
            .values({
              userId,
              channelId: wm.conversationId,
              threadTs: msg.thread_ts ?? msg.ts,
              lastReplyTs,
              replyCount: String(msg.reply_count),
              isActive: true,
            })
            .onConflictDoUpdate({
              target: [threadWatermarks.userId, threadWatermarks.channelId, threadWatermarks.threadTs],
              set: {
                replyCount: String(msg.reply_count),
                lastReplyTs,
                isActive: true,
              },
            });
        }
      }

      cursor = data.response_metadata?.next_cursor || undefined;
      pagesProcessed++;
    } while (cursor && pagesProcessed < maxPages);

    if (hasRealMessages && maxTs > (wm.lastSeenTs ?? "0")) {
      await db
        .update(conversationWatermarks)
        .set({ lastSeenTs: maxTs, lastPolledAt: new Date() })
        .where(eq(conversationWatermarks.id, wm.id));
    } else {
      await db
        .update(conversationWatermarks)
        .set({ lastPolledAt: new Date() })
        .where(eq(conversationWatermarks.id, wm.id));
    }
    return {
      stored: storedForConversation,
      capped: Boolean(cursor) && pagesProcessed >= maxPages,
    };
  });

  const stored = storedByConversation.reduce((sum, result) => sum + result.stored, 0);
  const cappedConversations = storedByConversation.filter((result) => result.capped).length;
  return {
    conversationsSeen: watermarks.length,
    stored,
    cappedConversations,
    exhausted: cappedConversations === 0,
    capHit: cappedConversations > 0,
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
  const token = await getSlackToken(userId);
  if (!token) throw new Error("No Slack token found for user");

  const channelIds = normalizeIds(options?.channelIds);
  if (options?.channelIds !== undefined && channelIds?.length === 0) {
    return 0;
  }

  const users = await getUserDirectory(userId, token);

  const threadConditions = [
    eq(threadWatermarks.userId, userId),
    eq(threadWatermarks.isActive, true),
  ];
  if (channelIds) {
    threadConditions.push(inArray(threadWatermarks.channelId, channelIds));
  }

  const threads = await db
    .select()
    .from(threadWatermarks)
    .where(and(...threadConditions));

  // Fix #6: Pre-load channel metadata to avoid N+1 queries
  const channelConditions = [
    eq(conversationWatermarks.userId, userId),
    eq(conversationWatermarks.provider, "slack"),
  ];
  if (channelIds) {
    channelConditions.push(inArray(conversationWatermarks.conversationId, channelIds));
  }
  const convos = await db
    .select({
      conversationId: conversationWatermarks.conversationId,
      name: conversationWatermarks.conversationName,
      type: conversationWatermarks.conversationType,
    })
    .from(conversationWatermarks)
    .where(and(...channelConditions));
  const channelMap = new Map(convos.map((c) => [c.conversationId, { name: c.name, type: c.type }]));

  const storedByThread = await mapWithConcurrency(threads, SLACK_THREAD_CONCURRENCY, async (tw) => {
    let storedForThread = 0;
    const channel = channelMap.get(tw.channelId);
    const channelName = channel?.name ?? tw.channelId;
    const channelType = channel?.type ?? "public_channel";

    let maxReplyTs = tw.lastReplyTs ?? "0";
    let newReplies = 0;
    let cursor: string | undefined;

    do {
      const params: Record<string, string> = {
        channel: tw.channelId,
        ts: tw.threadTs,
        // 15 messages/request under the 2025 non-Marketplace regime; more
        // pages instead, each paced by the conversations.replies bucket.
        limit: String(SLACK_HISTORY_PAGE_LIMIT),
      };
      if (tw.lastReplyTs && !cursor) {
        params.oldest = tw.lastReplyTs;
        params.inclusive = "false";
      }
      if (cursor) {
        params.cursor = cursor;
      }

      let data: any;
      try {
        data = await slackApi(token, "conversations.replies", params);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("thread_not_found") || msg.includes("channel_not_found")) {
          await db
            .update(threadWatermarks)
            .set({ isActive: false })
            .where(eq(threadWatermarks.id, tw.id));
          return storedForThread;
        }
        throw err;
      }

      const messages = (data.messages as SlackMessage[]) ?? [];

      for (const msg of messages) {
        if (msg.ts === tw.threadTs) continue;
        if (tw.lastReplyTs && msg.ts <= tw.lastReplyTs) continue;

        const userInfo = msg.user ? users.get(msg.user) : undefined;

        const [stored] = await storeMessage(
          userId,
          token,
          msg,
          tw.channelId,
          channelName,
          channelType,
          "thread_reply",
          tw.threadTs,
          userInfo,
        );

        if (stored) {
          storedForThread++;
          newReplies++;
        }
        if (msg.ts > maxReplyTs) maxReplyTs = msg.ts;
      }

      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Fix #2: Use lastReplyTs (actual reply time) for deactivation, not lastPolledAt
    const lastReplyTime = maxReplyTs !== "0"
      ? parseFloat(maxReplyTs) * 1000
      : (tw.createdAt?.getTime() ?? Date.now());
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stillActive = newReplies > 0 || lastReplyTime > sevenDaysAgo;

    await db
      .update(threadWatermarks)
      .set({
        lastReplyTs: maxReplyTs !== "0" ? maxReplyTs : tw.lastReplyTs,
        lastPolledAt: new Date(),
        isActive: stillActive,
      })
      .where(eq(threadWatermarks.id, tw.id));
    return storedForThread;
  });

  return storedByThread.reduce((sum, count) => sum + count, 0);
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
