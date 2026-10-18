/**
 * Cursor background agents provider (read-only lane in src/integrations/cursor-agents/lane.ts). Current state:
 *
 *   sources/cursor-agents/<connectionId>/<agentId>/agent.json          (exact post-redaction agent object)
 *   sources/cursor-agents/<connectionId>/<agentId>/conversation.json   (full conversation, when fetched)
 *
 * Both are tombstoned when a completed listing no longer returns the agent. Every observed state and every
 * webhook delivery is also kept raw (sources/cursor-agents/_raw/...).
 */
import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourceProviderModule } from "../../core/types.js";
import { CURSOR_BACKGROUND_AGENTS_PROVIDER, CURSOR_SYNC_FREQUENCY_SECONDS, listCursorConnections } from "../../../integrations/cursor-agents/lane.js";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
const seg = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");

export const cursorAgentsExport: ExtraTableExport = {
  table: "cursor_agents_snapshots",
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
    const [r] = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
      SELECT connection_id, agent_id, agent_payload::text AS agent_text, conversation_payload::text AS conversation_text, created_at_provider, observed_at, deleted, deleted_reason
      FROM cursor_agents_snapshots WHERE tenant_id = ${ctx.tenantId} AND id = ${key}
    `));
    if (!r) return prev.map((path) => ({ op: "delete" as const, path, deletedAt: j.enqueuedAt, reason: "snapshot_row_deleted", capturedAt: j.enqueuedAt }));
    const dir = `sources/cursor-agents/${seg(String(r.connection_id))}/${seg(String(r.agent_id))}`;
    const capturedAt = iso(r.observed_at);
    const provenance = { runtime: "cursor-agents source lane (read-only)", port: "askshepherd/gigabrain@9411c1a362fffb7e5a778080d991082810da2510 brain/src/polling/cursor-background-agents.ts", externalId: String(r.agent_id) };
    const paths = [`${dir}/agent.json`, ...(r.conversation_text ? [`${dir}/conversation.json`] : [])];
    if (r.deleted) return paths.map((path) => ({ op: "delete" as const, path, deletedAt: capturedAt, reason: String(r.deleted_reason ?? "deleted"), capturedAt, provenance }));
    const put = (path: string, text: string): SourceFileChange => ({ op: "put", path, kind: "raw", contentType: "application/json", content: Buffer.from(text, "utf8"), sourceUpdatedAt: null, capturedAt, provenance });
    return [put(`${dir}/agent.json`, String(r.agent_text)), ...(r.conversation_text ? [put(`${dir}/conversation.json`, String(r.conversation_text))] : [])];
  },
};

export async function cursorAgentsCoverage(ctx: ExportContext, now = new Date()): Promise<CoverageReport[]> {
  const conns = await listCursorConnections(ctx.tenantId, ctx.executor as never);
  if (!conns.length) return [{ provider: "cursor-agents", scope: "connections", state: "pending", reason: "no Cursor API connection" }];
  const out: CoverageReport[] = [];
  for (const c of conns) {
    const scope = `connection:${c.id}`;
    if (c.status !== "active") {
      out.push({ provider: "cursor-agents", scope, state: "blocked", reason: `connection ${c.status}${c.statusReason ? `: ${c.statusReason}` : ""}` });
      continue;
    }
    const fresh = c.lastCompleteListingAt != null && now.getTime() - Date.parse(c.lastCompleteListingAt) <= 3 * CURSOR_SYNC_FREQUENCY_SECONDS * 1000;
    out.push({
      provider: "cursor-agents", scope: `${scope}:agents`, state: fresh && !c.lastError ? "complete" : c.lastPollAt || c.lastCompleteListingAt ? "partial" : "pending",
      reason: fresh && !c.lastError ? `every agent the API lists, completed ${c.lastCompleteListingAt} (the API's own retention bounds history)` : c.lastError ?? "listing in progress",
      ...(c.lastPollAt ? { lastSuccessAt: c.lastPollAt } : {}),
      ...(c.lastError ? { lastError: c.lastError } : {}),
    });
    const [cnt] = rowsOf<{ stored: number; other: number }>(await ctx.executor.execute(sql`
      SELECT count(*) FILTER (WHERE conversation_state = 'stored')::int AS stored, count(*) FILTER (WHERE conversation_state <> 'stored')::int AS other
      FROM cursor_agents_snapshots WHERE connection_id = ${c.id} AND NOT deleted
    `));
    out.push({
      provider: "cursor-agents", scope: `${scope}:conversations`, state: (cnt?.other ?? 0) > 0 ? "partial" : (cnt?.stored ?? 0) > 0 ? "complete" : "pending",
      reason: (cnt?.other ?? 0) > 0 ? `${cnt!.other} conversation(s) not yet fetched or failed (bounded per run)` : "full conversation stored for every listed agent",
      counts: { stored: cnt?.stored ?? 0, pendingOrFailed: cnt?.other ?? 0 },
    });
  }
  return out;
}

export const cursorAgentsProvider: SourceProviderModule = {
  id: "cursor-agents",
  eventSources: [CURSOR_BACKGROUND_AGENTS_PROVIDER],
  mirrorRoots: [],
  connectionProviders: [CURSOR_BACKGROUND_AGENTS_PROVIDER],
  extraTables: [cursorAgentsExport],
  coverage: (ctx) => cursorAgentsCoverage(ctx),
};
