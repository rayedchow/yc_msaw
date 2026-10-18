/**
 * Exhaustive unit tests for the Google Docs suggestion lifecycle tracker.
 *
 * Tests trackSuggestions, describeSuggestion, summarizeSuggestions with
 * every combination of suggestion creation, modification, acceptance,
 * rejection, formatting, and edge cases.
 *
 * No live API requests — all tests use mock DocChangelog objects.
 */

import { describe, it, expect } from "vitest";
import {
  trackSuggestions,
  describeSuggestion,
  summarizeSuggestions,
  type SuggestionLifecycle,
  type SuggestionSummary,
} from "../../src/polling/_archived-gdocs/gdocs-suggestion-tracker.js";
import type {
  ChangelogOperation,
  DocChangelog,
} from "../../src/polling/_archived-gdocs/gdocs-revisions-load.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let opCounter = 0;

/** Create a ChangelogOperation with sensible defaults. */
function makeOp(
  overrides: Partial<ChangelogOperation> & { type: ChangelogOperation["type"] },
): ChangelogOperation {
  opCounter++;
  return {
    userId: "user-author",
    timestamp: new Date("2025-01-15T10:00:00Z"),
    revisionId: 1,
    sessionId: "sess1",
    changelogIndex: opCounter,
    ...overrides,
  };
}

/** Create a minimal DocChangelog from a list of operations. */
function makeChangelog(operations: ChangelogOperation[]): DocChangelog {
  return {
    fileId: "test-doc",
    totalRevisions: operations.length,
    userMap: new Map(),
    operations,
    tabs: [],
  };
}

/** Reset the operation counter between describe blocks. */
function resetCounter() {
  opCounter = 0;
}

// ===========================================================================
// 1. trackSuggestions
// ===========================================================================

