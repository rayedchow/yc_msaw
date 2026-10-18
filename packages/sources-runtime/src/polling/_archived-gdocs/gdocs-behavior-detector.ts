/**
 * Detects implicit user behaviors from OT changelog patterns.
 *
 * These are things users DO in Google Docs that don't have explicit API events
 * but ARE detectable from operation patterns: paste vs type, undo chains,
 * real-time collaboration, document structuring, find & replace, etc.
 */

import type { ChangelogOperation, DocChangelog } from "./gdocs-revisions-load.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectedBehavior {
  type:
    | "paste"
    | "undo"
    | "find_replace"
    | "collaboration"
    | "structuring"
    | "bulk_format"
    | "link_insertion"
    | "session_break"
    | "typing_burst";
  startIndex: number;
  endIndex: number;
  timestamp: Date;
  userId: string;
  tabId?: string;
  detail: Record<string, unknown>;
}

export interface SessionAnalysis {
  userId: string;
  sessionStart: Date;
  sessionEnd: Date;
  activeTimeMs: number;
  totalTimeMs: number;
  typingBursts: number;
  thinkingPauses: number;
  breaks: number;
  charsInserted: number;
  charsDeleted: number;
  avgTypingSpeedCpm: number;
}

export interface CollaborationAnalysis {
  concurrent: boolean;
  users: Array<{ userId: string; operationCount: number; firstOp: Date; lastOp: Date }>;
  interleaveRatio: number;
  overlapMs: number;
}

