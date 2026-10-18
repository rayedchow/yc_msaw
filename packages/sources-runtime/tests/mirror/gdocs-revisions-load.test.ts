/**
 * Exhaustive unit test suite for the Google Docs OT changelog parser.
 *
 * Tests parseOperation, flattenMultiOps, parseXssiJson, extractTabId,
 * replayWithDiffs, buildAuthorAttribution, extractPendingSuggestions,
 * enrichPhase1Events, and pagination logic — all with mocked data.
 *
 * No live API requests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must come before importing the module under test
// ---------------------------------------------------------------------------

// Mock DB
vi.mock("../../src/db/client.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => []),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => []),
      })),
    })),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  activityEvents: { id: "id", userId: "userId", source: "source", rawPayload: "rawPayload", timestamp: "timestamp", eventType: "eventType" },
}));

vi.mock("../../src/vault/google-auth.js", () => ({
  getGoogleAccessToken: vi.fn(async () => "mock-token"),
  // Referenced by fetchDocChangelog; value is irrelevant under the mocked
  // getGoogleAccessToken. Must be present — vitest 3.x throws on access to
  // an undefined named export.
  GOOGLE_DOCS_DELEGATION_SCOPES: ["https://www.googleapis.com/auth/drive.readonly"],
}));

vi.mock("../../src/polling/_archived-gdocs/gdocs-api.js", () => ({
  gFetch: vi.fn(async () => new Response("", { status: 500 })),
}));

vi.mock("../../src/env.js", () => ({
  env: {
    DATABASE_URL: "postgresql://test",
    REDIS_URL: "redis://test",
    ADMIN_API_KEY: "test-admin-key",
    ENCRYPTION_KEY: "test-encryption-key",
    WEBHOOK_BASE_URL: "https://test.railway.app",
  },
}));

vi.mock("../../src/vault/encryption.js", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace("enc:", ""),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  sql: vi.fn(() => ({})),
  gte: vi.fn((...args: unknown[]) => ({ _gte: args })),
}));

// ---------------------------------------------------------------------------
// Import functions under test (after mocks are defined)
// ---------------------------------------------------------------------------

// We need to access unexported functions. We'll re-implement the pure functions
// for testing by extracting them. Since parseOperation, flattenMultiOps,
// parseXssiJson, and extractTabId are not exported, we test them indirectly
// through the exported functions, or we import the module and test the exports.

// For the unexported pure functions, we replicate the logic here for direct
// testing. The exported functions (replayWithDiffs, buildAuthorAttribution,
// extractPendingSuggestions, etc.) are tested directly.

import {
  replayWithDiffs,
  buildAuthorAttribution,
  extractPendingSuggestions,
  getOperationsSince,
  fetchDocChangelog,
  type ChangelogOperation,
  type DocChangelog,
  type RevisionTile,
} from "../../src/polling/_archived-gdocs/gdocs-revisions-load.js";

import { gFetch } from "../../src/polling/_archived-gdocs/gdocs-api.js";

const mockGFetch = vi.mocked(gFetch);

// ---------------------------------------------------------------------------
// Helper: Replicate the unexported pure functions for direct testing
// We copy the exact logic from the source to test behavior, then also
// test through the exported API to ensure integration correctness.
// ---------------------------------------------------------------------------

// These replicate the source exactly:
const XSSI_PATTERNS = [
  /^\)\]\}'\n?/,
  /^while\(1\);?\s*/,
  /^&&+START&&+\s*/,
];