describe("trackSuggestions", () => {
  // -----------------------------------------------------------------------
  // Basic cases
  // -----------------------------------------------------------------------

  describe("basic cases", () => {
    it("1. empty changelog returns 0 suggestions", () => {
      resetCounter();
      const summary = trackSuggestions(makeChangelog([]));
      expect(summary.total).toBe(0);
      expect(summary.pending).toBe(0);
      expect(summary.accepted).toBe(0);
      expect(summary.rejected).toBe(0);
      expect(summary.modified).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(summary.suggestions).toHaveLength(0);
    });

    it("2. single insert suggestion -> 1 pending", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.001",
          text: "hello world",
          startIndex: 10,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.pending).toBe(1);
      expect(summary.suggestions[0].sugId).toBe("sug.001");
      expect(summary.suggestions[0].status).toBe("pending");
      expect(summary.suggestions[0].originalText).toBe("hello world");
      expect(summary.suggestions[0].currentText).toBe("hello world");
      expect(summary.suggestions[0].position).toBe(10);
      expect(summary.suggestions[0].authorUserId).toBe("user-author");
      expect(summary.suggestions[0].modificationCount).toBe(0);
    });

    it("3. single delete suggestion -> 1 pending", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "delete_suggestion",
          sugId: "sug.002",
          startIndex: 5,
          endIndex: 15,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.pending).toBe(1);
      expect(summary.suggestions[0].sugId).toBe("sug.002");
      expect(summary.suggestions[0].deleteRange).toEqual({ startIndex: 5, endIndex: 15 });
      expect(summary.suggestions[0].position).toBe(5);
      expect(summary.suggestions[0].originalText).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Acceptance detection
  // -----------------------------------------------------------------------

  describe("acceptance detection", () => {
    it("4. insert suggestion + acceptance (is at same position, later timestamp) -> 1 accepted", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.003",
          text: "accepted text",
          startIndex: 20,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert",
          text: "accepted text",
          startIndex: 20,
          userId: "user-accepter",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.accepted).toBe(1);
      expect(summary.suggestions[0].status).toBe("accepted");
      expect(summary.suggestions[0].resolvedByUserId).toBe("user-accepter");
      expect(summary.suggestions[0].resolvedAt).toEqual(new Date("2025-01-15T11:00:00Z"));
    });

    it("16. is/ds at same position but BEFORE the suggestion (wrong temporal order) -> not acceptance", () => {
      resetCounter();
      const ops = [
        // An insert at position 20 happens BEFORE the suggestion is created
        makeOp({
          type: "insert",
          text: "earlier insert",
          startIndex: 20,
          userId: "user-other",
          timestamp: new Date("2025-01-15T09:00:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.016",
          text: "my suggestion",
          startIndex: 20,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      // The earlier insert should NOT be treated as acceptance
      expect(summary.suggestions[0].status).toBe("pending");
    });

    it("delete suggestion acceptance via ds at same position", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "delete_suggestion",
          sugId: "sug.del-accept",
          startIndex: 30,
          endIndex: 40,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "delete",
          startIndex: 30,
          endIndex: 40,
          userId: "user-accepter",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.accepted).toBe(1);
      expect(summary.suggestions[0].status).toBe("accepted");
      expect(summary.suggestions[0].resolvedByUserId).toBe("user-accepter");
    });
  });

  // -----------------------------------------------------------------------
  // Rejection detection
  // -----------------------------------------------------------------------

  describe("rejection detection", () => {
    it("5. insert suggestion + rejection (usfd with same sugId) -> 1 rejected", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.004",
          text: "rejected text",
          startIndex: 25,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "unmark_deletion",
          sugId: "sug.004",
          startIndex: 25,
          endIndex: 37,
          userId: "user-rejecter",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.rejected).toBe(1);
      expect(summary.suggestions[0].status).toBe("rejected");
      expect(summary.suggestions[0].resolvedByUserId).toBe("user-rejecter");
      expect(summary.suggestions[0].resolvedAt).toEqual(new Date("2025-01-15T11:00:00Z"));
    });

    it("6. insert suggestion + rejection via ras -> 1 rejected", () => {
      resetCounter();
      // ras is parsed as unmark_deletion in gdocs-revisions-load.ts
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.005",
          text: "ras-rejected",
          startIndex: 30,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        // ras maps to unmark_deletion with sugId
        makeOp({
          type: "unmark_deletion",
          sugId: "sug.005",
          startIndex: 30,
          endIndex: 42,
          userId: "user-ras-rejecter",
          timestamp: new Date("2025-01-15T12:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.rejected).toBe(1);
      expect(summary.suggestions[0].status).toBe("rejected");
      expect(summary.suggestions[0].resolvedByUserId).toBe("user-ras-rejecter");
    });
  });

  // -----------------------------------------------------------------------
  // Modification tracking
  // -----------------------------------------------------------------------

  describe("modification tracking", () => {
    it("7. suggestion modified once (2 iss with same sugId) -> modificationCount=1, status=modified", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.006",
          text: "original",
          startIndex: 10,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.006",
          text: "updated",
          startIndex: 10,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.suggestions[0].modificationCount).toBe(1);
      expect(summary.suggestions[0].status).toBe("modified");
      expect(summary.suggestions[0].originalText).toBe("original");
      expect(summary.suggestions[0].currentText).toBe("updated");
      expect(summary.suggestions[0].lastModifiedAt).toEqual(new Date("2025-01-15T10:30:00Z"));
    });

    it("8. suggestion modified 3 times then accepted -> modificationCount=3, status=accepted", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.007",
          text: "v1",
          startIndex: 5,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.007",
          text: "v2",
          startIndex: 5,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:10:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.007",
          text: "v3",
          startIndex: 5,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:20:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.007",
          text: "v4",
          startIndex: 5,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
        // Acceptance
        makeOp({
          type: "insert",
          text: "v4",
          startIndex: 5,
          userId: "user-accepter",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.suggestions[0].modificationCount).toBe(3);
      expect(summary.suggestions[0].status).toBe("accepted");
      expect(summary.suggestions[0].originalText).toBe("v1");
      expect(summary.suggestions[0].currentText).toBe("v4");
    });

    it("delete suggestion modification updates range", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "delete_suggestion",
          sugId: "sug.del-mod",
          startIndex: 10,
          endIndex: 20,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "delete_suggestion",
          sugId: "sug.del-mod",
          startIndex: 10,
          endIndex: 25,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.suggestions[0].modificationCount).toBe(1);
      expect(summary.suggestions[0].status).toBe("modified");
      expect(summary.suggestions[0].deleteRange).toEqual({ startIndex: 10, endIndex: 25 });
    });
  });

  // -----------------------------------------------------------------------
  // Formatting (sas) and mark for deletion (msfd)
  // -----------------------------------------------------------------------

  describe("formatting and mark_deletion", () => {
    it("9. suggestion with formatting change (sas with sugId) -> styleChanges populated", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "format",
          sugId: "sug.008",
          startIndex: 10,
          endIndex: 20,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          styleType: "text",
          styleModification: { ts_bd: true },
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.pending).toBe(1);
      expect(summary.suggestions[0].styleChanges).toEqual({ ts_bd: true });
      expect(summary.suggestions[0].position).toBe(10);
    });

    it("10. mark for deletion (msfd with sugId) -> deleteRange populated", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.009",
          text: "some text",
          startIndex: 5,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "mark_deletion",
          sugId: "sug.009",
          startIndex: 5,
          endIndex: 14,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.suggestions[0].deleteRange).toEqual({ startIndex: 5, endIndex: 14 });
      expect(summary.suggestions[0].originalText).toBe("some text");
    });

    it("mark_deletion on its own creates a lifecycle entry", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "mark_deletion",
          sugId: "sug.msfd-only",
          startIndex: 100,
          endIndex: 120,
          userId: "user-marker",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.suggestions[0].deleteRange).toEqual({ startIndex: 100, endIndex: 120 });
      expect(summary.suggestions[0].position).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple suggestions
  // -----------------------------------------------------------------------

  describe("multiple suggestions", () => {
    it("11. two different suggestions (different sugIds) -> 2 separate lifecycles", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.010a",
          text: "first",
          startIndex: 10,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.010b",
          text: "second",
          startIndex: 50,
          userId: "user-B",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(2);
      expect(summary.pending).toBe(2);
      const sugA = summary.suggestions.find((s) => s.sugId === "sug.010a");
      const sugB = summary.suggestions.find((s) => s.sugId === "sug.010b");
      expect(sugA).toBeDefined();
      expect(sugA!.originalText).toBe("first");
      expect(sugA!.authorUserId).toBe("user-A");
      expect(sugB).toBeDefined();
      expect(sugB!.originalText).toBe("second");
      expect(sugB!.authorUserId).toBe("user-B");
    });

    it("12. two suggestions at same position -> both tracked independently", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.011a",
          text: "alpha",
          startIndex: 20,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.011b",
          text: "beta",
          startIndex: 20,
          userId: "user-B",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(2);
      const sugA = summary.suggestions.find((s) => s.sugId === "sug.011a");
      const sugB = summary.suggestions.find((s) => s.sugId === "sug.011b");
      expect(sugA).toBeDefined();
      expect(sugB).toBeDefined();
      expect(sugA!.originalText).toBe("alpha");
      expect(sugB!.originalText).toBe("beta");
    });

    it("17. multiple suggestions, some accepted, some rejected, some pending -> correct counts", () => {
      resetCounter();
      const ops = [
        // Suggestion A: will be accepted
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.A",
          text: "accepted",
          startIndex: 10,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        // Suggestion B: will be rejected
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.B",
          text: "rejected",
          startIndex: 30,
          userId: "user-B",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        // Suggestion C: stays pending
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.C",
          text: "pending",
          startIndex: 50,
          userId: "user-C",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        // Suggestion D: will be modified (stays as modified)
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.D",
          text: "orig",
          startIndex: 70,
          userId: "user-D",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.D",
          text: "modified",
          startIndex: 70,
          userId: "user-D",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
        // Suggestion E: will be accepted
        makeOp({
          type: "delete_suggestion",
          sugId: "sug.E",
          startIndex: 90,
          endIndex: 100,
          userId: "user-E",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        // Accept A
        makeOp({
          type: "insert",
          text: "accepted",
          startIndex: 10,
          userId: "user-accepter",
          timestamp: new Date("2025-01-15T12:00:00Z"),
        }),
        // Reject B
        makeOp({
          type: "unmark_deletion",
          sugId: "sug.B",
          startIndex: 30,
          endIndex: 37,
          userId: "user-rejecter",
          timestamp: new Date("2025-01-15T12:00:00Z"),
        }),
        // Accept E
        makeOp({
          type: "delete",
          startIndex: 90,
          endIndex: 100,
          userId: "user-accepter",
          timestamp: new Date("2025-01-15T12:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(5);
      expect(summary.accepted).toBe(2); // A and E
      expect(summary.rejected).toBe(1); // B
      expect(summary.pending).toBe(1); // C
      expect(summary.modified).toBe(1); // D
    });
  });

  // -----------------------------------------------------------------------
  // Operations without sugId
  // -----------------------------------------------------------------------

  describe("operations without sugId", () => {
    it("13. operations without sugId are ignored", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert",
          text: "normal insert",
          startIndex: 1,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "delete",
          startIndex: 5,
          endIndex: 10,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:01:00Z"),
        }),
        makeOp({
          type: "format",
          startIndex: 1,
          endIndex: 5,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:02:00Z"),
        }),
        makeOp({
          type: "other",
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:03:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Author and resolver tracking
  // -----------------------------------------------------------------------

  describe("author and resolver tracking", () => {
    it("14. suggestion created by user A, accepted by user B -> authorUserId=A, resolvedByUserId=B", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.014",
          text: "collaborative",
          startIndex: 15,
          userId: "user-creator",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert",
          text: "collaborative",
          startIndex: 15,
          userId: "user-reviewer",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.suggestions[0].authorUserId).toBe("user-creator");
      expect(summary.suggestions[0].resolvedByUserId).toBe("user-reviewer");
    });
  });

  // -----------------------------------------------------------------------
  // Tab tracking
  // -----------------------------------------------------------------------

  describe("tab tracking", () => {
    it("15. tabId is captured from operations", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.015",
          text: "tab-aware",
          startIndex: 5,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          tabId: "t.tab123",
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.suggestions[0].tabId).toBe("t.tab123");
    });

    it("tabId is backfilled from later operation if missing initially", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.tab-backfill",
          text: "first",
          startIndex: 5,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          // No tabId on first op
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.tab-backfill",
          text: "second",
          startIndex: 5,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:30:00Z"),
          tabId: "t.late-tab",
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.suggestions[0].tabId).toBe("t.late-tab");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("suggestion created and immediately rejected in the same entry batch", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.quick-reject",
          text: "flash",
          startIndex: 10,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          changelogIndex: 1,
        }),
        makeOp({
          type: "unmark_deletion",
          sugId: "sug.quick-reject",
          startIndex: 10,
          endIndex: 15,
          userId: "user-B",
          timestamp: new Date("2025-01-15T10:00:01Z"),
          changelogIndex: 2,
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.rejected).toBe(1);
      expect(summary.suggestions[0].status).toBe("rejected");
    });

    it("format suggestion without styleType or styleModification is tracked but styleChanges is undefined", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "format",
          sugId: "sug.empty-format",
          startIndex: 10,
          endIndex: 20,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          // No styleType, no styleModification
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.suggestions[0].styleChanges).toBeUndefined();
    });

    it("only format suggestion with sugId (no iss/dss) creates a lifecycle", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "format",
          sugId: "sug.format-only",
          startIndex: 10,
          endIndex: 20,
          userId: "user-formatter",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          styleType: "text",
          styleModification: { ts_it: true },
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      expect(summary.pending).toBe(1);
      expect(summary.suggestions[0].authorUserId).toBe("user-formatter");
      expect(summary.suggestions[0].styleChanges).toEqual({ ts_it: true });
    });

    it("operations with types like 'insert' or 'delete' that have sugId are processed in Pass 1", () => {
      resetCounter();
      // When a suggestion is accepted, Google emits is/ds with the original sugId
      // These enter the tracker via Pass 1 (they have sugId), and their type is "insert"/"delete"
      // which is not in the switch. They get tracked in operationIndices but do not change lifecycle state.
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.with-is",
          text: "suggestion text",
          startIndex: 10,
          userId: "user-author",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        // An is with sugId (acceptance op that carries the sugId)
        makeOp({
          type: "insert",
          sugId: "sug.with-is",
          text: "suggestion text",
          startIndex: 10,
          userId: "user-accepter",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(1);
      // The is with sugId enters Pass 1 but falls through the switch (no "insert" case).
      // Then Pass 2 detects the same is at position 10 after createdAt, marking as accepted.
      expect(summary.suggestions[0].status).toBe("accepted");
      expect(summary.suggestions[0].operationIndices).toHaveLength(2);
    });

    it("operationIndices tracks all operations for a suggestion", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.indices",
          text: "v1",
          startIndex: 5,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          changelogIndex: 10,
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.indices",
          text: "v2",
          startIndex: 5,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:30:00Z"),
          changelogIndex: 15,
        }),
        makeOp({
          type: "unmark_deletion",
          sugId: "sug.indices",
          startIndex: 5,
          endIndex: 7,
          userId: "user-B",
          timestamp: new Date("2025-01-15T11:00:00Z"),
          changelogIndex: 20,
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.suggestions[0].operationIndices).toEqual([10, 15, 20]);
    });

    it("mark_deletion with missing startIndex/endIndex defaults to 0", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "mark_deletion",
          sugId: "sug.msfd-null",
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          // startIndex and endIndex are undefined
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.suggestions[0].deleteRange).toEqual({ startIndex: 0, endIndex: 0 });
    });

    it("delete_suggestion with missing startIndex/endIndex defaults to 0", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "delete_suggestion",
          sugId: "sug.dss-null",
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
          // startIndex and endIndex are undefined
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.suggestions[0].deleteRange).toEqual({ startIndex: 0, endIndex: 0 });
    });

    it("rejected suggestion is NOT overwritten by acceptance in Pass 2", () => {
      resetCounter();
      // Suggestion is rejected in Pass 1, then there is an unrelated is at same position
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.rej-no-overwrite",
          text: "will be rejected",
          startIndex: 10,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "unmark_deletion",
          sugId: "sug.rej-no-overwrite",
          startIndex: 10,
          endIndex: 26,
          userId: "user-rejecter",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
        // Unrelated insert at same position
        makeOp({
          type: "insert",
          text: "unrelated",
          startIndex: 10,
          userId: "user-other",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      // Pass 2 should skip this because status is "rejected" (not "pending" or "modified")
      expect(summary.suggestions[0].status).toBe("rejected");
    });

    it("createdAt is the timestamp of the first operation with this sugId", () => {
      resetCounter();
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.created-at",
          text: "v1",
          startIndex: 5,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.created-at",
          text: "v2",
          startIndex: 5,
          userId: "user-A",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.suggestions[0].createdAt).toEqual(new Date("2025-01-15T10:00:00Z"));
    });

    it("acceptance only considers is/ds in Pass 2 (not insert_suggestion or delete_suggestion)", () => {
      resetCounter();
      // A second insert_suggestion at the same position should NOT trigger acceptance
      const ops = [
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.no-cross",
          text: "original",
          startIndex: 20,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        // Another insert_suggestion (different sugId) at same position
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.other",
          text: "other",
          startIndex: 20,
          userId: "user-B",
          timestamp: new Date("2025-01-15T11:00:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(2);
      // Neither should be "accepted" — insert_suggestion is not "insert" type
      expect(summary.suggestions[0].status).toBe("pending");
      expect(summary.suggestions[1].status).toBe("pending");
    });
  });

  // -----------------------------------------------------------------------
  // Summary counts
  // -----------------------------------------------------------------------

  describe("summary counts", () => {
    it("summary fields match suggestion statuses exactly", () => {
      resetCounter();
      const ops = [
        // pending
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.p1",
          text: "p1",
          startIndex: 10,
          userId: "user-A",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        // modified
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.m1",
          text: "m1-v1",
          startIndex: 20,
          userId: "user-B",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
        makeOp({
          type: "insert_suggestion",
          sugId: "sug.m1",
          text: "m1-v2",
          startIndex: 20,
          userId: "user-B",
          timestamp: new Date("2025-01-15T10:30:00Z"),
        }),
      ];
      const summary = trackSuggestions(makeChangelog(ops));
      expect(summary.total).toBe(2);
      expect(summary.pending).toBe(1);
      expect(summary.modified).toBe(1);
      expect(summary.accepted).toBe(0);
      expect(summary.rejected).toBe(0);
      expect(summary.deleted).toBe(0);
    });
  });
});

