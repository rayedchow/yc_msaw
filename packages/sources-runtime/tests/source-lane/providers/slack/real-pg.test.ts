import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSlack } from "./fake-slack.js";
import { bindingToken, FakePublishStore } from "./publish.js";

/**
 * Slack lane on a real PostgreSQL (SOURCES_TEST_PG_URL, synthetic fixture cluster): the full
 * source-lane migration plan including 9400, durable quota slots claimed concurrently from
 * separate connections, the per-workspace history lease under real concurrency, and the
 * exporter. Creates and drops its own database; never touches another one.
 */

const PG = process.env.SOURCES_TEST_PG_URL;
const tokenStore = vi.hoisted(() => new Map<string, { token: string; metadata: Record<string, unknown> | null }>());
vi.mock("../../../../src/vault/tokens.js", () => ({
  getTokenWithMetadata: async (u: string, p: string) => tokenStore.get(`${u}:${p}`) ?? null,
  getTokenMetadata: async (u: string, p: string) => tokenStore.get(`${u}:${p}`)?.metadata ?? null,
  getToken: async (u: string, p: string) => tokenStore.get(`${u}:${p}`)?.token ?? null,
  mergeTokenMetadata: async () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
const mods: Record<string, Any> = {};
const T = "tenant-slack-pg";
const TEAM = "T0PG";
const TOKEN = "xoxp-synthetic-pg";

describe.skipIf(!PG)("slack source lane on real PostgreSQL", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `slack_lane_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 4, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.store = await import("../../../../src/integrations/slack/source-store.js");
    mods.sync = await import("../../../../src/integrations/slack/history-sync.js");
    mods.exporter = await import("../../../../src/source-lane/export/exporter.js");
    mods.bindings = await import("../../../../src/source-lane/export/bindings.js");
    mods.registry = await import("../../../../src/source-lane/registry.js");
    mods.slack = await import("../../../../src/source-lane/providers/slack/index.js");
    mods.paths = await import("../../../../src/source-lane/providers/slack/paths.js");
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await sql?.end({ timeout: 5 });
    try {
      await (mods.db as Any)?.pgClient?.end?.({ timeout: 5 });
    } catch {
      // client may not have been created
    }
    if (adminSql && dbName) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
  });

  it("spaces concurrently claimed quota slots across connections and honours a shared Retry-After", async () => {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    const a = postgres(url.href, { max: 1, onnotice: () => {} });
    const b = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      const now = new Date("2027-01-20T12:00:00.000Z");
      const deadline = new Date(now.getTime() + 60 * 60_000);
      const workers = [drizzle(a), drizzle(b)];
      const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => mods.store.claimQuotaSlot(workers[i % 2], "qk-pg", "conversations.history", 60_000, now, deadline)));
      const slots = claims.map((d: Date) => d.getTime()).sort((x: number, y: number) => x - y);
      expect(new Set(slots).size).toBe(10);
      for (let i = 1; i < slots.length; i++) expect(slots[i] - slots[i - 1]).toBe(60_000);
      // A Retry-After recorded by one worker holds back the other.
      await mods.store.recordRateLimited(workers[0], "qk-pg", "conversations.replies", 300, now);
      expect(await mods.store.claimQuotaSlot(workers[1], "qk-pg", "conversations.replies", 60_000, now, new Date(now.getTime() + 120_000))).toBeNull();
      const later = await mods.store.claimQuotaSlot(workers[1], "qk-pg", "conversations.replies", 60_000, now, new Date(now.getTime() + 600_000));
      expect(later.getTime()).toBe(now.getTime() + 300_000);
    } finally {
      await a.end({ timeout: 5 });
      await b.end({ timeout: 5 });
    }
  });

  it("captures history once under concurrent runs (lease) and exports it", async () => {
    const fake = new FakeSlack();
    fake.token(TOKEN, TEAM);
    fake.channel("C1", { name: "general" });
    const base = Date.parse("2027-01-20T10:00:00.000Z");
    for (let i = 0; i < 20; i++) fake.post("C1", { ts: `${Math.floor((base + i * 60_000) / 1000)}.000100`, user: "U1", text: `m${i}` });
    vi.stubGlobal("fetch", fake.fetch);
    tokenStore.set(`${T}:slack`, { token: TOKEN, metadata: { slackTeamId: TEAM, teamName: "PG" } });
    await sql`INSERT INTO integration_tokens (user_id, provider, access_token) VALUES (${T}, 'slack', 'synthetic')`;
    await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES (${T}, 'slack', ${TEAM}, 'active')`;
    let t = Date.parse("2027-01-20T12:00:00.000Z");
    // One long simulated run (fake clock): wait in-process up to the deadline instead of deferring after the first slot.
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; }, maxInlineWaitMs: Infinity };
    await mods.sync.discoverSlackConversations(T, clock);
    const runs = await Promise.all([
      mods.sync.syncSlackHistory(T, { ...clock, enqueueContinuation: false }),
      mods.sync.syncSlackHistory(T, { ...clock, enqueueContinuation: false }),
    ]);
    expect(runs.filter((r: Any) => r.leaseHeld)).toHaveLength(1);
    const [{ n, distinct }] = await sql`SELECT count(*)::int AS n, count(DISTINCT source_event_id)::int AS distinct FROM activity_events WHERE user_id = ${T}`;
    expect(n).toBe(20);
    expect(distinct).toBe(20);
    const [state] = await sql`SELECT history_complete_at FROM slack_source_conversations WHERE tenant_id = ${T} AND channel_id = 'C1'`;
    expect(state.history_complete_at).not.toBeNull();

    const store = new FakePublishStore();
    await mods.bindings.setTenantBinding(mods.db.db, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new mods.exporter.SourceExporter({ db: mods.db.db, registry: new mods.registry.SourceProviderRegistry([mods.slack.slackProvider]), fetchImpl: store.fetch, log: () => {} });
    for (let i = 0; i < 20; i++) {
      const r = await exporter.runOnce();
      expect(r.deadLettered).toBe(0);
      if (r.claimed === 0) break;
    }
    expect(store.live("sources/slack/_raw/").length).toBe(20);
    expect(store.json(mods.paths.conversationLabelPath(TEAM, "C1")).history.coverage).toBe("complete_from_channel_start");
  });
});
