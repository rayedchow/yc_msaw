/** Durable state of the Discord bot lane (migration 10100). */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../db/client.js";
import { decrypt, encrypt } from "../../vault/encryption.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import type { DiscordMessage } from "./api.js";

export type Executor = Pick<typeof defaultDb, "execute">;

export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(r) ? r : [];
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------- connections

export interface DiscordConnection {
  id: string;
  tenantId: string;
  botUserId: string;
  botUsername: string | null;
  applicationId: string | null;
  messageContentIntent: "enabled" | "limited" | "disabled" | "unknown";
  status: "active" | "revoked" | "error";
  statusReason: string | null;
  retryAt: string | null;
  createdAt: string;
}

function toConnection(r: Record<string, unknown>): DiscordConnection {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    botUserId: String(r.bot_user_id),
    botUsername: (r.bot_username as string | null) ?? null,
    applicationId: (r.application_id as string | null) ?? null,
    messageContentIntent: r.message_content_intent as DiscordConnection["messageContentIntent"],
    status: r.status as DiscordConnection["status"],
    statusReason: (r.status_reason as string | null) ?? null,
    retryAt: iso(r.retry_at),
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
  };
}

function seal(id: string, tenantId: string, value: string): string {
  return encrypt(JSON.stringify({ c: id, t: tenantId, f: "bot_token", v: value }));
}

function unseal(id: string, tenantId: string, ciphertext: string): string {
  const p = JSON.parse(decrypt(ciphertext)) as { c?: string; t?: string; f?: string; v?: string };
  if (p.c !== id || p.t !== tenantId || p.f !== "bot_token" || typeof p.v !== "string") throw new Error("Discord credential does not belong to this connection");
  return p.v;
}

export const newConnectionId = () => `dc_${randomBytes(12).toString("hex")}`;

export async function insertConnection(
  input: { id: string; tenantId: string; botUserId: string; botUsername: string | null; applicationId: string | null; botToken: string; messageContentIntent: DiscordConnection["messageContentIntent"] },
  executor: Executor = defaultDb,
): Promise<DiscordConnection> {
  const [row] = rows<Record<string, unknown>>(await executor.execute(sql`
    INSERT INTO discord_connections (id, tenant_id, bot_user_id, bot_username, application_id, bot_token_ciphertext, message_content_intent)
    VALUES (${input.id}, ${input.tenantId}, ${input.botUserId}, ${input.botUsername}, ${input.applicationId},
      ${seal(input.id, input.tenantId, input.botToken)}, ${input.messageContentIntent})
    RETURNING *
  `));
  return toConnection(row!);
}

export async function listConnections(tenantId: string, executor: Executor = defaultDb): Promise<DiscordConnection[]> {
  return rows<Record<string, unknown>>(await executor.execute(sql`SELECT * FROM discord_connections WHERE tenant_id = ${tenantId} ORDER BY created_at, id`)).map(toConnection);
}

export async function getConnection(tenantId: string, id: string, executor: Executor = defaultDb): Promise<(DiscordConnection & { botToken: () => string }) | null> {
  const [row] = rows<Record<string, unknown>>(await executor.execute(sql`SELECT * FROM discord_connections WHERE id = ${id} AND tenant_id = ${tenantId}`));
  if (!row) return null;
  const c = toConnection(row);
  return { ...c, botToken: () => unseal(c.id, c.tenantId, String(row.bot_token_ciphertext)) };
}

export async function revokeConnections(tenantId: string, executor: Executor = defaultDb): Promise<number> {
  return rows(await executor.execute(sql`
    UPDATE discord_connections SET status = 'revoked', status_reason = 'disconnected', bot_token_ciphertext = '', revoked_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND status <> 'revoked' RETURNING id
  `)).length;
}

export async function setConnectionState(id: string, update: { status?: "error"; reason?: string; retryAt?: Date | null }, executor: Executor = defaultDb): Promise<void> {
  await executor.execute(sql`
    UPDATE discord_connections SET
      status = COALESCE(${update.status ?? null}, status),
      status_reason = COALESCE(${update.reason ?? null}, status_reason),
      retry_at = ${update.retryAt ? update.retryAt.toISOString() : null}::timestamptz,
      updated_at = now()
    WHERE id = ${id} AND status = 'active'
  `);
}

// ---------------------------------------------------------------- channels (allowlist + cursors)

export interface DiscordChannelState {
  connectionId: string;
  channelId: string;
  tenantId: string;
  guildId: string;
  name: string | null;
  type: number | null;
  selected: boolean;
  status: "active" | "blocked" | "removed";
  statusReason: string | null;
  backfillBefore: string | null;
  backfillCompleteAt: string | null;
  newestId: string | null;
  lastPollAt: string | null;
  lastReconcileAt: string | null;
  retryAt: string | null;
  attempts: number;
  lastError: string | null;
}

