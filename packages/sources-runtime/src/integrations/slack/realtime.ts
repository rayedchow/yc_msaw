import { createHash } from "node:crypto";
import WebSocket from "ws";
import { db } from "../../db/client.js";
import { deriveActivityEventSourceContract } from "../../db/activity-event-source.js";
import { activityEvents, conversationWatermarks, integrationTokens } from "../../db/schema.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import { eq, and, sql } from "drizzle-orm";
import { env } from "../../env.js";
import { getTokenWithMetadata, mergeTokenMetadata } from "../../vault/tokens.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { activityEventTimes } from "../../lib/activity-event-time.js";
import { materializeSlackChannelDay } from "./materialize.js";
import { captureSlackMessageFiles } from "./files.js";
import { recordSlackSkip, SLACK_UNATTRIBUTED_SKIP_BUCKET } from "./skips.js";
import { enqueueSlackChannelWindows } from "./windows.js";

const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;

function slackTimestampToDate(ts: string | number | null | undefined): Date | null {
  if (ts == null) return null;
  const seconds = typeof ts === "number" ? ts : Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

function slackEventTimes(
  occurredTs: string | number | null | undefined,
  sourceUpdatedTs?: string | number | null,
): ReturnType<typeof activityEventTimes> {
  return activityEventTimes(slackTimestampToDate(occurredTs) ?? new Date(), slackTimestampToDate(sourceUpdatedTs));
}

interface SlackUserInfo {
  id: string;
  name: string;
  realName: string;
  email?: string;
  displayName?: string;
}

interface SlackUserDirectoryCache {
  users: Map<string, SlackUserInfo>;
  expiresAt: number;
}

const userDirectoryCaches = new Map<string, SlackUserDirectoryCache>();

async function loadUserDirectory(token: string): Promise<Map<string, SlackUserInfo>> {
  const cache = new Map<string, SlackUserInfo>();
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as any;
    if (!data.ok) break;

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

function userDirectoryCacheKey(userId: string, token: string): string {
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

async function getUserInfo(ownerUserId: string, token: string, slackUserId: string): Promise<SlackUserInfo | undefined> {
  const cacheKey = userDirectoryCacheKey(ownerUserId, token);
  const now = Date.now();
  pruneUserDirectoryCaches(ownerUserId, cacheKey, now);
  const cached = userDirectoryCaches.get(cacheKey);
  if (!cached || now >= cached.expiresAt || cached.users.size === 0) {
    try {
      userDirectoryCaches.set(cacheKey, {
        users: await loadUserDirectory(token),
        expiresAt: now + 10 * 60 * 1000,
      });
    } catch {
      // Use stale cache
    }
  }
  return userDirectoryCaches.get(cacheKey)?.users.get(slackUserId);
}

async function getChannelName(channelId: string, userId: string): Promise<{ name: string; type: string }> {
  const [wm] = await db
    .select({ name: conversationWatermarks.conversationName, type: conversationWatermarks.conversationType })
    .from(conversationWatermarks)
    .where(
      and(
        eq(conversationWatermarks.userId, userId),
        eq(conversationWatermarks.provider, "slack"),
        eq(conversationWatermarks.conversationId, channelId),
      ),
    )
    .limit(1);

  return { name: wm?.name ?? channelId, type: wm?.type ?? "unknown" };
}

function sourceEventIdForMessage(channelId: string, ts: string): string {
  return `slack:${channelId}:${ts}`;
}

// Some event families (channel_rename, member_joined_channel, ...) carry the
// channel as an object rather than an id string.
function slackEventChannelId(event: any): string | undefined {
  const raw = event?.channel ?? event?.item?.channel;
  if (typeof raw === "string" && raw) return raw;
  if (raw && typeof raw === "object" && typeof raw.id === "string" && raw.id) return raw.id;
  return undefined;
}

/**
 * Append-only change-ledger row. Every observed edit/delete/reaction/lifecycle
 * change becomes a NEW activity_events row with a versioned source_event_id
 * (same change twice -> same id -> ON CONFLICT DO NOTHING). Ledger rows are
 * marked `_ledger: true` in the raw payload so the channel-day mirror keeps
 * rendering only current-state message rows, exactly as before.
 */
async function appendSlackLedgerEvent(input: {
  userId: string;
  workspaceId: string | null;
  eventType: string;
  sourceEventId: string;
  occurredTs: string | number | null | undefined;
  payload: Record<string, unknown>;
  extractedEntities?: Array<Record<string, unknown>> | null;
}): Promise<void> {
  const times = slackEventTimes(input.occurredTs, input.occurredTs);
  const rawPayload = redactSlackPayload({
    ...input.payload,
    _team_id: input.workspaceId,
    _ledger: true,
  });
  const [inserted] = await db
    .insert(activityEvents)
    .values({
      userId: input.userId,
      source: "slack",
      ...deriveActivityEventSourceContract({
        source: "slack",
        eventType: input.eventType,
        rawPayload,
        defaultRecordKind: "activity",
      }),
      eventType: input.eventType,
      timestamp: times.timestamp,
      sourceUpdatedAt: times.sourceUpdatedAt,
      wikiEligibilityAt: times.wikiEligibilityAt,
      rawPayload,
      sourceEventId: input.sourceEventId,
      processingStatus: "collected",
      extractedEntities: input.extractedEntities ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  if (inserted) {
    await enqueueCollectedEventForProcessing(inserted.id, input.userId, "slack");
  }
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
      ...(userInfo ? { name: userInfo.displayName, realName: userInfo.realName, email: userInfo.email } : {}),
    });
  }
  if (userInfo?.email) {
    entities.push({ type: "email_contact", id: userInfo.email.toLowerCase(), email: userInfo.email.toLowerCase() });
  }
  return entities.length > 0 ? entities : null;
}

async function materializeSlackEventDay(userId: string, channelId: string, ts: string): Promise<void> {
  await materializeSlackChannelDay(userId, channelId, ts);
  await enqueueSlackChannelWindows(userId, channelId);
}

export interface SlackSocketsOptions {
  userIds?: string[];
  onEvent?: (userId: string, eventType: string, channelId: string) => void;
}

export interface SlackSocketPoolHandle {
  close: () => void;
  userIds: string[];
}

export interface SlackRouteTarget {
  userId: string;
  token: string;
  slackUserId: string;
  slackTeamId: string;
}

interface SlackAuthorization {
  team_id?: string;
  user_id?: string;
}

const ROUTING_REFRESH_INTERVAL_MS = 60_000;
const AUTHORIZATIONS_CACHE_TTL_MS = 5 * 60_000;
const AUTHORIZATIONS_CACHE_MAX = 500;
const AUTHORIZATIONS_LIST_BACKOFF_MS = 60_000;
const SEEN_EVENT_TTL_MS = 15 * 60_000;
const SEEN_EVENT_MAX = 10_000;

export async function listSlackSocketUserIds(): Promise<string[]> {
  const rows = await db
    .select({ userId: integrationTokens.userId })
    .from(integrationTokens)
    .where(eq(integrationTokens.provider, "slack"));

  return [...new Set(rows.map((row) => row.userId).filter(Boolean))].sort();
}

function routeKey(teamId: string, slackUserId: string): string {
  return `${teamId}:${slackUserId}`;
}

async function fetchSlackIdentity(
  token: string,
): Promise<{ slackUserId: string; slackTeamId: string; teamName: string } | null> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as any;
    if (!data.ok) return null;
    return { slackUserId: data.user_id, slackTeamId: data.team_id, teamName: data.team };
  } catch {
    return null;
  }
}