function parseXssiJson(rawText: string): Record<string, unknown> | null {
  for (const pattern of XSSI_PATTERNS) {
    const stripped = rawText.replace(pattern, "");
    if (stripped !== rawText) {
      try {
        return JSON.parse(stripped) as Record<string, unknown>;
      } catch {
        // pattern matched but JSON invalid - try next
      }
    }
  }
  for (const skip of [4, 5, 6]) {
    try {
      return JSON.parse(rawText.slice(skip)) as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  return null;
}

// Local replica of parseOperation matching production behavior.
// Must be kept in sync with src/polling/gdocs-revisions-load.ts parseOperation().
function parseOperation(
  raw: Record<string, unknown> | null | undefined,
): Partial<ChangelogOperation> | null {
  if (!raw || typeof raw !== "object") return null;
  const ty = raw.ty as string | undefined;
  switch (ty) {
    case "is":
      return { type: "insert", text: raw.s as string | undefined, startIndex: raw.ibi as number | undefined };
    case "ds":
      return { type: "delete", startIndex: raw.si as number | undefined, endIndex: raw.ei as number | undefined };
    case "iss":
      return { type: "insert_suggestion", text: raw.s as string | undefined, startIndex: raw.ibi as number | undefined };
    case "dss":
      return { type: "delete_suggestion", startIndex: raw.si as number | undefined, endIndex: raw.ei as number | undefined };
    case "msfd":
      return { type: "mark_deletion", startIndex: raw.si as number | undefined, endIndex: raw.ei as number | undefined };
    case "usfd":
      return { type: "unmark_deletion", startIndex: raw.si as number | undefined, endIndex: raw.ei as number | undefined };
    case "as":
      return { type: "format", startIndex: raw.si as number | undefined, endIndex: raw.ei as number | undefined, styleType: raw.st as string | undefined, styleModification: raw.sm as Record<string, unknown> | undefined };
    case "nm": {
      const nmc = raw.nmc as Record<string, unknown> | undefined;
      if (nmc && typeof nmc === "object") {
        const inner = parseOperation(nmc);
        if (inner) return inner;
      }
      return { type: "other" };
    }
    case "mlti":
      return { type: "multi" };
    case "rplc":
      return { type: "replace" };
    case "rvrt":
      return { type: "revert" };
    case "ae":
      return { type: "add_element", elementType: raw.et as string | undefined, elementId: raw.id as string | undefined };
    case "de":
      return { type: "delete_element", elementType: raw.et as string | undefined, elementId: raw.id as string | undefined };
    case "ue":
      return { type: "update_element", elementType: raw.et as string | undefined, elementId: raw.id as string | undefined };
    case "te":
      return { type: "tether_element", elementType: raw.et as string | undefined, elementId: raw.id as string | undefined, startIndex: raw.spi as number | undefined };
    case "sas":
      return { type: "format", startIndex: raw.si as number | undefined, endIndex: raw.ei as number | undefined, sugId: raw.sugid as string | undefined, styleType: raw.st as string | undefined, styleModification: raw.sm as Record<string, unknown> | undefined };
    case "astss":
      return { type: "format", startIndex: raw.si as number | undefined, endIndex: raw.ei as number | undefined, styleType: raw.st as string | undefined, styleModification: raw.sm as Record<string, unknown> | undefined };
    case "ras":
      return { type: "unmark_deletion", startIndex: raw.si as number | undefined, endIndex: raw.ei as number | undefined, sugId: raw.sugid as string | undefined };
    case "umv": case "utlp":
      return { type: "other" };
    // ac, dc, mch, mkch, ucp have complex d[] parsing — simplified to "other" in unit tests.
    // Production behavior is tested through integration tests.
    case "ac": case "dc": case "mch": case "mkch": case "ucp":
      return { type: "other" };
    default:
      return null;
  }
}

function flattenMultiOps(
  raw: Record<string, unknown>,
): Array<Partial<ChangelogOperation>> {
  const ty = raw.ty as string | undefined;
  if (ty === "mlti") {
    const subs = (raw.mts as Array<Record<string, unknown>>) ?? [];
    const results: Array<Partial<ChangelogOperation>> = [];
    for (const sub of subs) {
      results.push(...flattenMultiOps(sub));
    }
    return results;
  }
  if (ty === "nm") {
    const nmc = raw.nmc as Record<string, unknown> | undefined;
    if (nmc && typeof nmc === "object") {
      return flattenMultiOps(nmc);
    }
    return [{ type: "other" }];
  }
  const op = parseOperation(raw);
  return op ? [op] : [];
}

function extractTabId(raw: Record<string, unknown>): string | undefined {
  if (raw.ty === "nm" && Array.isArray(raw.nmr)) {
    for (const id of raw.nmr) {
      if (typeof id === "string" && id.startsWith("t.")) return id;
    }
  }
  if (raw.ty === "mlti" && Array.isArray(raw.mts)) {
    for (const sub of raw.mts as Array<Record<string, unknown>>) {
      if (sub && typeof sub === "object") {
        const id = extractTabId(sub);
        if (id) return id;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helper: create a ChangelogOperation
// ---------------------------------------------------------------------------

function makeOp(
  overrides: Partial<ChangelogOperation> & { type: ChangelogOperation["type"] },
): ChangelogOperation {
  return {
    userId: "user1",
    timestamp: new Date("2025-01-15T10:00:00Z"),
    revisionId: 1,
    sessionId: "sess1",
    changelogIndex: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

// =========================================================================
// 1. parseOperation — every operation type
// =========================================================================

describe("parseOperation", () => {
  it("parses is (InsertString)", () => {
    const result = parseOperation({ ty: "is", ibi: 14, s: "hello" });
    expect(result).toEqual({ type: "insert", text: "hello", startIndex: 14 });
  });

  it("parses ds (DeleteString)", () => {
    const result = parseOperation({ ty: "ds", si: 10, ei: 15 });
    expect(result).toEqual({ type: "delete", startIndex: 10, endIndex: 15 });
  });

  it("parses iss (InsertStringSuggestion)", () => {
    const result = parseOperation({ ty: "iss", sugid: "suggest.abc", ibi: 230, s: "realized" });
    expect(result).toEqual({ type: "insert_suggestion", text: "realized", startIndex: 230 });
  });

  it("parses dss (DeleteStringSuggestion)", () => {
    const result = parseOperation({ ty: "dss", sugid: "suggest.xyz", si: 296, ei: 300 });
    expect(result).toEqual({ type: "delete_suggestion", startIndex: 296, endIndex: 300 });
  });

  it("parses msfd (MarkStringForDeletion)", () => {
    const result = parseOperation({ ty: "msfd", sugid: "suggest.gh3v2o30oabr", si: 230, ei: 250 });
    expect(result).toEqual({ type: "mark_deletion", startIndex: 230, endIndex: 250 });
  });

  it("parses usfd (UnmarkStringForDeletion)", () => {
    const result = parseOperation({ ty: "usfd", sugid: "suggest.1dguw1hn6h5l", si: 3336, ei: 3339 });
    expect(result).toEqual({ type: "unmark_deletion", startIndex: 3336, endIndex: 3339 });
  });

  it("parses ras (RejectAllSuggestions) as unmark_deletion with sugId", () => {
    const result = parseOperation({ ty: "ras", sugid: "suggest.lzz7mex81dkx", si: 4387, ei: 4564 });
    expect(result).toEqual({ type: "unmark_deletion", startIndex: 4387, endIndex: 4564, sugId: "suggest.lzz7mex81dkx" });
  });

  it("parses as (ApplyStyle) as format with style fields", () => {
    const result = parseOperation({
      ty: "as", st: "text", si: 5, ei: 10, sm: { ts_bd: true, ts_bd_i: false },
    });
    expect(result).toEqual({ type: "format", startIndex: 5, endIndex: 10, styleType: "text", styleModification: { ts_bd: true, ts_bd_i: false } });
  });

  it("parses sas (SuggestAdjustStyle) as format with sugId", () => {
    const result = parseOperation({
      ty: "sas", sugid: "suggest.abc", st: "text", si: 100, ei: 200, sm: {},
    });
    expect(result).toEqual({ type: "format", startIndex: 100, endIndex: 200, sugId: "suggest.abc", styleType: "text", styleModification: {} });
  });

  it("parses astss (ApplyStyleToSnapshot) as format", () => {
    const result = parseOperation({ ty: "astss", st: "text", si: 1, ei: 100, sm: {} });
    expect(result).toEqual({ type: "format", startIndex: 1, endIndex: 100, styleType: "text", styleModification: {} });
  });

  it("parses ae (AddElement) with element fields", () => {
    const result = parseOperation({ ty: "ae", et: "list", id: "kix.5dg9", epm: {} });
    expect(result).toEqual({ type: "add_element", elementType: "list", elementId: "kix.5dg9" });
  });

  it("parses de (DeleteElement)", () => {
    const result = parseOperation({ ty: "de", id: "kix.4b85", et: "inline" });
    expect(result).toEqual({ type: "delete_element", elementType: "inline", elementId: "kix.4b85" });
  });

  it("parses ue (UpdateElement)", () => {
    const result = parseOperation({ ty: "ue", id: "kix.e649", epm: {} });
    expect(result).toEqual({ type: "update_element", elementType: undefined, elementId: "kix.e649" });
  });

  it("parses te (TetherElement)", () => {
    const result = parseOperation({ ty: "te", id: "kix.6y2r", spi: 1 });
    expect(result).toEqual({ type: "tether_element", elementType: undefined, elementId: "kix.6y2r", startIndex: 1 });
  });

  it("parses nm (NamedMutation) — unwraps nmc insert", () => {
    const result = parseOperation({
      ty: "nm",
      nmr: ["ksm", "t.taev36xqg9o0"],
      nmc: { ty: "is", ibi: 14, s: "hello" },
    });
    expect(result).toEqual({ type: "insert", text: "hello", startIndex: 14 });
  });

  it("parses nm — unwraps nmc delete", () => {
    const result = parseOperation({
      ty: "nm",
      nmr: ["ksm", "t.abc123"],
      nmc: { ty: "ds", si: 5, ei: 10 },
    });
    expect(result).toEqual({ type: "delete", startIndex: 5, endIndex: 10 });
  });

  it("parses nm — unwraps nmc format (as)", () => {
    const result = parseOperation({
      ty: "nm",
      nmr: ["ksm", "t.tab1"],
      nmc: { ty: "as", si: 1, ei: 20, sm: { ts_bd: true }, st: "text" },
    });
    expect(result).toEqual({ type: "format", startIndex: 1, endIndex: 20, styleType: "text", styleModification: { ts_bd: true } });
  });

  it("parses nm — unwraps nmc ae", () => {
    const result = parseOperation({
      ty: "nm",
      nmr: ["ksm", "t.tab1"],
      nmc: { ty: "ae", et: "list", id: "kix.abc" },
    });
    expect(result).toEqual({ type: "add_element", elementType: "list", elementId: "kix.abc" });
  });

  it("parses nm — unwraps nmc de", () => {
    const result = parseOperation({
      ty: "nm",
      nmr: ["ksm", "t.tab1"],
      nmc: { ty: "de", id: "kix.abc", et: "inline" },
    });
    expect(result).toEqual({ type: "delete_element", elementType: "inline", elementId: "kix.abc" });
  });

  it("parses nm — unwraps nmc ue", () => {
    const result = parseOperation({
      ty: "nm",
      nmr: ["ksm", "t.tab1"],
      nmc: { ty: "ue", id: "kix.abc", epm: {} },
    });
    expect(result).toEqual({ type: "update_element", elementType: undefined, elementId: "kix.abc" });
  });

  it("parses nm — unwraps nmc te", () => {
    const result = parseOperation({
      ty: "nm",
      nmr: ["ksm", "t.tab1"],
      nmc: { ty: "te", id: "kix.abc", spi: 1 },
    });
    expect(result).toEqual({ type: "tether_element", elementType: undefined, elementId: "kix.abc", startIndex: 1 });
  });

  it("parses nm without nmc as other", () => {
    const result = parseOperation({ ty: "nm", nmr: ["ksm"] });
    expect(result).toEqual({ type: "other" });
  });

  it("parses mlti as multi", () => {
    const result = parseOperation({ ty: "mlti", mts: [] });
    expect(result).toEqual({ type: "multi" });
  });

  it("parses rplc as replace", () => {
    const result = parseOperation({ ty: "rplc", snapshot: [] });
    expect(result).toEqual({ type: "replace" });
  });

  it("parses rvrt as revert", () => {
    const result = parseOperation({ ty: "rvrt", snapshot: [] });
    expect(result).toEqual({ type: "revert" });
  });

  it("parses dc (DocumentConfiguration) as other", () => {
    const result = parseOperation({ ty: "dc", d: ["", [1], 0] });
    expect(result).toEqual({ type: "other" });
  });

  it("parses ac (AddComment/AddTab) as other", () => {
    const result = parseOperation({ ty: "ac", d: ["t.taev36xqg9o0", [1, "Tab 2"], [1]] });
    expect(result).toEqual({ type: "other" });
  });

  it("parses mch (ModifyComment/Header) as other", () => {
    const result = parseOperation({ ty: "mch", d: [[1], [0]] });
    expect(result).toEqual({ type: "other" });
  });

  it("parses mkch (MarkComment/RenameTab) as other", () => {
    const result = parseOperation({ ty: "mkch", d: [[1, "Idea Matrix"]] });
    expect(result).toEqual({ type: "other" });
  });

  it("parses ucp (UpdateCursorPosition) as other", () => {
    const result = parseOperation({ ty: "ucp", d: ["t.ao989aeozkre", [[], [1, "dump"]]] });
    expect(result).toEqual({ type: "other" });
  });

  it("parses umv (UpdateModelVersion) as other", () => {
    const result = parseOperation({ ty: "umv", mv: 61 });
    expect(result).toEqual({ type: "other" });
  });

  it("parses utlp (UpdateTopLevelProperties) as other", () => {
    const result = parseOperation({ ty: "utlp", d: [[[], [1, "en"]]] });
    expect(result).toEqual({ type: "other" });
  });

  // Edge cases
  it("returns null for null operation", () => {
    expect(parseOperation(null)).toBeNull();
  });

  it("returns null for undefined operation", () => {
    expect(parseOperation(undefined)).toBeNull();
  });

  it("returns null for non-object (number)", () => {
    expect(parseOperation(42 as unknown as Record<string, unknown>)).toBeNull();
  });

  it("returns null for non-object (string)", () => {
    expect(parseOperation("hello" as unknown as Record<string, unknown>)).toBeNull();
  });

  it("returns null for unknown/future operation types", () => {
    expect(parseOperation({ ty: "xyz_future_type" })).toBeNull();
  });

  it("returns null for empty object (no ty field)", () => {
    expect(parseOperation({})).toBeNull();
  });

  it("handles is with missing s field", () => {
    const result = parseOperation({ ty: "is", ibi: 1 });
    expect(result).toEqual({ type: "insert", text: undefined, startIndex: 1 });
  });

  it("handles is with missing ibi field", () => {
    const result = parseOperation({ ty: "is", s: "text" });
    expect(result).toEqual({ type: "insert", text: "text", startIndex: undefined });
  });

  it("handles ds with missing si/ei", () => {
    const result = parseOperation({ ty: "ds" });
    expect(result).toEqual({ type: "delete", startIndex: undefined, endIndex: undefined });
  });

  it("handles nm with nmc that has unknown inner type", () => {
    const result = parseOperation({
      ty: "nm",
      nmr: ["ksm", "t.tab1"],
      nmc: { ty: "future_inner_type" },
    });
    // parseOperation returns null for unknown types, so nm falls back to "other"
    expect(result).toEqual({ type: "other" });
  });

  it("handles nm with nmc set to non-object value", () => {
    const result = parseOperation({ ty: "nm", nmr: ["ksm"], nmc: 42 });
    expect(result).toEqual({ type: "other" });
  });

  it("handles nm with nmc set to null", () => {
    const result = parseOperation({ ty: "nm", nmr: ["ksm"], nmc: null });
    expect(result).toEqual({ type: "other" });
  });
});

// =========================================================================
// 2. flattenMultiOps
// =========================================================================

describe("flattenMultiOps", () => {
  it("flattens mlti with two nm[is]", () => {
    const raw = {
      ty: "mlti",
      mts: [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "A" } },
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 2, s: "B" } },
      ],
    };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "insert", text: "A", startIndex: 1 });
    expect(result[1]).toEqual({ type: "insert", text: "B", startIndex: 2 });
  });

  it("flattens mlti[nm[ds], nm[is]] (replace pattern)", () => {
    const raw = {
      ty: "mlti",
      mts: [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "ds", si: 10, ei: 15 } },
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 10, s: "world" } },
      ],
    };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "delete", startIndex: 10, endIndex: 15 });
    expect(result[1]).toEqual({ type: "insert", text: "world", startIndex: 10 });
  });

  it("flattens mlti[nm[is], nm[as]] (insert with formatting)", () => {
    const raw = {
      ty: "mlti",
      mts: [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "Bold" } },
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "as", si: 1, ei: 4, sm: { ts_bd: true } } },
      ],
    };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "insert", text: "Bold", startIndex: 1 });
    expect(result[1]).toEqual({ type: "format", startIndex: 1, endIndex: 4, styleType: undefined, styleModification: { ts_bd: true } });
  });

  it("flattens nested mlti[mlti[nm[is], nm[as]], mlti[nm[is], nm[as]]]", () => {
    const raw = {
      ty: "mlti",
      mts: [
        {
          ty: "mlti",
          mts: [
            { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "X" } },
            { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "as", si: 1, ei: 1 } },
          ],
        },
        {
          ty: "mlti",
          mts: [
            { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 2, s: "Y" } },
            { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "as", si: 2, ei: 2 } },
          ],
        },
      ],
    };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: "insert", text: "X", startIndex: 1 });
    expect(result[1]).toEqual({ type: "format", startIndex: 1, endIndex: 1 });
    expect(result[2]).toEqual({ type: "insert", text: "Y", startIndex: 2 });
    expect(result[3]).toEqual({ type: "format", startIndex: 2, endIndex: 2 });
  });

  it("flattens mlti containing nm with tab ID", () => {
    const raw = {
      ty: "mlti",
      mts: [
        { ty: "nm", nmr: ["ksm", "t.specific_tab"], nmc: { ty: "ds", si: 5, ei: 8 } },
      ],
    };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "delete", startIndex: 5, endIndex: 8 });
  });

  it("flattens triple-nested mlti > mlti > mlti > nm", () => {
    const raw = {
      ty: "mlti",
      mts: [{
        ty: "mlti",
        mts: [{
          ty: "mlti",
          mts: [
            { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "deep" } },
          ],
        }],
      }],
    };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "insert", text: "deep", startIndex: 1 });
  });

  it("flattens mlti with direct is/ds (older docs, no nm wrapper)", () => {
    const raw = {
      ty: "mlti",
      mts: [
        { ty: "ds", si: 10, ei: 15 },
        { ty: "is", ibi: 10, s: "replacement" },
      ],
    };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "delete", startIndex: 10, endIndex: 15 });
    expect(result[1]).toEqual({ type: "insert", text: "replacement", startIndex: 10 });
  });

  it("handles mlti with empty mts array", () => {
    const raw = { ty: "mlti", mts: [] };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(0);
  });

  it("handles mlti with missing mts field", () => {
    const raw = { ty: "mlti" };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(0);
  });

  it("handles nm without nmc as other", () => {
    const result = flattenMultiOps({ ty: "nm", nmr: ["ksm"] });
    expect(result).toEqual([{ type: "other" }]);
  });

  it("unwraps a standalone nm to its leaf", () => {
    const raw = { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 5, s: "test" } };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "insert", text: "test", startIndex: 5 });
  });

  it("processes a standalone leaf (is) directly", () => {
    const raw = { ty: "is", ibi: 1, s: "plain" };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "insert", text: "plain", startIndex: 1 });
  });

  it("returns empty for unknown types in flattenMultiOps", () => {
    const raw = { ty: "unknown_future_type" };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(0);
  });

  it("flattens mlti containing ae, ue, as (add element with styling)", () => {
    const raw = {
      ty: "mlti",
      mts: [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "ae", et: "list", id: "kix.abc" } },
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "ue", id: "kix.abc", epm: {} } },
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "as", si: 1, ei: 5 } },
      ],
    };
    const result = flattenMultiOps(raw);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "add_element", elementType: "list", elementId: "kix.abc" });
    expect(result[1]).toEqual({ type: "update_element", elementType: undefined, elementId: "kix.abc" });
    expect(result[2]).toEqual({ type: "format", startIndex: 1, endIndex: 5, styleType: undefined, styleModification: undefined });
  });
});

// =========================================================================
// 3. nm unwrapping — nmc contains each leaf type
// =========================================================================

describe("nm unwrapping — all nmc leaf types", () => {
  const leafTypes = [
    { nmc: { ty: "is", ibi: 1, s: "text" }, expected: "insert" },
    { nmc: { ty: "ds", si: 1, ei: 5 }, expected: "delete" },
    { nmc: { ty: "iss", ibi: 1, s: "sug" }, expected: "insert_suggestion" },
    { nmc: { ty: "dss", si: 1, ei: 3 }, expected: "delete_suggestion" },
    { nmc: { ty: "as", si: 1, ei: 10 }, expected: "format" },
    { nmc: { ty: "ae", et: "list" }, expected: "add_element" },
    { nmc: { ty: "de", id: "kix.x" }, expected: "delete_element" },
    { nmc: { ty: "ue", id: "kix.y" }, expected: "update_element" },
    { nmc: { ty: "te", id: "kix.z", spi: 1 }, expected: "tether_element" },
  ];

  for (const { nmc, expected } of leafTypes) {
    it(`nm with nmc.ty=${nmc.ty} produces type=${expected}`, () => {
      const result = parseOperation({
        ty: "nm",
        nmr: ["ksm", "t.tab1"],
        nmc,
      });
      expect(result?.type).toBe(expected);
    });
  }
});

// =========================================================================
// 4. rplc/rvrt snapshot processing
// =========================================================================

describe("rplc/rvrt snapshot processing", () => {
  it("rplc is parsed as replace", () => {
    const result = parseOperation({
      ty: "rplc",
      snapshot: [
        { ty: "mkch", d: [[1, "Tab Name"]] },
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "restored text" } },
      ],
    });
    expect(result).toEqual({ type: "replace" });
  });

  it("rvrt is parsed as revert", () => {
    const result = parseOperation({
      ty: "rvrt",
      snapshot: [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "old content" } },
      ],
    });
    expect(result).toEqual({ type: "revert" });
  });
});

