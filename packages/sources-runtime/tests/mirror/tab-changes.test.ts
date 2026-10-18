import { describe, expect, it } from "vitest";
import { extractTabChanges, tabTreeSignature } from "../../src/integrations/google/gdocs/tab-changes.js";

function changelog(ops: unknown[], tabs: unknown[], userMap: Record<string, { name: string }>) {
  return {
    fileId: "doc1",
    totalRevisions: ops.length,
    userMap: new Map(Object.entries(userMap).map(([id, v]) => [id, { ...v, anonymous: false }])),
    operations: ops,
    tabs,
  } as unknown as Parameters<typeof extractTabChanges>[0];
}

describe("extractTabChanges", () => {
  it("extracts attributed tab create/rename/move/delete events and current state", () => {
    const result = extractTabChanges(
      changelog(
        [
          { type: "tab_created", tabEvent: { targetTabId: "t.a", position: [1] }, userId: "u1", timestamp: new Date("2026-07-03T10:00:00Z"), changelogIndex: 1 },
          { type: "tab_renamed", tabEvent: { targetTabId: "t.a", tabName: "Renamed", position: [1] }, userId: "u2", timestamp: new Date("2026-07-03T10:05:00Z"), changelogIndex: 2 },
          { type: "tab_moved", tabEvent: { targetTabId: "t.a", fromPosition: [1], position: [0, 0] }, userId: "u1", timestamp: new Date("2026-07-03T10:06:00Z"), changelogIndex: 3 },
          { type: "tab_deleted", tabEvent: { targetTabId: "t.b" }, userId: "u2", timestamp: new Date("2026-07-03T10:07:00Z"), changelogIndex: 4 },
          // non-tab op ignored
          { type: "insert", text: "hi", userId: "u1", timestamp: new Date(), changelogIndex: 5 },
          // tab_config ignored
          { type: "tab_config", tabEvent: { targetTabId: "t.a" }, userId: "u1", timestamp: new Date(), changelogIndex: 6 },
        ],
        [{ tabId: "t.a", name: "Renamed", position: [0, 0], parentTabId: "t.root", createdAt: new Date("2026-07-03T10:00:00Z") }],
        { u1: { name: "Alice" }, u2: { name: "Bob" } },
      ),
    );

    expect(result.events.map((e) => e.eventType)).toEqual(["created", "renamed", "moved", "deleted"]);
    const renamed = result.events.find((e) => e.eventType === "renamed")!;
    expect(renamed.actorName).toBe("Bob");
    expect(renamed.newName).toBe("Renamed");
    const moved = result.events.find((e) => e.eventType === "moved")!;
    expect(moved.fromPosition).toEqual([1]);
    expect(moved.toPosition).toEqual([0, 0]);
    expect(moved.actorName).toBe("Alice");

    expect(result.state).toHaveLength(1);
    expect(result.state[0]).toMatchObject({ tabId: "t.a", name: "Renamed", parentTabId: "t.root" });
  });

  it("signature changes on rename, reorder, and re-nest — so drift is detected without a changelog", () => {
    const base = tabTreeSignature([
      { tabId: "t.a", tabName: "Intro", parentTabId: null, order: 0 },
      { tabId: "t.b", tabName: "Body", parentTabId: null, order: 1 },
    ]);
    const renamed = tabTreeSignature([
      { tabId: "t.a", tabName: "Introduction", parentTabId: null, order: 0 },
      { tabId: "t.b", tabName: "Body", parentTabId: null, order: 1 },
    ]);
    const reordered = tabTreeSignature([
      { tabId: "t.b", tabName: "Body", parentTabId: null, order: 0 },
      { tabId: "t.a", tabName: "Intro", parentTabId: null, order: 1 },
    ]);
    const renested = tabTreeSignature([
      { tabId: "t.a", tabName: "Intro", parentTabId: null, order: 0 },
      { tabId: "t.b", tabName: "Body", parentTabId: "t.a", order: 1 },
    ]);
    expect(renamed).not.toBe(base);
    expect(reordered).not.toBe(base);
    expect(renested).not.toBe(base);
    // Identical tree → identical signature (no false drift).
    expect(tabTreeSignature([
      { tabId: "t.a", tabName: "Intro", parentTabId: null, order: 0 },
      { tabId: "t.b", tabName: "Body", parentTabId: null, order: 1 },
    ])).toBe(base);
  });
});
