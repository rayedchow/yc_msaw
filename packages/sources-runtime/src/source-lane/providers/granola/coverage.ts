import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { isoOrNull, loadGranolaState, rowsOf } from "./state.js";

/**
 * Truthful Granola coverage from durable state (granola_source_state, the note
 * catalog, the connection row, integration_tokens and the Retry-After quota):
 *
 *  - `account:<label>` (current state of every note the credential can list):
 *      blocked  - no stored credential, connection not active, or auth failed;
 *      pending  - no inventory pass has finished for the current credential/folder scope;
 *      partial  - inventory finished but: a listing could not be drained (hasMore without
 *                 cursor / cap), notes still failing, the change poll is lagging or failing,
 *                 the deletion sweep is overdue or incomplete, a Retry-After cooldown is
 *                 active, transcripts were not returned for some notes, or transcripts are
 *                 excluded by the connection;
 *      complete - otherwise (deletions are reconciled every 6h, so a deletion may lag that long).
 *  - `account:<label>:history`: always partial. Granola's API returns only the current
 *      note; revisions are what this runtime observed.
 */

export interface GranolaCoverageOptions {
  now?: Date;
  /** Poll lag after which the current-state scope is partial (default 15 min; schedule is 120s). */
  pollLagMs?: number;
  /** Deletion sweep interval of the donor poller (6h); overdue beyond 2x. */
  sweepIntervalMs?: number;
}

function ago(value: string | null, now: number): number {
  return value ? now - Date.parse(value) : Number.POSITIVE_INFINITY;
}

