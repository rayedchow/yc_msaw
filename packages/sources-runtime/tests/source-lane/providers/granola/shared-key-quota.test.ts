import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { connectGranola, query, ready, resetAll } from "./harness.js";
import { FakeGranola, note } from "./fake-granola.js";
import { runGranolaSourceBackfill } from "../../../../src/source-lane/providers/granola/lane.js";
import { resetGranolaRateGatesForTests } from "../../../../src/integrations/granola/poller.js";
import { personalSegment, scopeTenantIdOf } from "../../../../src/source-lane/core/personal-scope.js";

/**
 * Granola rate-limits per user or workspace depending on the key's scope (docs.granola.ai/introduction#rate-limits),
 * and two members may connect ONE key in their own owner scopes. A 429 on that key must hold both scopes (durable,
 * across processes), an independent key keeps running concurrently, and a long hold never parks a worker in-process.
 * Real lane code on PGlite with the real migrations; Granola is a local fake per key. Synthetic data only.
 */
const ORG = "org-acme";
const scope = (subject: string) => scopeTenantIdOf(ORG, personalSegment({ tenantNs: ORG, issuer: "https://auth.example.test", subject }));
const BOB = scope("user_bob");
const CAROL = scope("user_carol");
const DAVE = scope("user_dave");
const SHARED = "grn_team_key_shared_by_two";
const OWN = "grn_dave_own_key_000001";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let fake: FakeGranola;
let byKey: string[];

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await resetAll();
  resetGranolaRateGatesForTests();
  fake = new FakeGranola();
  fake.account(SHARED);
  fake.account(OWN);
  byKey = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    byKey.push(new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "");
    return fake.fetch(input, init);
  });
});
afterEach(() => vi.unstubAllGlobals());

const calls = (key: string) => byKey.filter((k) => k === key).length;

describe("one Granola key reused across owner scopes shares one Retry-After cooldown", () => {
  it("a 429 in bob's scope defers carol's scope on the same key (even from a fresh process); dave's own key runs concurrently", async () => {
    fake.put(SHARED, note("n-shared", ago(2)));
    fake.put(OWN, note("n-dave", ago(2)));
    for (const [tenant, key] of [[BOB, SHARED], [CAROL, SHARED], [DAVE, OWN]] as const) await connectGranola(tenant, key);
    fake.script((url) => (url.pathname === "/v1/notes" ? new Response("slow down", { status: 429, headers: { "retry-after": "600" } }) : null));

    const bob = await runGranolaSourceBackfill(BOB).catch((e: Error) => e);
    expect(String(bob instanceof Error ? bob.message : JSON.stringify(bob))).toMatch(/429|deferred/);
    const [quota] = await query<{ quota_key: string; blocked_until: string }>(`SELECT quota_key, blocked_until FROM granola_source_quota`);
    expect(Date.parse(quota!.blocked_until) - Date.now()).toBeGreaterThan(590_000);
    expect((await query<{ tenant_id: string; quota_key: string }>(`SELECT tenant_id, quota_key FROM granola_source_state ORDER BY tenant_id`)).filter((r) => r.tenant_id === BOB)[0]!.quota_key).toBe(quota!.quota_key);

    for (const fresh of [false, true]) {
      if (fresh) resetGranolaRateGatesForTests(); // another worker process: only the durable row remains
      const before = calls(SHARED);
      const [carol, dave] = await Promise.all([runGranolaSourceBackfill(CAROL), fresh ? Promise.resolve(null) : runGranolaSourceBackfill(DAVE)]);
      expect(carol.deferredUntil).toBe(new Date(quota!.blocked_until).toISOString());
      expect(calls(SHARED)).toBe(before); // nothing sent on the cooling key from the other scope
      if (dave) expect(dave).toMatchObject({ stored: 1, failed: 0 }); // independent key unaffected
    }
    expect((await query(`SELECT DISTINCT quota_key FROM granola_source_state WHERE tenant_id IN ($1, $2)`, [BOB, CAROL])).length).toBe(1);
  });

  it("a long Retry-After on one note fetch never parks the run in-process: later fetches send nothing and the wait becomes durable", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    ids.forEach((id, i) => fake.put(SHARED, note(id, ago(5 - i * 0.1))));
    await connectGranola(BOB, SHARED);
    let throttledAt = -1;
    fake.script((url) => {
      if (url.pathname !== "/v1/notes/n0") return null;
      throttledAt = fake.calls.length;
      return new Response("slow down", { status: 429, headers: { "retry-after": "3600" } });
    });

    const started = Date.now();
    // The surfaced 429 (as the lane already reports a list-page 429) rather than a worker asleep for an hour.
    const outcome = await runGranolaSourceBackfill(BOB).catch((e: Error) => e);
    expect(Date.now() - started).toBeLessThan(15_000); // not 3600 s of sleep inside the worker
    if (outcome instanceof Error) expect(outcome.message).toMatch(/\(429\); retry-after=/);
    else expect(outcome.failed).toBeGreaterThan(0);
    const [quota] = await query<{ blocked_until: string }>(`SELECT blocked_until FROM granola_source_quota`);
    expect(Date.parse(quota!.blocked_until) - Date.now()).toBeGreaterThan(3_590_000);
    // Only fetches already in flight when the 429 arrived reached Granola; none started afterwards.
    const after = fake.calls.slice(throttledAt + 1).length;
    expect(after).toBeLessThanOrEqual(5);
    // carol on the same key, same process: deferred without a request.
    await connectGranola(CAROL, SHARED);
    const before = calls(SHARED);
    expect((await runGranolaSourceBackfill(CAROL)).deferredUntil).toBeTruthy();
    expect(calls(SHARED)).toBe(before);
  }, 30_000);
});
