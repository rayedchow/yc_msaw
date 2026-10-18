/**
 * Tracks the full lifecycle of Google Docs suggestions by grouping
 * OT operations by sugId and correlating with Activity API events.
 *
 * A single suggestion (one sugId) can generate multiple OT operations:
 * - First iss/dss = suggestion created
 * - Subsequent iss/dss with same sugId = suggestion modified
 * - usfd/ras with same sugId = suggestion rejected
 * - is/ds at same position after iss/dss = suggestion accepted
 * - sas with same sugId = suggested formatting change
 * - msfd with same sugId = text marked for deletion in suggestion
 *
 * The tracker deduplicates these into a single SuggestionLifecycle per sugId.
 */

import type { ChangelogOperation, DocChangelog } from "./gdocs-revisions-load.js";
import { humanizeStyleChanges, summarizeStyleChanges } from "./gdocs-style-humanizer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuggestionStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "modified"
  | "deleted";

export interface SuggestionLifecycle {
  sugId: string;
  status: SuggestionStatus;
  /** The user who created the suggestion. */
  authorUserId: string;
  /** When the suggestion was first created. */
  createdAt: Date;
  /** The original suggested text (for insert suggestions). */
  originalText?: string;
  /** The current/latest suggested text (after modifications). */
  currentText?: string;
  /** For delete suggestions: the range being deleted. */
  deleteRange?: { startIndex: number; endIndex: number };
  /** Document position where the suggestion applies. */
  position?: number;
  /** Tab the suggestion is on. */
  tabId?: string;
  /** If this is a formatting suggestion, what style changes. */
  styleChanges?: Record<string, unknown>;
  /** When the suggestion was last modified. */
  lastModifiedAt?: Date;
  /** Who resolved (accepted/rejected) the suggestion, if known. */
  resolvedByUserId?: string;
  /** When the suggestion was resolved. */
  resolvedAt?: Date;
  /** Number of times the suggestion text was modified. */
  modificationCount: number;
  /** All OT operations that belong to this suggestion. */
  operationIndices: number[];
}

