import { describe, it, expect } from "vitest";
import {
  aggregateSessions,
  formatForLLM,
  replayFullDoc,
  type AggregatedSession,
} from "../../src/polling/_archived-gdocs/gdocs-session-aggregator.js";
import type { ChangelogOperation, DocChangelog } from "../../src/polling/_archived-gdocs/gdocs-revisions-load.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(overrides: Partial<ChangelogOperation> & { changelogIndex: number; userId: string; timestamp: Date }): ChangelogOperation {
  return {
    type: "insert",
    text: "",
    revisionId: overrides.changelogIndex,
    sessionId: "s1",
    ...overrides,
  };
}

function makeChangelog(ops: ChangelogOperation[]): DocChangelog {
  return {
    fileId: "test-doc",
    totalRevisions: ops.length,
    userMap: new Map([
      ["user1", { name: "Ishan", anonymous: false }],
      ["user2", { name: "Elijah", anonymous: false }],
    ]),
    operations: ops,
    tabs: [{ tabId: "t.0", name: "Main", position: [0] }],
  };
}

const t = (min: number) => new Date(Date.UTC(2026, 4, 20, 12, min, 0));

// ---------------------------------------------------------------------------
// Session grouping
// ---------------------------------------------------------------------------

describe("aggregateSessions", () => {
  it("groups ops into a single session when all within 5min", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), text: "hello" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 14 * 60_000), text: " world" }),
      makeOp({ changelogIndex: 3, userId: "user1", timestamp: new Date(Date.now() - 13 * 60_000), text: "!" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions.length).toBe(1);
    expect(result.completedSessions[0].authorUserId).toBe("user1");
    expect(result.completedSessions[0].operationCount).toBe(3);
  });

  it("splits into two sessions when gap >= 5min", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 20 * 60_000) }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 19 * 60_000) }),
      makeOp({ changelogIndex: 3, userId: "user1", timestamp: new Date(Date.now() - 10 * 60_000) }),
      makeOp({ changelogIndex: 4, userId: "user1", timestamp: new Date(Date.now() - 9 * 60_000) }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions.length).toBe(2);
  });

  it("keeps active session in pendingOps", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 2 * 60_000), text: "hi" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions.length).toBe(0);
    expect(result.pendingOps.length).toBe(1);
  });

  it("separates different users into different sessions", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), text: "a" }),
      makeOp({ changelogIndex: 2, userId: "user2", timestamp: new Date(Date.now() - 14 * 60_000), text: "b" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions.length).toBe(2);
  });

  it("combines pending buffer with new ops", () => {
    const pendingOps = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 20 * 60_000), text: "old" }),
    ];
    const newOps = [
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 18 * 60_000), text: "new" }),
    ];
    const changelog = makeChangelog([...pendingOps, ...newOps]);
    const result = aggregateSessions(changelog, newOps, pendingOps, [], 0);
    expect(result.completedSessions.length).toBe(1);
    expect(result.completedSessions[0].operationCount).toBe(2);
  });

  it("returns empty when no ops", () => {
    const changelog = makeChangelog([]);
    const result = aggregateSessions(changelog, [], [], [], 0);
    expect(result.completedSessions.length).toBe(0);
  });

  it("tracks lastSynthesizedEntry correctly", () => {
    const ops = [
      makeOp({ changelogIndex: 50, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000) }),
      makeOp({ changelogIndex: 51, userId: "user1", timestamp: new Date(Date.now() - 14 * 60_000) }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 49);
    expect(result.lastSynthesizedEntry).toBe(51);
  });

  it("deduplicates overlapping pendingBuffer and newOps", () => {
    const sharedOps = [
      makeOp({ changelogIndex: 5, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), text: "x" }),
    ];
    const changelog = makeChangelog(sharedOps);
    const result = aggregateSessions(changelog, sharedOps, [...sharedOps], [], 0);
    expect(result.completedSessions.length).toBe(1);
    expect(result.completedSessions[0].operationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tab activity (timeline-based)
// ---------------------------------------------------------------------------

describe("tab activity", () => {
  it("tracks insertions with timeline entries", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "hello world", startIndex: 1, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const tab = result.completedSessions[0].tabActivity[0];
    expect(tab.charsInserted).toBe(11);
    expect(tab.timeline.length).toBeGreaterThan(0);
    expect(tab.timeline[0].description).toContain("Added 11 chars");
    expect(tab.timeline[0].description).toContain("hello world");
  });

  it("tracks deletions with deleted text in timeline", () => {
    const priorOps = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 30 * 60_000), type: "insert", text: "delete me", startIndex: 1, tabId: "t.0" }),
    ];
    const newOps = [
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "delete", startIndex: 1, endIndex: 6, tabId: "t.0" }),
    ];
    const changelog = makeChangelog([...priorOps, ...newOps]);
    const result = aggregateSessions(changelog, newOps, [], priorOps, 1);
    const tab = result.completedSessions[0].tabActivity[0];
    expect(tab.charsDeleted).toBe(6);
    expect(tab.timeline[0].description).toContain("Deleted");
  });

  it("captures tab events in timeline", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "tab_created", tabId: "t.new" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 14 * 60_000), type: "insert", text: "content", startIndex: 1, tabId: "t.new" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const tab = result.completedSessions[0].tabActivity.find(t => t.tabId === "t.new");
    expect(tab).toBeDefined();
    const events = tab!.timeline.map(e => e.description);
    expect(events.some(e => e.includes("Created tab"))).toBe(true);
  });

  it("captures format changes with affected text in timeline", () => {
    const priorOps = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 30 * 60_000), type: "insert", text: "Y Combinator rocks", startIndex: 1, tabId: "t.0" }),
    ];
    const newOps = [
      makeOp({
        changelogIndex: 2, userId: "user1",
        timestamp: new Date(Date.now() - 15 * 60_000),
        type: "format", startIndex: 1, endIndex: 12, tabId: "t.0",
        styleModification: { ts_bd: true },
      }),
    ];
    const changelog = makeChangelog([...priorOps, ...newOps]);
    const result = aggregateSessions(changelog, newOps, [], priorOps, 1);
    const tab = result.completedSessions[0].tabActivity[0];
    const formatEntry = tab.timeline.find(e => e.description.includes("bold"));
    expect(formatEntry).toBeDefined();
    expect(formatEntry!.description).toContain("Y Combinator");
  });

  it("provides full tab content (after session) from replay", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "first ", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 14 * 60_000), type: "insert", text: "second", startIndex: 7, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions[0].tabActivity[0].fullContent).toBe("first second");
  });

  it("handles element operations in timeline", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "add_element", tabId: "t.0", elementType: "table" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const tab = result.completedSessions[0].tabActivity[0];
    expect(tab.timeline[0].description).toContain("Added table");
  });

  it("handles replace/revert in timeline", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 18 * 60_000), type: "insert", text: "original", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 17 * 60_000), type: "replace", tabId: "t.0" }),
      makeOp({ changelogIndex: 3, userId: "user1", timestamp: new Date(Date.now() - 16 * 60_000), type: "insert", text: "replaced", startIndex: 1, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const tab = result.completedSessions[0].tabActivity[0];
    expect(tab.fullContent).toBe("replaced");
    expect(tab.timeline.some(e => e.description.includes("replaced"))).toBe(true);
  });

  it("replace only clears affected tab", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 20 * 60_000), type: "insert", text: "tab0 content", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 19 * 60_000), type: "insert", text: "tab1 content", startIndex: 1, tabId: "t.1" }),
      makeOp({ changelogIndex: 3, userId: "user1", timestamp: new Date(Date.now() - 18 * 60_000), type: "replace", tabId: "t.1" }),
      makeOp({ changelogIndex: 4, userId: "user1", timestamp: new Date(Date.now() - 17 * 60_000), type: "insert", text: "new tab1", startIndex: 1, tabId: "t.1" }),
    ];
    const changelog = makeChangelog(ops);
    changelog.tabs.push({ tabId: "t.1", name: "Tab 2", position: [1] });
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const tab0 = result.completedSessions[0].tabActivity.find(t => t.tabId === "t.0");
    const tab1 = result.completedSessions[0].tabActivity.find(t => t.tabId === "t.1");
    expect(tab0!.fullContent).toBe("tab0 content");
    expect(tab1!.fullContent).toBe("new tab1");
  });

  it("clamps deleteChars to actual doc length", () => {
    const priorOps = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 30 * 60_000), type: "insert", text: "abcde", startIndex: 1, tabId: "t.0" }),
    ];
    const newOps = [
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "delete", startIndex: 3, endIndex: 8, tabId: "t.0" }),
    ];
    const changelog = makeChangelog([...priorOps, ...newOps]);
    const result = aggregateSessions(changelog, newOps, [], priorOps, 1);
    expect(result.completedSessions[0].tabActivity[0].charsDeleted).toBe(3);
  });

  it("coalesces consecutive inserts into single timeline entry", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "a", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 14.9 * 60_000), type: "insert", text: "b", startIndex: 2, tabId: "t.0" }),
      makeOp({ changelogIndex: 3, userId: "user1", timestamp: new Date(Date.now() - 14.8 * 60_000), type: "insert", text: "c", startIndex: 3, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const tab = result.completedSessions[0].tabActivity[0];
    // Should be coalesced into 1 timeline entry, not 3
    const addEntries = tab.timeline.filter(e => e.description.startsWith("Added"));
    expect(addEntries.length).toBe(1);
    expect(addEntries[0].description).toContain("3 chars");
  });

  it("does not coalesce non-contiguous inserts on same tab", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "start ", startIndex: 1, tabId: "t.0" }),
      // Non-contiguous: jumps to position 50
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 14 * 60_000), type: "insert", text: "end", startIndex: 50, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const tab = result.completedSessions[0].tabActivity[0];
    const addEntries = tab.timeline.filter(e => e.description.startsWith("Added"));
    expect(addEntries.length).toBe(2);
  });

  it("delete shows surrounding context with brackets", () => {
    // "working from a coffee shop in SoMa, watching the sunset"
    //  1234567890...                     ^30  ^33 (1-indexed)
    const priorOps = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 30 * 60_000), type: "insert", text: "working from a coffee shop in SoMa, watching the sunset", startIndex: 1, tabId: "t.0" }),
    ];
    const newOps = [
      // 1-indexed: 'S'=31, 'o'=32, 'M'=33, 'a'=34
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "delete", startIndex: 31, endIndex: 34, tabId: "t.0" }),
    ];
    const changelog = makeChangelog([...priorOps, ...newOps]);
    const result = aggregateSessions(changelog, newOps, [], priorOps, 1);
    const desc = result.completedSessions[0].tabActivity[0].timeline[0].description;
    expect(desc).toContain("[SoMa]");
    expect(desc).toContain("shop in ");
    expect(desc).toContain(", watching");
  });

  it("insert shows surrounding context with brackets", () => {
    const priorOps = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 30 * 60_000), type: "insert", text: "coffee shop in , watching", startIndex: 1, tabId: "t.0" }),
    ];
    const newOps = [
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "Dogpatch", startIndex: 16, tabId: "t.0" }),
    ];
    const changelog = makeChangelog([...priorOps, ...newOps]);
    const result = aggregateSessions(changelog, newOps, [], priorOps, 1);
    const desc = result.completedSessions[0].tabActivity[0].timeline[0].description;
    expect(desc).toContain("[Dogpatch]");
    expect(desc).toContain("coffee shop in");
    expect(desc).toContain("watching");
  });

  it("handles newlines in edited text by replacing with ↵", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "line1\nline2\nline3", startIndex: 1, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const desc = result.completedSessions[0].tabActivity[0].timeline[0].description;
    expect(desc).not.toContain("\n");
    expect(desc).toContain("↵");
  });

  it("handles insert at start of empty doc (no before-context)", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "first text", startIndex: 1, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const desc = result.completedSessions[0].tabActivity[0].timeline[0].description;
    expect(desc).toContain("Added 10 chars");
    expect(desc).toContain("first text");
  });

  it("mark_deletion produces timeline entry with affected text", () => {
    const priorOps = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 30 * 60_000), type: "insert", text: "remove this text", startIndex: 1, tabId: "t.0" }),
    ];
    const newOps = [
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "mark_deletion", startIndex: 8, endIndex: 11, tabId: "t.0", sugId: "sug1" }),
    ];
    const changelog = makeChangelog([...priorOps, ...newOps]);
    const result = aggregateSessions(changelog, newOps, [], priorOps, 1);
    const tab = result.completedSessions[0].tabActivity[0];
    const entry = tab.timeline.find(e => e.description.includes("Suggested deleting"));
    expect(entry).toBeDefined();
    expect(entry!.description).toContain("this");
  });

  it("insert context shows correct ordering: before [inserted] after", () => {
    const priorOps = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 30 * 60_000), type: "insert", text: "AAA BBB", startIndex: 1, tabId: "t.0" }),
    ];
    const newOps = [
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "CCC", startIndex: 5, tabId: "t.0" }),
    ];
    const changelog = makeChangelog([...priorOps, ...newOps]);
    const result = aggregateSessions(changelog, newOps, [], priorOps, 1);
    const desc = result.completedSessions[0].tabActivity[0].timeline[0].description;
    expect(desc).toMatch(/AAA \[CCC\]BBB/);
  });
});

