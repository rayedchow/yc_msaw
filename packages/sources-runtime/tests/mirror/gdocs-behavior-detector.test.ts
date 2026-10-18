/**
 * Exhaustive unit tests for the Google Docs behavior detector.
 *
 * Tests detectBehaviors and all sub-detectors: detectPastes, detectUndos,
 * detectFindReplace, detectStructuring, detectBulkFormatting, detectLinkInsertions,
 * analyzeSessionPatterns, analyzeCollaboration.
 *
 * No live API requests. Uses mock ChangelogOperation arrays.
 */

import { describe, it, expect } from "vitest";
import type { ChangelogOperation, DocChangelog } from "../../src/polling/_archived-gdocs/gdocs-revisions-load.js";
import {
  detectBehaviors,
  analyzeSessionPatterns,
  analyzeCollaboration,
} from "../../src/polling/_archived-gdocs/gdocs-behavior-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(overrides: Partial<ChangelogOperation>): ChangelogOperation {
  return {
    type: "other",
    userId: "user1",
    timestamp: new Date("2026-01-01T12:00:00Z"),
    revisionId: 1,
    sessionId: "sess1",
    changelogIndex: 1,
    ...overrides,
  };
}

function makeChangelog(ops: ChangelogOperation[]): DocChangelog {
  return {
    fileId: "test-file",
    totalRevisions: ops.length,
    userMap: new Map(),
    operations: ops,
    tabs: [],
  };
}

// ---------------------------------------------------------------------------
// detectPastes
// ---------------------------------------------------------------------------