export async function loadSlackRoutingTable(
  filterUserIds?: string[],
): Promise<Map<string, SlackRouteTarget[]>> {
  const connected = await listSlackSocketUserIds();
  const selected = filterUserIds?.length
    ? connected.filter((userId) => filterUserIds.includes(userId))
    : connected;
  const routing = new Map<string, SlackRouteTarget[]>();

  for (const userId of selected) {
    const stored = await getTokenWithMetadata(userId, "slack");
    if (!stored) continue;

    let slackUserId = typeof stored.metadata?.slackUserId === "string" ? stored.metadata.slackUserId : undefined;
    let slackTeamId = typeof stored.metadata?.slackTeamId === "string" ? stored.metadata.slackTeamId : undefined;

    if (!slackUserId || !slackTeamId) {
      // Connections made before identity metadata was stored - resolve once and persist.
      const identity = await fetchSlackIdentity(stored.token);
      if (!identity) {
        console.error(`[slack-socket] cannot resolve Slack identity for user ${userId}; excluded from realtime routing`);
        continue;
      }
      slackUserId = identity.slackUserId;
      slackTeamId = identity.slackTeamId;
      await mergeTokenMetadata(userId, "slack", { slackUserId, slackTeamId, teamName: identity.teamName });
    }

    const key = routeKey(slackTeamId, slackUserId);
    const targets = routing.get(key) ?? [];
    targets.push({ userId, token: stored.token, slackUserId, slackTeamId });
    routing.set(key, targets);
  }

  return routing;
}

