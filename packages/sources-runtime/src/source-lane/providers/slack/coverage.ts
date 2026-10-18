import { sql } from "drizzle-orm";
import {
  isoOrNull,
  listConversations,
  listWorkspaces,
  rowsOf,
  type SlackConversationRow,
  type SlackWorkspaceRow,
} from "../../../integrations/slack/source-store.js";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { PROVIDER } from "./paths.js";

/**
 * Truthful Slack coverage, per workspace the tenant's token was validated against.
 *
 *  workspace:<team>                 blocked when the token is gone/revoked/invalid; partial while
 *                                   conversation discovery never completed, failed or is stale
 *  conversation:<team>/<channel>    complete ONLY when the backward walk reached the start of the
 *                                   channel (unbounded), the conversation is still readable, the last
 *                                   forward pass is within the lag limit and no error is pending;
 *                                   bounded backfills, walks in progress, poll lag, rate-limit
 *                                   deferral and errors are partial; lost access is blocked
 *  threads:<team>                   partial while registered threads were never fetched
 *  files:<team>                     complete only when every observed, non-deleted file has its bytes
 *  edits-deletes:<team>             always partial: realtime (Socket Mode) + a reconcile sweep over the
 *                                   recent window; older edits/deletes made while realtime was down and
 *                                   deleted thread replies are not detected
 */

const DEFAULT_MAX_LAG_MS = 24 * 60 * 60_000;
const DISCOVERY_STALE_MS = 60 * 60_000;
const MAX_CONVERSATION_SCOPES = 1_000;

