/**
 * gdocs-revisions-load.ts - Full OT changelog client for per-character edit attribution.
 *
 * Ported from the harvard-vpal/gdocrevisions Python library. Uses the undocumented
 * /revisions/load endpoint to fetch the complete OT (operational transform) changelog
 * for a Google Doc, providing character-level edit attribution.
 *
 * Called hourly per active doc via the enrichment queue. "Active" = docs with edit
 * activity since the last enrichment run (tracked via conversationWatermarks).
 *
 * The endpoint returns a response prefixed with an anti-XSSI guard `)]}'` - the
 * first 5 characters must be stripped before JSON.parse.
 *
 * data.changelog is an array of 9-element tuples:
 *   [operationObj, timestampMs, userId, revisionId, sessionId, sessionIndex, null, null, false]
 *
 * Operation types (raw.ty):
 *   is   - InsertString: insert text at position (ibi=index, s=string)
 *   ds   - DeleteString: delete range (si=start, ei=end, inclusive 1-indexed)
 *   iss  - InsertStringSuggestion: suggested insert
 *   dss  - DeleteStringSuggestion: suggested delete
 *   msfd - MarkStringForDeletion: mark text for deletion in suggestion mode
 *   usfd - UnmarkStringForDeletion: unmark (reject suggestion)
 *   as   - ApplyStyle: format change (si/ei range, bold, italic, etc.)
 *   mlti - MultiOperation: container for sub-ops in raw.mts[]
 *   nm   - NamedMutation: named range operation, wraps a text op in raw.nmc
 *          (e.g. nmc={ty:"is", ibi:1, s:"text"}). Most common op type -
 *          Google wraps nearly all user edits in nm for internal tracking.
 *   rplc - Replace: full document replace (snapshot in raw.snapshot)
 *   rvrt - Revert: revert to snapshot
 *   ae   - AddElement: add structural element (table, list, etc.)
 *   de   - DeleteElement: remove structural element
 *   ue   - UpdateElement: update element properties
 *   te   - TetherElement: tether element to position
 *   sas  - SetAndStyle: combined style set
 *   ac   - AddComment/Annotation
 *   mch  - ModifyComment/Header
 *   mkch - MarkComment/Header
 *   ucp  - UpdateCursorPosition: cursor tracking, includes tab context
 *   dc   - DocumentConfiguration: tab creation (d=[tabId, indices, flags])
 *   astss- ApplyStyleToSnapshot: format change in snapshot context
 *   ras  - RejectAllSuggestions: reject suggestion range (sugid, si, ei)
 *   umv  - UpdateModelVersion: internal model version bump (mv=number)
 *   utlp - UpdateTopLevelProperties: language/doc-level config
 *
 * All document indices are 1-indexed, matching the Python library conventions.
 */

import { getGoogleAccessToken, GOOGLE_DOCS_DELEGATION_SCOPES } from "../../vault/google-auth.js";
import { GoogleRateLimitError } from "../../vault/google-rate-limit.js";
import { gFetch } from "./gdocs-api.js";
import {
  changelogPaceKey,
  changelogPacer,
  changelogPageConcurrency,
  changelogRequestsPerSecond,
  fetchContiguousPages,
  knownTotalRanges,
} from "../../source-lane/providers/google-docs/changelog-page-pool.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChangelogOperation {
  type:
    | "insert"
    | "delete"
    | "insert_suggestion"
    | "delete_suggestion"
    | "mark_deletion"
    | "unmark_deletion"
    | "format"
    | "multi"
    | "replace"
    | "revert"
    | "tab_created"
    | "tab_deleted"
    | "tab_moved"
    | "tab_renamed"
    | "tab_config"
    | "cursor"
    | "add_element"
    | "delete_element"
    | "update_element"
    | "tether_element"
    | "other";
  /** For insert/insert_suggestion: the actual characters inserted. */
  text?: string;
  /** 1-indexed position in the document. */
  startIndex?: number;
  /** For deletes/ranges: end of range (inclusive, 1-indexed). */
  endIndex?: number;
  /** Google user ID of who made this operation. */
  userId: string;
  /** Millisecond-precision timestamp. */
  timestamp: Date;
  /** Revision number in the changelog. */
  revisionId: number;
  /** Editing session identifier. */
  sessionId: string;
  /** 1-indexed position in the raw changelog (matches tile start/end). */
  changelogIndex: number;
  /** Tab ID from nm.nmr[] (e.g., "t.taev36xqg9o0"). Multi-tab docs have different index spaces per tab. */
  tabId?: string;
  /** For tab operations: structured tab event data. */
  tabEvent?: TabEvent;
  /** Suggestion ID linking related suggestion operations (iss, dss, msfd, usfd, ras, sas). */
  sugId?: string;
  /** For format operations: style type - "text", "paragraph", "document", "headings", "language". */
  styleType?: string;
  /** For format operations: style modification map (e.g., { ts_bd: true, ts_bd_i: false }). */
  styleModification?: Record<string, unknown>;
  /** For element operations (ae/de/ue/te): element type - "list", "inline", "table", etc. */
  elementType?: string;
  /** For element operations: kix-prefixed element ID. */
  elementId?: string;
  /** For cursor operations: which tab the cursor is on. */
  cursorTabId?: string;
}

export interface TabEvent {
  /** The tab ID affected (e.g., "t.taev36xqg9o0"). */
  targetTabId?: string;
  /** Tab name at the time of the operation. */
  tabName?: string;
  /** Position in hierarchy. [2] = top-level, [2,0] = subtab. Max 3 levels. */
  position?: number[];
  /** For moves: the previous position. */
  fromPosition?: number[];
}

export interface TabInfo {
  tabId: string;
  name: string;
  /** Current position in hierarchy. [2] = top-level, [2,0] = subtab. */
  position: number[];
  /** Parent tab ID, or undefined for top-level tabs. */
  parentTabId?: string;
  createdAt?: Date;
  deletedAt?: Date;
}

export interface DocChangelog {
  fileId: string;
  totalRevisions: number;
  /** User metadata map from the changelog (display names, photos). */
  userMap: Map<string, { name: string; photo?: string; anonymous: boolean }>;
  operations: ChangelogOperation[];
  /** Tab state reconstructed from ac/dc/mch/mkch operations. */
  tabs: TabInfo[];
}

