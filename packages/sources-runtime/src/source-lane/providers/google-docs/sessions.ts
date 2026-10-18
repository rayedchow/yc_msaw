/**
 * Session diff events from a COMPLETE OT changelog. Deterministic, no LLM.
 *
 * Session boundaries are exactly the pinned gigabrain aggregator's
 * (`gdocs-session-aggregator.ts` @ 5448774: per user, a gap >= 5 minutes
 * starts a new session, and a session is only "complete" once its last op is
 * more than 5 minutes old). The donor `aggregateSessions` output is kept per
 * session as `donorAggregate` (humanized per-tab timeline, chars, active time,
 * suggestion lifecycle), minus its `fullContent` copies of the tab text.
 *
 * The donor aggregator replays ops in SESSION order (sessions sorted by start
 * time, each applied whole), which reorders concurrent users' ops. The
 * before/after states here are instead produced by replaying the whole
 * changelog in TRUE changelog order with the same apply semantics as the donor
 * (`applyOp` / `replayWithDiffs`: insert & insert_suggestion splice, delete &
 * delete_suggestion splice, replace/revert clear the tab), so each session's
 * `before` is the doc state just before its first op and `after` the state
 * just after its last op, with other users' interleaved ops listed. Element
 * ops (tables, lists, images) are not modelled by the donor replay; they are
 * recorded as ops but do not change the replayed text.
 */
import { createHash } from "node:crypto";
import type { ChangelogOperation, DocChangelog } from "../../../polling/_archived-gdocs/gdocs-revisions-load.js";
import { aggregateSessions, type AggregatedSession } from "../../../polling/_archived-gdocs/gdocs-session-aggregator.js";
import { compactLineDiff } from "./snapshot-diff.js";

export const SESSION_GAP_MS = 5 * 60 * 1000;
const DEFAULT_TAB = "__default__";

export interface ReplayedOp {
  changelogIndex: number;
  revisionId: number;
  /** Raw OT changelog session id (not the 5-minute session). */
  otSessionId: string;
  timestamp: string;
  userId: string;
  type: ChangelogOperation["type"];
  tabId: string | null;
  startIndex: number | null;
  endIndex: number | null;
  insertedText?: string;
  /** Text actually removed from the replayed state (delete / delete_suggestion). */
  deletedText?: string;
  sugId?: string;
  styleType?: string;
  styleModification?: Record<string, unknown>;
  elementType?: string;
  elementId?: string;
  tabEvent?: ChangelogOperation["tabEvent"];
  cursorTabId?: string;
}

export interface TextStateRef {
  sha256: string;
  length: number;
}

export interface SessionTabDiff {
  tabId: string;
  tabName: string;
  before: TextStateRef;
  after: TextStateRef;
  addedLines: number;
  deletedLines: number;
  unifiedDiff: string;
}

export interface SessionDiffEvent {
  schema: "procmem.gdocs.session/v1";
  sessionKey: string;
  docId: string;
  actor: { userId: string; name: string | null; anonymous: boolean | null };
  startTime: string;
  endTime: string;
  startEntry: number;
  endEntry: number;
  operationCount: number;
  /** Changelog indices by OTHER users inside [startEntry, endEntry]. */
  interleavedEntries: number[];
  otSessionIds: string[];
  tabs: SessionTabDiff[];
  ops: ReplayedOp[];
  donorAggregate: Omit<AggregatedSession, "tabActivity" | "startTime" | "endTime"> & {
    startTime: string;
    endTime: string;
    tabActivity: Array<{ tabId: string; tabName: string; charsInserted: number; charsDeleted: number; timeline: Array<{ timestamp: string; description: string }> }>;
  };
  grouping: "per-user 5-minute gap (gigabrain 5448774)";
  replay: "true changelog order; text ops only (element ops recorded, not modelled)";
}

export interface SessionBuildResult {
  sessions: SessionDiffEvent[];
  /** Distinct text states referenced by sessions, keyed by sha256. */
  states: Map<string, string>;
  /** Ops in sessions that are not yet complete (< 5 minutes old). */
  pendingOps: number;
  /** When the earliest pending session becomes complete (null = none). */
  pendingCompleteAt: string | null;
}

function textSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

class TrueOrderReplay {
  private readonly tabs = new Map<string, string[]>();

  text(tabId: string): string {
    return (this.tabs.get(tabId) ?? []).join("");
  }

