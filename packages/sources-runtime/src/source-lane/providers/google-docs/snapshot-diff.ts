/**
 * Official-API snapshot diff events (additive cross-check, every auth lane).
 *
 * Ported from gigabrain `21feb7132:brain/src/integrations/google/gdocs/diff-events.ts`
 * (compact line diff: LCS under a 250k-cell matrix, 80-line lookahead
 * fallback above it, 3 context lines; tab hash diff; whitespace-normalized
 * content hash). Deliberate differences, all fidelity fixes:
 *
 *  - NO 12,000-character caps. The donor truncated snapshot text and the
 *    unified diff to 12k chars; here the full before/after tab content is the
 *    archived tab snapshot itself and the diff is complete.
 *  - Keyed by Docs `revisionId` pairs, not by content hash, so A -> B -> A
 *    (a revert) produces a second event instead of colliding with the first.
 *  - Input is the donor's append-only `google_doc_tab_snapshots` rows (which
 *    Aqueduct already captures per revision), so no second snapshot table.
 *
 * This is NOT per-author history: attribution is Drive's lastModifyingUser
 * (or unknown), labelled as such. Per-author OT history is the changelog lane.
 */
import { createHash } from "node:crypto";

const DIFF_CONTEXT_LINES = 3;
const MAX_EXACT_DIFF_MATRIX_CELLS = 250_000;

export interface TabSnapshotText {
  tabId: string;
  tabName: string;
  parentTabId?: string | null;
  content: string;
  contentSha: string;
}

export interface DocSnapshotState {
  revisionId: string;
  capturedAt: string;
  sourceUpdatedAt: string | null;
  title: string;
  tabs: TabSnapshotText[];
  updatedByEmail?: string | null;
  updatedByName?: string | null;
}

export type TabChangeKind = "added" | "removed" | "changed";

export interface SnapshotTabDiff {
  tabId: string;
  tabName: string;
  change: TabChangeKind;
  previousHash?: string;
  currentHash?: string;
  addedLines: number;
  deletedLines: number;
  /** Complete compact unified diff ("@@" separates hunks), never truncated. */
  unifiedDiff: string;
}

export interface SnapshotDiffEvent {
  schema: "procmem.gdocs.snapshot-diff/v1";
  eventType: "doc_snapshot_baselined" | "doc_content_changed";
  sourceEventId: string;
  docId: string;
  title: string;
  previousRevisionId: string | null;
  revisionId: string;
  previousContentHash: string | null;
  contentHash: string;
  structuralHash: string;
  tabHashes: Record<string, string>;
  sourceUpdatedAt: string | null;
  capturedAt: string;
  sourceApi: "docs.documents.get";
  sourceApiSemantics: string;
  stats: { addedLines: number; deletedLines: number; changedTabs: number };
  tabChanges: SnapshotTabDiff[];
  attribution: {
    confidence: "drive_last_modifying_user" | "unknown";
    actorEmail: string | null;
    actorName: string | null;
    note: string;
  };
}

