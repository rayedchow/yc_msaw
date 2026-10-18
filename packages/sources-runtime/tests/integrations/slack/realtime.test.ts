import { beforeEach, describe, expect, it, vi } from "vitest";

const limitMock = vi.hoisted(() => vi.fn());
const selectMock = vi.hoisted(() => vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ limit: limitMock })),
  })),
})));
const returningMock = vi.hoisted(() => vi.fn());
const valuesMock = vi.hoisted(() => vi.fn(() => ({
  onConflictDoNothing: vi.fn(() => ({ returning: returningMock })),
})));
const insertMock = vi.hoisted(() => vi.fn(() => ({ values: valuesMock })));
const updateWhereMock = vi.hoisted(() => vi.fn());
const updateSetMock = vi.hoisted(() => vi.fn(() => ({ where: updateWhereMock })));
const updateMock = vi.hoisted(() => vi.fn(() => ({ set: updateSetMock })));
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const materializeSlackDayMock = vi.hoisted(() => vi.fn());
const captureFilesMock = vi.hoisted(() => vi.fn(async () => ({ stored: 0, skips: {} })));
const enqueueSlackWindowsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
  },
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  getTokenWithMetadata: vi.fn(),
  mergeTokenMetadata: vi.fn(),
}));

vi.mock("../../../src/integrations/slack/materialize.js", () => ({
  materializeSlackChannelDay: materializeSlackDayMock,
}));

vi.mock("../../../src/integrations/slack/files.js", () => ({
  captureSlackMessageFiles: captureFilesMock,
}));

vi.mock("../../../src/integrations/slack/windows.js", () => ({
  enqueueSlackChannelWindows: enqueueSlackWindowsMock,
}));

import { handleEvent } from "../../../src/integrations/slack/realtime.js";
import { drainSlackSkips } from "../../../src/integrations/slack/skips.js";

function insertedValues(): Array<Record<string, any>> {
  return (valuesMock.mock.calls as unknown[][]).map((call) => call[0] as Record<string, any>);
}

