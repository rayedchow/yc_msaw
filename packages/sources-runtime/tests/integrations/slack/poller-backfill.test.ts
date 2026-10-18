import { beforeEach, describe, expect, it, vi } from "vitest";

// Verifies backfill completeness: a conversation with no watermark (fresh
// connect) is fetched WITHOUT an `oldest` bound and paginated to exhaustion,
// every subtype is stored, and threads register for full-reply fetch.

interface InsertRecord {
  table: unknown;
  values: Record<string, any>;
}

const inserted = vi.hoisted(() => [] as InsertRecord[]);
const updates = vi.hoisted(() => [] as Array<Record<string, any>>);
const watermarkRows = vi.hoisted(() => [] as Array<Record<string, any>>);
const enqueueSlackWindowsMock = vi.hoisted(() => vi.fn());

const dbMock = vi.hoisted(() => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => watermarkRows),
    })),
  })),
  insert: vi.fn((table: unknown) => ({
    values: vi.fn((values: Record<string, any>) => {
      inserted.push({ table, values });
      return {
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: `evt-${inserted.length}` }]),
        })),
        onConflictDoUpdate: vi.fn(async () => undefined),
      };
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn((values: Record<string, any>) => {
      updates.push(values);
      return { where: vi.fn(async () => undefined) };
    }),
  })),
}));

vi.mock("../../../src/db/client.js", () => ({ db: dbMock }));

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: vi.fn(),
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  getTokenWithMetadata: vi.fn(async () => ({
    token: "xoxp-token",
    metadata: { slackTeamId: "T123" },
  })),
}));

vi.mock("../../../src/integrations/slack/materialize.js", () => ({
  materializeSlackChannelDay: vi.fn(),
  slackDayKeyFromTs: vi.fn(() => "2027-01-15"),
}));

vi.mock("../../../src/integrations/slack/files.js", () => ({
  captureSlackMessageFiles: vi.fn(async () => ({ stored: 0, skips: {} })),
}));

vi.mock("../../../src/integrations/slack/windows.js", () => ({
  enqueueSlackChannelWindows: enqueueSlackWindowsMock,
}));

// The real throttle allows 1 history request/min (non-Marketplace regime);
// pacing behavior is covered in rate-limit.test.ts. Keep the real page-limit
// constant so the `limit=15` assertion below exercises production config.
vi.mock("../../../src/integrations/slack/rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/integrations/slack/rate-limit.js")>()),
  slackThrottle: vi.fn(async () => undefined),
}));

import { pollConversationsDetailed } from "../../../src/integrations/slack/poller.js";
import { activityEvents, threadWatermarks } from "../../../src/db/schema.js";

describe("Slack first-poll history backfill", () => {
  beforeEach(() => {
    inserted.length = 0;
    updates.length = 0;
    watermarkRows.length = 0;
    enqueueSlackWindowsMock.mockReset().mockResolvedValue("task-1");
    vi.unstubAllGlobals();
  });

  it("fetches the FULL channel history for a fresh watermark and stores every subtype", async () => {
    watermarkRows.push({
      id: "wm-1",
      userId: "tenant-1",
      provider: "slack",
      conversationId: "C123",
      conversationType: "public_channel",
      conversationName: "launch",
      lastSeenTs: null, // fresh connect: never polled
      lastPolledAt: null,
      isActive: true,
    });

    const historyRequests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users.list")) {
        return jsonResponse({ ok: true, members: [], response_metadata: { next_cursor: "" } });
      }
      if (url.pathname.endsWith("/conversations.history")) {
        historyRequests.push(url);
        if (!url.searchParams.get("cursor")) {
          return jsonResponse({
            ok: true,
            messages: [{
              type: "message",
              user: "U1",
              text: "newest",
              ts: "1800000010.000100",
              thread_ts: "1800000010.000100",
              reply_count: 3,
              latest_reply: "1800000011.000000",
            }],
            response_metadata: { next_cursor: "cursor-2" },
          });
        }
        return jsonResponse({
          ok: true,
          messages: [{
            type: "message",
            subtype: "channel_join",
            user: "U2",
            text: "<@U2> has joined the channel",
            ts: "1700000000.000100",
          }],
          response_metadata: { next_cursor: "" },
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }));

    const result = await pollConversationsDetailed("tenant-1");

    // History was paginated to exhaustion with NO `oldest` bound (full backfill).
    expect(historyRequests).toHaveLength(2);
    expect(historyRequests[0]?.searchParams.has("oldest")).toBe(false);
    expect(historyRequests[1]?.searchParams.get("cursor")).toBe("cursor-2");

    // Every history page honors the 15-messages/request cap of the 2025
    // non-Marketplace distributed-app regime.
    for (const request of historyRequests) {
      expect(request.searchParams.get("limit")).toBe("15");
    }

    // Both messages stored, including the channel_join subtype (max capture).
    const messageInserts = inserted.filter((record) => record.table === activityEvents);
    expect(messageInserts.map((record) => record.values.sourceEventId)).toEqual([
      "slack:C123:1800000010.000100",
      "slack:C123:1700000000.000100",
    ]);
    expect(messageInserts[1]?.values.rawPayload).toMatchObject({ subtype: "channel_join" });
    expect(messageInserts[0]?.values).toMatchObject({
      sourceNamespace: "workspace:T123",
      sourceObjectId: "message:C123:1800000010.000100",
      recordKind: "activity",
    });
    expect(enqueueSlackWindowsMock).toHaveBeenCalledTimes(2);
    expect(enqueueSlackWindowsMock).toHaveBeenCalledWith("tenant-1", "C123");

    // The thread registered for a FULL reply fetch (no lastReplyTs watermark).
    const threadInserts = inserted.filter((record) => record.table === threadWatermarks);
    expect(threadInserts).toHaveLength(1);
    expect(threadInserts[0]?.values).toMatchObject({
      channelId: "C123",
      threadTs: "1800000010.000100",
      lastReplyTs: null,
    });

    // Watermark advanced to the newest ts only after full traversal.
    expect(updates.some((values) => values.lastSeenTs === "1800000010.000100")).toBe(true);

    expect(result).toMatchObject({ conversationsSeen: 1, stored: 2, exhausted: true, capHit: false });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
