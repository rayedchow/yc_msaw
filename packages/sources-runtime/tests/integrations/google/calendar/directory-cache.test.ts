import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The recurring calendar.poll re-enters runGoogleCalendarSetup every cycle.
// The workspace directory enumeration (Admin SDK users.list) is cached per
// tenant with a TTL so the steady-state cycle only does the per-user
// calendarList delta, not a full directory sweep.

const dbMock = vi.hoisted(() => {
  const limit = vi.fn(async (): Promise<unknown[]> => [{ channelId: "chan-1" }]);
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
  enqueueCollectedEventForProcessing: vi.fn(async () => undefined),
}));

vi.mock("../../../../src/mirror/materializer.js", () => ({
  materializeCalendarEventSourceWiki: vi.fn(async () => null),
}));

vi.mock("../../../../src/vault/tokens.js", () => ({
  getTokenMetadata: vi.fn(async () => ({ delegation: true, email: "admin@example.com" })),
}));

vi.mock("../../../../src/vault/google-auth.js", () => ({
  GOOGLE_CALENDAR_DELEGATION_SCOPES: ["https://www.googleapis.com/auth/calendar.readonly"],
  GOOGLE_WORKSPACE_DIRECTORY_DELEGATION_SCOPES: ["https://www.googleapis.com/auth/admin.directory.user.readonly"],
  getGoogleAccessToken: vi.fn(async () => "access-token"),
  isDelegationConfigured: () => true,
}));

import {
  clearGoogleCalendarDirectoryUsersCacheForTests,
  runGoogleCalendarSetup,
} from "../../../../src/integrations/google/calendar/poller.js";

function makeFetchMock() {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("admin.googleapis.com")) {
      return new Response(JSON.stringify({ users: [{ primaryEmail: "member@example.com" }] }), { status: 200 });
    }
    if (url.includes("/users/me/calendarList")) {
      return new Response(JSON.stringify({ items: [], nextSyncToken: "sync-token-1" }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

function callsTo(fetchMock: ReturnType<typeof makeFetchMock>, host: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(host)).length;
}

describe("Google Calendar directory-users cache", () => {
  beforeEach(() => {
    clearGoogleCalendarDirectoryUsersCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enumerates the directory once and reuses it on the next poll cycle", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const first = await runGoogleCalendarSetup("u1");
    const second = await runGoogleCalendarSetup("u1");

    expect(first.delegatedUsers).toBe(1);
    expect(second.delegatedUsers).toBe(1);
    // Directory sweep happened once; the per-user calendarList delta ran both cycles.
    expect(callsTo(fetchMock, "admin.googleapis.com")).toBe(1);
    expect(callsTo(fetchMock, "/users/me/calendarList")).toBe(2);
  });

  it("bypasses the cache on forceFull (setup / manual full resync)", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await runGoogleCalendarSetup("u1");
    await runGoogleCalendarSetup("u1", { forceFull: true });

    expect(callsTo(fetchMock, "admin.googleapis.com")).toBe(2);
  });

  it("does not touch the directory at all when delegatedEmails are given explicitly", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await runGoogleCalendarSetup("u1", { delegatedEmails: ["member@example.com"] });

    expect(callsTo(fetchMock, "admin.googleapis.com")).toBe(0);
    expect(callsTo(fetchMock, "/users/me/calendarList")).toBe(1);
  });
});
