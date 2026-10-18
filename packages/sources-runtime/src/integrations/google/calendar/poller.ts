import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, ne } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { deriveActivityEventSourceContract } from "../../../db/activity-event-source.js";
import {
  activityEvents,
  conversationWatermarks,
  googleCalendarEventSnapshots,
  googleCalendarSyncStates,
  googleCalendarWatchChannels,
} from "../../../db/schema.js";
import { env } from "../../../env.js";
import { enqueueCollectedEventForProcessing } from "../../../queue/dispatch.js";
import { activityEventTimes, validDate } from "../../../lib/activity-event-time.js";
import {
  GOOGLE_CALENDAR_DELEGATION_SCOPES,
  GOOGLE_WORKSPACE_DIRECTORY_DELEGATION_SCOPES,
  getGoogleAccessToken,
  isDelegationConfigured,
} from "../../../vault/google-auth.js";
import { getTokenMetadata } from "../../../vault/tokens.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import { materializeCalendarEventSourceWiki } from "../../../mirror/materializer.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../../../lib/concurrency.js";
import {
  googleErrorMessageFromPayload,
  googleRateLimitErrorFromResponse,
  throwIfGoogleRateLimited,
} from "../../../vault/google-rate-limit.js";
import {
  GOOGLE_CALENDAR_EVENT_TYPES,
  GOOGLE_CALENDAR_LIST_RESOURCE_KEY,
  GOOGLE_CALENDAR_WEBHOOK_PATH,
  calendarEventTypeToActivityEventType,
  googleCalendarChannelTokenHash,
  googleCalendarSemanticSourceEventId,
  googleCalendarSourceEventId,
  type GoogleCalendarResourceType,
} from "./common.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DIRECTORY_API = "https://admin.googleapis.com/admin/directory/v1";
const WATCH_TTL_SECONDS = Math.min(
  Math.max(60, Math.floor(Number(process.env.GOOGLE_CALENDAR_WATCH_TTL_SECONDS ?? 604_800))),
  604_800,
);
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const SETUP_MAX_DELEGATED_USERS = positiveIntegerEnv("GOOGLE_CALENDAR_SETUP_MAX_DELEGATED_USERS", 500);
const SETUP_MAX_CALENDARS_PER_USER = positiveIntegerEnv("GOOGLE_CALENDAR_SETUP_MAX_CALENDARS_PER_USER", 200);
const SETUP_MAX_FULL_SYNC_EVENT_PAGES_PER_CALENDAR = positiveIntegerEnv(
  "GOOGLE_CALENDAR_SETUP_MAX_FULL_SYNC_EVENT_PAGES_PER_CALENDAR",
  20,
);
const CALENDAR_SYNC_CONCURRENCY = parseConcurrencyEnv("GOOGLE_CALENDAR_SYNC_CONCURRENCY", 5, { max: 10 });
const EVENT_STORE_CONCURRENCY = parseConcurrencyEnv("GOOGLE_CALENDAR_EVENT_STORE_CONCURRENCY", 8, { max: 10 });
// The recurring calendar.poll re-enters runGoogleCalendarSetup every cycle;
// re-enumerating the whole workspace directory (users.list, paged) each time
// is the single largest fixed cost of the cycle and the user roster changes
// on hours/days timescales, not minutes. Cache the directory result per
// tenant with a TTL; forceFull (setup / manual full resync) bypasses it.
// New workspace members are picked up within one TTL — accepted tradeoff.
const DIRECTORY_USERS_CACHE_TTL_MS = positiveIntegerEnv("GOOGLE_CALENDAR_DIRECTORY_CACHE_TTL_SECONDS", 3_600) * 1000;
const directoryUsersCache = new Map<string, { users: string[]; expiresAt: number }>();

export function clearGoogleCalendarDirectoryUsersCacheForTests(): void {
  directoryUsersCache.clear();
}

async function listWorkspaceUsersCached(userId: string, opts: { forceRefresh?: boolean } = {}): Promise<string[]> {
  const cached = directoryUsersCache.get(userId);
  if (!opts.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.users;
  const { users } = await listWorkspaceUsers(userId);
  directoryUsersCache.set(userId, { users, expiresAt: Date.now() + DIRECTORY_USERS_CACHE_TTL_MS });
  return users;
}

type CalendarSyncState = typeof googleCalendarSyncStates.$inferSelect;

function redactCalendarPayload(value: Record<string, unknown>): Record<string, unknown> {
  return redactProviderPayload("google-calendar", value) as Record<string, unknown>;
}

type DirectoryUser = {
  primaryEmail?: string;
  suspended?: boolean;
  archived?: boolean;
};

type DirectoryUsersResponse = {
  users?: DirectoryUser[];
  nextPageToken?: string;
};

type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  deleted?: boolean;
  hidden?: boolean;
};