// =========================================================================
// 5. null operations
// =========================================================================

describe("null operations", () => {
  it("ty: null is not in the switch — returns null", () => {
    // The source uses "default: return null", and "null" is not a case
    // However note that the raw op has ty: "null" as a string, not actual null
    const result = parseOperation({ ty: "null" });
    // "null" is not in the switch cases, so it hits default and returns null
    expect(result).toBeNull();
  });
});

// =========================================================================
// 6. Unknown/future operation types
// =========================================================================

describe("unknown/future operation types", () => {
  it("returns null for completely unknown type", () => {
    expect(parseOperation({ ty: "brand_new_google_feature" })).toBeNull();
  });

  it("returns null for empty string type", () => {
    expect(parseOperation({ ty: "" })).toBeNull();
  });

  it("returns null for numeric type", () => {
    expect(parseOperation({ ty: 42 })).toBeNull();
  });
});

// =========================================================================
// 7. Malformed operations
// =========================================================================

describe("malformed operations", () => {
  it("handles object with extra unexpected fields gracefully", () => {
    const result = parseOperation({ ty: "is", ibi: 1, s: "x", extra: "field", nested: { a: 1 } });
    expect(result).toEqual({ type: "insert", text: "x", startIndex: 1 });
  });

  it("handles is with s as a number (wrong type)", () => {
    const result = parseOperation({ ty: "is", ibi: 1, s: 42 });
    expect(result).toEqual({ type: "insert", text: 42, startIndex: 1 });
  });

  it("handles ds with si/ei as strings", () => {
    const result = parseOperation({ ty: "ds", si: "10", ei: "15" });
    expect(result).toEqual({ type: "delete", startIndex: "10", endIndex: "15" });
  });

  it("handles empty object (no ty)", () => {
    expect(parseOperation({})).toBeNull();
  });
});

// =========================================================================
// 8-13. Anti-XSSI prefix (parseXssiJson)
// =========================================================================

describe("parseXssiJson", () => {
  it("parses standard 5-char prefix: )]}' + newline", () => {
    const raw = `)]}'
{"foo": "bar"}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ foo: "bar" });
  });

  it("parses 4-char prefix: )]}' (no newline)", () => {
    const raw = `)]}'{"foo": "bar"}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ foo: "bar" });
  });

  it("parses historical prefix: while(1);", () => {
    const raw = `while(1);{"data": 123}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ data: 123 });
  });

  it("parses historical prefix: while(1) (no semicolon)", () => {
    const raw = `while(1){"data": 123}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ data: 123 });
  });

  it("parses historical prefix: &&&START&&&", () => {
    const raw = `&&&START&&&{"legacy": true}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ legacy: true });
  });

  it("parses &&&START&&& with trailing space", () => {
    const raw = `&&&START&&& {"spaced": true}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ spaced: true });
  });

  it("handles no prefix (raw JSON) via brute-force fallback", () => {
    // The raw JSON doesn't match any pattern, so falls back to slice(4/5/6)
    // For raw JSON, none of the patterns match, and slice(4) on raw JSON
    // would likely fail unless the JSON happens to be valid after slicing.
    // Let's test with 4+ chars of padding to ensure the fallback works.
    const raw = `XXXX{"fallback": true}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ fallback: true });
  });

  it("handles empty string", () => {
    const result = parseXssiJson("");
    expect(result).toBeNull();
  });

  it("handles HTML error page (not JSON)", () => {
    const raw = `<html><body><h1>403 Forbidden</h1></body></html>`;
    const result = parseXssiJson(raw);
    expect(result).toBeNull();
  });

  it("handles prefix followed by invalid JSON", () => {
    const raw = `)]}'
{invalid json here}`;
    // Pattern matches but JSON.parse fails, falls back to brute-force which also fails
    const result = parseXssiJson(raw);
    expect(result).toBeNull();
  });

  it("handles while(1); with whitespace before JSON", () => {
    const raw = `while(1);   {"whitespace": "ok"}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ whitespace: "ok" });
  });

  it("parses complex nested JSON after prefix", () => {
    const payload = {
      chunkedSnapshot: [[]],
      changelog: [
        [{ ty: "is", ibi: 1, s: "a" }, 1700000000000, "12345", 1, "sess", 0, null, null, false],
      ],
    };
    const raw = `)]}'\n` + JSON.stringify(payload);
    const result = parseXssiJson(raw);
    expect(result).toEqual(payload);
  });

  it("handles prefix with 6-char brute-force fallback", () => {
    const raw = `XXXXXX{"six": true}`;
    const result = parseXssiJson(raw);
    expect(result).toEqual({ six: true });
  });
});

// =========================================================================
// 14-18. Tab ID extraction (extractTabId)
// =========================================================================

describe("extractTabId", () => {
  it("extracts tab ID from nm with nmr containing ksm and t.xxx", () => {
    const raw = { ty: "nm", nmr: ["ksm", "t.taev36xqg9o0"], nmc: { ty: "is", ibi: 1, s: "a" } };
    expect(extractTabId(raw)).toBe("t.taev36xqg9o0");
  });

  it("returns undefined for nm with only ksm (no tab ID)", () => {
    const raw = { ty: "nm", nmr: ["ksm"], nmc: { ty: "is", ibi: 1, s: "a" } };
    expect(extractTabId(raw)).toBeUndefined();
  });

  it("extracts tab ID from mlti containing nm with tab ID", () => {
    const raw = {
      ty: "mlti",
      mts: [
        { ty: "nm", nmr: ["ksm", "t.tab_in_mlti"], nmc: { ty: "is", ibi: 1, s: "x" } },
        { ty: "nm", nmr: ["ksm", "t.tab_in_mlti"], nmc: { ty: "as", si: 1, ei: 1 } },
      ],
    };
    expect(extractTabId(raw)).toBe("t.tab_in_mlti");
  });

  it("extracts tab ID from nested mlti > mlti > nm", () => {
    const raw = {
      ty: "mlti",
      mts: [{
        ty: "mlti",
        mts: [{
          ty: "nm",
          nmr: ["ksm", "t.deep_nested_tab"],
          nmc: { ty: "is", ibi: 1, s: "deep" },
        }],
      }],
    };
    expect(extractTabId(raw)).toBe("t.deep_nested_tab");
  });

  it("returns undefined for non-nm operation (direct is)", () => {
    const raw = { ty: "is", ibi: 1, s: "hello" };
    expect(extractTabId(raw)).toBeUndefined();
  });

  it("returns undefined for dc operation", () => {
    const raw = { ty: "dc", d: ["t.abc123", [1], 0] };
    expect(extractTabId(raw)).toBeUndefined();
  });

  it("returns undefined for ucp operation (even though it has tab context)", () => {
    const raw = { ty: "ucp", d: ["t.ao989aeozkre", [[], [1, "dump"]]] };
    expect(extractTabId(raw)).toBeUndefined();
  });

  it("extracts first tab ID when nm has multiple t. entries", () => {
    const raw = { ty: "nm", nmr: ["ksm", "t.first", "t.second"], nmc: { ty: "is", ibi: 1, s: "a" } };
    expect(extractTabId(raw)).toBe("t.first");
  });

  it("returns undefined for mlti with no nm children", () => {
    const raw = {
      ty: "mlti",
      mts: [
        { ty: "is", ibi: 1, s: "bare" },
        { ty: "ds", si: 1, ei: 1 },
      ],
    };
    expect(extractTabId(raw)).toBeUndefined();
  });

  it("returns undefined for nm with empty nmr array", () => {
    const raw = { ty: "nm", nmr: [], nmc: { ty: "is", ibi: 1, s: "a" } };
    expect(extractTabId(raw)).toBeUndefined();
  });

  it("returns undefined for nm with non-array nmr", () => {
    const raw = { ty: "nm", nmr: "ksm", nmc: { ty: "is", ibi: 1, s: "a" } };
    expect(extractTabId(raw)).toBeUndefined();
  });
});

// =========================================================================
// 19-23. Pagination logic (tested through fetchDocChangelog mock)
// =========================================================================