export interface SuggestionSummary {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  modified: number;
  deleted: number;
  suggestions: SuggestionLifecycle[];
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/**
 * Build a complete suggestion lifecycle map from a DocChangelog.
 *
 * Groups all suggestion-related operations by sugId, classifies each
 * suggestion's current status, and tracks modifications over time.
 */
export function trackSuggestions(changelog: DocChangelog): SuggestionSummary {
  const sugMap = new Map<string, SuggestionLifecycle>();

  // Pass 1: Group operations by sugId
  for (const op of changelog.operations) {
    if (!op.sugId) continue;

    let lifecycle = sugMap.get(op.sugId);

    if (!lifecycle) {
      lifecycle = {
        sugId: op.sugId,
        status: "pending",
        authorUserId: op.userId,
        createdAt: op.timestamp,
        modificationCount: 0,
        operationIndices: [],
        tabId: op.tabId,
      };
      sugMap.set(op.sugId, lifecycle);
    }

    lifecycle.operationIndices.push(op.changelogIndex);

    switch (op.type) {
      case "insert_suggestion": {
        if (!lifecycle.originalText) {
          // First insert for this sugId = creation
          lifecycle.originalText = op.text;
          lifecycle.currentText = op.text;
          lifecycle.position = op.startIndex;
        } else {
          // Subsequent insert with same sugId = modification
          lifecycle.currentText = op.text;
          lifecycle.position = op.startIndex;
          lifecycle.modificationCount++;
          lifecycle.lastModifiedAt = op.timestamp;
          lifecycle.status = "modified";
        }
        break;
      }
      case "delete_suggestion": {
        if (!lifecycle.deleteRange) {
          // First delete for this sugId = creation
          lifecycle.deleteRange = {
            startIndex: op.startIndex ?? 0,
            endIndex: op.endIndex ?? 0,
          };
          lifecycle.position = op.startIndex;
        } else {
          // Subsequent delete = modification of the range
          lifecycle.deleteRange = {
            startIndex: op.startIndex ?? lifecycle.deleteRange.startIndex,
            endIndex: op.endIndex ?? lifecycle.deleteRange.endIndex,
          };
          lifecycle.modificationCount++;
          lifecycle.lastModifiedAt = op.timestamp;
          lifecycle.status = "modified";
        }
        break;
      }
      case "mark_deletion": {
        // msfd = text marked for deletion within this suggestion
        lifecycle.deleteRange = {
          startIndex: op.startIndex ?? 0,
          endIndex: op.endIndex ?? 0,
        };
        lifecycle.position = lifecycle.position ?? op.startIndex;
        break;
      }
      case "unmark_deletion": {
        // usfd/ras = rejection
        lifecycle.status = "rejected";
        lifecycle.resolvedByUserId = op.userId;
        lifecycle.resolvedAt = op.timestamp;
        break;
      }
      case "format": {
        // sas = suggested formatting change
        const isModification = lifecycle.styleChanges !== undefined;
        lifecycle.styleChanges = op.styleModification ?? lifecycle.styleChanges;
        lifecycle.position = lifecycle.position ?? op.startIndex;
        if (isModification) {
          lifecycle.modificationCount++;
          lifecycle.lastModifiedAt = op.timestamp;
          lifecycle.status = "modified";
        }
        break;
      }
    }

    // Update tabId if we find it on a later operation
    if (op.tabId && !lifecycle.tabId) {
      lifecycle.tabId = op.tabId;
    }
  }

  // Pass 2: Detect acceptances
  // When a suggestion is accepted, Google produces a regular is/ds.
  // Strategy: exact sugId match first (if the accepting op carries sugId),
  // then position+timestamp heuristic as fallback.
  const acceptedSugIds = new Set<string>();

  // 2a: Exact sugId match - is/ds that carries the original sugId
  for (const op of changelog.operations) {
    if (op.type !== "insert" && op.type !== "delete") continue;
    if (!op.sugId) continue;

    const lifecycle = sugMap.get(op.sugId);
    if (lifecycle && (lifecycle.status === "pending" || lifecycle.status === "modified")) {
      if (op.timestamp > lifecycle.createdAt) {
        lifecycle.status = "accepted";
        lifecycle.resolvedByUserId = op.userId;
        lifecycle.resolvedAt = op.timestamp;
        acceptedSugIds.add(op.sugId);
      }
    }
  }

  // 2b: Position+timestamp fallback - for is/ds without sugId
  for (const op of changelog.operations) {
    if (op.type !== "insert" && op.type !== "delete") continue;
    if (op.sugId) continue; // Already handled in 2a

    for (const lifecycle of sugMap.values()) {
      if (lifecycle.status !== "pending" && lifecycle.status !== "modified") continue;
      if (acceptedSugIds.has(lifecycle.sugId)) continue;

      const sugPos = lifecycle.position;
      const opPos = op.startIndex;

      if (sugPos !== undefined && opPos !== undefined && sugPos === opPos) {
        if (op.timestamp > lifecycle.createdAt) {
          lifecycle.status = "accepted";
          lifecycle.resolvedByUserId = op.userId;
          lifecycle.resolvedAt = op.timestamp;
          acceptedSugIds.add(lifecycle.sugId);
          break;
        }
      }
    }
  }

  // Build summary
  const suggestions = [...sugMap.values()];
  return {
    total: suggestions.length,
    pending: suggestions.filter((s) => s.status === "pending").length,
    accepted: suggestions.filter((s) => s.status === "accepted").length,
    rejected: suggestions.filter((s) => s.status === "rejected").length,
    modified: suggestions.filter((s) => s.status === "modified").length,
    deleted: suggestions.filter((s) => s.status === "deleted").length,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Humanized suggestion description
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable description of a suggestion's lifecycle.
 */
export interface SuggestionDescribeContext {
  userMap?: Map<string, { name: string; photo?: string; anonymous: boolean }>;
  tabNames?: Map<string, string>;
}

export function describeSuggestion(s: SuggestionLifecycle, ctx?: SuggestionDescribeContext): string {
  const parts: string[] = [];

  // What was suggested
  if (s.originalText) {
    parts.push(`suggested inserting "${truncate(s.originalText, 60)}"`);
  } else if (s.deleteRange) {
    parts.push(`suggested deleting characters ${s.deleteRange.startIndex}-${s.deleteRange.endIndex}`);
  } else if (s.styleChanges) {
    const humanized = humanizeStyleChanges(s.styleChanges);
    const desc = summarizeStyleChanges(humanized);
    parts.push(desc ? `suggested ${desc}` : "suggested a formatting change");
  } else {
    parts.push("created a suggestion");
  }

  // Tab context - resolve to name if possible
  if (s.tabId) {
    const tabName = ctx?.tabNames?.get(s.tabId);
    parts.push(tabName ? `on tab "${tabName}"` : `on tab ${s.tabId}`);
  }

  // Modifications
  if (s.modificationCount > 0 && s.currentText && s.currentText !== s.originalText) {
    parts.push(`modified ${s.modificationCount}x to "${truncate(s.currentText, 60)}"`);
  } else if (s.modificationCount > 0) {
    parts.push(`modified ${s.modificationCount}x`);
  }

  // Resolution - resolve userId to name if possible
  if (s.status === "accepted") {
    const resolverName = s.resolvedByUserId && ctx?.userMap?.get(s.resolvedByUserId)?.name;
    const atTime = s.resolvedAt ? ` at ${s.resolvedAt.toISOString().slice(11, 19)}` : "";
    parts.push(resolverName ? `accepted by ${resolverName}${atTime}` : `accepted${atTime}`);
  } else if (s.status === "rejected") {
    const resolverName = s.resolvedByUserId && ctx?.userMap?.get(s.resolvedByUserId)?.name;
    const atTime = s.resolvedAt ? ` at ${s.resolvedAt.toISOString().slice(11, 19)}` : "";
    parts.push(resolverName ? `rejected by ${resolverName}${atTime}` : `rejected${atTime}`);
  } else if (s.status === "pending" || s.status === "modified") {
    const since = s.createdAt ? ` (since ${s.createdAt.toISOString().slice(11, 19)})` : "";
    const modAt = s.modificationCount > 0 && s.lastModifiedAt
      ? `, last modified at ${s.lastModifiedAt.toISOString().slice(11, 19)}`
      : "";
    parts.push(`still pending${since}${modAt}`);
  }

  return parts.join(", ");
}

/**
 * Produce a compact summary of all suggestions in a document.
 */
export function summarizeSuggestions(summary: SuggestionSummary): string {
  if (summary.total === 0) return "";

  const parts: string[] = [`${summary.total} suggestion(s)`];

  if (summary.accepted > 0) parts.push(`${summary.accepted} accepted`);
  if (summary.rejected > 0) parts.push(`${summary.rejected} rejected`);
  if (summary.pending > 0) parts.push(`${summary.pending} pending`);
  if (summary.modified > 0) parts.push(`${summary.modified} modified`);
  if (summary.deleted > 0) parts.push(`${summary.deleted} deleted`);

  return parts.join(", ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
