import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getTokenFullMock = vi.hoisted(() => vi.fn());
const mergeTokenMetadataMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const materializeGranolaMock = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => {
  const limit = vi.fn(async () => []);
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit })),
    })),
  }));
  const returning = vi.fn(async () => [{ id: "event-1" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  }));
  return { select, insert, update, values, returning, onConflictDoNothing, limit };
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
}));

import { buildGranolaEventValues, listGranolaNotes, pollGranola } from "../../../src/integrations/granola/poller.js";

describe("Granola poller watermark behavior", () => {
  beforeEach(() => {
    getTokenFullMock.mockReset();
    mergeTokenMetadataMock.mockReset().mockResolvedValue(undefined);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    materializeGranolaMock.mockReset().mockResolvedValue(undefined);
    dbMock.select.mockClear();
    dbMock.insert.mockClear();
    dbMock.update.mockClear();
    dbMock.values.mockClear();
    dbMock.returning.mockClear();
    dbMock.onConflictDoNothing.mockClear();
    dbMock.limit.mockReset().mockResolvedValue([]);
    vi.unstubAllGlobals();
    getTokenFullMock.mockResolvedValue({
      token: "granola-token",
      refreshToken: null,
      metadata: {
        lastUpdatedAt: "2024-01-01T00:00:00.000Z",
        includeTranscript: true,
      },
    });
  });

  it("builds full redacted note payloads with stable mirror aliases and versioned ids", () => {
    const values = buildGranolaEventValues("tenant-1", {
      note: {
        id: "note-1",
        object: "note",
        title: "Design Review",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:05:00.000Z",
        web_url: "https://app.granola.ai/notes/note-1",
        calendar_event: {
          event_title: "Design Review",
          organiser: "lead@example.com",
          calendar_event_id: "cal-1",
        },
        summary_text: "summary",
        summary_markdown: "## summary",
        transcript: [{ text: "hello", speaker: { diarization_label: "A" } }],
        asset_url: "https://cdn.granola.ai/assets/audio.m4a",
        provider_extra: { nested: true },
      } as any,
      transcriptIncluded: true,
      apiSource: "granola_public_api",
    });

    const payload = values.rawPayload as Record<string, any>;
    expect(values.sourceEventId).toBe("granola:note-1:2024-01-01T00:05:00.000Z");
    expect(payload.id).toBe("note-1");
    expect(payload.object).toBe("note");
    expect(payload.calendar_event.calendar_event_id).toBe("cal-1");
    expect(payload.transcript[0].text).toBe("hello");
    expect(payload.provider_extra).toEqual({ nested: true });
    expect(payload.granolaId).toBe("note-1");
    expect(payload.webUrl).toBe("https://app.granola.ai/notes/note-1");
    expect(payload.calendarEvent.calendar_event_id).toBe("cal-1");
    expect(payload.summaryText).toBe("summary");
    expect(JSON.stringify(payload)).not.toContain("audio.m4a");
    expect(payload._content_hash).toEqual(expect.any(String));
  });

  it("appends changed note versions as separate raw events", async () => {
    const versions = [
      "2024-01-01T00:01:00.000Z",
      "2024-01-01T00:02:00.000Z",
    ];
    let run = 0;
    const fetchMock = vi.fn(async (rawUrl: string | URL) => {
      const url = new URL(String(rawUrl));
      const updatedAt = versions[Math.min(run, versions.length - 1)];
      if (url.pathname.endsWith("/notes")) {
        return jsonResponse({
          notes: [noteListItem("n1", updatedAt)],
          hasMore: false,
          cursor: null,
        });
      }
      return jsonResponse(granolaNote("n1", updatedAt));
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollGranola("tenant-1", { maxNotes: 1 });
    run++;
    await pollGranola("tenant-1", { maxNotes: 1 });

    const rawEventValues = (dbMock.values.mock.calls as unknown as Array<[any]>)
      .map(([value]) => value)
      .filter((value) => value?.source === "granola");
    expect(rawEventValues.map((value) => value.sourceEventId)).toEqual([
      `granola:n1:${versions[0]}`,
      `granola:n1:${versions[1]}`,
    ]);
    expect(rawEventValues.every((value) => value.sourceEventId !== "granola:n1")).toBe(true);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("stores a resume on cap hit and advances to the merged max after draining it", async () => {
    const lastUpdatedAt = "2024-01-01T00:00:00.000Z";
    const times = [
      "2024-01-01T00:01:00.000Z",
      "2024-01-01T00:02:00.000Z",
      "2024-01-01T00:03:00.000Z",
      "2024-01-01T00:04:00.000Z",
    ];
    getTokenFullMock
      .mockResolvedValueOnce({
        token: "granola-token",
        refreshToken: null,
        metadata: { lastUpdatedAt, includeTranscript: true },
      })
      .mockResolvedValueOnce({
        token: "granola-token",
        refreshToken: null,
        metadata: {
          lastUpdatedAt,
          includeTranscript: true,
          granolaResume: {
            cursor: "cursor-1",
            updatedAfter: lastUpdatedAt,
            maxSeenUpdatedAt: times[3],
          },
        },
      });
    const fetchMock = vi.fn(async (rawUrl: string | URL) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith("/notes")) {
        if (url.searchParams.get("cursor") === "cursor-1") {
          return jsonResponse({
            notes: [noteListItem("n2", times[1]), noteListItem("n1", times[0])],
            hasMore: false,
            cursor: null,
          });
        }
        return jsonResponse({
          notes: [noteListItem("n4", times[3]), noteListItem("n3", times[2])],
          hasMore: true,
          cursor: "cursor-1",
        });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const timeById: Record<string, string> = {
        n1: times[0],
        n2: times[1],
        n3: times[2],
        n4: times[3],
      };
      return jsonResponse(granolaNote(id, timeById[id] ?? times[0]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await pollGranola("tenant-1", { maxNotes: 2 });

    expect(first).toMatchObject({
      listed: 2,
      processed: 2,
      failed: 0,
      capHit: true,
      watermarkAdvancedTo: null,
    });
    expect(mergeTokenMetadataMock).toHaveBeenNthCalledWith(1, "tenant-1", "granola", {
      granolaResume: {
        cursor: "cursor-1",
        updatedAfter: lastUpdatedAt,
        maxSeenUpdatedAt: times[3],
      },
    });

    const second = await pollGranola("tenant-1", { maxNotes: 2 });

    expect(second).toMatchObject({
      listed: 2,
      processed: 2,
      failed: 0,
      capHit: false,
      watermarkAdvancedTo: times[3],
    });
    expect(mergeTokenMetadataMock).toHaveBeenNthCalledWith(2, "tenant-1", "granola", {
      lastUpdatedAt: times[3],
      granolaResume: null,
    });

    const listCalls = fetchMock.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname.endsWith("/notes"));
    expect(listCalls[0].searchParams.get("updated_after")).toBe(lastUpdatedAt);
    expect(listCalls[0].searchParams.get("page_size")).toBe("2");
    expect(listCalls[1].searchParams.get("cursor")).toBe("cursor-1");
    expect(listCalls[1].searchParams.get("updated_after")).toBe(lastUpdatedAt);
  });

  it("clears an existing resume and does not advance when a note fetch fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const lastUpdatedAt = "2024-01-02T00:00:00.000Z";
    const updatedAfter = "2024-01-01T00:00:00.000Z";
    const times = [
      "2024-01-01T00:01:00.000Z",
      "2024-01-01T00:02:00.000Z",
      "2024-01-01T00:03:00.000Z",
    ];
    getTokenFullMock.mockResolvedValue({
      token: "granola-token",
      refreshToken: null,
      metadata: {
        lastUpdatedAt,
        includeTranscript: true,
        granolaResume: {
          cursor: "cursor-1",
          updatedAfter,
          maxSeenUpdatedAt: times[2],
        },
      },
    });
    const fetchMock = vi.fn(async (rawUrl: string | URL) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith("/notes")) {
        return jsonResponse({
          notes: [noteListItem("n1", times[0]), noteListItem("n2", times[1])],
          hasMore: false,
          cursor: null,
        });
      }
      if (url.pathname.endsWith("/notes/n2")) {
        return new Response("boom", { status: 500 });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const index = id === "n1" ? 0 : 2;
      return jsonResponse(granolaNote(id, times[index]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollGranola("tenant-1", { maxNotes: 10 });

    expect(result).toMatchObject({
      listed: 2,
      processed: 1,
      failed: 1,
      capHit: false,
      exhausted: false,
      watermarkAdvancedTo: null,
    });
    expect(mergeTokenMetadataMock).toHaveBeenCalledWith("tenant-1", "granola", { granolaResume: null });
    const listCall = fetchMock.mock.calls
      .map(([url]) => new URL(String(url)))
      .find((url) => url.pathname.endsWith("/notes"));
    expect(listCall?.searchParams.get("cursor")).toBe("cursor-1");
    expect(listCall?.searchParams.get("updated_after")).toBe(updatedAfter);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("n2"));
    warnSpy.mockRestore();
  });
});

describe("Granola 429 Retry-After handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits out Retry-After on 429 and then retries successfully", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ notes: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = listGranolaNotes("granola-token");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // No retry before the Retry-After window (2s) elapses.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ notes: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after bounded retries and surfaces the 429", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = listGranolaNotes("granola-token");
    const assertion = expect(pending).rejects.toThrow(/Granola API failed \(429\).*retry-after=0/);
    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial attempt + 3 bounded retries.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function noteListItem(id: string, updatedAt: string): { id: string; title: string; created_at: string; updated_at: string } {
  return {
    id,
    title: id,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: updatedAt,
  };
}

function granolaNote(id: string, updatedAt: string): ReturnType<typeof noteListItem> & {
  summary_text: string;
  transcript: Array<{ text: string }>;
} {
  return {
    ...noteListItem(id, updatedAt),
    summary_text: `summary ${id}`,
    transcript: [{ text: `transcript ${id}` }],
  };
}