function maxLagMs(): number {
  const hours = Number(process.env.SLACK_COVERAGE_MAX_LAG_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : DEFAULT_MAX_LAG_MS;
}

function ms(value: unknown): number | null {
  const iso = isoOrNull(value);
  return iso ? Date.parse(iso) : null;
}

function tsIso(ts: string | null): string | null {
  if (!ts) return null;
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
}

function conversationCoverage(ws: SlackWorkspaceRow, c: SlackConversationRow, now: number, rateLimitedUntil: number | null): CoverageReport {
  const scope = `conversation:${c.team_id}/${c.channel_id}`;
  const label = c.channel_name && c.channel_name !== c.channel_id ? ` (${c.channel_type ?? "conversation"} ${c.channel_name})` : "";
  const base: CoverageReport = {
    provider: PROVIDER,
    scope,
    state: "partial",
    ...(c.head_ts ? { cursor: c.head_ts } : {}),
    ...(isoOrNull(c.last_success_at) ? { lastSuccessAt: isoOrNull(c.last_success_at)! } : {}),
    ...(c.last_error ? { lastError: c.last_error, ...(isoOrNull(c.last_error_at) ? { lastErrorAt: isoOrNull(c.last_error_at)! } : {}) } : {}),
    counts: { messagesSeen: Number(c.messages_seen ?? 0), pages: Number(c.pages_done ?? 0) },
  };
  if (ws.auth_state === "blocked") return { ...base, state: "blocked", reason: `workspace token is not usable (${ws.auth_error ?? "auth error"}); captured history kept${label}` };
  if (c.access_state !== "listed") {
    return { ...base, state: "blocked", reason: `${c.access_reason ?? c.access_state}${label}` };
  }
  if (!c.history_started_at) return { ...base, state: "pending", reason: `history walk not started yet${label}` };
  const reasons: string[] = [];
  if (!c.history_complete_at) {
    const back = tsIso(c.tail_ts);
    reasons.push(back ? `history walk in progress: captured back to ${back}` : "history walk in progress");
  } else if (c.history_bound_ts) {
    reasons.push(`bounded backfill: messages before ${tsIso(c.history_bound_ts) ?? c.history_bound_ts} were not requested`);
  }
  const forwardAt = ms(c.last_forward_complete_at);
  if (!c.is_archived && (forwardAt === null || forwardAt < now - maxLagMs())) {
    reasons.push(forwardAt === null
      ? "no completed forward (newest-messages) pass yet; realtime may still be current"
      : `poll lag: last completed forward pass ${new Date(forwardAt).toISOString()}; realtime may still be current`);
  }
  if (c.fwd_started_at) reasons.push("forward pass in progress");
  const errorAt = ms(c.last_error_at);
  const successAt = ms(c.last_success_at);
  if (c.last_error && errorAt !== null && (successAt === null || errorAt >= successAt)) reasons.push(`last request failed: ${c.last_error}`);
  if (rateLimitedUntil !== null && rateLimitedUntil > now) reasons.push(`Slack rate limit: requests deferred until ${new Date(rateLimitedUntil).toISOString()}`);
  if (reasons.length === 0) return { ...base, state: "complete", reason: `complete from channel start; last forward pass ${new Date(forwardAt ?? now).toISOString()}${label}` };
  return { ...base, state: "partial", reason: `${reasons.join("; ")}${label}` };
}

export async function slackCoverage(ctx: ExportContext, now = Date.now()): Promise<CoverageReport[]> {
  const db = ctx.executor;
  const workspaces = await listWorkspaces(db, ctx.tenantId);
  const token = rowsOf(await db.execute(sql`SELECT 1 FROM integration_tokens WHERE user_id = ${ctx.tenantId} AND provider = 'slack' LIMIT 1`)).length > 0;
  const connection = rowsOf<{ status: string; external_account_id: string | null }>(await db.execute(sql`
    SELECT status, external_account_id FROM connections WHERE tenant_id = ${ctx.tenantId} AND provider = 'slack' ORDER BY updated_at DESC LIMIT 1
  `))[0];
  const out: CoverageReport[] = [];
  if (workspaces.length === 0) {
    if (token || (connection && connection.status !== "revoked")) {
      out.push({ provider: PROVIDER, scope: "workspace", state: "pending", reason: "Slack connected; first discovery/poll has not run yet" });
    }
    return out;
  }
  for (const ws of workspaces) {
    const rateLimitedUntil = ms(ws.rate_limited_until);
    const prefix = `workspace:${ws.team_id}`;
    const wsReasons: string[] = [];
    let wsState: CoverageReport["state"] = "complete";
    if (!token) {
      wsState = "blocked";
      wsReasons.push("no Slack token stored (disconnected); captured history kept but not refreshed");
    } else if (ws.auth_state === "blocked") {
      wsState = "blocked";
      wsReasons.push(`Slack rejected the token (${ws.auth_error ?? "auth error"}); reconnect`);
    } else if (connection && connection.external_account_id && connection.external_account_id !== ws.team_id) {
      wsState = "blocked";
      wsReasons.push(`connection now points at workspace ${connection.external_account_id}; this workspace is no longer refreshed`);
    } else {
      const discovered = ms(ws.discovery_complete_at);
      if (discovered === null) {
        wsState = "partial";
        wsReasons.push("conversation discovery has not completed");
      } else if (discovered < now - DISCOVERY_STALE_MS) {
        wsState = "partial";
        wsReasons.push(`conversation list last refreshed ${new Date(discovered).toISOString()}`);
      }
      if (ws.discovery_error && (ms(ws.discovery_error_at) ?? 0) >= (discovered ?? 0)) {
        wsState = "partial";
        wsReasons.push(`last discovery failed: ${ws.discovery_error}`);
      }
      if (rateLimitedUntil !== null && rateLimitedUntil > now) {
        wsState = "partial";
        wsReasons.push(`Slack rate limit (Retry-After): history requests deferred until ${new Date(rateLimitedUntil).toISOString()}`);
      }
    }
    out.push({
      provider: PROVIDER,
      scope: prefix,
      state: wsState,
      reason: wsReasons.length ? wsReasons.join("; ") : `conversation list current (${ws.team_name ?? ws.team_id})`,
      ...(isoOrNull(ws.discovery_complete_at) ? { lastSuccessAt: isoOrNull(ws.discovery_complete_at)! } : {}),
      ...(ws.auth_error ? { lastError: ws.auth_error, ...(isoOrNull(ws.auth_error_at) ? { lastErrorAt: isoOrNull(ws.auth_error_at)! } : {}) } : {}),
    });

    const conversations = await listConversations(db, ctx.tenantId, ws.team_id);
    const reports = conversations.map((c) => conversationCoverage(wsState === "blocked" && ws.auth_state !== "blocked" ? { ...ws, auth_state: "blocked", auth_error: wsReasons[0] ?? null } : ws, c, now, rateLimitedUntil));
    const tally: Record<string, number> = { complete: 0, partial: 0, blocked: 0, pending: 0 };
    for (const r of reports) tally[r.state] = (tally[r.state] ?? 0) + 1;
    // Incomplete scopes first so a capped report never hides them.
    const ordered = [...reports].sort((a, b) => (a.state === "complete" ? 1 : 0) - (b.state === "complete" ? 1 : 0));
    out.push(...ordered.slice(0, MAX_CONVERSATION_SCOPES));
    out.push({
      provider: PROVIDER,
      scope: `${prefix}/conversations`,
      state: conversations.length === 0 ? "pending" : tally.complete === conversations.length ? "complete" : tally.blocked === conversations.length ? "blocked" : "partial",
      reason: conversations.length === 0
        ? "no conversations discovered yet"
        : `${tally.complete}/${conversations.length} conversations captured completely${ordered.length > MAX_CONVERSATION_SCOPES ? `; ${ordered.length - MAX_CONVERSATION_SCOPES} complete conversations omitted from this report` : ""}`,
      counts: tally,
    });

    const threads = rowsOf<{ pending: number; active: number; inactive: number }>(await db.execute(sql`
      SELECT count(*) FILTER (WHERE is_active AND last_polled_at IS NULL)::int AS pending,
             count(*) FILTER (WHERE is_active)::int AS active,
             count(*) FILTER (WHERE NOT is_active)::int AS inactive
      FROM thread_watermarks t
      WHERE t.user_id = ${ctx.tenantId}
        AND EXISTS (SELECT 1 FROM slack_source_conversations c WHERE c.tenant_id = ${ctx.tenantId} AND c.team_id = ${ws.team_id} AND c.channel_id = t.channel_id)
    `))[0] ?? { pending: 0, active: 0, inactive: 0 };
    out.push({
      provider: PROVIDER,
      scope: `threads:${ws.team_id}`,
      state: threads.pending > 0 ? "partial" : "complete",
      reason: threads.pending > 0
        ? `${threads.pending} registered threads have not had their replies fetched yet`
        : "every registered thread was fetched; quiet threads (7 days) are refreshed by realtime replies or reconcile sweeps",
      counts: threads,
      ...(isoOrNull(ws.last_threads_run_at) ? { lastSuccessAt: isoOrNull(ws.last_threads_run_at)! } : {}),
    });

    const files = rowsOf<{ status: string; deleted: boolean; n: number }>(await db.execute(sql`
      SELECT status, deleted_at IS NOT NULL AS deleted, count(*)::int AS n
      FROM slack_source_files WHERE tenant_id = ${ctx.tenantId} AND team_id = ${ws.team_id}
      GROUP BY 1, 2
    `));
    const fileCounts: Record<string, number> = {};
    for (const f of files) fileCounts[f.deleted ? "deleted" : f.status] = (fileCounts[f.deleted ? "deleted" : f.status] ?? 0) + f.n;
    const missing = Object.entries(fileCounts).filter(([s]) => s !== "stored" && s !== "deleted").reduce((sum, [, n]) => sum + n, 0);
    out.push({
      provider: PROVIDER,
      scope: `files:${ws.team_id}`,
      state: missing > 0 ? "partial" : "complete",
      reason: missing > 0
        ? `bytes not captured for ${missing} files (${Object.entries(fileCounts).filter(([s]) => s !== "stored" && s !== "deleted").map(([s, n]) => `${s}: ${n}`).join(", ")}); metadata is exported`
        : "bytes captured for every observed file (deleted files are tombstoned)",
      counts: fileCounts,
    });

    out.push({
      provider: PROVIDER,
      scope: `edits-deletes:${ws.team_id}`,
      state: "partial",
      reason: `edits, deletions and reactions are captured from realtime (Socket Mode) and by a reconcile sweep of the last ${process.env.SLACK_RECONCILE_WINDOW_DAYS ?? "2"} days; older changes made while realtime was down, and deleted thread replies, are not detected`,
    });
  }
  return out;
}
