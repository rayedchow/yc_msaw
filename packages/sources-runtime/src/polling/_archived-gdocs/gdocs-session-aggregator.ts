/**
 * Session Aggregator — combines pre-synthesis outputs into structured LLM input.
 *
 * Takes raw OT operations since the last synthesis watermark, groups them into
 * sessions (5-min gap = new session), runs the pre-synthesis modules, and produces
 * a structured AggregatedSession per completed session. Maintains a per-tab document
 * state via OT replay so format changes can be annotated with affected text.
 */

import type {
  ChangelogOperation,
  DocChangelog,
  TabInfo,
  RevisionTile,
} from "./gdocs-revisions-load.js";
import { humanizeStyleChanges, summarizeStyleChanges, humanizeElementType } from "./gdocs-style-humanizer.js";
import { trackSuggestions, describeSuggestion, type SuggestionSummary, type SuggestionDescribeContext } from "./gdocs-suggestion-tracker.js";
import { analyzeSessionPatterns, type SessionAnalysis } from "./gdocs-behavior-detector.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  timestamp: Date;
  description: string;
}

export interface TabActivity {
  tabId: string;
  tabName: string;
  charsInserted: number;
  charsDeleted: number;
  timeline: TimelineEntry[];
  fullContent: string;
}

export interface AggregatedSession {
  authorUserId: string;
  authorName: string;
  startTime: Date;
  endTime: Date;
  durationMinutes: number;
  activeTimeMinutes: number;
  typingSpeedCpm: number;

  tabActivity: TabActivity[];
  suggestions: SuggestionSummary;

  operationCount: number;
  startEntry: number;
  endEntry: number;
}

