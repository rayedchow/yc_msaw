import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSlack } from "./fake-slack.js";
import { bindingToken, FakePublishStore } from "./publish.js";

/**
 * final-performance-check (Claude Opus 5.5): Slack late DM classification in the ACTUAL producer order, on real
 * PostgreSQL (SOURCES_TEST_PG_URL; own database, dropped at the end). Synthetic data only.
 *
 * Producer order modelled: a group DM (mpim, non-D id) message arrives over realtime (`handleEvent`) before
 * `conversations.list` discovery has written its slack_source_conversations row (and with no donor watermark), so
 * realtime stores `_channel_type: "unknown"` next to Slack's own `channel_type: "mpim"`. Discovery then lists it.
 * The real SourceExporter exports through the real wire protocol into FakePublishStore.
 *
 * Drop into packages/sources-runtime/tests/source-lane/providers/slack/ to run.
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
const TEAM = "T0LATE";
const TOKEN = "xoxp-synthetic-late";
let tenantSeq = 0;

const isDmQuery = (text: string) => text.includes("known_channel");

/** The exporter's database, with a hook after each isDirectChannel query (and a count of them). */
function hookedDb(onDmQuery: (params: unknown[]) => Promise<void>) {
  const real = mods.db.db;
  const counter = { dmQueries: 0 };
  const proxy = new Proxy(real, {
    get(t, p) {
      if (p === "execute") {
        return async (q: Any) => {
          const res = await t.execute(q);
          let text = "";
          let params: unknown[] = [];
          try {
            const compiled = t.dialect.sqlToQuery(q);
            text = compiled.sql;
            params = compiled.params;
          } catch {
            text = "";
          }
          if (isDmQuery(text)) {
            counter.dmQueries++;
            await onDmQuery(params);
          }
          return res;
        };
      }
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { db: proxy, counter };
}

describe.skipIf(!PG)("Slack late DM classification in producer order (real PG)", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `fpc_slack_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    sql = postgres(url.href, { max: 4, onnotice: () => {} });
    mods.migrations = await import("../../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../../src/db/client.js");
    mods.realtime = await import("../../../../src/integrations/slack/realtime.js");
    mods.sync = await import("../../../../src/integrations/slack/history-sync.js");
    mods.exporter = await import("../../../../src/source-lane/export/exporter.js");
    mods.bindings = await import("../../../../src/source-lane/export/bindings.js");
    mods.registry = await import("../../../../src/source-lane/registry.js");
    mods.slack = await import("../../../../src/source-lane/providers/slack/index.js");
    mods.direct = await import("../../../../src/source-lane/providers/slack/direct.js");
  }, 120_000);

  beforeEach(() => mods.direct.resetDirectChannelCacheForTests());

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

  async function tenant() {
    const T = `tenant-late-${++tenantSeq}`;
    const fake = new FakeSlack();
    fake.token(TOKEN, TEAM);
    vi.stubGlobal("fetch", fake.fetch);
    tokenStore.set(`${T}:slack`, { token: TOKEN, metadata: { slackTeamId: TEAM, teamName: "Late" } });
    await sql`INSERT INTO integration_tokens (user_id, provider, access_token) VALUES (${T}, 'slack', 'synthetic')`;
    await sql`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES (${T}, 'slack', ${TEAM}, 'active')`;
    const store = new FakePublishStore();
    await mods.bindings.setTenantBinding(mods.db.db, { tenantId: T, bindingId: `sb-${randomBytes(8).toString("hex")}`, token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    let t = Date.parse("2027-01-20T12:00:00.000Z");
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; }, maxInlineWaitMs: Infinity };
    return { T, fake, store, clock };
  }

  /** A realtime message event exactly as Slack's Events API delivers it for a group DM (no `user`: no users.info call). */
  const mpimEvent = (channel: string, ts: string, text: string) => ({ team_id: TEAM, event: { type: "message", channel, channel_type: "mpim", ts, text } });
  const channelEvent = (channel: string, ts: string, text: string) => ({ team_id: TEAM, event: { type: "message", channel, channel_type: "channel", ts, text } });

  const exporterOn = (db: Any, store: FakePublishStore) =>
    new mods.exporter.SourceExporter({ db, registry: new mods.registry.SourceProviderRegistry([mods.slack.slackProvider]), fetchImpl: store.fetch, log: () => {}, claimLimit: 5000 });

  /** Every path ever published as a put that carries `channel` (raw ledger rows, channel-day projections). */
  const everPut = (store: FakePublishStore, channel: string) => [...store.versions.entries()].filter(([p, vs]) => p.includes(channel) && vs.some((v) => v.op === "put")).map(([p]) => p);
  const liveWith = (store: FakePublishStore, channel: string) => [...store.versions.entries()].filter(([p, vs]) => p.includes(channel) && vs.at(-1)?.op === "put").map(([p]) => p);

  it("records what reaches the store for a realtime group-DM event that arrives before discovery (pass boundary)", async () => {
    const { T, fake, store, clock } = await tenant();
    const CH = "G0MPIMLATE1";
    await mods.realtime.handleEvent(mpimEvent(CH, "1800000000.000100", "private group dm one"), T, TOKEN, TEAM);
    const [ev] = await sql`SELECT raw_payload FROM activity_events WHERE user_id = ${T} AND source = 'slack'`;
    const payload = typeof ev.raw_payload === "string" ? JSON.parse(ev.raw_payload) : ev.raw_payload;
    const shape = { _channel_type: payload._channel_type, channel_type: payload.channel_type };
    const { db, counter } = hookedDb(async () => {});
    const exporter = exporterOn(db, store);
    await exporter.runOnce();
    const afterPass1 = { everPut: everPut(store, CH), live: liveWith(store, CH), dmQueries: counter.dmQueries };
    // Discovery lists the conversation (actual history-sync code), then the next pass exports its row.
    fake.channel(CH, { name: "mpdm-a--b--c-1", is_channel: false, is_mpim: true, is_private: true });
    await mods.sync.discoverSlackConversations(T, clock);
    await mods.realtime.handleEvent(mpimEvent(CH, "1800000060.000100", "private group dm two"), T, TOKEN, TEAM);
    for (let i = 0; i < 5; i++) if ((await exporter.runOnce()).claimed === 0) break;
    const afterPass2 = { everPut: everPut(store, CH), live: liveWith(store, CH), deletes: [...store.versions.entries()].filter(([p, vs]) => p.includes(CH) && vs.at(-1)?.op === "delete").map(([p, vs]) => [p, vs.at(-1)!.reason]) };
    console.log("[fpc] pass-boundary", JSON.stringify({ shape, afterPass1, afterPass2 }, null, 1));
    // Property under test: once classified, nothing of the group DM may stay readable in $SOURCES.
    expect(afterPass2.live).toEqual([]);
    // And Slack's own channel_type ("mpim") was available at ingest: the first pass must not publish it either.
    expect(afterPass1.everPut).toEqual([]);
  });

  it("same pass: discovery commits between two rows of one export pass; the later row must be withheld", async () => {
    const { T, fake, store, clock } = await tenant();
    const CH = "G0MPIMLATE2";
    // Two realtime rows before any pass; discovery has not run (no watermark, no conversation row).
    await mods.realtime.handleEvent(mpimEvent(CH, "1800000100.000100", "first private"), T, TOKEN, TEAM);
    await mods.realtime.handleEvent(mpimEvent(CH, "1800000160.000100", "second private"), T, TOKEN, TEAM);
    fake.channel(CH, { name: "mpdm-x--y--z-1", is_channel: false, is_mpim: true, is_private: true });
    let fired = false;
    const { db, counter } = hookedDb(async (params) => {
      if (fired || !params.includes(CH)) return;
      fired = true;
      // Another worker's discovery commits right after the exporter's first check of this conversation.
      await mods.sync.discoverSlackConversations(T, clock);
    });
    const exporter = exporterOn(db, store);
    await exporter.runOnce();
    const [{ type }] = await sql`SELECT channel_type AS type FROM slack_source_conversations WHERE tenant_id = ${T} AND channel_id = ${CH}`;
    const result = { fired, conversationType: type, dmQueries: counter.dmQueries, everPut: everPut(store, CH), live: liveWith(store, CH) };
    console.log("[fpc] same-pass", JSON.stringify(result, null, 1));
    expect(fired).toBe(true);
    // Rows mapped after the commit must not be published (pre-a6cffa8 each row re-queried and saw 'mpim').
    expect(result.everPut.filter((p) => p.includes("1800000160"))).toEqual([]);
  });

  it("a row stored before the realtime fix (_channel_type 'unknown', Slack channel_type 'mpim') is not published", async () => {
    const { T, fake, store, clock } = await tenant();
    const CH = "G0MPIMLEGACY";
    await mods.realtime.handleEvent(mpimEvent(CH, "1800000500.000100", "legacy private"), T, TOKEN, TEAM);
    await sql`UPDATE activity_events SET raw_payload = jsonb_set(raw_payload::jsonb, '{_channel_type}', '"unknown"') WHERE user_id = ${T} AND source = 'slack'`;
    const exporter = exporterOn(mods.db.db, store);
    await exporter.runOnce();
    const rawPut = everPut(store, CH).filter((p) => p.includes("/_raw/"));
    fake.channel(CH, { name: "mpdm-l--m--n-1", is_channel: false, is_mpim: true, is_private: true });
    await mods.sync.discoverSlackConversations(T, clock);
    for (let i = 0; i < 5; i++) if ((await exporter.runOnce()).claimed === 0) break;
    console.log("[fpc] legacy", JSON.stringify({ rawPut, live: liveWith(store, CH) }));
    expect(rawPut).toEqual([]);
    expect(liveWith(store, CH)).toEqual([]);
  });

  it("rows that carry no conversation type (reactions) in an unknown group DM are retracted when discovery classifies it (same pass + boundary)", async () => {
    const { T, fake, store, clock } = await tenant();
    const CH = "G0MPIMREACT";
    // Slack reaction events carry item.channel but no channel_type: nothing can classify them before discovery.
    const reaction = (ts: string, name: string) => ({ team_id: TEAM, event: { type: "reaction_added", user: undefined, reaction: name, item: { type: "message", channel: CH, ts: "1800000300.000100" }, event_ts: ts } });
    await mods.realtime.handleEvent(reaction("1800000310.000100", "eyes"), T, TOKEN, TEAM);
    await mods.realtime.handleEvent(reaction("1800000320.000100", "tada"), T, TOKEN, TEAM);
    fake.channel(CH, { name: "mpdm-r--s--t-1", is_channel: false, is_mpim: true, is_private: true });
    let fired = false;
    const { db, counter } = hookedDb(async (params) => {
      if (fired || !params.includes(CH)) return;
      fired = true;
      await mods.sync.discoverSlackConversations(T, clock);
    });
    const exporter = exporterOn(db, store);
    await exporter.runOnce();
    const pass1 = { everPut: everPut(store, CH), live: liveWith(store, CH), dmQueries: counter.dmQueries };
    for (let i = 0; i < 5; i++) if ((await exporter.runOnce()).claimed === 0) break;
    const after = { live: liveWith(store, CH), deletes: [...store.versions.entries()].filter(([p, vs]) => p.includes(CH) && vs.at(-1)?.op === "delete").map(([p, vs]) => [p, vs.at(-1)!.reason]) };
    console.log("[fpc] reactions", JSON.stringify({ fired, pass1, after }, null, 1));
    expect(fired).toBe(true);
    expect(after.live).toEqual([]);
    for (const p of pass1.everPut) expect(after.deletes).toContainEqual([p, "slack_direct_message_withheld"]);
  });

  it("counts isDirectChannel queries for a metadata-less public drain (one pass) and keeps public messages", async () => {
    const { T, store } = await tenant();
    const CHANNELS = 20;
    const PER = 30;
    for (let c = 0; c < CHANNELS; c++) {
      for (let i = 0; i < PER; i++) {
        await mods.realtime.handleEvent(channelEvent(`C0PUB${String(c).padStart(5, "0")}`, `${1800001000 + c * 1000 + i * 10}.000100`, `public ${c}/${i}`), T, TOKEN, TEAM);
      }
    }
    const { db, counter } = hookedDb(async () => {});
    const exporter = exporterOn(db, store);
    const r = await exporter.runOnce();
    const raw = [...store.versions.keys()].filter((p) => p.startsWith("sources/slack/_raw/") && store.versions.get(p)!.at(-1)!.op === "put").length;
    const out = { rows: CHANNELS * PER, claimed: r.claimed, dmQueries: counter.dmQueries, liveRawPaths: raw };
    console.log("[fpc] drain", JSON.stringify(out));
    expect(out.dmQueries).toBeLessThanOrEqual(CHANNELS * 2);
    expect(raw).toBeGreaterThanOrEqual(CHANNELS * PER);
  }, 120_000);
});