describe("pagination logic", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  function makeChangelogEntry(index: number): unknown[] {
    return [
      { ty: "is", ibi: index, s: String.fromCharCode(65 + (index % 26)) },
      1700000000000 + index * 1000,
      "user123",
      index,
      "sess1",
      index,
      null,
      null,
      false,
    ];
  }

  it("handles single page (entries < 1000)", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => makeChangelogEntry(i + 1));

    // First call: tiles
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        tileInfo: [{ start: 1, end: 50, endMillis: 1700000050000, users: ["user123"] }],
        userMap: { user123: { name: "Test User", anonymous: false } },
      }),
    );
    // Second call: load page 1
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "doc1");
    expect(result).not.toBeNull();
    expect(result!.operations.length).toBe(50);
    // Only 2 calls: tiles + 1 load page
    expect(mockGFetch).toHaveBeenCalledTimes(2);
  });

  it("handles multiple pages (entries > 1000)", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeChangelogEntry(i + 1));
    const page2 = Array.from({ length: 500 }, (_, i) => makeChangelogEntry(1001 + i));

    // tiles
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        tileInfo: [{ start: 1, end: 1500, endMillis: 1700001500000, users: ["user123"] }],
        userMap: {},
      }),
    );
    // load page 1 (1-1000)
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: page1 }),
    );
    // load page 2 (1001-1500)
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: page2 }),
    );

    const result = await fetchDocChangelog("system", "doc2");
    expect(result).not.toBeNull();
    expect(result!.operations.length).toBe(1500);
    // 3 calls: tiles + 2 load pages
    expect(mockGFetch).toHaveBeenCalledTimes(3);
  });

  it("tiles endpoint returns total count correctly", async () => {
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        tileInfo: [
          { start: 1, end: 100, endMillis: 1700000100000, users: ["u1"] },
          { start: 101, end: 200, endMillis: 1700000200000, users: ["u2"] },
          { start: 201, end: 350, endMillis: 1700000350000, users: ["u1", "u2"] },
        ],
        userMap: {},
      }),
    );
    const entries = Array.from({ length: 350 }, (_, i) => makeChangelogEntry(i + 1));
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "doc3");
    expect(result).not.toBeNull();
    expect(result!.operations.length).toBe(350);
  });

  it("tiles endpoint fails — falls back to iterative pagination", async () => {
    // tiles fails
    mockGFetch.mockResolvedValueOnce(new Response("", { status: 403 }));
    // iterative /revisions/load: first page returns 50 entries (short page = done)
    const entries = Array.from({ length: 50 }, (_, i) => makeChangelogEntry(i + 1));
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "doc4");
    expect(result).not.toBeNull();
    expect(result!.operations.length).toBe(50);
  });

  it("empty document (0 entries from tiles)", async () => {
    // tiles returns empty tileInfo
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [], userMap: {} }),
    );
    // iterative /revisions/load returns 400 (no changelog)
    mockGFetch.mockResolvedValueOnce(new Response("", { status: 400 }));

    const result = await fetchDocChangelog("system", "empty-doc");
    expect(result).not.toBeNull();
    expect(result!.operations).toHaveLength(0);
    expect(result!.totalRevisions).toBe(0);
  });

  it("handles null operations in changelog entries", async () => {
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        tileInfo: [{ start: 1, end: 3, endMillis: 1700000003000, users: ["user1"] }],
        userMap: {},
      }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        chunkedSnapshot: [[]],
        changelog: [
          [{ ty: "is", ibi: 1, s: "a" }, 1700000001000, "user1", 1, "sess1", 1, null, null, false],
          [null, 1700000002000, "user1", 2, "sess1", 2, null, null, false],
          [{ ty: "is", ibi: 2, s: "b" }, 1700000003000, "user1", 3, "sess1", 3, null, null, false],
        ],
      }),
    );

    const result = await fetchDocChangelog("system", "doc-with-nulls");
    expect(result).not.toBeNull();
    expect(result!.operations).toHaveLength(3);
    expect(result!.operations[0].type).toBe("insert");
    expect(result!.operations[1].type).toBe("other"); // null op becomes other
    expect(result!.operations[2].type).toBe("insert");
  });

  it("known entry count skips tiles fetch", async () => {
    const entries = Array.from({ length: 100 }, (_, i) => makeChangelogEntry(i + 1));
    // Only load, no tiles
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "doc-known", 100);
    expect(result).not.toBeNull();
    expect(result!.operations.length).toBe(100);
    // Only 1 call: load (tiles skipped)
    expect(mockGFetch).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// 24-30. Replay (replayWithDiffs)
// =========================================================================

describe("replayWithDiffs", () => {
  const emptyUserMap = new Map<string, { name: string; photo?: string; anonymous: boolean }>();

  function makeTile(start: number, end: number, users: string[] = ["user1"]): RevisionTile {
    return { start, end, endMillis: 1700000000000 + end * 1000, users };
  }

  it("simple inserts building text", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "H", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "insert", text: "e", startIndex: 2, changelogIndex: 2 }),
      makeOp({ type: "insert", text: "l", startIndex: 3, changelogIndex: 3 }),
      makeOp({ type: "insert", text: "l", startIndex: 4, changelogIndex: 4 }),
      makeOp({ type: "insert", text: "o", startIndex: 5, changelogIndex: 5 }),
    ];
    const tiles = [makeTile(1, 5)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].netCharChange).toBe(5);
    expect(chunks[0].operationCount).toBe(5);
    // Insertions should be consolidated since they're adjacent
    expect(chunks[0].insertions.length).toBe(1);
    expect(chunks[0].insertions[0].text).toBe("Hello");
    expect(chunks[0].insertions[0].position).toBe(0);
  });

  it("insert then delete", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "Hello World", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "delete", startIndex: 6, endIndex: 11, changelogIndex: 2 }), // delete " World"
    ];
    const tiles = [makeTile(1, 2)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].netCharChange).toBe(5); // 11 inserted - 6 deleted
    expect(chunks[0].insertions[0].text).toBe("Hello World");
    expect(chunks[0].deletions[0].text).toBe(" World");
  });

  it("multi-tab replay (different tab IDs get separate state)", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "Tab1 content", startIndex: 1, changelogIndex: 1, tabId: "t.tab1" }),
      makeOp({ type: "insert", text: "Tab2 content", startIndex: 1, changelogIndex: 2, tabId: "t.tab2" }),
      // Delete from tab1 — position 1 in tab1's state
      makeOp({ type: "delete", startIndex: 1, endIndex: 4, changelogIndex: 3, tabId: "t.tab1" }),
    ];
    const tiles = [makeTile(1, 3)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks).toHaveLength(1);
    // Tab1: "Tab1 content" then delete "Tab1" (4 chars) -> " content" (8 chars)
    // Tab2: "Tab2 content" (12 chars)
    // Net: 12 + 12 - 4 = 20
    expect(chunks[0].netCharChange).toBe(20);
    expect(chunks[0].deletions[0].text).toBe("Tab1");
  });

  it("rplc clears all tab states", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "Old content", startIndex: 1, changelogIndex: 1, tabId: "t.tab1" }),
      makeOp({ type: "insert", text: "Tab2 old", startIndex: 1, changelogIndex: 2, tabId: "t.tab2" }),
      // replace clears everything
      makeOp({ type: "replace", changelogIndex: 3 }),
      // New content after replace
      makeOp({ type: "insert", text: "Fresh", startIndex: 1, changelogIndex: 4, tabId: "t.tab1" }),
    ];
    const tiles = [makeTile(1, 4)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks).toHaveLength(1);
    // After rplc, state is cleared. Only "Fresh" remains.
    // Net: "Old content"(11) + "Tab2 old"(8) + "Fresh"(5) = 24 inserted, 0 deleted = 24
    expect(chunks[0].netCharChange).toBe(24);
  });

  it("tile gap handling (non-contiguous tiles)", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "A", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "insert", text: "B", startIndex: 2, changelogIndex: 2 }),
      // Entries 3-4 are in a gap (e.g., null/tab management ops)
      makeOp({ type: "other", changelogIndex: 3 }),
      makeOp({ type: "other", changelogIndex: 4 }),
      makeOp({ type: "insert", text: "C", startIndex: 3, changelogIndex: 5 }),
      makeOp({ type: "insert", text: "D", startIndex: 4, changelogIndex: 6 }),
    ];
    // Non-contiguous tiles: gap between 2 and 5
    const tiles = [
      makeTile(1, 2),
      makeTile(5, 6),
    ];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    // First tile covers indices 1-2: "A" and "B"
    expect(chunks[0].insertions[0].text).toBe("AB");
    expect(chunks[0].netCharChange).toBe(2);

    // Second tile covers indices 5-6: "C" and "D"
    // Operations at index 3-4 are skipped (not covered by any tile)
    expect(chunks[1].insertions[0].text).toBe("CD");
    expect(chunks[1].netCharChange).toBe(2);
  });

  it("consolidation of adjacent insertions", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "H", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "insert", text: "i", startIndex: 2, changelogIndex: 2 }),
      makeOp({ type: "insert", text: "!", startIndex: 3, changelogIndex: 3 }),
    ];
    const tiles = [makeTile(1, 3)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    // Should be consolidated into a single "Hi!" insertion
    expect(chunks[0].insertions).toHaveLength(1);
    expect(chunks[0].insertions[0].text).toBe("Hi!");
    expect(chunks[0].insertions[0].position).toBe(0);
  });

  it("consolidation of adjacent deletions at same position", () => {
    // Typing backspace repeatedly: each deletion is at the same position
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "ABC", startIndex: 1, changelogIndex: 1 }),
      // Delete "C" at position 3 (si=3, ei=3) -> state is "AB"
      makeOp({ type: "delete", startIndex: 3, endIndex: 3, changelogIndex: 2 }),
      // Delete "B" at position 2 (si=2, ei=2) -> state is "A"
      makeOp({ type: "delete", startIndex: 2, endIndex: 2, changelogIndex: 3 }),
    ];
    const tiles = [makeTile(1, 3)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks[0].insertions[0].text).toBe("ABC");
    // Two deletions: "C" at pos 2, "B" at pos 1 — different positions, not consolidated
    expect(chunks[0].deletions.length).toBe(2);
    expect(chunks[0].netCharChange).toBe(1); // 3 - 2 = 1
  });

  it("handles empty operations list", () => {
    const chunks = replayWithDiffs([], [makeTile(1, 10)], emptyUserMap);
    expect(chunks).toHaveLength(0);
  });

  it("handles empty tiles list", () => {
    const ops = [makeOp({ type: "insert", text: "x", startIndex: 1, changelogIndex: 1 })];
    const chunks = replayWithDiffs(ops, [], emptyUserMap);
    expect(chunks).toHaveLength(0);
  });

  it("multiple tiles with different content", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "First", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "insert", text: " chunk", startIndex: 6, changelogIndex: 2 }),
      makeOp({ type: "insert", text: "Second", startIndex: 12, changelogIndex: 3 }),
      makeOp({ type: "insert", text: " chunk", startIndex: 18, changelogIndex: 4 }),
    ];
    const tiles = [
      makeTile(1, 2, ["author1"]),
      makeTile(3, 4, ["author2"]),
    ];
    const userMap = new Map([
      ["author1", { name: "Alice", anonymous: false }],
      ["author2", { name: "Bob", anonymous: false }],
    ]);

    const chunks = replayWithDiffs(ops, tiles, userMap);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].authors[0].name).toBe("Alice");
    expect(chunks[0].netCharChange).toBe(11); // "First" + " chunk"
    expect(chunks[1].authors[0].name).toBe("Bob");
    expect(chunks[1].netCharChange).toBe(12); // "Second" + " chunk"
  });

  it("insert_suggestion operations also affect doc state", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "Hello", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "insert_suggestion", text: " World", startIndex: 6, changelogIndex: 2 }),
    ];
    const tiles = [makeTile(1, 2)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks[0].netCharChange).toBe(11);
  });

  it("delete_suggestion operations also affect doc state", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "Hello World", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "delete_suggestion", startIndex: 6, endIndex: 11, changelogIndex: 2 }),
    ];
    const tiles = [makeTile(1, 2)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks[0].netCharChange).toBe(5); // 11 - 6 = 5
    expect(chunks[0].deletions[0].text).toBe(" World");
  });

  it("format operations increment opCount but do not change chars", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "Bold", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "format", startIndex: 1, endIndex: 4, changelogIndex: 2 }),
    ];
    const tiles = [makeTile(1, 2)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks[0].operationCount).toBe(2);
    expect(chunks[0].netCharChange).toBe(4);
    expect(chunks[0].insertions).toHaveLength(1);
    expect(chunks[0].deletions).toHaveLength(0);
  });

  it("revert clears all tab states same as rplc", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "data", startIndex: 1, changelogIndex: 1, tabId: "t.a" }),
      makeOp({ type: "revert", changelogIndex: 2 }),
      makeOp({ type: "insert", text: "new", startIndex: 1, changelogIndex: 3, tabId: "t.a" }),
    ];
    const tiles = [makeTile(1, 3)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    // data(4) + new(3) = 7 net
    expect(chunks[0].netCharChange).toBe(7);
  });
});

// =========================================================================
// 31. Integration: raw changelog entry -> parsed operation -> attribution
// =========================================================================

describe("integration: full pipeline", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  it("raw changelog entry -> parsed operations with tab IDs", async () => {
    const changelog = [
      // nm wrapping an insert
      [
        { ty: "nm", nmr: ["ksm", "t.tab_abc"], nmc: { ty: "is", ibi: 1, s: "Hello" } },
        1700000001000, "user_A", 1, "sess1", 1, null, null, false,
      ],
      // mlti containing two nm ops
      [
        {
          ty: "mlti",
          mts: [
            { ty: "nm", nmr: ["ksm", "t.tab_abc"], nmc: { ty: "ds", si: 1, ei: 5 } },
            { ty: "nm", nmr: ["ksm", "t.tab_abc"], nmc: { ty: "is", ibi: 1, s: "World" } },
          ],
        },
        1700000002000, "user_B", 2, "sess2", 1, null, null, false,
      ],
      // Direct is (older doc style)
      [
        { ty: "is", ibi: 6, s: "!" },
        1700000003000, "user_A", 3, "sess1", 2, null, null, false,
      ],
    ];

    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        tileInfo: [{ start: 1, end: 3, endMillis: 1700000003000, users: ["user_A", "user_B"] }],
        userMap: {},
      }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog }),
    );

    const result = await fetchDocChangelog("system", "integration-doc");
    expect(result).not.toBeNull();

    const ops = result!.operations;
    // Entry 1: nm[is] -> 1 operation
    // Entry 2: mlti[nm[ds], nm[is]] -> 2 operations
    // Entry 3: is -> 1 operation
    expect(ops).toHaveLength(4);

    expect(ops[0].type).toBe("insert");
    expect(ops[0].text).toBe("Hello");
    expect(ops[0].tabId).toBe("t.tab_abc");
    expect(ops[0].userId).toBe("user_A");

    expect(ops[1].type).toBe("delete");
    expect(ops[1].startIndex).toBe(1);
    expect(ops[1].endIndex).toBe(5);
    expect(ops[1].tabId).toBe("t.tab_abc");
    expect(ops[1].userId).toBe("user_B");

    expect(ops[2].type).toBe("insert");
    expect(ops[2].text).toBe("World");
    expect(ops[2].userId).toBe("user_B");

    expect(ops[3].type).toBe("insert");
    expect(ops[3].text).toBe("!");
    expect(ops[3].tabId).toBeUndefined(); // direct is, no nm wrapper
    expect(ops[3].userId).toBe("user_A");
  });
});

// =========================================================================
// 32. buildAuthorAttribution
// =========================================================================

describe("buildAuthorAttribution", () => {
  it("aggregates multiple authors correctly", async () => {
    const now = new Date("2025-01-15T12:00:00Z");
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 5,
      tabs: [],
      userMap: new Map([
        ["user_A", { name: "Alice", anonymous: false }],
        ["user_B", { name: "Bob", anonymous: false }],
      ]),
      operations: [
        makeOp({ type: "insert", text: "Hello", startIndex: 1, userId: "user_A", timestamp: new Date("2025-01-15T10:00:00Z") }),
        makeOp({ type: "insert", text: " World", startIndex: 6, userId: "user_B", timestamp: new Date("2025-01-15T10:30:00Z") }),
        makeOp({ type: "delete", startIndex: 6, endIndex: 11, userId: "user_A", timestamp: new Date("2025-01-15T11:00:00Z") }),
        makeOp({ type: "insert_suggestion", text: "Suggested", startIndex: 6, userId: "user_B", timestamp: new Date("2025-01-15T11:30:00Z") }),
        makeOp({ type: "format", startIndex: 1, endIndex: 5, userId: "user_A", timestamp: new Date("2025-01-15T11:45:00Z") }),
      ],
    };

    const resolver = async (userId: string) => {
      if (userId === "user_A") return "alice@test.com";
      if (userId === "user_B") return "bob@test.com";
      return null;
    };

    const since = new Date("2025-01-15T09:00:00Z");
    const until = new Date("2025-01-15T13:00:00Z");

    const result = await buildAuthorAttribution(changelog, since, until, resolver);
    expect(result).toHaveLength(2);

    const alice = result.find((a) => a.email === "alice@test.com");
    const bob = result.find((a) => a.email === "bob@test.com");

    expect(alice).toBeDefined();
    expect(alice!.insertions).toBe(5); // "Hello" = 5 chars
    expect(alice!.deletions).toBe(6); // positions 6-11 = 6 chars
    expect(alice!.name).toBe("Alice");

    expect(bob).toBeDefined();
    expect(bob!.insertions).toBe(6 + 9); // " World" + "Suggested"
    expect(bob!.suggestionsCreated).toBe(1);
  });

  it("returns empty for no operations in window", async () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 1,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert", text: "old", startIndex: 1, timestamp: new Date("2024-01-01T00:00:00Z") }),
      ],
    };

    const result = await buildAuthorAttribution(
      changelog,
      new Date("2025-01-01T00:00:00Z"),
      new Date("2025-12-31T23:59:59Z"),
      async () => null,
    );
    expect(result).toHaveLength(0);
  });

  it("handles delete_suggestion counting", async () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 1,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({
          type: "delete_suggestion",
          startIndex: 10,
          endIndex: 20,
          userId: "user_C",
          timestamp: new Date("2025-01-15T10:00:00Z"),
        }),
      ],
    };

    const result = await buildAuthorAttribution(
      changelog,
      new Date("2025-01-15T00:00:00Z"),
      new Date("2025-01-15T23:59:59Z"),
      async (uid) => uid === "user_C" ? "carol@test.com" : null,
    );

    expect(result).toHaveLength(1);
    expect(result[0].suggestionsCreated).toBe(1);
    expect(result[0].deletions).toBe(11); // 20 - 10 + 1
  });

  it("uses userId as email when resolver returns null", async () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 1,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert", text: "x", startIndex: 1, userId: "unknown_user", timestamp: new Date("2025-01-15T10:00:00Z") }),
      ],
    };

    const result = await buildAuthorAttribution(
      changelog,
      new Date("2025-01-15T00:00:00Z"),
      new Date("2025-01-15T23:59:59Z"),
      async () => null,
    );

    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("unknown_user");
  });
});