export interface AuthorAttribution {
  email: string;
  name: string;
  /** Character count of insertions. */
  insertions: number;
  /** Character count of deletions. */
  deletions: number;
  suggestionsCreated: number;
  suggestionsAccepted: number;
  firstEditAt: Date;
  lastEditAt: Date;
}

export interface DocDailySummary {
  fileId: string;
  fileName: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  authors: AuthorAttribution[];
  operationCount: number;
  netCharacterChange: number;
  pendingSuggestions: Array<{
    userId: string;
    text: string;
    position: number;
    timestamp: Date;
    sugId?: string;
  }>;
}

export interface RevisionTile {
  start: number;
  end: number;
  endMillis: number;
  users: string[];
}

export interface EditChunkDiff {
  tileIndex: number;
  startOp: number;
  endOp: number;
  timestamp: Date;
  authors: Array<{ userId: string; name: string }>;
  insertions: Array<{ text: string; position: number }>;
  deletions: Array<{ text: string; position: number }>;
  netCharChange: number;
  operationCount: number;
}

export interface ChunkedDocDiffs {
  fileId: string;
  tiles: RevisionTile[];
  userMap: Map<string, { name: string; photo?: string; anonymous: boolean }>;
  chunks: EditChunkDiff[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Time window for matching Phase 1 events to Phase 2 OT operations. */
const ENRICHMENT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes


// ---------------------------------------------------------------------------
// Operation parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw OT operation object from the changelog into a typed partial
 * ChangelogOperation.  Returns null for unrecognised operation types.
 *
 * For "mlti" (MultiOperation), we recursively flatten sub-operations into
 * the caller's list rather than nesting.
 */
function parseOperation(
  raw: Record<string, unknown> | null | undefined,
): Partial<ChangelogOperation> | null {
  if (!raw || typeof raw !== "object") return null;

  const ty = raw.ty as string | undefined;
  switch (ty) {
    case "is": // InsertString (may carry sugid when accepting a suggestion)
      return {
        type: "insert",
        text: raw.s as string | undefined,
        startIndex: raw.ibi as number | undefined,
        sugId: raw.sugid as string | undefined,
      };
    case "ds": // DeleteString (may carry sugid when accepting a suggestion)
      return {
        type: "delete",
        startIndex: raw.si as number | undefined,
        endIndex: raw.ei as number | undefined,
        sugId: raw.sugid as string | undefined,
      };
    case "iss": // InsertStringSuggestion
      return {
        type: "insert_suggestion",
        text: raw.s as string | undefined,
        startIndex: raw.ibi as number | undefined,
        sugId: raw.sugid as string | undefined,
      };
    case "dss": // DeleteStringSuggestion
      return {
        type: "delete_suggestion",
        startIndex: raw.si as number | undefined,
        endIndex: raw.ei as number | undefined,
        sugId: raw.sugid as string | undefined,
      };
    case "msfd": // MarkStringForDeletion
      return {
        type: "mark_deletion",
        startIndex: raw.si as number | undefined,
        endIndex: raw.ei as number | undefined,
        sugId: raw.sugid as string | undefined,
      };
    case "usfd": // UnmarkStringForDeletion
      return {
        type: "unmark_deletion",
        startIndex: raw.si as number | undefined,
        endIndex: raw.ei as number | undefined,
        sugId: raw.sugid as string | undefined,
      };
    case "as": // ApplyStyle (format)
      return {
        type: "format",
        startIndex: raw.si as number | undefined,
        endIndex: raw.ei as number | undefined,
        styleType: raw.st as string | undefined,
        styleModification: raw.sm as Record<string, unknown> | undefined,
      };
    case "nm": {
      // NamedMutation - the inner text operation lives in raw.nmc
      const nmc = raw.nmc as Record<string, unknown> | undefined;
      if (nmc && typeof nmc === "object") {
        const inner = parseOperation(nmc);
        if (inner) return inner;
      }
      return { type: "other" };
    }
    case "mlti": // MultiOperation - handled via recursion in flattenMultiOps
      return { type: "multi" };
    case "rplc": // Replace
      return { type: "replace" };
    case "rvrt": // Revert
      return { type: "revert" };
    case "ae": // AddElement (list, inline, table, etc.)
      return {
        type: "add_element" as const,
        elementType: raw.et as string | undefined,
        elementId: raw.id as string | undefined,
      };
    case "de": // DeleteElement
      return {
        type: "delete_element" as const,
        elementType: raw.et as string | undefined,
        elementId: raw.id as string | undefined,
      };
    case "ue": // UpdateElement
      return {
        type: "update_element" as const,
        elementType: raw.et as string | undefined,
        elementId: raw.id as string | undefined,
      };
    case "te": // TetherElement (anchor floating element)
      return {
        type: "tether_element" as const,
        elementType: raw.et as string | undefined,
        elementId: raw.id as string | undefined,
        startIndex: raw.spi as number | undefined,
      };
    case "umv": // UpdateModelVersion
    case "utlp": // UpdateTopLevelProperties (language, etc.)
      return { type: "other" };
    case "sas": // SuggestAdjustStyle (suggested formatting)
      return {
        type: "format",
        startIndex: raw.si as number | undefined,
        endIndex: raw.ei as number | undefined,
        sugId: raw.sugid as string | undefined,
        styleType: raw.st as string | undefined,
        styleModification: raw.sm as Record<string, unknown> | undefined,
      };
    case "astss": // ApplyStyleToSnapshot
      return {
        type: "format",
        startIndex: raw.si as number | undefined,
        endIndex: raw.ei as number | undefined,
        styleType: raw.st as string | undefined,
        styleModification: raw.sm as Record<string, unknown> | undefined,
      };
    case "ras": // RejectAllSuggestions
      return {
        type: "unmark_deletion",
        startIndex: raw.si as number | undefined,
        endIndex: raw.ei as number | undefined,
        sugId: raw.sugid as string | undefined,
      };
    case "ac": { // AddComment/AddTab
      const d = raw.d as unknown[] | undefined;
      if (d && typeof d[0] === "string" && (d[0] as string).startsWith("t.")) {
        const nameArr = d[1] as [number, string] | undefined;
        const posArr = d[2] as number[] | undefined;
        return {
          type: "tab_created",
          tabEvent: {
            targetTabId: d[0] as string,
            tabName: Array.isArray(nameArr) ? nameArr[1] : undefined,
            position: Array.isArray(posArr) ? posArr : undefined,
          },
        };
      }
      return { type: "other" };
    }
    case "dc": { // DocumentConfiguration (tab create/configure/delete)
      const d = raw.d as unknown[] | undefined;
      if (d && typeof d[0] === "string" && (d[0] as string).startsWith("t.")) {
        const posArr = d[1] as number[] | undefined;
        return {
          type: "tab_config",
          tabEvent: {
            targetTabId: d[0] as string,
            position: Array.isArray(posArr) ? posArr : undefined,
          },
        };
      }
      if (d && d[0] === "") {
        // Default tab config: ["", [1], 0]
        return { type: "tab_config", tabEvent: { targetTabId: "t.0" } };
      }
      return { type: "tab_config" };
    }
    case "mch": { // ModifyComment/Header - includes tab moves
      const d = raw.d as unknown[] | undefined;
      if (d && Array.isArray(d[0]) && Array.isArray(d[1])) {
        return {
          type: "tab_moved",
          tabEvent: {
            fromPosition: d[0] as number[],
            position: d[1] as number[],
          },
        };
      }
      return { type: "other" };
    }
    case "mkch": { // MarkComment/RenameTab
      const d = raw.d as unknown[] | undefined;
      if (d && Array.isArray(d[0]) && typeof (d[0] as unknown[])[1] === "string") {
        return {
          type: "tab_renamed",
          tabEvent: {
            tabName: (d[0] as [number, string])[1],
            position: [(d[0] as number[])[0]],
          },
        };
      }
      return { type: "other" };
    }
    case "ucp": { // UpdateCursorPosition - d[0] is the tab ID
      const d = raw.d as unknown[] | undefined;
      const cursorTab = (d && typeof d[0] === "string" && (d[0] as string).startsWith("t."))
        ? d[0] as string
        : undefined;
      return { type: "cursor", cursorTabId: cursorTab };
    }
    default:
      return null;
  }
}

/**
 * Recursively flatten a multi-operation ("mlti") into leaf operations,
 * propagating per-sub-operation tab IDs from nm wrappers.
 *
 * The Python library does the same in MultiOperation.iter_operations().
 *
 * Bug fix: previously, a single extractTabId on the top-level raw op assigned
 * the FIRST tab ID to ALL flattened sub-ops. In multi-tab docs, an mlti can
 * contain nm sub-ops for different tabs. Now each sub-op carries the tabId
 * from its own nm wrapper.
 */
const MAX_FLATTEN_DEPTH = 20;

function flattenMultiOps(
  raw: Record<string, unknown>,
  depth: number = 0,
  inheritedTabId?: string,
): Array<Partial<ChangelogOperation>> {
  if (depth > MAX_FLATTEN_DEPTH) return [{ type: "other" }];

  const ty = raw.ty as string | undefined;

  if (ty === "mlti") {
    const subs = (raw.mts as Array<Record<string, unknown>>) ?? [];
    const results: Array<Partial<ChangelogOperation>> = [];
    for (const sub of subs) {
      if (!sub || typeof sub !== "object") continue;
      results.push(...flattenMultiOps(sub, depth + 1, inheritedTabId));
    }
    return results;
  }

  if (ty === "nm") {
    // Extract tab ID from this nm's nmr[] and propagate to inner ops
    const nmTabId = extractTabIdFromNm(raw) ?? inheritedTabId;
    const nmc = raw.nmc as Record<string, unknown> | undefined;
    if (nmc && typeof nmc === "object") {
      return flattenMultiOps(nmc, depth + 1, nmTabId);
    }
    return [{ type: "other", tabId: nmTabId }];
  }

  if (ty === "rplc" || ty === "rvrt") {
    const results: Array<Partial<ChangelogOperation>> = [
      { type: ty === "rplc" ? "replace" : "revert", tabId: inheritedTabId },
    ];
    const snapshot = raw.snapshot as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(snapshot)) {
      for (const sub of snapshot) {
        if (sub && typeof sub === "object") {
          results.push(...flattenMultiOps(sub, depth + 1, inheritedTabId));
        }
      }
    }
    return results;
  }

  const op = parseOperation(raw);
  if (op) {
    // Attach inherited tab ID if the leaf op doesn't have its own
    if (inheritedTabId && !op.tabId) op.tabId = inheritedTabId;
    return [op];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tab state builder
// ---------------------------------------------------------------------------

/**
 * Build a list of tabs from tab lifecycle operations in the changelog.
 * Tracks creates, renames, and deletions to produce the final tab state.
 */
function buildTabState(operations: ChangelogOperation[]): TabInfo[] {
  const tabMap = new Map<string, TabInfo>();

  // Default tab always exists
  tabMap.set("t.0", { tabId: "t.0", name: "", position: [0] });

  // Position-to-tabId mapping for resolving moves and renames
  const posToId = new Map<string, string>();
  posToId.set("[0]", "t.0");

  for (const op of operations) {
    if (op.type === "tab_created" && op.tabEvent?.targetTabId) {
      const tabId = op.tabEvent.targetTabId;
      const pos = op.tabEvent.position ?? [];
      tabMap.set(tabId, {
        tabId,
        name: op.tabEvent.tabName ?? "",
        position: pos,
        parentTabId: pos.length > 1 ? findParentAtPosition(pos.slice(0, -1), posToId, tabMap) : undefined,
        createdAt: op.timestamp,
      });
      posToId.set(JSON.stringify(pos), tabId);
    }

    if (op.type === "tab_renamed" && op.tabEvent?.tabName && op.tabEvent.position) {
      // mkch renames by position - resolve position to tab ID
      const posKey = JSON.stringify(op.tabEvent.position);
      const tabId = posToId.get(posKey);
      if (tabId) {
        const tab = tabMap.get(tabId);
        if (tab) tab.name = op.tabEvent.tabName;
      } else {
        // Position might match the default tab
        if (op.tabEvent.position.length === 1) {
          // Try to match by first position index
          for (const [key, id] of posToId) {
            const parsed = JSON.parse(key) as number[];
            if (parsed.length === 1 && parsed[0] === op.tabEvent.position[0]) {
              const tab = tabMap.get(id);
              if (tab) tab.name = op.tabEvent.tabName;
              break;
            }
          }
        }
      }
    }

    if (op.type === "tab_moved" && op.tabEvent?.fromPosition && op.tabEvent.position) {
      // Update position mapping
      const fromKey = JSON.stringify(op.tabEvent.fromPosition);
      const tabId = op.tabEvent.targetTabId ?? posToId.get(fromKey);
      if (tabId) {
        posToId.delete(fromKey);
        const newPos = op.tabEvent.position;
        posToId.set(JSON.stringify(newPos), tabId);
        const tab = tabMap.get(tabId);
        if (tab) {
          tab.position = newPos;
          tab.parentTabId = newPos.length > 1
            ? findParentAtPosition(newPos.slice(0, -1), posToId, tabMap)
            : undefined;
        }
      }
    }

    if (op.type === "tab_config" && op.tabEvent?.targetTabId) {
      const tabId = op.tabEvent.targetTabId;
      const existing = tabMap.get(tabId);
      if (existing && !existing.deletedAt) {
        existing.deletedAt = op.timestamp;
        if (op.tabEvent.position) existing.position = op.tabEvent.position;
      } else if (!existing) {
        // dc for a tab we haven't seen created = initial configuration (not deletion)
        tabMap.set(tabId, {
          tabId,
          name: "",
          position: op.tabEvent.position ?? [],
        });
        if (op.tabEvent.position) {
          posToId.set(JSON.stringify(op.tabEvent.position), tabId);
        }
      }
    }
  }

  return [...tabMap.values()];
}

function findParentAtPosition(
  parentPos: number[],
  posToId: Map<string, string>,
  tabMap: Map<string, TabInfo>,
): string | undefined {
  const key = JSON.stringify(parentPos);
  return posToId.get(key);
}

// ---------------------------------------------------------------------------
// fetchDocChangelog
// ---------------------------------------------------------------------------

/**
 * Parse the anti-XSSI prefixed JSON response from docs.google.com endpoints.
 *
 * Known Google anti-XSSI prefixes (past and present):
 *   - `)]}'\n`  - current standard (4 chars + optional newline)
 *   - `while(1);` - used by Calendar/Gmail
 *   - `&&&START&&&` - historically used by Google Docs (pre-2015)
 *
 * We strip known prefixes by pattern, then fall back to fixed-offset slicing.
 */
const XSSI_PATTERNS = [
  /^\)\]\}'\n?/,
  /^while\(1\);?\s*/,
  /^&&+START&&+\s*/,
];

