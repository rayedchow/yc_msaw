/**
 * Discord source provider (official bot API lane, src/integrations/discord). Raw versions of every observed
 * message state and every deletion stay in activity_events (default raw layout under sources/discord/_raw/).
 * The current state of each message is exported from `discord_messages` as
 *
 *   sources/discord/<guildId>/<channelId>/<yyyy-mm>/<messageId>.json   (exact post-redaction message JSON)
 *
 * and becomes a tombstone when a reconcile scan finds it deleted.
 */
import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourceProviderModule } from "../../core/types.js";
import { DONOR } from "../../core/donor.js";
import { listChannels, listConnections } from "../../../integrations/discord/store.js";
import { DISCORD_RECONCILE_DAYS, DISCORD_SYNC_FREQUENCY_SECONDS } from "../../../integrations/discord/sync.js";

export const DISCORD_MESSAGES_TABLE = "discord_messages";

export function discordMessagePath(guildId: string, channelId: string, messageTs: Date, messageId: string): string {
  const month = messageTs.toISOString().slice(0, 7);
  return `sources/discord/${guildId}/${channelId}/${month}/${messageId}.json`;
}

interface Row {
  guild_id: string;
  channel_id: string;
  message_id: string;
  message_ts: string | Date;
  payload_text: string;
  edited_timestamp: string | Date | null;
  observed_at: string | Date;
  deleted: boolean;
  deleted_reason: string | null;
  connection_id: string;
}

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

export const discordMessagesExport: ExtraTableExport = {
  table: DISCORD_MESSAGES_TABLE,
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
    const result = await ctx.executor.execute(sql`
      SELECT guild_id, channel_id, message_id, message_ts, payload::text AS payload_text, edited_timestamp, observed_at, deleted, deleted_reason, connection_id
      FROM discord_messages WHERE tenant_id = ${ctx.tenantId} AND id = ${rowKey}
    `);
    const row = ((Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) ?? [])[0] as Row | undefined;
    if (!row) return previousPaths.map((path) => ({ op: "delete" as const, path, deletedAt: journal.enqueuedAt, reason: "message_row_deleted", capturedAt: journal.enqueuedAt }));
    const path = discordMessagePath(row.guild_id, row.channel_id, toDate(row.message_ts), row.message_id);
    const provenance = {
      runtime: "discord bot source lane",
      donor: `${DONOR.repo}@${DONOR.commit}`,
      reference: "askshepherd/gigabrain@5448774e0a121570666adaa0c8ca18570df72be9 brain/src/integrations/discord-personal (semantics only; bot API instead of user tokens)",
      externalId: row.message_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      connectionId: row.connection_id,
    };
    const capturedAt = toDate(row.observed_at).toISOString();
    if (row.deleted) return [{ op: "delete", path, deletedAt: capturedAt, reason: row.deleted_reason ?? "deleted", capturedAt, provenance }];
    const updated = toDate(row.edited_timestamp ?? row.message_ts).toISOString();
    return [{
      op: "put", path, kind: "raw", contentType: "application/json", content: Buffer.from(row.payload_text, "utf8"),
      sourceUpdatedAt: updated, capturedAt, sourceVersion: { ref: `edited:${updated}` }, provenance,
    }];
  },
};

export async function discordCoverage(ctx: ExportContext, now: Date = new Date()): Promise<CoverageReport[]> {
  const executor = ctx.executor as never;
  const conns = await listConnections(ctx.tenantId, executor);
  if (!conns.length) return [{ provider: "discord", scope: "connections", state: "pending", reason: "no Discord bot connection" }];
  const channels = await listChannels(ctx.tenantId, executor);
  const out: CoverageReport[] = [];
  for (const conn of conns) {
    const scope = `bot:${conn.botUserId}`;
    if (conn.status !== "active") {
      out.push({ provider: "discord", scope, state: "blocked", reason: `connection ${conn.status}${conn.statusReason ? `: ${conn.statusReason}` : ""}` });
      continue;
    }
    const contentOk = conn.messageContentIntent === "enabled";
    out.push({
      provider: "discord", scope: `${scope}:content`, state: contentOk ? "complete" : "partial",
      reason: contentOk ? "Message Content intent enabled" : `Message Content intent ${conn.messageContentIntent}: content/embeds/attachments are empty for messages that do not mention the bot`,
    });
    out.push({
      provider: "discord", scope: `${scope}:edits-deletions`, state: "partial",
      reason: `no gateway connection: edits and deletions are detected by rescanning the last ${DISCORD_RECONCILE_DAYS()} days; older deletions are not detected`,
    });
    for (const ch of channels.filter((c) => c.connectionId === conn.id && c.selected)) {
      const chScope = `${scope}:channel:${ch.guildId}/${ch.channelId}`;
      const fresh = ch.lastPollAt != null && now.getTime() - Date.parse(ch.lastPollAt) <= 3 * DISCORD_SYNC_FREQUENCY_SECONDS * 1000;
      let state: CoverageReport["state"];
      if (ch.status === "blocked") state = "blocked";
      else if (ch.backfillCompleteAt && fresh && !ch.lastError && contentOk) state = "complete";
      else if (ch.lastPollAt || ch.newestId) state = "partial";
      else state = "pending";
      out.push({
        provider: "discord", scope: chScope, state,
        reason: state === "complete"
          ? `full message history since the channel's first message; polled ${ch.lastPollAt}`
          : [ch.statusReason, ch.lastError, ch.backfillCompleteAt ? null : "history backfill in progress", fresh ? null : "poll not current", contentOk ? null : "content limited by intent"].filter(Boolean).join("; ") || "not synced yet",
        ...(ch.lastPollAt ? { lastSuccessAt: ch.lastPollAt } : {}),
        ...(ch.lastError ? { lastError: ch.lastError } : {}),
      });
    }
  }
  return out;
}

export const discordProvider: SourceProviderModule = {
  id: "discord",
  eventSources: ["discord"],
  mirrorRoots: [],
  connectionProviders: ["discord"],
  extraTables: [discordMessagesExport],
  coverage: (ctx: ExportContext) => discordCoverage(ctx),
};