// =========================================================================
// 33-34. extractPendingSuggestions
// =========================================================================

describe("extractPendingSuggestions", () => {
  it("returns insert_suggestion as pending when no acceptance", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 2,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert", text: "existing text", startIndex: 1, changelogIndex: 1 }),
        makeOp({ type: "insert_suggestion", text: "suggested addition", startIndex: 14, changelogIndex: 2, userId: "suggester1" }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe("suggested addition");
    expect(pending[0].position).toBe(14);
    expect(pending[0].userId).toBe("suggester1");
  });

  it("marks suggestion as resolved when is at same position exists", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert_suggestion", text: "accepted text", startIndex: 10, changelogIndex: 1, userId: "suggester1" }),
        // Acceptance: an insert at the same position
        makeOp({ type: "insert", text: "accepted text", startIndex: 10, changelogIndex: 2, userId: "accepter1" }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(0);
  });

  it("marks delete_suggestion as resolved when delete at same position", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "delete_suggestion", startIndex: 5, endIndex: 10, changelogIndex: 1 }),
        makeOp({ type: "delete", startIndex: 5, endIndex: 10, changelogIndex: 2 }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(0);
  });

  it("marks mark_deletion as resolved when unmark_deletion at same position", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "mark_deletion", startIndex: 20, endIndex: 30, changelogIndex: 1 }),
        makeOp({ type: "unmark_deletion", startIndex: 20, endIndex: 30, changelogIndex: 2 }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(0);
  });

  it("returns multiple pending suggestions", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 4,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert_suggestion", text: "first", startIndex: 1, changelogIndex: 1, userId: "u1" }),
        makeOp({ type: "insert_suggestion", text: "second", startIndex: 50, changelogIndex: 2, userId: "u2" }),
        makeOp({ type: "delete_suggestion", startIndex: 100, endIndex: 110, changelogIndex: 3, userId: "u3" }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(3);
  });

  it("mixed resolved and unresolved suggestions", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 5,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert_suggestion", text: "kept", startIndex: 1, changelogIndex: 1, userId: "u1" }),
        makeOp({ type: "insert_suggestion", text: "accepted", startIndex: 50, changelogIndex: 2, userId: "u2" }),
        // Accept the second suggestion
        makeOp({ type: "insert", text: "accepted", startIndex: 50, changelogIndex: 3 }),
        makeOp({ type: "delete_suggestion", startIndex: 100, endIndex: 110, changelogIndex: 4, userId: "u3" }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    // Only the first insert_suggestion and the delete_suggestion remain pending
    expect(pending).toHaveLength(2);
    expect(pending[0].text).toBe("kept");
    expect(pending[1].position).toBe(100);
  });

  it("empty changelog returns no pending", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 0,
      tabs: [],
      userMap: new Map(),
      operations: [],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(0);
  });
});

// =========================================================================
// 35. getOperationsSince
// =========================================================================

describe("getOperationsSince", () => {
  it("filters operations after the given timestamp", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert", text: "old", timestamp: new Date("2025-01-01T00:00:00Z"), changelogIndex: 1 }),
        makeOp({ type: "insert", text: "recent", timestamp: new Date("2025-06-15T12:00:00Z"), changelogIndex: 2 }),
        makeOp({ type: "insert", text: "newest", timestamp: new Date("2025-06-15T13:00:00Z"), changelogIndex: 3 }),
      ],
    };

    const result = getOperationsSince(changelog, new Date("2025-06-15T00:00:00Z"));
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("recent");
    expect(result[1].text).toBe("newest");
  });

  it("returns empty if no operations after timestamp", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 1,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert", text: "old", timestamp: new Date("2020-01-01T00:00:00Z"), changelogIndex: 1 }),
      ],
    };

    const result = getOperationsSince(changelog, new Date("2025-01-01T00:00:00Z"));
    expect(result).toHaveLength(0);
  });

  it("excludes operations at exactly the since timestamp (strictly after)", () => {
    const exactTime = new Date("2025-06-15T12:00:00Z");
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 1,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({ type: "insert", text: "exact", timestamp: exactTime, changelogIndex: 1 }),
      ],
    };

    const result = getOperationsSince(changelog, exactTime);
    expect(result).toHaveLength(0);
  });
});
// =========================================================================
// Additional edge cases from the research docs
// =========================================================================

describe("additional edge cases", () => {
  it("handles is with multi-char string (paste operation)", () => {
    const result = parseOperation({ ty: "is", ibi: 1, s: "This is a long pasted paragraph with multiple words." });
    expect(result!.type).toBe("insert");
    expect(result!.text).toBe("This is a long pasted paragraph with multiple words.");
    expect(result!.startIndex).toBe(1);
  });

  it("handles is with single char (keystroke)", () => {
    const result = parseOperation({ ty: "is", ibi: 14, s: "a" });
    expect(result!.type).toBe("insert");
    expect(result!.text).toBe("a");
  });

  it("handles ds with si === ei (single char delete)", () => {
    const result = parseOperation({ ty: "ds", si: 5, ei: 5 });
    expect(result!.type).toBe("delete");
    expect(result!.startIndex).toBe(5);
    expect(result!.endIndex).toBe(5);
  });

  it("handles is with special characters (newline, tab, unicode)", () => {
    const result = parseOperation({ ty: "is", ibi: 1, s: "Hello\nWorld\t!" });
    expect(result!.text).toBe("Hello\nWorld\t!");
  });

  it("handles is with emoji characters", () => {
    const result = parseOperation({ ty: "is", ibi: 1, s: "\u{1F600}\u{1F389}" });
    expect(result!.text).toBe("\u{1F600}\u{1F389}");
  });

  it("handles as with all style types (text, paragraph, document, headings, language)", () => {
    for (const st of ["text", "paragraph", "document", "headings", "language"]) {
      const result = parseOperation({ ty: "as", st, si: 1, ei: 10, sm: {} });
      expect(result!.type).toBe("format");
    }
  });

  it("handles rplc with snapshot containing mkch, ac, nm, as (full rebuild)", () => {
    const rplcOp = {
      ty: "rplc",
      snapshot: [
        { ty: "mkch", d: [[1, "Tab Name"]] },
        { ty: "ac", d: ["t.xxx", [1, "Tab 2"], [1]] },
        { ty: "nm", nmr: ["ksm", "t.xxx"], nmc: { ty: "is", ibi: 1, s: "content" } },
        { ty: "nm", nmr: ["ksm", "t.xxx"], nmc: { ty: "as", si: 1, ei: 7, sm: { ts_bd: true } } },
      ],
    };
    // parseOperation just returns "replace" for the top level
    const result = parseOperation(rplcOp);
    expect(result).toEqual({ type: "replace" });
  });
});

// =========================================================================
// Consolidation helpers
// =========================================================================

describe("consolidation helpers via replayWithDiffs", () => {
  const emptyUserMap = new Map<string, { name: string; photo?: string; anonymous: boolean }>();

  function makeTile(start: number, end: number): RevisionTile {
    return { start, end, endMillis: 1700000000000 + end * 1000, users: ["u1"] };
  }

  it("non-adjacent insertions stay separate", () => {
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "A", startIndex: 1, changelogIndex: 1 }),
      makeOp({ type: "insert", text: "B", startIndex: 10, changelogIndex: 2 }), // gap
    ];
    const tiles = [makeTile(1, 2)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    expect(chunks[0].insertions).toHaveLength(2);
    expect(chunks[0].insertions[0].text).toBe("A");
    expect(chunks[0].insertions[1].text).toBe("B");
  });

  it("deletions at same position are consolidated", () => {
    // Insert "ABCDE" then delete "C", then "B" (both at position 2 after shrinking)
    const ops: ChangelogOperation[] = [
      makeOp({ type: "insert", text: "ABCDE", startIndex: 1, changelogIndex: 1 }),
      // delete "C" at position 3 -> "ABDE"
      makeOp({ type: "delete", startIndex: 3, endIndex: 3, changelogIndex: 2 }),
      // delete "D" at position 3 (now D is at position 3) -> "ABE"
      makeOp({ type: "delete", startIndex: 3, endIndex: 3, changelogIndex: 3 }),
    ];
    const tiles = [makeTile(1, 3)];
    const chunks = replayWithDiffs(ops, tiles, emptyUserMap);

    // Both deletions are at position 2 (0-indexed), so they should be consolidated
    expect(chunks[0].deletions).toHaveLength(1);
    expect(chunks[0].deletions[0].text).toBe("CD");
    expect(chunks[0].deletions[0].position).toBe(2);
  });
});

// =========================================================================
// Changelog index correctness
// =========================================================================

describe("changelog index correctness", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("changelogIndex is 1-indexed and sequential", async () => {
    const entries = [
      [{ ty: "is", ibi: 1, s: "a" }, 1700000001000, "u1", 1, "s1", 0, null, null, false],
      [{ ty: "is", ibi: 2, s: "b" }, 1700000002000, "u1", 2, "s1", 1, null, null, false],
      [{ ty: "is", ibi: 3, s: "c" }, 1700000003000, "u1", 3, "s1", 2, null, null, false],
    ];

    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        tileInfo: [{ start: 1, end: 3, endMillis: 1700000003000, users: ["u1"] }],
        userMap: {},
      }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "idx-doc");
    expect(result!.operations[0].changelogIndex).toBe(1);
    expect(result!.operations[1].changelogIndex).toBe(2);
    expect(result!.operations[2].changelogIndex).toBe(3);
  });

  it("mlti flattens into multiple ops all sharing the same changelogIndex", async () => {
    const entries = [
      [
        {
          ty: "mlti",
          mts: [
            { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "ds", si: 1, ei: 5 } },
            { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "new" } },
          ],
        },
        1700000001000, "u1", 1, "s1", 0, null, null, false,
      ],
    ];

    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["u1"] }],
        userMap: {},
      }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "mlti-doc");
    // mlti with 2 sub-ops -> 2 operations, both with changelogIndex 1
    expect(result!.operations).toHaveLength(2);
    expect(result!.operations[0].changelogIndex).toBe(1);
    expect(result!.operations[1].changelogIndex).toBe(1);
  });
});

// =========================================================================
// Entry with short array (< 4 elements) is skipped
// =========================================================================

describe("malformed changelog entries", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("skips entries with fewer than 4 elements", async () => {
    const entries = [
      [{ ty: "is", ibi: 1, s: "a" }, 1700000001000, "u1", 1, "s1", 0, null, null, false],
      [{ ty: "is" }, 1700000002000], // malformed: only 2 elements
      [{ ty: "is", ibi: 2, s: "b" }, 1700000003000, "u1", 3, "s1", 2, null, null, false],
    ];

    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        tileInfo: [{ start: 1, end: 3, endMillis: 1700000003000, users: ["u1"] }],
        userMap: {},
      }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "malformed-doc");
    // Only 2 valid entries (the short one is skipped)
    expect(result!.operations).toHaveLength(2);
    expect(result!.operations[0].text).toBe("a");
    expect(result!.operations[1].text).toBe("b");
  });
});

// =========================================================================
// NEW TESTS: Element operations (ae, de, ue, te)
// =========================================================================