describe("Slack realtime capture", () => {
  beforeEach(() => {
    limitMock.mockReset().mockResolvedValue([{ name: "launch", type: "public_channel" }]);
    selectMock.mockClear();
    insertMock.mockClear();
    valuesMock.mockClear();
    updateMock.mockClear();
    updateSetMock.mockClear();
    updateWhereMock.mockReset().mockResolvedValue(undefined);
    returningMock.mockReset().mockResolvedValue([{ id: "event-1" }]);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    materializeSlackDayMock.mockReset().mockResolvedValue(undefined);
    captureFilesMock.mockClear().mockResolvedValue({ stored: 0, skips: {} });
    enqueueSlackWindowsMock.mockReset().mockResolvedValue("task-1");
    drainSlackSkips("tenant-1");
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: true,
      members: [{
        id: "U123",
        name: "ada",
        real_name: "Ada Lovelace",
        profile: { email: "ada@example.com", display_name: "Ada" },
      }],
      response_metadata: { next_cursor: "" },
    })));
  });

  it("stores a redacted Slack message event and materializes the touched day file", async () => {
    await handleEvent({
      event: {
        type: "message",
        channel: "C123",
        user: "U123",
        ts: "1800000000.000100",
        text: "Launch note",
        files: [{ id: "F123", name: "launch.pdf", url_private: "https://files.slack.com/private" }],
      },
    }, "tenant-1", "xoxp-token", "T123");

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "tenant-1",
      source: "slack",
      eventType: "message",
      sourceNamespace: "workspace:T123",
      sourceObjectId: "message:C123:1800000000.000100",
      recordKind: "activity",
      sourceEventId: "slack:C123:1800000000.000100",
      processingStatus: "collected",
      extractedEntities: expect.arrayContaining([
        expect.objectContaining({ type: "slack_user", id: "U123", email: "ada@example.com" }),
        { type: "email_contact", id: "ada@example.com", email: "ada@example.com" },
      ]),
    }));
    const values = insertedValues()[0];
    if (!values) throw new Error("expected activity_events insert values");
    expect(values.rawPayload).toMatchObject({
      text: "Launch note",
      _channel: "C123",
      _channel_name: "launch",
      _user_email: "ada@example.com",
    });
    expect(JSON.stringify(values.rawPayload)).not.toContain("files.slack.com/private");
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("event-1", "tenant-1", "slack");
    expect(materializeSlackDayMock).toHaveBeenCalledWith("tenant-1", "C123", "1800000000.000100");
    expect(enqueueSlackWindowsMock).toHaveBeenCalledWith("tenant-1", "C123");
    expect(captureFilesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      files: [expect.objectContaining({ id: "F123" })],
    }));
  });

  it("captures channel_join messages instead of skipping them", async () => {
    await handleEvent({
      event: {
        type: "message",
        subtype: "channel_join",
        channel: "C123",
        user: "U123",
        ts: "1800000000.000200",
        text: "<@U123> has joined the channel",
      },
    }, "tenant-1", "xoxp-token", "T123");

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "message",
      sourceEventId: "slack:C123:1800000000.000200",
    }));
  });

  it("appends a message.edited observation without mutating the original", async () => {
    limitMock
      .mockResolvedValueOnce([{ name: "launch", type: "public_channel" }]) // channel name
      .mockResolvedValueOnce([{
        id: "orig-1",
        rawPayload: { text: "old text", _channel: "C123" },
      }]); // existing message row

    await handleEvent({
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C123",
        event_ts: "1800000001.000000",
        message: {
          type: "message",
          user: "U123",
          ts: "1800000000.000100",
          text: "new text",
          edited: { user: "U123", ts: "1800000001.000000" },
        },
        previous_message: { type: "message", user: "U123", ts: "1800000000.000100", text: "old text" },
      },
    }, "tenant-1", "xoxp-token", "T123");

    // Appended ledger row (new row, versioned dedupe key)
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "message.edited",
      sourceNamespace: "workspace:T123",
      sourceObjectId: "message:C123:1800000000.000100",
      recordKind: "activity",
      sourceEventId: "slack:C123:1800000000.000100:edit:1800000001.000000",
      processingStatus: "collected",
    }));
    const ledger = insertedValues().find((v) => v.eventType === "message.edited");
    expect(ledger?.rawPayload).toMatchObject({
      _ledger: true,
      _channel: "C123",
      previous_message: expect.objectContaining({ text: "old text" }),
    });

    expect(updateMock).not.toHaveBeenCalled();
    expect(enqueueSlackWindowsMock).toHaveBeenCalledWith("tenant-1", "C123");
  });

  it("appends a message.deleted tombstone without mutating the original", async () => {
    limitMock
      .mockResolvedValueOnce([{ name: "launch", type: "public_channel" }]) // channel name
      .mockResolvedValueOnce([{
        id: "orig-1",
        rawPayload: { text: "to be deleted", _channel: "C123" },
      }]); // existing message row

    await handleEvent({
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C123",
        deleted_ts: "1800000000.000100",
        event_ts: "1800000002.000000",
        previous_message: { type: "message", user: "U123", ts: "1800000000.000100", text: "to be deleted" },
      },
    }, "tenant-1", "xoxp-token", "T123");

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "message.deleted",
      sourceNamespace: "workspace:T123",
      sourceObjectId: "message:C123:1800000000.000100",
      recordKind: "tombstone",
      sourceEventId: "slack:C123:1800000000.000100:delete:1800000002.000000",
      extractedEntities: [{ type: "slack_user", id: "U123" }],
    }));
    const ledger = insertedValues().find((v) => v.eventType === "message.deleted");
    expect(ledger?.rawPayload).toMatchObject({ _ledger: true, _channel: "C123" });

    expect(updateMock).not.toHaveBeenCalled();
    expect(enqueueSlackWindowsMock).toHaveBeenCalledWith("tenant-1", "C123");
  });

  it("appends versioned reaction observations without mutating the original", async () => {
    limitMock
      .mockResolvedValueOnce([{ name: "launch", type: "public_channel" }]) // channel name
      .mockResolvedValueOnce([{
        id: "orig-1",
        rawPayload: { text: "hello", _channel: "C123", reactions: [] },
      }]); // existing message row

    await handleEvent({
      event: {
        type: "reaction_added",
        user: "U123",
        reaction: "tada",
        item: { type: "message", channel: "C123", ts: "1800000000.000100" },
        event_ts: "1800000003.000000",
      },
    }, "tenant-1", "xoxp-token", "T123");

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "message.reaction_added",
      sourceNamespace: "workspace:T123",
      sourceObjectId: "message:C123:1800000000.000100",
      recordKind: "activity",
      sourceEventId: "slack:C123:1800000000.000100:reaction:tada:U123:1800000003.000000",
      extractedEntities: [{ type: "slack_user", id: "U123" }],
    }));
    const ledger = insertedValues().find((v) => v.eventType === "message.reaction_added");
    expect(ledger?.rawPayload).toMatchObject({ _ledger: true, reaction: "tada" });

    expect(updateMock).not.toHaveBeenCalled();
    expect(enqueueSlackWindowsMock).toHaveBeenCalledWith("tenant-1", "C123");
  });

  it("captures channel lifecycle events without a message ts as ledger rows", async () => {
    await handleEvent({
      event: {
        type: "channel_archive",
        channel: "C123",
        user: "U123",
        event_ts: "1800000005.000000",
      },
    }, "tenant-1", "xoxp-token", "T123");

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "channel_archive",
      sourceNamespace: "workspace:T123",
      sourceObjectId: "channel:C123",
      recordKind: "activity",
      sourceEventId: "slack:C123:channel_archive:1800000005.000000",
      extractedEntities: [{ type: "slack_user", id: "U123" }],
    }));
    const ledger = insertedValues()[0];
    expect(ledger?.rawPayload).toMatchObject({ _ledger: true, _channel: "C123" });
  });

  it("counts unhandleable events in the skips ledger instead of a bare return", async () => {
    await handleEvent({
      event: {
        type: "some_future_event",
        channel: "C123",
        // no ts, no event_ts
      },
    }, "tenant-1", "xoxp-token", "T123");

    expect(valuesMock).not.toHaveBeenCalled();
    expect(drainSlackSkips("tenant-1")).toEqual({ "realtime_unhandled:some_future_event": 1 });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
