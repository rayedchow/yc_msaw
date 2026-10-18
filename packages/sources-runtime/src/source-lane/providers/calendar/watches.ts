import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { env } from "../../../env.js";
import {
  GOOGLE_CALENDAR_EVENT_TYPES,
  GOOGLE_CALENDAR_LIST_RESOURCE_KEY,
  GOOGLE_CALENDAR_WEBHOOK_PATH,
  googleCalendarChannelTokenHash,
  type GoogleCalendarResourceType,
} from "../../../integrations/google/calendar/common.js";
import { calendarEventsWatchUrl } from "../../../integrations/google/calendar/poller.js";
import { GOOGLE_CALENDAR_DELEGATION_SCOPES } from "../../../vault/google-auth.js";
import { LaneGoogleApiError, errorText, laneClient, queryRows, type LaneGoogleClient } from "./google-lane.js";

/**
 * Push channels for the calendar lane (donor semantics: token stored only as a
 * sha256, resourceId checked by the webhook, "push not supported" remembered for
 * 24h). Added over the donor: channels are renewed inside the 24h window and the
 * replaced channel is stopped at Google (channels/stop), lapsed channels are
 * marked expired, and with no https WEBHOOK_BASE_URL the lane is polling-only.
 * The 60s calendar.poll schedule is always the fallback; a push only triggers an
 * earlier targeted poll.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const WATCH_TTL_SECONDS = Math.min(
  Math.max(60, Math.floor(Number(process.env.GOOGLE_CALENDAR_WATCH_TTL_SECONDS ?? 604_800))),
  604_800,
);
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PushMode = { enabled: true; address: string } | { enabled: false; reason: string };

export function calendarPushMode(base: string | undefined = env.WEBHOOK_BASE_URL): PushMode {
  const trimmed = base?.trim().replace(/\/$/, "");
  if (!trimmed) return { enabled: false, reason: "WEBHOOK_BASE_URL not configured; polling only" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { enabled: false, reason: "WEBHOOK_BASE_URL is not a URL; polling only" };
  }
  if (url.protocol !== "https:") return { enabled: false, reason: "Google push requires an https WEBHOOK_BASE_URL; polling only" };
  return { enabled: true, address: `${trimmed}${GOOGLE_CALENDAR_WEBHOOK_PATH}` };
}

interface ChannelRow {
  channel_id: string;
  resource_id: string;
  expiration: string | null;
  status: string;
}

/** Ensure (create / renew) the calendar-list channel and one events channel per calendar. Returns channels created. */
export async function ensureCalendarWatches(
  tenantId: string,
  client: LaneGoogleClient,
  mailbox: string,
  input: { calendarList: boolean; calendars: readonly string[] },
): Promise<number> {
  const mode = calendarPushMode();
  if (!mode.enabled) return 0;
  let created = 0;
  if (input.calendarList) {
    if (await ensureWatch(tenantId, client, mailbox, "calendar_list", GOOGLE_CALENDAR_LIST_RESOURCE_KEY, null, mode.address)) created++;
  }
  for (const calendarId of input.calendars) {
    try {
      if (await ensureWatch(tenantId, client, mailbox, "events", calendarId, calendarId, mode.address)) created++;
    } catch (err) {
      console.warn(`[calendar-lane] events watch failed for one calendar: ${errorText(err)}`);
    }
  }
  return created;
}

async function ensureWatch(
  tenantId: string,
  client: LaneGoogleClient,
  mailbox: string,
  resourceType: GoogleCalendarResourceType,
  resourceKey: string,
  calendarId: string | null,
  address: string,
): Promise<boolean> {
  await db.execute(sql`
    UPDATE google_calendar_watch_channels SET status = 'expired', updated_at = now()
    WHERE user_id = ${tenantId} AND delegated_email = ${mailbox} AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
      AND status = 'active' AND expiration IS NOT NULL AND expiration < now()
  `);
  const active = await queryRows<ChannelRow>(sql`
    SELECT channel_id, resource_id, expiration, status FROM google_calendar_watch_channels
    WHERE user_id = ${tenantId} AND delegated_email = ${mailbox} AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
      AND status = 'active'
    ORDER BY expiration DESC NULLS LAST
  `);
  const renewAfter = Date.now() + RENEWAL_WINDOW_MS;
  if (active.some((c) => c.expiration && new Date(c.expiration).getTime() > renewAfter)) return false;
  const [unsupported] = await queryRows<{ channel_id: string }>(sql`
    SELECT channel_id FROM google_calendar_watch_channels
    WHERE user_id = ${tenantId} AND delegated_email = ${mailbox} AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
      AND status = 'stopped' AND resource_id = 'unsupported' AND expiration > now()
    LIMIT 1
  `);
  if (unsupported) return false;

  const channelId = `gcal-${randomUUID()}`;
  const token = randomUUID();
  const url = resourceType === "calendar_list" ? new URL(`${CALENDAR_API}/users/me/calendarList/watch`) : calendarEventsWatchUrl(resourceKey);
  let watch: { id?: string; resourceId?: string; resourceUri?: string; expiration?: string };
  try {
    watch = await client.json(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: channelId, type: "web_hook", address, token, params: { ttl: String(WATCH_TTL_SECONDS) } }),
    });
  } catch (err) {
    if (err instanceof LaneGoogleApiError && err.status === 400 && /push notifications are not supported/i.test(err.message)) {
      await storeUnsupported(tenantId, mailbox, resourceType, resourceKey, calendarId);
      return false;
    }
    throw err;
  }
  if (!watch.resourceId) throw new Error(`Google Calendar watch response for ${url.pathname} did not include resourceId.`);
  const id = watch.id ?? channelId;
  const expiration = watch.expiration ? new Date(Number(watch.expiration)) : new Date(Date.now() + WATCH_TTL_SECONDS * 1000);
  const eventTypes = resourceType === "events" ? [...GOOGLE_CALENDAR_EVENT_TYPES] : [];
  await db.execute(sql`
    INSERT INTO google_calendar_watch_channels
      (channel_id, user_id, delegated_email, resource_type, resource_key, calendar_id, resource_id, resource_uri, token_hash, event_types, expiration, status, updated_at)
    VALUES (${id}, ${tenantId}, ${mailbox}, ${resourceType}, ${resourceKey}, ${calendarId}, ${watch.resourceId}, ${watch.resourceUri ?? null},
            ${googleCalendarChannelTokenHash(token)}, ${JSON.stringify(eventTypes)}::jsonb, ${expiration.toISOString()}, 'active', now())
  `);
  // The renewed channel replaces the old ones: stop them at Google so they stop pushing.
  const superseded = await queryRows<ChannelRow>(sql`
    UPDATE google_calendar_watch_channels SET status = 'superseded', updated_at = now()
    WHERE user_id = ${tenantId} AND delegated_email = ${mailbox} AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
      AND status = 'active' AND channel_id <> ${id}
    RETURNING channel_id, resource_id, expiration, status
  `);
  for (const old of superseded) await stopChannel(client, tenantId, old);
  return true;
}