type GoogleCalendarListResponse = {
  items?: GoogleCalendarListEntry[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

type GoogleCalendarPerson = {
  email?: string;
  displayName?: string;
  self?: boolean;
};

type GoogleCalendarEventDate = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type GoogleCalendarEvent = {
  id: string;
  iCalUID?: string;
  status?: string;
  eventType?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  created?: string;
  updated?: string;
  start?: GoogleCalendarEventDate;
  end?: GoogleCalendarEventDate;
  originalStartTime?: GoogleCalendarEventDate;
  organizer?: GoogleCalendarPerson;
  creator?: GoogleCalendarPerson;
  attendees?: Array<GoogleCalendarPerson & {
    optional?: boolean;
    responseStatus?: string;
    resource?: boolean;
  }>;
  recurrence?: string[];
  recurringEventId?: string;
  sequence?: number;
  conferenceData?: unknown;
  workingLocationProperties?: unknown;
  outOfOfficeProperties?: unknown;
  focusTimeProperties?: unknown;
  birthdayProperties?: unknown;
};

type GoogleCalendarEventsResponse = {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

type GoogleWatchResponse = {
  id?: string;
  resourceId?: string;
  resourceUri?: string;
  expiration?: string;
};

export type CalendarSyncMode = "full" | "incremental";
type CalendarEventSnapshot = typeof googleCalendarEventSnapshots.$inferSelect;

export type CalendarEventStoreOptions = {
  syncMode: CalendarSyncMode;
  emitRawOnNew: boolean;
};

export type CalendarSemanticChange = {
  eventType: string;
  changeKey: string;
  title: string;
  text: string;
  changedFields: string[];
  previous?: unknown;
  current?: unknown;
  subject?: Record<string, unknown>;
};

export type GoogleCalendarRunResult = {
  delegatedUsers: number;
  calendarListsSynced: number;
  calendarsSeen: number;
  calendarsSynced: number;
  eventsSeen: number;
  eventsStored: number;
  watchesEnsured: number;
};

type EventSyncTarget = {
  delegatedEmail: string;
  calendar: GoogleCalendarListEntry;
};

class GoogleCalendarApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleCalendarApiError";
  }
}

function emptyResult(): GoogleCalendarRunResult {
  return {
    delegatedUsers: 0,
    calendarListsSynced: 0,
    calendarsSeen: 0,
    calendarsSynced: 0,
    eventsSeen: 0,
    eventsStored: 0,
    watchesEnsured: 0,
  };
}

function addResult(target: GoogleCalendarRunResult, source: Partial<GoogleCalendarRunResult>): GoogleCalendarRunResult {
  target.delegatedUsers += source.delegatedUsers ?? 0;
  target.calendarListsSynced += source.calendarListsSynced ?? 0;
  target.calendarsSeen += source.calendarsSeen ?? 0;
  target.calendarsSynced += source.calendarsSynced ?? 0;
  target.eventsSeen += source.eventsSeen ?? 0;
  target.eventsStored += source.eventsStored ?? 0;
  target.watchesEnsured += source.watchesEnsured ?? 0;
  return target;
}

export function enforceCalendarSetupLimit(input: {
  label: string;
  count: number;
  max: number;
  context: string;
}): void {
  if (input.count <= input.max) return;
  throw new Error(
    `Google Calendar setup exceeded the configured ${input.label} limit for ${input.context}: ${input.count} > ${input.max}. `
      + "Increase the GOOGLE_CALENDAR_SETUP_MAX_* limits deliberately or run a narrower delegatedEmail/calendarId delta sync.",
  );
}

export async function runGoogleCalendarSetup(
  userId: string,
  opts: { forceFull?: boolean; delegatedEmails?: string[] | null } = {},
): Promise<GoogleCalendarRunResult> {
  const users = normalizeDelegatedEmails(opts.delegatedEmails);
  if (users.length === 0) {
    users.push(...await listWorkspaceUsersCached(userId, { forceRefresh: opts.forceFull === true }));
  }
  const result = emptyResult();
  result.delegatedUsers = users.length;

  for (const delegatedEmail of users) {
    const accessToken = await getGoogleAccessToken(userId, delegatedEmail, GOOGLE_CALENDAR_DELEGATION_SCOPES);
    addResult(result, await syncCalendarList(userId, delegatedEmail, accessToken, opts));
  }

  return result;
}

function normalizeDelegatedEmails(value: string[] | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort();
}

export async function runGoogleCalendarDelta(
  userId: string,
  input: {
    channelId?: string | null;
    delegatedEmail?: string | null;
    calendarId?: string | null;
    resourceType?: GoogleCalendarResourceType | null;
    forceFull?: boolean | null;
  } = {},
): Promise<GoogleCalendarRunResult> {
  if (input.channelId) {
    const [channel] = await db
      .select()
      .from(googleCalendarWatchChannels)
      .where(eq(googleCalendarWatchChannels.channelId, input.channelId))
      .limit(1);
    if (!channel) throw new Error(`Google Calendar watch channel not found: ${input.channelId}`);
    if (channel.userId !== userId) {
      throw new Error(`Google Calendar channel ${input.channelId} belongs to a different user`);
    }
    if (channel.resourceType === "calendar_list") {
      const accessToken = await getGoogleAccessToken(userId, channel.delegatedEmail, GOOGLE_CALENDAR_DELEGATION_SCOPES);
      return syncCalendarList(userId, channel.delegatedEmail, accessToken, { forceFull: input.forceFull ?? false });
    }
    if (channel.resourceType === "events") {
      if (!channel.calendarId) throw new Error(`Google Calendar event channel ${input.channelId} is missing calendarId`);
      return syncCalendarEventsForStoredCalendar(userId, channel.delegatedEmail, channel.calendarId, {
        forceFull: input.forceFull ?? false,
      });
    }
    throw new Error(`Unknown Google Calendar channel resource type: ${channel.resourceType}`);
  }

  const delegatedEmail = input.delegatedEmail?.trim().toLowerCase() ?? null;
  const calendarId = input.calendarId?.trim() ?? null;
  if (delegatedEmail && calendarId) {
    return syncCalendarEventsForStoredCalendar(userId, delegatedEmail, calendarId, {
      forceFull: input.forceFull ?? false,
    });
  }

  return runGoogleCalendarSetup(userId, { forceFull: input.forceFull ?? false });
}

async function listWorkspaceUsers(userId: string): Promise<{ adminEmail: string; users: string[] }> {
  const adminEmail = await requireDelegationAdminEmail(userId);
  const accessToken = await getGoogleAccessToken(userId, adminEmail, GOOGLE_WORKSPACE_DIRECTORY_DELEGATION_SCOPES);
  const users: string[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${DIRECTORY_API}/users`);
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", "500");
    url.searchParams.set("projection", "basic");
    url.searchParams.set("orderBy", "email");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await googleJson<DirectoryUsersResponse>(accessToken, url);
    for (const user of data.users ?? []) {
      const email = user.primaryEmail?.trim().toLowerCase();
      if (!email || user.suspended || user.archived) continue;
      if (users.includes(email)) continue;
      users.push(email);
      enforceCalendarSetupLimit({
        label: "delegated users",
        count: users.length,
        max: SETUP_MAX_DELEGATED_USERS,
        context: "workspace directory",
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  const uniqueUsers = [...new Set(users)].sort();
  if (uniqueUsers.length === 0) {
    throw new Error("Google Workspace Directory returned zero active users for Calendar ingestion.");
  }
  return { adminEmail, users: uniqueUsers };
}

async function requireDelegationAdminEmail(userId: string): Promise<string> {
  if (!isDelegationConfigured()) {
    throw new Error("Google Calendar ingestion requires Google Workspace domain-wide delegation credentials.");
  }
  const metadata = await getTokenMetadata(userId, "google");
  const usesDelegation = metadata?.delegation === true || metadata?.authMode === "domain_wide_delegation";
  if (!usesDelegation) {
    throw new Error("Google Calendar ingestion requires this user to be connected via Google Workspace domain-wide delegation.");
  }
  const email = typeof metadata?.email === "string" && metadata.email.trim()
    ? metadata.email.trim().toLowerCase()
    : env.GOOGLE_WORKSPACE_USER_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw new Error("Google Calendar ingestion needs a delegated admin email in Google token metadata or GOOGLE_WORKSPACE_USER_EMAIL.");
  }
  return email;
}

async function syncCalendarList(
  userId: string,
  delegatedEmail: string,
  accessToken: string,
  opts: { forceFull?: boolean } = {},
): Promise<GoogleCalendarRunResult> {
  const result = emptyResult();
  const state = await loadSyncState(userId, delegatedEmail, "calendar_list", GOOGLE_CALENDAR_LIST_RESOURCE_KEY);
  const useIncremental = Boolean(state?.syncToken && !opts.forceFull);
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  const calendarsToSync: GoogleCalendarListEntry[] = [];

  try {
    do {
      const url = calendarListUrl({
        syncToken: useIncremental ? state?.syncToken ?? null : null,
        pageToken,
      });
      const data = await googleJson<GoogleCalendarListResponse>(accessToken, url);
      for (const calendar of data.items ?? []) {
        if (!calendar.id) continue;
        result.calendarsSeen++;
        await upsertCalendarWatermark(userId, delegatedEmail, calendar);
        await upsertSyncState({
          userId,
          delegatedEmail,
          resourceType: "events",
          resourceKey: calendar.id,
          calendar,
          syncToken: null,
          preserveExistingSyncToken: true,
          full: false,
        });
        if (calendarCanSyncEvents(calendar)) calendarsToSync.push(calendar);
        enforceCalendarSetupLimit({
          label: "syncable calendars",
          count: calendarsToSync.length,
          max: SETUP_MAX_CALENDARS_PER_USER,
          context: delegatedEmail,
        });
      }
      pageToken = data.nextPageToken;
      nextSyncToken = data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
  } catch (err) {
    if (err instanceof GoogleCalendarApiError && err.status === 410 && useIncremental) {
      await clearSyncToken(userId, delegatedEmail, "calendar_list", GOOGLE_CALENDAR_LIST_RESOURCE_KEY);
      return syncCalendarList(userId, delegatedEmail, accessToken, { forceFull: true });
    }
    throw err;
  }

  await upsertSyncState({
    userId,
    delegatedEmail,
    resourceType: "calendar_list",
    resourceKey: GOOGLE_CALENDAR_LIST_RESOURCE_KEY,
    syncToken: nextSyncToken ?? state?.syncToken ?? null,
    full: !useIncremental,
  });
  result.calendarListsSynced++;
  if (await ensureCalendarListWatch(userId, delegatedEmail, accessToken)) result.watchesEnsured++;

  const calendarResults = await mapWithConcurrency(calendarsToSync, CALENDAR_SYNC_CONCURRENCY, (calendar) =>
    syncCalendarEvents(userId, accessToken, { delegatedEmail, calendar }));
  for (const calendarResult of calendarResults) {
    addResult(result, calendarResult);
  }

  return result;
}

async function syncCalendarEventsForStoredCalendar(
  userId: string,
  delegatedEmail: string,
  calendarId: string,
  opts: { forceFull?: boolean; baselineOnly?: boolean } = {},
): Promise<GoogleCalendarRunResult> {
  const state = await loadSyncState(userId, delegatedEmail, "events", calendarId);
  if (!state) {
    throw new Error(`No Google Calendar sync state for ${delegatedEmail}/${calendarId}`);
  }
  const accessToken = await getGoogleAccessToken(userId, delegatedEmail, GOOGLE_CALENDAR_DELEGATION_SCOPES);
  const calendar: GoogleCalendarListEntry = {
    id: calendarId,
    summary: state.calendarSummary ?? undefined,
    accessRole: state.calendarAccessRole ?? undefined,
    timeZone: state.calendarTimeZone ?? undefined,
    primary: state.calendarPrimary,
  };
  return syncCalendarEvents(userId, accessToken, { delegatedEmail, calendar }, opts);
}

async function syncCalendarEvents(
  userId: string,
  accessToken: string,
  target: EventSyncTarget,
  opts: { forceFull?: boolean; baselineOnly?: boolean } = {},
): Promise<GoogleCalendarRunResult> {
  const result = emptyResult();
  const state = await loadSyncState(userId, target.delegatedEmail, "events", target.calendar.id);
  const useIncremental = Boolean(state?.syncToken && !opts.forceFull);
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let fullSyncPagesFetched = 0;

  try {
    do {
      const url = calendarEventsListUrl(target.calendar.id, {
        syncToken: useIncremental ? state?.syncToken ?? null : null,
        pageToken,
      });
      const data = await googleJson<GoogleCalendarEventsResponse>(accessToken, url);
      if (!useIncremental) {
        fullSyncPagesFetched++;
        enforceCalendarSetupLimit({
          label: "full-sync event pages",
          count: fullSyncPagesFetched,
          max: SETUP_MAX_FULL_SYNC_EVENT_PAGES_PER_CALENDAR,
          context: `${target.delegatedEmail}/${target.calendar.id}`,
        });
      }
      const events = (data.items ?? []).filter((event): event is GoogleCalendarEvent & { id: string } => Boolean(event.id));
      result.eventsSeen += events.length;
      const storedCounts = await mapWithConcurrency(events, EVENT_STORE_CONCURRENCY, (event) =>
        storeCalendarEvent(userId, target, event, calendarEventStoreOptions({
          useIncremental,
          baselineOnly: opts.baselineOnly === true,
        })));
      result.eventsStored += storedCounts.reduce((sum, stored) => sum + stored, 0);
      pageToken = data.nextPageToken;
      nextSyncToken = data.nextSyncToken ?? nextSyncToken;
      if (!useIncremental && pageToken) {
        enforceCalendarSetupLimit({
          label: "full-sync event pages",
          count: fullSyncPagesFetched + 1,
          max: SETUP_MAX_FULL_SYNC_EVENT_PAGES_PER_CALENDAR,
          context: `${target.delegatedEmail}/${target.calendar.id}`,
        });
      }
    } while (pageToken);
  } catch (err) {
    if (err instanceof GoogleCalendarApiError && err.status === 410 && useIncremental) {
      await clearSyncToken(userId, target.delegatedEmail, "events", target.calendar.id);
      await clearCalendarEventSnapshots(userId, target.delegatedEmail, target.calendar.id);
      return syncCalendarEvents(userId, accessToken, target, { forceFull: true, baselineOnly: true });
    }
    throw err;
  }

  await upsertSyncState({
    userId,
    delegatedEmail: target.delegatedEmail,
    resourceType: "events",
    resourceKey: target.calendar.id,
    calendar: target.calendar,
    syncToken: nextSyncToken ?? state?.syncToken ?? null,
    full: !useIncremental,
  });
  result.calendarsSynced++;
  if (await ensureCalendarEventsWatch(userId, target.delegatedEmail, target.calendar, accessToken)) {
    result.watchesEnsured++;
  }
  await upsertCalendarWatermark(userId, target.delegatedEmail, target.calendar);
  return result;
}

export function calendarListUrl(input: { syncToken?: string | null; pageToken?: string | null }): URL {
  const url = new URL(`${CALENDAR_API}/users/me/calendarList`);
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("showHidden", "true");
  if (input.syncToken) url.searchParams.set("syncToken", input.syncToken);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return url;
}

export function calendarEventsListUrl(calendarId: string, input: { syncToken?: string | null; pageToken?: string | null }): URL {
  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("maxResults", "2500");
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("singleEvents", "true");
  for (const eventType of GOOGLE_CALENDAR_EVENT_TYPES) {
    url.searchParams.append("eventTypes", eventType);
  }
  if (input.syncToken) url.searchParams.set("syncToken", input.syncToken);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return url;
}

export function calendarEventsWatchUrl(calendarId: string): URL {
  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`);
  for (const eventType of GOOGLE_CALENDAR_EVENT_TYPES) {
    url.searchParams.append("eventTypes", eventType);
  }
  return url;
}

export async function storeCalendarEvent(
  userId: string,
  target: EventSyncTarget,
  event: GoogleCalendarEvent,
  input: CalendarEventStoreOptions,
): Promise<number> {
  const sourceEventId = googleCalendarSourceEventId({
    delegatedEmail: target.delegatedEmail,
    calendarId: target.calendar.id,
    eventId: event.id,
    revision: event.updated ?? event.created ?? event.status,
  });
  const timestamp = calendarEventTimestamp(event, target.calendar.timeZone);
  const sourceUpdatedAt = validDate(event.updated) ?? validDate(event.created) ?? timestamp;
  const normalizedPayload = normalizeCalendarEventPayload(target, event);
  const redactedPayload = redactCalendarPayload(normalizedPayload);
  const contentHash = googleCalendarEventContentHash(redactedPayload);
  const rawPayload = { ...redactedPayload, _content_hash: contentHash };
  const previous = await loadCalendarEventSnapshot(userId, target.delegatedEmail, target.calendar.id, event.id);

  if (previous?.contentHash === contentHash) {
    await upsertCalendarEventSnapshot(userId, target, rawPayload, contentHash, sourceUpdatedAt);
    return 0;
  }

  let insertedCount = 0;
  if (!previous) {
    if (event.status === "cancelled") {
      if (input.syncMode === "incremental") {
        insertedCount += await insertCalendarSemanticEvent(userId, target, event, rawPayload, contentHash, sourceUpdatedAt, {
          eventType: "calendar_event_cancelled",
          changeKey: "status:cancelled",
          title: calendarChangeTitle("Calendar event cancelled", rawPayload),
          text: `${calendarEventLabel(rawPayload)} was cancelled.`,
          changedFields: ["status"],
          previous: null,
          current: { status: "cancelled" },
        }) ? 1 : 0;
      }
      await upsertCalendarEventSnapshot(userId, target, rawPayload, contentHash, sourceUpdatedAt);
      await mirrorCalendarEventSourceWiki(userId, target, event, rawPayload, sourceUpdatedAt);
      return insertedCount;
    }

    if (input.emitRawOnNew) {
      insertedCount += await insertCalendarActivityEvent({
        userId,
        eventType: calendarEventTypeToActivityEventType(event.eventType, event.status),
        timestamp,
        sourceUpdatedAt,
        rawPayload,
        sourceEventId,
      }) ? 1 : 0;
    }
    await upsertCalendarEventSnapshot(userId, target, rawPayload, contentHash, sourceUpdatedAt);
    await mirrorCalendarEventSourceWiki(userId, target, event, rawPayload, sourceUpdatedAt);
    return insertedCount;
  }

  if (input.syncMode === "incremental") {
    const changes = deriveCalendarSemanticChanges(previous.rawPayload as Record<string, unknown>, rawPayload);
    for (const change of changes) {
      insertedCount += await insertCalendarSemanticEvent(userId, target, event, rawPayload, contentHash, sourceUpdatedAt, change) ? 1 : 0;
    }
  }

  await upsertCalendarEventSnapshot(userId, target, rawPayload, contentHash, sourceUpdatedAt);
  await mirrorCalendarEventSourceWiki(userId, target, event, rawPayload, sourceUpdatedAt);
  return insertedCount;
}

/**
 * Best-effort live mirror of one calendar event snapshot (same renderer as
 * the batch backfill; cancelled events remove the file there too). Only
 * invoked when the snapshot content hash is new or changed - unchanged
 * upserts skip the mirror entirely. A mirror failure must never fail or
 * retry the capture path.
 */
async function mirrorCalendarEventSourceWiki(
  userId: string,
  target: EventSyncTarget,
  event: GoogleCalendarEvent,
  rawPayload: Record<string, unknown>,
  sourceUpdatedAt: Date,
): Promise<void> {
  try {
    await materializeCalendarEventSourceWiki(userId, {
      calendarId: target.calendar.id,
      eventId: event.id,
      summary: event.summary ?? null,
      status: event.status ?? null,
      eventType: event.eventType ?? null,
      start: event.start ?? null,
      end: event.end ?? null,
      sourceUpdatedAt,
      rawPayload,
    });
  } catch (err) {
    console.warn(
      `[google-calendar] source mirror failed for ${target.calendar.id}/${event.id}:`,
      err instanceof Error ? err.name : "unknown error",
    );
  }
}

export function calendarEventStoreOptions(input: {
  useIncremental: boolean;
  baselineOnly?: boolean;
}): CalendarEventStoreOptions {
  return {
    syncMode: input.useIncremental ? "incremental" : "full",
    emitRawOnNew: input.baselineOnly !== true,
  };
}

async function insertCalendarActivityEvent(input: {
  userId: string;
  eventType: string;
  timestamp: Date;
  sourceUpdatedAt: Date;
  rawPayload: Record<string, unknown>;
  sourceEventId: string;
}): Promise<boolean> {
  const rawPayload = redactCalendarPayload(input.rawPayload);
  const [inserted] = await db
    .insert(activityEvents)
    .values({
      userId: input.userId,
      source: "calendar",
      ...deriveActivityEventSourceContract({
        source: "calendar",
        eventType: input.eventType,
        rawPayload,
      }),
      eventType: input.eventType,
      ...activityEventTimes(input.timestamp, input.sourceUpdatedAt),
      rawPayload,
      sourceEventId: input.sourceEventId,
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  if (!inserted?.id) return false;
  await enqueueCollectedEventForProcessing(inserted.id, input.userId);
  return true;
}

async function insertCalendarSemanticEvent(
  userId: string,
  target: EventSyncTarget,
  event: GoogleCalendarEvent,
  rawPayload: Record<string, unknown>,
  contentHash: string,
  sourceUpdatedAt: Date,
  change: CalendarSemanticChange,
): Promise<boolean> {
  const revision = event.updated ?? event.created ?? sourceUpdatedAt.toISOString() ?? contentHash;
  const sourceEventId = googleCalendarSemanticSourceEventId({
    delegatedEmail: target.delegatedEmail,
    calendarId: target.calendar.id,
    eventId: event.id,
    revision,
    semanticType: change.eventType,
    changeKey: change.changeKey,
  });
  const payload = {
    provider: "google_calendar",
    kind: "calendar_semantic_change",
    title: change.title,
    text: change.text,
    changeType: change.eventType,
    changeKey: change.changeKey,
    changedFields: change.changedFields,
    delegatedEmail: target.delegatedEmail,
    calendarId: target.calendar.id,
    calendarSummary: rawPayload.calendarSummary ?? target.calendar.summary ?? target.calendar.id,
    eventId: event.id,
    iCalUID: rawPayload.iCalUID ?? null,
    recurringEventId: rawPayload.recurringEventId ?? null,
    eventType: rawPayload.eventType ?? "default",
    status: rawPayload.status ?? null,
    summary: rawPayload.summary ?? "",
    start: rawPayload.start ?? null,
    end: rawPayload.end ?? null,
    originalStartTime: rawPayload.originalStartTime ?? null,
    location: rawPayload.location ?? "",
    htmlLink: rawPayload.htmlLink ?? null,
    organizer: rawPayload.organizer ?? null,
    creator: rawPayload.creator ?? null,
    previous: change.previous ?? null,
    current: change.current ?? null,
    subject: change.subject ?? null,
    sourceUpdatedAt: sourceUpdatedAt.toISOString(),
    _content_hash: contentHash,
  };

  return insertCalendarActivityEvent({
    userId,
    eventType: change.eventType,
    timestamp: sourceUpdatedAt,
    sourceUpdatedAt,
    rawPayload: payload,
    sourceEventId,
  });
}

async function loadCalendarEventSnapshot(
  userId: string,
  delegatedEmail: string,
  calendarId: string,
  eventId: string,
): Promise<CalendarEventSnapshot | null> {
  const [snapshot] = await db
    .select()
    .from(googleCalendarEventSnapshots)
    .where(and(
      eq(googleCalendarEventSnapshots.userId, userId),
      eq(googleCalendarEventSnapshots.delegatedEmail, delegatedEmail),
      eq(googleCalendarEventSnapshots.calendarId, calendarId),
      eq(googleCalendarEventSnapshots.eventId, eventId),
    ))
    .limit(1);
  return snapshot ?? null;
}

async function upsertCalendarEventSnapshot(
  userId: string,
  target: EventSyncTarget,
  rawPayload: Record<string, unknown>,
  contentHash: string,
  sourceUpdatedAt: Date,
): Promise<void> {
  const now = new Date();
  const redactedRawPayload = redactCalendarPayload(rawPayload);
  const values = {
    userId,
    delegatedEmail: target.delegatedEmail,
    calendarId: target.calendar.id,
    eventId: stringValue(rawPayload.eventId) ?? "",
    iCalUID: stringValue(rawPayload.iCalUID) ?? null,
    recurringEventId: stringValue(rawPayload.recurringEventId) ?? null,
    eventType: stringValue(rawPayload.eventType) ?? null,
    status: stringValue(rawPayload.status) ?? null,
    summary: stringValue(rawPayload.summary) ?? null,
    start: rawPayload.start ?? null,
    end: rawPayload.end ?? null,
    sourceUpdatedAt,
    contentHash,
    rawPayload: redactedRawPayload,
    lastSeenAt: now,
    updatedAt: now,
  };

  await db
    .insert(googleCalendarEventSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [
        googleCalendarEventSnapshots.userId,
        googleCalendarEventSnapshots.delegatedEmail,
        googleCalendarEventSnapshots.calendarId,
        googleCalendarEventSnapshots.eventId,
      ],
      set: {
        iCalUID: values.iCalUID,
        recurringEventId: values.recurringEventId,
        eventType: values.eventType,
        status: values.status,
        summary: values.summary,
        start: values.start,
        end: values.end,
        sourceUpdatedAt,
        contentHash,
        rawPayload: redactedRawPayload,
        lastSeenAt: now,
        updatedAt: now,
      },
    });
}

export function googleCalendarEventContentHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function deriveCalendarSemanticChanges(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): CalendarSemanticChange[] {
  const changes: CalendarSemanticChange[] = [];
  const prevStatus = stringValue(previous.status);
  const currentStatus = stringValue(current.status);

  if (prevStatus !== "cancelled" && currentStatus === "cancelled") {
    const cancelled = {
      ...current,
      summary: stringValue(current.summary) ?? stringValue(previous.summary) ?? current.summary,
    };
    changes.push({
      eventType: "calendar_event_cancelled",
      changeKey: "status:cancelled",
      title: calendarChangeTitle("Calendar event cancelled", cancelled),
      text: `${calendarEventLabel(cancelled)} was cancelled.`,
      changedFields: ["status"],
      previous: { status: prevStatus ?? null },
      current: { status: currentStatus },
    });
    return changes;
  } else if (prevStatus === "cancelled" && currentStatus && currentStatus !== "cancelled") {
    changes.push({
      eventType: "calendar_event_restored",
      changeKey: `status:${currentStatus}`,
      title: calendarChangeTitle("Calendar event restored", current),
      text: `${calendarEventLabel(current)} was restored with status ${currentStatus}.`,
      changedFields: ["status"],
      previous: { status: prevStatus },
      current: { status: currentStatus },
    });
  }

  if (changed(previous.start, current.start) || changed(previous.end, current.end)) {
    changes.push({
      eventType: "calendar_event_rescheduled",
      changeKey: "time",
      title: calendarChangeTitle("Calendar event rescheduled", current),
      text: `${calendarEventLabel(current)} moved from ${calendarTimeRange(previous)} to ${calendarTimeRange(current)}.`,
      changedFields: ["start", "end"],
      previous: pickFields(previous, ["start", "end"]),
      current: pickFields(current, ["start", "end"]),
    });
  }

  const detailFields = ["summary", "description", "eventType", "status"].filter((field) => changed(previous[field], current[field]));
  if (detailFields.length > 0 && !(detailFields.length === 1 && detailFields[0] === "status" && (prevStatus === "cancelled" || currentStatus === "cancelled"))) {
    changes.push({
      eventType: "calendar_event_details_changed",
      changeKey: `details:${detailFields.join(",")}`,
      title: calendarChangeTitle("Calendar event details changed", current),
      text: `${calendarEventLabel(current)} changed ${detailFields.join(", ")}.`,
      changedFields: detailFields,
      previous: pickFields(previous, detailFields),
      current: pickFields(current, detailFields),
    });
  }

  if (changed(previous.location, current.location)) {
    changes.push({
      eventType: "calendar_location_changed",
      changeKey: "location",
      title: calendarChangeTitle("Calendar location changed", current),
      text: `${calendarEventLabel(current)} location changed from ${quoted(stringValue(previous.location) ?? "none")} to ${quoted(stringValue(current.location) ?? "none")}.`,
      changedFields: ["location"],
      previous: { location: stringValue(previous.location) ?? null },
      current: { location: stringValue(current.location) ?? null },
    });
  }

  if (changed(previous.hangoutLink, current.hangoutLink) || changed(previous.conferenceData, current.conferenceData)) {
    changes.push({
      eventType: "calendar_conference_changed",
      changeKey: "conference",
      title: calendarChangeTitle("Calendar conference changed", current),
      text: `${calendarEventLabel(current)} conference details changed.`,
      changedFields: ["hangoutLink", "conferenceData"],
      previous: pickFields(previous, ["hangoutLink", "conferenceData"]),
      current: pickFields(current, ["hangoutLink", "conferenceData"]),
    });
  }

  if (changed(previous.recurrence, current.recurrence) || changed(previous.recurringEventId, current.recurringEventId)) {
    changes.push({
      eventType: "calendar_recurrence_changed",
      changeKey: "recurrence",
      title: calendarChangeTitle("Calendar recurrence changed", current),
      text: `${calendarEventLabel(current)} recurrence details changed.`,
      changedFields: ["recurrence", "recurringEventId"],
      previous: pickFields(previous, ["recurrence", "recurringEventId"]),
      current: pickFields(current, ["recurrence", "recurringEventId"]),
    });
  }

  changes.push(...attendeeChanges(previous, current));
  changes.push(...specializedCalendarEventChanges(previous, current));

  if (changes.length === 0 && googleCalendarEventContentHash(previous) !== googleCalendarEventContentHash(current)) {
    changes.push({
      eventType: "calendar_event_updated",
      changeKey: "unclassified",
      title: calendarChangeTitle("Calendar event updated", current),
      text: `${calendarEventLabel(current)} changed in Google Calendar.`,
      changedFields: ["rawEvent"],
      previous: null,
      current: null,
    });
  }

  return changes;
}

function attendeeChanges(previous: Record<string, unknown>, current: Record<string, unknown>): CalendarSemanticChange[] {
  const changes: CalendarSemanticChange[] = [];
  const previousAttendees = attendeeMap(previous.attendees);
  const currentAttendees = attendeeMap(current.attendees);

  for (const [key, attendee] of currentAttendees) {
    if (previousAttendees.has(key)) continue;
    changes.push({
      eventType: "calendar_attendee_added",
      changeKey: `attendee_added:${key}`,
      title: calendarChangeTitle("Calendar attendee added", current),
      text: `${attendeeLabel(attendee)} was added to ${calendarEventLabel(current)}.`,
      changedFields: ["attendees"],
      previous: null,
      current: attendee,
      subject: attendee,
    });
  }

  for (const [key, attendee] of previousAttendees) {
    if (currentAttendees.has(key)) continue;
    changes.push({
      eventType: "calendar_attendee_removed",
      changeKey: `attendee_removed:${key}`,
      title: calendarChangeTitle("Calendar attendee removed", current),
      text: `${attendeeLabel(attendee)} was removed from ${calendarEventLabel(current)}.`,
      changedFields: ["attendees"],
      previous: attendee,
      current: null,
      subject: attendee,
    });
  }

  for (const [key, attendee] of currentAttendees) {
    const previousAttendee = previousAttendees.get(key);
    if (!previousAttendee) continue;
    const previousResponse = stringValue(previousAttendee.responseStatus);
    const currentResponse = stringValue(attendee.responseStatus);
    if (previousResponse === currentResponse) continue;
    changes.push({
      eventType: "calendar_attendee_response_changed",
      changeKey: `attendee_response:${key}`,
      title: calendarChangeTitle("Calendar attendee response changed", current),
      text: `${attendeeLabel(attendee)} response for ${calendarEventLabel(current)} changed from ${previousResponse ?? "unknown"} to ${currentResponse ?? "unknown"}.`,
      changedFields: ["attendees.responseStatus"],
      previous: { ...previousAttendee, responseStatus: previousResponse ?? null },
      current: { ...attendee, responseStatus: currentResponse ?? null },
      subject: attendee,
    });
  }

  return changes;
}

function specializedCalendarEventChanges(previous: Record<string, unknown>, current: Record<string, unknown>): CalendarSemanticChange[] {
  const specs: Array<{ field: string; eventType: string; label: string }> = [
    { field: "workingLocationProperties", eventType: "calendar_working_location_changed", label: "working location" },
    { field: "outOfOfficeProperties", eventType: "calendar_out_of_office_changed", label: "out of office" },
    { field: "focusTimeProperties", eventType: "calendar_focus_time_changed", label: "focus time" },
    { field: "birthdayProperties", eventType: "calendar_birthday_changed", label: "birthday" },
  ];
  return specs.flatMap(({ field, eventType, label }) => changed(previous[field], current[field])
    ? [{
        eventType,
        changeKey: field,
        title: calendarChangeTitle(`Calendar ${label} changed`, current),
        text: `${calendarEventLabel(current)} ${label} details changed.`,
        changedFields: [field],
        previous: previous[field] ?? null,
        current: current[field] ?? null,
      }]
    : []);
}

function attendeeMap(value: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const attendee of arrayRecords(value)) {
    const key = stringValue(attendee.email)?.toLowerCase() ?? stringValue(attendee.name)?.toLowerCase();
    if (key) map.set(key, attendee);
  }
  return map;
}

function attendeeLabel(attendee: Record<string, unknown>): string {
  const name = stringValue(attendee.name);
  const email = stringValue(attendee.email);
  if (name && email && name !== email) return `${name} (${email})`;
  return name ?? email ?? "An attendee";
}

function calendarChangeTitle(prefix: string, payload: Record<string, unknown>): string {
  return `${prefix}: ${stringValue(payload.summary) ?? "Untitled event"}`;
}

function calendarEventLabel(payload: Record<string, unknown>): string {
  const summary = stringValue(payload.summary);
  if (summary) return `"${summary}"`;
  const time = calendarTimeRange(payload);
  return time === "an unspecified time" ? "\"Untitled event\"" : `"Untitled event at ${time}"`;
}

function calendarTimeRange(payload: Record<string, unknown>): string {
  const start = calendarDateLabel(payload.start) ?? calendarDateLabel(payload.originalStartTime);
  const end = calendarDateLabel(payload.end);
  if (start && end) return `${start} to ${end}`;
  return start ?? end ?? "an unspecified time";
}

function calendarDateLabel(value: unknown): string | null {
  const record = recordValue(value);
  return stringValue(record.dateTime) ?? stringValue(record.date);
}

function pickFields(payload: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) picked[field] = payload[field] ?? null;
  return picked;
}