function toChannel(r: Record<string, unknown>): DiscordChannelState {
  return {
    connectionId: String(r.connection_id),
    channelId: String(r.channel_id),
    tenantId: String(r.tenant_id),
    guildId: String(r.guild_id),
    name: (r.name as string | null) ?? null,
    type: r.type == null ? null : Number(r.type),
    selected: r.selected === true,
    status: r.status as DiscordChannelState["status"],
    statusReason: (r.status_reason as string | null) ?? null,
    backfillBefore: (r.backfill_before as string | null) ?? null,
    backfillCompleteAt: iso(r.backfill_complete_at),
    newestId: (r.newest_id as string | null) ?? null,
    lastPollAt: iso(r.last_poll_at),
    lastReconcileAt: iso(r.last_reconcile_at),
    retryAt: iso(r.retry_at),
    attempts: Number(r.attempts ?? 0),
    lastError: (r.last_error as string | null) ?? null,
  };
}

export async function listChannels(tenantId: string, executor: Executor = defaultDb): Promise<DiscordChannelState[]> {
  return rows<Record<string, unknown>>(await executor.execute(sql`
    SELECT * FROM discord_channels WHERE tenant_id = ${tenantId} ORDER BY connection_id, guild_id, channel_id
  `)).map(toChannel);
}

/** Replace the connection's allowlist: listed channels selected (created if new), every other channel deselected. */
export async function setSelection(
  tenantId: string,
  connectionId: string,
  channels: Array<{ channelId: string; guildId: string; name: string | null; type: number }>,
  executor: Executor = defaultDb,
): Promise<void> {
  for (const ch of channels) {
    await executor.execute(sql`
      INSERT INTO discord_channels (connection_id, channel_id, tenant_id, guild_id, name, type, selected, status)
      VALUES (${connectionId}, ${ch.channelId}, ${tenantId}, ${ch.guildId}, ${ch.name}, ${ch.type}, true, 'active')
      ON CONFLICT (connection_id, channel_id) DO UPDATE SET selected = true, name = EXCLUDED.name, type = EXCLUDED.type,
        status = CASE WHEN discord_channels.status = 'removed' THEN 'active' ELSE discord_channels.status END, updated_at = now()
    `);
  }
  await executor.execute(sql`
    UPDATE discord_channels SET selected = false, updated_at = now()
    WHERE connection_id = ${connectionId} AND tenant_id = ${tenantId}
      AND channel_id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(channels.map((c) => c.channelId))}::jsonb))
  `);
}

export async function leaseChannel(connectionId: string, channelId: string, owner: string, executor: Executor = defaultDb): Promise<DiscordChannelState | null> {
  const [row] = rows<Record<string, unknown>>(await executor.execute(sql`
    UPDATE discord_channels SET lease_owner = ${owner}, lease_until = now() + interval '10 minutes'
    WHERE connection_id = ${connectionId} AND channel_id = ${channelId} AND selected AND status = 'active'
      AND (lease_until IS NULL OR lease_until < now()) AND (retry_at IS NULL OR retry_at <= now())
    RETURNING *
  `));
  return row ? toChannel(row) : null;
}

export async function saveChannel(
  c: { connectionId: string; channelId: string },
  owner: string,
  u: Partial<Pick<DiscordChannelState, "backfillBefore" | "newestId" | "status" | "statusReason" | "lastError">> & {
    backfillComplete?: boolean; polled?: boolean; reconciled?: boolean; retryAt?: Date | null; attempts?: number; release?: boolean;
  },
  executor: Executor = defaultDb,
): Promise<boolean> {
  const r = rows(await executor.execute(sql`
    UPDATE discord_channels SET
      backfill_before = ${u.backfillBefore === undefined ? sql`backfill_before` : sql`${u.backfillBefore}`},
      newest_id = ${u.newestId === undefined ? sql`newest_id` : sql`${u.newestId}`},
      status = ${u.status ?? sql`status`},
      status_reason = ${u.statusReason === undefined ? sql`status_reason` : sql`${u.statusReason}`},
      last_error = ${u.lastError === undefined ? sql`last_error` : sql`${u.lastError}`},
      backfill_complete_at = CASE WHEN ${u.backfillComplete === true} THEN now() ELSE backfill_complete_at END,
      last_poll_at = CASE WHEN ${u.polled === true} THEN now() ELSE last_poll_at END,
      last_reconcile_at = CASE WHEN ${u.reconciled === true} THEN now() ELSE last_reconcile_at END,
      retry_at = ${u.retryAt === undefined ? sql`retry_at` : sql`${u.retryAt ? u.retryAt.toISOString() : null}::timestamptz`},
      attempts = ${u.attempts ?? sql`attempts`},
      lease_owner = CASE WHEN ${u.release === true} THEN NULL ELSE lease_owner END,
      lease_until = CASE WHEN ${u.release === true} THEN NULL ELSE lease_until END,
      updated_at = now()
    WHERE connection_id = ${c.connectionId} AND channel_id = ${c.channelId} AND lease_owner = ${owner}
    RETURNING channel_id
  `));
  return r.length > 0;
}