describe("detectPastes", () => {
  it("1. short insert (<30 chars) is not detected as paste", () => {
    const ops = [makeOp({ type: "insert", text: "short text", changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(0);
  });

  it("2. long insert (50 chars) is detected as paste", () => {
    const text = "a".repeat(50);
    const ops = [makeOp({ type: "insert", text, changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(1);
    expect(result.pasteCharCount).toBe(50);
    const paste = result.behaviors.find((b) => b.type === "paste");
    expect(paste).toBeDefined();
    expect(paste!.detail.charCount).toBe(50);
    expect(paste!.detail.hasNewlines).toBe(false);
  });

  it("3. long insert with newlines is detected, hasNewlines=true", () => {
    const text = "a".repeat(20) + "\n" + "b".repeat(20);
    const ops = [makeOp({ type: "insert", text, changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(1);
    const paste = result.behaviors.find((b) => b.type === "paste");
    expect(paste!.detail.hasNewlines).toBe(true);
  });

  it("4. insert_suggestion with long text is detected as paste", () => {
    const text = "a".repeat(50);
    const ops = [makeOp({ type: "insert_suggestion", text, changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(1);
  });

  it("5. insert with no text field is not detected", () => {
    const ops = [makeOp({ type: "insert", changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(0);
  });

  it("6. exactly 30 chars is detected (threshold is >= 30, not > 30)", () => {
    // The code uses `op.text.length < PASTE_CHAR_THRESHOLD` to skip,
    // so length === 30 passes the filter and IS detected.
    const text = "a".repeat(30);
    const ops = [makeOp({ type: "insert", text, changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(1);
    expect(result.pasteCharCount).toBe(30);
  });

  it("29 chars is NOT detected", () => {
    const text = "a".repeat(29);
    const ops = [makeOp({ type: "insert", text, changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(0);
  });

  it("preview is truncated to 100 chars", () => {
    const text = "x".repeat(200);
    const ops = [makeOp({ type: "insert", text, changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    const paste = result.behaviors.find((b) => b.type === "paste");
    expect((paste!.detail.preview as string).length).toBe(100);
  });

  it("delete type is never detected as paste", () => {
    const ops = [makeOp({ type: "delete", text: "a".repeat(50), changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectUndos
// ---------------------------------------------------------------------------

describe("detectUndos", () => {
  it("7. insert then delete at same position within 5s is detected as undo", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "hello",
        startIndex: 10,
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "delete",
        startIndex: 10,
        endIndex: 14, // 5 chars: 10,11,12,13,14 = endIndex - startIndex + 1 = 5
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:02Z"), // 2 seconds later
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.undoCount).toBe(1);
    const undo = result.behaviors.find((b) => b.type === "undo");
    expect(undo).toBeDefined();
    expect(undo!.detail.undoneChangelogIndex).toBe(1);
    expect(undo!.detail.delayMs).toBe(2000);
    expect(undo!.detail.charCount).toBe(5);
  });

  it("8. insert then delete at DIFFERENT position is not detected", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "hello",
        startIndex: 10,
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "delete",
        startIndex: 20, // different position
        endIndex: 24,
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:02Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.undoCount).toBe(0);
  });

  it("9. insert then delete after 10s (outside 5s window) is not detected", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "hello",
        startIndex: 10,
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "delete",
        startIndex: 10,
        endIndex: 14,
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:10Z"), // 10 seconds later
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.undoCount).toBe(0);
  });

  it("10. insert then delete with different lengths is not detected", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "hello", // 5 chars
        startIndex: 10,
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "delete",
        startIndex: 10,
        endIndex: 12, // only 3 chars deleted
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:02Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.undoCount).toBe(0);
  });

  it("11. different userId is not detected as undo", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "hello",
        startIndex: 10,
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
      makeOp({
        type: "delete",
        startIndex: 10,
        endIndex: 14,
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:02Z"),
        userId: "user2", // different user
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.undoCount).toBe(0);
  });

  it("12. multiple inserts — undo matches any matching recent insert", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "abc",
        startIndex: 5,
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "insert",
        text: "hello",
        startIndex: 10,
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:01Z"),
      }),
      makeOp({
        type: "delete",
        startIndex: 10,
        endIndex: 14, // matches second insert
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:00:03Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.undoCount).toBe(1);
    const undo = result.behaviors.find((b) => b.type === "undo");
    expect(undo!.detail.undoneChangelogIndex).toBe(2);
  });

  it("13. very fast undo (<50ms) is not detected (likely same operation)", () => {
    const baseTime = new Date("2026-01-01T12:00:00.000Z");
    const ops = [
      makeOp({
        type: "insert",
        text: "hello",
        startIndex: 10,
        changelogIndex: 1,
        timestamp: baseTime,
      }),
      makeOp({
        type: "delete",
        startIndex: 10,
        endIndex: 14,
        changelogIndex: 2,
        timestamp: new Date(baseTime.getTime() + 30), // 30ms later
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.undoCount).toBe(0);
  });

  it("ring buffer: 51st insert pushes out the 1st", () => {
    const ops: ChangelogOperation[] = [];
    // 51 inserts, all at different positions
    for (let i = 0; i < 51; i++) {
      ops.push(
        makeOp({
          type: "insert",
          text: "x",
          startIndex: 100 + i,
          changelogIndex: i + 1,
          timestamp: new Date(`2026-01-01T12:00:${String(i).padStart(2, "0")}Z`),
        }),
      );
    }
    // Try to undo the first insert (pos 100, 1 char)
    ops.push(
      makeOp({
        type: "delete",
        startIndex: 100,
        endIndex: 100,
        changelogIndex: 52,
        timestamp: new Date("2026-01-01T12:00:52Z"), // within 5s of op at :00? no, 52s > 5s
      }),
    );
    const result = detectBehaviors(makeChangelog(ops));
    // Not detected: both because the first insert was evicted from the ring buffer
    // AND because the time window is exceeded
    expect(result.undoCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectFindReplace
// ---------------------------------------------------------------------------

describe("detectFindReplace", () => {
  it("14. 3 identical inserts at same timestamp, different positions is detected", () => {
    const ts = new Date("2026-01-01T12:00:00Z");
    const ops = [
      makeOp({ type: "insert", text: "foo", startIndex: 10, changelogIndex: 1, timestamp: ts }),
      makeOp({ type: "insert", text: "foo", startIndex: 50, changelogIndex: 2, timestamp: ts }),
      makeOp({ type: "insert", text: "foo", startIndex: 90, changelogIndex: 3, timestamp: ts }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.findReplaceCount).toBe(1);
    const fr = result.behaviors.find((b) => b.type === "find_replace");
    expect(fr).toBeDefined();
    expect(fr!.detail.replacementText).toBe("foo");
    expect(fr!.detail.replacementCount).toBe(3);
    expect(fr!.detail.positions).toEqual([10, 50, 90]);
  });

  it("15. 2 identical inserts is not detected (need 3+)", () => {
    const ts = new Date("2026-01-01T12:00:00Z");
    const ops = [
      makeOp({ type: "insert", text: "foo", startIndex: 10, changelogIndex: 1, timestamp: ts }),
      makeOp({ type: "insert", text: "foo", startIndex: 50, changelogIndex: 2, timestamp: ts }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.findReplaceCount).toBe(0);
  });

  it("16. 3 inserts with different text is not detected", () => {
    const ts = new Date("2026-01-01T12:00:00Z");
    const ops = [
      makeOp({ type: "insert", text: "foo", startIndex: 10, changelogIndex: 1, timestamp: ts }),
      makeOp({ type: "insert", text: "bar", startIndex: 50, changelogIndex: 2, timestamp: ts }),
      makeOp({ type: "insert", text: "baz", startIndex: 90, changelogIndex: 3, timestamp: ts }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.findReplaceCount).toBe(0);
  });

  it("17. 3 identical inserts at different timestamps is not detected", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "foo",
        startIndex: 10,
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "insert",
        text: "foo",
        startIndex: 50,
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:01Z"),
      }),
      makeOp({
        type: "insert",
        text: "foo",
        startIndex: 90,
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:00:02Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.findReplaceCount).toBe(0);
  });

  it("find_replace with 5 identical inserts captures all positions", () => {
    const ts = new Date("2026-01-01T12:00:00Z");
    const ops = [
      makeOp({ type: "insert", text: "word", startIndex: 10, changelogIndex: 1, timestamp: ts }),
      makeOp({ type: "insert", text: "word", startIndex: 30, changelogIndex: 2, timestamp: ts }),
      makeOp({ type: "insert", text: "word", startIndex: 50, changelogIndex: 3, timestamp: ts }),
      makeOp({ type: "insert", text: "word", startIndex: 70, changelogIndex: 4, timestamp: ts }),
      makeOp({ type: "insert", text: "word", startIndex: 90, changelogIndex: 5, timestamp: ts }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.findReplaceCount).toBe(1);
    const fr = result.behaviors.find((b) => b.type === "find_replace");
    expect(fr!.detail.replacementCount).toBe(5);
  });

  it("operations that are not inserts are ignored", () => {
    const ts = new Date("2026-01-01T12:00:00Z");
    const ops = [
      makeOp({ type: "delete", text: "foo", startIndex: 10, changelogIndex: 1, timestamp: ts }),
      makeOp({ type: "delete", text: "foo", startIndex: 50, changelogIndex: 2, timestamp: ts }),
      makeOp({ type: "delete", text: "foo", startIndex: 90, changelogIndex: 3, timestamp: ts }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.findReplaceCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectStructuring
// ---------------------------------------------------------------------------

describe("detectStructuring", () => {
  it("18. 3 heading changes within 5 minutes is detected", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: { ps_hd: 1 },
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 2 },
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:01:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 3 },
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:02:00Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.structuringBursts).toBe(1);
    const struc = result.behaviors.find((b) => b.type === "structuring");
    expect(struc).toBeDefined();
    expect(struc!.detail.headingChanges).toBe(3);
  });

  it("19. 2 heading changes is not detected", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: { ps_hd: 1 },
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 2 },
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:01:00Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.structuringBursts).toBe(0);
  });

  it("20. 3 heading changes spread over 10 minutes is not detected", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: { ps_hd: 1 },
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 2 },
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:04:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 3 },
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:10:00Z"), // >5 min from first
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.structuringBursts).toBe(0);
  });

  it("21. heading levels are captured correctly", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: { ps_hd: 1 },
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 3 },
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:30Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 2 },
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:01:00Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    const struc = result.behaviors.find((b) => b.type === "structuring");
    expect(struc!.detail.headingLevels).toEqual([1, 3, 2]);
  });

  it("format without ps_hd in styleModification is not a heading change", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: { ts_bd: true },
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ts_it: true },
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:30Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ts_un: true },
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:01:00Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.structuringBursts).toBe(0);
  });

  it("sliding window avoids double-counting overlapping bursts", () => {
    // 5 heading changes in quick succession — should be 1 burst, not 3
    const ops = [];
    for (let i = 0; i < 5; i++) {
      ops.push(
        makeOp({
          type: "format",
          styleModification: { ps_hd: i + 1 },
          changelogIndex: i + 1,
          timestamp: new Date(`2026-01-01T12:0${i}:00Z`),
        }),
      );
    }
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.structuringBursts).toBe(1);
    const struc = result.behaviors.find((b) => b.type === "structuring");
    expect(struc!.detail.headingChanges).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// detectBulkFormatting
// ---------------------------------------------------------------------------

describe("detectBulkFormatting", () => {
  it("22. format spanning 500+ chars is detected", () => {
    const ops = [
      makeOp({
        type: "format",
        startIndex: 1,
        endIndex: 501,
        styleType: "text",
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.bulkFormatCount).toBe(1);
    const bf = result.behaviors.find((b) => b.type === "bulk_format");
    expect(bf).toBeDefined();
    expect(bf!.detail.range).toBe(500);
    expect(bf!.detail.styleType).toBe("text");
  });

  it("23. format spanning 100 chars is not detected", () => {
    const ops = [
      makeOp({
        type: "format",
        startIndex: 1,
        endIndex: 101,
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.bulkFormatCount).toBe(0);
  });

  it("24. missing startIndex means not detected", () => {
    const ops = [
      makeOp({
        type: "format",
        endIndex: 600,
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.bulkFormatCount).toBe(0);
  });

  it("missing endIndex means not detected", () => {
    const ops = [
      makeOp({
        type: "format",
        startIndex: 1,
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.bulkFormatCount).toBe(0);
  });

  it("exactly 500 chars is detected (threshold is >= 500)", () => {
    const ops = [
      makeOp({
        type: "format",
        startIndex: 1,
        endIndex: 501, // 501 - 1 = 500
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.bulkFormatCount).toBe(1);
  });

  it("499 chars is not detected", () => {
    const ops = [
      makeOp({
        type: "format",
        startIndex: 1,
        endIndex: 500, // 500 - 1 = 499
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.bulkFormatCount).toBe(0);
  });

  it("non-format type is ignored even with large range", () => {
    const ops = [
      makeOp({
        type: "insert",
        startIndex: 1,
        endIndex: 1000,
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.bulkFormatCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectLinkInsertions
// ---------------------------------------------------------------------------

describe("detectLinkInsertions", () => {
  it("25. format with lnks_link containing URL is detected, URL extracted", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: {
          lnks_link: { ulnk_url: "https://example.com", lnk_type: 1 },
        },
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.linksInserted).toBe(1);
    const link = result.behaviors.find((b) => b.type === "link_insertion");
    expect(link).toBeDefined();
    expect(link!.detail.url).toBe("https://example.com");
    expect(link!.detail.linkType).toBe(1);
  });

  it("26. format with lnks_link without ulnk_url has url='unknown'", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: {
          lnks_link: { lnk_type: 2 },
        },
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.linksInserted).toBe(1);
    const link = result.behaviors.find((b) => b.type === "link_insertion");
    expect(link!.detail.url).toBe("unknown");
  });

  it("27. format without lnks_link is not detected", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: { ts_bd: true },
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.linksInserted).toBe(0);
  });

  it("format without styleModification is not detected", () => {
    const ops = [makeOp({ type: "format", changelogIndex: 1 })];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.linksInserted).toBe(0);
  });

  it("non-format type with lnks_link in styleModification is ignored", () => {
    const ops = [
      makeOp({
        type: "insert",
        styleModification: {
          lnks_link: { ulnk_url: "https://example.com" },
        },
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.linksInserted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeSessionPatterns
// ---------------------------------------------------------------------------

describe("analyzeSessionPatterns", () => {
  it("28. single user, continuous typing — 1 session", () => {
    const ops: ChangelogOperation[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(
        makeOp({
          type: "insert",
          text: "a",
          changelogIndex: i + 1,
          timestamp: new Date(`2026-01-01T12:00:${String(i).padStart(2, "0")}Z`),
          userId: "user1",
        }),
      );
    }
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userId).toBe("user1");
    expect(sessions[0].charsInserted).toBe(9); // first op is session start, chars counted from i=1
  });

  it("29. single user, 10-minute gap — 2 sessions", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "a",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "b",
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:01Z"),
        userId: "user1",
      }),
      // 10-minute gap
      makeOp({
        type: "insert",
        text: "c",
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:10:01Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "d",
        changelogIndex: 4,
        timestamp: new Date("2026-01-01T12:10:02Z"),
        userId: "user1",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].sessionStart).toEqual(new Date("2026-01-01T12:00:00Z"));
    expect(sessions[0].sessionEnd).toEqual(new Date("2026-01-01T12:00:01Z"));
    expect(sessions[1].sessionStart).toEqual(new Date("2026-01-01T12:10:01Z"));
    expect(sessions[1].sessionEnd).toEqual(new Date("2026-01-01T12:10:02Z"));
  });

  it("30. typing speed calculation returns correct CPM", () => {
    // 60 inserts of 1 char each, 1 second apart = 60 chars in 59 seconds of active time
    const ops: ChangelogOperation[] = [];
    for (let i = 0; i < 60; i++) {
      ops.push(
        makeOp({
          type: "insert",
          text: "a",
          changelogIndex: i + 1,
          timestamp: new Date(new Date("2026-01-01T12:00:00Z").getTime() + i * 1000),
          userId: "user1",
        }),
      );
    }
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(1);
    // 59 chars inserted (first op is session start, not counted)
    // activeTimeMs = 59 * 1000 = 59000ms (each 1s gap is < 2000ms so counts as active)
    // CPM = 59 / (59000 / 60000) = 59 / 0.9833... = ~60
    expect(sessions[0].avgTypingSpeedCpm).toBe(60);
  });

  it("31. single operation returns no sessions (need 2+)", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "a",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(0);
  });

  it("32. thinking pauses (5s gaps) counted", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "a",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "b",
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:01Z"),
        userId: "user1",
      }),
      // 6-second gap (thinking pause, >= 5s)
      makeOp({
        type: "insert",
        text: "c",
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:00:07Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "d",
        changelogIndex: 4,
        timestamp: new Date("2026-01-01T12:00:08Z"),
        userId: "user1",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].thinkingPauses).toBe(1);
  });

  it("33. empty operations array returns empty sessions", () => {
    const sessions = analyzeSessionPatterns([]);
    expect(sessions).toHaveLength(0);
  });

  it("operations with no userId are skipped", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "a",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(0);
  });

  it("delete operations contribute to charsDeleted", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "hello",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
        startIndex: 1,
      }),
      makeOp({
        type: "delete",
        startIndex: 1,
        endIndex: 5,
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:01Z"),
        userId: "user1",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(1);
    // delete_suggestion also counted, so let's just check delete
    expect(sessions[0].charsDeleted).toBe(5); // endIndex - startIndex + 1 = 5
  });

  it("multiple users produce separate sessions", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "a",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "b",
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:01Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "c",
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user2",
      }),
      makeOp({
        type: "insert",
        text: "d",
        changelogIndex: 4,
        timestamp: new Date("2026-01-01T12:00:01Z"),
        userId: "user2",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(2);
    const user1Session = sessions.find((s) => s.userId === "user1");
    const user2Session = sessions.find((s) => s.userId === "user2");
    expect(user1Session).toBeDefined();
    expect(user2Session).toBeDefined();
  });

  it("typing bursts are counted when gap < 2s", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "a",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "b",
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:01Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "c",
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:00:01.500Z"),
        userId: "user1",
      }),
      // thinking pause
      makeOp({
        type: "insert",
        text: "d",
        changelogIndex: 4,
        timestamp: new Date("2026-01-01T12:00:07Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "e",
        changelogIndex: 5,
        timestamp: new Date("2026-01-01T12:00:08Z"),
        userId: "user1",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(1);
    // burst1: ops 1-3 (gap < 2s), ends at thinking pause -> typingBursts++
    // burst2: ops 4-5 (gap < 2s), ends at session end -> typingBursts++
    expect(sessions[0].typingBursts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// analyzeCollaboration
// ---------------------------------------------------------------------------

describe("analyzeCollaboration", () => {
  it("34. single user returns null", () => {
    const ops = [
      makeOp({ userId: "user1", changelogIndex: 1, timestamp: new Date("2026-01-01T12:00:00Z") }),
      makeOp({ userId: "user1", changelogIndex: 2, timestamp: new Date("2026-01-01T12:00:01Z") }),
    ];
    const result = analyzeCollaboration(ops);
    expect(result).toBeNull();
  });

  it("35. two users with overlapping timestamps — concurrent=true", () => {
    const ops = [
      makeOp({
        userId: "user1",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        userId: "user2",
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:30Z"),
      }),
      makeOp({
        userId: "user1",
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:01:00Z"),
      }),
      makeOp({
        userId: "user2",
        changelogIndex: 4,
        timestamp: new Date("2026-01-01T12:01:30Z"),
      }),
      makeOp({
        userId: "user1",
        changelogIndex: 5,
        timestamp: new Date("2026-01-01T12:02:00Z"),
      }),
      makeOp({
        userId: "user2",
        changelogIndex: 6,
        timestamp: new Date("2026-01-01T12:02:30Z"),
      }),
    ];
    const result = analyzeCollaboration(ops);
    expect(result).not.toBeNull();
    // user1: 12:00:00 - 12:02:00, user2: 12:00:30 - 12:02:30
    // overlap: max(00,30) to min(120,150) = 30s to 120s = 90s = 90000ms > 60000ms
    // interleaveRatio: all 5 transitions are alternating = 5/5 = 1.0 > 0.1
    expect(result!.concurrent).toBe(true);
    expect(result!.interleaveRatio).toBe(1.0);
    expect(result!.overlapMs).toBe(90000);
  });

  it("36. two users with no overlap — concurrent=false", () => {
    const ops = [
      makeOp({
        userId: "user1",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        userId: "user1",
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:01:00Z"),
      }),
      // user2 starts well after user1 finishes (no overlap)
      makeOp({
        userId: "user2",
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T13:00:00Z"),
      }),
      makeOp({
        userId: "user2",
        changelogIndex: 4,
        timestamp: new Date("2026-01-01T13:01:00Z"),
      }),
    ];
    const result = analyzeCollaboration(ops);
    expect(result).not.toBeNull();
    // No overlap: user1 12:00-12:01, user2 13:00-13:01
    expect(result!.overlapMs).toBe(0);
    expect(result!.concurrent).toBe(false);
  });

  it("37. interleave ratio for alternating operations is close to 1.0", () => {
    const ops = [
      makeOp({ userId: "user1", changelogIndex: 1, timestamp: new Date("2026-01-01T12:00:00Z") }),
      makeOp({ userId: "user2", changelogIndex: 2, timestamp: new Date("2026-01-01T12:00:01Z") }),
      makeOp({ userId: "user1", changelogIndex: 3, timestamp: new Date("2026-01-01T12:00:02Z") }),
      makeOp({ userId: "user2", changelogIndex: 4, timestamp: new Date("2026-01-01T12:00:03Z") }),
    ];
    const result = analyzeCollaboration(ops);
    expect(result).not.toBeNull();
    // 3 transitions out of 3 possible = 1.0
    expect(result!.interleaveRatio).toBe(1.0);
  });

  it("interleave ratio for sequential same-user operations is 1/(n-1)", () => {
    const ops = [
      makeOp({ userId: "user1", changelogIndex: 1, timestamp: new Date("2026-01-01T12:00:00Z") }),
      makeOp({ userId: "user1", changelogIndex: 2, timestamp: new Date("2026-01-01T12:00:01Z") }),
      makeOp({ userId: "user1", changelogIndex: 3, timestamp: new Date("2026-01-01T12:00:02Z") }),
      makeOp({ userId: "user2", changelogIndex: 4, timestamp: new Date("2026-01-01T12:00:03Z") }),
    ];
    const result = analyzeCollaboration(ops);
    expect(result).not.toBeNull();
    // 1 alternation out of 3 = 0.333...
    expect(result!.interleaveRatio).toBeCloseTo(1 / 3, 5);
  });

  it("38. three users — all pairs checked for overlap", () => {
    const ops = [
      // All three users active at the same time
      makeOp({ userId: "user1", changelogIndex: 1, timestamp: new Date("2026-01-01T12:00:00Z") }),
      makeOp({ userId: "user2", changelogIndex: 2, timestamp: new Date("2026-01-01T12:00:30Z") }),
      makeOp({ userId: "user3", changelogIndex: 3, timestamp: new Date("2026-01-01T12:01:00Z") }),
      makeOp({ userId: "user1", changelogIndex: 4, timestamp: new Date("2026-01-01T12:02:00Z") }),
      makeOp({ userId: "user2", changelogIndex: 5, timestamp: new Date("2026-01-01T12:02:30Z") }),
      makeOp({ userId: "user3", changelogIndex: 6, timestamp: new Date("2026-01-01T12:03:00Z") }),
    ];
    const result = analyzeCollaboration(ops);
    expect(result).not.toBeNull();
    expect(result!.users).toHaveLength(3);
    // user1: 12:00:00 - 12:02:00
    // user2: 12:00:30 - 12:02:30
    // user3: 12:01:00 - 12:03:00
    // Pair (1,2): overlap = max(0,30) to min(120,150) = 30 to 120 = 90s
    // Pair (1,3): overlap = max(0,60) to min(120,180) = 60 to 120 = 60s
    // Pair (2,3): overlap = max(30,60) to min(150,180) = 60 to 150 = 90s
    // Total overlap = 90000 + 60000 + 90000 = 240000ms
    expect(result!.overlapMs).toBe(240000);
    expect(result!.concurrent).toBe(true);
  });

  it("operations with empty userId are filtered out", () => {
    const ops = [
      makeOp({ userId: "", changelogIndex: 1, timestamp: new Date("2026-01-01T12:00:00Z") }),
      makeOp({ userId: "user1", changelogIndex: 2, timestamp: new Date("2026-01-01T12:00:01Z") }),
    ];
    const result = analyzeCollaboration(ops);
    // Only 1 user after filtering empty userId
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectBehaviors (integration)
// ---------------------------------------------------------------------------

describe("detectBehaviors (integration)", () => {
  it("39. mixed changelog with pastes, undos, and formatting — all detected", () => {
    const ops = [
      // Paste (50 chars)
      makeOp({
        type: "insert",
        text: "a".repeat(50),
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
      // Undo pair
      makeOp({
        type: "insert",
        text: "hello",
        startIndex: 10,
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:05Z"),
        userId: "user1",
      }),
      makeOp({
        type: "delete",
        startIndex: 10,
        endIndex: 14,
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:00:07Z"),
        userId: "user1",
      }),
      // Bulk format
      makeOp({
        type: "format",
        startIndex: 1,
        endIndex: 600,
        styleType: "text",
        changelogIndex: 4,
        timestamp: new Date("2026-01-01T12:00:10Z"),
        userId: "user1",
      }),
      // Link insertion
      makeOp({
        type: "format",
        styleModification: {
          lnks_link: { ulnk_url: "https://example.com", lnk_type: 1 },
        },
        changelogIndex: 5,
        timestamp: new Date("2026-01-01T12:00:15Z"),
        userId: "user1",
      }),
    ];

    const result = detectBehaviors(makeChangelog(ops));

    expect(result.pasteCount).toBe(1);
    expect(result.pasteCharCount).toBe(50);
    expect(result.undoCount).toBe(1);
    expect(result.bulkFormatCount).toBe(1);
    expect(result.linksInserted).toBe(1);
    expect(result.behaviors).toHaveLength(4); // paste + undo + bulk_format + link
  });

  it("40. empty changelog returns empty summary", () => {
    const result = detectBehaviors(makeChangelog([]));

    expect(result.pasteCount).toBe(0);
    expect(result.pasteCharCount).toBe(0);
    expect(result.undoCount).toBe(0);
    expect(result.findReplaceCount).toBe(0);
    expect(result.structuringBursts).toBe(0);
    expect(result.bulkFormatCount).toBe(0);
    expect(result.linksInserted).toBe(0);
    expect(result.sessions).toHaveLength(0);
    expect(result.collaboration).toBeNull();
    expect(result.behaviors).toHaveLength(0);
  });

  it("all behavior types can coexist in one summary", () => {
    const ts = new Date("2026-01-01T12:00:00Z");
    const ops = [
      // Paste
      makeOp({ type: "insert", text: "a".repeat(50), changelogIndex: 1, timestamp: ts, userId: "user1" }),
      // Find & Replace (3 identical inserts at same ts)
      makeOp({ type: "insert", text: "replaced", startIndex: 100, changelogIndex: 2, timestamp: ts, userId: "user1" }),
      makeOp({ type: "insert", text: "replaced", startIndex: 200, changelogIndex: 3, timestamp: ts, userId: "user1" }),
      makeOp({ type: "insert", text: "replaced", startIndex: 300, changelogIndex: 4, timestamp: ts, userId: "user1" }),
      // Structuring (3 heading changes)
      makeOp({ type: "format", styleModification: { ps_hd: 1 }, changelogIndex: 5, timestamp: new Date("2026-01-01T12:01:00Z"), userId: "user1" }),
      makeOp({ type: "format", styleModification: { ps_hd: 2 }, changelogIndex: 6, timestamp: new Date("2026-01-01T12:02:00Z"), userId: "user1" }),
      makeOp({ type: "format", styleModification: { ps_hd: 3 }, changelogIndex: 7, timestamp: new Date("2026-01-01T12:03:00Z"), userId: "user1" }),
      // Bulk format
      makeOp({ type: "format", startIndex: 1, endIndex: 600, changelogIndex: 8, timestamp: new Date("2026-01-01T12:03:30Z"), userId: "user1" }),
      // Link insertion
      makeOp({ type: "format", styleModification: { lnks_link: { ulnk_url: "https://x.com" } }, changelogIndex: 9, timestamp: new Date("2026-01-01T12:04:00Z"), userId: "user1" }),
    ];

    const result = detectBehaviors(makeChangelog(ops));
    expect(result.pasteCount).toBe(1);
    expect(result.findReplaceCount).toBe(1);
    expect(result.structuringBursts).toBe(1);
    expect(result.bulkFormatCount).toBe(1);
    expect(result.linksInserted).toBe(1);
  });

  it("behaviors carry correct userId and timestamp", () => {
    const ts = new Date("2026-01-01T15:30:00Z");
    const ops = [
      makeOp({
        type: "insert",
        text: "a".repeat(40),
        changelogIndex: 1,
        timestamp: ts,
        userId: "specific-user",
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    const paste = result.behaviors[0];
    expect(paste.userId).toBe("specific-user");
    expect(paste.timestamp).toEqual(ts);
  });

  it("behaviors carry tabId when present", () => {
    const ops = [
      makeOp({
        type: "insert",
        text: "a".repeat(40),
        changelogIndex: 1,
        tabId: "t.test123",
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    const paste = result.behaviors[0];
    expect(paste.tabId).toBe("t.test123");
  });
});

// ---------------------------------------------------------------------------
// Edge cases and bug verification
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("BUG: session avgTypingSpeedCpm handles zero activeTimeMs in mid-session emit", () => {
    // When a session break occurs right after the first op of a session,
    // activeTimeMs can be 0 while totalMs > 0.
    // The code at line 420 checks totalMs > 0 but divides by activeTimeMs.
    // This can produce Infinity.
    const ops = [
      makeOp({
        type: "insert",
        text: "a",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
      // Thinking pause (>5s), not a session break
      makeOp({
        type: "insert",
        text: "b",
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:06Z"),
        userId: "user1",
      }),
      // Session break (>5 min gap)
      makeOp({
        type: "insert",
        text: "c",
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:10:00Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "d",
        changelogIndex: 4,
        timestamp: new Date("2026-01-01T12:10:01Z"),
        userId: "user1",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    // Verify no session has Infinity or NaN for avgTypingSpeedCpm
    for (const session of sessions) {
      expect(Number.isFinite(session.avgTypingSpeedCpm)).toBe(true);
      expect(Number.isNaN(session.avgTypingSpeedCpm)).toBe(false);
    }
  });

  it("session with only thinking pauses (>5s gaps) has 0 activeTimeMs", () => {
    // Two ops with a 6-second gap (thinking pause, not session break)
    // activeTimeMs stays 0 because gap >= THINKING_PAUSE_MS
    const ops = [
      makeOp({
        type: "insert",
        text: "a",
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        userId: "user1",
      }),
      makeOp({
        type: "insert",
        text: "b",
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:00:06Z"),
        userId: "user1",
      }),
    ];
    const sessions = analyzeSessionPatterns(ops);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].activeTimeMs).toBe(0);
    // avgTypingSpeedCpm should be 0 (guarded by activeTimeMs > 0 in final emit)
    expect(sessions[0].avgTypingSpeedCpm).toBe(0);
  });

  it("collaboration with ops lacking userId are filtered", () => {
    const ops = [
      makeOp({ userId: "", changelogIndex: 1, timestamp: new Date("2026-01-01T12:00:00Z") }),
      makeOp({ userId: "", changelogIndex: 2, timestamp: new Date("2026-01-01T12:00:01Z") }),
    ];
    const result = analyzeCollaboration(ops);
    expect(result).toBeNull();
  });

  it("concurrent requires both interleaveRatio > 0.1 AND overlapMs > 60000", () => {
    // High interleave but tiny overlap (<60s)
    const ops = [
      makeOp({ userId: "user1", changelogIndex: 1, timestamp: new Date("2026-01-01T12:00:00Z") }),
      makeOp({ userId: "user2", changelogIndex: 2, timestamp: new Date("2026-01-01T12:00:01Z") }),
      makeOp({ userId: "user1", changelogIndex: 3, timestamp: new Date("2026-01-01T12:00:02Z") }),
      makeOp({ userId: "user2", changelogIndex: 4, timestamp: new Date("2026-01-01T12:00:03Z") }),
    ];
    const result = analyzeCollaboration(ops);
    expect(result).not.toBeNull();
    // interleaveRatio = 1.0, but overlapMs = 2000 (3s - 1s overlap) < 60000
    expect(result!.interleaveRatio).toBe(1.0);
    expect(result!.overlapMs).toBeLessThan(60000);
    expect(result!.concurrent).toBe(false);
  });

  it("undo detection uses ring buffer of 50 — old inserts evicted", () => {
    const ops: ChangelogOperation[] = [];
    const baseTime = new Date("2026-01-01T12:00:00Z").getTime();

    // First insert
    ops.push(
      makeOp({
        type: "insert",
        text: "X",
        startIndex: 1,
        changelogIndex: 1,
        timestamp: new Date(baseTime),
      }),
    );

    // 50 more inserts (total 51 in ring buffer, first should be evicted)
    for (let i = 1; i <= 50; i++) {
      ops.push(
        makeOp({
          type: "insert",
          text: "y",
          startIndex: 1000 + i,
          changelogIndex: i + 1,
          timestamp: new Date(baseTime + i * 100), // 100ms apart
        }),
      );
    }

    // Delete matching the first insert — should NOT match because it was evicted
    ops.push(
      makeOp({
        type: "delete",
        startIndex: 1,
        endIndex: 1,
        changelogIndex: 52,
        timestamp: new Date(baseTime + 4000), // within 5s of first insert
      }),
    );

    const result = detectBehaviors(makeChangelog(ops));
    expect(result.undoCount).toBe(0);
  });

  it("find_replace with mixed types: only insert operations counted", () => {
    const ts = new Date("2026-01-01T12:00:00Z");
    const ops = [
      makeOp({ type: "insert", text: "foo", changelogIndex: 1, timestamp: ts }),
      makeOp({ type: "insert", text: "foo", changelogIndex: 2, timestamp: ts }),
      makeOp({ type: "format", text: "foo" as any, changelogIndex: 3, timestamp: ts }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    // Only 2 inserts with text "foo", not enough for find_replace
    expect(result.findReplaceCount).toBe(0);
  });

  it("structuring: ps_hd value of 0 is still a number and counted", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: { ps_hd: 0 }, // "Normal text" heading level
        changelogIndex: 1,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 1 },
        changelogIndex: 2,
        timestamp: new Date("2026-01-01T12:01:00Z"),
      }),
      makeOp({
        type: "format",
        styleModification: { ps_hd: 2 },
        changelogIndex: 3,
        timestamp: new Date("2026-01-01T12:02:00Z"),
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    expect(result.structuringBursts).toBe(1);
    const struc = result.behaviors.find((b) => b.type === "structuring");
    expect(struc!.detail.headingLevels).toEqual([0, 1, 2]);
  });

  it("link insertion captures linkType even when url is present", () => {
    const ops = [
      makeOp({
        type: "format",
        styleModification: {
          lnks_link: { ulnk_url: "https://docs.google.com/doc/123", lnk_type: 3 },
        },
        changelogIndex: 1,
      }),
    ];
    const result = detectBehaviors(makeChangelog(ops));
    const link = result.behaviors.find((b) => b.type === "link_insertion");
    expect(link!.detail.linkType).toBe(3);
  });
});
