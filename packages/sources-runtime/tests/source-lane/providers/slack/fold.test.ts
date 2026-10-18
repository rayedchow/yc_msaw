import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { connectSlack, db, query, ready, resetAll } from "./harness.js";
import { sql } from "drizzle-orm";
import { foldSlackChannelDayRows, foldSlackMessage, foldSlackWindowRows, slackLedgerColumn, slackWindowFoldColumns, type SlackLedgerObservation, type SlackWindowRow } from "../../../../src/mirror/slack-fold.js";
import { handleEvent } from "../../../../src/integrations/slack/realtime.js";
import { mirrorSlackChannelWindows } from "../../../../src/mirror/backfill.js";

const T = "tenant-slack-fold";
const TEAM = "T0FOLD";
const CH = "C1";
const TS = "1800000000.000100";

function obs(event_type: string, at: string, raw_payload: Record<string, unknown>, id = `${event_type}:${at}`): SlackLedgerObservation {
  return { event_type, source_event_id: id, timestamp: at, raw_payload };
}

const base = { ts: TS, user: "U1", text: "hello", _channel: CH, _channel_name: "general", _user_name: "Ada", reactions: [{ name: "eyes", users: ["U2"], count: 1 }] };

describe("foldSlackMessage", () => {
  it("applies edits in order and keeps the edit history; the input is not mutated", () => {
    const snapshot = structuredClone(base);
    const folded = foldSlackMessage(base, [
      obs("message.edited", "2027-01-15T08:01:00Z", { message: { ts: TS, user: "U1", text: "hello v2", edited: { user: "U1", ts: "1800000060.000000" } } }),
      obs("message.edited", "2027-01-15T08:02:00Z", { message: { ts: TS, user: "U1", text: "hello v3", edited: { user: "U1", ts: "1800000120.000000" } } }),
    ]);
    expect(folded.payload.text).toBe("hello v3");
    expect(folded.payload._edit_history).toEqual([
      { text: "hello", edited_at: "1800000060.000000" },
      { text: "hello v2", edited_at: "1800000120.000000" },
    ]);
    expect(folded.payload._channel).toBe(CH); // base stamps survive
    expect(base).toEqual(snapshot);
  });

  it("an explicit delete is terminal; an absence can be undone by a later observation", () => {
    const deleted = foldSlackMessage(base, [
      obs("message.deleted", "2027-01-15T09:00:00Z", { deleted_ts: TS, event_ts: "1800003600.000000" }),
      obs("message.revision_observed", "2027-01-15T10:00:00Z", { message: { ts: TS, text: "stale page" } }),
    ]);
    expect(deleted.payload).toMatchObject({ _deleted: true, _deleted_reason: "message_deleted", text: "hello" });

    const back = foldSlackMessage(base, [
      obs("message.absent_observed", "2027-01-15T09:00:00Z", {}),
      obs("message.revision_observed", "2027-01-15T10:00:00Z", { message: { ts: TS, text: "hello" } }),
    ]);
    expect(back.payload._deleted).toBeUndefined();
  });

  it("reactions are idempotent per user (re-delivered events do not double count)", () => {
    const folded = foldSlackMessage(base, [
      obs("message.reaction_added", "2027-01-15T08:00:00Z", { reaction: "tada", user: "U3" }, "a1"),
      obs("message.reaction_added", "2027-01-15T08:00:01Z", { reaction: "tada", user: "U3" }, "a2"),
      obs("message.reaction_added", "2027-01-15T08:00:02Z", { reaction: "eyes", user: "U2" }, "a3"),
      obs("message.reaction_removed", "2027-01-15T08:00:03Z", { reaction: "eyes", user: "U2" }, "r1"),
    ]);
    expect(folded.payload.reactions).toEqual([{ name: "tada", users: ["U3"], count: 1 }]);
  });

  it("a thread parent replaced by a tombstone renders as deleted", () => {
    const folded = foldSlackMessage(base, [
      obs("message.edited", "2027-01-15T08:00:00Z", { message: { ts: TS, subtype: "tombstone", text: "This message was deleted." } }),
    ]);
    expect(folded.payload).toMatchObject({ _deleted: true, _deleted_reason: "tombstone" });
  });
});

