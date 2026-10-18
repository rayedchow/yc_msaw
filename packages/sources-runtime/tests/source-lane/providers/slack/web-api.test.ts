import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { Clock, db, query, ready, resetAll } from "./harness.js";
import { parseRetryAfterSeconds, SlackApiError, SlackDeferredError, SlackWebClient } from "../../../../src/integrations/slack/web-api.js";
import { SlackApiError as PollerSlackApiError } from "../../../../src/integrations/slack/poller.js";

describe("Slack Web API client", () => {
  let clock: Clock;
  beforeAll(async () => {
    await ready;
  });
  beforeEach(async () => {
    await resetAll();
    clock = new Clock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses Retry-After seconds and HTTP dates and never returns a zero wait", () => {
    expect(parseRetryAfterSeconds("30", 0)).toBe(30);
    expect(parseRetryAfterSeconds("0", 0)).toBe(1);
    expect(parseRetryAfterSeconds(new Date(Date.now() + 90_000).toUTCString(), 0)).toBeGreaterThanOrEqual(89);
    expect(parseRetryAfterSeconds(null, 0)).toBe(60);
    expect(parseRetryAfterSeconds(null, 3)).toBe(480);
    expect(parseRetryAfterSeconds(null, 10)).toBe(900);
  });

  it("two workers sharing a quota key are spaced by the method tier (no per-process bursts)", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, messages: [] }));
    const opts = { token: "xoxp-x", quotaKey: "qk-1", deadline: new Date(clock.t + 10 * 60_000), executor: db as never, fetchImpl, now: clock.now, sleep: clock.sleep, rpm: () => 1 };
    const w1 = new SlackWebClient(opts);
    const w2 = new SlackWebClient(opts);
    const start = clock.t;
    await w1.call("conversations.history", { channel: "C1" });
    await w2.call("conversations.history", { channel: "C2" });
    await w1.call("conversations.history", { channel: "C3" });
    expect(clock.t - start).toBe(120_000);
    // A different method has its own bucket.
    await w2.call("conversations.replies", { channel: "C1", ts: "1.0" });
    expect(clock.t - start).toBe(120_000);
  });

  it("defers instead of waiting past the run deadline, without reserving a slot", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const client = new SlackWebClient({ token: "xoxp-x", quotaKey: "qk-2", deadline: new Date(clock.t + 30_000), executor: db as never, fetchImpl, now: clock.now, sleep: clock.sleep, rpm: () => 1 });
    await client.call("conversations.history");
    await expect(client.call("conversations.history")).rejects.toBeInstanceOf(SlackDeferredError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [q] = await query<{ next_slot_at: Date }>(`SELECT next_slot_at FROM slack_source_quota WHERE quota_key = 'qk-2'`);
    expect(new Date(q!.next_slot_at).getTime()).toBe(clock.t + 60_000);
  });

  it("surfaces Slack errors as one typed error class shared with the donor poller, and never sends the token elsewhere", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${new URL(String(input)).host}|${new Headers(init?.headers).get("authorization")}|${init?.redirect}`);
      return Response.json({ ok: false, error: "not_in_channel" });
    });
    const client = new SlackWebClient({ token: "xoxp-x", quotaKey: "qk-3", deadline: new Date(clock.t + 60_000), executor: db as never, fetchImpl, now: clock.now, sleep: clock.sleep });
    const err = await client.call("conversations.history", { channel: "C1" }).catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err).toBeInstanceOf(PollerSlackApiError);
    expect(err).toMatchObject({ code: "not_in_channel", method: "conversations.history" });
    expect(seen).toEqual(["slack.com|Bearer xoxp-x|error"]);
  });
});