// ---------------------------------------------------------------------------
// Format for LLM
// ---------------------------------------------------------------------------

describe("formatForLLM", () => {
  it("produces timeline-based LLM input", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "hello world", startIndex: 1, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const llmInput = formatForLLM(result.completedSessions[0], new Map([["t.0", "Empty tab"]]));

    expect(llmInput.author).toBe("Ishan");
    expect(llmInput.tabs.length).toBe(1);
    expect(llmInput.tabs[0].previousSummary).toBe("Empty tab");
    expect(llmInput.tabs[0].fullContent).toBe("hello world");
    expect(llmInput.tabs[0].changes).toContain("Added 11 chars");
    // Timeline format: [HH:MM:SS] description
    expect(llmInput.tabs[0].changes).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  it("includes timestamps in output", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "test", startIndex: 1, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    const llmInput = formatForLLM(result.completedSessions[0], new Map());
    expect(llmInput.startTime).toContain("T");
    expect(llmInput.endTime).toContain("T");
  });

});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty text inserts", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "", startIndex: 1, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions.length).toBe(1);
  });

  it("handles ops without tabId (default tab)", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "notab", startIndex: 1 }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions[0].tabActivity[0].tabId).toBe("__default__");
  });

  it("handles mixed sessions (some complete, some pending)", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 20 * 60_000), text: "old" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 1 * 60_000), text: "new" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions.length).toBe(1);
    expect(result.pendingOps.length).toBe(1);
  });

  it("pending sessions still advance replay state for later sessions", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 2 * 60_000), type: "insert", text: "PENDING", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user2", timestamp: new Date(Date.now() - 15 * 60_000), type: "insert", text: "DONE", startIndex: 1, tabId: "t.0" }),
    ];
    const changelog = makeChangelog(ops);
    const result = aggregateSessions(changelog, ops, [], [], 0);
    expect(result.completedSessions.length).toBe(1);
    expect(result.completedSessions[0].authorUserId).toBe("user2");
    expect(result.pendingOps.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// replayFullDoc (cold-start)
// ---------------------------------------------------------------------------

describe("replayFullDoc", () => {
  it("replays all ops into final per-tab content", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: t(0), type: "insert", text: "hello ", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: t(1), type: "insert", text: "world", startIndex: 7, tabId: "t.0" }),
      makeOp({ changelogIndex: 3, userId: "user1", timestamp: t(2), type: "insert", text: "tab2 content", startIndex: 1, tabId: "t.1" }),
    ];
    const result = replayFullDoc(ops);
    expect(result.get("t.0")).toBe("hello world");
    expect(result.get("t.1")).toBe("tab2 content");
  });

  it("handles deletes correctly", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: t(0), type: "insert", text: "abcdefg", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: t(1), type: "delete", startIndex: 3, endIndex: 5, tabId: "t.0" }),
    ];
    const result = replayFullDoc(ops);
    expect(result.get("t.0")).toBe("abfg");
  });

  it("handles replace on one tab without affecting others", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: t(0), type: "insert", text: "tab0", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: t(1), type: "insert", text: "tab1 original", startIndex: 1, tabId: "t.1" }),
      makeOp({ changelogIndex: 3, userId: "user1", timestamp: t(2), type: "replace", tabId: "t.1" }),
      makeOp({ changelogIndex: 4, userId: "user1", timestamp: t(3), type: "insert", text: "tab1 new", startIndex: 1, tabId: "t.1" }),
    ];
    const result = replayFullDoc(ops);
    expect(result.get("t.0")).toBe("tab0");
    expect(result.get("t.1")).toBe("tab1 new");
  });

  it("returns empty map for no ops", () => {
    const result = replayFullDoc([]);
    expect(result.size).toBe(0);
  });

  it("multi-tab ops with correct per-op tab IDs produce separate tab content", () => {
    // This test verifies the Bug A fix: each op has its own tabId
    // (previously mlti could assign all sub-ops the same tab ID)
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: t(0), type: "insert", text: "tab1 content", startIndex: 1, tabId: "t.tab1" }),
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: t(0), type: "insert", text: "tab2 content", startIndex: 1, tabId: "t.tab2" }),
    ];
    const result = replayFullDoc(ops);
    expect(result.get("t.tab1")).toBe("tab1 content");
    expect(result.get("t.tab2")).toBe("tab2 content");
  });

  it("interleaved multi-tab inserts and deletes stay isolated", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: t(0), type: "insert", text: "ABCDE", startIndex: 1, tabId: "t.0" }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: t(1), type: "insert", text: "12345", startIndex: 1, tabId: "t.1" }),
      // Delete from t.0 should not affect t.1
      makeOp({ changelogIndex: 3, userId: "user1", timestamp: t(2), type: "delete", startIndex: 2, endIndex: 4, tabId: "t.0" }),
      // Delete from t.1 should not affect t.0
      makeOp({ changelogIndex: 4, userId: "user1", timestamp: t(3), type: "delete", startIndex: 1, endIndex: 2, tabId: "t.1" }),
    ];
    const result = replayFullDoc(ops);
    expect(result.get("t.0")).toBe("AE");    // deleted BCD
    expect(result.get("t.1")).toBe("345");   // deleted 12
  });
});