export interface BehaviorSummary {
  pasteCount: number;
  pasteCharCount: number;
  undoCount: number;
  findReplaceCount: number;
  structuringBursts: number;
  bulkFormatCount: number;
  linksInserted: number;
  sessions: SessionAnalysis[];
  collaboration: CollaborationAnalysis | null;
  behaviors: DetectedBehavior[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PASTE_CHAR_THRESHOLD = 30;
const UNDO_TIME_WINDOW_MS = 5000;
const SESSION_BREAK_MS = 5 * 60 * 1000;
const THINKING_PAUSE_MS = 5000;
const TYPING_BURST_MAX_GAP_MS = 2000;
const STRUCTURING_WINDOW_MS = 5 * 60 * 1000;
const STRUCTURING_MIN_HEADING_CHANGES = 3;

// ---------------------------------------------------------------------------
// Main detector
// ---------------------------------------------------------------------------

export function detectBehaviors(changelog: DocChangelog): BehaviorSummary {
  const ops = changelog.operations;
  const behaviors: DetectedBehavior[] = [];

  // Run all detectors
  const pastes = detectPastes(ops);
  const undos = detectUndos(ops);
  const findReplaces = detectFindReplace(ops);
  const structuring = detectStructuring(ops);
  const bulkFormats = detectBulkFormatting(ops);
  const links = detectLinkInsertions(ops);

  behaviors.push(...pastes, ...undos, ...findReplaces, ...structuring, ...bulkFormats, ...links);

  const sessions = analyzeSessionPatterns(ops);
  const collaboration = analyzeCollaboration(ops);

  return {
    pasteCount: pastes.length,
    pasteCharCount: pastes.reduce((sum, p) => sum + ((p.detail.charCount as number) ?? 0), 0),
    undoCount: undos.length,
    findReplaceCount: findReplaces.length,
    structuringBursts: structuring.length,
    bulkFormatCount: bulkFormats.length,
    linksInserted: links.length,
    sessions,
    collaboration,
    behaviors,
  };
}

// ---------------------------------------------------------------------------
// Paste detection
// ---------------------------------------------------------------------------

function detectPastes(ops: ChangelogOperation[]): DetectedBehavior[] {
  const results: DetectedBehavior[] = [];

  for (const op of ops) {
    if (op.type !== "insert" && op.type !== "insert_suggestion") continue;
    if (!op.text || op.text.length < PASTE_CHAR_THRESHOLD) continue;

    const hasNewlines = op.text.includes("\n");
    const charCount = op.text.length;

    results.push({
      type: "paste",
      startIndex: op.changelogIndex,
      endIndex: op.changelogIndex,
      timestamp: op.timestamp,
      userId: op.userId,
      tabId: op.tabId,
      detail: {
        charCount,
        hasNewlines,
        preview: op.text.slice(0, 100),
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Undo detection
// ---------------------------------------------------------------------------

function detectUndos(ops: ChangelogOperation[]): DetectedBehavior[] {
  const results: DetectedBehavior[] = [];
  const recentInserts: Array<{ pos: number; len: number; ts: number; userId: string; idx: number }> = [];

  for (const op of ops) {
    if (op.type === "insert" && op.text && op.startIndex) {
      recentInserts.push({
        pos: op.startIndex,
        len: op.text.length,
        ts: op.timestamp.getTime(),
        userId: op.userId,
        idx: op.changelogIndex,
      });
      if (recentInserts.length > 50) recentInserts.shift();
    }

    if (op.type === "delete" && op.startIndex && op.endIndex) {
      const deleteLen = op.endIndex - op.startIndex + 1;
      const deleteTs = op.timestamp.getTime();

      for (const recent of recentInserts) {
        if (
          recent.userId === op.userId &&
          recent.pos === op.startIndex &&
          recent.len === deleteLen &&
          deleteTs - recent.ts < UNDO_TIME_WINDOW_MS &&
          deleteTs - recent.ts > 50
        ) {
          results.push({
            type: "undo",
            startIndex: op.changelogIndex,
            endIndex: op.changelogIndex,
            timestamp: op.timestamp,
            userId: op.userId,
            tabId: op.tabId,
            detail: {
              undoneChangelogIndex: recent.idx,
              delayMs: deleteTs - recent.ts,
              charCount: deleteLen,
            },
          });
          break;
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Find & Replace detection
// ---------------------------------------------------------------------------

function detectFindReplace(ops: ChangelogOperation[]): DetectedBehavior[] {
  const results: DetectedBehavior[] = [];

  // Group operations by exact timestamp
  const byTimestamp = new Map<number, ChangelogOperation[]>();
  for (const op of ops) {
    const ts = op.timestamp.getTime();
    if (!byTimestamp.has(ts)) byTimestamp.set(ts, []);
    byTimestamp.get(ts)!.push(op);
  }

  for (const [ts, group] of byTimestamp) {
    if (group.length < 3) continue;

    // Find insert operations with identical text
    const insertTexts = new Map<string, ChangelogOperation[]>();
    for (const op of group) {
      if (op.type === "insert" && op.text) {
        if (!insertTexts.has(op.text)) insertTexts.set(op.text, []);
        insertTexts.get(op.text)!.push(op);
      }
    }

    for (const [text, insertOps] of insertTexts) {
      if (insertOps.length >= 3) {
        results.push({
          type: "find_replace",
          startIndex: insertOps[0].changelogIndex,
          endIndex: insertOps[insertOps.length - 1].changelogIndex,
          timestamp: new Date(ts),
          userId: insertOps[0].userId,
          detail: {
            replacementText: text,
            replacementCount: insertOps.length,
            positions: insertOps.map((o) => o.startIndex),
          },
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Document structuring detection
// ---------------------------------------------------------------------------

function detectStructuring(ops: ChangelogOperation[]): DetectedBehavior[] {
  const results: DetectedBehavior[] = [];

  // Find bursts of heading changes (ps_hd) with minimal text insertion
  const headingChanges: Array<{ op: ChangelogOperation; headingLevel: number }> = [];

  for (const op of ops) {
    if (op.type !== "format" || !op.styleModification) continue;
    const sm = op.styleModification as Record<string, unknown>;
    if (typeof sm.ps_hd === "number") {
      headingChanges.push({ op, headingLevel: sm.ps_hd as number });
    }
  }

  // Sliding window: find bursts of 3+ heading changes within 5 minutes
  for (let i = 0; i < headingChanges.length; i++) {
    const windowStart = headingChanges[i].op.timestamp.getTime();
    let windowEnd = i;

    while (
      windowEnd < headingChanges.length - 1 &&
      headingChanges[windowEnd + 1].op.timestamp.getTime() - windowStart < STRUCTURING_WINDOW_MS
    ) {
      windowEnd++;
    }

    const burstSize = windowEnd - i + 1;
    if (burstSize >= STRUCTURING_MIN_HEADING_CHANGES) {
      const levels = headingChanges.slice(i, windowEnd + 1).map((h) => h.headingLevel);
      results.push({
        type: "structuring",
        startIndex: headingChanges[i].op.changelogIndex,
        endIndex: headingChanges[windowEnd].op.changelogIndex,
        timestamp: headingChanges[i].op.timestamp,
        userId: headingChanges[i].op.userId,
        detail: {
          headingChanges: burstSize,
          headingLevels: levels,
          durationMs: headingChanges[windowEnd].op.timestamp.getTime() - windowStart,
        },
      });
      i = windowEnd; // skip past this burst
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Bulk formatting detection
// ---------------------------------------------------------------------------

function detectBulkFormatting(ops: ChangelogOperation[]): DetectedBehavior[] {
  const results: DetectedBehavior[] = [];

  for (const op of ops) {
    if (op.type !== "format") continue;
    if (!op.startIndex || !op.endIndex) continue;

    const range = op.endIndex - op.startIndex;
    if (range >= 500) {
      results.push({
        type: "bulk_format",
        startIndex: op.changelogIndex,
        endIndex: op.changelogIndex,
        timestamp: op.timestamp,
        userId: op.userId,
        tabId: op.tabId,
        detail: {
          range,
          styleType: op.styleType,
        },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Link insertion detection
// ---------------------------------------------------------------------------

function detectLinkInsertions(ops: ChangelogOperation[]): DetectedBehavior[] {
  const results: DetectedBehavior[] = [];

  for (const op of ops) {
    if (op.type !== "format" || !op.styleModification) continue;
    const sm = op.styleModification as Record<string, unknown>;
    const link = sm.lnks_link as Record<string, unknown> | undefined;
    if (!link) continue;

    const url = link.ulnk_url as string | undefined;
    results.push({
      type: "link_insertion",
      startIndex: op.changelogIndex,
      endIndex: op.changelogIndex,
      timestamp: op.timestamp,
      userId: op.userId,
      tabId: op.tabId,
      detail: {
        url: url ?? "unknown",
        linkType: link.lnk_type,
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Session pattern analysis
// ---------------------------------------------------------------------------

export function analyzeSessionPatterns(ops: ChangelogOperation[]): SessionAnalysis[] {
  // Group by userId
  const byUser = new Map<string, ChangelogOperation[]>();
  for (const op of ops) {
    if (!op.userId) continue;
    if (!byUser.has(op.userId)) byUser.set(op.userId, []);
    byUser.get(op.userId)!.push(op);
  }

  const sessions: SessionAnalysis[] = [];

  for (const [userId, userOps] of byUser) {
    if (userOps.length < 2) continue;

    const sorted = [...userOps].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    let sessionStart = sorted[0].timestamp;
    let lastOp = sorted[0].timestamp;
    let activeTimeMs = 0;
    let typingBursts = 0;
    let thinkingPauses = 0;
    let breaks = 0;
    let charsInserted = 0;
    let charsDeleted = 0;
    let burstChars = 0;
    let burstStartMs = sorted[0].timestamp.getTime();
    let inBurst = false;

    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].timestamp.getTime() - sorted[i - 1].timestamp.getTime();
      const op = sorted[i];

      if (op.type === "insert" || op.type === "insert_suggestion") {
        charsInserted += op.text?.length ?? 0;
      } else if (op.type === "delete" || op.type === "delete_suggestion") {
        charsDeleted += (op.endIndex ?? 0) - (op.startIndex ?? 0) + 1;
      }

      if (gap >= SESSION_BREAK_MS) {
        // End current session, start new one
        if (inBurst) typingBursts++;
        const totalMs = lastOp.getTime() - sessionStart.getTime();
        sessions.push({
          userId,
          sessionStart,
          sessionEnd: lastOp,
          activeTimeMs,
          totalTimeMs: totalMs,
          typingBursts,
          thinkingPauses,
          breaks,
          charsInserted,
          charsDeleted,
          avgTypingSpeedCpm: activeTimeMs > 0 ? Math.round((charsInserted / (activeTimeMs / 60000))) : 0,
        });

        // Reset for new session
        sessionStart = op.timestamp;
        activeTimeMs = 0;
        typingBursts = 0;
        thinkingPauses = 0;
        charsInserted = 0;
        charsDeleted = 0;
        inBurst = false;
        breaks++;
      } else if (gap >= THINKING_PAUSE_MS) {
        thinkingPauses++;
        if (inBurst) { typingBursts++; inBurst = false; }
      } else if (gap < TYPING_BURST_MAX_GAP_MS) {
        activeTimeMs += gap;
        if (!inBurst) { inBurst = true; burstStartMs = sorted[i - 1].timestamp.getTime(); }
      }

      lastOp = op.timestamp;
    }

    // Final session
    if (inBurst) typingBursts++;
    const totalMs = lastOp.getTime() - sessionStart.getTime();
    if (totalMs > 0) {
      sessions.push({
        userId,
        sessionStart,
        sessionEnd: lastOp,
        activeTimeMs,
        totalTimeMs: totalMs,
        typingBursts,
        thinkingPauses,
        breaks,
        charsInserted,
        charsDeleted,
        avgTypingSpeedCpm: activeTimeMs > 0 ? Math.round((charsInserted / (activeTimeMs / 60000))) : 0,
      });
    }
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Collaboration analysis
// ---------------------------------------------------------------------------

export function analyzeCollaboration(ops: ChangelogOperation[]): CollaborationAnalysis | null {
  const byUser = new Map<string, { ops: ChangelogOperation[]; firstOp: Date; lastOp: Date }>();

  for (const op of ops) {
    if (!op.userId) continue;
    if (!byUser.has(op.userId)) {
      byUser.set(op.userId, { ops: [], firstOp: op.timestamp, lastOp: op.timestamp });
    }
    const user = byUser.get(op.userId)!;
    user.ops.push(op);
    if (op.timestamp < user.firstOp) user.firstOp = op.timestamp;
    if (op.timestamp > user.lastOp) user.lastOp = op.timestamp;
  }

  if (byUser.size < 2) return null;

  // Calculate interleave ratio
  const allOps = [...ops].filter((o) => o.userId).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let alternations = 0;
  for (let i = 1; i < allOps.length; i++) {
    if (allOps[i].userId !== allOps[i - 1].userId) alternations++;
  }
  const interleaveRatio = allOps.length > 1 ? alternations / (allOps.length - 1) : 0;

  // Calculate temporal overlap
  const users = [...byUser.entries()].map(([userId, data]) => ({
    userId,
    operationCount: data.ops.length,
    firstOp: data.firstOp,
    lastOp: data.lastOp,
  }));

  let overlapMs = 0;
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const overlapStart = Math.max(users[i].firstOp.getTime(), users[j].firstOp.getTime());
      const overlapEnd = Math.min(users[i].lastOp.getTime(), users[j].lastOp.getTime());
      if (overlapEnd > overlapStart) overlapMs += overlapEnd - overlapStart;
    }
  }

  return {
    concurrent: interleaveRatio > 0.1 && overlapMs > 60000,
    users,
    interleaveRatio,
    overlapMs,
  };
}
