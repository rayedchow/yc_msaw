import { describe, expect, it, vi } from "vitest";

// Ported from gigabrain brain/tests/integrations/google-calendar.test.ts @ 5448774 (the only
// tests of the semantic-diff / normalization / timestamp helpers). Test bodies are unchanged;
// only import paths and module mocks were adapted to the Aqueduct poller (no db access here).
vi.mock("../../../../src/db/client.js", () => ({ db: {} }));

import {
  GOOGLE_CALENDAR_EVENT_TYPES,
  calendarEventTypeToActivityEventType,
  googleCalendarChannelTokenHash,
  googleCalendarSourceEventId,
} from "../../../../src/integrations/google/calendar/common.js";
import {
  calendarEventTimestamp,
  calendarEventStoreOptions,
  calendarEventsListUrl,
  calendarEventsWatchUrl,
  deriveCalendarSemanticChanges,
  enforceCalendarSetupLimit,
  googleCalendarEventContentHash,
  normalizeCalendarEventPayload,
} from "../../../../src/integrations/google/calendar/poller.js";

describe("Google Calendar ingestion helpers", () => {
  it("requests and subscribes to every supported Calendar API event type", () => {
    const listUrl = calendarEventsListUrl("primary", {});
    const watchUrl = calendarEventsWatchUrl("primary");

    expect(listUrl.searchParams.getAll("eventTypes")).toEqual([
      "birthday",
      "default",
      "focusTime",
      "fromGmail",
      "outOfOffice",
      "workingLocation",
    ]);
    expect(listUrl.searchParams.get("singleEvents")).toBe("true");
    expect(watchUrl.searchParams.getAll("eventTypes")).toEqual([...GOOGLE_CALENDAR_EVENT_TYPES]);
  });

  it("rebaselines reset full syncs without raw occurrence emission", () => {
    expect(calendarEventStoreOptions({ useIncremental: false })).toEqual({
      syncMode: "full",
      emitRawOnNew: true,
    });
    expect(calendarEventStoreOptions({ useIncremental: false, baselineOnly: true })).toEqual({
      syncMode: "full",
      emitRawOnNew: false,
    });
    expect(calendarEventStoreOptions({ useIncremental: true })).toEqual({
      syncMode: "incremental",
      emitRawOnNew: true,
    });
  });

  it("fails closed when Calendar setup exceeds configured backfill limits", () => {
    expect(() => enforceCalendarSetupLimit({
      label: "delegated users",
      count: 501,
      max: 500,
      context: "workspace directory",
    })).toThrow(/Google Calendar setup exceeded the configured delegated users limit/);
  });

  it("maps Google Calendar event types into activity event types", () => {
    expect(calendarEventTypeToActivityEventType("default")).toBe("calendar_event_default");
    expect(calendarEventTypeToActivityEventType("focusTime")).toBe("calendar_event_focus_time");
    expect(calendarEventTypeToActivityEventType("fromGmail")).toBe("calendar_event_from_gmail");
    expect(calendarEventTypeToActivityEventType("outOfOffice")).toBe("calendar_event_out_of_office");
    expect(calendarEventTypeToActivityEventType("workingLocation")).toBe("calendar_event_working_location");
    expect(calendarEventTypeToActivityEventType("birthday")).toBe("calendar_event_birthday");
    expect(calendarEventTypeToActivityEventType("default", "cancelled")).toBe("calendar_event_cancelled");
  });

  it("uses stable Calendar timestamps and source identifiers", () => {
    const allDayTimestamp = calendarEventTimestamp({
      id: "evt_1",
      start: { date: "2026-06-24" },
      updated: "2026-06-25T01:02:03.000Z",
    });
    expect(allDayTimestamp.toISOString()).toBe("2026-06-24T00:00:00.000Z");

    const pacificAllDayTimestamp = calendarEventTimestamp({
      id: "evt_1b",
      start: { date: "2026-06-24" },
      updated: "2026-06-25T01:02:03.000Z",
    }, "America/Los_Angeles");
    expect(pacificAllDayTimestamp.toISOString()).toBe("2026-06-24T07:00:00.000Z");

    const cancelledRecurringTimestamp = calendarEventTimestamp({
      id: "evt_2",
      recurringEventId: "series_1",
      status: "cancelled",
      originalStartTime: { dateTime: "2026-06-26T09:30:00-07:00" },
      updated: "2026-06-25T01:02:03.000Z",
    });
    expect(cancelledRecurringTimestamp.toISOString()).toBe("2026-06-26T16:30:00.000Z");

    const sourceA = googleCalendarSourceEventId({
      delegatedEmail: "user@example.com",
      calendarId: "primary",
      eventId: "evt_1",
      revision: "2026-06-25T01:02:03.000Z",
    });
    const sourceB = googleCalendarSourceEventId({
      delegatedEmail: "user@example.com",
      calendarId: "primary",
      eventId: "evt_1",
      revision: "2026-06-25T01:02:03.000Z",
    });
    expect(sourceA).toBe(sourceB);
    expect(sourceA).toMatch(/^calendar:[a-f0-9]{40}$/);
  });

  it("normalizes organizer, creator, attendees, and specialized properties", () => {
    const payload = normalizeCalendarEventPayload({
      delegatedEmail: "owner@example.com",
      calendar: {
        id: "primary",
        summary: "Primary",
        timeZone: "America/Los_Angeles",
        accessRole: "owner",
        primary: true,
      },
    }, {
      id: "evt_1",
      eventType: "workingLocation",
      status: "confirmed",
      summary: "WFH",
      organizer: { email: "owner@example.com", displayName: "Owner", self: true },
      creator: { email: "creator@example.com", displayName: "Creator" },
      attendees: [{ email: "teammate@example.com", displayName: "Teammate", responseStatus: "accepted" }],
      originalStartTime: { dateTime: "2026-06-24T09:00:00-07:00" },
      workingLocationProperties: { type: "homeOffice" },
    });

    expect(payload).toMatchObject({
      delegatedEmail: "owner@example.com",
      calendarId: "primary",
      eventType: "workingLocation",
      organizer: { email: "owner@example.com", name: "Owner", self: true },
      creator: { email: "creator@example.com", name: "Creator" },
      originalStartTime: { dateTime: "2026-06-24T09:00:00-07:00" },
      workingLocationProperties: { type: "homeOffice" },
    });
    expect(payload.attendees).toEqual([
      expect.objectContaining({ email: "teammate@example.com", name: "Teammate", responseStatus: "accepted" }),
    ]);
  });

  it("derives semantic Calendar changes from stable event snapshots", () => {
    const previous = normalizeCalendarEventPayload({
      delegatedEmail: "owner@example.com",
      calendar: { id: "primary", summary: "Primary" },
    }, {
      id: "evt_1",
      eventType: "default",
      status: "confirmed",
      summary: "Pipeline review",
      location: "Zoom",
      start: { dateTime: "2026-06-25T16:00:00-07:00" },
      end: { dateTime: "2026-06-25T16:30:00-07:00" },
      attendees: [
        { email: "ana@example.com", displayName: "Ana", responseStatus: "needsAction" },
      ],
    });
    const current = normalizeCalendarEventPayload({
      delegatedEmail: "owner@example.com",
      calendar: { id: "primary", summary: "Primary" },
    }, {
      id: "evt_1",
      eventType: "default",
      status: "confirmed",
      summary: "Pipeline review",
      location: "Conference room",
      start: { dateTime: "2026-06-25T17:00:00-07:00" },
      end: { dateTime: "2026-06-25T17:30:00-07:00" },
      attendees: [
        { email: "ana@example.com", displayName: "Ana", responseStatus: "accepted" },
        { email: "bo@example.com", displayName: "Bo", responseStatus: "tentative" },
      ],
    });

    const changes = deriveCalendarSemanticChanges(previous, current);

    expect(changes.map((change) => change.eventType)).toEqual([
      "calendar_event_rescheduled",
      "calendar_location_changed",
      "calendar_attendee_added",
      "calendar_attendee_response_changed",
    ]);
    expect(changes.find((change) => change.eventType === "calendar_attendee_response_changed")?.text)
      .toContain("needsAction to accepted");
  });

  it("does not create noisy field diffs for partial cancelled events", () => {
    const previous = normalizeCalendarEventPayload({
      delegatedEmail: "owner@example.com",
      calendar: { id: "primary", summary: "Primary" },
    }, {
      id: "evt_1",
      eventType: "default",
      status: "confirmed",
      summary: "Pipeline review",
      location: "Zoom",
      start: { dateTime: "2026-06-25T16:00:00-07:00" },
      end: { dateTime: "2026-06-25T16:30:00-07:00" },
      attendees: [{ email: "ana@example.com", displayName: "Ana", responseStatus: "accepted" }],
    });
    const cancelled = normalizeCalendarEventPayload({
      delegatedEmail: "owner@example.com",
      calendar: { id: "primary", summary: "Primary" },
    }, {
      id: "evt_1",
      status: "cancelled",
      updated: "2026-06-25T19:00:00.000Z",
    });

    const changes = deriveCalendarSemanticChanges(previous, cancelled);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.eventType).toBe("calendar_event_cancelled");
    expect(changes[0]?.title).toContain("Pipeline review");
  });

  it("uses stable canonical JSON for Calendar snapshot hashes", () => {
    const first = googleCalendarEventContentHash({ b: 2, a: { z: "last", c: "first" } });
    const second = googleCalendarEventContentHash({ a: { c: "first", z: "last" }, b: 2 });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes channel tokens before persistence", () => {
    const hash = googleCalendarChannelTokenHash("secret-channel-token");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("secret-channel-token");
  });
});