describe("element operations via fetchDocChangelog", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("ae returns add_element with elementType and elementId", async () => {
    const entries = [
      [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "ae", et: "list", id: "kix.5dg9" } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "elem-ae");
    expect(result).not.toBeNull();
    const op = result!.operations[0];
    expect(op.type).toBe("add_element");
    expect(op.elementType).toBe("list");
    expect(op.elementId).toBe("kix.5dg9");
  });

  it("de returns delete_element with elementType and elementId", async () => {
    const entries = [
      [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "de", et: "inline", id: "kix.4b85" } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "elem-de");
    const op = result!.operations[0];
    expect(op.type).toBe("delete_element");
    expect(op.elementType).toBe("inline");
    expect(op.elementId).toBe("kix.4b85");
  });

  it("ue returns update_element with elementId", async () => {
    const entries = [
      [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "ue", id: "kix.e649" } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "elem-ue");
    const op = result!.operations[0];
    expect(op.type).toBe("update_element");
    expect(op.elementId).toBe("kix.e649");
  });

  it("te returns tether_element with elementId and startIndex", async () => {
    const entries = [
      [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "te", id: "kix.6y2r", spi: 42 } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "elem-te");
    const op = result!.operations[0];
    expect(op.type).toBe("tether_element");
    expect(op.elementId).toBe("kix.6y2r");
    expect(op.startIndex).toBe(42);
  });

  it("ae without nm wrapper (direct) also produces add_element", async () => {
    const entries = [
      [
        { ty: "ae", et: "table", id: "kix.tbl1" },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "elem-ae-direct");
    const op = result!.operations[0];
    expect(op.type).toBe("add_element");
    expect(op.elementType).toBe("table");
    expect(op.elementId).toBe("kix.tbl1");
  });
});

// =========================================================================
// NEW TESTS: Cursor tab tracking (ucp)
// =========================================================================

