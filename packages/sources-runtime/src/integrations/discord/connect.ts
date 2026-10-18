/**
 * Discord connect over the official bot API. Semantic reference: gigabrain 5448774
 * brain/src/integrations/discord-personal/connect.ts. Authentication is adapted: the donor accepted user
 * tokens typed in or captured from a browser session (a Discord Terms of Service problem). Here only a bot
 * token is accepted, and `GET /users/@me` must report `bot: true`. The operator creates the bot and invites
 * it to the guild with View Channel + Read Message History. Nothing here registers, invites or grants anything.
 *
 * Body forms (tenant = verified yc_msaw principal, never the body):
 *  - `{botToken, channelIds}` creates a connection with an explicit channel allowlist (each channel verified).
 *  - `{connectionId, discover: true}` lists the guild text channels the bot can see (for choosing).
 *  - `{connectionId, channelIds}` replaces the allowlist.
 *  - `{list: true}` lists connections and channels (no secrets).
 */
import { upsertConnection } from "../../db/connections.js";
import { enqueueTask } from "../../queue/queue.js";
import { upsertTaskSchedule } from "../../queue/sweeper.js";
import type { ConnectResult } from "../types.js";
import { DiscordApiError, DiscordClient, MESSAGE_CHANNEL_TYPES, messageContentIntent, type FetchImpl } from "./api.js";
import { getConnection, insertConnection, listChannels, listConnections, newConnectionId, revokeConnections, setSelection, type Executor } from "./store.js";
import { DISCORD_SYNC_FREQUENCY_SECONDS } from "./sync.js";
import { db as defaultDb } from "../../db/client.js";

const SNOWFLAKE = /^\d{17,20}$/;
const CONNECTION_ID = /^dc_[0-9a-f]{24}$/;
const MAX_CHANNELS = 500;

export interface DiscordConnectDeps {
  executor?: Executor;
  fetchImpl?: FetchImpl;
  apiBase?: string;
}

const bad = (message: string, code = "invalid_input", status = 400, extra: Record<string, unknown> = {}): ConnectResult => ({ status, body: { error: { code, message, ...extra } } });

async function verifyChannels(client: DiscordClient, ids: string[]): Promise<{ ok: Array<{ channelId: string; guildId: string; name: string | null; type: number }>; refused: Array<{ channelId: string; reason: string }> }> {
  const ok: Array<{ channelId: string; guildId: string; name: string | null; type: number }> = [];
  const refused: Array<{ channelId: string; reason: string }> = [];
  for (const id of ids) {
    try {
      const ch = await client.channel(id);
      if (!ch.guild_id) refused.push({ channelId: id, reason: "not a guild channel (bot DMs are not collected)" });
      else if (!MESSAGE_CHANNEL_TYPES.has(ch.type)) refused.push({ channelId: id, reason: `channel type ${ch.type} has no message history` });
      else ok.push({ channelId: id, guildId: ch.guild_id, name: ch.name ?? null, type: ch.type });
    } catch (err) {
      if (err instanceof DiscordApiError && err.accessDenied) refused.push({ channelId: id, reason: `bot cannot access this channel (${err.status}${err.code ? `/${err.code}` : ""})` });
      else throw err;
    }
  }
  return { ok, refused };
}

function channelIdsOf(body: Record<string, unknown>): string[] | ConnectResult {
  if (!Array.isArray(body.channelIds) || body.channelIds.length === 0) return bad("channelIds: an explicit, non-empty allowlist of guild channel ids is required");
  const ids = [...new Set(body.channelIds.map(String))];
  if (ids.length > MAX_CHANNELS) return bad(`At most ${MAX_CHANNELS} channels per connection`);
  if (!ids.every((id) => SNOWFLAKE.test(id))) return bad("channelIds must be Discord snowflakes");
  return ids;
}