export function parseXssiJson(rawText: string): Record<string, unknown> | null {
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
  // Fallback: brute-force skip common lengths
  for (const skip of [4, 5, 6]) {
    try {
      return JSON.parse(rawText.slice(skip)) as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  return null;
}

const CHANGELOG_PAGE_SIZE = 1000;

/**
 * Extract the tab ID from an operation's nm.nmr[] array.
 * Tab IDs are prefixed with "t." (e.g., "t.taev36xqg9o0").
 * Only checks the immediate nm wrapper - does NOT recurse into mlti sub-ops.
 * For mlti, each sub-op carries its own tab ID via flattenMultiOpsWithTabs.
 */
function extractTabIdFromNm(raw: Record<string, unknown>): string | undefined {
  if (raw.ty === "nm" && Array.isArray(raw.nmr)) {
    for (const id of raw.nmr) {
      if (typeof id === "string" && id.startsWith("t.")) return id;
    }
  }
  return undefined;
}

/**
 * Extract the first tab ID found anywhere in an operation tree.
 * Used as a fallback when per-sub-op extraction isn't available.
 */
function extractTabId(raw: Record<string, unknown>): string | undefined {
  const direct = extractTabIdFromNm(raw);
  if (direct) return direct;
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

/**
 * Flatten the `chunkedSnapshot` of the first /revisions/load page (an array of
 * op groups - the document state before changelog entry 1) into raw ops.
 * (gigabrain 5448774 `collectSnapshotOps`.)
 */
export function collectSnapshotOps(chunkedSnapshot: unknown): Array<Record<string, unknown>> {
  const snapshotOps: Array<Record<string, unknown>> = [];
  if (!Array.isArray(chunkedSnapshot)) return snapshotOps;
  for (const group of chunkedSnapshot) {
    if (Array.isArray(group)) {
      for (const op of group) {
        if (op && typeof op === "object") snapshotOps.push(op as Record<string, unknown>);
      }
    }
  }
  return snapshotOps;
}

/**
 * Pure parser: raw changelog tuples (+ the first page's snapshot ops) into a
 * DocChangelog. This is exactly the parse half of `fetchDocChangelog`, split
 * out so stored raw pages can be re-parsed by the production code without a
 * re-fetch. `allEntries[i]` must be changelog entry i+1 (1-indexed).
 */
export function parseChangelogEntries(
  fileId: string,
  allEntries: unknown[][],
  snapshotOps: Array<Record<string, unknown>>,
  userMap: Map<string, { name: string; photo?: string; anonymous: boolean }>,
): DocChangelog {
  // Step 3: Parse snapshot operations (initial document state for imported docs)
  // These represent the document state BEFORE any changelog edits.
  // Bug fix: snapshot ops now extract tab IDs from nm wrappers so they land
  // in the correct tab namespace (previously all got tabId: undefined).
  const snapshotParsed: ChangelogOperation[] = [];
  for (const rawOp of snapshotOps) {
    const snapshotTabId = extractTabId(rawOp);
    const partials = flattenMultiOps(rawOp, 0, snapshotTabId);
    for (const partial of partials) {
      snapshotParsed.push({
        type: partial.type ?? "other",
        text: partial.text,
        startIndex: partial.startIndex,
        endIndex: partial.endIndex,
        userId: "",
        timestamp: new Date(0),
        revisionId: 0,
        sessionId: "",
        changelogIndex: 0,
        tabId: partial.tabId ?? snapshotTabId,
        elementType: partial.elementType,
        elementId: partial.elementId,
        styleType: partial.styleType,
        styleModification: partial.styleModification,
      });
    }
  }

  // Step 4: Parse the changelog entries
  const operations: ChangelogOperation[] = [];

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    if (!Array.isArray(entry) || entry.length < 4) continue;

    const rawOp = entry[0] as Record<string, unknown> | null;
    const timestampMs = entry[1] as number;
    const entryUserId = (entry[2] as string) ?? "";
    const entryRevisionId = (entry[3] as number) ?? 0;
    const entrySessionId = (entry[4] as string) ?? "";
    const changelogIndex = i + 1; // 1-indexed to match tile start/end

    if (!rawOp || typeof rawOp !== "object") {
      operations.push({
        type: "other", userId: entryUserId, timestamp: new Date(timestampMs),
        revisionId: entryRevisionId, sessionId: entrySessionId, changelogIndex,
      });
      continue;
    }

    // Extract top-level tab ID (fallback for ops not inside an nm wrapper)
    const topLevelTabId = extractTabId(rawOp);

    // Flatten ALL operation types through flattenMultiOps - this handles:
    //   - mlti: flattens sub-ops with per-sub-op tab IDs
    //   - nm wrapping mlti: recursively flattens (previously produced a no-op "multi")
    //   - nm wrapping is/ds: extracts the inner op with correct tab ID
    //   - plain is/ds/as: passes through unchanged
    const partials = flattenMultiOps(rawOp, 0, topLevelTabId);

    if (partials.length === 0) {
      partials.push({ type: "other" });
    }

    for (const partial of partials) {
      operations.push({
        type: partial.type!,
        text: partial.text,
        startIndex: partial.startIndex,
        endIndex: partial.endIndex,
        userId: entryUserId,
        timestamp: new Date(timestampMs),
        revisionId: entryRevisionId,
        sessionId: entrySessionId,
        changelogIndex,
        tabId: partial.tabId ?? topLevelTabId,
        tabEvent: partial.tabEvent,
        sugId: partial.sugId,
        styleType: partial.styleType,
        styleModification: partial.styleModification,
        elementType: partial.elementType,
        elementId: partial.elementId,
        cursorTabId: partial.cursorTabId,
      });
    }
  }

  // Include snapshot operations (initial document state) before changelog ops
  const allOperations = [...snapshotParsed, ...operations];

  // Step 4: Build tab state from tab lifecycle operations
  const tabs = buildTabState(allOperations);

  // Backfill targetTabId on tab_moved operations using position-to-ID mapping
  const posToTabId = new Map<string, string>();
  for (const tab of tabs) {
    posToTabId.set(JSON.stringify(tab.position), tab.tabId);
  }
  for (const op of operations) {
    if (op.type === "tab_moved" && op.tabEvent?.fromPosition && !op.tabEvent.targetTabId) {
      const key = JSON.stringify(op.tabEvent.fromPosition);
      op.tabEvent.targetTabId = posToTabId.get(key);
      // Update mapping after the move
      if (op.tabEvent.targetTabId && op.tabEvent.position) {
        posToTabId.delete(key);
        posToTabId.set(JSON.stringify(op.tabEvent.position), op.tabEvent.targetTabId);
      }
    }
  }

  return {
    fileId,
    totalRevisions:
      operations.length > 0
        ? operations[operations.length - 1].revisionId
        : 0,
    userMap,
    operations: allOperations,
    tabs,
  };
}

/**
 * Fetch the complete OT changelog from the undocumented /revisions/load endpoint.
 *
 * Steps:
 *   1. Fetch tiles to determine the total changelog length.
 *   2. Paginate /revisions/load in chunks of 1000 (the endpoint rejects
 *      requests where end-start exceeds ~1000-2000, varying per document).
 *   3. Parse each page's anti-XSSI prefix and collect changelog entries.
 *   4. Parse changelog tuples into ChangelogOperation[].
 *
 * FAIL-CLOSED (source-lane patch, restoring gigabrain 5448774's later fix):
 * any page failure, malformed page, short page against a known tile count, or
 * page-cap exhaustion returns null instead of the entries fetched so far - a
 * prefix of the changelog must never be treated as the whole history (it
 * misclassifies suggestion status and would advance sync watermarks).
 * Google rate limits are rethrown so callers can honor Retry-After.
 *
 * Known-total ranges are fetched concurrently again (gigabrain 4a4d68fc,
 * GDOCS_CHANGELOG_PAGE_CONCURRENCY default 8), through the source lane's
 * fail-closed pool: per-credential pacing of the burst (GDOCS_CHANGELOG_MAX_RPS
 * default 5), no dispatch after the first failing range, and the same
 * contiguous-prefix outcome as the serial loop. Open-ended pagination stays
 * serial.
 *
 * Returns null on any other failure (network, auth, malformed response).
 */
export async function fetchDocChangelog(
  userId: string,
  fileId: string,
  knownEntryCount?: number,
  overrideAccessToken?: string,
): Promise<DocChangelog | null> {
  try {
    const accessToken = overrideAccessToken ?? await getGoogleAccessToken(userId, undefined, GOOGLE_DOCS_DELEGATION_SCOPES);

    let totalEntries = knownEntryCount ?? 0;
    const userMap = new Map<string, { name: string; photo?: string; anonymous: boolean }>();

    // Step 1: Fetch tiles to determine total changelog length (skip if caller already knows)
    if (totalEntries === 0) {
      const tilesUrl =
        `https://docs.google.com/document/d/${fileId}/revisions/tiles` +
        `?id=${fileId}&start=1&showDetailedRevisions=true`;
      const tilesRes = await gFetch(tilesUrl, accessToken);

      if (tilesRes.ok) {
        const tilesRaw = await tilesRes.text();
        const tilesData = parseXssiJson(tilesRaw);
        if (tilesData) {
          const tileInfo = tilesData.tileInfo as Array<Record<string, unknown>> | undefined;
          if (tileInfo && tileInfo.length > 0) {
            totalEntries = (tileInfo[tileInfo.length - 1].end as number) ?? 0;
          }
          // Populate userMap from tiles response
          const rawUserMap = (tilesData.userMap as Record<string, Record<string, unknown>>) ?? {};
          for (const [id, info] of Object.entries(rawUserMap)) {
            userMap.set(id, {
              name: (info.name as string) ?? "",
              photo: info.photo as string | undefined,
              anonymous: (info.anonymous as boolean) ?? false,
            });
          }
        }
      }
    }

    // Fallback: if tiles didn't give us a count, paginate iteratively
    // (DO NOT use Drive Revisions API lastRevId - those IDs get merged/compacted
    // and don't correspond to changelog entry indices)
    const totalKnown = totalEntries > 0;

    // Step 2: Paginate /revisions/load in chunks
    const MAX_PAGES = 500; // safety valve: 500 pages × 1000 entries = 500K max entries
    const allEntries: unknown[][] = [];
    let snapshotOps: Array<Record<string, unknown>> = [];

    type LoadedPage = { start: number; end: number; changelog: unknown[][]; chunkedSnapshot?: unknown };
    type LoadFailure = { status: number; message: string };
    const loadPage = async (start: number, end: number): Promise<{ ok: true; page: LoadedPage } | { ok: false; failure: LoadFailure }> => {
      const loadUrl =
        `https://docs.google.com/document/d/${fileId}/revisions/load` +
        `?id=${fileId}&start=${start}&end=${end}`;
      const response = await gFetch(loadUrl, accessToken);
      if (!response.ok) {
        return { ok: false, failure: { status: response.status, message: `/revisions/load failed (${response.status}) for ${fileId} [${start}-${end}]` } };
      }
      const rawText = await response.text();
      const data = parseXssiJson(rawText);
      if (!data) {
        // Response bytes are provider data; log only their size.
        return { ok: false, failure: { status: 0, message: `malformed JSON for ${fileId} [${start}-${end}] (${rawText.length} chars)` } };
      }
      return { ok: true, page: { start, end, changelog: (data.changelog as unknown[][] | undefined) ?? [], chunkedSnapshot: data.chunkedSnapshot } };
    };
    const emptyChangelog = (): DocChangelog => ({ fileId, totalRevisions: 0, userMap, operations: [], tabs: [] });

    if (totalKnown) {
      const ranges = knownTotalRanges(1, totalEntries, CHANGELOG_PAGE_SIZE, MAX_PAGES);
      const pool = await fetchContiguousPages<LoadedPage, LoadFailure>(
        ranges,
        async (range) => {
          const loaded = await loadPage(range.start, range.end);
          if (!loaded.ok) return loaded;
          return { ok: true, page: loaded.page, complete: loaded.page.changelog.length === range.end - range.start + 1 };
        },
        // Per-credential pacing of the concurrent burst, shared with the source lane's capture of the same token.
        { concurrency: changelogPageConcurrency(), pace: changelogPacer(changelogPaceKey(accessToken), changelogRequestsPerSecond()) },
      );
      const rateLimit = pool.errors.find((err) => err instanceof GoogleRateLimitError);
      if (rateLimit) throw rateLimit;
      if (pool.stop) {
        const range = ranges[pool.stoppedAt as number];
        if (pool.stop.kind === "failure" && pool.stoppedAt === 0 && pool.stop.failure.status === 400) {
          // No changelog at all (empty or imported doc)
          return emptyChangelog();
        }
        if (pool.stop.kind === "error") throw pool.stop.error;
        const detail = pool.stop.kind === "failure"
          ? pool.stop.failure.message
          : `incomplete /revisions/load page for ${fileId} [${range.start}-${range.end}] expected ${range.end - range.start + 1} entries, got ${pool.pages[pool.pages.length - 1].changelog.length}`;
        console.error(`fetchDocChangelog: ${detail}; refusing partial changelog`);
        return null;
      }
      if (ranges.length * CHANGELOG_PAGE_SIZE < totalEntries) {
        console.error(
          `fetchDocChangelog: page cap (${MAX_PAGES}) reached for ${fileId} before the end of the changelog; refusing partial changelog`,
        );
        return null;
      }
      for (const page of pool.pages) allEntries.push(...page.changelog);
      // Capture chunkedSnapshot from first page (initial document state)
      snapshotOps = collectSnapshotOps(pool.pages[0]?.chunkedSnapshot);
    } else {
      let start = 1;
      let pageCount = 0;
      let reachedEnd = false;

      while (pageCount < MAX_PAGES) {
        pageCount++;
        const end = start + CHANGELOG_PAGE_SIZE - 1;
        const loaded = await loadPage(start, end);

        if (!loaded.ok) {
          if (allEntries.length === 0 && loaded.failure.status === 400) {
            // No changelog at all (empty or imported doc)
            return emptyChangelog();
          }
          console.error(`fetchDocChangelog: ${loaded.failure.message}; refusing partial changelog`);
          return null;
        }

        const pageChangelog = loaded.page.changelog;
        allEntries.push(...pageChangelog);

        // Capture chunkedSnapshot from first page (initial document state)
        if (start === 1 && snapshotOps.length === 0) {
          snapshotOps = collectSnapshotOps(loaded.page.chunkedSnapshot);
        }

        if (pageChangelog.length < CHANGELOG_PAGE_SIZE) {
          reachedEnd = true;
          break;
        }
        start = end + 1;
      }

      if (!reachedEnd) {
        console.error(
          `fetchDocChangelog: page cap (${MAX_PAGES}) reached for ${fileId} before the end of the changelog; refusing partial changelog`,
        );
        return null;
      }
    }

    return parseChangelogEntries(fileId, allEntries, snapshotOps, userMap);
  } catch (err) {
    if (err instanceof GoogleRateLimitError) throw err;
    console.error(
      `fetchDocChangelog failed for ${fileId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// getOperationsSince
// ---------------------------------------------------------------------------

/**
 * Filter changelog operations to only those after a given timestamp.
 * Used for incremental daily processing - fetch the full changelog once,
 * then slice locally by time.
 */
export function getOperationsSince(
  changelog: DocChangelog,
  since: Date,
): ChangelogOperation[] {
  const sinceMs = since.getTime();
  return changelog.operations.filter((op) => op.timestamp.getTime() > sinceMs);
}

// ---------------------------------------------------------------------------
// buildAuthorAttribution
// ---------------------------------------------------------------------------

/**
 * Build per-author attribution summary for a time window.
 *
 * Aggregates character-level insertions, deletions, and suggestion counts
 * for each unique author within [since, until].  Uses the provided
 * actorEmailResolver callback to map OT changelog userIds to emails.
 */
export async function buildAuthorAttribution(
  changelog: DocChangelog,
  since: Date,
  until: Date,
  actorEmailResolver: (userId: string) => Promise<string | null>,
): Promise<AuthorAttribution[]> {
  const sinceMs = since.getTime();
  const untilMs = until.getTime();

  // Filter operations to the time window
  const windowOps = changelog.operations.filter((op) => {
    const t = op.timestamp.getTime();
    return t >= sinceMs && t <= untilMs;
  });

  if (windowOps.length === 0) return [];

  // Collect unique userIds
  const uniqueUserIds = [...new Set(windowOps.map((op) => op.userId))];

  // Resolve emails
  const emailMap = new Map<string, string>();
  for (const uid of uniqueUserIds) {
    const email = await actorEmailResolver(uid);
    if (email) {
      emailMap.set(uid, email);
    }
  }

  // Aggregate per-author
  const authorMap = new Map<
    string,
    {
      email: string;
      name: string;
      insertions: number;
      deletions: number;
      suggestionsCreated: number;
      suggestionsAccepted: number;
      firstEditAt: Date;
      lastEditAt: Date;
    }
  >();

  for (const op of windowOps) {
    const email = emailMap.get(op.userId) ?? op.userId;
    const userInfo = changelog.userMap.get(op.userId);
    const name = userInfo?.name ?? email;

    let entry = authorMap.get(email);
    if (!entry) {
      entry = {
        email,
        name,
        insertions: 0,
        deletions: 0,
        suggestionsCreated: 0,
        suggestionsAccepted: 0,
        firstEditAt: op.timestamp,
        lastEditAt: op.timestamp,
      };
      authorMap.set(email, entry);
    }

    // Update timestamps
    if (op.timestamp < entry.firstEditAt) entry.firstEditAt = op.timestamp;
    if (op.timestamp > entry.lastEditAt) entry.lastEditAt = op.timestamp;

    // Aggregate counts by operation type
    switch (op.type) {
      case "insert":
        entry.insertions += op.text?.length ?? 0;
        break;
      case "delete":
        entry.deletions +=
          op.endIndex !== undefined && op.startIndex !== undefined
            ? op.endIndex - op.startIndex + 1
            : 0;
        break;
      case "insert_suggestion":
        entry.suggestionsCreated++;
        entry.insertions += op.text?.length ?? 0;
        break;
      case "delete_suggestion":
        entry.suggestionsCreated++;
        entry.deletions +=
          op.endIndex !== undefined && op.startIndex !== undefined
            ? op.endIndex - op.startIndex + 1
            : 0;
        break;
      // format, multi, replace, revert, mark/unmark deletion do not contribute
      // to character counts
    }
  }

  // Count accepted suggestions by position matching.
  // When a suggestion is accepted, Google produces a regular is/ds at the same
  // position. The accepting op does NOT carry the original sugId.
  // Rejected suggestions are usfd/ras ops (already have sugId for exact matching).
  const suggestionPositions = new Map<number, { sugId?: string; userId: string }>();
  const rejectedSugIds = new Set<string>();

  for (const op of windowOps) {
    if ((op.type === "insert_suggestion" || op.type === "delete_suggestion")) {
      suggestionPositions.set(op.startIndex ?? 0, { sugId: op.sugId, userId: op.userId });
    }
    if (op.type === "unmark_deletion" && op.sugId) {
      rejectedSugIds.add(op.sugId);
    }
  }

  for (const op of windowOps) {
    if (op.type === "insert" || op.type === "delete") {
      const pos = op.startIndex ?? -1;
      const suggestion = suggestionPositions.get(pos);
      if (suggestion && !(suggestion.sugId && rejectedSugIds.has(suggestion.sugId))) {
        const email = emailMap.get(op.userId) ?? op.userId;
        const entry = authorMap.get(email);
        if (entry) entry.suggestionsAccepted++;
        suggestionPositions.delete(pos);
      }
    }
  }

  return [...authorMap.values()];
}

// ---------------------------------------------------------------------------
// extractPendingSuggestions
// ---------------------------------------------------------------------------

/**
 * Identify pending (unresolved) suggestions from the OT changelog.
 *
 * A suggestion is "pending" if an insert_suggestion (iss) or delete_suggestion
 * (dss) operation exists without a corresponding accept (subsequent is/ds at
 * the same position) or reject (subsequent usfd/ras at the same sugId).
 *
 * When sugId is available (modern docs), we match by exact suggestion ID.
 * Falls back to position-based matching for older docs without sugId.
 */
export function extractPendingSuggestions(
  changelog: DocChangelog,
): Array<{ userId: string; text: string; position: number; timestamp: Date; sugId?: string }> {
  const pending: Array<{
    userId: string;
    text: string;
    position: number;
    timestamp: Date;
    sugId?: string;
    resolved: boolean;
  }> = [];

  for (const op of changelog.operations) {
    if (op.type === "insert_suggestion") {
      pending.push({
        userId: op.userId,
        text: op.text ?? "",
        position: op.startIndex ?? 0,
        timestamp: op.timestamp,
        sugId: op.sugId,
        resolved: false,
      });
    } else if (op.type === "delete_suggestion" || op.type === "mark_deletion") {
      pending.push({
        userId: op.userId,
        text: "",
        position: op.startIndex ?? 0,
        timestamp: op.timestamp,
        sugId: op.sugId,
        resolved: false,
      });
    }
  }

  // Track which sugIds have been resolved (rejected or accepted)
  const resolvedSugIds = new Set<string>();

  for (const op of changelog.operations) {
    // usfd/ras with a sugId = explicit rejection by suggestion ID
    if (op.type === "unmark_deletion" && op.sugId) {
      resolvedSugIds.add(op.sugId);
    }
  }

  // Mark suggestions as resolved by sugId (exact match) or position (fallback)
  for (const s of pending) {
    if (s.sugId && resolvedSugIds.has(s.sugId)) {
      s.resolved = true;
      continue;
    }
  }

  // Position-based acceptance: an is/ds at the same position as a pending
  // suggestion = acceptance. Works for both sugId and non-sugId suggestions
  // because the accepting is/ds operation does NOT carry the original sugId.
  for (const op of changelog.operations) {
    if (op.type === "insert" || op.type === "delete") {
      for (const s of pending) {
        if (!s.resolved && s.position === (op.startIndex ?? -1)) {
          s.resolved = true;
        }
      }
    } else if (op.type === "unmark_deletion" && !op.sugId) {
      for (const s of pending) {
        if (
          !s.resolved &&
          s.position === (op.startIndex ?? -1) &&
          s.text === ""
        ) {
          s.resolved = true;
        }
      }
    }
  }

  // Return only unresolved suggestions
  return pending
    .filter((s) => !s.resolved)
    .map(({ userId, text, position, timestamp, sugId }) => ({
      userId,
      text,
      position,
      timestamp,
      sugId,
    }));
}


// ---------------------------------------------------------------------------
// Revision tiles
// ---------------------------------------------------------------------------

export async function fetchRevisionTiles(
  userId: string,
  fileId: string,
  detailed: boolean = true,
): Promise<{
  tiles: RevisionTile[];
  userMap: Map<string, { name: string; photo?: string; anonymous: boolean }>;
} | null> {
  try {
    const accessToken = await getGoogleAccessToken(userId, undefined, GOOGLE_DOCS_DELEGATION_SCOPES);
    const url =
      `https://docs.google.com/document/d/${fileId}/revisions/tiles` +
      `?id=${fileId}&start=1&showDetailedRevisions=${detailed}`;
    const res = await gFetch(url, accessToken);
    if (!res.ok) return null;

    const rawText = await res.text();
    const data = parseXssiJson(rawText);
    if (!data) return null;

    const rawTiles = (data.tileInfo as Array<Record<string, unknown>>) ?? [];
    const tiles: RevisionTile[] = rawTiles.map((t) => ({
      start: (t.start as number) ?? 0,
      end: (t.end as number) ?? 0,
      endMillis: (t.endMillis as number) ?? 0,
      users: (t.users as string[]) ?? [],
    }));

    const userMap = new Map<string, { name: string; photo?: string; anonymous: boolean }>();
    const rawUserMap = (data.userMap as Record<string, Record<string, unknown>>) ?? {};
    for (const [id, info] of Object.entries(rawUserMap)) {
      userMap.set(id, {
        name: (info.name as string) ?? "",
        photo: info.photo as string | undefined,
        anonymous: (info.anonymous as boolean) ?? false,
      });
    }

    return { tiles, userMap };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document state replay with diff capture
// ---------------------------------------------------------------------------

export function replayWithDiffs(
  operations: ChangelogOperation[],
  tiles: RevisionTile[],
  userMap: Map<string, { name: string; photo?: string; anonymous: boolean }>,
): EditChunkDiff[] {
  // Per-tab document state - multi-tab docs have separate index spaces per tab
  const tabStates = new Map<string, string[]>();
  const DEFAULT_TAB = "__default__";

  function getTabState(tabId?: string): string[] {
    const key = tabId ?? DEFAULT_TAB;
    let state = tabStates.get(key);
    if (!state) {
      state = [];
      tabStates.set(key, state);
    }
    return state;
  }

  const chunks: EditChunkDiff[] = [];
  let opIndex = 0;

  for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
    const tile = tiles[tileIdx];
    const chunkInsertions: Array<{ text: string; position: number }> = [];
    const chunkDeletions: Array<{ text: string; position: number }> = [];
    let chunkOpCount = 0;

    while (opIndex < operations.length && operations[opIndex].changelogIndex <= tile.end) {
      const op = operations[opIndex];
      const docState = getTabState(op.tabId);

      if (op.type === "insert" || op.type === "insert_suggestion") {
        const text = op.text ?? "";
        const pos = (op.startIndex ?? 1) - 1;
        if (text.length > 0) {
          chunkInsertions.push({ text, position: pos });
          const chars = text.split("");
          docState.splice(pos, 0, ...chars);
        }
        chunkOpCount++;
      } else if (op.type === "delete" || op.type === "delete_suggestion") {
        const si = (op.startIndex ?? 1) - 1;
        const ei = (op.endIndex ?? op.startIndex ?? 1) - 1;
        const count = ei - si + 1;
        if (count > 0 && si < docState.length) {
          const deletedChars = docState.slice(si, si + count);
          const deletedText = deletedChars.join("");
          if (deletedText.length > 0) {
            chunkDeletions.push({ text: deletedText, position: si });
          }
          docState.splice(si, count);
        }
        chunkOpCount++;
      } else if (op.type === "replace" || op.type === "revert") {
        const targetTab = op.tabId ?? DEFAULT_TAB;
        const s = tabStates.get(targetTab);
        if (s) s.length = 0;
        chunkOpCount++;
      } else {
        chunkOpCount++;
      }

      opIndex++;
    }

    if (chunkOpCount === 0) continue;

    const insertedChars = chunkInsertions.reduce((sum, ins) => sum + ins.text.length, 0);
    const deletedChars = chunkDeletions.reduce((sum, del) => sum + del.text.length, 0);

    const authors = tile.users.map((uid) => ({
      userId: uid,
      name: userMap.get(uid)?.name ?? uid,
    }));

    chunks.push({
      tileIndex: tileIdx,
      startOp: tile.start,
      endOp: tile.end,
      timestamp: new Date(tile.endMillis),
      authors,
      insertions: consolidateInsertions(chunkInsertions),
      deletions: consolidateDeletions(chunkDeletions),
      netCharChange: insertedChars - deletedChars,
      operationCount: chunkOpCount,
    });
  }

  return chunks;
}

function consolidateInsertions(
  raw: Array<{ text: string; position: number }>,
): Array<{ text: string; position: number }> {
  if (raw.length === 0) return [];

  const result: Array<{ text: string; position: number }> = [];
  let current = { text: raw[0].text, position: raw[0].position };

  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];
    if (next.position === current.position + current.text.length) {
      current.text += next.text;
    } else {
      result.push(current);
      current = { text: next.text, position: next.position };
    }
  }
  result.push(current);
  return result;
}

function consolidateDeletions(
  raw: Array<{ text: string; position: number }>,
): Array<{ text: string; position: number }> {
  if (raw.length === 0) return [];

  const result: Array<{ text: string; position: number }> = [];
  let current = { text: raw[0].text, position: raw[0].position };

  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];
    if (next.position === current.position) {
      current.text += next.text;
    } else {
      result.push(current);
      current = { text: next.text, position: next.position };
    }
  }
  result.push(current);
  return result;
}

// ---------------------------------------------------------------------------
// buildChunkedDiffs - main entry point
// ---------------------------------------------------------------------------

export async function buildChunkedDiffs(
  userId: string,
  fileId: string,
): Promise<ChunkedDocDiffs | null> {
  // Fetch tiles first (needed for both pagination and chunk boundaries)
  const tilesResult = await fetchRevisionTiles(userId, fileId, true);
  if (!tilesResult || tilesResult.tiles.length === 0) return null;

  const totalEntries = tilesResult.tiles[tilesResult.tiles.length - 1].end;
  const changelog = await fetchDocChangelog(userId, fileId, totalEntries);

  if (!changelog) return null;
  if (changelog.operations.length === 0) return null;

  const chunks = replayWithDiffs(
    changelog.operations,
    tilesResult.tiles,
    tilesResult.userMap,
  );

  return {
    fileId,
    tiles: tilesResult.tiles,
    userMap: tilesResult.userMap,
    chunks,
  };
}