describe("Slack renderer folding over real rows (realtime ledger)", () => {
  beforeAll(async () => {
    await ready;
  });

  beforeEach(async () => {
    await resetAll();
    await connectSlack(T, "xoxp-fold", TEAM);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, members: [], response_metadata: { next_cursor: "" } })));
    await query(
      `INSERT INTO conversation_watermarks (user_id, provider, conversation_id, conversation_type, conversation_name, is_active) VALUES ($1, 'slack', $2, 'public_channel', 'general', true)`,
      [T, CH],
    );
    for (const [ts, text] of [[TS, "first"], ["1800000001.000100", "second"], ["1800000002.000100", "third"]] as const) {
      await handleEvent({ event: { type: "message", channel: CH, user: "U1", ts, text } }, T, "xoxp-fold", TEAM);
    }
    await handleEvent({ event: { type: "message", subtype: "message_changed", channel: CH, event_ts: "1800000100.000000", message: { ts: TS, user: "U1", text: "first (edited)", edited: { user: "U1", ts: "1800000100.000000" } }, previous_message: { ts: TS, user: "U1", text: "first" } } }, T, "xoxp-fold", TEAM);
    await handleEvent({ event: { type: "message", subtype: "message_deleted", channel: CH, deleted_ts: "1800000001.000100", event_ts: "1800000200.000000", previous_message: { ts: "1800000001.000100", user: "U1", text: "second" } } }, T, "xoxp-fold", TEAM);
    await handleEvent({ event: { type: "reaction_added", user: "U2", reaction: "tada", item: { type: "message", channel: CH, ts: "1800000002.000100" }, event_ts: "1800000300.000000" } }, T, "xoxp-fold", TEAM);
  });

  it("the base rows stay as first captured; the folded rows carry current state", async () => {
    const executor = db as unknown as { execute(q: unknown): Promise<{ rows: unknown[] }> };
    const dayRows = (await executor.execute(sql`
      SELECT source_event_id, source_updated_at, raw_payload, ${slackLedgerColumn()}
      FROM activity_events
      WHERE user_id = ${T} AND source = 'slack' AND raw_payload->>'_channel' = ${CH}
        AND COALESCE(raw_payload->>'_ledger', '') <> 'true'
      ORDER BY timestamp ASC, source_event_id ASC
    `)).rows as Array<{ source_event_id: string; source_updated_at: Date | null; raw_payload: Record<string, unknown>; fold_ledger: unknown }>;
    expect(dayRows.map((r) => r.raw_payload.text)).toEqual(["first", "second", "third"]); // raw unchanged
    const folded = foldSlackChannelDayRows(dayRows);
    expect(folded.map((r) => r.raw_payload.text)).toEqual(["first (edited)", "second", "third"]);
    expect(folded[1]!.raw_payload).toMatchObject({ _deleted: true, _deleted_reason: "message_deleted" });
    expect(folded[2]!.raw_payload.reactions).toEqual([{ name: "tada", users: ["U2"], count: 1 }]);
    expect(new Date(folded[0]!.source_updated_at!).toISOString()).toBe(new Date(1800000100 * 1000).toISOString());
    expect(folded.every((r) => !("fold_ledger" in r))).toBe(true);

    const windowRows = (await executor.execute(sql`
      SELECT raw_payload->>'ts' AS ts, source_event_id, raw_payload->>'text' AS text, raw_payload->>'_deleted' = 'true' AS deleted,
             raw_payload->>'_user_name' AS sender_name, raw_payload->>'user' AS sender_handle,
             COALESCE(raw_payload->>'_thread_ts', raw_payload->>'thread_ts') AS thread_ts, raw_payload->>'_channel_name' AS channel_name,
             raw_payload->'reactions' AS reactions, raw_payload->'_mentions' AS mentions, ${slackWindowFoldColumns()}
      FROM activity_events
      WHERE user_id = ${T} AND source = 'slack' AND raw_payload->>'_channel' = ${CH} AND event_type = 'message'
        AND COALESCE(raw_payload->>'_ledger', '') <> 'true'
      ORDER BY "timestamp" ASC, source_event_id ASC
    `)).rows as SlackWindowRow[];
    expect(foldSlackWindowRows(windowRows).map((r) => [r.text, r.deleted])).toEqual([["first (edited)", false], ["second", true], ["third", false]]);
    // Rows selected without the fold columns (donor fixtures) pass through unchanged.
    const plain: SlackWindowRow = { ts: TS, source_event_id: "x", text: "t", deleted: false, sender_name: null, sender_handle: null, thread_ts: null, channel_name: null, reactions: null, mentions: null };
    expect(foldSlackWindowRows([plain])).toEqual([plain]);
  });

  const materializerSource = readFileSync(fileURLToPath(new URL("../../../../src/mirror/materializer.ts", import.meta.url)), "utf8");
  const backfillSource = readFileSync(fileURLToPath(new URL("../../../../src/mirror/backfill.ts", import.meta.url)), "utf8");
  const patched = materializerSource.includes("foldSlackChannelDayRows") && backfillSource.includes("foldSlackWindowRows");

  // Activates once AUDIT/implementation/patch-requests/slack.md (materializer.ts + backfill.ts hunks) is applied.
  it.skipIf(!patched)("channel-day and window projections show edits, deletions and reactions (shared patch applied)", async () => {
    const [day] = await query<{ content: string }>(`SELECT content FROM mirror_files WHERE user_id = $1 AND path = $2`, [T, `sources/slack/${CH}/2027-01-15.md`]);
    expect(day!.content).toContain("first (edited)");
    expect(day!.content).toMatch(/\[deleted\]/);
    expect(day!.content).not.toMatch(/: second/);
    expect(day!.content).toContain(":tada:");
    // Thread windows always render (short sessions are skipped as crumbs by the donor renderer).
    const parent = "1800000010.000100";
    await handleEvent({ event: { type: "message", channel: CH, user: "U1", ts: parent, text: "thread parent" } }, T, "xoxp-fold", TEAM);
    await handleEvent({ event: { type: "message", channel: CH, user: "U2", ts: "1800000011.000100", thread_ts: parent, text: "reply v1" } }, T, "xoxp-fold", TEAM);
    await handleEvent({ event: { type: "message", channel: CH, user: "U3", ts: "1800000012.000100", thread_ts: parent, text: "reply to delete" } }, T, "xoxp-fold", TEAM);
    await handleEvent({ event: { type: "message", subtype: "message_changed", channel: CH, event_ts: "1800000400.000000", message: { ts: "1800000011.000100", thread_ts: parent, user: "U2", text: "reply v2", edited: { user: "U2", ts: "1800000400.000000" } } } }, T, "xoxp-fold", TEAM);
    await handleEvent({ event: { type: "message", subtype: "message_deleted", channel: CH, deleted_ts: "1800000012.000100", event_ts: "1800000500.000000" } }, T, "xoxp-fold", TEAM);
    const windows = await mirrorSlackChannelWindows(T, CH, "general");
    const thread = windows.files.find((f) => f.path.includes("/threads/"))!;
    expect(thread.content).toContain("reply v2");
    expect(thread.content).not.toContain("reply v1");
    expect(thread.content).toContain("[deleted]");
    expect(thread.content).not.toContain("reply to delete");
  });
});