function quoted(value: string): string {
  return `"${value}"`;
}

function changed(left: unknown, right: unknown): boolean {
  return stableJson(left ?? null) !== stableJson(right ?? null);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

export function calendarEventTimestamp(event: GoogleCalendarEvent, calendarTimeZone?: string | null): Date {
  return dateFromCalendarEventDate(event.start, calendarTimeZone)
    ?? dateFromCalendarEventDate(event.originalStartTime, calendarTimeZone)
    ?? validDate(event.created)
    ?? validDate(event.updated)
    ?? new Date();
}

function dateFromCalendarEventDate(value: GoogleCalendarEventDate | undefined, calendarTimeZone?: string | null): Date | null {
  if (!value) return null;
  if (value.dateTime) return validDate(value.dateTime);
  if (value.date) return allDayDateAtCalendarMidnight(value.date, value.timeZone ?? calendarTimeZone);
  return null;
}

function allDayDateAtCalendarMidnight(date: string, calendarTimeZone?: string | null): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return validDate(`${date}T00:00:00.000Z`);
  const timeZone = stringValue(calendarTimeZone) ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    return validDate(`${date}T00:00:00.000Z`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const offsetAtGuess = timeZoneOffsetMs(timeZone, new Date(utcMidnight));
  let instant = new Date(utcMidnight - offsetAtGuess);
  const offsetAtInstant = timeZoneOffsetMs(timeZone, instant);
  if (offsetAtInstant !== offsetAtGuess) instant = new Date(utcMidnight - offsetAtInstant);
  return instant;
}

function timeZoneOffsetMs(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "00";
  const asUtc = Date.UTC(
    Number(part("year")),
    Number(part("month")) - 1,
    Number(part("day")),
    Number(part("hour")),
    Number(part("minute")),
    Number(part("second")),
  );
  return asUtc - instant.getTime();
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.trunc(value);
}

function calendarCanSyncEvents(calendar: GoogleCalendarListEntry): boolean {
  if (calendar.deleted) return false;
  return calendar.accessRole !== "freeBusyReader";
}

export function normalizeCalendarEventPayload(
  target: EventSyncTarget,
  event: GoogleCalendarEvent,
): Record<string, unknown> {
  return {
    provider: "google_calendar",
    delegatedEmail: target.delegatedEmail,
    calendarId: target.calendar.id,
    calendarSummary: target.calendar.summary ?? target.calendar.id,
    calendarTimeZone: target.calendar.timeZone ?? null,
    calendarAccessRole: target.calendar.accessRole ?? null,
    calendarPrimary: target.calendar.primary ?? false,
    eventId: event.id,
    iCalUID: event.iCalUID ?? null,
    eventType: event.eventType ?? "default",
    status: event.status ?? null,
    summary: event.summary ?? "",
    description: event.description ?? "",
    location: event.location ?? "",
    htmlLink: event.htmlLink ?? null,
    hangoutLink: event.hangoutLink ?? null,
    created: event.created ?? null,
    updated: event.updated ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    originalStartTime: event.originalStartTime ?? null,
    organizer: normalizeCalendarPerson(event.organizer),
    creator: normalizeCalendarPerson(event.creator),
    attendees: (event.attendees ?? []).map((attendee) => ({
      ...normalizeCalendarPerson(attendee),
      optional: attendee.optional ?? false,
      responseStatus: attendee.responseStatus ?? null,
      resource: attendee.resource ?? false,
      self: attendee.self ?? false,
    })),
    recurrence: event.recurrence ?? [],
    recurringEventId: event.recurringEventId ?? null,
    sequence: event.sequence ?? null,
    conferenceData: event.conferenceData ?? null,
    workingLocationProperties: event.workingLocationProperties ?? null,
    outOfOfficeProperties: event.outOfOfficeProperties ?? null,
    focusTimeProperties: event.focusTimeProperties ?? null,
    birthdayProperties: event.birthdayProperties ?? null,
    rawEvent: event,
  };
}

function normalizeCalendarPerson(person: GoogleCalendarPerson | undefined): { email: string | null; name: string | null; self: boolean } | null {
  if (!person) return null;
  const email = person.email?.trim().toLowerCase() ?? null;
  const name = person.displayName?.trim() || email;
  if (!email && !name) return null;
  return { email, name, self: person.self ?? false };
}

async function ensureCalendarListWatch(userId: string, delegatedEmail: string, accessToken: string): Promise<boolean> {
  if (await hasActiveWatch(userId, delegatedEmail, "calendar_list", GOOGLE_CALENDAR_LIST_RESOURCE_KEY)) return false;
  if (await hasRecentUnsupportedWatch(userId, delegatedEmail, "calendar_list", GOOGLE_CALENDAR_LIST_RESOURCE_KEY)) return false;
  let watch: GoogleWatchResponse & { token: string; channelId: string };
  try {
    watch = await createWatch(accessToken, new URL(`${CALENDAR_API}/users/me/calendarList/watch`));
  } catch (err) {
    if (isUnsupportedCalendarWatchError(err)) {
      await storeUnsupportedWatchChannel({
        userId,
        delegatedEmail,
        resourceType: "calendar_list",
        resourceKey: GOOGLE_CALENDAR_LIST_RESOURCE_KEY,
        calendarId: null,
        eventTypes: [],
      });
      console.warn("[google-calendar] Calendar list push watch unsupported; continuing with sync-only state.");
      return false;
    }
    throw err;
  }
  await storeWatchChannel({
    userId,
    delegatedEmail,
    resourceType: "calendar_list",
    resourceKey: GOOGLE_CALENDAR_LIST_RESOURCE_KEY,
    calendarId: null,
    watch,
    eventTypes: [],
  });
  return true;
}

async function ensureCalendarEventsWatch(
  userId: string,
  delegatedEmail: string,
  calendar: GoogleCalendarListEntry,
  accessToken: string,
): Promise<boolean> {
  if (await hasActiveWatch(userId, delegatedEmail, "events", calendar.id)) return false;
  if (await hasRecentUnsupportedWatch(userId, delegatedEmail, "events", calendar.id)) return false;
  let watch: GoogleWatchResponse & { token: string; channelId: string };
  try {
    watch = await createWatch(accessToken, calendarEventsWatchUrl(calendar.id));
  } catch (err) {
    if (isUnsupportedCalendarWatchError(err)) {
      await storeUnsupportedWatchChannel({
        userId,
        delegatedEmail,
        resourceType: "events",
        resourceKey: calendar.id,
        calendarId: calendar.id,
        eventTypes: [...GOOGLE_CALENDAR_EVENT_TYPES],
      });
      console.warn("[google-calendar] Event push watch unsupported; continuing with sync-only state.");
      return false;
    }
    throw err;
  }
  await storeWatchChannel({
    userId,
    delegatedEmail,
    resourceType: "events",
    resourceKey: calendar.id,
    calendarId: calendar.id,
    watch,
    eventTypes: [...GOOGLE_CALENDAR_EVENT_TYPES],
  });
  return true;
}

function isUnsupportedCalendarWatchError(err: unknown): boolean {
  return err instanceof GoogleCalendarApiError
    && err.status === 400
    && /push notifications are not supported/i.test(err.message);
}

async function hasActiveWatch(
  userId: string,
  delegatedEmail: string,
  resourceType: GoogleCalendarResourceType,
  resourceKey: string,
): Promise<boolean> {
  const minimumExpiration = new Date(Date.now() + WATCH_RENEWAL_WINDOW_MS);
  const [existing] = await db
    .select({ channelId: googleCalendarWatchChannels.channelId })
    .from(googleCalendarWatchChannels)
    .where(and(
      eq(googleCalendarWatchChannels.userId, userId),
      eq(googleCalendarWatchChannels.delegatedEmail, delegatedEmail),
      eq(googleCalendarWatchChannels.resourceType, resourceType),
      eq(googleCalendarWatchChannels.resourceKey, resourceKey),
      eq(googleCalendarWatchChannels.status, "active"),
      gt(googleCalendarWatchChannels.expiration, minimumExpiration),
    ))
    .limit(1);
  return Boolean(existing);
}

async function hasRecentUnsupportedWatch(
  userId: string,
  delegatedEmail: string,
  resourceType: GoogleCalendarResourceType,
  resourceKey: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ channelId: googleCalendarWatchChannels.channelId })
    .from(googleCalendarWatchChannels)
    .where(and(
      eq(googleCalendarWatchChannels.userId, userId),
      eq(googleCalendarWatchChannels.delegatedEmail, delegatedEmail),
      eq(googleCalendarWatchChannels.resourceType, resourceType),
      eq(googleCalendarWatchChannels.resourceKey, resourceKey),
      eq(googleCalendarWatchChannels.status, "stopped"),
      eq(googleCalendarWatchChannels.resourceId, "unsupported"),
      gt(googleCalendarWatchChannels.expiration, new Date()),
    ))
    .limit(1);
  return Boolean(existing);
}