  knownTabs(): string[] {
    return [...this.tabs.keys()];
  }

  apply(op: ChangelogOperation): { insertedText?: string; deletedText?: string } {
    const key = op.tabId ?? DEFAULT_TAB;
    let doc = this.tabs.get(key);
    if (!doc) {
      doc = [];
      this.tabs.set(key, doc);
    }
    if (op.type === "insert" || op.type === "insert_suggestion") {
      const text = op.text ?? "";
      const pos = (op.startIndex ?? 1) - 1;
      if (text.length > 0) doc.splice(pos, 0, ...text.split(""));
      return { insertedText: text };
    }
    if (op.type === "delete" || op.type === "delete_suggestion") {
      const si = (op.startIndex ?? 1) - 1;
      const ei = (op.endIndex ?? op.startIndex ?? 1) - 1;
      const count = ei - si + 1;
      if (count > 0 && si < doc.length) {
        const removed = doc.splice(si, count).join("");
        return { deletedText: removed };
      }
      return { deletedText: "" };
    }
    if (op.type === "replace" || op.type === "revert") {
      doc.length = 0;
    }
    return {};
  }
}

function replayedOp(op: ChangelogOperation, effect: { insertedText?: string; deletedText?: string }): ReplayedOp {
  return {
    changelogIndex: op.changelogIndex,
    revisionId: op.revisionId,
    otSessionId: op.sessionId,
    timestamp: op.timestamp.toISOString(),
    userId: op.userId,
    type: op.type,
    tabId: op.tabId ?? null,
    startIndex: op.startIndex ?? null,
    endIndex: op.endIndex ?? null,
    ...(effect.insertedText !== undefined ? { insertedText: effect.insertedText } : {}),
    ...(effect.deletedText !== undefined ? { deletedText: effect.deletedText } : {}),
    ...(op.sugId ? { sugId: op.sugId } : {}),
    ...(op.styleType ? { styleType: op.styleType } : {}),
    ...(op.styleModification ? { styleModification: op.styleModification } : {}),
    ...(op.elementType ? { elementType: op.elementType } : {}),
    ...(op.elementId ? { elementId: op.elementId } : {}),
    ...(op.tabEvent ? { tabEvent: op.tabEvent } : {}),
    ...(op.cursorTabId ? { cursorTabId: op.cursorTabId } : {}),
  };
}

/** Replay every op in changelog order; returns per-op effects (exact deleted text). */
export function replayChangelog(changelog: DocChangelog): ReplayedOp[] {
  const replay = new TrueOrderReplay();
  return changelog.operations.map((op) => replayedOp(op, replay.apply(op)));
}

function sessionKey(session: { startTime: Date; startEntry: number; authorUserId: string }): string {
  const iso = session.startTime.toISOString().replace(/[:.]/g, "-");
  return `${iso}-e${String(session.startEntry).padStart(7, "0")}-${createHash("sha256").update(session.authorUserId).digest("hex").slice(0, 10)}`;
}

/**
 * Build session diff events. `now` decides session completion exactly like
 * the donor (`Date.now() - endTime > 5 min`); pass it for deterministic tests.
 */