// ---------------------------------------------------------------- messages

export const messageKey = (connectionId: string, channelId: string, messageId: string) => `${connectionId}:${channelId}:${messageId}`;

export function redactDiscordPayload<T>(value: T): T {
  // Attachment/CDN URLs are signed and expire (ex/is/hm query); the global rule redacts signed URLs.
  return redactProviderPayload("discord", value) as T;
}

/**
 * Record the observed state of one message. A new or changed state (edit, reactions, embeds) is a new raw
 * version in activity_events (`discord:<channel>:<message>:<sha prefix>`) and updates the current row.
 */
export async function upsertMessage(
  input: { tenantId: string; connectionId: string; guildId: string; message: DiscordMessage },
  executor: Executor = defaultDb,
): Promise<"created" | "updated" | "unchanged"> {
  const payload = redactDiscordPayload(input.message);
  const sha = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const id = messageKey(input.connectionId, input.message.channel_id, input.message.id);
  const [prior] = rows<{ payload_sha256: string; deleted: boolean }>(await executor.execute(sql`SELECT payload_sha256, deleted FROM discord_messages WHERE id = ${id}`));
  if (prior && prior.payload_sha256 === sha && !prior.deleted) return "unchanged";
  await executor.execute(sql`
    INSERT INTO discord_messages (id, tenant_id, connection_id, guild_id, channel_id, message_id, message_ts, payload, payload_sha256, edited_timestamp, observed_at)
    VALUES (${id}, ${input.tenantId}, ${input.connectionId}, ${input.guildId}, ${input.message.channel_id}, ${input.message.id},
      ${input.message.timestamp}::timestamptz, ${JSON.stringify(payload)}::jsonb, ${sha}, ${input.message.edited_timestamp ?? null}::timestamptz, now())
    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, payload_sha256 = EXCLUDED.payload_sha256,
      edited_timestamp = EXCLUDED.edited_timestamp, observed_at = now(), deleted = false, deleted_reason = NULL, updated_at = now()
  `);
  await insertRaw(input.tenantId, input.guildId, input.message.channel_id, input.message.id, `${input.message.id}:${sha.slice(0, 16)}`,
    input.message.edited_timestamp ? "message_edited" : "message", payload, input.message.edited_timestamp ?? input.message.timestamp, "snapshot", executor);
  return prior ? "updated" : "created";
}

/** A message a complete scan no longer returned (deleted at Discord, or purged). */
export async function tombstoneMessage(tenantId: string, connectionId: string, guildId: string, channelId: string, messageId: string, reason: string, executor: Executor = defaultDb): Promise<boolean> {
  const id = messageKey(connectionId, channelId, messageId);
  const r = rows(await executor.execute(sql`
    UPDATE discord_messages SET deleted = true, deleted_reason = ${reason}, observed_at = now(), updated_at = now()
    WHERE id = ${id} AND NOT deleted RETURNING id
  `));
  if (!r.length) return false;
  const at = new Date().toISOString();
  await insertRaw(tenantId, guildId, channelId, messageId, `${messageId}:deleted:${at}`, "message_deleted",
    { id: messageId, channel_id: channelId, guild_id: guildId, _deleted: true, _deleted_at: at, _reason: reason }, at, "tombstone", executor);
  return true;
}

async function insertRaw(tenantId: string, guildId: string, channelId: string, messageId: string, versionKey: string, eventType: string, payload: unknown, at: string, kind: "snapshot" | "tombstone", executor: Executor): Promise<void> {
  await executor.execute(sql`
    INSERT INTO activity_events (user_id, source, event_type, timestamp, source_updated_at, wiki_eligibility_at, raw_payload,
      source_event_id, processing_status, source_namespace, source_object_id, record_kind)
    VALUES (${tenantId}, 'discord', ${eventType}, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz, ${JSON.stringify(payload)}::jsonb,
      ${`discord:${channelId}:${versionKey}`}, 'received', ${`guild:${guildId}`}, ${`channel:${channelId}:message:${messageId}`}, ${kind})
    ON CONFLICT (user_id, source_event_id) DO NOTHING
  `);
}

/** Live (not deleted) stored message ids of a channel within [fromId, toId] (inclusive snowflakes). */
export async function liveMessageIdsBetween(connectionId: string, channelId: string, fromTs: string, executor: Executor = defaultDb): Promise<string[]> {
  return rows<{ message_id: string }>(await executor.execute(sql`
    SELECT message_id FROM discord_messages
    WHERE connection_id = ${connectionId} AND channel_id = ${channelId} AND NOT deleted AND message_ts >= ${fromTs}::timestamptz
  `)).map((r) => r.message_id);
}