async function stopChannel(client: LaneGoogleClient, tenantId: string, channel: ChannelRow): Promise<boolean> {
  if (!channel.resource_id || channel.resource_id === "unsupported") return false;
  try {
    await client.json(new URL(`${CALENDAR_API}/channels/stop`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: channel.channel_id, resourceId: channel.resource_id }),
    });
  } catch (err) {
    // 404: Google already forgot it. Anything else: the channel lapses at its expiration.
    if (!(err instanceof LaneGoogleApiError && err.status === 404)) {
      console.warn(`[calendar-lane] channels/stop failed: ${errorText(err)}`);
      return false;
    }
  }
  await db.execute(sql`
    UPDATE google_calendar_watch_channels SET status = 'stopped', updated_at = now()
    WHERE channel_id = ${channel.channel_id} AND user_id = ${tenantId}
  `);
  return true;
}

async function storeUnsupported(
  tenantId: string,
  mailbox: string,
  resourceType: GoogleCalendarResourceType,
  resourceKey: string,
  calendarId: string | null,
): Promise<void> {
  const digest = createHash("sha256").update(tenantId).update("\0").update(mailbox).update("\0").update(resourceType).update("\0").update(resourceKey).digest("hex").slice(0, 40);
  const channelId = `gcal-unsupported-${digest}`;
  const expiration = new Date(Date.now() + RENEWAL_WINDOW_MS).toISOString();
  const eventTypes = resourceType === "events" ? [...GOOGLE_CALENDAR_EVENT_TYPES] : [];
  await db.execute(sql`
    INSERT INTO google_calendar_watch_channels
      (channel_id, user_id, delegated_email, resource_type, resource_key, calendar_id, resource_id, resource_uri, token_hash, event_types, expiration, status, updated_at)
    VALUES (${channelId}, ${tenantId}, ${mailbox}, ${resourceType}, ${resourceKey}, ${calendarId}, 'unsupported', NULL,
            ${googleCalendarChannelTokenHash(channelId)}, ${JSON.stringify(eventTypes)}::jsonb, ${expiration}, 'stopped', now())
    ON CONFLICT (channel_id) DO UPDATE SET expiration = EXCLUDED.expiration, status = 'stopped', updated_at = now()
  `);
}

/**
 * Stop every active channel of a tenant (optionally one mailbox) at Google and mark
 * it stopped; used when a Google account or the tenant disconnects. Channels whose
 * credential can no longer be resolved are marked stopped locally (the webhook then
 * refuses them) and lapse at Google on expiration.
 */
export async function stopCalendarWatches(tenantId: string, mailbox?: string): Promise<{ stopped: number; local: number }> {
  const channels = await queryRows<ChannelRow & { delegated_email: string }>(mailbox
    ? sql`SELECT channel_id, resource_id, expiration, status, delegated_email FROM google_calendar_watch_channels
          WHERE user_id = ${tenantId} AND delegated_email = ${mailbox.trim().toLowerCase()} AND status IN ('active', 'superseded')`
    : sql`SELECT channel_id, resource_id, expiration, status, delegated_email FROM google_calendar_watch_channels
          WHERE user_id = ${tenantId} AND status IN ('active', 'superseded')`);
  let stopped = 0;
  let local = 0;
  const clients = new Map<string, LaneGoogleClient | null>();
  for (const channel of channels) {
    if (!clients.has(channel.delegated_email)) {
      clients.set(channel.delegated_email, await laneClient(tenantId, channel.delegated_email, GOOGLE_CALENDAR_DELEGATION_SCOPES, "google-calendar").catch(() => null));
    }
    const client = clients.get(channel.delegated_email);
    if (client && (await stopChannel(client, tenantId, channel))) {
      stopped++;
      continue;
    }
    await db.execute(sql`UPDATE google_calendar_watch_channels SET status = 'stopped', updated_at = now() WHERE channel_id = ${channel.channel_id} AND user_id = ${tenantId}`);
    local++;
  }
  return { stopped, local };
}