async function createWatch(accessToken: string, url: URL): Promise<GoogleWatchResponse & { token: string; channelId: string }> {
  const address = webhookAddress();
  const channelId = `gcal-${randomUUID()}`;
  const token = randomUUID();
  const watch = await googleJson<GoogleWatchResponse>(accessToken, url, {
    method: "POST",
    body: JSON.stringify({
      id: channelId,
      type: "web_hook",
      address,
      token,
      params: { ttl: String(WATCH_TTL_SECONDS) },
    }),
    headers: { "Content-Type": "application/json" },
  });
  if (!watch.resourceId) {
    throw new Error(`Google Calendar watch response for ${url.pathname} did not include resourceId.`);
  }
  return { ...watch, token, channelId: watch.id ?? channelId };
}

function webhookAddress(): string {
  const base = env.WEBHOOK_BASE_URL?.replace(/\/$/, "");
  if (!base) throw new Error("WEBHOOK_BASE_URL is required for Google Calendar push subscriptions.");
  return `${base}${GOOGLE_CALENDAR_WEBHOOK_PATH}`;
}

async function storeWatchChannel(input: {
  userId: string;
  delegatedEmail: string;
  resourceType: GoogleCalendarResourceType;
  resourceKey: string;
  calendarId: string | null;
  watch: GoogleWatchResponse & { token: string; channelId: string };
  eventTypes: string[];
}): Promise<void> {
  const now = new Date();
  const expiration = input.watch.expiration
    ? new Date(Number(input.watch.expiration))
    : new Date(Date.now() + WATCH_TTL_SECONDS * 1000);
  await db
    .insert(googleCalendarWatchChannels)
    .values({
      channelId: input.watch.channelId,
      userId: input.userId,
      delegatedEmail: input.delegatedEmail,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      calendarId: input.calendarId,
      resourceId: input.watch.resourceId!,
      resourceUri: input.watch.resourceUri ?? null,
      tokenHash: googleCalendarChannelTokenHash(input.watch.token),
      eventTypes: input.eventTypes,
      expiration,
      status: "active",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: googleCalendarWatchChannels.channelId,
      set: {
        userId: input.userId,
        delegatedEmail: input.delegatedEmail,
        resourceType: input.resourceType,
        resourceKey: input.resourceKey,
        calendarId: input.calendarId,
        resourceId: input.watch.resourceId!,
        resourceUri: input.watch.resourceUri ?? null,
        tokenHash: googleCalendarChannelTokenHash(input.watch.token),
        eventTypes: input.eventTypes,
        expiration,
        status: "active",
        updatedAt: now,
      },
    });

  await db
    .update(googleCalendarWatchChannels)
    .set({ status: "superseded", updatedAt: now })
    .where(and(
      eq(googleCalendarWatchChannels.userId, input.userId),
      eq(googleCalendarWatchChannels.delegatedEmail, input.delegatedEmail),
      eq(googleCalendarWatchChannels.resourceType, input.resourceType),
      eq(googleCalendarWatchChannels.resourceKey, input.resourceKey),
      eq(googleCalendarWatchChannels.status, "active"),
      ne(googleCalendarWatchChannels.channelId, input.watch.channelId),
    ));
}