// ===========================================================================
// 2. describeSuggestion
// ===========================================================================

describe("describeSuggestion", () => {
  function makeLifecycle(overrides: Partial<SuggestionLifecycle> = {}): SuggestionLifecycle {
    return {
      sugId: "sug.test",
      status: "pending",
      authorUserId: "user-A",
      createdAt: undefined as unknown as Date,
      modificationCount: 0,
      operationIndices: [1],
      ...overrides,
    };
  }

  it("18. insert suggestion, pending -> 'suggested inserting \"text\", still pending'", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: "hello world",
        currentText: "hello world",
        status: "pending",
      }),
    );
    expect(desc).toBe('suggested inserting "hello world", still pending');
  });

  it("19. delete suggestion, pending -> 'suggested deleting characters X-Y, still pending'", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        deleteRange: { startIndex: 10, endIndex: 25 },
        status: "pending",
      }),
    );
    expect(desc).toBe("suggested deleting characters 10-25, still pending");
  });

  it("20. insert modified then accepted", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: "original",
        currentText: "new version",
        status: "accepted",
        modificationCount: 1,
      }),
    );
    expect(desc).toBe('suggested inserting "original", modified 1x to "new version", accepted');
  });

  it("21. formatting suggestion, pending", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        styleChanges: { ts_bd: true },
        status: "pending",
      }),
    );
    expect(desc).toBe("suggested Text: bold, still pending");
  });

  it("resolves resolvedByUserId to name via context", () => {
    const ctx = {
      userMap: new Map([["user-reviewer", { name: "Alice", anonymous: false }]]),
      tabNames: new Map([["t.intro", "Introduction"]]),
    };
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: "some text",
        status: "accepted",
        resolvedByUserId: "user-reviewer",
        tabId: "t.intro",
      }),
      ctx,
    );
    expect(desc).toContain("accepted by Alice");
    expect(desc).toContain('on tab "Introduction"');
  });

  it("falls back gracefully when context is not provided", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: "text",
        status: "accepted",
        resolvedByUserId: "user-123",
        tabId: "t.abc",
      }),
    );
    expect(desc).toContain("accepted");
    expect(desc).not.toContain("accepted by");
    expect(desc).toContain("on tab t.abc");
  });

  it("22. rejected suggestion", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: "rejected text",
        currentText: "rejected text",
        status: "rejected",
      }),
    );
    expect(desc).toBe('suggested inserting "rejected text", rejected');
  });

  it("23. long text truncation (>60 chars)", () => {
    const longText = "A".repeat(80);
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: longText,
        currentText: longText,
        status: "pending",
      }),
    );
    // Truncated to 60 chars: 57 A's + "..."
    const expectedTruncated = "A".repeat(57) + "...";
    expect(desc).toBe(`suggested inserting "${expectedTruncated}", still pending`);
  });

  it("suggestion with no text, no deleteRange, no styleChanges -> generic description", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        status: "pending",
      }),
    );
    expect(desc).toBe("created a suggestion, still pending");
  });

  it("modification count > 0 but currentText equals originalText", () => {
    // This can happen if a user modifies back to the original text
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: "same",
        currentText: "same",
        status: "modified",
        modificationCount: 2,
      }),
    );
    // When currentText === originalText, the "modified Nx to ..." branch is skipped
    // but the "modified Nx" branch is used
    expect(desc).toBe('suggested inserting "same", modified 2x, still pending');
  });

  it("delete suggestion, accepted", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        deleteRange: { startIndex: 5, endIndex: 20 },
        status: "accepted",
      }),
    );
    expect(desc).toBe("suggested deleting characters 5-20, accepted");
  });

  it("delete suggestion, rejected", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        deleteRange: { startIndex: 5, endIndex: 20 },
        status: "rejected",
      }),
    );
    expect(desc).toBe("suggested deleting characters 5-20, rejected");
  });

  it("modified delete suggestion (modificationCount > 0, no text)", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        deleteRange: { startIndex: 5, endIndex: 20 },
        status: "modified",
        modificationCount: 3,
      }),
    );
    expect(desc).toBe("suggested deleting characters 5-20, modified 3x, still pending");
  });

  it("formatting + modification count", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        styleChanges: { ts_bd: true },
        status: "modified",
        modificationCount: 1,
      }),
    );
    expect(desc).toBe("suggested Text: bold, modified 1x, still pending");
  });

  it("truncation applies to currentText too", () => {
    const longOriginal = "B".repeat(80);
    const longCurrent = "C".repeat(80);
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: longOriginal,
        currentText: longCurrent,
        status: "accepted",
        modificationCount: 1,
      }),
    );
    const truncatedOrig = "B".repeat(57) + "...";
    const truncatedCurrent = "C".repeat(57) + "...";
    expect(desc).toBe(
      `suggested inserting "${truncatedOrig}", modified 1x to "${truncatedCurrent}", accepted`,
    );
  });

  it("status 'deleted' produces no resolution line", () => {
    const desc = describeSuggestion(
      makeLifecycle({
        originalText: "deleted",
        currentText: "deleted",
        status: "deleted",
      }),
    );
    // "deleted" status is not in the resolution if/else branches
    expect(desc).toBe('suggested inserting "deleted"');
  });
});

