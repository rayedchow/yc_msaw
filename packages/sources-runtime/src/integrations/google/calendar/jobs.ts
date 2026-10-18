import { runCalendarLane, type CalendarLaneResult } from "../../../source-lane/providers/calendar/sync.js";
import type { GoogleCalendarResourceType } from "./common.js";

// SOURCE-LANE PATCH (calendar-contacts): the calendar.poll / calendar.setup task
// handlers run the source-lane sync (resumable full sync, 410 reset without losing
// snapshots, removal tombstones, per-mailbox auth via the google-auth seam, persisted
// backoff). Event storage is still the donor storeCalendarEvent in poller.ts.

export function runGoogleCalendarDelta(
  userId: string,
  input: {
    channelId?: string | null;
    delegatedEmail?: string | null;
    calendarId?: string | null;
    resourceType?: GoogleCalendarResourceType | null;
    forceFull?: boolean | null;
  } = {},
): Promise<CalendarLaneResult> {
  return runCalendarLane(userId, input);
}

export function runGoogleCalendarSetup(
  userId: string,
  opts: { forceFull?: boolean; delegatedEmails?: string[] | null } = {},
): Promise<CalendarLaneResult> {
  return runCalendarLane(userId, { forceFull: opts.forceFull ?? false, delegatedEmails: opts.delegatedEmails ?? null });
}