export async function granolaCoverage(ctx: ExportContext, opts: GranolaCoverageOptions = {}): Promise<CoverageReport[]> {
  const now = (opts.now ?? new Date()).getTime();
  const pollLag = opts.pollLagMs ?? 15 * 60_000;
  const sweepEvery = opts.sweepIntervalMs ?? 6 * 3600_000;
  const t = ctx.tenantId;

  const conn = rowsOf<{ status: string }>(await ctx.executor.execute(sql`
    SELECT status FROM connections WHERE tenant_id = ${t} AND provider = 'granola' ORDER BY updated_at DESC LIMIT 1
  `))[0];
  const token = rowsOf<{ n: number }>(await ctx.executor.execute(sql`
    SELECT count(*)::int AS n FROM integration_tokens WHERE user_id = ${t} AND provider = 'granola'
  `))[0];
  const state = await loadGranolaState(ctx.executor, t);
  if (!conn && !state) return [];

  const counts = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
    SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS live_notes,
           count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted_notes,
           count(*) FILTER (WHERE deleted_at IS NULL AND (transcript_included IS NOT TRUE OR COALESCE(transcript_segments, 0) = 0)) AS notes_without_transcript,
           COALESCE(sum(revision_count), 0) AS revisions
      FROM granola_source_notes WHERE tenant_id = ${t}
  `))[0] ?? {};
  const c: Record<string, number> = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v ?? 0)]));
  const failedNotes = Object.keys(state?.failed_notes ?? {}).length;
  const activeCooldown = await activeGranolaCooldown(ctx, now);

  const label = state?.account_label ?? (state?.auth_mode === "oauth_mcp" ? "oauth" : state?.auth_mode === "api_key" ? "api-key" : "granola");
  const scope = `account:${label}${state?.folder_id ? `/folder:${state.folder_id}` : ""}`;
  const allCounts = {
    ...c,
    failed_notes: failedNotes,
    inventory_generation: state?.inventory_generation ?? 0,
    inventory_pages: state?.inventory_pages ?? 0,
    inventory_listed: state?.inventory_listed ?? 0,
  };
  const base = {
    provider: "granola",
    scope,
    ...(state?.poll_watermark ? { cursor: `updated_after ${state.poll_watermark}` } : {}),
    ...(state?.last_poll_ok_at ? { lastSuccessAt: state.last_poll_ok_at } : {}),
    ...(state?.last_poll_error_at ? { lastErrorAt: state.last_poll_error_at, lastError: state.last_poll_error ?? undefined } : {}),
    counts: allCounts,
  };
  const out: CoverageReport[] = [];

  if (!token?.n) {
    out.push({ ...base, state: "blocked", reason: "no Granola credential is stored for this tenant (disconnected or revoked); captured notes are kept" });
  } else if (conn && conn.status !== "active") {
    out.push({ ...base, state: "blocked", reason: `Granola connection is ${conn.status}; captured notes are kept` });
  } else if (state?.blocked_code) {
    out.push({ ...base, state: "blocked", reason: `${state.blocked_code}: ${state.blocked_reason ?? ""}`.trim() });
  } else if (!state || state.inventory_complete_key !== state.inventory_key) {
    const progress = state?.inventory_phase === "running"
      ? `inventory pass ${state.inventory_generation} running (${state.inventory_pages} page(s), ${state.inventory_listed} note(s) listed)`
      : state?.inventory_phase === "complete"
        ? `inventory pass ${state.inventory_generation} listed ${state.inventory_listed} note(s) but is not complete (${state.inventory_listing_complete ? `${failedNotes} note(s) still failing` : "the listing could not be drained"})`
        : "no inventory pass has finished for the current credential and folder scope";
    out.push({ ...base, state: "pending", reason: progress });
  } else {
    const gaps: string[] = [];
    if (state.listing_truncated_at) gaps.push("the note listing reported more pages without a cursor (MCP list tool without cursor support); notes beyond the first page are not reachable");
    if (failedNotes) gaps.push(`${failedNotes} note(s) failed to fetch and are retried by id`);
    if (ago(state.last_poll_ok_at, now) > pollLag) gaps.push(`change poll lagging (last clean poll ${state.last_poll_ok_at ?? "never"})`);
    if (state.last_poll_error_at && (!state.last_poll_ok_at || state.last_poll_error_at > state.last_poll_ok_at)) gaps.push(`last poll failed: ${state.last_poll_error ?? "unknown error"}`);
    const sweep = state.last_sweep as { listingIncomplete?: boolean; confirmFailed?: number } | null;
    const sweepRef = state.last_sweep_at ?? state.inventory_complete_at;
    if (ago(sweepRef, now) > 2 * sweepEvery) gaps.push(`deletion sweep overdue (last ${state.last_sweep_at ?? "never"})`);
    if (sweep?.listingIncomplete) gaps.push("last deletion sweep listing was truncated at 200 pages");
    if (sweep?.confirmFailed) gaps.push(`${sweep.confirmFailed} possible deletion(s) could not be confirmed`);
    if (activeCooldown) gaps.push(`rate limited by Granola until ${activeCooldown} (Retry-After)`);
    if (state.include_transcript === false) gaps.push("transcripts are excluded by the connection (includeTranscript=false)");
    else if (c.notes_without_transcript) gaps.push(`${c.notes_without_transcript} live note(s) have no transcript from Granola (not returned, forbidden or empty)`);
    out.push(gaps.length
      ? { ...base, state: "partial", reason: gaps.join("; ") }
      : {
        ...base,
        state: "complete",
        reason: `every note the credential lists${state.folder_id ? ` in folder ${state.folder_id}` : ""} is captured at its latest observed revision with summary and transcript; deletions are reconciled every 6h (last ${state.last_sweep_at ?? "baseline"})`,
      });
  }

  out.push({
    provider: "granola",
    scope: `${scope}:history`,
    state: "partial",
    reason: "Granola's API returns only a note's current state: revisions are the states observed by 120s polls (plus transcript re-checks); edits between observations collapse and notes edited before connection have only their state at the first capture",
    ...(state?.last_poll_ok_at ? { lastSuccessAt: state.last_poll_ok_at } : {}),
    counts: { revisions: c.revisions ?? 0, deleted_notes: c.deleted_notes ?? 0 },
  });
  return out;
}

/** Cooldown on any Granola quota key this tenant's runs touched (keys are credential fingerprints). */
async function activeGranolaCooldown(ctx: ExportContext, now: number): Promise<string | null> {
  const row = rowsOf<{ until: unknown }>(await ctx.executor.execute(sql`
    SELECT max(q.blocked_until) AS until FROM granola_source_quota q
     WHERE q.blocked_until > ${new Date(now).toISOString()}::timestamptz
       AND q.quota_key = (SELECT s.quota_key FROM granola_source_state s WHERE s.tenant_id = ${ctx.tenantId})
  `))[0];
  return isoOrNull(row?.until);
}