export async function connectDiscord(input: { tenantId: string; body: unknown }, deps: DiscordConnectDeps = {}): Promise<ConnectResult> {
  const executor = deps.executor ?? defaultDb;
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !["botToken", "channelIds", "connectionId", "discover", "list"].includes(k));
  if (unknown.length) return bad(`Unknown field(s): ${unknown.join(", ")}`);

  if (body.list === true) {
    return { status: 200, body: { connections: await listConnections(input.tenantId, executor), channels: await listChannels(input.tenantId, executor) } };
  }

  if (typeof body.connectionId === "string") {
    if (!CONNECTION_ID.test(body.connectionId)) return bad("Invalid connectionId");
    const conn = await getConnection(input.tenantId, body.connectionId, executor);
    if (!conn || conn.status !== "active") return bad("No active Discord connection with that id", "not_found", 404);
    const client = new DiscordClient(conn.botToken(), deps.fetchImpl, deps.apiBase);
    if (body.discover === true) {
      const guilds = await client.guilds();
      const out = [];
      for (const g of guilds) {
        const channels = await client.guildChannels(g.id).catch(() => []);
        out.push({ guildId: g.id, name: g.name ?? null, channels: channels.filter((c) => MESSAGE_CHANNEL_TYPES.has(c.type)).map((c) => ({ channelId: c.id, name: c.name ?? null, type: c.type })) });
      }
      return { status: 200, body: { guilds: out, note: "Listing shows channels the bot can see; read access is verified when channels are selected and on every sync." } };
    }
    const ids = channelIdsOf(body);
    if (!Array.isArray(ids)) return ids;
    const v = await verifyChannels(client, ids);
    if (v.refused.length) return bad("Some channels cannot be collected by this bot", "channels_refused", 400, { refused: v.refused });
    await setSelection(input.tenantId, conn.id, v.ok, executor);
    await enqueueTask({ queue: "sync", tenantId: input.tenantId, kind: "discord.sync", groupKey: `${input.tenantId}:discord`, dedupeKey: `${input.tenantId}:discord.sync:selection`, payload: {} }, executor);
    return { status: 200, body: { connectionId: conn.id, channels: v.ok } };
  }

  if (typeof body.botToken !== "string" || body.botToken.length < 50 || body.botToken.length > 200 || /\s/.test(body.botToken)) return bad("botToken must be a Discord bot token");
  const ids = channelIdsOf(body);
  if (!Array.isArray(ids)) return ids;
  const client = new DiscordClient(body.botToken, deps.fetchImpl, deps.apiBase);
  let me;
  try {
    me = await client.me();
  } catch (err) {
    if (err instanceof DiscordApiError && err.status === 401) return bad("Discord rejected the bot token", "invalid_bot_token");
    return bad(`Could not verify the token: ${err instanceof Error ? err.message : String(err)}`, "discord_unreachable", 502);
  }
  if (me.bot !== true) return bad("Only bot tokens are supported; user (selfbot) tokens are refused", "user_token_refused");
  const app = await client.application().catch(() => null);
  const v = await verifyChannels(client, ids);
  if (v.refused.length) return bad("Some channels cannot be collected by this bot", "channels_refused", 400, { refused: v.refused });
  const id = newConnectionId();
  const conn = await insertConnection({
    id, tenantId: input.tenantId, botUserId: me.id, botUsername: me.username ?? null, applicationId: app?.id ?? null,
    botToken: body.botToken, messageContentIntent: messageContentIntent(app?.flags),
  }, executor);
  await setSelection(input.tenantId, id, v.ok, executor);
  await upsertConnection({ tenantId: input.tenantId, provider: "discord", externalAccountId: me.id, status: "active", metadata: { connectionId: id, botUsername: me.username ?? null } }, executor);
  await upsertTaskSchedule({ tenantId: input.tenantId, kind: "discord.sync", frequencySeconds: DISCORD_SYNC_FREQUENCY_SECONDS, queue: "sync", groupKey: `${input.tenantId}:discord` }, executor);
  await enqueueTask({ queue: "sync", tenantId: input.tenantId, kind: "discord.sync", groupKey: `${input.tenantId}:discord`, dedupeKey: `${input.tenantId}:discord.sync:${id}`, payload: {} }, executor);
  return {
    status: 201,
    body: {
      connection: conn,
      channels: v.ok,
      ...(conn.messageContentIntent !== "enabled" ? { warning: `Message Content intent is ${conn.messageContentIntent}: Discord returns empty content/embeds/attachments for messages that do not mention the bot. Enable it in the Developer Portal for full content.` } : {}),
    },
  };
}

export async function disconnectDiscord(input: { tenantId: string }, deps: DiscordConnectDeps = {}): Promise<void> {
  await revokeConnections(input.tenantId, deps.executor ?? defaultDb);
}
