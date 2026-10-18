import { sql } from "drizzle-orm";
import type { ActivityEventRow, ExportContext, JournalInfo, MirrorFileRow, SourceFileChange, SourceProviderModule } from "../../core/types.js";
import { defaultEventChanges } from "../../export/mapping.js";
import type { SourceProviderRegistry } from "../../registry.js";
import { PROVIDER } from "./paths.js";

/**
 * Slack direct messages (im) and group DMs (mpim) never reach $SOURCES.
 *
 * yc_msaw serves personal sources to their owner only (yc_msaw src/sources/access.ts). A Slack conversation's
 * participants are Slack users, not verified yc_msaw principals, so there is no owner to serve a DM to; and the donor
 * thread/session directories (`<name>-channel-<hash>`) do not show the conversation id. So DM content is withheld at
 * export: its projections, raw records, conversation labels and the files shared only in DMs are published as
 * deletes (reason `slack_direct_message_withheld`). It stays in the runtime database; channels are unaffected.
 */
export const DIRECT_MESSAGE_WITHHELD = "slack_direct_message_withheld";
const DIRECT_TYPES = new Set(["im", "mpim"]);
const DM_ID_RE = /^D[A-Z0-9]{6,}$/;
const CACHE_TTL_MS = 10 * 60_000;
/** A "not a DM" answer is re-checked sooner: conversation metadata can arrive after the first messages. */
const NEGATIVE_TTL_MS = 60_000;
const MAX_CACHE = 20_000;
const cache = new Map<string, { direct: boolean; at: number }>();
/** Conversations of unknown type already checked in one export pass (keyed by the pass's context object). */
const unknownInPass = new WeakMap<ExportContext, Set<string>>();

export function isDirectConversationType(type: unknown): boolean {
  return typeof type === "string" && DIRECT_TYPES.has(type);
}