export interface SessionAggregationResult {
  completedSessions: AggregatedSession[];
  pendingOps: ChangelogOperation[];
  lastSynthesizedEntry: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_BREAK_MS = 5 * 60 * 1000;
const TEXT_SAMPLE_MAX = 500;

// ---------------------------------------------------------------------------
// Session grouping
// ---------------------------------------------------------------------------

interface RawSession {
  userId: string;
  ops: ChangelogOperation[];
  startTime: Date;
  endTime: Date;
}

function groupIntoSessions(ops: ChangelogOperation[]): RawSession[] {
  if (ops.length === 0) return [];

  const byUser = new Map<string, ChangelogOperation[]>();
  for (const op of ops) {
    const list = byUser.get(op.userId) ?? [];
    list.push(op);
    byUser.set(op.userId, list);
  }

  const sessions: RawSession[] = [];

  for (const [userId, userOps] of byUser) {
    const sorted = userOps.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    let sessionStart = 0;

    for (let i = 1; i <= sorted.length; i++) {
      const isLast = i === sorted.length;
      const gap = isLast ? Infinity : sorted[i].timestamp.getTime() - sorted[i - 1].timestamp.getTime();

      if (gap >= SESSION_BREAK_MS) {
        const sessionOps = sorted.slice(sessionStart, i);
        sessions.push({
          userId,
          ops: sessionOps,
          startTime: sessionOps[0].timestamp,
          endTime: sessionOps[sessionOps.length - 1].timestamp,
        });
        sessionStart = i;
      }
    }
  }

  return sessions.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

function isSessionComplete(session: RawSession): boolean {
  return Date.now() - session.endTime.getTime() > SESSION_BREAK_MS;
}

// ---------------------------------------------------------------------------
// OT replay for per-tab document state + format text extraction
// ---------------------------------------------------------------------------

interface ReplayState {
  tabStates: Map<string, string[]>;
}

function createReplayState(): ReplayState {
  return { tabStates: new Map() };
}

function getTabContent(state: ReplayState, tabId: string): string[] {
  let s = state.tabStates.get(tabId);
  if (!s) {
    s = [];
    state.tabStates.set(tabId, s);
  }
  return s;
}

function getFullTabText(state: ReplayState, tabId: string): string {
  return (state.tabStates.get(tabId) ?? []).join("");
}

function applyOp(state: ReplayState, op: ChangelogOperation): void {
  const tabId = op.tabId ?? "__default__";
  const doc = getTabContent(state, tabId);

  if (op.type === "insert" || op.type === "insert_suggestion") {
    const text = op.text ?? "";
    const pos = (op.startIndex ?? 1) - 1;
    if (text.length > 0) doc.splice(pos, 0, ...text.split(""));
  } else if (op.type === "delete" || op.type === "delete_suggestion") {
    const si = (op.startIndex ?? 1) - 1;
    const ei = (op.endIndex ?? op.startIndex ?? 1) - 1;
    const count = ei - si + 1;
    if (count > 0 && si < doc.length) doc.splice(si, count);
  } else if (op.type === "replace" || op.type === "revert") {
    const targetTab = op.tabId ?? "__default__";
    const s = state.tabStates.get(targetTab);
    if (s) s.length = 0;
  }
}

function getTextAtRange(state: ReplayState, tabId: string, si?: number, ei?: number): string {
  if (si == null || ei == null) return "";
  const doc = state.tabStates.get(tabId ?? "__default__") ?? [];
  const start = si - 1;
  const end = Math.min(ei, doc.length);
  if (start >= doc.length || start < 0) return "";
  const text = doc.slice(start, end).join("");
  return text.length > 80 ? text.slice(0, 80) + "..." : text;
}

// ---------------------------------------------------------------------------
// Full doc replay (for cold-start: replay all ops, return per-tab text)
// ---------------------------------------------------------------------------

export function replayFullDoc(
  ops: ChangelogOperation[],
): Map<string, string> {
  const state = createReplayState();
  for (const op of ops) applyOp(state, op);
  const result = new Map<string, string>();
  for (const [tabId, chars] of state.tabStates) {
    const text = chars.join("");
    if (text.length > 0) result.set(tabId, text);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build per-tab activity
// ---------------------------------------------------------------------------

function buildTabActivity(
  ops: ChangelogOperation[],
  replayState: ReplayState,
  tabs: TabInfo[],
  allOps: ChangelogOperation[],
): TabActivity[] {
  const tabMap = new Map<string, TabInfo>();
  for (const t of tabs) tabMap.set(t.tabId, t);

  const activities = new Map<string, {
    insertChars: number;
    deleteChars: number;
    timeline: TimelineEntry[];
  }>();

  function getActivity(tabId: string) {
    let a = activities.get(tabId);
    if (!a) {
      a = { insertChars: 0, deleteChars: 0, timeline: [] };
      activities.set(tabId, a);
    }
    return a;
  }

  const CTX = 40;
  const MARKER = "\x00INS\x00";

  function esc(s: string): string { return s.replace(/\n/g, "↵"); }

  function getContext(doc: string[], pos: number, len: number): string {
    const before = esc(doc.slice(Math.max(0, pos - CTX), pos).join(""));
    const after = esc(doc.slice(pos + len, Math.min(doc.length, pos + len + CTX)).join(""));
    return before || after ? `${before ? "..." + before : ""}${MARKER}${after ? after + "..." : ""}` : "";
  }

  // Accumulator for consecutive contiguous inserts (avoids one entry per keystroke)
  let pendingInsert: { tabId: string; text: string; pos: number; preContext: string; timestamp: Date } | null = null;

  function flushInsert() {
    if (!pendingInsert) return;
    const a = getActivity(pendingInsert.tabId);
    const text = pendingInsert.text;
    const sample = esc(text.length > 150 ? text.slice(0, 150) + "..." : text);
    const parts = pendingInsert.preContext.split(MARKER);
    const ctx = parts.length === 2 ? `${parts[0]}[${sample}]${parts[1]}` : "";
    a.timeline.push({
      timestamp: pendingInsert.timestamp,
      description: ctx ? `Added ${text.length} chars — ${ctx}` : `Added ${text.length} chars: "${sample}"`,
    });
    pendingInsert = null;
  }

  for (const op of ops) {
    const tabId = op.tabId ?? "__default__";
    const a = getActivity(tabId);

    if (op.type === "insert" || op.type === "insert_suggestion") {
      const text = op.text ?? "";
      a.insertChars += text.length;
      const newPos = (op.startIndex ?? 1) - 1;
      const isContiguous = pendingInsert
        && pendingInsert.tabId === tabId
        && pendingInsert.pos + pendingInsert.text.length === newPos;
      if (isContiguous) {
        pendingInsert!.text += text;
        pendingInsert!.timestamp = op.timestamp;
      } else {
        flushInsert();
        const doc = replayState.tabStates.get(tabId) ?? [];
        const preCtx = getContext(doc, newPos, 0);
        pendingInsert = { tabId, text, pos: newPos, preContext: preCtx, timestamp: op.timestamp };
      }
    } else if (op.type === "delete" || op.type === "delete_suggestion") {
      flushInsert();
      const si = (op.startIndex ?? 1) - 1;
      const ei = (op.endIndex ?? op.startIndex ?? 1) - 1;
      const count = ei - si + 1;
      const doc = replayState.tabStates.get(tabId) ?? [];
      const actualCount = (si < doc.length && count > 0) ? Math.min(count, doc.length - si) : 0;
      a.deleteChars += actualCount;
      if (actualCount > 0) {
        const deleted = doc.slice(si, si + actualCount).join("");
        const sample = esc(deleted.length > 80 ? deleted.slice(0, 80) + "..." : deleted);
        const before = esc(doc.slice(Math.max(0, si - CTX), si).join(""));
        const after = esc(doc.slice(si + actualCount, Math.min(doc.length, si + actualCount + CTX)).join(""));
        const ctx = (before || after) ? `${before ? "..." + before : ""}[${sample}]${after ? after + "..." : ""}` : `"${sample}"`;
        a.timeline.push({ timestamp: op.timestamp, description: `Deleted ${actualCount} chars — ${ctx}` });
      }
    } else if (op.type === "format" && op.styleModification) {
      flushInsert();
      const affectedText = getTextAtRange(replayState, tabId, op.startIndex, op.endIndex);
      const changes = humanizeStyleChanges(op.styleModification);
      const summary = summarizeStyleChanges(changes);
      if (summary) {
        a.timeline.push({
          timestamp: op.timestamp,
          description: affectedText ? `Format: ${summary} on "${affectedText}"` : `Format: ${summary}`,
        });
      }
    } else if (op.type === "tab_created") {
      flushInsert();
      const name = op.tabEvent?.tabName;
      a.timeline.push({ timestamp: op.timestamp, description: name ? `Created tab "${name}"` : "Created tab" });
    } else if (op.type === "tab_deleted") {
      flushInsert();
      a.timeline.push({ timestamp: op.timestamp, description: "Deleted tab" });
    } else if (op.type === "tab_config") {
      flushInsert();
      const targetId = op.tabEvent?.targetTabId;
      const isExisting = targetId && (replayState.tabStates.has(targetId) || tabs.some((t) => t.tabId === targetId));
      if (isExisting) {
        a.timeline.push({ timestamp: op.timestamp, description: "Deleted tab" });
      }
    } else if (op.type === "tab_renamed") {
      flushInsert();
      const newName = op.tabEvent?.tabName;
      a.timeline.push({ timestamp: op.timestamp, description: newName ? `Renamed tab to "${newName}"` : "Renamed tab" });
    } else if (op.type === "tab_moved") {
      flushInsert();
      const pos = op.tabEvent?.position;
      a.timeline.push({ timestamp: op.timestamp, description: pos ? `Moved tab to position ${pos.join(".")}` : "Moved tab" });
    } else if (op.type === "add_element") {
      flushInsert();
      a.timeline.push({ timestamp: op.timestamp, description: `Added ${humanizeElementType(op.elementType)}` });
    } else if (op.type === "delete_element") {
      flushInsert();
      a.timeline.push({ timestamp: op.timestamp, description: `Deleted ${humanizeElementType(op.elementType)}` });
    } else if (op.type === "update_element") {
      flushInsert();
      a.timeline.push({ timestamp: op.timestamp, description: `Updated ${humanizeElementType(op.elementType)}` });
    } else if (op.type === "tether_element") {
      flushInsert();
      a.timeline.push({ timestamp: op.timestamp, description: `Anchored ${humanizeElementType(op.elementType)}` });
    } else if (op.type === "replace" || op.type === "revert") {
      flushInsert();
      a.timeline.push({ timestamp: op.timestamp, description: op.type === "replace" ? "Document replaced (full snapshot)" : "Document reverted to previous version" });
    } else if (op.type === "mark_deletion" || op.type === "unmark_deletion") {
      flushInsert();
      const markedText = getTextAtRange(replayState, tabId, op.startIndex, op.endIndex);
      const desc = op.type === "mark_deletion"
        ? (markedText ? `Suggested deleting "${markedText}"` : "Suggested deletion")
        : (markedText ? `Removed suggested deletion of "${markedText}"` : "Removed suggested deletion");
      a.timeline.push({ timestamp: op.timestamp, description: desc });
    } else {
      flushInsert();
    }

    applyOp(replayState, op);
  }
  flushInsert();

  const result: TabActivity[] = [];
  for (const [tabId, a] of activities) {
    if (a.insertChars === 0 && a.deleteChars === 0 && a.timeline.length === 0) continue;

    const tabInfo = tabMap.get(tabId);
    result.push({
      tabId,
      tabName: tabInfo?.name ?? (tabId === "__default__" ? "Main" : tabId),
      charsInserted: a.insertChars,
      charsDeleted: a.deleteChars,
      timeline: a.timeline,
      fullContent: getFullTabText(replayState, tabId),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main aggregation function
// ---------------------------------------------------------------------------

export function aggregateSessions(
  changelog: DocChangelog,
  newOps: ChangelogOperation[],
  pendingBuffer: ChangelogOperation[],
  allPriorOps: ChangelogOperation[],
  lastSynthesizedEntry: number,
): SessionAggregationResult {
  // Deduplicate by changelogIndex — pendingBuffer and newOps can overlap
  // when watermark doesn't advance (no completed sessions across runs)
  const seen = new Set<number>();
  const allUnsynthesized: ChangelogOperation[] = [];
  for (const op of [...pendingBuffer, ...newOps]) {
    if (!seen.has(op.changelogIndex)) {
      seen.add(op.changelogIndex);
      allUnsynthesized.push(op);
    }
  }
  if (allUnsynthesized.length === 0) {
    return { completedSessions: [], pendingOps: [], lastSynthesizedEntry };
  }

  const sessions = groupIntoSessions(allUnsynthesized);
  const completed: AggregatedSession[] = [];
  const pendingOps: ChangelogOperation[] = [];

  // Track suggestions across the full changelog so cross-user acceptance is visible
  const fullSuggestions = trackSuggestions(changelog);
  const sugBySugId = new Map(fullSuggestions.suggestions.map((s) => [s.sugId, s]));

  // Replay all prior ops to build document state before these sessions
  const replayState = createReplayState();
  for (const op of allPriorOps) {
    applyOp(replayState, op);
  }

  let highestSynthesizedEntry = lastSynthesizedEntry;

  for (const session of sessions) {
    if (!isSessionComplete(session)) {
      pendingOps.push(...session.ops);
      for (const op of session.ops) applyOp(replayState, op);
      continue;
    }

    // Build tab activity with format text context
    const tabActivity = buildTabActivity(session.ops, replayState, changelog.tabs, changelog.operations);

    // Run behavior detection on this session's ops
    const sessionChangelog: DocChangelog = {
      fileId: changelog.fileId,
      totalRevisions: session.ops.length,
      userMap: changelog.userMap,
      operations: session.ops,
      tabs: changelog.tabs,
    };
    // Filter full-changelog suggestions to those relevant to this session
    const sessionSugIds = new Set(session.ops.filter((o) => o.sugId).map((o) => o.sugId!));
    const sessionSuggestions = fullSuggestions.suggestions.filter((s) => sessionSugIds.has(s.sugId));
    const suggestions: SuggestionSummary = {
      total: sessionSuggestions.length,
      pending: sessionSuggestions.filter((s) => s.status === "pending" || s.status === "modified").length,
      accepted: sessionSuggestions.filter((s) => s.status === "accepted").length,
      rejected: sessionSuggestions.filter((s) => s.status === "rejected").length,
      modified: sessionSuggestions.filter((s) => s.status === "modified").length,
      deleted: sessionSuggestions.filter((s) => s.status === "deleted").length,
      suggestions: sessionSuggestions,
    };

    // Compute active time from session patterns
    const sessionPatterns = analyzeSessionPatterns(session.ops);
    const userSessions = sessionPatterns.filter((s) => s.userId === session.userId);
    const activeTimeMs = userSessions.reduce((sum, s) => sum + s.activeTimeMs, 0);
    const totalCharsInserted = userSessions.reduce((sum, s) => sum + s.charsInserted, 0);
    const totalActiveMin = activeTimeMs / 60_000;
    const avgCpm = totalActiveMin > 0 ? totalCharsInserted / totalActiveMin : 0;

    // Build format change summary
    const userName = changelog.userMap.get(session.userId)?.name ?? session.userId;
    const durationMs = session.endTime.getTime() - session.startTime.getTime();

    const endEntry = session.ops.reduce((max, o) => o.changelogIndex > max ? o.changelogIndex : max, session.ops[0].changelogIndex);
    const startEntry = session.ops.reduce((min, o) => o.changelogIndex < min ? o.changelogIndex : min, session.ops[0].changelogIndex);

    completed.push({
      authorUserId: session.userId,
      authorName: userName,
      startTime: session.startTime,
      endTime: session.endTime,
      durationMinutes: Math.round(durationMs / 60_000 * 10) / 10,
      activeTimeMinutes: Math.round(activeTimeMs / 60_000 * 10) / 10,
      typingSpeedCpm: Math.round(avgCpm),
      tabActivity,
      suggestions,
      operationCount: session.ops.length,
      startEntry,
      endEntry,
    });

    if (endEntry > highestSynthesizedEntry) {
      highestSynthesizedEntry = endEntry;
    }
  }

  return {
    completedSessions: completed,
    pendingOps,
    lastSynthesizedEntry: highestSynthesizedEntry,
  };
}

// ---------------------------------------------------------------------------
// Format session data for LLM input
// ---------------------------------------------------------------------------

export interface LLMTabInput {
  tabId: string;
  tabName: string;
  previousSummary: string;
  fullContent: string;
  changes: string;
}

export interface LLMSessionInput {
  author: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  activeTimeMinutes: number;
  typingSpeedCpm: number;
  operationCount: number;
  tabs: LLMTabInput[];
  suggestions: string;
  comments: string;
}

export interface CommentEvent {
  eventType: string;
  authorName: string;
  content: string | null;
  quotedText: string | null;
  timestamp: string;
}

export function formatForLLM(
  session: AggregatedSession,
  previousTabSummaries: Map<string, string>,
  sugCtx?: SuggestionDescribeContext,
  commentEvents?: CommentEvent[],
): LLMSessionInput {
  const tabs: LLMTabInput[] = session.tabActivity.map((ta) => {
    // Timeline entries — chronological order, cap at 30 to stay within token budget
    const timelineLines = ta.timeline.slice(0, 30).map((e) => {
      const time = e.timestamp.toISOString().slice(11, 19);
      return `[${time}] ${e.description}`;
    });
    if (ta.timeline.length > 30) {
      timelineLines.push(`... and ${ta.timeline.length - 30} more events`);
    }

    // Summary line at top
    const summaryParts: string[] = [];
    if (ta.charsInserted > 0) summaryParts.push(`+${ta.charsInserted} chars`);
    if (ta.charsDeleted > 0) summaryParts.push(`-${ta.charsDeleted} chars`);
    const summaryLine = summaryParts.length > 0 ? `Net: ${summaryParts.join(", ")}` : "";

    const changes = [summaryLine, ...timelineLines].filter(Boolean).join("\n");

    return {
      tabId: ta.tabId,
      tabName: ta.tabName,
      previousSummary: previousTabSummaries.get(ta.tabId) ?? "(no previous summary)",
      fullContent: ta.fullContent,
      changes,
    };
  });

  // Suggestions
  const sugLines: string[] = [];
  const s = session.suggestions;
  if (s.total > 0) {
    sugLines.push(`${s.total} suggestion(s): ${s.accepted} accepted, ${s.rejected} rejected, ${s.pending} pending`);
    for (const sug of s.suggestions.slice(0, 8)) {
      sugLines.push(`  - ${describeSuggestion(sug, sugCtx)}`);
    }
    if (s.suggestions.length > 8) {
      sugLines.push(`  ... and ${s.suggestions.length - 8} more`);
    }
  }

  // Comments from Activity API
  const commentLines: string[] = [];
  if (commentEvents && commentEvents.length > 0) {
    for (const c of commentEvents.slice(0, 15)) {
      const typeLabel = c.eventType
        .replace("doc_", "")
        .replace(/_/g, " ");
      const time = c.timestamp ? new Date(c.timestamp).toISOString().slice(11, 19) : "";
      let line = `[${time}] ${c.authorName}: ${typeLabel}`;
      if (c.content) line += ` — "${c.content.slice(0, 200)}"`;
      if (c.quotedText) line += ` (on: "${c.quotedText.slice(0, 100)}")`;
      commentLines.push(line);
    }
    if (commentEvents.length > 15) {
      commentLines.push(`... and ${commentEvents.length - 15} more`);
    }
  }

  return {
    author: session.authorName,
    startTime: session.startTime.toISOString(),
    endTime: session.endTime.toISOString(),
    durationMinutes: session.durationMinutes,
    activeTimeMinutes: session.activeTimeMinutes,
    typingSpeedCpm: session.typingSpeedCpm,
    operationCount: session.operationCount,
    tabs,
    suggestions: sugLines.join("\n") || "none",
    comments: commentLines.join("\n") || "none",
  };
}
