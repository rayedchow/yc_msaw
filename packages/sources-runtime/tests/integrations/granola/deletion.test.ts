import { beforeEach, describe, expect, it, vi } from "vitest";

const getTokenFullMock = vi.hoisted(() => vi.fn());
const mergeTokenMetadataMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const materializeGranolaMock = vi.hoisted(() => vi.fn());
const deleteGranolaMirrorMock = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => {
  const state = {
    selectQueue: [] as unknown[][],
    insertReturning: [{ id: "event-1" }] as Array<{ id: string }>,
  };
  const returning = vi.fn(async () => state.insertReturning);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  // Select results are consumed in call order; awaiting the where() result
  // (sweep) and calling .limit() (single-row lookups) both yield the same rows.
  const where = vi.fn(() => {
    const rows = state.selectQueue.length > 0 ? state.selectQueue.shift()! : [];
    return Object.assign(Promise.resolve(rows), { limit: vi.fn(async () => rows) });
  });
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const updateWhere = vi.fn(async () => []);
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  return { state, select, insert, update, values, returning, onConflictDoNothing, where, set, updateWhere };
});

vi.mock("../../../src/db/client.js", () => ({
  db: dbMock,
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  getTokenFull: getTokenFullMock,
  mergeTokenMetadata: mergeTokenMetadataMock,
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

vi.mock("../../../src/mirror/materializer.js", () => ({
  materializeGranolaMeetingSourceWiki: materializeGranolaMock,
  deleteGranolaMeetingSourceWiki: deleteGranolaMirrorMock,
}));

import {
  classifyGranolaNoteFetchFailure,
  pollGranola,
} from "../../../src/integrations/granola/poller.js";

const LAST_UPDATED_AT = "2024-01-01T00:00:00.000Z";
const NOTE_UPDATED_AT = "2024-06-01T00:01:00.000Z";

describe("Granola deletion taxonomy", () => {
  beforeEach(() => {
    getTokenFullMock.mockReset();
    mergeTokenMetadataMock.mockReset().mockResolvedValue(undefined);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    materializeGranolaMock.mockReset().mockResolvedValue(undefined);
    deleteGranolaMirrorMock.mockReset().mockResolvedValue(undefined);
    dbMock.select.mockClear();
    dbMock.insert.mockClear();
    dbMock.update.mockClear();
    dbMock.values.mockClear();
    dbMock.returning.mockClear();
    dbMock.onConflictDoNothing.mockClear();
    dbMock.where.mockClear();
    dbMock.updateWhere.mockClear();
    dbMock.state.selectQueue = [];
    dbMock.state.insertReturning = [{ id: "event-1" }];
    vi.unstubAllGlobals();
    getTokenFullMock.mockResolvedValue({
      token: "granola-token",
      refreshToken: null,
      metadata: { lastUpdatedAt: LAST_UPDATED_AT, includeTranscript: true },
    });
  });

  it("tombstones a previously captured note that 404s on fetch and removes its mirror", async () => {
    stubPollFetch({ noteResponse: () => new Response("not found", { status: 404 }) });
    dbMock.state.selectQueue = [
      [{ id: "wm-1", conversationName: "Design Review", lastSeenTs: NOTE_UPDATED_AT }],
    ];

    const result = await pollGranola("tenant-1", { maxNotes: 10 });

    expect(result).toMatchObject({
      failed: 0,
      tombstoned: 1,
      watermarkAdvancedTo: NOTE_UPDATED_AT,
    });

    const tombstone = insertedValues().find((value) => value.eventType === "meeting_note.deleted");
    expect(tombstone).toBeTruthy();
    expect(tombstone?.sourceEventId).toBe("granola:n1:deleted");
    expect(tombstone?.rawPayload).toMatchObject({
      granolaId: "n1",
      deleted: true,
      deletionReason: "fetch_404",
      title: "Design Review",
      lastSeenUpdatedAt: NOTE_UPDATED_AT,
    });
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("event-1", "tenant-1");
    expect(deleteGranolaMirrorMock).toHaveBeenCalledWith("tenant-1", "n1");
    // The tracked-conversation row is retired so the sweep never re-checks it.
    expect(dbMock.update).toHaveBeenCalled();
    // A deletion must not block the watermark advance.
    expect(mergeTokenMetadataMock).toHaveBeenCalledWith("tenant-1", "granola", {
      lastUpdatedAt: NOTE_UPDATED_AT,
      granolaResume: null,
    });
    // First clean poll only baselines the deletion sweep clock.
    expect(mergeTokenMetadataMock).toHaveBeenCalledWith("tenant-1", "granola", {
      granolaDeletionSweepAt: expect.any(String),
    });
  });

  it("is idempotent when the tombstone already exists (no re-enqueue, no mirror rewrite)", async () => {
    stubPollFetch({ noteResponse: () => new Response("not found", { status: 404 }) });
    dbMock.state.selectQueue = [
      [{ id: "wm-1", conversationName: "Design Review", lastSeenTs: NOTE_UPDATED_AT }],
    ];
    dbMock.state.insertReturning = [];

    const result = await pollGranola("tenant-1", { maxNotes: 10 });

    expect(result).toMatchObject({ failed: 0, tombstoned: 1 });
    expect(enqueueCollectedEventMock).not.toHaveBeenCalled();
    expect(deleteGranolaMirrorMock).not.toHaveBeenCalled();
    expect(dbMock.update).toHaveBeenCalled();
  });

  it("counts a never-captured 404 as a visible skip without writing a tombstone", async () => {
    stubPollFetch({ noteResponse: () => new Response("not found", { status: 404 }) });
    dbMock.state.selectQueue = [[]];

    const result = await pollGranola("tenant-1", { maxNotes: 10 });

    expect(result).toMatchObject({
      failed: 0,
      tombstoned: 0,
      skips: { deleted_uncaptured: 1 },
    });
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(deleteGranolaMirrorMock).not.toHaveBeenCalled();
  });

  it("keeps transient note-fetch errors fail-soft (no tombstone, counted as failed)", async () => {
    stubPollFetch({ noteResponse: () => new Response("boom", { status: 500 }) });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await pollGranola("tenant-1", { maxNotes: 10 });

    expect(result).toMatchObject({ failed: 1, tombstoned: 0, watermarkAdvancedTo: null });
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(deleteGranolaMirrorMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("propagates 401/403 note-fetch failures to the credential teardown path", async () => {
    stubPollFetch({ noteResponse: () => new Response("unauthorized", { status: 401 }) });

    await expect(pollGranola("tenant-1", { maxNotes: 10 })).rejects.toThrow("(401)");
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(deleteGranolaMirrorMock).not.toHaveBeenCalled();
  });

  it("classifies fetch failures without mistaking DNS errors for deleted notes", () => {
    expect(classifyGranolaNoteFetchFailure(new Error("Granola API failed (404): gone"))).toBe("not_found");
    expect(classifyGranolaNoteFetchFailure(new Error("Granola MCP tool get_note failed: Note not found"))).toBe("not_found");
    expect(classifyGranolaNoteFetchFailure(new Error("Granola API failed (401): nope"))).toBe("permanent");
    expect(classifyGranolaNoteFetchFailure(new Error("Granola API failed (403): nope"))).toBe("permanent");
    expect(classifyGranolaNoteFetchFailure(new Error("Granola API failed (500): boom"))).toBe("transient");
    expect(classifyGranolaNoteFetchFailure(new Error("getaddrinfo ENOTFOUND public-api.granola.ai"))).toBe("transient");
  });
});

describe("Granola deletion sweep", () => {
  beforeEach(() => {
    getTokenFullMock.mockReset();
    mergeTokenMetadataMock.mockReset().mockResolvedValue(undefined);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    materializeGranolaMock.mockReset().mockResolvedValue(undefined);
    deleteGranolaMirrorMock.mockReset().mockResolvedValue(undefined);
    dbMock.insert.mockClear();
    dbMock.update.mockClear();
    dbMock.values.mockClear();
    dbMock.state.selectQueue = [];
    dbMock.state.insertReturning = [{ id: "event-2" }];
    vi.unstubAllGlobals();
  });

  it("tombstones tracked notes missing from the full listing only after a confirming 404", async () => {
    getTokenFullMock.mockResolvedValue({
      token: "granola-token",
      refreshToken: null,
      metadata: {
        lastUpdatedAt: LAST_UPDATED_AT,
        includeTranscript: true,
        granolaDeletionSweepAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      },
    });
    const fetchMock = vi.fn(async (rawUrl: string | URL) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith("/notes")) {
        if (url.searchParams.has("updated_after")) {
          // Poll listing: nothing changed.
          return jsonResponse({ notes: [], hasMore: false, cursor: null });
        }
        // Sweep listing: only n1 still exists in the listing.
        return jsonResponse({ notes: [noteListItem("n1")], hasMore: false, cursor: null });
      }
      if (url.pathname.endsWith("/notes/n2")) return new Response("not found", { status: 404 });
      // n3 is unlisted but still fetchable (e.g. moved out of scope).
      return jsonResponse({ ...noteListItem("n3"), summary_text: "still here" });
    });
    vi.stubGlobal("fetch", fetchMock);
    dbMock.state.selectQueue = [
      [{ conversationId: "n1" }, { conversationId: "n2" }, { conversationId: "n3" }],
      [{ id: "wm-2", conversationName: "Gone Meeting", lastSeenTs: NOTE_UPDATED_AT }],
    ];

    const result = await pollGranola("tenant-1", { maxNotes: 10 });

    expect(result.deletionSweep).toEqual({
      tracked: 3,
      listedPages: 1,
      listingIncomplete: false,
      missing: 2,
      tombstoned: 1,
      confirmFailed: 0,
    });
    const tombstone = insertedValues().find((value) => value.eventType === "meeting_note.deleted");
    expect(tombstone).toBeTruthy();
    expect(tombstone?.sourceEventId).toBe("granola:n2:deleted");
    expect(tombstone?.rawPayload).toMatchObject({ deletionReason: "missing_from_list" });
    expect(deleteGranolaMirrorMock).toHaveBeenCalledWith("tenant-1", "n2");
    expect(deleteGranolaMirrorMock).not.toHaveBeenCalledWith("tenant-1", "n3");
    expect(mergeTokenMetadataMock).toHaveBeenCalledWith("tenant-1", "granola", {
      granolaDeletionSweepAt: expect.any(String),
    });
  });

  it("skips the sweep when the last one ran inside the interval", async () => {
    getTokenFullMock.mockResolvedValue({
      token: "granola-token",
      refreshToken: null,
      metadata: {
        lastUpdatedAt: LAST_UPDATED_AT,
        includeTranscript: true,
        granolaDeletionSweepAt: new Date().toISOString(),
      },
    });
    const fetchMock = vi.fn(async () => jsonResponse({ notes: [], hasMore: false, cursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollGranola("tenant-1", { maxNotes: 10 });

    expect(result.deletionSweep).toBeNull();
    // Only the poll listing hit the API; no sweep listing happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function stubPollFetch(input: { noteResponse: () => Response }): void {
  const fetchMock = vi.fn(async (rawUrl: string | URL) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.endsWith("/notes")) {
      return jsonResponse({ notes: [noteListItem("n1")], hasMore: false, cursor: null });
    }
    return input.noteResponse();
  });
  vi.stubGlobal("fetch", fetchMock);
}

function insertedValues(): Array<Record<string, any>> {
  return (dbMock.values.mock.calls as unknown as Array<[Record<string, any>]>).map(([value]) => value);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function noteListItem(id: string): { id: string; title: string; created_at: string; updated_at: string } {
  return {
    id,
    title: id,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: NOTE_UPDATED_AT,
  };
}
