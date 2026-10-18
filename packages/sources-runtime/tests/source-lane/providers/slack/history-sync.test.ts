import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { Clock, connectSlack, conversationState, db, query, ready, resetAll, slackRows, ts } from "./harness.js";
import { FakeSlack } from "./fake-slack.js";
import { discoverSlackConversations, syncSlackHistory } from "../../../../src/integrations/slack/history-sync.js";
import { slackQuotaKey } from "../../../../src/integrations/slack/source-store.js";
import { resetSlackRateBucketsForTests } from "../../../../src/integrations/slack/rate-limit.js";
import { foldSlackMessage, loadSlackLedgerObservations } from "../../../../src/mirror/slack-fold.js";
import { slackCoverage } from "../../../../src/source-lane/providers/slack/coverage.js";

const T = "tenant-slack-a";
const TEAM = "T0ACME";
const TOKEN = "xoxp-synthetic-a";
let fake: FakeSlack;
let clock: Clock;

const START = Date.parse("2027-01-20T12:00:00.000Z");
const HOUR = 3_600_000;

function deps(extra: Record<string, unknown> = {}) {
  return { now: clock.now, sleep: clock.sleep, enqueueContinuation: false, budgetMs: 60 * 60_000, ...extra };
}

/** n messages one minute apart ending an hour before START. */
function seedChannel(channelId: string, n: number, info: Record<string, unknown> = {}): string[] {
  fake.channel(channelId, info);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = ts(START - HOUR - (n - i) * 60_000);
    fake.post(channelId, { ts: t, user: "U1", text: `m${i}` });
    out.push(t);
  }
  return out;
}

async function baseMessageTs(tenant = T, channel = "C1"): Promise<string[]> {
  const rows = await query<{ ts: string }>(
    `SELECT raw_payload->>'ts' AS ts FROM activity_events WHERE user_id = $1 AND source = 'slack' AND event_type = 'message'
       AND raw_payload->>'_channel' = $2 AND COALESCE(raw_payload->>'_ledger','') <> 'true' ORDER BY (raw_payload->>'ts')::numeric`,
    [tenant, channel],
  );
  return rows.map((r) => r.ts);
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
  vi.unstubAllEnvs();
});

