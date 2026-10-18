/**
 * Discord bot collection, per selected channel, with a leased durable cursor (`discord_channels`):
 *
 *  1. forward: `after=<newest stored id>` pages until a short page. The first run takes the newest page
 *     and seeds both cursors.
 *  2. backfill: `before=<oldest reached id>` pages back to the channel's first message, which is the full
 *     history the bot can read. It resumes from the stored cursor; an empty page completes it.
 *  3. reconcile: every DISCORD_RECONCILE_INTERVAL_SECONDS, rescans the last DISCORD_RECONCILE_DAYS.
 *     Changed payloads (edits, reactions, embeds) become new versions. Stored messages inside the scanned id
 *     range that the scan no longer returns are tombstoned. Deletions older than the window are not
 *     detected, and coverage says so.
 *
 * Without a gateway connection there are no live MESSAGE_UPDATE/DELETE events. Edits and deletions appear
 * at the next reconcile.
 *
 * Failures stay per channel:
 *  - 429 sets the channel's retry time to the full `retry_after` (a `global` limit pauses the whole connection);
 *  - Missing Access / Missing Permissions blocks only that channel;
 *  - 401 marks the connection `error`.
 */
import { randomUUID } from "node:crypto";
import { DiscordApiError, DiscordClient, type DiscordMessage, type FetchImpl, snowflakeGreater } from "./api.js";
import {
  getConnection,
  leaseChannel,
  listChannels,
  listConnections,
  liveMessageIdsBetween,
  saveChannel,
  setConnectionState,
  tombstoneMessage,
  upsertMessage,
  type DiscordChannelState,
  type DiscordConnection,
  type Executor,
} from "./store.js";
import { db as defaultDb } from "../../db/client.js";