export function buildSessionDiffEvents(changelog: DocChangelog, now: Date = new Date()): SessionBuildResult {
  const realNow = Date.now;
  // The donor aggregator reads Date.now() directly; pin it for this call.
  Date.now = () => now.getTime();
  let aggregation: ReturnType<typeof aggregateSessions>;
  try {
    const snapshotOps = changelog.operations.filter((op) => op.changelogIndex === 0);
    const changelogOps = changelog.operations.filter((op) => op.changelogIndex > 0);
    aggregation = aggregateSessions(changelog, changelogOps, [], snapshotOps, 0);
  } finally {
    Date.now = realNow;
  }

  // Index sessions by (user, time window) so true-order replay can attribute ops.
  const completed = aggregation.completedSessions;
  const byUser = new Map<string, AggregatedSession[]>();
  for (const session of completed) {
    const list = byUser.get(session.authorUserId) ?? [];
    list.push(session);
    byUser.set(session.authorUserId, list);
  }
  const sessionOf = (op: ChangelogOperation): AggregatedSession | null => {
    if (op.changelogIndex === 0) return null;
    for (const s of byUser.get(op.userId) ?? []) {
      const t = op.timestamp.getTime();
      if (t >= s.startTime.getTime() && t <= s.endTime.getTime()) return s;
    }
    return null;
  };

  type Acc = { before: Map<string, string>; after: Map<string, string>; ops: ReplayedOp[]; tabs: Set<string>; otSessions: Set<string> };
  const acc = new Map<AggregatedSession, Acc>();
  const replay = new TrueOrderReplay();
  const states = new Map<string, string>();

  for (const op of changelog.operations) {
    const session = sessionOf(op);
    const tabKey = op.tabId ?? DEFAULT_TAB;
    let a: Acc | undefined;
    if (session) {
      a = acc.get(session);
      if (!a) {
        a = { before: new Map(), after: new Map(), ops: [], tabs: new Set(), otSessions: new Set() };
        acc.set(session, a);
      }
      if (!a.before.has(tabKey)) a.before.set(tabKey, replay.text(tabKey));
    }
    const effect = replay.apply(op);
    if (session && a) {
      a.ops.push(replayedOp(op, effect));
      a.tabs.add(tabKey);
      if (op.sessionId) a.otSessions.add(op.sessionId);
      a.after.set(tabKey, replay.text(tabKey));
    }
  }

  const tabName = (tabId: string) =>
    changelog.tabs.find((t) => t.tabId === tabId)?.name || (tabId === DEFAULT_TAB ? "Main" : tabId);

  const sessions: SessionDiffEvent[] = [];
  for (const session of completed) {
    const a = acc.get(session);
    if (!a) continue;
    const tabs: SessionTabDiff[] = [];
    for (const tabId of a.tabs) {
      const before = a.before.get(tabId) ?? "";
      const after = a.after.get(tabId) ?? before;
      const beforeSha = textSha(before);
      const afterSha = textSha(after);
      states.set(beforeSha, before);
      states.set(afterSha, after);
      const diff = beforeSha === afterSha ? { unifiedDiff: "", addedLines: 0, deletedLines: 0 } : compactLineDiff(before, after);
      tabs.push({
        tabId,
        tabName: tabName(tabId),
        before: { sha256: beforeSha, length: before.length },
        after: { sha256: afterSha, length: after.length },
        ...diff,
      });
    }
    const interleaved = changelog.operations
      .filter((op) => op.changelogIndex >= session.startEntry && op.changelogIndex <= session.endEntry && op.userId !== session.authorUserId)
      .map((op) => op.changelogIndex);
    const user = changelog.userMap.get(session.authorUserId);
    sessions.push({
      schema: "procmem.gdocs.session/v1",
      sessionKey: sessionKey(session),
      docId: changelog.fileId,
      actor: { userId: session.authorUserId, name: user?.name ?? null, anonymous: user?.anonymous ?? null },
      startTime: session.startTime.toISOString(),
      endTime: session.endTime.toISOString(),
      startEntry: session.startEntry,
      endEntry: session.endEntry,
      operationCount: session.operationCount,
      interleavedEntries: [...new Set(interleaved)],
      otSessionIds: [...a.otSessions],
      tabs,
      ops: a.ops,
      donorAggregate: {
        authorUserId: session.authorUserId,
        authorName: session.authorName,
        startTime: session.startTime.toISOString(),
        endTime: session.endTime.toISOString(),
        durationMinutes: session.durationMinutes,
        activeTimeMinutes: session.activeTimeMinutes,
        typingSpeedCpm: session.typingSpeedCpm,
        tabActivity: session.tabActivity.map((ta) => ({
          tabId: ta.tabId,
          tabName: ta.tabName,
          charsInserted: ta.charsInserted,
          charsDeleted: ta.charsDeleted,
          timeline: ta.timeline.map((e) => ({ timestamp: e.timestamp.toISOString(), description: e.description })),
        })),
        suggestions: session.suggestions,
        operationCount: session.operationCount,
        startEntry: session.startEntry,
        endEntry: session.endEntry,
      },
      grouping: "per-user 5-minute gap (gigabrain 5448774)",
      replay: "true changelog order; text ops only (element ops recorded, not modelled)",
    });
  }

  const pendingEnd = aggregation.pendingOps.reduce<number | null>((max, op) => {
    const t = op.timestamp.getTime();
    return max == null || t > max ? t : max;
  }, null);
  return {
    sessions,
    states,
    pendingOps: aggregation.pendingOps.length,
    pendingCompleteAt: pendingEnd == null ? null : new Date(pendingEnd + SESSION_GAP_MS + 1).toISOString(),
  };
}