export function hashText(value: string): string {
  return createHash("sha256").update(value.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 32);
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function tabSnapshotText(tab: TabSnapshotText): string {
  return `# ${tab.tabName}\n\n${tab.content}`.trim();
}

export function snapshotHashes(state: DocSnapshotState): { contentHash: string; structuralHash: string; tabHashes: Record<string, string> } {
  const fullText = state.tabs.map((tab) => tabSnapshotText(tab)).join("\n\n");
  return {
    contentHash: hashText(fullText),
    structuralHash: hashJson(state.tabs.map((tab) => ({
      tabId: tab.tabId,
      tabName: tab.tabName,
      parentTabId: tab.parentTabId ?? undefined,
      contentHash: tab.contentSha,
    }))),
    tabHashes: Object.fromEntries(state.tabs.map((tab) => [tab.tabId, tab.contentSha])),
  };
}

type LineChange = { kind: "context" | "delete" | "add"; line: string };

export function lineChanges(before: string[], after: string[]): LineChange[] {
  const matrixCells = (before.length + 1) * (after.length + 1);
  if (matrixCells > MAX_EXACT_DIFF_MATRIX_CELLS) {
    return lookaheadLineChanges(before, after);
  }
  const width = after.length + 1;
  const lcs = new Uint32Array((before.length + 1) * (after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const index = i * width + j;
      lcs[index] = before[i] === after[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      changes.push({ kind: "context", line: before[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      changes.push({ kind: "delete", line: before[i++] });
    } else {
      changes.push({ kind: "add", line: after[j++] });
    }
  }
  while (i < before.length) changes.push({ kind: "delete", line: before[i++] });
  while (j < after.length) changes.push({ kind: "add", line: after[j++] });
  return changes;
}

function lookaheadLineChanges(before: string[], after: string[]): LineChange[] {
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      changes.push({ kind: "context", line: before[i] });
      i++;
      j++;
      continue;
    }
    const sync = findNextSync(before, after, i, j);
    if (!sync) {
      changes.push({ kind: "delete", line: before[i++] });
      changes.push({ kind: "add", line: after[j++] });
      continue;
    }
    while (i < sync.beforeIndex) changes.push({ kind: "delete", line: before[i++] });
    while (j < sync.afterIndex) changes.push({ kind: "add", line: after[j++] });
  }
  while (i < before.length) changes.push({ kind: "delete", line: before[i++] });
  while (j < after.length) changes.push({ kind: "add", line: after[j++] });
  return changes;
}

function findNextSync(
  before: string[],
  after: string[],
  beforeIndex: number,
  afterIndex: number,
): { beforeIndex: number; afterIndex: number } | null {
  const lookahead = 80;
  for (let distance = 1; distance <= lookahead; distance++) {
    for (let beforeOffset = 0; beforeOffset <= distance; beforeOffset++) {
      const afterOffset = distance - beforeOffset;
      const candidateBefore = beforeIndex + beforeOffset;
      const candidateAfter = afterIndex + afterOffset;
      if (
        candidateBefore < before.length
        && candidateAfter < after.length
        && before[candidateBefore] === after[candidateAfter]
      ) {
        return { beforeIndex: candidateBefore, afterIndex: candidateAfter };
      }
    }
  }
  return null;
}

function renderCompactDiff(changes: LineChange[]): string[] {
  const changedIndexes = changes
    .map((change, index) => change.kind === "context" ? -1 : index)
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const range = {
      start: Math.max(0, index - DIFF_CONTEXT_LINES),
      end: Math.min(changes.length, index + DIFF_CONTEXT_LINES + 1),
    };
    const previous = ranges.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      ranges.push(range);
    }
  }

  const lines: string[] = [];
  for (const range of ranges) {
    if (lines.length > 0) lines.push("@@");
    for (const change of changes.slice(range.start, range.end)) {
      const prefix = change.kind === "add" ? "+" : change.kind === "delete" ? "-" : " ";
      lines.push(`${prefix}${change.line}`);
    }
  }
  return lines;
}

/** Full (uncapped) compact line diff between two texts. */
export function compactLineDiff(previousText: string, currentText: string): {
  unifiedDiff: string;
  addedLines: number;
  deletedLines: number;
} {
  const changes = lineChanges(previousText.split("\n"), currentText.split("\n"));
  return {
    unifiedDiff: renderCompactDiff(changes).join("\n"),
    addedLines: changes.filter((change) => change.kind === "add" && change.line.trim().length > 0).length,
    deletedLines: changes.filter((change) => change.kind === "delete" && change.line.trim().length > 0).length,
  };
}

/** Pure: diff two consecutive revision snapshots of one doc. */
export function buildSnapshotDiffEvent(docId: string, previous: DocSnapshotState | null, current: DocSnapshotState): SnapshotDiffEvent {
  const currentHashes = snapshotHashes(current);
  const previousHashes = previous ? snapshotHashes(previous) : null;
  const prevTabs = new Map((previous?.tabs ?? []).map((tab) => [tab.tabId, tab]));
  const curTabs = new Map(current.tabs.map((tab) => [tab.tabId, tab]));

  const tabChanges: SnapshotTabDiff[] = [];
  if (previous) {
    const tabIds = [...new Set([...prevTabs.keys(), ...curTabs.keys()])];
    for (const tabId of tabIds) {
      const before = prevTabs.get(tabId);
      const after = curTabs.get(tabId);
      if (before && after && before.contentSha === after.contentSha && before.tabName === after.tabName) continue;
      const diff = compactLineDiff(before ? tabSnapshotText(before) : "", after ? tabSnapshotText(after) : "");
      tabChanges.push({
        tabId,
        tabName: after?.tabName ?? before?.tabName ?? tabId,
        change: !before ? "added" : !after ? "removed" : "changed",
        ...(before ? { previousHash: before.contentSha } : {}),
        ...(after ? { currentHash: after.contentSha } : {}),
        addedLines: diff.addedLines,
        deletedLines: diff.deletedLines,
        unifiedDiff: diff.unifiedDiff,
      });
    }
  }

  const actorEmail = current.updatedByEmail ?? null;
  const actorName = current.updatedByName ?? null;
  return {
    schema: "procmem.gdocs.snapshot-diff/v1",
    eventType: previous ? "doc_content_changed" : "doc_snapshot_baselined",
    sourceEventId: previous
      ? `gdocs:diff:${docId}:${previous.revisionId}:${current.revisionId}`
      : `gdocs:baseline:${docId}:${current.revisionId}`,
    docId,
    title: current.title,
    previousRevisionId: previous?.revisionId ?? null,
    revisionId: current.revisionId,
    previousContentHash: previousHashes?.contentHash ?? null,
    contentHash: currentHashes.contentHash,
    structuralHash: currentHashes.structuralHash,
    tabHashes: currentHashes.tabHashes,
    sourceUpdatedAt: current.sourceUpdatedAt,
    capturedAt: current.capturedAt,
    sourceApi: "docs.documents.get",
    sourceApiSemantics: previous
      ? "Official Docs snapshot diff between two captured revisions; not per-keystroke or per-author revision history. Intermediate revisions between captures are not observed."
      : "Official Docs snapshot baseline; later captured revisions are diffed against it.",
    stats: {
      addedLines: tabChanges.reduce((sum, tab) => sum + tab.addedLines, 0),
      deletedLines: tabChanges.reduce((sum, tab) => sum + tab.deletedLines, 0),
      changedTabs: tabChanges.length,
    },
    tabChanges,
    attribution: {
      confidence: actorEmail || actorName ? "drive_last_modifying_user" : "unknown",
      actorEmail,
      actorName,
      note: "Google Drive metadata names the last modifying user; the official Docs API snapshot does not prove who typed each changed line.",
    },
  };
}