function intEnv(name: string, fallback: number, min: number): number {
  const n = Math.floor(Number(process.env[name] ?? fallback));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

export const DISCORD_SYNC_FREQUENCY_SECONDS = 300;
export const DISCORD_PAGES_PER_RUN = () => intEnv("DISCORD_PAGES_PER_RUN", 10, 1);
export const DISCORD_RECONCILE_DAYS = () => intEnv("DISCORD_RECONCILE_DAYS", 7, 1);
export const DISCORD_RECONCILE_INTERVAL_SECONDS = () => intEnv("DISCORD_RECONCILE_INTERVAL_SECONDS", 3600, 60);
export const DISCORD_RECONCILE_MAX_PAGES = () => intEnv("DISCORD_RECONCILE_MAX_PAGES", 20, 1);

export interface DiscordSyncDeps {
  executor?: Executor;
  fetchImpl?: FetchImpl;
  apiBase?: string;
  now?: () => Date;
}

export interface ChannelRunResult {
  channelId: string;
  status: "ok" | "skipped" | "rate_limited" | "blocked" | "error";
  stored: number;
  tombstoned: number;
  pages: number;
  reason?: string;
}

const minId = (msgs: DiscordMessage[]) => msgs.reduce<string | null>((m, x) => (m === null || BigInt(x.id) < BigInt(m) ? x.id : m), null);
const maxId = (msgs: DiscordMessage[]) => msgs.reduce<string | null>((m, x) => (m === null || BigInt(x.id) > BigInt(m) ? x.id : m), null);

async function runChannel(conn: DiscordConnection, client: DiscordClient, ch: DiscordChannelState, deps: DiscordSyncDeps): Promise<ChannelRunResult> {
  const executor = deps.executor ?? defaultDb;
  const now = deps.now ?? (() => new Date());
  const owner = `discord-${randomUUID()}`;
  const leased = await leaseChannel(conn.id, ch.channelId, owner, executor);
  if (!leased) return { channelId: ch.channelId, status: "skipped", stored: 0, tombstoned: 0, pages: 0, reason: "leased, deselected or retry pending" };
  const out: ChannelRunResult = { channelId: ch.channelId, status: "ok", stored: 0, tombstoned: 0, pages: 0 };
  let newest = leased.newestId;
  let before = leased.backfillBefore;
  let backfillDone = Boolean(leased.backfillCompleteAt);
  const store = async (msgs: DiscordMessage[]) => {
    for (const m of msgs) {
      // A message must belong to the leased channel (Discord never mixes channels; this is defence in depth).
      if (m.channel_id !== ch.channelId) continue;
      if ((await upsertMessage({ tenantId: conn.tenantId, connectionId: conn.id, guildId: leased.guildId, message: m }, executor)) !== "unchanged") out.stored++;
    }
  };
  const checkpoint = () => saveChannel(leased, owner, { newestId: newest, backfillBefore: before }, executor);
  try {
    const budget = DISCORD_PAGES_PER_RUN();
    // 1. forward
    if (!newest) {
      const page = await client.messages(ch.channelId, { limit: 100 });
      out.pages++;
      await store(page);
      newest = maxId(page);
      before = minId(page);
      if (page.length < 100) backfillDone = true;
      await saveChannel(leased, owner, { newestId: newest, backfillBefore: before, ...(page.length < 100 ? { backfillComplete: true } : {}) }, executor);
    }
    while (newest && out.pages < budget) {
      const page = await client.messages(ch.channelId, { after: newest, limit: 100 });
      out.pages++;
      await store(page);
      const top = maxId(page);
      if (top && snowflakeGreater(top, newest)) newest = top;
      await checkpoint();
      if (page.length < 100) break;
    }
    // 2. backfill (oldest history)
    while (!backfillDone && before && out.pages < budget) {
      const page = await client.messages(ch.channelId, { before, limit: 100 });
      out.pages++;
      await store(page);
      if (page.length === 0) {
        backfillDone = true;
        await saveChannel(leased, owner, { backfillComplete: true }, executor);
        break;
      }
      before = minId(page);
      await checkpoint();
    }
    // 3. reconcile recent window (edits / deletions)
    const due = !leased.lastReconcileAt || now().getTime() - Date.parse(leased.lastReconcileAt) >= DISCORD_RECONCILE_INTERVAL_SECONDS() * 1000;
    // Only once the history backfill is complete (until then the backfill itself is the full read).
    if (due && newest && backfillDone) {
      // Every message up to `newest` (read by the forward step just now) must appear in a complete scan.
      const scanCeiling = newest;
      const windowStart = new Date(now().getTime() - DISCORD_RECONCILE_DAYS() * 86_400_000);
      const seen = new Set<string>();
      let cursor: string | undefined;
      let highest: string | null = null;
      let lowest: string | null = null;
      let reachedEnd = false;
      let pages = 0;
      while (pages < DISCORD_RECONCILE_MAX_PAGES()) {
        const page = await client.messages(ch.channelId, { ...(cursor ? { before: cursor } : {}), limit: 100 });
        pages++;
        out.pages++;
        await store(page);
        for (const m of page) seen.add(m.id);
        const hi = maxId(page);
        const lo = minId(page);
        if (hi && (!highest || snowflakeGreater(hi, highest))) highest = hi;
        if (lo) lowest = lo;
        if (page.length < 100) {
          reachedEnd = true;
          break;
        }
        const oldestTs = Math.min(...page.map((m) => Date.parse(m.timestamp)));
        if (oldestTs < windowStart.getTime()) break;
        cursor = lo ?? undefined;
      }
      // Tombstone stored live messages inside [lowest, highest] the complete scan did not return.
      const candidates = await liveMessageIdsBetween(conn.id, ch.channelId, (reachedEnd ? new Date(0) : windowStart).toISOString(), executor);
      for (const id of candidates) {
        if (seen.has(id)) continue;
        if (snowflakeGreater(id, highest && snowflakeGreater(highest, scanCeiling) ? highest : scanCeiling)) continue; // newer than the scan start
        if (!reachedEnd && lowest && BigInt(id) < BigInt(lowest)) continue; // older than what the scan covered
        if (await tombstoneMessage(conn.tenantId, conn.id, leased.guildId, ch.channelId, id, "absent_from_reconcile_scan", executor)) out.tombstoned++;
      }
      await saveChannel(leased, owner, { reconciled: true }, executor);
    }
    await saveChannel(leased, owner, { polled: true, attempts: 0, retryAt: null, lastError: null, statusReason: null, release: true }, executor);
    // Proactively respect an exhausted bucket before the next run touches it.
    if (client.lastBucket.remaining === 0 && (client.lastBucket.resetAfterSeconds ?? 0) > 0) {
      await saveChannelRetry(conn, ch, client.lastBucket.resetAfterSeconds!, executor);
    }
    return out;
  } catch (err) {
    const attempts = leased.attempts + 1;
    if (err instanceof DiscordApiError && err.rateLimited) {
      const retryAt = new Date(Date.now() + Math.ceil((err.retryAfterSeconds ?? 1) * 1000));
      await saveChannel(leased, owner, { newestId: newest, backfillBefore: before, retryAt, attempts, lastError: `rate_limited${err.global ? " (global)" : ""}: retry after ${err.retryAfterSeconds}s`, release: true }, executor);
      if (err.global) await setConnectionState(conn.id, { retryAt }, executor);
      return { ...out, status: "rate_limited", reason: `retry after ${err.retryAfterSeconds}s${err.global ? " (global)" : ""}` };
    }
    if (err instanceof DiscordApiError && err.status === 401) {
      await saveChannel(leased, owner, { lastError: "invalid bot token", release: true }, executor);
      await setConnectionState(conn.id, { status: "error", reason: "invalid_bot_token" }, executor);
      return { ...out, status: "error", reason: "invalid bot token" };
    }
    if (err instanceof DiscordApiError && err.accessDenied) {
      const reason = `${err.code === 50013 ? "missing_permissions" : "missing_access"}: ${err.message} (needs VIEW_CHANNEL + READ_MESSAGE_HISTORY)`;
      await saveChannel(leased, owner, { status: "blocked", statusReason: reason, lastError: reason, newestId: newest, backfillBefore: before, retryAt: new Date(Date.now() + 3600_000), attempts, release: true }, executor);
      return { ...out, status: "blocked", reason };
    }
    const delay = Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
    const message = err instanceof Error ? err.message : String(err);
    await saveChannel(leased, owner, { newestId: newest, backfillBefore: before, retryAt: new Date(Date.now() + delay * 1000), attempts, lastError: message.slice(0, 500), release: true }, executor);
    return { ...out, status: "error", reason: message };
  }
}

async function saveChannelRetry(conn: DiscordConnection, ch: DiscordChannelState, seconds: number, executor: Executor): Promise<void> {
  const owner = `discord-bucket-${randomUUID()}`;
  const leased = await leaseChannel(conn.id, ch.channelId, owner, executor);
  if (leased) await saveChannel(leased, owner, { retryAt: new Date(Date.now() + Math.ceil(seconds * 1000)), release: true }, executor);
}

/** Scheduled sync of every selected channel of every active connection of the tenant. */
export async function runDiscordSync(tenantId: string, deps: DiscordSyncDeps = {}): Promise<{ connections: number; channels: ChannelRunResult[] }> {
  const executor = deps.executor ?? defaultDb;
  const results: ChannelRunResult[] = [];
  const conns = (await listConnections(tenantId, executor)).filter((c) => c.status === "active");
  const channels = await listChannels(tenantId, executor);
  for (const conn of conns) {
    if (conn.retryAt && Date.parse(conn.retryAt) > Date.now()) continue; // global rate limit
    const full = await getConnection(tenantId, conn.id, executor);
    if (!full) continue;
    const client = new DiscordClient(full.botToken(), deps.fetchImpl, deps.apiBase);
    for (const ch of channels.filter((c) => c.connectionId === conn.id && c.selected && c.status === "active")) {
      const r = await runChannel(conn, client, ch, deps);
      results.push(r);
      if (r.status === "rate_limited" && /global/.test(r.reason ?? "")) break;
      if (r.status === "error" && r.reason === "invalid bot token") break;
    }
  }
  return { connections: conns.length, channels: results };
}
