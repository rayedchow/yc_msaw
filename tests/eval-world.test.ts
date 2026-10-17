import { describe, expect, it } from "vitest";
import {
  ALL_SCENARIOS,
  NotificationWorld,
  buildScenario,
  evaluateWorld,
  isEligible,
} from "../eval/world/notifications.js";
import {
  directClient,
  noDedupePolicy,
  noFilterPolicy,
  noRetryPolicy,
  pageOneOnlyPolicy,
  referencePolicy,
  type ScriptedPolicy,
} from "../eval/scripted-policies.js";

async function run(seed: string, policy: ScriptedPolicy) {
  const world = NotificationWorld.fromSeed(seed);
  await policy(directClient(world), world.spec.channel);
  return { world, result: evaluateWorld(world) };
}

describe("notification world", () => {
  it("is deterministic per seed and differs across seeds", () => {
    expect(buildScenario("heldout-x")).toEqual(buildScenario("heldout-x"));
    expect(JSON.stringify(buildScenario("heldout-x"))).not.toEqual(JSON.stringify(buildScenario("heldout-y")));
  });

  it("every scenario contains every trap and eligible work beyond page one", () => {
    for (const seed of ALL_SCENARIOS) {
      const s = buildScenario(seed);
      expect(s.staleDelivered.length).toBeGreaterThan(0);
      expect(s.commitThen503.length).toBeGreaterThan(0);
      expect(Object.keys(s.transient503).length).toBeGreaterThan(1);
      expect(s.notifications.some((n) => n.status === "failed_permanent")).toBe(true);
      expect(s.notifications.some((n) => !n.recipient)).toBe(true);
      expect(s.notifications.some((n) => !["email", "sms", "push"].includes(n.channel))).toBe(true);
      const failedForChannel = s.notifications.filter(
        (n) => (n.status === "failed" || n.status === "failed_permanent") && n.channel === s.channel,
      );
      expect(failedForChannel.slice(3).some((n) => isEligible(n, s))).toBe(true);
    }
  });

  it("paginates with page size <= 3 and rejects bad cursors", () => {
    const w = NotificationWorld.fromSeed("train-day1-a");
    const r = w.listNotifications({ status: "failed", limit: 50 });
    expect(r.status).toBe(200);
    const body = r.body as { data: unknown[]; next_cursor: string | null };
    expect(body.data.length).toBe(3);
    expect(body.next_cursor).toBeTruthy();
    let bad = w.listNotifications({ status: "failed", cursor: "garbage" });
    if (bad.status === 429) bad = w.listNotifications({ status: "failed", cursor: "garbage" });
    expect(bad.status).toBe(400);
    expect(w.log.some((l) => l.status === 429)).toBe(true);
  });

  it("dedupes on idempotency key, 409s permanent, 422s malformed", () => {
    const w = NotificationWorld.fromSeed("train-day1-a");
    const s = w.spec;
    const stale = s.staleDelivered[0]!;
    const replay = w.deliver({ id: stale, idempotency_key: stale });
    expect(replay.status).toBe(200);
    expect((replay.body as { deduplicated: boolean }).deduplicated).toBe(true);
    const perm = s.notifications.find((n) => n.status === "failed_permanent")!;
    expect(w.deliver({ id: perm.id }).status).toBe(409);
    const noRecipient = s.notifications.find((n) => !n.recipient)!;
    expect(w.deliver({ id: noRecipient.id }).status).toBe(422);
    expect(w.log.map((l) => l.status)).toEqual([200, 409, 422]);
  });

  it("commit-then-503 creates a duplicate on blind retry but not with the idempotency key", () => {
    const seed = "heldout-y";
    const id = buildScenario(seed).commitThen503[0]!;
    const blind = NotificationWorld.fromSeed(seed);
    expect(blind.deliver({ id }).status).toBe(503);
    expect(blind.deliver({ id }).status).toBe(202);
    expect(evaluateWorld(blind).duplicates).toBe(1);
    const safe = NotificationWorld.fromSeed(seed);
    expect(safe.deliver({ id, idempotency_key: id }).status).toBe(503);
    expect(safe.deliver({ id, idempotency_key: id }).status).toBe(200);
    expect(safe.allDeliveries().filter((d) => d.notification_id === id)).toHaveLength(1);
  });
});

describe("oracle against scripted policies", () => {
  for (const seed of ALL_SCENARIOS) {
    it(`reference policy succeeds on ${seed}`, async () => {
      const { result } = await run(seed, referencePolicy);
      expect(result).toMatchObject({ success: true, duplicates: 0, missed: 0, wrong: 0 });
      expect(result.delivered).toBe(result.eligible);
      expect(result.failedCalls).toBeGreaterThan(0); // 429/503 are unavoidable on first try
    });

    it(`page-one-only misses work on ${seed}`, async () => {
      const { result } = await run(seed, pageOneOnlyPolicy);
      expect(result.success).toBe(false);
      expect(result.missed).toBeGreaterThan(0);
      expect(result.duplicates).toBe(0);
    });

    it(`no-retry misses transient failures on ${seed}`, async () => {
      const { result } = await run(seed, noRetryPolicy);
      expect(result.success).toBe(false);
      expect(result.missed).toBeGreaterThan(0);
    });

    it(`no-dedupe creates duplicates on ${seed}`, async () => {
      const { world, result } = await run(seed, noDedupePolicy);
      expect(result.success).toBe(false);
      expect(result.duplicates).toBeGreaterThanOrEqual(world.spec.staleDelivered.length + world.spec.commitThen503.length);
      expect(result.missed).toBe(0);
    });

    it(`no-filter delivers to the wrong channel on ${seed}`, async () => {
      const { result } = await run(seed, noFilterPolicy);
      expect(result.success).toBe(false);
      expect(result.wrong).toBeGreaterThan(0);
    });
  }
});
