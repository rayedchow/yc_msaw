import { sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  calendarEventStoreOptions,
  calendarEventsListUrl,
  calendarListUrl,
  storeCalendarEvent,
  type GoogleCalendarEvent,
  type GoogleCalendarRunResult,
} from "../../../integrations/google/calendar/poller.js";
import { GOOGLE_CALENDAR_LIST_RESOURCE_KEY } from "../../../integrations/google/calendar/common.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../../../lib/concurrency.js";
import { materializeCalendarEventSourceWiki, materializeSourceWikiIndexes } from "../../../mirror/materializer.js";
import { GOOGLE_CALENDAR_DELEGATION_SCOPES } from "../../../vault/google-auth.js";
import { GoogleRateLimitError } from "../../../vault/google-rate-limit.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import {
  LaneGoogleApiError,
  backoffSeconds,
  claimLease,
  classifyLaneFailure,
  clearListed,
  errorText,
  laneClient,
  loadMailboxStatus,
  markListed,
  newLeaseOwner,
  positiveIntegerEnv,
  queryRows,
  recordMailboxFailure,
  recordMailboxSuccess,
  recordRosterStatus,
  releaseLease,
  resolveGoogleRoster,
  type LaneGoogleClient,
} from "./google-lane.js";
import { ensureCalendarWatches } from "./watches.js";

/**
 * Google Calendar source-lane sync (replaces the donor runGoogleCalendarSetup /
 * runGoogleCalendarDelta orchestration; event storage is still the donor's
 * storeCalendarEvent, so snapshot identity, semantic diffs, raw ledger rows and the
 * mirror projection are unchanged).
 *
 * Differences from the donor orchestration, each closing an audit defect:
 *  * Full syncs are resumable: the page token is checkpointed after every page has
 *    been stored, and a run stops after a page budget instead of throwing at 20
 *    pages. The sync token is written only after the last page is stored.
 *  * A 410 keeps the snapshots (the donor deleted them and re-baselined): the reset
 *    full listing diffs against them, and when it completes every snapshot it did
 *    not return is removed (tombstoned) with reason `not_in_full_listing`.
 *  * Calendars that are deleted, unsubscribed or downgraded to free/busy remove
 *    that mailbox's snapshots (reason `calendar_<state>`); mirror files go only
 *    when no other mailbox still holds a live copy of the event.
 *  * Every mailbox resolves its own credential (DWD / OAuth / Composio through
 *    fetchGoogleApi). Auth, quota and API failures are recorded per mailbox or per
 *    calendar with persisted backoff; one failure never aborts the tenant.
 *  * Cursors are leased, so webhook-triggered polls cannot race the schedule.
 */

const CALENDAR_SYNC_CONCURRENCY = parseConcurrencyEnv("GOOGLE_CALENDAR_SYNC_CONCURRENCY", 5, { max: 10 });
const EVENT_STORE_CONCURRENCY = parseConcurrencyEnv("GOOGLE_CALENDAR_EVENT_STORE_CONCURRENCY", 8, { max: 10 });
export const MAX_CALENDARS_PER_MAILBOX = positiveIntegerEnv("GOOGLE_CALENDAR_SETUP_MAX_CALENDARS_PER_USER", 200);
/** Full-sync pages per calendar per run; the rest resumes from the checkpoint on the next run. */
export const FULL_SYNC_PAGE_BUDGET = positiveIntegerEnv("GOOGLE_CALENDAR_FULL_SYNC_PAGES_PER_RUN", 20);
const INCREMENTAL_PAGE_LIMIT = 500;

export type CalendarState = "active" | "deleted" | "not_syncable" | "over_cap" | "removed";

