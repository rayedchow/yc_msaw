import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("../stripe/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, json, pg, query, ready } from "../stripe/harness.js";
import { connectDiscord, disconnectDiscord } from "../../../../src/integrations/discord/connect.js";
import { runDiscordSync } from "../../../../src/integrations/discord/sync.js";
import { GATEWAY_MESSAGE_CONTENT, type DiscordMessage } from "../../../../src/integrations/discord/api.js";
import { discordIntegration } from "../../../../src/integrations/discord/index.js";
import { integrationById } from "../../../../src/integrations/registry.js";
import { discordMessagesExport, discordProvider } from "../../../../src/source-lane/providers/discord/index.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";

/**
 * Discord official-bot lane (coordinator). Selected vs non-selected channels, full-history pagination and
 * resumption, forward polling, Discord's full retry_after (> 60 s), permission blocks, edits and deletions by
 * reconcile, tenant isolation, export and coverage. Synthetic data only; production code only.
 */
const T = "tenant-discord";
const T2 = "tenant-discord-rival";
const TOKEN = `MTA${"x".repeat(60)}.bot`;
const GUILD = "900000000000000001";
const CH_A = "910000000000000001";
const CH_B = "910000000000000002";
const CH_PRIVATE = "910000000000000003";
const BASE = 1_000_000_000_000_000_000n;

let fake: FakeDiscord;
const deps = () => ({ fetchImpl: fake.fetch, executor: db as never });

class FakeDiscord {
  me = { id: "800000000000000001", username: "procmem-bot", bot: true };
  appFlags = GATEWAY_MESSAGE_CONTENT;
  messages = new Map<string, DiscordMessage[]>([[CH_A, []], [CH_B, []]]);
  calls: URL[] = [];
  hooks: Array<(url: URL) => Response | undefined> = [];
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.calls.push(url);
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
    if (new Headers(init?.headers).get("authorization") !== `Bot ${TOKEN}`) return json({ message: "401: Unauthorized", code: 0 }, 401);
    for (const h of this.hooks) {
      const r = h(url);
      if (r) return r;
    }
    const p = url.pathname.replace(/^\/api\/v10/, "");
    if (p === "/users/@me") return json(this.me);
    if (p === "/applications/@me") return json({ id: "700000000000000001", flags: this.appFlags });
    if (p === "/users/@me/guilds") return json([{ id: GUILD, name: "Acme" }]);
    if (p === `/guilds/${GUILD}/channels`) return json([{ id: CH_A, type: 0, name: "general" }, { id: CH_B, type: 0, name: "eng" }, { id: "910000000000000099", type: 4, name: "category" }]);
    const ch = /^\/channels\/(\d+)$/.exec(p);
    if (ch) {
      if (ch[1] === CH_PRIVATE) return json({ message: "Missing Access", code: 50001 }, 403);
      return this.messages.has(ch[1]!) ? json({ id: ch[1], type: 0, guild_id: GUILD, name: ch[1] === CH_A ? "general" : "eng" }) : json({ message: "Unknown Channel", code: 10003 }, 404);
    }
    const m = /^\/channels\/(\d+)\/messages$/.exec(p);
    if (m) {
      const all = [...(this.messages.get(m[1]!) ?? [])].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      if (before) return json(all.filter((x) => BigInt(x.id) < BigInt(before)).slice(0, limit));
      if (after) return json(all.filter((x) => BigInt(x.id) > BigInt(after)).slice(-limit));
      return json(all.slice(0, limit));
    }
    return json({ message: "404: Not Found", code: 0 }, 404);
  };
  add(channel: string, n: number, opts: { from?: number; daysAgo?: (i: number) => number } = {}) {
    const list = this.messages.get(channel)!;
    const start = opts.from ?? list.length;
    for (let i = 0; i < n; i++) {
      const k = start + i;
      const days = opts.daysAgo ? opts.daysAgo(k) : 0;
      list.push({ id: String(BASE + BigInt(k) * 1000n + BigInt(channel === CH_A ? 1 : 2)), channel_id: channel, guild_id: GUILD, type: 0, content: `m${k}`,
        timestamp: new Date(Date.now() - days * 86_400_000).toISOString(), edited_timestamp: null, author: { id: "600000000000000001", username: "ana" } });
    }
  }
}

