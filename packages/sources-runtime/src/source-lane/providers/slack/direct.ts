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
const MAX_CACHE = 20_000;
const cache = new Map<string, { direct: boolean; at: number }>();

export function isDirectConversationType(type: unknown): boolean {
  return typeof type === "string" && DIRECT_TYPES.has(type);
}

/** Whether `channelId` is a DM / group DM for this tenant (conversation metadata, the raw ledger, or a D… id). */
export async function isDirectChannel(ctx: ExportContext, channelId: string): Promise<boolean> {
  if (DM_ID_RE.test(channelId)) return true;
  const key = `${ctx.tenantId}\n${channelId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.direct;
  const res = (await ctx.executor.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM slack_source_conversations
       WHERE tenant_id = ${ctx.tenantId} AND channel_id = ${channelId} AND channel_type IN ('im', 'mpim')
    ) OR EXISTS (
      SELECT 1 FROM activity_events
       WHERE user_id = ${ctx.tenantId} AND source = 'slack'
         AND COALESCE(raw_payload->>'_channel', raw_payload->>'channel') = ${channelId}
         AND raw_payload->>'_channel_type' IN ('im', 'mpim')
    ) AS direct
  `)) as unknown as { rows?: Array<{ direct: boolean }> } | Array<{ direct: boolean }>;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  const direct = rows[0]?.direct === true;
  cache.delete(key);
  cache.set(key, { direct, at: Date.now() });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return direct;
}

export function resetDirectChannelCacheForTests(): void {
  cache.clear();
}

function withheld(path: string, at: string): SourceFileChange {
  return { op: "delete", path, deletedAt: at, reason: DIRECT_MESSAGE_WITHHELD, capturedAt: at, provenance: { provider: PROVIDER, withheld: "direct_message" } };
}

/** Channel id of a donor Slack projection: its meta (window files) or its path (channel-day files). */
function mirrorChannelId(path: string, row: MirrorFileRow): string | null {
  const meta = row.meta as { sourceAcl?: { channelId?: unknown }; externalId?: unknown; staged?: { sourceAcl?: { channelId?: unknown } } } | null;
  const fromAcl = meta?.sourceAcl?.channelId ?? meta?.staged?.sourceAcl?.channelId;
  if (typeof fromAcl === "string" && fromAcl) return fromAcl;
  if (typeof meta?.externalId === "string" && meta.externalId.includes(":")) return meta.externalId.split(":")[0]!;
  const seg = path.split("/");
  return seg.length === 4 && /^[A-Z0-9]{8,}$/.test(seg[2]!) ? seg[2]! : null;
}

const RAW_DIR = { forEventSource: () => ({ id: PROVIDER }) } as unknown as SourceProviderRegistry;

export const mapSlackMirror: NonNullable<SourceProviderModule["mapMirror"]> = async (path, row, ctx, journal) => {
  if (!row || path.startsWith(`sources/${PROVIDER}/_workspaces/`)) return null;
  const channelId = mirrorChannelId(path, row);
  if (channelId && (await isDirectChannel(ctx, channelId))) return [withheld(path, journal.enqueuedAt)];
  return null;
};

export const mapSlackEvent: NonNullable<SourceProviderModule["mapEvent"]> = async (row: ActivityEventRow, ctx: ExportContext, journal: JournalInfo) => {
  const payload = (typeof row.raw_payload === "string" ? JSON.parse(row.raw_payload) : row.raw_payload) as Record<string, unknown> | null;
  const channelId = typeof payload?._channel === "string" ? payload._channel : typeof payload?.channel === "string" ? payload.channel : null;
  const direct = isDirectConversationType(payload?._channel_type) || (channelId !== null && (await isDirectChannel(ctx, channelId)));
  if (!direct) return null;
  return defaultEventChanges(RAW_DIR, row, journal).map((c) => withheld(c.path, journal.enqueuedAt));
};