// ===========================================================================
// 3. summarizeSuggestions
// ===========================================================================

describe("summarizeSuggestions", () => {
  it("24. 0 suggestions -> empty string", () => {
    const summary: SuggestionSummary = {
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      modified: 0,
      deleted: 0,
      suggestions: [],
    };
    expect(summarizeSuggestions(summary)).toBe("");
  });

  it("25. all accepted -> '3 suggestion(s), 3 accepted'", () => {
    const summary: SuggestionSummary = {
      total: 3,
      pending: 0,
      accepted: 3,
      rejected: 0,
      modified: 0,
      deleted: 0,
      suggestions: [],
    };
    expect(summarizeSuggestions(summary)).toBe("3 suggestion(s), 3 accepted");
  });

  it("26. mixed -> '5 suggestion(s), 2 accepted, 1 rejected, 2 pending'", () => {
    const summary: SuggestionSummary = {
      total: 5,
      pending: 2,
      accepted: 2,
      rejected: 1,
      modified: 0,
      deleted: 0,
      suggestions: [],
    };
    expect(summarizeSuggestions(summary)).toBe("5 suggestion(s), 2 accepted, 1 rejected, 2 pending");
  });

  it("27. only pending -> '2 suggestion(s), 2 pending'", () => {
    const summary: SuggestionSummary = {
      total: 2,
      pending: 2,
      accepted: 0,
      rejected: 0,
      modified: 0,
      deleted: 0,
      suggestions: [],
    };
    expect(summarizeSuggestions(summary)).toBe("2 suggestion(s), 2 pending");
  });

  it("includes modified count when present", () => {
    const summary: SuggestionSummary = {
      total: 4,
      pending: 1,
      accepted: 1,
      rejected: 1,
      modified: 1,
      deleted: 0,
      suggestions: [],
    };
    expect(summarizeSuggestions(summary)).toBe(
      "4 suggestion(s), 1 accepted, 1 rejected, 1 pending, 1 modified",
    );
  });

  it("only rejected -> '1 suggestion(s), 1 rejected'", () => {
    const summary: SuggestionSummary = {
      total: 1,
      pending: 0,
      accepted: 0,
      rejected: 1,
      modified: 0,
      deleted: 0,
      suggestions: [],
    };
    expect(summarizeSuggestions(summary)).toBe("1 suggestion(s), 1 rejected");
  });

  it("all modified -> '2 suggestion(s), 2 modified'", () => {
    const summary: SuggestionSummary = {
      total: 2,
      pending: 0,
      accepted: 0,
      rejected: 0,
      modified: 2,
      deleted: 0,
      suggestions: [],
    };
    expect(summarizeSuggestions(summary)).toBe("2 suggestion(s), 2 modified");
  });

  it("deleted count is included in summarize", () => {
    const summary: SuggestionSummary = {
      total: 1,
      pending: 0,
      accepted: 0,
      rejected: 0,
      modified: 0,
      deleted: 1,
      suggestions: [],
    };
    expect(summarizeSuggestions(summary)).toBe("1 suggestion(s), 1 deleted");
  });
});