async function storeUnsupportedWatchChannel(input: {
  userId: string;
  delegatedEmail: string;
  resourceType: GoogleCalendarResourceType;
  resourceKey: string;
  calendarId: string | null;
  eventTypes: string[];
}): Promise<void> {
  const now = new Date();
  const channelId = unsupportedWatchChannelId(input);
  const expiration = new Date(Date.now() + WATCH_RENEWAL_WINDOW_MS);
  await db
    .insert(googleCalendarWatchChannels)
    .values({
      channelId,
      userId: input.userId,
      delegatedEmail: input.delegatedEmail,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      calendarId: input.calendarId,
      resourceId: "unsupported",
      resourceUri: null,
      tokenHash: googleCalendarChannelTokenHash(channelId),
      eventTypes: input.eventTypes,
      expiration,
      status: "stopped",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: googleCalendarWatchChannels.channelId,
      set: {
        expiration,
        status: "stopped",
        updatedAt: now,
      },
    });
}

function unsupportedWatchChannelId(input: {
  userId: string;
  delegatedEmail: string;
  resourceType: GoogleCalendarResourceType;
  resourceKey: string;
}): string {
  const digest = createHash("sha256")
    .update(input.userId)
    .update("\0")
    .update(input.delegatedEmail)
    .update("\0")
    .update(input.resourceType)
    .update("\0")
    .update(input.resourceKey)
    .digest("hex")
    .slice(0, 40);
  return `gcal-unsupported-${digest}`;
}

