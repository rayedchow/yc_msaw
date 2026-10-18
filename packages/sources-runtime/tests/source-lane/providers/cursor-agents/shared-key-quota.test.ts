import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("../stripe/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, json, pg, query, ready } from "../stripe/harness.js";
import { connectCursorAgents, cursorAgentsIntegration, cursorQuotaKey, runCursorAgentsSync } from "../../../../src/integrations/cursor-agents/lane.js";
import { personalSegment, scopeTenantIdOf } from "../../../../src/source-lane/core/personal-scope.js";

/**
 * Cursor rate-limits the user/team behind an API key (cursor.com/docs/api.md#rate-limits), so owner-scope isolation
 * must not multiply one key's quota: a 429 seen in one member's scope holds every connection on that key, while
 * independent keys keep running concurrently. Real connect/sync/task-handler code on PGlite with the real migration
 * plan; Cursor is a local fake per key. Synthetic data only.
 */
const ORG = "org-acme";
const scope = (subject: string) => scopeTenantIdOf(ORG, personalSegment({ tenantNs: ORG, issuer: "https://auth.example.test", subject }));
const BOB = scope("user_bob");
const CAROL = scope("user_carol");
const DAVE = scope("user_dave");
const SHARED_KEY = "key_cursor_team_shared_1";
const DAVE_KEY = "key_cursor_dave_own_0001";

const fake = {
  calls: [] as Array<{ key: string; path: string }>,
  throttle: new Map<string, { status: number; headers: Record<string, string> }>(),
  fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    fake.calls.push({ key, path: url.pathname });
    if (![SHARED_KEY, DAVE_KEY].includes(key)) return json({ error: "unauthorized" }, 401);
    const t = fake.throttle.get(key);
    if (t) return json({ error: "rate limited" }, t.status, t.headers);
    if (url.pathname === "/v0/agents") return json({ agents: [{ id: `bc_${key.slice(-4)}`, status: "RUNNING", source: {}, target: {}, createdAt: "2026-10-01T00:00:00Z" }] });
    const m = /^\/v0\/agents\/([^/]+)\/conversation$/.exec(url.pathname);
    if (m) return json({ id: m[1], messages: [] });
    return json({}, 404);
  },
};
const deps = { fetchImpl: fake.fetch, executor: db as never, env: {} as NodeJS.ProcessEnv };
const callsFor = (key: string) => fake.calls.filter((c) => c.key === key).length;
const retryAt = async (tenant: string) => Date.parse((await query<{ retry_at: string }>(`SELECT retry_at FROM cursor_agents_connections WHERE tenant_id = $1`, [tenant]))[0]!.retry_at);
const due = (tenant: string) => pg.query(`UPDATE cursor_agents_connections SET retry_at = NULL, lease_until = NULL WHERE tenant_id = $1`, [tenant]);