// ---------------------------------------------------------------------------
// Cross-user suggestion acceptance
// ---------------------------------------------------------------------------

describe("cross-user suggestion tracking", () => {
  it("shows accepted status when different user accepts suggestion", () => {
    // User1 suggests, User2 accepts — they're in different sessions
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 20 * 60_000),
        type: "insert_suggestion", text: "suggested text", startIndex: 1, tabId: "t.0", sugId: "sug.1" }),
      makeOp({ changelogIndex: 2, userId: "user2", timestamp: new Date(Date.now() - 15 * 60_000),
        type: "insert", text: "suggested text", startIndex: 1, tabId: "t.0", sugId: "sug.1" }),
    ];
    const changelog = makeChangelog(ops);

    const result = aggregateSessions(changelog, ops, [], [], 0);

    // Two separate sessions (different users)
    expect(result.completedSessions.length).toBe(2);

    // User1's session should show the suggestion as ACCEPTED (not pending)
    const user1Session = result.completedSessions.find(s => s.authorUserId === "user1")!;
    expect(user1Session.suggestions.total).toBe(1);
    expect(user1Session.suggestions.accepted).toBe(1);
    expect(user1Session.suggestions.pending).toBe(0);

    // The suggestion description should say accepted
    const sug = user1Session.suggestions.suggestions[0];
    expect(sug.status).toBe("accepted");
  });

  it("shows rejected status cross-user", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 20 * 60_000),
        type: "insert_suggestion", text: "bad idea", startIndex: 1, tabId: "t.0", sugId: "sug.2" }),
      makeOp({ changelogIndex: 2, userId: "user2", timestamp: new Date(Date.now() - 15 * 60_000),
        type: "unmark_deletion", startIndex: 1, endIndex: 8, tabId: "t.0", sugId: "sug.2" }),
    ];
    const changelog = makeChangelog(ops);

    const result = aggregateSessions(changelog, ops, [], [], 0);
    const user1Session = result.completedSessions.find(s => s.authorUserId === "user1")!;
    expect(user1Session.suggestions.rejected).toBe(1);
  });

  it("formatting suggestion modification is tracked", () => {
    const ops = [
      makeOp({ changelogIndex: 1, userId: "user1", timestamp: new Date(Date.now() - 20 * 60_000),
        type: "format", startIndex: 1, endIndex: 10, tabId: "t.0", sugId: "sug.3",
        styleModification: { ts_bd: true } }),
      makeOp({ changelogIndex: 2, userId: "user1", timestamp: new Date(Date.now() - 19 * 60_000),
        type: "format", startIndex: 1, endIndex: 20, tabId: "t.0", sugId: "sug.3",
        styleModification: { ts_bd: true, ts_it: true } }),
    ];
    const changelog = makeChangelog(ops);

    const result = aggregateSessions(changelog, ops, [], [], 0);
    const session = result.completedSessions[0];

    const sug = session.suggestions.suggestions.find(s => s.sugId === "sug.3")!;
    expect(sug).toBeDefined();
    expect(sug.modificationCount).toBe(1);
    expect(sug.status).toBe("modified");
    expect(sug.styleChanges).toEqual({ ts_bd: true, ts_it: true });
  });
});