async function loadSyncState(
  userId: string,
  delegatedEmail: string,
  resourceType: GoogleCalendarResourceType,
  resourceKey: string,
): Promise<CalendarSyncState | null> {
  const [state] = await db
    .select()
    .from(googleCalendarSyncStates)
    .where(and(
      eq(googleCalendarSyncStates.userId, userId),
      eq(googleCalendarSyncStates.delegatedEmail, delegatedEmail),
      eq(googleCalendarSyncStates.resourceType, resourceType),
      eq(googleCalendarSyncStates.resourceKey, resourceKey),
    ))
    .limit(1);
  return state ?? null;
}

async function upsertSyncState(input: {
  userId: string;
  delegatedEmail: string;
  resourceType: GoogleCalendarResourceType;
  resourceKey: string;
  calendar?: GoogleCalendarListEntry | null;
  syncToken: string | null;
  full: boolean;
  preserveExistingSyncToken?: boolean;
}): Promise<void> {
  const now = new Date();
  const set: Partial<typeof googleCalendarSyncStates.$inferInsert> = {
    calendarId: input.calendar?.id ?? null,
    calendarSummary: input.calendar?.summary ?? null,
    calendarAccessRole: input.calendar?.accessRole ?? null,
    calendarTimeZone: input.calendar?.timeZone ?? null,
    calendarPrimary: input.calendar?.primary ?? false,
    updatedAt: now,
  };
  if (!input.preserveExistingSyncToken) set.syncToken = input.syncToken;
  if (input.full) {
    set.lastFullSyncAt = now;
  } else {
    set.lastIncrementalSyncAt = now;
  }

  await db
    .insert(googleCalendarSyncStates)
    .values({
      userId: input.userId,
      delegatedEmail: input.delegatedEmail,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      calendarId: input.calendar?.id ?? null,
      calendarSummary: input.calendar?.summary ?? null,
      calendarAccessRole: input.calendar?.accessRole ?? null,
      calendarTimeZone: input.calendar?.timeZone ?? null,
      calendarPrimary: input.calendar?.primary ?? false,
      syncToken: input.syncToken,
      lastFullSyncAt: input.full ? now : null,
      lastIncrementalSyncAt: input.full ? null : now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        googleCalendarSyncStates.userId,
        googleCalendarSyncStates.delegatedEmail,
        googleCalendarSyncStates.resourceType,
        googleCalendarSyncStates.resourceKey,
      ],
      set,
    });
}

