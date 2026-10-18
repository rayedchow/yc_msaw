import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies backfill completeness: a conversation with no watermark (fresh
// connect) is fetched WITHOUT an `oldest` bound and paginated to exhaustion,
// every subtype is stored, and threads register for full-reply fetch.
//
// Patched for the source lane: pollConversationsDetailed now runs the
// checkpointed history engine (history-sync.ts) whose state lives in the
// 9400 tables, so this runs against real SQL (PGlite) instead of a mocked
// drizzle chain; the assertions are the donor's. The durable quota is made
// fast with SLACK_HISTORY_RPM (pacing is covered in rate-limit.test.ts and
// tests/source-lane/providers/slack/history-sync.test.ts).

const enqueueSlackWindowsMock = vi.hoisted(() => {
  process.env.SLACK_HISTORY_RPM = "6000";
  return vi.fn();
});

vi.mock("../../../src/db/client.js", async () => {
  const h = await import("../../source-lane/providers/slack/harness.js");
  return { db: h.db, pgClient: null };
});

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: vi.fn(),
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  getTokenWithMetadata: vi.fn(async () => ({
    token: "xoxp-token",
    metadata: { slackTeamId: "T123" },
  })),
  getTokenMetadata: vi.fn(async () => ({ slackTeamId: "T123" })),
  mergeTokenMetadata: vi.fn(),
}));

vi.mock("../../../src/integrations/slack/materialize.js", () => ({
  materializeSlackChannelDay: vi.fn(),
  slackDayKeyFromTs: vi.fn(() => "2027-01-15"),
}));

vi.mock("../../../src/integrations/slack/files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/integrations/slack/files.js")>()),
  captureSlackMessageFiles: vi.fn(async () => ({ stored: 0, skips: {} })),
}));

vi.mock("../../../src/integrations/slack/windows.js", () => ({
  enqueueSlackChannelWindows: enqueueSlackWindowsMock,
}));

import { pollConversationsDetailed } from "../../../src/integrations/slack/poller.js";
import { SLACK_HISTORY_PAGE_LIMIT } from "../../../src/integrations/slack/rate-limit.js";
import { query, ready, resetAll } from "../../source-lane/providers/slack/harness.js";

describe("Slack first-poll history backfill", () => {
  beforeAll(async () => {
    await ready;
  });

  beforeEach(async () => {
    await resetAll();
    enqueueSlackWindowsMock.mockReset().mockResolvedValue("task-1");
    vi.unstubAllGlobals();
  });

  it("fetches the FULL channel history for a fresh watermark and stores every subtype", async () => {
    await query(
      `INSERT INTO conversation_watermarks (user_id, provider, conversation_id, conversation_type, conversation_name, last_seen_ts, last_polled_at, is_active)
       VALUES ('tenant-1', 'slack', 'C123', 'public_channel', 'launch', NULL, NULL, true)`, // fresh connect: never polled
    );

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
    expect(SLACK_HISTORY_PAGE_LIMIT).toBe(15);
    for (const request of historyRequests) {
      expect(request.searchParams.get("limit")).toBe("15");
    }

    // Both messages stored, including the channel_join subtype (max capture).
    const messageInserts = await query<{ source_event_id: string; raw_payload: Record<string, unknown>; source_namespace: string; source_object_id: string; record_kind: string }>(
      `SELECT source_event_id, raw_payload, source_namespace, source_object_id, record_kind FROM activity_events WHERE user_id = 'tenant-1' ORDER BY (raw_payload->>'ts')::numeric DESC`,
    );
    expect(messageInserts.map((record) => record.source_event_id)).toEqual([
      "slack:C123:1800000010.000100",
      "slack:C123:1700000000.000100",
    ]);
    expect(messageInserts[1]?.raw_payload).toMatchObject({ subtype: "channel_join" });
    expect(messageInserts[0]).toMatchObject({
      source_namespace: "workspace:T123",
      source_object_id: "message:C123:1800000010.000100",
      record_kind: "activity",
    });
    expect(enqueueSlackWindowsMock).toHaveBeenCalledTimes(2);
    expect(enqueueSlackWindowsMock).toHaveBeenCalledWith("tenant-1", "C123");

    // The thread registered for a FULL reply fetch (no lastReplyTs watermark).
    const threadInserts = await query(`SELECT channel_id, thread_ts, last_reply_ts FROM thread_watermarks WHERE user_id = 'tenant-1'`);
    expect(threadInserts).toHaveLength(1);
    expect(threadInserts[0]).toMatchObject({
      channel_id: "C123",
      thread_ts: "1800000010.000100",
      last_reply_ts: null,
    });

    // Watermark advanced to the newest ts only after full traversal.
    const [watermark] = await query<{ last_seen_ts: string }>(`SELECT last_seen_ts FROM conversation_watermarks WHERE user_id = 'tenant-1'`);
    expect(watermark?.last_seen_ts).toBe("1800000010.000100");
    const [state] = await query<{ history_complete_at: Date | null }>(`SELECT history_complete_at FROM slack_source_conversations WHERE tenant_id = 'tenant-1'`);
    expect(state?.history_complete_at).not.toBeNull();

    expect(result).toMatchObject({ conversationsSeen: 1, stored: 2, exhausted: true, capHit: false });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