const stored = (tenant = T) => query<{ channel_id: string; message_id: string; deleted: boolean; deleted_reason: string | null; payload: { content?: string } }>(
  `SELECT channel_id, message_id, deleted, deleted_reason, payload FROM discord_messages WHERE tenant_id = $1 ORDER BY message_id`, [tenant]);
const coverage = (tenant = T) => discordProvider.coverage!({ tenantId: tenant, executor: db as never });

async function connect(channelIds = [CH_A]) {
  const r = await connectDiscord({ tenantId: T, body: { botToken: TOKEN, channelIds } }, deps());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { connection: { id: string } }).connection.id;
}
async function due() {
  await query(`UPDATE discord_channels SET retry_at = NULL, lease_until = NULL`);
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM discord_messages; DELETE FROM discord_channels; DELETE FROM discord_connections; DELETE FROM activity_events WHERE source = 'discord'; DELETE FROM task_queue; DELETE FROM task_schedules; DELETE FROM connections; DELETE FROM source_lane_journal;`);
  fake = new FakeDiscord();
  vi.stubEnv("DISCORD_PAGES_PER_RUN", "50");
});
afterEach(() => vi.unstubAllEnvs());

describe("connect (official bot API only)", () => {
  it("refuses user tokens, requires an explicit verified channel allowlist, and stores the token encrypted", async () => {
    fake.me = { ...fake.me, bot: false };
    expect((await connectDiscord({ tenantId: T, body: { botToken: TOKEN, channelIds: [CH_A] } }, deps())).body).toMatchObject({ error: { code: "user_token_refused" } });
    fake.me = { ...fake.me, bot: true };
    expect((await connectDiscord({ tenantId: T, body: { botToken: TOKEN } }, deps())).status).toBe(400);
    expect((await connectDiscord({ tenantId: T, body: { botToken: TOKEN, channelIds: [CH_A], tenantId: T2 } }, deps())).status).toBe(400);
    expect((await connectDiscord({ tenantId: T, body: { botToken: `${TOKEN}x`.replace("bot", "bad"), channelIds: [CH_A] } }, deps())).body).toMatchObject({ error: { code: "invalid_bot_token" } });
    const refused = await connectDiscord({ tenantId: T, body: { botToken: TOKEN, channelIds: [CH_A, CH_PRIVATE] } }, deps());
    expect(refused.body).toMatchObject({ error: { code: "channels_refused", refused: [{ channelId: CH_PRIVATE }] } });

    const id = await connect();
    const [row] = await query<{ bot_token_ciphertext: string; message_content_intent: string }>(`SELECT bot_token_ciphertext, message_content_intent FROM discord_connections WHERE id = $1`, [id]);
    expect(row!.bot_token_ciphertext).not.toContain("xxxx");
    expect(row!.message_content_intent).toBe("enabled");
    const discover = await connectDiscord({ tenantId: T, body: { connectionId: id, discover: true } }, deps());
    expect((discover.body as { guilds: Array<{ channels: unknown[] }> }).guilds[0]!.channels).toHaveLength(2);
    // Another tenant cannot touch this connection.
    expect((await connectDiscord({ tenantId: T2, body: { connectionId: id, channelIds: [CH_B] } }, deps())).status).toBe(404);
    expect((await query(`SELECT kind FROM task_schedules WHERE tenant_id = $1`, [T])).map((r) => r.kind)).toEqual(["discord.sync"]);
  });
});

describe("collection", () => {
  it("backfills full history resumably for selected channels only, then polls forward", async () => {
    vi.stubEnv("DISCORD_PAGES_PER_RUN", "2");
    fake.add(CH_A, 350);
    fake.add(CH_B, 20);
    await connect([CH_A]);
    await runDiscordSync(T, deps());
    expect((await stored()).length).toBe(100); // two pages per run: newest page + forward check
    const counts: number[] = [];
    for (let run = 0; run < 10; run++) {
      const [ch] = await query<{ backfill_complete_at: string | null; backfill_before: string }>(`SELECT backfill_complete_at, backfill_before FROM discord_channels WHERE channel_id = $1`, [CH_A]);
      if (ch!.backfill_complete_at) break;
      await due();
      await runDiscordSync(T, deps());
      counts.push((await stored()).length);
    }
    // Resumed from the durable `before` cursor each run, one backfill page per run, to the first message.
    expect(counts).toEqual([200, 300, 350, 350]);
    expect(fake.calls.some((u) => u.pathname.includes(`/channels/${CH_B}/messages`))).toBe(false);
    expect((await stored()).every((m) => m.channel_id === CH_A)).toBe(true);

    fake.add(CH_A, 5);
    await due();
    await runDiscordSync(T, deps());
    expect((await stored()).length).toBe(355);
    const raw = await query(`SELECT count(*)::int AS n FROM activity_events WHERE user_id = $1 AND source = 'discord'`, [T]);
    expect(raw[0]!.n).toBe(355);
    expect((await coverage()).find((c) => c.scope.endsWith(`channel:${GUILD}/${CH_A}`))!.state).toBe("complete");
    expect((await coverage()).find((c) => c.scope.endsWith(":edits-deletions"))!.state).toBe("partial");
  });

  it("honours Discord's full retry_after (beyond 60 s) by persisting it, and pauses the connection on a global limit", async () => {
    fake.add(CH_A, 10);
    await connect([CH_A, CH_B]);
    fake.hooks.push((url) => (url.pathname.endsWith(`/channels/${CH_A}/messages`) ? json({ message: "You are being rate limited.", retry_after: 187.5, global: false }, 429, { "retry-after": "188" }) : undefined));
    const before = Date.now();
    const r = await runDiscordSync(T, deps());
    expect(Date.now() - before).toBeLessThan(5_000); // no in-process sleep
    expect(r.channels.find((c) => c.channelId === CH_A)!.status).toBe("rate_limited");
    expect(r.channels.find((c) => c.channelId === CH_B)!.status).toBe("ok");
    const [a] = await query<{ retry_at: string }>(`SELECT retry_at FROM discord_channels WHERE channel_id = $1`, [CH_A]);
    expect(Date.parse(a!.retry_at) - before).toBeGreaterThanOrEqual(187_000);
    expect((await runDiscordSync(T, deps())).channels.find((c) => c.channelId === CH_A)!.status).toBe("skipped");

    fake.hooks = [(url) => (url.pathname.includes("/messages") ? json({ message: "global", retry_after: 90, global: true }, 429) : undefined)];
    await due();
    await runDiscordSync(T, deps());
    const [conn] = await query<{ retry_at: string }>(`SELECT retry_at FROM discord_connections`);
    expect(Date.parse(conn!.retry_at) - Date.now()).toBeGreaterThan(80_000);
    const calls = fake.calls.length;
    await due();
    expect((await runDiscordSync(T, deps())).channels).toEqual([]);
    expect(fake.calls.length).toBe(calls);
  });

  it("stops collecting a channel as soon as it is removed from the allowlist", async () => {
    fake.add(CH_A, 3);
    fake.add(CH_B, 3);
    const id = await connect([CH_A, CH_B]);
    await runDiscordSync(T, deps());
    expect((await connectDiscord({ tenantId: T, body: { connectionId: id, channelIds: [CH_A] } }, deps())).status).toBe(200);
    fake.add(CH_B, 3);
    const mark = fake.calls.length;
    await due();
    const r = await runDiscordSync(T, deps());
    expect(r.channels.map((c) => c.channelId)).toEqual([CH_A]);
    expect(fake.calls.slice(mark).some((u) => u.pathname.includes(`/channels/${CH_B}/`))).toBe(false);
    expect((await stored()).filter((m) => m.channel_id === CH_B)).toHaveLength(3);
    expect((await coverage()).some((c) => c.scope.endsWith(`/${CH_B}`))).toBe(false);
  });

  it("blocks only a channel whose permissions were removed", async () => {
    fake.add(CH_A, 3);
    fake.add(CH_B, 3);
    await connect([CH_A, CH_B]);
    fake.hooks.push((url) => (url.pathname.endsWith(`/channels/${CH_B}/messages`) ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined));
    const r = await runDiscordSync(T, deps());
    expect(r.channels.map((c) => [c.channelId, c.status])).toEqual([[CH_A, "ok"], [CH_B, "blocked"]]);
    const cov = await coverage();
    expect(cov.find((c) => c.scope.endsWith(`/${CH_B}`))).toMatchObject({ state: "blocked" });
    expect(cov.find((c) => c.scope.endsWith(`/${CH_B}`))!.reason).toMatch(/missing_permissions/);
  });

  it("reconcile records edits as new versions and tombstones deletions inside the window only", async () => {
    vi.stubEnv("DISCORD_RECONCILE_DAYS", "7");
    // 150 messages 30 days old, then 3 from yesterday: the reconcile scan's first page crosses the window.
    fake.add(CH_A, 153, { daysAgo: (k) => (k < 150 ? 30 : 1) });
    await connect([CH_A]);
    await runDiscordSync(T, deps());
    expect((await stored()).length).toBe(153);
    const msgs = fake.messages.get(CH_A)!;
    msgs[151] = { ...msgs[151]!, content: "edited", edited_timestamp: new Date().toISOString() };
    const removedRecent = msgs.splice(152, 1)[0]!; // the newest message
    const removedOld = msgs.splice(0, 1)[0]!;
    await query(`UPDATE discord_channels SET last_reconcile_at = now() - interval '2 hours'`);
    await due();
    await runDiscordSync(T, deps());
    const rows = await stored();
    expect(rows.find((m) => m.message_id === msgs[150]!.id)!.payload.content).toBe("edited");
    expect(rows.find((m) => m.message_id === removedRecent.id)).toMatchObject({ deleted: true, deleted_reason: "absent_from_reconcile_scan" });
    // Older than the reconcile window: the scan stopped before it, so it is NOT tombstoned (and coverage says so).
    expect(rows.find((m) => m.message_id === removedOld.id)!.deleted).toBe(false);
    const raw = await query<{ event_type: string }>(`SELECT event_type FROM activity_events WHERE user_id = $1 AND source = 'discord' AND event_type <> 'message' ORDER BY event_type`, [T]);
    expect(raw.map((r) => r.event_type)).toEqual(["message_deleted", "message_edited"]);
  });
});

describe("export, registration, isolation", () => {
  it("maps messages to files, isolates tenants, and revokes on disconnect", async () => {
    expect(integrationById("discord")).toBe(discordIntegration);
    expect(defaultRegistry().extraTable("discord_messages")?.provider).toBe(discordProvider);
    fake.add(CH_A, 1);
    await connect([CH_A]);
    await runDiscordSync(T, deps());
    const [{ id: key }] = await query<{ id: string }>(`SELECT id FROM discord_messages`);
    const journal = { op: "INSERT" as const, enqueuedAt: new Date().toISOString() };
    const [put] = await discordMessagesExport.map({ tenantId: T, executor: db as never }, key!, journal, []);
    expect(put).toMatchObject({ op: "put", kind: "raw", contentType: "application/json" });
    expect((put as { path: string }).path).toMatch(new RegExp(`^sources/discord/${GUILD}/${CH_A}/\\d{4}-\\d{2}/\\d+\\.json$`));
    expect(await discordMessagesExport.map({ tenantId: T2, executor: db as never }, key!, journal, [])).toEqual([]);
    expect(await query(`SELECT row_key FROM source_lane_journal WHERE table_name = 'discord_messages'`)).toHaveLength(1);
    await disconnectDiscord({ tenantId: T });
    expect((await coverage())[0]).toMatchObject({ state: "blocked" });
    const calls = fake.calls.length;
    await due();
    await runDiscordSync(T, deps());
    expect(fake.calls.length).toBe(calls);
  });
});
