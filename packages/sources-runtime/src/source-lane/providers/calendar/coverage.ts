import { sql } from "drizzle-orm";
import { listGoogleMailboxes } from "../../../integrations/google/mailboxes.js";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { isoOrNull, listMailboxStatus, positiveIntegerEnv, queryRows, type Executor, type MailboxStatusRow } from "./google-lane.js";
import { calendarPushMode } from "./watches.js";

/** A mailbox whose last successful check is older than this is reported partial (lagging). */
export const CALENDAR_MAX_LAG_MS = positiveIntegerEnv("GOOGLE_CALENDAR_COVERAGE_MAX_LAG_SECONDS", 30 * 60) * 1000;

/** Roster scope shared by the calendar and contacts lanes (status row mailbox '*'). */
export function rosterCoverage(provider: string, row: MailboxStatusRow | undefined): CoverageReport {
  if (!row) return { provider, scope: "roster", state: "pending", reason: "no sync has run yet" };
  const base = {
    provider,
    scope: "roster",
    ...(row.reason ? { reason: row.reason } : {}),
    ...(isoOrNull(row.last_success_at) ? { lastSuccessAt: isoOrNull(row.last_success_at)! } : {}),
    ...(isoOrNull(row.last_error_at) ? { lastErrorAt: isoOrNull(row.last_error_at)! } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    counts: numericCounts(row.counts),
  };
  switch (row.state) {
    case "ok":
      return { ...base, state: "complete", reason: "Workspace directory listed; every active user is in the roster" };
    case "blocked":
      return { ...base, state: "blocked" };
    default:
      return { ...base, state: "partial" };
  }
}

interface CursorSummary {
  mailbox: string;
  calendars: number;
  never_full: number;
  full_in_progress: number;
  pages_done: number;
  failing: number;
  over_cap: number;
  not_syncable: number;
  oldest_success: string | null;
  first_capture: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export async function calendarCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const provider = "calendar";
  const statuses = await listMailboxStatus(ctx.tenantId, "calendar", ctx.executor);
  const reports: CoverageReport[] = [rosterCoverage(provider, statuses.find((s) => s.mailbox === "*"))];

  const summaries = new Map((await summarizeCursors(ctx.tenantId, ctx.executor)).map((s) => [s.mailbox, s]));
  const snapshotCounts = new Map((await queryRows<{ mailbox: string; n: number }>(sql`
    SELECT delegated_email AS mailbox, count(*)::int AS n FROM google_calendar_event_snapshots WHERE user_id = ${ctx.tenantId} GROUP BY delegated_email
  `, ctx.executor)).map((r) => [r.mailbox, Number(r.n)]));
  const mailboxes = new Set<string>([
    ...(await listGoogleMailboxes(ctx.tenantId, ctx.executor).catch(() => [] as string[])),
    ...statuses.filter((s) => s.mailbox !== "*").map((s) => s.mailbox),
    ...summaries.keys(),
  ]);

  for (const mailbox of [...mailboxes].sort()) {
    const status = statuses.find((s) => s.mailbox === mailbox);
    reports.push(mailboxCoverage(provider, mailbox, status, summaries.get(mailbox), snapshotCounts.get(mailbox) ?? 0));
  }

  const push = calendarPushMode();
  const [channels] = await queryRows<{ active: number }>(sql`
    SELECT count(*)::int AS active FROM google_calendar_watch_channels
    WHERE user_id = ${ctx.tenantId} AND status = 'active' AND expiration > now()
  `, ctx.executor);
  reports.push(push.enabled
    ? { provider, scope: "push", state: "complete", reason: "push channels renew within 24h of expiry; 60s polling remains the fallback", counts: { activeChannels: Number(channels?.active ?? 0) } }
    : { provider, scope: "push", state: "partial", reason: `${push.reason} (60s calendar.poll)` });
  return reports;
}

function mailboxCoverage(provider: string, mailbox: string, status: MailboxStatusRow | undefined, cursors: CursorSummary | undefined, events: number): CoverageReport {
  const scope = `mailbox:${mailbox}`;
  const lastSuccessAt = isoOrNull(status?.last_success_at);
  const common: Omit<CoverageReport, "state"> = {
    provider,
    scope,
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(isoOrNull(status?.last_error_at ?? cursors?.last_error_at) ? { lastErrorAt: isoOrNull(status?.last_error_at ?? cursors?.last_error_at)! } : {}),
    ...((status?.last_error ?? cursors?.last_error) ? { lastError: (status?.last_error ?? cursors?.last_error)! } : {}),
    counts: {
      calendars: cursors?.calendars ?? 0,
      events,
      fullSyncPending: (cursors?.never_full ?? 0),
      fullSyncPagesDone: cursors?.pages_done ?? 0,
      failingCalendars: cursors?.failing ?? 0,
      overCapCalendars: cursors?.over_cap ?? 0,
      freeBusyOnlyCalendars: cursors?.not_syncable ?? 0,
    },
  };
  if (!status || status.state === "pending") return { ...common, state: "pending", reason: "mailbox not synced yet" };
  if (status.state === "blocked") return { ...common, state: "blocked", reason: `credential or access blocked: ${status.reason ?? status.last_error_code ?? "unknown"}` };
  if (status.state === "rate_limited") return { ...common, state: "partial", reason: `rate limited by Google; next attempt ${isoOrNull(status.next_attempt_at) ?? "soon"}` };
  if (status.state === "error") return { ...common, state: "partial", reason: `last sync failed (${status.last_error_code ?? "error"}); retrying with backoff` };
  if (!cursors || cursors.calendars === 0) return { ...common, state: "partial", reason: "calendar list synced but no readable calendars" };
  if (cursors.never_full > 0) {
    return { ...common, state: "partial", reason: `initial full sync in progress for ${cursors.never_full} of ${cursors.calendars} calendars (resumable; ${cursors.pages_done} pages checkpointed)` };
  }
  if (cursors.failing > 0) return { ...common, state: "partial", reason: `${cursors.failing} calendars failing; retrying with backoff` };
  if (cursors.over_cap > 0) return { ...common, state: "partial", reason: `${cursors.over_cap} calendars beyond the per-mailbox cap are not synced` };
  if (cursors.full_in_progress > 0) return { ...common, state: "partial", reason: `${cursors.full_in_progress} calendars re-listing after a sync-token reset` };
  const oldest = cursors.oldest_success ? Date.parse(cursors.oldest_success) : Number.NaN;
  if (!Number.isFinite(oldest) || Date.now() - oldest > CALENDAR_MAX_LAG_MS) {
    return { ...common, state: "partial", reason: `lagging: oldest calendar check ${cursors.oldest_success ?? "never"}` };
  }
  return {
    ...common,
    state: "complete",
    reason: `current state of ${cursors.calendars} calendars complete (full listing + incremental sync tokens); `
      + `edit history only from first capture ${cursors.first_capture?.slice(0, 10) ?? "unknown"} (Google exposes no earlier revisions)`,
  };
}

async function summarizeCursors(tenantId: string, executor: Executor): Promise<CursorSummary[]> {
  return (await queryRows<CursorSummary>(sql`
    SELECT mailbox,
      count(*) FILTER (WHERE calendar_state = 'active')::int AS calendars,
      count(*) FILTER (WHERE calendar_state = 'active' AND first_full_sync_completed_at IS NULL)::int AS never_full,
      count(*) FILTER (WHERE calendar_state = 'active' AND full_sync_started_at IS NOT NULL)::int AS full_in_progress,
      COALESCE(sum(full_sync_pages) FILTER (WHERE calendar_state = 'active'), 0)::int AS pages_done,
      count(*) FILTER (WHERE calendar_state = 'active' AND last_error_at IS NOT NULL
        AND (last_success_at IS NULL OR last_error_at > last_success_at))::int AS failing,
      count(*) FILTER (WHERE calendar_state = 'over_cap')::int AS over_cap,
      count(*) FILTER (WHERE calendar_state = 'not_syncable')::int AS not_syncable,
      min(last_success_at) FILTER (WHERE calendar_state = 'active') AS oldest_success,
      min(first_full_sync_completed_at) FILTER (WHERE calendar_state = 'active') AS first_capture,
      max(last_error) FILTER (WHERE calendar_state = 'active' AND last_error_at IS NOT NULL) AS last_error,
      max(last_error_at) FILTER (WHERE calendar_state = 'active') AS last_error_at
    FROM google_calendar_lane_cursors
    WHERE tenant_id = ${tenantId} AND resource_type = 'events'
    GROUP BY mailbox
  `, executor)).map((r) => ({ ...r, oldest_success: isoOrNull(r.oldest_success), first_capture: isoOrNull(r.first_capture), last_error_at: isoOrNull(r.last_error_at) }));
}

export function numericCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
