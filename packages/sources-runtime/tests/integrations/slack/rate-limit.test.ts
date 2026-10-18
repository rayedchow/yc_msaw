import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSlackRateBucketsForTests,
  SLACK_HISTORY_PAGE_LIMIT,
  SLACK_HISTORY_RPM,
  slackRateBucketKey,
  slackThrottle,
} from "../../../src/integrations/slack/rate-limit.js";

describe("Slack rate buckets", () => {
  beforeEach(() => {
    resetSlackRateBucketsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keys buckets per workspace token AND method", () => {
    const a = slackRateBucketKey("xoxp-team-a", "conversations.history");
    const b = slackRateBucketKey("xoxp-team-b", "conversations.history");
    const c = slackRateBucketKey("xoxp-team-a", "conversations.replies");

    expect(a).toMatch(/^[a-f0-9]{16}:conversations\.history$/u);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // Raw token never appears in the key.
    expect(a).not.toContain("xoxp-team-a");
  });

  it("caps history/replies at 1 request/min (2025 non-Marketplace distributed-app limit)", async () => {
    expect(SLACK_HISTORY_RPM).toBe(1);
    expect(SLACK_HISTORY_PAGE_LIMIT).toBe(15);

    for (const method of ["conversations.history", "conversations.replies"]) {
      // First call in the window passes immediately.
      await slackThrottle("xoxp-team-a", method);

      // Second call within the same minute must wait for the window reset.
      let secondResolved = false;
      const second = slackThrottle("xoxp-team-a", method)
        .then(() => { secondResolved = true; });

      await vi.advanceTimersByTimeAsync(0);
      expect(secondResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      await second;
      expect(secondResolved).toBe(true);
    }
  });


  it("serializes concurrent waiters instead of releasing them all at window reset", async () => {
    // Exhaust the 1/min history budget, then queue five concurrent waiters —
    // the observed live failure was all five waking at resetAt and firing
    // together against a 1 req/min budget.
    await slackThrottle("xoxp-team-a", "conversations.history");

    const resolved: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      void slackThrottle("xoxp-team-a", "conversations.history").then(() => { resolved.push(i); });
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveLength(0);

    // After one window only ONE waiter may proceed; the rest wait for later windows.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(resolved).toHaveLength(5);
  });

  it("one workspace exhausting its budget does not stall another workspace's token", async () => {
    // conversations.history tier allows 1 call/min (non-Marketplace regime).
    await slackThrottle("xoxp-team-a", "conversations.history");

    let saturatedResolved = false;
    const saturated = slackThrottle("xoxp-team-a", "conversations.history")
      .then(() => { saturatedResolved = true; });

    let otherResolved = false;
    void slackThrottle("xoxp-team-b", "conversations.history")
      .then(() => { otherResolved = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(saturatedResolved).toBe(false); // team A must wait for the window
    expect(otherResolved).toBe(true); // team B is unaffected

    await vi.advanceTimersByTimeAsync(60_000);
    await saturated;
    expect(saturatedResolved).toBe(true);
  });

  it("keeps independent budgets per method for the same token", async () => {
    // Exhaust the history budget (1/min)...
    await slackThrottle("xoxp-team-a", "conversations.history");
    let historyBlocked = true;
    void slackThrottle("xoxp-team-a", "conversations.history")
      .then(() => { historyBlocked = false; });

    // ...replies has its own bucket and is unaffected.
    let repliesResolved = false;
    void slackThrottle("xoxp-team-a", "conversations.replies")
      .then(() => { repliesResolved = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(historyBlocked).toBe(true);
    expect(repliesResolved).toBe(true);
  });

  it("SLACK_HISTORY_RPM env raises the history tier without a code change", async () => {
    vi.stubEnv("SLACK_HISTORY_RPM", "45");
    vi.resetModules();
    try {
      const fresh = await import("../../../src/integrations/slack/rate-limit.js");
      expect(fresh.SLACK_HISTORY_RPM).toBe(45);

      for (let i = 0; i < 45; i++) {
        await fresh.slackThrottle("xoxp-team-a", "conversations.history");
      }
      let saturatedResolved = false;
      void fresh.slackThrottle("xoxp-team-a", "conversations.history")
        .then(() => { saturatedResolved = true; });

      await vi.advanceTimersByTimeAsync(0);
      expect(saturatedResolved).toBe(false); // 46th call waits — cap is 45, not unlimited
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
