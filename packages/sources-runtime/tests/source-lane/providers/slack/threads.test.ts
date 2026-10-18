import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { Clock, connectSlack, db, query, ready, resetAll, ts } from "./harness.js";
import { FakeSlack } from "./fake-slack.js";
import { discoverSlackConversations, syncSlackHistory, syncSlackThreads } from "../../../../src/integrations/slack/history-sync.js";
import { handleEvent } from "../../../../src/integrations/slack/realtime.js";
import { resetSlackRateBucketsForTests } from "../../../../src/integrations/slack/rate-limit.js";
import { slackCoverage } from "../../../../src/source-lane/providers/slack/coverage.js";

const T = "tenant-slack-thr";
const TEAM = "T0THR";
const TOKEN = "xoxp-synthetic-thr";
const START = Date.parse("2027-01-20T12:00:00.000Z");
let fake: FakeSlack;
let clock: Clock;

function deps(extra: Record<string, unknown> = {}) {
  return { now: clock.now, sleep: clock.sleep, enqueueContinuation: false, budgetMs: 60 * 60_000, ...extra };
}

async function replies(threadTs: string): Promise<string[]> {
  const rows = await query<{ ts: string }>(
    `SELECT raw_payload->>'ts' AS ts FROM activity_events WHERE user_id = $1 AND event_type = 'message'
       AND COALESCE(raw_payload->>'_thread_ts', raw_payload->>'thread_ts') = $2 AND raw_payload->>'ts' <> $2
       AND COALESCE(raw_payload->>'_ledger','') <> 'true' ORDER BY (raw_payload->>'ts')::numeric`,
    [T, threadTs],
  );
  return rows.map((r) => r.ts);
}

async function watermark(threadTs: string) {
  const [row] = await query<{ last_reply_ts: string | null; last_polled_at: Date | null; is_active: boolean }>(
    `SELECT last_reply_ts, last_polled_at, is_active FROM thread_watermarks WHERE user_id = $1 AND thread_ts = $2`,
    [T, threadTs],
  );
  return row;
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  resetSlackRateBucketsForTests();
  fake = new FakeSlack();
  fake.token(TOKEN, TEAM);
  clock = new Clock(START);
  vi.stubGlobal("fetch", fake.fetch);
  await connectSlack(T, TOKEN, TEAM);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack thread replies (source lane)", () => {
  it("registers threads seen in history and fetches every reply page with a per-page checkpoint", async () => {
    const parent = ts(START - 3_600_000);
    fake.post("C1", { ts: parent, user: "U1", text: "parent" });
    const sent: string[] = [];
    for (let i = 0; i < 20; i++) sent.push(fake.reply("C1", parent, { ts: ts(START - 3_000_000 + i * 1000), user: "U2", text: `r${i}` }).ts);
    await discoverSlackConversations(T, deps());
    await syncSlackHistory(T, deps());
    expect(await watermark(parent)).toMatchObject({ last_reply_ts: null, is_active: true });

    // One replies request fits: the first page is stored and checkpointed, the thread stays pending.
    const first = await syncSlackThreads(T, deps({ budgetMs: 30_000 }));
    expect(first).toMatchObject({ deferred: true, repliesStored: 15 });
    expect((await watermark(parent))!.last_reply_ts).toBe(sent[14]);
    expect((await watermark(parent))!.last_polled_at).toBeNull();
    const pendingCov = await slackCoverage({ tenantId: T, executor: db as never }, clock.t);
    expect(pendingCov.find((c) => c.scope === `threads:${TEAM}`)?.state).toBe("partial");

    // Resume: strictly after the checkpoint (no cursor), all 20 replies, no duplicates.
    clock.advance(60_000);
    const second = await syncSlackThreads(T, deps());
    expect(second.repliesStored).toBe(5);
    const last = fake.calls("conversations.replies").at(-1)!;
    expect(last.url.searchParams.get("oldest")).toBe(sent[14]);
    expect(last.url.searchParams.has("cursor")).toBe(false);
    expect(await replies(parent)).toEqual(sent);
    for (const r of fake.calls("conversations.replies")) expect(r.url.searchParams.get("limit")).toBe("15");
    expect((await watermark(parent))!.last_polled_at).not.toBeNull();
    const doneCov = await slackCoverage({ tenantId: T, executor: db as never }, clock.t);
    expect(doneCov.find((c) => c.scope === `threads:${TEAM}`)?.state).toBe("complete");
  });

  it("backfills a thread first seen through a realtime reply (parent never registered)", async () => {
    const parent = ts(START - 7_200_000);
    fake.post("C1", { ts: parent, user: "U1", text: "old parent" });
    const early = fake.reply("C1", parent, { ts: ts(START - 7_000_000), user: "U2", text: "missed while offline" });
    const live = fake.reply("C1", parent, { ts: ts(START - 1_000), user: "U3", text: "live reply" });
    await handleEvent({ event: { type: "message", channel: "C1", user: "U3", ts: live.ts, thread_ts: parent, text: "live reply" } }, T, TOKEN, TEAM);
    expect(await watermark(parent)).toMatchObject({ last_reply_ts: null, is_active: true });
    await syncSlackThreads(T, deps());
    expect(await replies(parent)).toEqual([early.ts, live.ts]);
  });

  it("registers missing threads from stored reply rows and deactivates threads Slack no longer has", async () => {
    const parent = ts(START - 7_200_000);
    await query(
      `INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id, processing_status)
       VALUES ($1, 'slack', 'message', now(), $2::jsonb, $3, 'collected')`,
      [T, JSON.stringify({ ts: ts(START - 7_100_000), thread_ts: parent, text: "orphan reply", _channel: "C9", _team_id: TEAM }), `slack:C9:${ts(START - 7_100_000)}`],
    );
    const result = await syncSlackThreads(T, deps());
    expect(result.threadsRegistered).toBe(1);
    // Slack answers thread_not_found: the thread is deactivated, not retried forever.
    expect(await watermark(parent)).toMatchObject({ is_active: false });
  });
});