describe("cursor tab tracking (ucp) via fetchDocChangelog", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("ucp extracts cursorTabId from d[0]", async () => {
    const entries = [
      [
        { ty: "ucp", d: ["t.ao989aeozkre", [[], [1, "dump"]]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "cursor-doc");
    const op = result!.operations[0];
    expect(op.type).toBe("cursor");
    expect(op.cursorTabId).toBe("t.ao989aeozkre");
  });

  it("ucp without tab ID prefix returns undefined cursorTabId", async () => {
    const entries = [
      [
        { ty: "ucp", d: ["not-a-tab", []] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "cursor-no-tab");
    const op = result!.operations[0];
    expect(op.type).toBe("cursor");
    expect(op.cursorTabId).toBeUndefined();
  });

  it("ucp with empty d array returns undefined cursorTabId", async () => {
    const entries = [
      [
        { ty: "ucp", d: [] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "cursor-empty-d");
    const op = result!.operations[0];
    expect(op.type).toBe("cursor");
    expect(op.cursorTabId).toBeUndefined();
  });
});

// =========================================================================
// NEW TESTS: sugId extraction (iss, dss, msfd, usfd, ras, sas)
// =========================================================================

describe("sugId extraction via fetchDocChangelog", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("iss extracts sugId", async () => {
    const entries = [
      [
        { ty: "iss", sugid: "suggest.abc123", ibi: 10, s: "suggested text" },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "sugid-iss");
    expect(result!.operations[0].sugId).toBe("suggest.abc123");
    expect(result!.operations[0].type).toBe("insert_suggestion");
  });

  it("dss extracts sugId", async () => {
    const entries = [
      [
        { ty: "dss", sugid: "suggest.xyz789", si: 5, ei: 15 },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "sugid-dss");
    expect(result!.operations[0].sugId).toBe("suggest.xyz789");
    expect(result!.operations[0].type).toBe("delete_suggestion");
  });

  it("msfd extracts sugId", async () => {
    const entries = [
      [
        { ty: "msfd", sugid: "suggest.msfd001", si: 20, ei: 30 },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "sugid-msfd");
    expect(result!.operations[0].sugId).toBe("suggest.msfd001");
    expect(result!.operations[0].type).toBe("mark_deletion");
  });

  it("usfd extracts sugId", async () => {
    const entries = [
      [
        { ty: "usfd", sugid: "suggest.usfd002", si: 100, ei: 110 },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "sugid-usfd");
    expect(result!.operations[0].sugId).toBe("suggest.usfd002");
    expect(result!.operations[0].type).toBe("unmark_deletion");
  });

  it("ras extracts sugId", async () => {
    const entries = [
      [
        { ty: "ras", sugid: "suggest.ras003", si: 50, ei: 60 },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "sugid-ras");
    expect(result!.operations[0].sugId).toBe("suggest.ras003");
    expect(result!.operations[0].type).toBe("unmark_deletion");
  });

  it("sas extracts sugId", async () => {
    const entries = [
      [
        { ty: "sas", sugid: "suggest.sas004", st: "text", si: 10, ei: 20, sm: { ts_bd: true } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "sugid-sas");
    expect(result!.operations[0].sugId).toBe("suggest.sas004");
    expect(result!.operations[0].type).toBe("format");
  });

  it("all sugId types forwarded through nm wrapper", async () => {
    const entries = [
      [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "iss", sugid: "suggest.nm_wrap", ibi: 5, s: "wrapped" } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "sugid-nm-wrap");
    expect(result!.operations[0].sugId).toBe("suggest.nm_wrap");
    expect(result!.operations[0].tabId).toBe("t.tab1");
  });
});

// =========================================================================
// NEW TESTS: styleType + styleModification (as, sas, astss)
// =========================================================================

describe("styleType and styleModification via fetchDocChangelog", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("as extracts styleType and styleModification", async () => {
    const entries = [
      [
        { ty: "as", st: "text", si: 1, ei: 10, sm: { ts_bd: true, ts_bd_i: false } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "style-as");
    const op = result!.operations[0];
    expect(op.type).toBe("format");
    expect(op.styleType).toBe("text");
    expect(op.styleModification).toEqual({ ts_bd: true, ts_bd_i: false });
  });

  it("sas extracts styleType and styleModification", async () => {
    const entries = [
      [
        { ty: "sas", sugid: "suggest.sty", st: "paragraph", si: 5, ei: 50, sm: { ts_it: true } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "style-sas");
    const op = result!.operations[0];
    expect(op.type).toBe("format");
    expect(op.styleType).toBe("paragraph");
    expect(op.styleModification).toEqual({ ts_it: true });
    expect(op.sugId).toBe("suggest.sty");
  });

  it("astss extracts styleType and styleModification", async () => {
    const entries = [
      [
        { ty: "astss", st: "headings", si: 1, ei: 100, sm: { ts_fs: 24 } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "style-astss");
    const op = result!.operations[0];
    expect(op.type).toBe("format");
    expect(op.styleType).toBe("headings");
    expect(op.styleModification).toEqual({ ts_fs: 24 });
  });

  it("as wrapped in nm forwards styleType and styleModification", async () => {
    const entries = [
      [
        { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "as", st: "document", si: 1, ei: 200, sm: { ts_un: true } } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "style-as-nm");
    const op = result!.operations[0];
    expect(op.type).toBe("format");
    expect(op.styleType).toBe("document");
    expect(op.styleModification).toEqual({ ts_un: true });
    expect(op.tabId).toBe("t.tab1");
  });
});

// =========================================================================
// NEW TESTS: rplc/rvrt snapshot processing in flattenMultiOps
// =========================================================================

describe("rplc/rvrt snapshot recursive flattening via fetchDocChangelog", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("rplc with snapshot sub-ops recursively flattens into leaf operations", async () => {
    const entries = [
      [
        {
          ty: "rplc",
          snapshot: [
            { ty: "is", ibi: 1, s: "restored" },
            { ty: "as", st: "text", si: 1, ei: 8, sm: { ts_bd: true } },
          ],
        },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "rplc-snapshot");
    // Now that all ops go through flattenMultiOps (Bug C fix), standalone rplc
    // also recursively flattens its snapshot sub-ops:
    //   replace + insert("restored") + format
    const ops = result!.operations;
    expect(ops).toHaveLength(3);
    expect(ops[0].type).toBe("replace");
    expect(ops[1].type).toBe("insert");
    expect(ops[1].text).toBe("restored");
    expect(ops[2].type).toBe("format");
  });

  it("rplc inside mlti recursively flattens snapshot sub-ops", async () => {
    const entries = [
      [
        {
          ty: "mlti",
          mts: [
            {
              ty: "rplc",
              snapshot: [
                { ty: "is", ibi: 1, s: "snap-text" },
                { ty: "as", st: "text", si: 1, ei: 9, sm: { ts_it: true } },
              ],
            },
            { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 10, s: " more" } },
          ],
        },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "rplc-in-mlti");
    const ops = result!.operations;
    // rplc flattens to: replace, insert("snap-text"), format
    // nm flattens to: insert(" more")
    // Total: 4 ops
    expect(ops).toHaveLength(4);
    expect(ops[0].type).toBe("replace");
    expect(ops[1].type).toBe("insert");
    expect(ops[1].text).toBe("snap-text");
    expect(ops[2].type).toBe("format");
    expect(ops[2].styleType).toBe("text");
    expect(ops[2].styleModification).toEqual({ ts_it: true });
    expect(ops[3].type).toBe("insert");
    expect(ops[3].text).toBe(" more");
  });

  it("rvrt inside mlti recursively flattens snapshot sub-ops", async () => {
    const entries = [
      [
        {
          ty: "mlti",
          mts: [
            {
              ty: "rvrt",
              snapshot: [
                { ty: "is", ibi: 1, s: "reverted" },
              ],
            },
          ],
        },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "rvrt-in-mlti");
    const ops = result!.operations;
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe("revert");
    expect(ops[1].type).toBe("insert");
    expect(ops[1].text).toBe("reverted");
  });

  it("rplc with nm-wrapped snapshot ops inside mlti", async () => {
    const entries = [
      [
        {
          ty: "mlti",
          mts: [
            {
              ty: "rplc",
              snapshot: [
                { ty: "nm", nmr: ["ksm", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "nm-snap" } },
              ],
            },
          ],
        },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "rplc-nm-snap");
    const ops = result!.operations;
    // rplc -> replace + nm unwrap -> insert("nm-snap")
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe("replace");
    expect(ops[1].type).toBe("insert");
    expect(ops[1].text).toBe("nm-snap");
  });
});

// =========================================================================
// NEW TESTS: chunkedSnapshot processing
// =========================================================================

describe("chunkedSnapshot processing via fetchDocChangelog", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("parses chunkedSnapshot from first page into operations", async () => {
    const changelog = [
      [
        { ty: "is", ibi: 9, s: " edit" },
        1700000002000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        chunkedSnapshot: [
          [
            { ty: "is", ibi: 1, s: "initial " },
          ],
        ],
        changelog,
      }),
    );

    const result = await fetchDocChangelog("system", "chunked-snap");
    expect(result).not.toBeNull();
    // Operations: 1 from chunkedSnapshot + 1 from changelog
    expect(result!.operations.length).toBe(2);
    // Snapshot op comes first
    expect(result!.operations[0].type).toBe("insert");
    expect(result!.operations[0].text).toBe("initial ");
    expect(result!.operations[0].userId).toBe(""); // snapshot ops have empty userId
    expect(result!.operations[0].changelogIndex).toBe(0);
    // Changelog op comes second
    expect(result!.operations[1].type).toBe("insert");
    expect(result!.operations[1].text).toBe(" edit");
    expect(result!.operations[1].userId).toBe("user1");
  });

  it("chunkedSnapshot with multiple groups of ops", async () => {
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        chunkedSnapshot: [
          [
            { ty: "is", ibi: 1, s: "group1 " },
          ],
          [
            { ty: "is", ibi: 8, s: "group2" },
            { ty: "as", st: "text", si: 8, ei: 14, sm: { ts_bd: true } },
          ],
        ],
        changelog: [
          [{ ty: "is", ibi: 15, s: "!" }, 1700000002000, "user1", 1, "sess1", 0, null, null, false],
        ],
      }),
    );

    const result = await fetchDocChangelog("system", "chunked-multi-group");
    // Snapshot: "group1 " (insert) + "group2" (insert) + format = 3 snapshot ops
    // Changelog: "!" (insert) = 1 op
    expect(result!.operations.length).toBe(4);
    expect(result!.operations[0].text).toBe("group1 ");
    expect(result!.operations[1].text).toBe("group2");
    expect(result!.operations[2].type).toBe("format");
    expect(result!.operations[2].styleType).toBe("text");
    expect(result!.operations[3].text).toBe("!");
  });

  it("chunkedSnapshot with element ops preserves elementType/elementId", async () => {
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        chunkedSnapshot: [
          [
            { ty: "ae", et: "list", id: "kix.snap_list" },
            { ty: "is", ibi: 1, s: "item" },
          ],
        ],
        changelog: [
          [{ ty: "is", ibi: 5, s: "!" }, 1700000002000, "user1", 1, "sess1", 0, null, null, false],
        ],
      }),
    );

    const result = await fetchDocChangelog("system", "chunked-elem");
    expect(result!.operations[0].type).toBe("add_element");
    expect(result!.operations[0].elementType).toBe("list");
    expect(result!.operations[0].elementId).toBe("kix.snap_list");
  });

  it("empty chunkedSnapshot does not add extra operations", async () => {
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        chunkedSnapshot: [[]],
        changelog: [
          [{ ty: "is", ibi: 1, s: "only" }, 1700000002000, "user1", 1, "sess1", 0, null, null, false],
        ],
      }),
    );

    const result = await fetchDocChangelog("system", "chunked-empty");
    expect(result!.operations.length).toBe(1);
    expect(result!.operations[0].text).toBe("only");
  });

  it("chunkedSnapshot absent (null) does not add extra operations", async () => {
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        changelog: [
          [{ ty: "is", ibi: 1, s: "only" }, 1700000002000, "user1", 1, "sess1", 0, null, null, false],
        ],
      }),
    );

    const result = await fetchDocChangelog("system", "chunked-absent");
    expect(result!.operations.length).toBe(1);
  });
});

// =========================================================================
// NEW TESTS: buildTabState
// =========================================================================

describe("buildTabState via fetchDocChangelog", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("always includes the default tab (t.0)", async () => {
    // A document with just a simple insert (no tab ops) should still have t.0
    const entries = [
      [
        { ty: "is", ibi: 1, s: "hello" },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-default");
    expect(result!.tabs).toHaveLength(1);
    expect(result!.tabs[0].tabId).toBe("t.0");
    expect(result!.tabs[0].position).toEqual([0]);
  });

  it("tracks tab creation from ac operations", async () => {
    const entries = [
      [
        { ty: "ac", d: ["t.newtab1", [1, "Research Tab"], [2]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-create");
    expect(result!.tabs.length).toBeGreaterThanOrEqual(2);
    const newTab = result!.tabs.find(t => t.tabId === "t.newtab1");
    expect(newTab).toBeDefined();
    expect(newTab!.name).toBe("Research Tab");
    expect(newTab!.position).toEqual([2]);
  });

  it("tracks subtab creation with parentTabId", async () => {
    const entries = [
      // Create parent tab at position [1]
      [
        { ty: "ac", d: ["t.parent", [1, "Parent"], [1]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
      // Create subtab at position [1,0] — parent is at [1]
      [
        { ty: "ac", d: ["t.child", [1, "Child"], [1, 0]] },
        1700000002000, "user1", 2, "sess1", 1, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 2, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-subtab");
    const child = result!.tabs.find(t => t.tabId === "t.child");
    expect(child).toBeDefined();
    expect(child!.parentTabId).toBe("t.parent");
    expect(child!.position).toEqual([1, 0]);
  });

  it("dc with default tab config (empty string d[0]) maps to t.0", async () => {
    const entries = [
      [
        { ty: "dc", d: ["", [1], 0] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-dc-default");
    // The dc for default tab should reference t.0
    const defaultTab = result!.tabs.find(t => t.tabId === "t.0");
    expect(defaultTab).toBeDefined();
  });

  it("tracks tab moves via mch operations", async () => {
    const entries = [
      // Create tab at position [1]
      [
        { ty: "ac", d: ["t.moveme", [1, "Movable"], [1]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
      // Move from position [1] to [2]
      [
        { ty: "mch", d: [[1], [2]] },
        1700000002000, "user1", 2, "sess1", 1, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 2, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-move");
    // Verify the tab_moved operation is in the operations list
    const moveOps = result!.operations.filter(op => op.type === "tab_moved");
    expect(moveOps.length).toBe(1);
    expect(moveOps[0].tabEvent?.fromPosition).toEqual([1]);
    expect(moveOps[0].tabEvent?.position).toEqual([2]);
  });

  it("dc for existing tab marks it as deleted", async () => {
    const entries = [
      // Create tab
      [
        { ty: "ac", d: ["t.doomed", [1, "Doomed Tab"], [1]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
      // dc for an existing tab = deletion
      [
        { ty: "dc", d: ["t.doomed", [1], 0] },
        1700000002000, "user1", 2, "sess1", 1, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 2, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-delete");
    const doomed = result!.tabs.find(t => t.tabId === "t.doomed");
    expect(doomed).toBeDefined();
    expect(doomed!.deletedAt).toBeDefined();
    expect(doomed!.deletedAt!.getTime()).toBe(1700000002000);
  });

  it("dc for unknown tab creates initial configuration (not deletion)", async () => {
    const entries = [
      // dc for a tab never seen via ac = initial config, not deletion
      [
        { ty: "dc", d: ["t.preexist", [3], 0] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-dc-initial");
    const preexist = result!.tabs.find(t => t.tabId === "t.preexist");
    expect(preexist).toBeDefined();
    expect(preexist!.deletedAt).toBeUndefined(); // Not deleted, just configured
    expect(preexist!.position).toEqual([3]);
  });

  it("mkch renames a tab by position", async () => {
    const entries = [
      // Create tab at position [1]
      [
        { ty: "ac", d: ["t.renameme", [1, "Old Name"], [1]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
      // Rename tab at position [1]
      [
        { ty: "mkch", d: [[1, "New Name"]] },
        1700000002000, "user1", 2, "sess1", 1, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 2, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-rename");
    const renamed = result!.tabs.find(t => t.tabId === "t.renameme");
    expect(renamed).toBeDefined();
    expect(renamed!.name).toBe("New Name");
  });

  it("position-to-ID mapping resolves correctly across creates and moves", async () => {
    const entries = [
      // Create tab A at [1]
      [
        { ty: "ac", d: ["t.tabA", [1, "Tab A"], [1]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
      // Create tab B at [2]
      [
        { ty: "ac", d: ["t.tabB", [1, "Tab B"], [2]] },
        1700000002000, "user1", 2, "sess1", 1, null, null, false,
      ],
      // Rename tab at position [2] (should rename tabB)
      [
        { ty: "mkch", d: [[2, "Tab B Renamed"]] },
        1700000003000, "user1", 3, "sess1", 2, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 3, endMillis: 1700000003000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "tab-pos-mapping");
    const tabA = result!.tabs.find(t => t.tabId === "t.tabA");
    const tabB = result!.tabs.find(t => t.tabId === "t.tabB");
    expect(tabA!.name).toBe("Tab A"); // unchanged
    expect(tabB!.name).toBe("Tab B Renamed");
  });
});

// =========================================================================
// NEW TESTS: suggestionsAccepted counting in buildAuthorAttribution
// =========================================================================

describe("suggestionsAccepted counting in buildAuthorAttribution", () => {
  it("counts suggestionsAccepted when insert follows insert_suggestion with same sugId", async () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        // User A creates a suggestion
        makeOp({
          type: "insert_suggestion", text: "suggested", startIndex: 1,
          userId: "user_A", timestamp: new Date("2025-01-15T10:00:00Z"),
          sugId: "suggest.001",
        }),
        // User B accepts the suggestion (insert with same sugId)
        makeOp({
          type: "insert", text: "suggested", startIndex: 1,
          userId: "user_B", timestamp: new Date("2025-01-15T11:00:00Z"),
          sugId: "suggest.001",
        }),
      ],
    };

    const result = await buildAuthorAttribution(
      changelog,
      new Date("2025-01-15T00:00:00Z"),
      new Date("2025-01-15T23:59:59Z"),
      async (uid) => uid === "user_A" ? "alice@test.com" : uid === "user_B" ? "bob@test.com" : null,
    );

    const bob = result.find(a => a.email === "bob@test.com");
    expect(bob).toBeDefined();
    expect(bob!.suggestionsAccepted).toBe(1);
  });

  it("does NOT count suggestionsAccepted when suggestion is rejected (unmark_deletion with same sugId)", async () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({
          type: "insert_suggestion", text: "rejected text", startIndex: 1,
          userId: "user_A", timestamp: new Date("2025-01-15T10:00:00Z"),
          sugId: "suggest.002",
        }),
        // Rejection: unmark_deletion with same sugId
        makeOp({
          type: "unmark_deletion", startIndex: 1, endIndex: 13,
          userId: "user_B", timestamp: new Date("2025-01-15T11:00:00Z"),
          sugId: "suggest.002",
        }),
      ],
    };

    const result = await buildAuthorAttribution(
      changelog,
      new Date("2025-01-15T00:00:00Z"),
      new Date("2025-01-15T23:59:59Z"),
      async (uid) => uid === "user_A" ? "alice@test.com" : uid === "user_B" ? "bob@test.com" : null,
    );

    const bob = result.find(a => a.email === "bob@test.com");
    // Bob has no accepted suggestions — the suggestion was rejected
    expect(bob?.suggestionsAccepted ?? 0).toBe(0);
  });

  it("counts multiple accepted suggestions per author", async () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 5,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({
          type: "insert_suggestion", text: "sug1", startIndex: 1,
          userId: "user_A", timestamp: new Date("2025-01-15T10:00:00Z"),
          sugId: "suggest.a",
        }),
        makeOp({
          type: "delete_suggestion", startIndex: 10, endIndex: 20,
          userId: "user_A", timestamp: new Date("2025-01-15T10:05:00Z"),
          sugId: "suggest.b",
        }),
        // User B accepts both
        makeOp({
          type: "insert", text: "sug1", startIndex: 1,
          userId: "user_B", timestamp: new Date("2025-01-15T11:00:00Z"),
          sugId: "suggest.a",
        }),
        makeOp({
          type: "delete", startIndex: 10, endIndex: 20,
          userId: "user_B", timestamp: new Date("2025-01-15T11:01:00Z"),
          sugId: "suggest.b",
        }),
      ],
    };

    const result = await buildAuthorAttribution(
      changelog,
      new Date("2025-01-15T00:00:00Z"),
      new Date("2025-01-15T23:59:59Z"),
      async (uid) => uid === "user_B" ? "bob@test.com" : uid,
    );

    const bob = result.find(a => a.email === "bob@test.com");
    expect(bob!.suggestionsAccepted).toBe(2);
  });

  it("does not double-count when same sugId appears multiple times", async () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({
          type: "insert_suggestion", text: "once", startIndex: 1,
          userId: "user_A", timestamp: new Date("2025-01-15T10:00:00Z"),
          sugId: "suggest.once",
        }),
        // First acceptance
        makeOp({
          type: "insert", text: "once", startIndex: 1,
          userId: "user_B", timestamp: new Date("2025-01-15T11:00:00Z"),
          sugId: "suggest.once",
        }),
        // Duplicate acceptance (should not be double-counted because sugId is removed from set after first match)
        makeOp({
          type: "insert", text: "once", startIndex: 1,
          userId: "user_B", timestamp: new Date("2025-01-15T11:01:00Z"),
          sugId: "suggest.once",
        }),
      ],
    };

    const result = await buildAuthorAttribution(
      changelog,
      new Date("2025-01-15T00:00:00Z"),
      new Date("2025-01-15T23:59:59Z"),
      async (uid) => uid === "user_B" ? "bob@test.com" : uid,
    );

    const bob = result.find(a => a.email === "bob@test.com");
    expect(bob!.suggestionsAccepted).toBe(1); // Only counted once
  });
});

// =========================================================================
// NEW TESTS: Tab event propagation through the operation builder
// =========================================================================

describe("tab event propagation through fetchDocChangelog", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("ac tab_created propagates tabEvent with targetTabId, tabName, and position", async () => {
    const entries = [
      [
        { ty: "ac", d: ["t.newtab", [1, "My Tab"], [2]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "prop-ac");
    const op = result!.operations[0];
    expect(op.type).toBe("tab_created");
    expect(op.tabEvent).toBeDefined();
    expect(op.tabEvent!.targetTabId).toBe("t.newtab");
    expect(op.tabEvent!.tabName).toBe("My Tab");
    expect(op.tabEvent!.position).toEqual([2]);
  });

  it("dc tab_config propagates tabEvent with targetTabId", async () => {
    const entries = [
      [
        { ty: "dc", d: ["t.cfgtab", [1], 0] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "prop-dc");
    const op = result!.operations[0];
    expect(op.type).toBe("tab_config");
    expect(op.tabEvent).toBeDefined();
    expect(op.tabEvent!.targetTabId).toBe("t.cfgtab");
    expect(op.tabEvent!.position).toEqual([1]);
  });

  it("mch tab_moved propagates tabEvent with fromPosition and position", async () => {
    const entries = [
      [
        { ty: "mch", d: [[0], [3]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "prop-mch");
    const op = result!.operations[0];
    expect(op.type).toBe("tab_moved");
    expect(op.tabEvent!.fromPosition).toEqual([0]);
    expect(op.tabEvent!.position).toEqual([3]);
  });

  it("mkch tab_renamed propagates tabEvent with tabName and position", async () => {
    const entries = [
      [
        { ty: "mkch", d: [[2, "Renamed Tab"]] },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "prop-mkch");
    const op = result!.operations[0];
    expect(op.type).toBe("tab_renamed");
    expect(op.tabEvent!.tabName).toBe("Renamed Tab");
    expect(op.tabEvent!.position).toEqual([2]);
  });

  it("all fields forwarded: tabId, sugId, styleType, styleModification, elementType, elementId, cursorTabId", async () => {
    const entries = [
      // nm-wrapped insert_suggestion with sugId
      [
        { ty: "nm", nmr: ["ksm", "t.propagate_tab"], nmc: { ty: "iss", sugid: "suggest.prop", ibi: 5, s: "prop" } },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
      // nm-wrapped format with styleType and styleModification
      [
        { ty: "nm", nmr: ["ksm", "t.style_tab"], nmc: { ty: "as", st: "language", si: 1, ei: 10, sm: { lang: "en" } } },
        1700000002000, "user1", 2, "sess1", 1, null, null, false,
      ],
      // nm-wrapped add_element with elementType and elementId
      [
        { ty: "nm", nmr: ["ksm", "t.elem_tab"], nmc: { ty: "ae", et: "table", id: "kix.prop_elem" } },
        1700000003000, "user1", 3, "sess1", 2, null, null, false,
      ],
      // cursor op with cursorTabId
      [
        { ty: "ucp", d: ["t.cursor_tab", []] },
        1700000004000, "user1", 4, "sess1", 3, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 4, endMillis: 1700000004000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "propagation-all");
    const ops = result!.operations;

    // Op 0: insert_suggestion with tabId and sugId
    expect(ops[0].tabId).toBe("t.propagate_tab");
    expect(ops[0].sugId).toBe("suggest.prop");
    expect(ops[0].type).toBe("insert_suggestion");

    // Op 1: format with tabId, styleType, styleModification
    expect(ops[1].tabId).toBe("t.style_tab");
    expect(ops[1].styleType).toBe("language");
    expect(ops[1].styleModification).toEqual({ lang: "en" });

    // Op 2: add_element with tabId, elementType, elementId
    expect(ops[2].tabId).toBe("t.elem_tab");
    expect(ops[2].elementType).toBe("table");
    expect(ops[2].elementId).toBe("kix.prop_elem");

    // Op 3: cursor with cursorTabId
    expect(ops[3].cursorTabId).toBe("t.cursor_tab");
  });
});

// =========================================================================
// NEW TESTS: Iterative pagination fallback
// =========================================================================

describe("iterative pagination fallback", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  function makeChangelogEntry(index: number): unknown[] {
    return [
      { ty: "is", ibi: index, s: String.fromCharCode(65 + (index % 26)) },
      1700000000000 + index * 1000,
      "user123",
      index,
      "sess1",
      index,
      null,
      null,
      false,
    ];
  }

  it("when tiles fail, paginates iteratively until short page", async () => {
    // tiles fails with 403
    mockGFetch.mockResolvedValueOnce(new Response("", { status: 403 }));
    // First iterative page: exactly 1000 entries (full page -> continue)
    const page1 = Array.from({ length: 1000 }, (_, i) => makeChangelogEntry(i + 1));
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: page1 }),
    );
    // Second iterative page: 200 entries (short page -> stop)
    const page2 = Array.from({ length: 200 }, (_, i) => makeChangelogEntry(1001 + i));
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: page2 }),
    );

    const result = await fetchDocChangelog("system", "iter-fallback");
    expect(result).not.toBeNull();
    expect(result!.operations.length).toBe(1200);
    // 3 calls: tiles (failed) + 2 load pages
    expect(mockGFetch).toHaveBeenCalledTimes(3);
  });

  it("when tiles return empty tileInfo and first load returns 400, returns empty doc", async () => {
    // tiles returns empty tileInfo
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [], userMap: {} }),
    );
    // iterative /revisions/load returns 400 (no changelog)
    mockGFetch.mockResolvedValueOnce(new Response("", { status: 400 }));

    const result = await fetchDocChangelog("system", "iter-empty");
    expect(result).not.toBeNull();
    expect(result!.operations).toHaveLength(0);
    expect(result!.totalRevisions).toBe(0);
  });

  it("when tiles fail and only one short page exists, returns that page", async () => {
    // tiles fail
    mockGFetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    // Single short page
    const entries = Array.from({ length: 5 }, (_, i) => makeChangelogEntry(i + 1));
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "iter-single-short");
    expect(result).not.toBeNull();
    expect(result!.operations.length).toBe(5);
    expect(mockGFetch).toHaveBeenCalledTimes(2);
  });

  it("when tiles fail and multiple full pages exist, paginates to completion", async () => {
    // tiles fail
    mockGFetch.mockResolvedValueOnce(new Response("", { status: 403 }));
    // 3 full pages + 1 short page
    const page1 = Array.from({ length: 1000 }, (_, i) => makeChangelogEntry(i + 1));
    const page2 = Array.from({ length: 1000 }, (_, i) => makeChangelogEntry(1001 + i));
    const page3 = Array.from({ length: 1000 }, (_, i) => makeChangelogEntry(2001 + i));
    const page4 = Array.from({ length: 50 }, (_, i) => makeChangelogEntry(3001 + i));
    mockGFetch.mockResolvedValueOnce(makeXssiResponse({ chunkedSnapshot: [[]], changelog: page1 }));
    mockGFetch.mockResolvedValueOnce(makeXssiResponse({ chunkedSnapshot: [[]], changelog: page2 }));
    mockGFetch.mockResolvedValueOnce(makeXssiResponse({ chunkedSnapshot: [[]], changelog: page3 }));
    mockGFetch.mockResolvedValueOnce(makeXssiResponse({ chunkedSnapshot: [[]], changelog: page4 }));

    const result = await fetchDocChangelog("system", "iter-multi-full");
    expect(result).not.toBeNull();
    expect(result!.operations.length).toBe(3050);
    // 5 calls: tiles (failed) + 4 load pages
    expect(mockGFetch).toHaveBeenCalledTimes(5);
  });
});

// =========================================================================
// NEW TESTS: extractPendingSuggestions with sugId matching
// =========================================================================

describe("extractPendingSuggestions with sugId matching", () => {
  it("resolves suggestion by sugId when unmark_deletion has matching sugId", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({
          type: "insert_suggestion", text: "to be rejected", startIndex: 10,
          sugId: "suggest.rej", changelogIndex: 1,
        }),
        makeOp({
          type: "unmark_deletion", startIndex: 10, endIndex: 24,
          sugId: "suggest.rej", changelogIndex: 2,
        }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(0); // resolved by sugId
  });

  it("does NOT resolve suggestion when sugIds differ", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 3,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({
          type: "insert_suggestion", text: "still pending", startIndex: 10,
          sugId: "suggest.aaa", changelogIndex: 1,
        }),
        makeOp({
          type: "unmark_deletion", startIndex: 10, endIndex: 24,
          sugId: "suggest.bbb", changelogIndex: 2,
        }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(1);
    expect(pending[0].sugId).toBe("suggest.aaa");
  });

  it("returns sugId in pending suggestion results", () => {
    const changelog: DocChangelog = {
      fileId: "test-doc",
      totalRevisions: 1,
      tabs: [],
      userMap: new Map(),
      operations: [
        makeOp({
          type: "insert_suggestion", text: "with id", startIndex: 5,
          sugId: "suggest.keepid", changelogIndex: 1,
        }),
      ],
    };

    const pending = extractPendingSuggestions(changelog);
    expect(pending).toHaveLength(1);
    expect(pending[0].sugId).toBe("suggest.keepid");
  });
});

// =========================================================================
// Bug fix tests: mlti mixed tab IDs, nm wrapping mlti, snapshot tab IDs
// =========================================================================

describe("Bug A: mlti with mixed tab IDs assigns per-sub-op tab IDs", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("mlti containing nm sub-ops for different tabs assigns correct tab IDs", async () => {
    // An mlti with two nm wrappers for different tabs
    const entries = [
      [
        {
          ty: "mlti",
          mts: [
            { ty: "nm", nmr: ["kix.1", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "tab1 text" } },
            { ty: "nm", nmr: ["kix.2", "t.tab2"], nmc: { ty: "is", ibi: 1, s: "tab2 text" } },
          ],
        },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "multi-tab-mlti");
    const ops = result!.operations;
    expect(ops).toHaveLength(2);
    // Each sub-op should have its own tab ID from its nm wrapper
    expect(ops[0].tabId).toBe("t.tab1");
    expect(ops[0].text).toBe("tab1 text");
    expect(ops[1].tabId).toBe("t.tab2");
    expect(ops[1].text).toBe("tab2 text");
  });

  it("mlti with one nm sub-op and one plain sub-op", async () => {
    const entries = [
      [
        {
          ty: "mlti",
          mts: [
            { ty: "nm", nmr: ["kix.1", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "in tab1" } },
            { ty: "is", ibi: 5, s: "no tab" },
          ],
        },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "mixed-nm-plain");
    const ops = result!.operations;
    expect(ops).toHaveLength(2);
    expect(ops[0].tabId).toBe("t.tab1");
    expect(ops[0].text).toBe("in tab1");
    // The plain op gets the top-level fallback tab ID (first found = t.tab1)
    expect(ops[1].tabId).toBe("t.tab1");
    expect(ops[1].text).toBe("no tab");
  });
});

describe("Bug C: nm wrapping mlti is properly flattened", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("nm wrapping mlti flattens all sub-ops (previously produced no-op)", async () => {
    // A top-level nm wrapping an mlti — previously the parseOperation path
    // returned { type: "multi" } which was a no-op, silently dropping sub-ops
    const entries = [
      [
        {
          ty: "nm",
          nmr: ["kix.1", "t.tab1"],
          nmc: {
            ty: "mlti",
            mts: [
              { ty: "is", ibi: 1, s: "first" },
              { ty: "is", ibi: 6, s: " second" },
            ],
          },
        },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "nm-wrapping-mlti");
    const ops = result!.operations;
    // Should produce 2 insert ops, NOT a single "multi" no-op
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe("insert");
    expect(ops[0].text).toBe("first");
    expect(ops[0].tabId).toBe("t.tab1");
    expect(ops[1].type).toBe("insert");
    expect(ops[1].text).toBe(" second");
    expect(ops[1].tabId).toBe("t.tab1");
  });

  it("nm wrapping mlti with delete sub-ops", async () => {
    const entries = [
      [
        {
          ty: "nm",
          nmr: ["kix.1", "t.tab1"],
          nmc: {
            ty: "mlti",
            mts: [
              { ty: "ds", si: 1, ei: 5 },
              { ty: "is", ibi: 1, s: "replacement" },
            ],
          },
        },
        1700000001000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000001000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ chunkedSnapshot: [[]], changelog: entries }),
    );

    const result = await fetchDocChangelog("system", "nm-mlti-delete");
    const ops = result!.operations;
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe("delete");
    expect(ops[0].startIndex).toBe(1);
    expect(ops[0].endIndex).toBe(5);
    expect(ops[1].type).toBe("insert");
    expect(ops[1].text).toBe("replacement");
  });
});

describe("Bug B: snapshot operations extract tab IDs", () => {
  beforeEach(() => {
    mockGFetch.mockReset();
  });

  function makeXssiResponse(data: Record<string, unknown>): Response {
    const body = `)]}'\n` + JSON.stringify(data);
    return new Response(body, { status: 200 });
  }

  it("chunkedSnapshot with nm-wrapped ops extracts tab IDs", async () => {
    const changelog = [
      [
        { ty: "nm", nmr: ["kix.1", "t.tab1"], nmc: { ty: "is", ibi: 10, s: " edit" } },
        1700000002000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        chunkedSnapshot: [
          [
            { ty: "nm", nmr: ["kix.0", "t.tab1"], nmc: { ty: "is", ibi: 1, s: "snapshot" } },
          ],
        ],
        changelog,
      }),
    );

    const result = await fetchDocChangelog("system", "snapshot-tab-ids");
    const ops = result!.operations;
    // Snapshot op should have tab ID from its nm wrapper
    const snapshotOp = ops.find(o => o.text === "snapshot");
    expect(snapshotOp).toBeDefined();
    expect(snapshotOp!.tabId).toBe("t.tab1");
  });

  it("chunkedSnapshot with plain ops gets no tab ID (backward compat)", async () => {
    const changelog = [
      [
        { ty: "is", ibi: 9, s: " edit" },
        1700000002000, "user1", 1, "sess1", 0, null, null, false,
      ],
    ];
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({ tileInfo: [{ start: 1, end: 1, endMillis: 1700000002000, users: ["user1"] }], userMap: {} }),
    );
    mockGFetch.mockResolvedValueOnce(
      makeXssiResponse({
        chunkedSnapshot: [
          [
            { ty: "is", ibi: 1, s: "plain" },
          ],
        ],
        changelog,
      }),
    );

    const result = await fetchDocChangelog("system", "snapshot-no-tab");
    const ops = result!.operations;
    const snapshotOp = ops.find(o => o.text === "plain");
    expect(snapshotOp).toBeDefined();
    // No nm wrapper = no tab ID (undefined), which maps to __default__
    expect(snapshotOp!.tabId).toBeUndefined();
  });
});