/** Whether `channelId` is a DM / group DM for this tenant (conversation metadata, the raw ledger, or a D… id). */
export async function isDirectChannel(ctx: ExportContext, channelId: string): Promise<boolean> {
  if (DM_ID_RE.test(channelId)) return true;
  const key = `${ctx.tenantId}\n${channelId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.direct ? CACHE_TTL_MS : NEGATIVE_TTL_MS)) return hit.direct;
  // A conversation without metadata is not cached across passes (it may turn out to be a DM), but within one export
  // pass its answer is reused: one query per conversation, not per row (perf-verification-2 O1). markDirectChannel
  // during the pass still wins, because the cache above is checked first.
  const unknown = unknownInPass.get(ctx);
  if (unknown?.has(channelId)) return false;
  const res = (await ctx.executor.execute(sql`
    SELECT (EXISTS (
      SELECT 1 FROM slack_source_conversations
       WHERE tenant_id = ${ctx.tenantId} AND channel_id = ${channelId} AND channel_type IN ('im', 'mpim')
    ) OR EXISTS (
      SELECT 1 FROM activity_events
       WHERE user_id = ${ctx.tenantId} AND source = 'slack'
         AND COALESCE(raw_payload->>'_channel', raw_payload->>'channel') = ${channelId}
         AND COALESCE(raw_payload->>'_channel_type', raw_payload->>'channel_type') IN ('im', 'mpim')
    )) AS direct,
    EXISTS (
      SELECT 1 FROM slack_source_conversations
       WHERE tenant_id = ${ctx.tenantId} AND channel_id = ${channelId} AND channel_type IS NOT NULL AND channel_type NOT IN ('im', 'mpim')
    ) AS known_channel
  `)) as unknown as { rows?: Array<{ direct: boolean; known_channel: boolean }> } | Array<{ direct: boolean; known_channel: boolean }>;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  const direct = rows[0]?.direct === true;
  // A "not a DM" answer is cached only when the conversation's own metadata says so; otherwise it is re-asked.
  if (direct || rows[0]?.known_channel === true) {
    cache.delete(key);
    cache.set(key, { direct, at: Date.now() });
  } else if (unknown) unknown.add(channelId);
  else unknownInPass.set(ctx, new Set([channelId]));
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return direct;
}

/** Record that a conversation is a DM (its metadata arrived): later exports withhold it without asking again. */
export function markDirectChannel(tenantId: string, channelId: string): void {
  const key = `${tenantId}\n${channelId}`;
  cache.delete(key);
  cache.set(key, { direct: true, at: Date.now() });
}

export function resetDirectChannelCacheForTests(): void {
  cache.clear();
}

function withheld(path: string, at: string): SourceFileChange {
  return { op: "delete", path, deletedAt: at, reason: DIRECT_MESSAGE_WITHHELD, capturedAt: at, provenance: { provider: PROVIDER, withheld: "direct_message" } };
}

/** First value of `key` in a (shallow) nested meta object. */
function findKey(value: unknown, key: string, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  const rec = value as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Channel id of a donor Slack projection: its meta (window files) or its path (channel-day files). */
export function mirrorChannelId(path: string, row: MirrorFileRow): string | null {
  const acl = findKey(row.meta, "sourceAcl");
  const fromAcl = acl && typeof acl === "object" ? (acl as Record<string, unknown>).channelId : undefined;
  if (typeof fromAcl === "string" && fromAcl) return fromAcl;
  const externalId = findKey(row.meta, "externalId");
  if (typeof externalId === "string" && externalId.includes(":")) return externalId.split(":")[0]!;
  const seg = path.split("/");
  return seg.length === 4 && /^[A-Z0-9]{8,}$/.test(seg[2]!) ? seg[2]! : null;
}

const RAW_DIR = { forEventSource: () => ({ id: PROVIDER }) } as unknown as SourceProviderRegistry;

export const mapSlackMirror: NonNullable<SourceProviderModule["mapMirror"]> = async (path, row, ctx, journal) => {
  if (!row || path.startsWith(`sources/${PROVIDER}/_workspaces/`)) return null;
  const channelId = mirrorChannelId(path, row);
  // A projection whose conversation cannot be determined could be a DM: withheld (fail closed).
  if (!channelId || (await isDirectChannel(ctx, channelId))) return [withheld(path, journal.enqueuedAt)];
  return null;
};

/**
 * Donor projections of a conversation that turned out to be a DM after they were exported (its metadata arrived
 * late): withheld when the conversation row is exported.
 */
export async function withheldProjectionsOf(ctx: ExportContext, channelId: string, at: string): Promise<SourceFileChange[]> {
  const res = (await ctx.executor.execute(sql`
    SELECT path, meta FROM mirror_files
    WHERE user_id = ${ctx.tenantId} AND path LIKE ${`sources/${PROVIDER}/%`} AND path NOT LIKE ${`sources/${PROVIDER}/\_workspaces/%`}
      AND (meta::text LIKE ${`%${channelId}%`} OR path LIKE ${`sources/${PROVIDER}/${channelId}/%`})
  `)) as unknown as { rows?: Array<{ path: string; meta: unknown }> } | Array<{ path: string; meta: unknown }>;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows
    .filter((r) => mirrorChannelId(r.path, { meta: r.meta } as MirrorFileRow) === channelId)
    .map((r) => withheld(r.path, at));
}

export const mapSlackEvent: NonNullable<SourceProviderModule["mapEvent"]> = async (row: ActivityEventRow, ctx: ExportContext, journal: JournalInfo) => {
  const payload = (typeof row.raw_payload === "string" ? JSON.parse(row.raw_payload) : row.raw_payload) as Record<string, unknown> | null;
  const channelId = typeof payload?._channel === "string" ? payload._channel : typeof payload?.channel === "string" ? payload.channel : null;
  const direct = isDirectConversationType(payload?._channel_type) || (channelId !== null && (await isDirectChannel(ctx, channelId)));
  if (!direct) return null;
  return defaultEventChanges(RAW_DIR, row, journal).map((c) => withheld(c.path, journal.enqueuedAt));
};
