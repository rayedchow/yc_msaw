import { describe, expect, it } from "vitest";
import {
  buildSlackMentionStamp,
  reconcileStoredSlackMessagePayload,
} from "../../src/mirror/slack-payload.js";

describe("Slack payload mention stamps", () => {
  it("stamps resolved mentions and counts unresolved or over-cap mentions as dropped", () => {
    const text = Array.from({ length: 22 }, (_, index) => `<@U${index}>`).join(" ");
    const stamp = buildSlackMentionStamp(text, (id) => id === "U1" ? undefined : `Name ${id}`);

    expect(stamp._mentions).toEqual(Object.fromEntries(
      Array.from({ length: 19 }, (_, index) => [`U${index === 0 ? 0 : index + 1}`, `Name U${index === 0 ? 0 : index + 1}`]),
    ));
    expect(stamp._mentions_dropped).toBe(3);
  });
});

describe("Slack stored payload reconciliation", () => {
  it("reports changed text, appends edit history, and removes old mention stamps", () => {
    const result = reconcileStoredSlackMessagePayload(
      {
        text: "old text",
        _mentions: { U2: "Old Blair" },
        _mentions_dropped: 1,
        _edit_history: [{ text: "older text", edited_at: "1719791000.000000" }],
      },
      {
        text: "new text <@U2>",
        _mentions: { U2: "Blair" },
        edited: { user: "U1", ts: "1719792060.000000" },
      },
      "fallback-edit-time",
    );

    expect(result.changed).toBe(true);
    expect(result.textChanged).toBe(true);
    expect(result.payload.text).toBe("new text <@U2>");
    expect(result.payload._mentions).toEqual({ U2: "Blair" });
    expect(result.payload._mentions_dropped).toBeUndefined();
    expect(result.payload._edit_history).toEqual([
      { text: "older text", edited_at: "1719791000.000000" },
      { text: "old text", edited_at: "1719792060.000000" },
    ]);
  });

  it("uses the caller-provided fallback edit time without reading the wall clock", () => {
    const result = reconcileStoredSlackMessagePayload(
      { text: "old text", _mentions: { U2: "Old Blair" } },
      { text: "new text" },
      "provided-fallback",
    );

    expect(result.changed).toBe(true);
    expect(result.payload._mentions).toBeUndefined();
    expect(result.payload._edit_history).toEqual([{ text: "old text", edited_at: "provided-fallback" }]);
  });

  it("reports changed reactions without appending edit history", () => {
    const result = reconcileStoredSlackMessagePayload(
      {
        text: "ship it",
        _edit_history: [{ text: "draft", edited_at: "1719791000.000000" }],
        reactions: [],
      },
      {
        text: "ship it",
        reactions: [{ name: "thumbsup", users: ["U2"], count: 1 }],
      },
      "fallback-edit-time",
    );

    expect(result.changed).toBe(true);
    expect(result.textChanged).toBe(false);
    expect(result.payload.reactions).toEqual([{ name: "thumbsup", users: ["U2"], count: 1 }]);
    expect(result.payload._edit_history).toEqual([{ text: "draft", edited_at: "1719791000.000000" }]);
  });

  it("reports identical payloads unchanged with stable-sorted reactions", () => {
    const result = reconcileStoredSlackMessagePayload(
      {
        text: "ship it",
        edited: { user: "U1", ts: "1719792060.000000" },
        reactions: [
          { name: "white_check_mark", users: ["U3"], count: 1 },
          { name: "thumbsup", users: ["U2", "U1"], count: 2 },
        ],
      },
      {
        text: "ship it",
        edited: { user: "U1", ts: "1719792060.000000" },
        reactions: [
          { name: "thumbsup", users: ["U1", "U2"], count: 2 },
          { name: "white_check_mark", users: ["U3"], count: 1 },
        ],
      },
      "fallback-edit-time",
    );

    expect(result.changed).toBe(false);
    expect(result.textChanged).toBe(false);
  });
});
