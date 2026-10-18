import { describe, expect, it } from "vitest";
import { collectSnapshotOps, parseChangelogEntries } from "../../../../src/polling/_archived-gdocs/gdocs-revisions-load.js";
import { aggregateSessions } from "../../../../src/polling/_archived-gdocs/gdocs-session-aggregator.js";
import { buildSessionDiffEvents, replayChangelog, SESSION_GAP_MS } from "../../../../src/source-lane/providers/google-docs/sessions.js";
import { buildSnapshotDiffEvent, compactLineDiff, type DocSnapshotState } from "../../../../src/source-lane/providers/google-docs/snapshot-diff.js";

/** One raw 9-element /revisions/load tuple. */
function entry(op: unknown, ms: number, userId: string, revision: number, session = "s-raw"): unknown[] {
  return [op, ms, userId, revision, session, revision, null, null, false];
}

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const users = new Map([["u1", { name: "Ada", anonymous: false }], ["u2", { name: "Bob", anonymous: false }]]);

function parse(entries: unknown[][], snapshot: unknown = [[]]) {
  return parseChangelogEntries("doc-s", entries, collectSnapshotOps(snapshot), users);
}

describe("buildSessionDiffEvents (production parser + gigabrain 5-minute grouping)", () => {
  const entries = [
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 1, s: "abc" } }, T0, "u1", 1),
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 4, s: "XYZ" } }, T0 + 60_000, "u2", 2),
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "ds", si: 2, ei: 2 } }, T0 + 120_000, "u1", 3),
    // u1 again after a >= 5 minute gap: a new session
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 1, s: ">" } }, T0 + 120_000 + SESSION_GAP_MS, "u1", 4),
  ];

  it("uses exactly the donor aggregator's sessions and adds true-order before/after", () => {
    const changelog = parse(entries);
    const now = new Date(T0 + 3_600_000);
    const result = buildSessionDiffEvents(changelog, now);

    // Same boundaries as the pinned donor aggregator.
    const realNow = Date.now;
    Date.now = () => now.getTime();
    const donor = aggregateSessions(changelog, changelog.operations.filter((o) => o.changelogIndex > 0), [], [], 0);
    Date.now = realNow;
    expect(result.sessions.map((s) => [s.actor.userId, s.startEntry, s.endEntry]))
      .toEqual(donor.completedSessions.map((s) => [s.authorUserId, s.startEntry, s.endEntry]));
    expect(result.sessions).toHaveLength(3);

    const [first, bob, second] = result.sessions;
    expect(first.actor).toEqual({ userId: "u1", name: "Ada", anonymous: false });
    expect(first.interleavedEntries).toEqual([2]);
    const text = (sha: string) => result.states.get(sha);
    // before: empty; after: "abc" + Bob's "XYZ" (interleaved), then u1 deletes "b"
    expect(text(first.tabs[0].before.sha256)).toBe("");
    expect(text(first.tabs[0].after.sha256)).toBe("acXYZ");
    expect(first.ops.map((o) => [o.changelogIndex, o.type, o.insertedText ?? o.deletedText])).toEqual([[1, "insert", "abc"], [3, "delete", "b"]]);
    expect(text(bob.tabs[0].before.sha256)).toBe("abc");
    expect(text(bob.tabs[0].after.sha256)).toBe("abcXYZ");
    expect(text(second.tabs[0].after.sha256)).toBe(">acXYZ");
    expect(first.tabs[0].unifiedDiff).toBe("-\n+acXYZ");
  });

  it("does not emit a session until it is more than 5 minutes old (pending ops reported)", () => {
    const changelog = parse(entries);
    const lastOp = T0 + 120_000 + SESSION_GAP_MS;
    const early = buildSessionDiffEvents(changelog, new Date(lastOp + 60_000));
    expect(early.sessions).toHaveLength(2);
    expect(early.pendingOps).toBe(1);
    expect(Date.parse(early.pendingCompleteAt!)).toBeGreaterThan(lastOp + SESSION_GAP_MS);
    const later = buildSessionDiffEvents(changelog, new Date(lastOp + SESSION_GAP_MS + 1_000));
    expect(later.sessions).toHaveLength(3);
    // Completed sessions are stable across runs (idempotent keys + content).
    expect(JSON.stringify(later.sessions.slice(0, 2))).toBe(JSON.stringify(early.sessions));
  });

  it("replays snapshot ops and per-tab index spaces from nested multi-tab envelopes", () => {
    const changelog = parse([
      entry({ ty: "mlti", mts: [
        { ty: "nm", nmr: ["t.a"], nmc: { ty: "is", ibi: 1, s: "AAA" } },
        { ty: "nm", nmr: ["t.b"], nmc: { ty: "mlti", mts: [{ ty: "is", ibi: 1, s: "BB" }, { ty: "ds", si: 1, ei: 1 }] } },
      ] }, T0, "u1", 1),
    ], [[{ ty: "nm", nmr: ["t.a"], nmc: { ty: "is", ibi: 1, s: "seed-" } }]]);
    const ops = replayChangelog(changelog);
    expect(ops[0]).toMatchObject({ changelogIndex: 0, tabId: "t.a", insertedText: "seed-" });
    expect(ops.filter((o) => o.tabId === "t.b").map((o) => o.insertedText ?? o.deletedText)).toEqual(["BB", "B"]);
    const result = buildSessionDiffEvents(changelog, new Date(T0 + 3_600_000));
    const tabs = Object.fromEntries(result.sessions[0].tabs.map((t) => [t.tabId, [result.states.get(t.before.sha256), result.states.get(t.after.sha256)]]));
    expect(tabs).toEqual({ "t.a": ["seed-", "AAAseed-"], "t.b": ["", "B"] });
  });
});

describe("buildSnapshotDiffEvent (21feb713 diff-events, uncapped, revision-keyed)", () => {
  const state = (revisionId: string, content: string, tabName = "Main"): DocSnapshotState => ({
    revisionId, capturedAt: "2026-10-01T00:00:00.000Z", sourceUpdatedAt: null, title: "T",
    tabs: [{ tabId: "t.0", tabName, content, contentSha: `sha-${content.length}-${content.slice(0, 8)}` }],
  });

  it("keeps the full diff beyond the donor's 12,000-character cap", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const changed = big.replace("line 2999", "LINE 2999 CHANGED");
    const event = buildSnapshotDiffEvent("d", state("r1", big), state("r2", changed));
    expect(event.tabChanges[0].unifiedDiff).toContain("+LINE 2999 CHANGED");
    expect(compactLineDiff("", big).unifiedDiff.length).toBeGreaterThan(12_000);
  });

  it("A -> B -> A produces distinct events (no content-hash collision on revert)", () => {
    const ab = buildSnapshotDiffEvent("d", state("r1", "A"), state("r2", "B"));
    const ba = buildSnapshotDiffEvent("d", state("r2", "B"), state("r3", "A"));
    expect(ab.sourceEventId).not.toBe(ba.sourceEventId);
    expect(ba.contentHash).toBe(buildSnapshotDiffEvent("d", null, state("r1", "A")).contentHash);
    expect(ba.attribution).toMatchObject({ confidence: "unknown" });
  });
});