export interface CalendarListEntry {
  id: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  deleted?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface CalendarCursorRow {
  id: string;
  tenant_id: string;
  mailbox: string;
  resource_type: "calendar_list" | "events";
  resource_key: string;
  calendar: CalendarListEntry | null;
  calendar_state: CalendarState;
  sync_token: string | null;
  full_sync_started_at: string | null;
  full_sync_page_token: string | null;
  full_sync_pages: number;
  full_sync_reason: string | null;
  full_sync_completed_at: string | null;
  first_full_sync_completed_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  next_attempt_at: string | null;
}

export type CalendarLaneResult = GoogleCalendarRunResult & {
  mailboxesBlocked: number;
  mailboxesRateLimited: number;
  mailboxesFailed: number;
  mailboxesSkipped: number;
  calendarsPartial: number;
  calendarsFailed: number;
  fullSyncsCompleted: number;
  resets: number;
  eventsRemoved: number;
  /** True while any calendar still has a full sync in progress (bounded run). */
  capHit: boolean;
};

export interface CalendarLaneInput {
  channelId?: string | null;
  delegatedEmail?: string | null;
  calendarId?: string | null;
  delegatedEmails?: string[] | null;
  forceFull?: boolean | null;
}

function emptyResult(): CalendarLaneResult {
  return {
    delegatedUsers: 0,
    calendarListsSynced: 0,
    calendarsSeen: 0,
    calendarsSynced: 0,
    eventsSeen: 0,
    eventsStored: 0,
    watchesEnsured: 0,
    mailboxesBlocked: 0,
    mailboxesRateLimited: 0,
    mailboxesFailed: 0,
    mailboxesSkipped: 0,
    calendarsPartial: 0,
    calendarsFailed: 0,
    fullSyncsCompleted: 0,
    resets: 0,
    eventsRemoved: 0,
    capHit: false,
  };
}

export async function runCalendarLane(tenantId: string, input: CalendarLaneInput = {}): Promise<CalendarLaneResult> {
  const result = emptyResult();
  const forceFull = input.forceFull === true;

  if (input.channelId) {
    // Tenant comes from the task (server-bound); a channel of another tenant is never followed.
    const [channel] = await queryRows<{ delegated_email: string; resource_type: string; calendar_id: string | null }>(sql`
      SELECT delegated_email, resource_type, calendar_id FROM google_calendar_watch_channels
      WHERE channel_id = ${input.channelId} AND user_id = ${tenantId}
    `);
    if (!channel) throw new Error(`Google Calendar watch channel not found for this tenant: ${input.channelId}`);
    result.delegatedUsers = 1;
    await syncMailbox(tenantId, channel.delegated_email, result, {
      forceFull,
      onlyCalendarId: channel.resource_type === "events" ? channel.calendar_id ?? undefined : undefined,
    });
    return result;
  }

  const delegatedEmail = input.delegatedEmail?.trim().toLowerCase() || null;
  if (delegatedEmail) {
    result.delegatedUsers = 1;
    await syncMailbox(tenantId, delegatedEmail, result, { forceFull, onlyCalendarId: input.calendarId?.trim() || undefined });
    return result;
  }

  const roster = await resolveGoogleRoster(tenantId, { explicit: input.delegatedEmails, forceRefresh: forceFull });
  if (!input.delegatedEmails?.length) await recordRosterStatus(tenantId, "calendar", roster);
  result.delegatedUsers = roster.mailboxes.length;
  for (const mailbox of roster.mailboxes) {
    await syncMailbox(tenantId, mailbox, result, { forceFull });
  }
  return result;
}

async function syncMailbox(
  tenantId: string,
  mailbox: string,
  result: CalendarLaneResult,
  opts: { forceFull: boolean; onlyCalendarId?: string },
): Promise<void> {
  const status = await loadMailboxStatus(tenantId, "calendar", mailbox);
  if (!opts.forceFull && status?.next_attempt_at && new Date(status.next_attempt_at).getTime() > Date.now()) {
    result.mailboxesSkipped++;
    return;
  }

  let client: LaneGoogleClient;
  try {
    client = await laneClient(tenantId, mailbox, GOOGLE_CALENDAR_DELEGATION_SCOPES, "google-calendar");
  } catch (err) {
    const failure = classifyLaneFailure(err);
    await recordMailboxFailure(tenantId, "calendar", mailbox, failure);
    if (failure.kind === "auth_blocked") result.mailboxesBlocked++;
    else if (failure.kind === "rate_limited") result.mailboxesRateLimited++;
    else result.mailboxesFailed++;
    return;
  }

  try {
    let calendars: CalendarCursorRow[];
    if (opts.onlyCalendarId) {
      const cursor = await loadCursor(tenantId, mailbox, "events", opts.onlyCalendarId);
      calendars = cursor && cursor.calendar_state === "active" ? [cursor] : [];
    } else {
      calendars = await syncCalendarList(tenantId, client, result, opts.forceFull);
      result.calendarListsSynced++;
    }

    const abort: { error: GoogleRateLimitError | null } = { error: null };
    const outcomes = await mapWithConcurrency(calendars, CALENDAR_SYNC_CONCURRENCY, (cursor) =>
      syncCalendarEvents(tenantId, client, cursor, result, { forceFull: opts.forceFull, abort }));
    if (abort.error) throw abort.error;

    const partialCalendars = outcomes.filter((o) => o !== "complete").length;
    const overCap = opts.onlyCalendarId ? 0 : (await countCalendarsInState(tenantId, mailbox, "over_cap"));
    try {
      result.watchesEnsured += await ensureCalendarWatches(tenantId, client, mailbox, {
        calendarList: !opts.onlyCalendarId,
        calendars: calendars.filter((_, i) => outcomes[i] === "complete").map((c) => c.resource_key),
      });
    } catch (err) {
      console.warn(`[calendar-lane] watch maintenance failed for a mailbox: ${errorText(err)}`);
    }
    await recordMailboxSuccess(tenantId, "calendar", mailbox, {
      state: partialCalendars > 0 || overCap > 0 ? "partial" : "ok",
      reason: overCap > 0
        ? `${overCap} calendars beyond the ${MAX_CALENDARS_PER_MAILBOX}-calendar cap are not synced`
        : partialCalendars > 0 ? `${partialCalendars} calendars still syncing or failing` : null,
      authMode: client.mode,
      counts: { calendars: calendars.length, partialCalendars, overCap },
    });
  } catch (err) {
    const failure = classifyLaneFailure(err);
    await recordMailboxFailure(tenantId, "calendar", mailbox, failure, { authMode: client.mode });
    if (failure.kind === "auth_blocked") result.mailboxesBlocked++;
    else if (failure.kind === "rate_limited") result.mailboxesRateLimited++;
    else result.mailboxesFailed++;
  }
}

// ---------------------------------------------------------------------------
// Calendar list
// ---------------------------------------------------------------------------

async function syncCalendarList(
  tenantId: string,
  client: LaneGoogleClient,
  result: CalendarLaneResult,
  forceFull: boolean,
): Promise<CalendarCursorRow[]> {
  const mailbox = client.account;
  const cursor = await ensureCursor(tenantId, mailbox, "calendar_list", GOOGLE_CALENDAR_LIST_RESOURCE_KEY, null);
  let incremental = Boolean(cursor.sync_token) && !forceFull;
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  // A calendar-list full listing completes within one run, so its membership is kept in memory.
  const listed = new Set<string>();

  for (;;) {
    let data: { items?: CalendarListEntry[]; nextPageToken?: string; nextSyncToken?: string };
    try {
      data = await client.json(calendarListUrl({ syncToken: incremental ? cursor.sync_token : null, pageToken }));
    } catch (err) {
      if (err instanceof LaneGoogleApiError && err.status === 410 && incremental) {
        result.resets++;
        incremental = false;
        listed.clear();
        pageToken = undefined;
        await db.execute(sql`UPDATE google_calendar_lane_cursors SET sync_token = NULL, updated_at = now() WHERE id = ${cursor.id}`);
        continue;
      }
      throw err;
    }
    for (const entry of data.items ?? []) {
      if (!entry.id) continue;
      result.calendarsSeen++;
      listed.add(entry.id);
      await upsertCalendarEntry(tenantId, mailbox, entry);
    }
    nextSyncToken = data.nextSyncToken ?? nextSyncToken;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  if (!incremental) {
    // A completed full listing that no longer returns a calendar means it left this mailbox's list.
    const known = await queryRows<{ id: string; resource_key: string }>(sql`
      SELECT id::text, resource_key FROM google_calendar_lane_cursors
      WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND resource_type = 'events' AND calendar_state <> 'removed'
    `);
    for (const row of known) {
      if (listed.has(row.resource_key)) continue;
      await db.execute(sql`UPDATE google_calendar_lane_cursors SET calendar_state = 'removed', updated_at = now() WHERE id = ${row.id}::uuid`);
    }
  }
  await db.execute(sql`
    UPDATE google_calendar_lane_cursors SET
      sync_token = ${nextSyncToken ?? (incremental ? cursor.sync_token : null)},
      full_sync_completed_at = CASE WHEN ${!incremental}::boolean THEN now() ELSE full_sync_completed_at END,
      first_full_sync_completed_at = CASE WHEN ${!incremental}::boolean THEN COALESCE(first_full_sync_completed_at, now()) ELSE first_full_sync_completed_at END,
      last_incremental_at = CASE WHEN ${incremental}::boolean THEN now() ELSE last_incremental_at END,
      last_success_at = now(), last_attempt_at = now(), last_error = NULL, last_error_code = NULL,
      consecutive_failures = 0, next_attempt_at = NULL, updated_at = now()
    WHERE id = ${cursor.id}
  `);

  await applyCalendarCap(tenantId, mailbox);
  result.eventsRemoved += await removeInactiveCalendarSnapshots(tenantId, mailbox);
  return queryRows<CalendarCursorRow>(sql`
    SELECT * FROM google_calendar_lane_cursors
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND resource_type = 'events' AND calendar_state = 'active'
    ORDER BY COALESCE((calendar ->> 'primary')::boolean, false) DESC, resource_key
  `);
}

export function calendarStateOf(entry: CalendarListEntry): CalendarState {
  if (entry.deleted) return "deleted";
  if (entry.accessRole === "freeBusyReader") return "not_syncable";
  return "active";
}

async function upsertCalendarEntry(tenantId: string, mailbox: string, entry: CalendarListEntry): Promise<void> {
  const redacted = redactProviderPayload("google-calendar", entry) as CalendarListEntry;
  const state = calendarStateOf(entry);
  await db.execute(sql`
    INSERT INTO google_calendar_lane_cursors (tenant_id, mailbox, resource_type, resource_key, calendar, calendar_state, listed_at, updated_at)
    VALUES (${tenantId}, ${mailbox}, 'events', ${entry.id}, ${JSON.stringify(redacted)}::jsonb, ${state}, now(), now())
    ON CONFLICT (tenant_id, mailbox, resource_type, resource_key) DO UPDATE SET
      calendar = EXCLUDED.calendar, calendar_state = EXCLUDED.calendar_state, listed_at = now(), updated_at = now()
  `);
}

/** Primary first, then by id; calendars beyond the cap are flagged (never silently dropped). */
async function applyCalendarCap(tenantId: string, mailbox: string): Promise<void> {
  const rows = await queryRows<{ id: string; calendar_state: CalendarState }>(sql`
    SELECT id, calendar_state FROM google_calendar_lane_cursors
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND resource_type = 'events' AND calendar_state IN ('active', 'over_cap')
    ORDER BY COALESCE((calendar ->> 'primary')::boolean, false) DESC, resource_key
  `);
  for (const [i, row] of rows.entries()) {
    const want: CalendarState = i < MAX_CALENDARS_PER_MAILBOX ? "active" : "over_cap";
    if (row.calendar_state !== want) {
      await db.execute(sql`UPDATE google_calendar_lane_cursors SET calendar_state = ${want}, updated_at = now() WHERE id = ${row.id}`);
    }
  }
}

async function countCalendarsInState(tenantId: string, mailbox: string, state: CalendarState): Promise<number> {
  const [row] = await queryRows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM google_calendar_lane_cursors
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND resource_type = 'events' AND calendar_state = ${state}
  `);
  return Number(row?.n ?? 0);
}

/** Deleted / removed / free-busy-only calendars: tombstone this mailbox's snapshots and reset the cursor. */
async function removeInactiveCalendarSnapshots(tenantId: string, mailbox: string): Promise<number> {
  const inactive = await queryRows<{ id: string; resource_key: string; calendar_state: CalendarState }>(sql`
    SELECT c.id, c.resource_key, c.calendar_state FROM google_calendar_lane_cursors c
    WHERE c.tenant_id = ${tenantId} AND c.mailbox = ${mailbox} AND c.resource_type = 'events'
      AND c.calendar_state IN ('deleted', 'removed', 'not_syncable')
      AND (c.sync_token IS NOT NULL OR c.full_sync_started_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM google_calendar_event_snapshots s
        WHERE s.user_id = c.tenant_id AND s.delegated_email = c.mailbox AND s.calendar_id = c.resource_key))
  `);
  let removed = 0;
  for (const cal of inactive) {
    removed += await removeSnapshots(tenantId, mailbox, cal.resource_key, `calendar_${cal.calendar_state}`, null);
    await clearListed(cal.id);
    await db.execute(sql`
      UPDATE google_calendar_lane_cursors SET sync_token = NULL, full_sync_started_at = NULL, full_sync_page_token = NULL,
        full_sync_pages = 0, full_sync_reason = NULL, updated_at = now()
      WHERE id = ${cal.id}
    `);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type CalendarOutcome = "complete" | "partial" | "skipped" | "failed";

async function syncCalendarEvents(
  tenantId: string,
  client: LaneGoogleClient,
  cursorRow: CalendarCursorRow,
  result: CalendarLaneResult,
  opts: { forceFull: boolean; abort: { error: GoogleRateLimitError | null } },
): Promise<CalendarOutcome> {
  if (opts.abort.error) return "skipped";
  if (!opts.forceFull && cursorRow.next_attempt_at && new Date(cursorRow.next_attempt_at).getTime() > Date.now()) {
    result.calendarsPartial++;
    return "skipped";
  }
  const owner = newLeaseOwner();
  if (!(await claimLease("google_calendar_lane_cursors", cursorRow.id, owner))) {
    result.calendarsPartial++;
    return "skipped";
  }
  try {
    const cursor = (await loadCursorById(cursorRow.id)) ?? cursorRow;
    const outcome = await syncCalendarEventsLeased(tenantId, client, cursor, result, opts.forceFull);
    if (outcome === "complete") result.calendarsSynced++;
    else result.calendarsPartial++;
    return outcome;
  } catch (err) {
    const failure = classifyLaneFailure(err);
    const failures = cursorRow.consecutive_failures + 1;
    const next = new Date(Date.now() + backoffSeconds(failure, failures) * 1000);
    await db.execute(sql`
      UPDATE google_calendar_lane_cursors SET last_error = ${errorText(err)}, last_error_code = ${failure.code}, last_error_at = now(),
        last_attempt_at = now(), consecutive_failures = ${failures}, next_attempt_at = ${next.toISOString()}, updated_at = now()
      WHERE id = ${cursorRow.id}
    `);
    if (err instanceof GoogleRateLimitError) opts.abort.error = err;
    result.calendarsFailed++;
    return "failed";
  } finally {
    await releaseLease("google_calendar_lane_cursors", cursorRow.id, owner);
  }
}

async function syncCalendarEventsLeased(
  tenantId: string,
  client: LaneGoogleClient,
  cursor: CalendarCursorRow,
  result: CalendarLaneResult,
  forceFull: boolean,
): Promise<CalendarOutcome> {
  const target = eventTarget(client.account, cursor);
  if (forceFull && !cursor.full_sync_started_at) {
    await beginFullSync(cursor, "forced");
    cursor = (await loadCursorById(cursor.id))!;
  }

  if (cursor.sync_token && !cursor.full_sync_started_at) {
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    let pages = 0;
    try {
      for (;;) {
        const data = await client.json<{ items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
          calendarEventsListUrl(cursor.resource_key, { syncToken: cursor.sync_token, pageToken }),
        );
        await storePage(tenantId, target, data.items ?? [], result, { useIncremental: true });
        nextSyncToken = data.nextSyncToken ?? nextSyncToken;
        if (!data.nextPageToken) break;
        if (++pages >= INCREMENTAL_PAGE_LIMIT) throw new Error(`incremental Calendar sync exceeded ${INCREMENTAL_PAGE_LIMIT} pages`);
        pageToken = data.nextPageToken;
      }
    } catch (err) {
      if (!(err instanceof LaneGoogleApiError && err.status === 410)) throw err;
      // Sync token expired / invalidated: full re-listing against the kept snapshots.
      result.resets++;
      await beginFullSync(cursor, "sync_token_expired");
      return runFullSync(tenantId, client, (await loadCursorById(cursor.id))!, target, result);
    }
    // All pages are stored; only now does the cursor advance.
    await db.execute(sql`
      UPDATE google_calendar_lane_cursors SET sync_token = ${nextSyncToken ?? cursor.sync_token}, last_incremental_at = now(),
        last_success_at = now(), last_attempt_at = now(), last_error = NULL, last_error_code = NULL,
        consecutive_failures = 0, next_attempt_at = NULL, updated_at = now()
      WHERE id = ${cursor.id}
    `);
    return "complete";
  }

  if (!cursor.full_sync_started_at) {
    await beginFullSync(cursor, cursor.first_full_sync_completed_at ? "resync" : "initial");
    cursor = (await loadCursorById(cursor.id))!;
  }
  return runFullSync(tenantId, client, cursor, target, result);
}

async function runFullSync(
  tenantId: string,
  client: LaneGoogleClient,
  cursor: CalendarCursorRow,
  target: EventTarget,
  result: CalendarLaneResult,
): Promise<CalendarOutcome> {
  let pageToken = cursor.full_sync_page_token ?? undefined;
  let restarted = false;
  for (let pagesThisRun = 0; ; ) {
    if (pagesThisRun >= FULL_SYNC_PAGE_BUDGET) {
      result.capHit = true;
      await db.execute(sql`UPDATE google_calendar_lane_cursors SET last_attempt_at = now(), last_success_at = now(), updated_at = now() WHERE id = ${cursor.id}`);
      return "partial";
    }
    let data: { items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string };
    try {
      data = await client.json(calendarEventsListUrl(cursor.resource_key, { syncToken: null, pageToken }));
    } catch (err) {
      // A checkpointed page token can expire between runs: restart this full listing once.
      if (pageToken && !restarted && err instanceof LaneGoogleApiError && (err.status === 410 || err.status === 400)) {
        restarted = true;
        result.resets++;
        pageToken = undefined;
        await clearListed(cursor.id);
        await db.execute(sql`
          UPDATE google_calendar_lane_cursors SET full_sync_started_at = now(), full_sync_page_token = NULL,
            full_sync_pages = 0, full_sync_reason = 'page_token_invalid', updated_at = now()
          WHERE id = ${cursor.id}
        `);
        continue;
      }
      throw err;
    }
    await storePage(tenantId, target, data.items ?? [], result, { useIncremental: false });
    await markListed(cursor.id, (data.items ?? []).map((e) => e?.id).filter((id): id is string => Boolean(id)));
    pagesThisRun++;
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
      // Checkpoint only after the page's events are stored: a crash re-reads at most this page.
      await db.execute(sql`
        UPDATE google_calendar_lane_cursors SET full_sync_page_token = ${pageToken}, full_sync_pages = full_sync_pages + 1,
          last_attempt_at = now(), updated_at = now()
        WHERE id = ${cursor.id}
      `);
      continue;
    }
    if (!data.nextSyncToken) throw new Error("Google Calendar full sync ended without nextSyncToken");
    result.eventsRemoved += await removeSnapshots(tenantId, target.delegatedEmail, cursor.resource_key, "not_in_full_listing", cursor.id);
    await clearListed(cursor.id);
    await db.execute(sql`
      UPDATE google_calendar_lane_cursors SET sync_token = ${data.nextSyncToken}, full_sync_started_at = NULL, full_sync_page_token = NULL,
        full_sync_pages = 0, full_sync_reason = NULL, full_sync_completed_at = now(),
        first_full_sync_completed_at = COALESCE(first_full_sync_completed_at, now()),
        last_success_at = now(), last_attempt_at = now(), last_error = NULL, last_error_code = NULL,
        consecutive_failures = 0, next_attempt_at = NULL, updated_at = now()
      WHERE id = ${cursor.id}
    `);
    result.fullSyncsCompleted++;
    return "complete";
  }
}

async function beginFullSync(cursor: CalendarCursorRow, reason: string): Promise<void> {
  await clearListed(cursor.id);
  await db.execute(sql`
    UPDATE google_calendar_lane_cursors SET sync_token = NULL, full_sync_started_at = now(), full_sync_page_token = NULL,
      full_sync_pages = 0, full_sync_reason = ${reason}, updated_at = now()
    WHERE id = ${cursor.id}
  `);
}

interface EventTarget {
  delegatedEmail: string;
  calendar: { id: string; summary?: string; timeZone?: string; accessRole?: string; primary?: boolean };
}

function eventTarget(mailbox: string, cursor: CalendarCursorRow): EventTarget {
  const cal = cursor.calendar ?? { id: cursor.resource_key };
  return {
    delegatedEmail: mailbox,
    calendar: {
      id: cursor.resource_key,
      ...(typeof cal.summary === "string" ? { summary: cal.summary } : {}),
      ...(typeof cal.timeZone === "string" ? { timeZone: cal.timeZone } : {}),
      ...(typeof cal.accessRole === "string" ? { accessRole: cal.accessRole } : {}),
      ...(typeof cal.primary === "boolean" ? { primary: cal.primary } : {}),
    },
  };
}

async function storePage(
  tenantId: string,
  target: EventTarget,
  items: GoogleCalendarEvent[],
  result: CalendarLaneResult,
  mode: { useIncremental: boolean },
): Promise<void> {
  const events = items.filter((event): event is GoogleCalendarEvent & { id: string } => Boolean(event?.id));
  result.eventsSeen += events.length;
  // Donor storage semantics: full listings emit raw rows only for unseen events and no
  // semantic rows; incremental listings emit semantic changes. Snapshots are kept across
  // resets, so "unseen" really means new to this mailbox.
  const stored = await mapWithConcurrency(events, EVENT_STORE_CONCURRENCY, (event) =>
    storeCalendarEvent(tenantId, target, event, calendarEventStoreOptions({ useIncremental: mode.useIncremental })));
  result.eventsStored += stored.reduce((sum, n) => sum + n, 0);
}

/**
 * Delete this mailbox's snapshots of one calendar (all of them, or those the completed
 * full listing of `unlistedInCursor` did not return), recording `reason` on the revision
 * ledger, then drop the shared mirror projection for events no other mailbox holds live.
 */
export async function removeSnapshots(
  tenantId: string,
  mailbox: string,
  calendarId: string,
  reason: string,
  unlistedInCursor: string | null,
): Promise<number> {
  const removed = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('procmem.calendar_removed_reason', ${reason}, true)`);
    return queryRows<{ event_id: string; summary: string | null }>(unlistedInCursor
      ? sql`DELETE FROM google_calendar_event_snapshots s
            WHERE s.user_id = ${tenantId} AND s.delegated_email = ${mailbox} AND s.calendar_id = ${calendarId}
              AND NOT EXISTS (SELECT 1 FROM google_lane_full_listing_seen l WHERE l.cursor_id = ${unlistedInCursor}::uuid AND l.item_key = s.event_id)
            RETURNING s.event_id, s.summary`
      : sql`DELETE FROM google_calendar_event_snapshots
            WHERE user_id = ${tenantId} AND delegated_email = ${mailbox} AND calendar_id = ${calendarId}
            RETURNING event_id, summary`, tx);
  });
  let mirrorsRemoved = 0;
  for (const row of removed) {
    const [other] = await queryRows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM google_calendar_event_snapshots
      WHERE user_id = ${tenantId} AND calendar_id = ${calendarId} AND event_id = ${row.event_id}
        AND COALESCE(status, '') <> 'cancelled'
    `);
    if (Number(other?.n ?? 0) > 0) continue;
    try {
      await materializeCalendarEventSourceWiki(tenantId, {
        calendarId,
        eventId: row.event_id,
        summary: row.summary,
        status: "cancelled",
        rawPayload: {},
      }, { refreshIndexes: false });
      mirrorsRemoved++;
    } catch (err) {
      console.warn(`[calendar-lane] mirror removal failed: ${errorText(err)}`);
    }
  }
  if (mirrorsRemoved > 0) {
    await materializeSourceWikiIndexes(tenantId).catch((err) => console.warn(`[calendar-lane] index refresh failed: ${errorText(err)}`));
  }
  return removed.length;
}

// ---------------------------------------------------------------------------
// Cursor rows
// ---------------------------------------------------------------------------

async function ensureCursor(
  tenantId: string,
  mailbox: string,
  resourceType: "calendar_list" | "events",
  resourceKey: string,
  calendar: CalendarListEntry | null,
): Promise<CalendarCursorRow> {
  await db.execute(sql`
    INSERT INTO google_calendar_lane_cursors (tenant_id, mailbox, resource_type, resource_key, calendar)
    VALUES (${tenantId}, ${mailbox}, ${resourceType}, ${resourceKey}, ${calendar ? JSON.stringify(calendar) : null}::jsonb)
    ON CONFLICT (tenant_id, mailbox, resource_type, resource_key) DO NOTHING
  `);
  return (await loadCursor(tenantId, mailbox, resourceType, resourceKey))!;
}

export async function loadCursor(
  tenantId: string,
  mailbox: string,
  resourceType: "calendar_list" | "events",
  resourceKey: string,
): Promise<CalendarCursorRow | null> {
  const [row] = await queryRows<CalendarCursorRow>(sql`
    SELECT * FROM google_calendar_lane_cursors
    WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
  `);
  return row ?? null;
}

async function loadCursorById(id: string): Promise<CalendarCursorRow | null> {
  const [row] = await queryRows<CalendarCursorRow>(sql`SELECT * FROM google_calendar_lane_cursors WHERE id = ${id}`);
  return row ?? null;
}