async function connect(tenant: string, apiKey: string) {
  const r = await connectCursorAgents({ tenantId: tenant, body: { apiKey } }, deps);
  return r;
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM cursor_agents_snapshots; DELETE FROM cursor_agents_connections; DELETE FROM cursor_agents_quota; DELETE FROM activity_events WHERE source = 'cursor_background_agents'; DELETE FROM task_queue; DELETE FROM task_schedules; DELETE FROM connections; DELETE FROM source_lane_journal;`);
  fake.calls = [];
  fake.throttle.clear();
});

describe("one Cursor key reused by two members' owner scopes shares one Retry-After cooldown", () => {
  it("a 429 in bob's scope holds carol's scope (same key) until the floor, while dave's own key runs concurrently", async () => {
    for (const [tenant, key] of [[BOB, SHARED_KEY], [CAROL, SHARED_KEY], [DAVE, DAVE_KEY]] as const) expect((await connect(tenant, key)).status).toBe(201);
    expect(new Set((await query<{ tenant_id: string }>(`SELECT tenant_id FROM cursor_agents_connections`)).map((r) => r.tenant_id))).toEqual(new Set([BOB, CAROL, DAVE]));

    fake.throttle.set(SHARED_KEY, { status: 429, headers: { "retry-after": "900" } });
    const t0 = Date.now();
    // Through the registered task handler, the tenant taken from the task row (as the queue runs it).
    const handler = cursorAgentsIntegration.taskHandlers!()["cursor_agents.sync"]!;
    expect(handler).toBeDefined();
    const bob = await runCursorAgentsSync(BOB, deps);
    expect(bob[0]).toMatchObject({ status: "rate_limited" });
    expect(await retryAt(BOB) - t0).toBeGreaterThanOrEqual(899_000);
    fake.throttle.delete(SHARED_KEY); // Cursor would answer again, but the provider's floor has not passed

    const before = callsFor(SHARED_KEY);
    const [carol, dave] = await Promise.all([runCursorAgentsSync(CAROL, deps), runCursorAgentsSync(DAVE, deps)]);
    expect(carol[0]).toMatchObject({ status: "rate_limited", agents: 0 });
    expect(callsFor(SHARED_KEY)).toBe(before); // no request on the cooling key from another scope
    expect(await retryAt(CAROL) - t0).toBeGreaterThanOrEqual(899_000); // carol's row waits for the same floor
    expect(dave[0]).toMatchObject({ status: "ok", agents: 1, conversations: 1 }); // independent key unaffected
    expect((await query(`SELECT quota_key FROM cursor_agents_quota`)).map((r) => r.quota_key)).toEqual([cursorQuotaKey(SHARED_KEY)]);
    expect(cursorQuotaKey(SHARED_KEY)).not.toContain(SHARED_KEY);

    // Connecting the same key in yet another scope during the cooldown sends nothing and says so.
    const eve = await connect(scope("user_eve"), SHARED_KEY);
    expect(eve.status).toBe(429);
    expect(eve.body).toMatchObject({ error: { code: "rate_limited" } });
    expect(callsFor(SHARED_KEY)).toBe(before);

    // Once the floor passes (simulated), both scopes on the shared key resume.
    await pg.exec(`UPDATE cursor_agents_quota SET blocked_until = now() - interval '1 second'`);
    await due(BOB);
    await due(CAROL);
    expect((await runCursorAgentsSync(CAROL, deps))[0]).toMatchObject({ status: "ok", agents: 1 });
    expect((await runCursorAgentsSync(BOB, deps))[0]).toMatchObject({ status: "ok", agents: 1 });
  });

  it("while the key cools down, another scope sends nothing, so a shorter Retry-After cannot replace the earlier floor", async () => {
    for (const tenant of [BOB, CAROL]) expect((await connect(tenant, SHARED_KEY)).status).toBe(201);
    fake.throttle.set(SHARED_KEY, { status: 429, headers: { "retry-after": "3600" } });
    await runCursorAgentsSync(BOB, deps);
    await pg.exec(`UPDATE cursor_agents_quota SET blocked_until = now() + interval '3600 seconds'`);
    fake.throttle.set(SHARED_KEY, { status: 429, headers: { "retry-after": "5" } });
    // carol is held without a request; nothing records the shorter value.
    expect((await runCursorAgentsSync(CAROL, deps))[0]).toMatchObject({ status: "rate_limited" });
    const [q] = await query<{ secs: number; n: number }>(`SELECT EXTRACT(EPOCH FROM blocked_until - now())::float8 AS secs, rate_limit_count AS n FROM cursor_agents_quota`);
    expect(q!.secs).toBeGreaterThanOrEqual(3590);
    expect(q!.n).toBe(1);
  });

  it("a malformed or HTTP-date Retry-After never crashes the run or skips the other connections", async () => {
    for (const [tenant, key] of [[BOB, SHARED_KEY], [BOB, DAVE_KEY]] as const) expect((await connect(tenant, key)).status).toBe(201);
    fake.throttle.set(SHARED_KEY, { status: 429, headers: { "retry-after": "soon" } });
    const t0 = Date.now();
    const out = await runCursorAgentsSync(BOB, deps);
    expect(out.map((o) => o.status).sort()).toEqual(["ok", "rate_limited"]); // the second connection still synced
    const [q] = await query<{ secs: number }>(`SELECT EXTRACT(EPOCH FROM blocked_until - now())::float8 AS secs FROM cursor_agents_quota`);
    expect(q!.secs).toBeGreaterThanOrEqual(55); // the 60 s fallback, not 0 / NaN

    await pg.exec(`DELETE FROM cursor_agents_quota; UPDATE cursor_agents_connections SET retry_at = NULL, lease_until = NULL`);
    fake.throttle.set(SHARED_KEY, { status: 429, headers: { "retry-after": new Date(t0 + 14 * 86_400_000).toUTCString() } });
    await runCursorAgentsSync(BOB, deps);
    const [q2] = await query<{ secs: number }>(`SELECT EXTRACT(EPOCH FROM blocked_until - now())::float8 AS secs FROM cursor_agents_quota`);
    expect(q2!.secs).toBeGreaterThanOrEqual(14 * 86_400 - 10);
  });
});
