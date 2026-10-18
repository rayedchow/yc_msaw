import { beforeEach, describe, expect, it, vi } from "vitest";

// Live calendar mirror materialization is content-sha gated inside
// storeCalendarEvent: unchanged snapshots must not touch the mirror at all.
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const materializeCalendarMock = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => {
  const limit = vi.fn(async (): Promise<unknown[]> => []);
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit })),
    })),
  }));
  const returning = vi.fn(async () => [{ id: "event-1" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const onConflictDoUpdate = vi.fn(async () => []);
  const values = vi.fn((..._args: unknown[]) => ({ onConflictDoNothing, onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  }));
  return { select, insert, update, values, returning, onConflictDoNothing, onConflictDoUpdate, limit };
});

vi.mock("../../../../src/db/client.js", () => ({
  db: dbMock,
}));

vi.mock("../../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

vi.mock("../../../../src/mirror/materializer.js", () => ({
  materializeCalendarEventSourceWiki: materializeCalendarMock,
}));

import {
  calendarEventStoreOptions,
  storeCalendarEvent,
} from "../../../../src/integrations/google/calendar/poller.js";

const target = {
  delegatedEmail: "ishan@askshepherd.ai",
  calendar: { id: "cal-1", summary: "Team", timeZone: "UTC", accessRole: "owner", primary: true },
};

const event = {
  id: "evt-1",
  status: "confirmed",
  eventType: "default",
  summary: "Design sync",
  updated: "2026-06-30T09:00:00.000Z",
  start: { dateTime: "2026-07-01T10:00:00Z" },
  end: { dateTime: "2026-07-01T11:00:00Z" },
  organizer: { email: "host@example.com", displayName: "Host" },
  attendees: [{ email: "guest@example.com", responseStatus: "accepted" }],
};

describe("calendar live mirror materialization", () => {
  beforeEach(() => {
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    materializeCalendarMock.mockReset().mockResolvedValue(null);
    dbMock.limit.mockReset().mockResolvedValue([]);
    dbMock.values.mockClear();
    dbMock.onConflictDoUpdate.mockClear();
    dbMock.returning.mockReset().mockResolvedValue([{ id: "event-1" }]);
  });

  it("materializes the mirror doc live on first capture of an event", async () => {
    await storeCalendarEvent("u1", target, event, calendarEventStoreOptions({ useIncremental: false }));

    expect(materializeCalendarMock).toHaveBeenCalledTimes(1);
    expect(materializeCalendarMock).toHaveBeenCalledWith("u1", expect.objectContaining({
      calendarId: "cal-1",
      eventId: "evt-1",
      summary: "Design sync",
      status: "confirmed",
    }));
  });

  it("skips the mirror entirely when the snapshot content hash is unchanged", async () => {
    // First store: capture the content hash the poller computed and persisted.
    await storeCalendarEvent("u1", target, event, calendarEventStoreOptions({ useIncremental: false }));
    const snapshotValues = dbMock.values.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((row) => typeof row.contentHash === "string");
    expect(snapshotValues).toBeTruthy();
    materializeCalendarMock.mockClear();

    // Second store of the identical event: previous snapshot hash matches.
    dbMock.limit.mockResolvedValue([{
      contentHash: snapshotValues!.contentHash,
      rawPayload: snapshotValues!.rawPayload,
    }]);
    await storeCalendarEvent("u1", target, event, calendarEventStoreOptions({ useIncremental: false }));

    expect(materializeCalendarMock).not.toHaveBeenCalled();
  });

  it("re-materializes when the event content changes (including cancellation)", async () => {
    await storeCalendarEvent("u1", target, event, calendarEventStoreOptions({ useIncremental: false }));
    const snapshotValues = dbMock.values.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((row) => typeof row.contentHash === "string");
    materializeCalendarMock.mockClear();

    dbMock.limit.mockResolvedValue([{
      contentHash: snapshotValues!.contentHash,
      rawPayload: snapshotValues!.rawPayload,
    }]);
    const cancelled = { ...event, status: "cancelled", updated: "2026-07-01T09:00:00.000Z" };
    await storeCalendarEvent("u1", target, cancelled, calendarEventStoreOptions({ useIncremental: true }));

    expect(materializeCalendarMock).toHaveBeenCalledTimes(1);
    expect(materializeCalendarMock).toHaveBeenCalledWith("u1", expect.objectContaining({
      eventId: "evt-1",
      status: "cancelled",
    }));
  });

  it("never fails the capture path on a mirror error", async () => {
    materializeCalendarMock.mockRejectedValueOnce(new Error("mirror down"));

    await expect(
      storeCalendarEvent("u1", target, event, calendarEventStoreOptions({ useIncremental: false })),
    ).resolves.toBeGreaterThanOrEqual(0);
  });
});