// ===========================================================================
// 4. Integration: trackSuggestions -> describeSuggestion -> summarizeSuggestions
// ===========================================================================

describe("integration: full pipeline", () => {
  it("tracks, describes, and summarizes a realistic editing session", () => {
    resetCounter();
    const ops = [
      // User A creates suggestion 1 (insert)
      makeOp({
        type: "insert_suggestion",
        sugId: "sug.int.1",
        text: "Introduction: ",
        startIndex: 1,
        userId: "user-alice",
        timestamp: new Date("2025-01-15T09:00:00Z"),
        tabId: "t.main",
      }),
      // User A creates suggestion 2 (delete)
      makeOp({
        type: "delete_suggestion",
        sugId: "sug.int.2",
        startIndex: 50,
        endIndex: 75,
        userId: "user-alice",
        timestamp: new Date("2025-01-15T09:05:00Z"),
        tabId: "t.main",
      }),
      // User B creates suggestion 3 (format)
      makeOp({
        type: "format",
        sugId: "sug.int.3",
        startIndex: 100,
        endIndex: 120,
        userId: "user-bob",
        timestamp: new Date("2025-01-15T09:10:00Z"),
        styleType: "text",
        styleModification: { ts_bd: true, ts_it: true },
      }),
      // User A modifies suggestion 1
      makeOp({
        type: "insert_suggestion",
        sugId: "sug.int.1",
        text: "Preface: ",
        startIndex: 1,
        userId: "user-alice",
        timestamp: new Date("2025-01-15T09:15:00Z"),
        tabId: "t.main",
      }),
      // Reviewer accepts suggestion 1
      makeOp({
        type: "insert",
        text: "Preface: ",
        startIndex: 1,
        userId: "user-reviewer",
        timestamp: new Date("2025-01-15T10:00:00Z"),
      }),
      // Reviewer rejects suggestion 2
      makeOp({
        type: "unmark_deletion",
        sugId: "sug.int.2",
        startIndex: 50,
        endIndex: 75,
        userId: "user-reviewer",
        timestamp: new Date("2025-01-15T10:05:00Z"),
      }),
      // Suggestion 3 stays pending
    ];

    const summary = trackSuggestions(makeChangelog(ops));
    expect(summary.total).toBe(3);
    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.pending).toBe(1);

    // Describe each suggestion
    const sug1 = summary.suggestions.find((s) => s.sugId === "sug.int.1")!;
    const desc1 = describeSuggestion(sug1);
    expect(desc1).toContain('suggested inserting "Introduction: "');
    expect(desc1).toContain('modified 1x to "Preface: "');
    expect(desc1).toContain("accepted");

    const sug2 = summary.suggestions.find((s) => s.sugId === "sug.int.2")!;
    const desc2 = describeSuggestion(sug2);
    expect(desc2).toContain("suggested deleting characters 50-75");
    expect(desc2).toContain("rejected");

    const sug3 = summary.suggestions.find((s) => s.sugId === "sug.int.3")!;
    const desc3 = describeSuggestion(sug3);
    expect(desc3).toContain("suggested Text: bold");
    expect(desc3).toContain("still pending");

    // Summarize
    const summaryText = summarizeSuggestions(summary);
    expect(summaryText).toBe("3 suggestion(s), 1 accepted, 1 rejected, 1 pending");
  });

  it("single pending suggestion full pipeline", () => {
    resetCounter();
    const ops = [
      makeOp({
        type: "insert_suggestion",
        sugId: "sug.only",
        text: "just pending",
        startIndex: 5,
        userId: "user-A",
        timestamp: new Date("2025-01-15T10:00:00Z"),
      }),
    ];

    const summary = trackSuggestions(makeChangelog(ops));
    expect(summarizeSuggestions(summary)).toBe("1 suggestion(s), 1 pending");

    const desc = describeSuggestion(summary.suggestions[0]);
    expect(desc).toContain('suggested inserting "just pending"');
    expect(desc).toContain("still pending");
  });
});