describe("Slack history capture (source lane)", () => {
  it("walks the complete history with 15-message pages, under the 1 request/min tier, and records completion", async () => {
    const sent = seedChannel("C1", 40);
    await discoverSlackConversations(T, deps());
    const result = await syncSlackHistory(T, deps());

    const history = fake.calls("conversations.history");
    expect(history).toHaveLength(3); // 15 + 15 + 10
    for (const r of history) expect(r.url.searchParams.get("limit")).toBe("15");
    expect(history[0]!.url.searchParams.has("oldest")).toBe(false); // unbounded walk
    expect(history[1]!.url.searchParams.get("cursor")).toBeTruthy();
    // Durable quota spaced the calls a full minute apart (fake clock: sleeps advance time).
    expect(clock.slept.filter((ms) => ms >= 59_000).length).toBeGreaterThanOrEqual(2);

    expect(await baseMessageTs()).toEqual(sent);
    const state = await conversationState(T, "C1");
    expect(state.history_complete_at).not.toBeNull();
    expect(state.history_bound_ts).toBeNull();
    expect(state.head_ts).toBe(sent[sent.length - 1]);
    expect(state.tail_ts).toBe(sent[0]);
    expect(result).toMatchObject({ stored: 40, exhausted: true, historyComplete: 1, historyIncomplete: 0 });

    // A later run only asks for newer messages and duplicates nothing.
    clock.advance(10 * 60_000);
    const newer = ts(clock.t - 1000);
    fake.post("C1", { ts: newer, user: "U2", text: "fresh" });
    const again = await syncSlackHistory(T, deps({ reconcileIntervalMs: 365 * 24 * HOUR }));
    const forward = fake.calls("conversations.history").slice(3);
    expect(forward).toHaveLength(1);
    expect(forward[0]!.url.searchParams.get("oldest")).toBe(sent[sent.length - 1]);
    expect(again.stored).toBe(1);
    expect((await baseMessageTs()).length).toBe(41);

    const cov = await slackCoverage({ tenantId: T, executor: db as never }, clock.t);
    expect(cov.find((c) => c.scope === `conversation:${TEAM}/C1`)?.state).toBe("complete");
  });

  it("resumes an interrupted walk from the durable checkpoint (no restart, no gap), and restarts below the tail when the cursor expired", async () => {
    const sent = seedChannel("C1", 50);
    await discoverSlackConversations(T, deps());
    // Budget for exactly two history requests at 1/min: the run stops with a checkpoint.
    const first = await syncSlackHistory(T, deps({ budgetMs: 90_000 }));
    expect(first.exhausted).toBe(false);
    expect(first.deferred).toBe(true);
    expect(fake.calls("conversations.history")).toHaveLength(2);
    const mid = await conversationState(T, "C1");
    expect(mid.history_complete_at).toBeNull();
    expect(mid.bwd_cursor).toBeTruthy();
    expect(mid.tail_ts).toBe(sent[50 - 30]);

    // The next run (forward pass first: it carries `oldest`) continues the walk with the stored
    // cursor - same query, never the first page again.
    clock.advance(60_000);
    await syncSlackHistory(T, deps({ maxPagesPerChannel: 2 }));
    const backwardCalls = () => fake.calls("conversations.history").filter((r) => !r.url.searchParams.has("oldest"));
    expect(backwardCalls()[2]!.url.searchParams.get("cursor")).toBe(mid.bwd_cursor);
    const seen = backwardCalls().length;

    // Cursor expires (invalid_cursor): the walk restarts strictly below the stored tail.
    fake.invalidateCursors();
    const tailBefore = (await conversationState(T, "C1")).tail_ts;
    clock.advance(60_000);
    await syncSlackHistory(T, deps());
    const afterExpiry = backwardCalls().slice(seen);
    expect(afterExpiry[0]!.url.searchParams.get("cursor")).toBeTruthy(); // refused: invalid_cursor
    const restart = afterExpiry[1]!;
    expect(restart.url.searchParams.has("cursor")).toBe(false);
    expect(restart.url.searchParams.get("latest")).toBe(tailBefore);
    expect(restart.url.searchParams.get("inclusive")).toBe("false");
    expect(await baseMessageTs()).toEqual(sent);
    expect((await conversationState(T, "C1")).history_complete_at).not.toBeNull();
    const dupes = await query<{ n: number }>(`SELECT count(*)::int AS n FROM activity_events WHERE user_id = $1 GROUP BY source_event_id HAVING count(*) > 1`, [T]);
    expect(dupes).toHaveLength(0);
  });

  it("honours Retry-After without a tight retry and shares the cooldown with every tenant of the workspace", async () => {
    seedChannel("C1", 5);
    await discoverSlackConversations(T, deps());
    fake.rateLimit("conversations.history", 1, "600");
    const r1 = await syncSlackHistory(T, deps({ budgetMs: 120_000 }));
    expect(r1).toMatchObject({ deferred: true, rateLimited: true, exhausted: false });
    expect(fake.calls("conversations.history")).toHaveLength(1); // the 429 only; no immediate retry
    const [quota] = await query<{ blocked_until: Date; last_retry_after_seconds: number }>(
      `SELECT blocked_until, last_retry_after_seconds FROM slack_source_quota WHERE quota_key = $1 AND method = 'conversations.history'`,
      [slackQuotaKey(TEAM)],
    );
    expect(quota!.last_retry_after_seconds).toBe(600);
    expect(new Date(quota!.blocked_until).getTime()).toBe(START + 600_000);

    // A second tenant connected to the SAME workspace is held by the same Retry-After.
    const T2 = "tenant-slack-b";
    fake.token("xoxp-synthetic-b", TEAM, "UOTHER");
    await connectSlack(T2, "xoxp-synthetic-b", TEAM);
    await discoverSlackConversations(T2, deps());
    clock.advance(60_000);
    const r2 = await syncSlackHistory(T2, deps({ budgetMs: 60_000 }));
    expect(r2.deferred).toBe(true);
    expect(fake.calls("conversations.history")).toHaveLength(1);
    const cov = await slackCoverage({ tenantId: T2, executor: db as never }, clock.t);
    expect(cov.find((c) => c.scope === `workspace:${TEAM}`)?.reason).toMatch(/Retry-After/);

    // After Retry-After, capture proceeds.
    clock.advance(600_000);
    const r3 = await syncSlackHistory(T, deps());
    expect(r3.exhausted).toBe(true);
    expect((await baseMessageTs()).length).toBe(5);
  });

  it("waits out a Retry-After that fits in the run budget, then succeeds", async () => {
    seedChannel("C1", 3);
    await discoverSlackConversations(T, deps());
    fake.rateLimit("conversations.history", 1, "30");
    const result = await syncSlackHistory(T, deps());
    expect(result.exhausted).toBe(true);
    const history = fake.calls("conversations.history");
    expect(history.map((r) => r.status)).toEqual([429, 200]);
    expect(clock.slept.some((ms) => ms >= 30_000)).toBe(true);
  });

  it("without a Retry-After header backs off at least a minute (never a tight loop)", async () => {
    seedChannel("C1", 3);
    await discoverSlackConversations(T, deps());
    fake.rateLimit("conversations.history", 1, null);
    await syncSlackHistory(T, deps({ budgetMs: 30_000 }));
    const [quota] = await query<{ last_retry_after_seconds: number }>(`SELECT last_retry_after_seconds FROM slack_source_quota WHERE method = 'conversations.history'`);
    expect(quota!.last_retry_after_seconds).toBeGreaterThanOrEqual(60);
    expect(fake.calls("conversations.history")).toHaveLength(1);
  });

  it("labels lost access per conversation and keeps capturing the readable ones", async () => {
    seedChannel("C1", 3);
    seedChannel("CPRIV", 2, { is_private: true, is_group: true });
    seedChannel("CARCH", 2, { is_archived: true });
    await discoverSlackConversations(T, deps());
    expect(fake.calls("conversations.list")[0]!.url.searchParams.get("exclude_archived")).toBe("false");
    fake.setError("CPRIV", "not_in_channel");
    const result = await syncSlackHistory(T, deps());
    expect(result.accessErrors).toEqual({ not_in_channel: 1 });
    expect((await conversationState(T, "CPRIV")).access_state).toBe("not_in_channel");
    expect((await conversationState(T, "CARCH")).history_complete_at).not.toBeNull(); // archived history captured
    expect((await baseMessageTs(T, "C1")).length).toBe(3);

    // Removed from a channel entirely: a complete listing marks it not_listed; data is kept.
    fake.unlist("C1");
    const disc = await discoverSlackConversations(T, deps());
    expect(disc.unlisted).toContain("C1");
    expect((await conversationState(T, "C1")).access_state).toBe("not_listed");
    expect((await baseMessageTs(T, "C1")).length).toBe(3);

    const cov = await slackCoverage({ tenantId: T, executor: db as never }, clock.t);
    expect(cov.find((c) => c.scope === `conversation:${TEAM}/CPRIV`)).toMatchObject({ state: "blocked" });
    expect(cov.find((c) => c.scope === `conversation:${TEAM}/C1`)).toMatchObject({ state: "blocked" });
    expect(cov.find((c) => c.scope === `${`workspace:${TEAM}`}/conversations`)?.state).toBe("partial");
  });

  it("a revoked token blocks the workspace instead of silently returning nothing", async () => {
    seedChannel("C1", 2);
    await discoverSlackConversations(T, deps());
    fake.tokens.delete(TOKEN);
    await expect(syncSlackHistory(T, deps())).rejects.toMatchObject({ code: "invalid_auth" });
    const cov = await slackCoverage({ tenantId: T, executor: db as never }, clock.t);
    expect(cov.find((c) => c.scope === `workspace:${TEAM}`)?.state).toBe("blocked");
  });

  it("reconcile sweep turns edits, reaction changes and deletions made while realtime was down into ledger observations", async () => {
    const sent = seedChannel("C1", 6);
    await discoverSlackConversations(T, deps());
    await syncSlackHistory(T, deps());
    const before = await slackRows(T);

    fake.edit("C1", sent[1]!, "m1 (edited)", ts(START + 60_000));
    fake.remove("C1", sent[2]!);
    fake.channel("C1").messages.get(sent[3]!)!.reactions = [{ name: "tada", users: ["U9"], count: 1 }];
    clock.advance(25 * HOUR);
    const result = await syncSlackHistory(T, deps({ reconcileWindowDays: 3 }));
    expect(result.revisionsObserved).toBe(2);
    expect(result.absentObserved).toBe(1);

    // Raw base rows are never rewritten.
    const after = await slackRows(T);
    for (const row of before) expect(after.find((r) => r.id === row.id)?.raw_payload).toEqual(row.raw_payload);
    const ledger = after.filter((r) => r.raw_payload._ledger === true).map((r) => r.event_type).sort();
    expect(ledger).toEqual(["message.absent_observed", "message.revision_observed", "message.revision_observed"]);

    const observations = await loadSlackLedgerObservations(db as never, T, "C1", [sent[1]!, sent[2]!, sent[3]!]);
    const base = (s: string) => before.find((r) => r.raw_payload.ts === s)!.raw_payload;
    const edited = foldSlackMessage(base(sent[1]!), observations.get(sent[1]!) ?? []).payload;
    expect(edited.text).toBe("m1 (edited)");
    expect(edited._edit_history).toEqual([{ text: "m1", edited_at: ts(START + 60_000) }]);
    expect(foldSlackMessage(base(sent[2]!), observations.get(sent[2]!) ?? []).payload).toMatchObject({ _deleted: true, _deleted_reason: "absent_from_history" });
    expect(foldSlackMessage(base(sent[3]!), observations.get(sent[3]!) ?? []).payload.reactions).toEqual([{ name: "tada", users: ["U9"], count: 1 }]);

    // A second sweep with no upstream change appends nothing.
    clock.advance(25 * HOUR);
    const quiet = await syncSlackHistory(T, deps({ reconcileWindowDays: 3 }));
    expect(quiet.revisionsObserved + quiet.absentObserved).toBe(0);
  });

  it("a bounded backfill is never reported as complete history", async () => {
    fake.channel("C1");
    fake.post("C1", { ts: ts(START - 40 * 24 * HOUR), user: "U1", text: "old" });
    fake.post("C1", { ts: ts(START - HOUR), user: "U1", text: "recent" });
    await discoverSlackConversations(T, deps());
    await syncSlackHistory(T, deps({ backfillDays: 30 }));
    expect(await baseMessageTs()).toEqual([ts(START - HOUR)]);
    const cov = await slackCoverage({ tenantId: T, executor: db as never }, clock.t);
    const c = cov.find((r) => r.scope === `conversation:${TEAM}/C1`)!;
    expect(c.state).toBe("partial");
    expect(c.reason).toMatch(/bounded backfill/);

    // An explicit unbounded run reopens the walk below the bound.
    await syncSlackHistory(T, deps({ backfillDays: null }));
    expect((await baseMessageTs()).length).toBe(2);
    const cov2 = await slackCoverage({ tenantId: T, executor: db as never }, clock.t);
    expect(cov2.find((r) => r.scope === `conversation:${TEAM}/C1`)!.state).toBe("complete");
  });

  it("keeps two workspaces of different tenants apart (state, quota identity, rows)", async () => {
    seedChannel("C1", 2);
    const T2 = "tenant-slack-c";
    fake.token("xoxp-other-team", "T0OTHER");
    await connectSlack(T2, "xoxp-other-team", "T0OTHER");
    await discoverSlackConversations(T, deps());
    await discoverSlackConversations(T2, deps());
    await syncSlackHistory(T, deps());
    await syncSlackHistory(T2, deps());
    const states = await query<{ tenant_id: string; team_id: string }>(`SELECT tenant_id, team_id FROM slack_source_conversations ORDER BY tenant_id`);
    expect(states).toEqual([{ tenant_id: T, team_id: TEAM }, { tenant_id: T2, team_id: "T0OTHER" }]);
    expect(slackQuotaKey(TEAM)).not.toBe(slackQuotaKey("T0OTHER"));
    expect((await slackRows(T2)).every((r) => r.source_namespace === "workspace:T0OTHER")).toBe(true);
    expect((await slackRows(T)).every((r) => r.source_namespace === `workspace:${TEAM}`)).toBe(true);
  });

  it("queues a continuation when work remains instead of looping", async () => {
    seedChannel("C1", 40);
    await discoverSlackConversations(T, deps());
    await syncSlackHistory(T, { ...deps({ budgetMs: 30_000 }), enqueueContinuation: true });
    const tasks = await query<{ kind: string; dedupe_key: string; run_at: Date }>(`SELECT kind, dedupe_key, run_at FROM task_queue WHERE tenant_id = $1 AND kind = 'slack.poll'`, [T]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.dedupe_key).toBe(`${T}:slack.poll:continue`);
    expect(new Date(tasks[0]!.run_at).getTime()).toBeGreaterThan(clock.t);
  });
});