async function clearSyncToken(
  userId: string,
  delegatedEmail: string,
  resourceType: GoogleCalendarResourceType,
  resourceKey: string,
): Promise<void> {
  await db
    .update(googleCalendarSyncStates)
    .set({ syncToken: null, updatedAt: new Date() })
    .where(and(
      eq(googleCalendarSyncStates.userId, userId),
      eq(googleCalendarSyncStates.delegatedEmail, delegatedEmail),
      eq(googleCalendarSyncStates.resourceType, resourceType),
      eq(googleCalendarSyncStates.resourceKey, resourceKey),
    ));
}

async function clearCalendarEventSnapshots(
  userId: string,
  delegatedEmail: string,
  calendarId: string,
): Promise<void> {
  await db
    .delete(googleCalendarEventSnapshots)
    .where(and(
      eq(googleCalendarEventSnapshots.userId, userId),
      eq(googleCalendarEventSnapshots.delegatedEmail, delegatedEmail),
      eq(googleCalendarEventSnapshots.calendarId, calendarId),
    ));
}

async function upsertCalendarWatermark(
  userId: string,
  delegatedEmail: string,
  calendar: GoogleCalendarListEntry,
): Promise<void> {
  const now = new Date();
  const conversationId = `${delegatedEmail}:${calendar.id}`;
  await db
    .insert(conversationWatermarks)
    .values({
      userId,
      provider: "calendar",
      conversationId,
      conversationType: "google_calendar",
      conversationName: calendar.summary ?? calendar.id,
      lastPolledAt: now,
      isActive: !calendar.deleted,
    })
    .onConflictDoUpdate({
      target: [
        conversationWatermarks.userId,
        conversationWatermarks.provider,
        conversationWatermarks.conversationId,
      ],
      set: {
        conversationType: "google_calendar",
        conversationName: calendar.summary ?? calendar.id,
        lastPolledAt: now,
        isActive: !calendar.deleted,
      },
    });
}

async function googleJson<T>(accessToken: string, url: URL, init: RequestInit = {}): Promise<T> {
  throwIfGoogleRateLimited("google-calendar");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json");
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const rateLimit = googleRateLimitErrorFromResponse("google-calendar", res, data);
    if (rateLimit) throw rateLimit;
    const message = errorMessageFromGooglePayload(data) ?? `${res.status} ${res.statusText}`;
    throw new GoogleCalendarApiError(`Google Calendar API request failed: ${message}`, res.status);
  }
  return (data ?? {}) as T;
}

function errorMessageFromGooglePayload(data: unknown): string | null {
  return googleErrorMessageFromPayload(data);
}