// Slack redelivers unacked events, possibly on a different pool socket - dedup by event_id.
const seenEvents = new Map<string, number>();

function wasEventSeen(key: string): boolean {
  const expiresAt = seenEvents.get(key);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    seenEvents.delete(key);
    return false;
  }
  return true;
}

function markEventSeen(key: string): void {
  const now = Date.now();
  if (seenEvents.size >= SEEN_EVENT_MAX) {
    for (const [staleKey, expiresAt] of seenEvents) {
      if (seenEvents.size < SEEN_EVENT_MAX && expiresAt > now) break;
      seenEvents.delete(staleKey);
    }
  }
  seenEvents.set(key, now + SEEN_EVENT_TTL_MS);
}

// The envelope carries at most one authorization; the full per-event list comes from
// apps.event.authorizations.list (app token, needs the authorizations:read scope).
// Visibility is channel-scoped, so results are cached per team+channel.
const eventAuthorizationsCache = new Map<string, { auths: SlackAuthorization[]; expiresAt: number }>();
let authorizationsListUnavailableUntil = 0;

async function getFullEventAuthorizations(appToken: string, payload: any): Promise<SlackAuthorization[]> {
  const channelId = payload.event?.channel ?? payload.event?.item?.channel;
  const cacheKey = channelId && payload.team_id ? `${payload.team_id}:${channelId}` : null;
  const now = Date.now();

  if (cacheKey) {
    const cached = eventAuthorizationsCache.get(cacheKey);
    if (cached && now < cached.expiresAt) return cached.auths;
  }
  if (typeof payload.event_context !== "string" || !payload.event_context) {
    throw new Error("event payload missing event_context");
  }

  const auths: SlackAuthorization[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ event_context: payload.event_context, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch("https://slack.com/api/apps.event.authorizations.list", {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const data = await res.json() as any;
    if (!data.ok) throw new Error(String(data.error ?? "unknown_error"));
    for (const auth of data.authorizations ?? []) {
      auths.push({ team_id: auth.team_id, user_id: auth.user_id });
    }
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  if (cacheKey) {
    if (eventAuthorizationsCache.size >= AUTHORIZATIONS_CACHE_MAX) {
      for (const [staleKey, entry] of eventAuthorizationsCache) {
        if (eventAuthorizationsCache.size < AUTHORIZATIONS_CACHE_MAX && entry.expiresAt > now) break;
        eventAuthorizationsCache.delete(staleKey);
      }
    }
    eventAuthorizationsCache.set(cacheKey, { auths, expiresAt: now + AUTHORIZATIONS_CACHE_TTL_MS });
  }
  return auths;
}

function matchAuthorizations(
  auths: SlackAuthorization[],
  routing: Map<string, SlackRouteTarget[]>,
): SlackRouteTarget[] {
  const matched = new Map<string, SlackRouteTarget>();
  for (const auth of auths) {
    if (!auth.team_id || !auth.user_id) continue;
    for (const target of routing.get(routeKey(auth.team_id, auth.user_id)) ?? []) {
      matched.set(target.userId, target);
    }
  }
  return [...matched.values()];
}

export async function resolveEventTargets(
  payload: any,
  routing: Map<string, SlackRouteTarget[]>,
  appToken: string,
): Promise<SlackRouteTarget[]> {
  if (routing.size === 0) return [];

  const envelopeAuths: SlackAuthorization[] = Array.isArray(payload.authorizations) ? payload.authorizations : [];
  const fromEnvelope = matchAuthorizations(envelopeAuths, routing);

  // With a single routed Slack identity, a direct envelope match fully attributes
  // the event - no extra API call.
  if (routing.size === 1 && fromEnvelope.length > 0) return fromEnvelope;

  if (Date.now() < authorizationsListUnavailableUntil) return fromEnvelope;

  try {
    const auths = await getFullEventAuthorizations(appToken, payload);
    return matchAuthorizations(auths, routing);
  } catch (err) {
    authorizationsListUnavailableUntil = Date.now() + AUTHORIZATIONS_LIST_BACKOFF_MS;
    console.error(
      "[slack-socket] apps.event.authorizations.list failed (does the app token have authorizations:read?):",
      err instanceof Error ? err.message : err,
    );
    return fromEnvelope;
  }
}

export async function startSlackSockets(options: SlackSocketsOptions = {}): Promise<SlackSocketPoolHandle> {
  const configuredAppToken = env.SLACK_APP_TOKEN;
  if (!configuredAppToken) {
    console.log("SLACK_APP_TOKEN not set, skipping Socket Mode");
    return { close: () => {}, userIds: [] };
  }
  const appToken = configuredAppToken;

  let routing = await loadSlackRoutingTable(options.userIds);
  if (routing.size === 0) {
    console.log("[slack-socket] no connected Slack users yet; pool will route new connections after refresh");
  }

  let closed = false;
  let openSockets = 0;
  let everConnected = false;
  let sawTotalOutage = false;

  const routedUserIds = () => [...new Set([...routing.values()].flat().map((t) => t.userId))].sort();

  async function gapFillAfterOutage(): Promise<void> {
    try {
      const { pollConversations } = await import("./poller.js");
      for (const userId of routedUserIds()) {
        try {
          const filled = await pollConversations(userId);
          if (filled > 0) console.log(`[slack-socket] gap-fill recovered ${filled} messages for user ${userId}`);
        } catch (err) {
          console.error(`[slack-socket] gap-fill failed for user ${userId}:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error("[slack-socket] gap-fill failed:", err instanceof Error ? err.message : err);
    }
  }

  async function dispatchEvent(envelope: any): Promise<void> {
    const payload = envelope.payload;
    const event = payload?.event;
    if (!event) return;

    const channelId = slackEventChannelId(event);
    if (!channelId) {
      recordSlackSkip(SLACK_UNATTRIBUTED_SKIP_BUCKET, `realtime_no_channel:${event.type ?? "unknown"}`);
      return;
    }

    const eventKey = typeof payload.event_id === "string" && payload.event_id
      ? payload.event_id
      : typeof envelope.envelope_id === "string" && envelope.envelope_id
        ? envelope.envelope_id
        : null;
    if (eventKey) {
      if (wasEventSeen(eventKey)) return;
      markEventSeen(eventKey);
    }

    const targets = await resolveEventTargets(payload, routing, appToken);
    if (targets.length === 0) {
      // Never guess attribution: an event that cannot be mapped to an authorized
      // connected user is dropped (metadata-only log, no message content). The
      // drop is counted (never silent) and surfaces in the next slack.poll
      // sync-run result under `skips`.
      recordSlackSkip(SLACK_UNATTRIBUTED_SKIP_BUCKET, `unattributed:${event.type ?? "unknown"}`);
      console.warn(`[slack-socket] dropping unattributed ${event.type ?? "unknown"} event in ${channelId}`);
      return;
    }

    for (const target of targets) {
      await handleEvent(payload, target.userId, target.token, target.slackTeamId);
      options.onEvent?.(target.userId, event.type, channelId);
    }
  }

  function startPoolSocket(label: string): { close: () => void } {
    let ws: WebSocket | null = null;
    let opened = false;
    let reconnectDelay = INITIAL_RECONNECT_DELAY;
    let reconnectScheduled = false;
    let slotClosed = false;

    async function connect(): Promise<void> {
      if (slotClosed || closed) return;

      try {
        const res = await fetch("https://slack.com/api/apps.connections.open", {
          method: "POST",
          headers: { Authorization: `Bearer ${appToken}` },
        });
        const data = await res.json() as any;

        if (!data.ok) {
          console.error(`[slack-socket ${label}] connection open failed:`, data.error);
          scheduleReconnect();
          return;
        }

        ws = new WebSocket(data.url);

        ws.on("open", () => {
          console.log(`[slack-socket ${label}] connected`);
          reconnectDelay = INITIAL_RECONNECT_DELAY;
          opened = true;
          openSockets++;
          if (everConnected && sawTotalOutage) {
            sawTotalOutage = false;
            void gapFillAfterOutage();
          }
          everConnected = true;
        });

        ws.on("message", async (raw) => {
          const socket = ws; // Capture before any await
          try {
            const envelope = JSON.parse(raw.toString());

            // Ack immediately (Slack requires within 3 seconds)
            if (envelope.envelope_id && socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            }

            if (envelope.type === "disconnect") {
              // Slack asks for a refresh; close so reconnect opens a fresh socket
              console.log(`[slack-socket ${label}] disconnect requested (${envelope.reason ?? "unknown"})`);
              socket?.close();
              return;
            }

            if (envelope.type === "events_api") {
              await dispatchEvent(envelope);
            }
          } catch (err) {
            console.error(`[slack-socket ${label}] event error:`, err instanceof Error ? err.message : err);
          }
        });

        ws.on("close", () => {
          if (opened) {
            opened = false;
            openSockets--;
            if (openSockets === 0) sawTotalOutage = true;
          }
          ws = null;
          if (!slotClosed && !closed) {
            console.log(`[slack-socket ${label}] disconnected`);
            scheduleReconnect();
          }
        });

        ws.on("error", (err) => {
          console.error(`[slack-socket ${label}] WebSocket error:`, err.message);
          // Don't call ws.close() - the close event fires on its own after an error
        });
      } catch (err) {
        console.error(`[slack-socket ${label}] connect error:`, err instanceof Error ? err.message : err);
        scheduleReconnect();
      }
    }

    function scheduleReconnect(): void {
      if (slotClosed || closed || reconnectScheduled) return;
      reconnectScheduled = true;
      console.log(`[slack-socket ${label}] reconnecting in ${reconnectDelay}ms...`);
      setTimeout(() => { reconnectScheduled = false; void connect(); }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }

    void connect();

    return {
      close: () => {
        slotClosed = true;
        ws?.close();
      },
    };
  }

  const poolSize = Math.min(Math.max(Math.trunc(env.SLACK_SOCKET_POOL_SIZE ?? 2), 1), 10);
  const slots = Array.from({ length: poolSize }, (_, index) => startPoolSocket(`#${index + 1}`));

  // Pick up newly connected/disconnected users and rotated tokens without a restart.
  const refreshTimer = setInterval(async () => {
    try {
      routing = await loadSlackRoutingTable(options.userIds);
    } catch (err) {
      console.error("[slack-socket] routing refresh failed:", err instanceof Error ? err.message : err);
    }
  }, ROUTING_REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();

  return {
    userIds: routedUserIds(),
    close: () => {
      closed = true;
      clearInterval(refreshTimer);
      for (const slot of slots) slot.close();
    },
  };
}

export async function handleEvent(
  payload: any,
  userId: string,
  userToken: string,
  routedWorkspaceId?: string,
): Promise<void> {
  const event = payload.event;
  if (!event) return;
  const workspaceId = routedWorkspaceId ?? (typeof payload.team_id === "string" ? payload.team_id : null);

  const channelId = slackEventChannelId(event);
  if (!channelId) {
    recordSlackSkip(userId, `realtime_no_channel:${event?.type ?? "unknown"}`);
    return;
  }

  const channel = await getChannelName(channelId, userId);
  const eventSubtype = event.subtype as string | undefined;

  if (eventSubtype === "message_changed") {
    await handleMessageChanged(event, userId, channelId, channel, userToken, workspaceId);
    return;
  }

  if (eventSubtype === "message_deleted") {
    await handleMessageDeleted(event, userId, channelId, channel, workspaceId);
    return;
  }

  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    await handleReaction(event, userId, channelId, channel, workspaceId);
    return;
  }

  if (!event.ts) {
    // Channel lifecycle events (channel_rename, channel_archive, member_joined_channel, ...)
    // have no message ts; capture whatever arrives as an append-only ledger row.
    // Anything without even an event_ts is counted, never silently dropped.
    const eventTs = event.event_ts as string | undefined;
    const eventType = typeof event.type === "string" && event.type ? event.type : undefined;
    if (eventType && eventTs) {
      await appendSlackLedgerEvent({
        userId,
        workspaceId,
        eventType,
        sourceEventId: `slack:${channelId}:${eventType}:${eventTs}`,
        occurredTs: eventTs,
        payload: {
          ...event,
          _channel: channelId,
          _channel_name: channel.name,
          _channel_type: channel.type,
        },
        extractedEntities: typeof event.user === "string" && event.user
          ? [{ type: "slack_user", id: event.user }]
          : null,
      });
    } else {
      recordSlackSkip(userId, `realtime_unhandled:${eventSubtype ?? eventType ?? "unknown"}`);
    }
    return;
  }

  // Regular message or thread reply
  const msgUser = event.user as string | undefined;
  const userInfo = msgUser ? await getUserInfo(userId, userToken, msgUser) : undefined;
  const sourceEventId = sourceEventIdForMessage(channelId, String(event.ts));
  const times = slackEventTimes(event.ts, event.edited?.ts);
  const rawPayload = redactSlackPayload({
    ...event,
    _team_id: workspaceId,
    _channel: channelId,
    _channel_name: channel.name,
    _channel_type: channel.type,
    ...(userInfo ? {
      _user_name: userInfo.displayName,
      _user_real_name: userInfo.realName,
      _user_email: userInfo.email,
    } : {}),
  });

  const [inserted] = await db
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
      sourceEventId,
      processingStatus: "collected",
      extractedEntities: slackExtractedEntities(msgUser, userInfo),
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  if (inserted) {
    await enqueueCollectedEventForProcessing(inserted.id, userId, "slack");
    await materializeSlackEventDay(userId, channelId, String(event.ts));
  }

  await captureEventFiles(userId, userToken, channelId, event.files);
}

// Attachment bytes ride the binary_documents lane; per-file skips (too large,
// no download URL, fetch failed) are counted for the next poll sync run.
async function captureEventFiles(
  userId: string,
  userToken: string,
  channelId: string,
  files: unknown,
): Promise<void> {
  if (!Array.isArray(files) || files.length === 0) return;
  try {
    const result = await captureSlackMessageFiles({ userId, token: userToken, channelId, files });
    for (const [reason, count] of Object.entries(result.skips)) {
      recordSlackSkip(userId, reason, count);
    }
  } catch (err) {
    recordSlackSkip(userId, "file_capture_error");
    console.error(`[slack] file capture failed in ${channelId}:`, err instanceof Error ? err.message : err);
  }
}

export async function handleMessageChanged(
  event: any,
  userId: string,
  channelId: string,
  channel: { name: string; type: string },
  userToken: string,
  workspaceId: string | null = null,
): Promise<void> {
  const newMessage = event.message;
  const previousMessage = event.previous_message;
  if (!newMessage?.ts) return;

  const sourceEventId = sourceEventIdForMessage(channelId, String(newMessage.ts));

  // The edit itself is a new immutable observation, versioned by edit ts.
  {
    const editTs = String(newMessage.edited?.ts ?? event.event_ts ?? newMessage.ts);
    const editor = (newMessage.edited?.user ?? newMessage.user) as string | undefined;
    const editorInfo = editor ? await getUserInfo(userId, userToken, editor) : undefined;
    await appendSlackLedgerEvent({
      userId,
      workspaceId,
      eventType: "message.edited",
      sourceEventId: `slack:${channelId}:${newMessage.ts}:edit:${editTs}`,
      occurredTs: editTs,
      payload: {
        ...event,
        _object_ts: String(newMessage.ts),
        _channel: channelId,
        _channel_name: channel.name,
        _channel_type: channel.type,
        ...(editorInfo ? {
          _user_name: editorInfo.displayName,
          _user_real_name: editorInfo.realName,
          _user_email: editorInfo.email,
        } : {}),
      },
      extractedEntities: slackExtractedEntities(editor, editorInfo),
    });
  }

  const [existing] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.userId, userId),
        eq(activityEvents.sourceEventId, sourceEventId),
      ),
    )
    .limit(1);

  if (existing) {
    await materializeSlackEventDay(userId, channelId, String(newMessage.ts));
  } else {
    // Original wasn't captured (gap) - store the edited version as new
    const msgUser = newMessage.user as string | undefined;
    const userInfo = msgUser ? await getUserInfo(userId, userToken, msgUser) : undefined;
    const times = slackEventTimes(newMessage.ts, newMessage.edited?.ts);

    const rawPayload = redactSlackPayload({
      ...newMessage,
      _team_id: workspaceId,
      _channel: channelId,
      _channel_name: channel.name,
      _channel_type: channel.type,
      _edit_history: previousMessage ? [{ text: previousMessage.text, edited_at: newMessage.edited?.ts }] : [],
      ...(userInfo ? {
        _user_name: userInfo.displayName,
        _user_real_name: userInfo.realName,
        _user_email: userInfo.email,
      } : {}),
    });
    const [inserted] = await db
      .insert(activityEvents)
      .values({
        userId,
        source: "slack",
        ...deriveActivityEventSourceContract({
          source: "slack",
          eventType: "message",
          rawPayload,
          defaultRecordKind: "snapshot",
        }),
        eventType: "message",
        timestamp: times.timestamp,
        sourceUpdatedAt: times.sourceUpdatedAt,
        wikiEligibilityAt: times.wikiEligibilityAt,
        rawPayload,
        sourceEventId,
        processingStatus: "collected",
        extractedEntities: slackExtractedEntities(msgUser, userInfo),
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id });

    if (inserted) {
      await enqueueCollectedEventForProcessing(inserted.id, userId, "slack");
      await materializeSlackEventDay(userId, channelId, String(newMessage.ts));
    }
  }

  await captureEventFiles(userId, userToken, channelId, newMessage.files);
}

export async function handleMessageDeleted(
  event: any,
  userId: string,
  channelId: string,
  channel: { name: string; type: string },
  workspaceId: string | null = null,
): Promise<void> {
  const deletedTs = event.deleted_ts ?? event.previous_message?.ts;
  if (!deletedTs) return;

  const sourceEventId = sourceEventIdForMessage(channelId, String(deletedTs));

  // The deletion is a new immutable observation, even when the original was
  // never captured.
  {
    const eventTs = String(event.event_ts ?? event.ts ?? deletedTs);
    const author = event.previous_message?.user as string | undefined;
    await appendSlackLedgerEvent({
      userId,
      workspaceId,
      eventType: "message.deleted",
      sourceEventId: `slack:${channelId}:${deletedTs}:delete:${eventTs}`,
      occurredTs: eventTs,
      payload: {
        ...event,
        _object_ts: String(deletedTs),
        _channel: channelId,
        _channel_name: channel.name,
        _channel_type: channel.type,
      },
      extractedEntities: author ? [{ type: "slack_user", id: author }] : null,
    });
  }

  const [existing] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.userId, userId),
        eq(activityEvents.sourceEventId, sourceEventId),
      ),
    )
    .limit(1);

  if (existing) {
    await materializeSlackEventDay(userId, channelId, String(deletedTs));
  }
}

export async function handleReaction(
  event: any,
  userId: string,
  channelId: string,
  channel: { name: string; type: string },
  workspaceId: string | null = null,
): Promise<void> {
  const itemTs = event.item?.ts;
  if (!itemTs) return;

  // Append-only ledger: every reaction add/remove is a NEW row, versioned by
  // the reaction event's own ts so re-adding after a removal stays distinct.
  {
    const eventTs = String(event.event_ts ?? event.ts ?? itemTs);
    await appendSlackLedgerEvent({
      userId,
      workspaceId,
      eventType: event.type === "reaction_added" ? "message.reaction_added" : "message.reaction_removed",
      sourceEventId: `slack:${channelId}:${itemTs}:reaction:${event.reaction}:${event.user}:${eventTs}`,
      occurredTs: eventTs,
      payload: {
        ...event,
        _object_ts: String(itemTs),
        _channel: channelId,
        _channel_name: channel.name,
        _channel_type: channel.type,
      },
      extractedEntities: typeof event.user === "string" && event.user
        ? [{ type: "slack_user", id: event.user }]
        : null,
    });
  }

  // Try direct sourceEventId first, then thread reply form as fallback
  let existing: { id: string; rawPayload: unknown } | undefined;

  const directId = `slack:${channelId}:${itemTs}`;
  [existing] = await db
    .select({ id: activityEvents.id, rawPayload: activityEvents.rawPayload })
    .from(activityEvents)
    .where(and(eq(activityEvents.userId, userId), eq(activityEvents.sourceEventId, directId)))
    .limit(1);

  if (!existing) {
    // Fallback: message might be a thread reply with sourceEventId like slack:C123:threadTs:replyTs
    const [threadReply] = await db
      .select({ id: activityEvents.id, rawPayload: activityEvents.rawPayload })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.userId, userId),
          sql`${activityEvents.sourceEventId} LIKE ${"slack:" + channelId + ":%:" + itemTs}`,
        ),
      )
      .limit(1);
    existing = threadReply;
  }

  if (existing) {
    await materializeSlackEventDay(userId, channelId, String(itemTs));
  } else {
    // Message not in DB - store reaction as standalone event
    const now = new Date();
    const times = activityEventTimes(slackTimestampToDate(itemTs) ?? now, now);
    const rawPayload = redactSlackPayload({
      ...event,
      ts: itemTs,
      _team_id: workspaceId,
      _channel: channelId,
      _channel_name: channel.name,
      _channel_type: channel.type,
    });
    const [inserted] = await db
      .insert(activityEvents)
      .values({
        userId,
        source: "slack",
        ...deriveActivityEventSourceContract({
          source: "slack",
          eventType: event.type,
          rawPayload,
          defaultRecordKind: "activity",
        }),
        eventType: event.type,
        timestamp: times.timestamp,
        sourceUpdatedAt: times.sourceUpdatedAt,
        wikiEligibilityAt: times.wikiEligibilityAt,
        rawPayload,
        sourceEventId: `slack:${channelId}:${itemTs}:${event.type}:${event.user}:${event.reaction}`,
        processingStatus: "collected",
        extractedEntities: [{ type: "slack_user", id: event.user }],
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id });

    if (inserted) {
      await enqueueCollectedEventForProcessing(inserted.id, userId, "slack");
      await materializeSlackEventDay(userId, channelId, String(itemTs));
    }
  }
}
