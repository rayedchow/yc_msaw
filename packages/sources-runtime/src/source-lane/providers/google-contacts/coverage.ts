import { sql } from "drizzle-orm";
import { listGoogleMailboxes } from "../../../integrations/google/mailboxes.js";
import type { CoverageReport, ExportContext } from "../../core/types.js";
import { numericCounts, rosterCoverage } from "../calendar/coverage.js";
import { isoOrNull, listMailboxStatus, positiveIntegerEnv, queryRows } from "../calendar/google-lane.js";
import { CONTACT_ENDPOINTS, type ContactEndpoint } from "./sync.js";

/** google.contacts_sync runs every 6h (donor schedule); a check older than two cycles is lagging. */
export const CONTACTS_MAX_LAG_MS = positiveIntegerEnv("GOOGLE_CONTACTS_COVERAGE_MAX_LAG_SECONDS", 45 * 60) * 1000;

interface CursorRow {
  mailbox: string;
  endpoint: ContactEndpoint;
  sync_token_present: boolean;
  full_sync_started_at: string | null;
  full_sync_pages: number;
  first_full_sync_completed_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  next_attempt_at: string | null;
}

export async function contactsCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const provider = "google-contacts";
  const statuses = await listMailboxStatus(ctx.tenantId, "contacts", ctx.executor);
  const reports: CoverageReport[] = [rosterCoverage(provider, statuses.find((s) => s.mailbox === "*"))];
  const cursors = await queryRows<CursorRow>(sql`
    SELECT mailbox, endpoint, (sync_token IS NOT NULL) AS sync_token_present, full_sync_started_at, full_sync_pages,
           first_full_sync_completed_at, last_success_at, last_error, last_error_code, last_error_at, next_attempt_at
    FROM google_contact_lane_cursors WHERE tenant_id = ${ctx.tenantId}
  `, ctx.executor);
  const counts = await queryRows<{ mailbox: string; endpoint: string; state: string; n: number }>(sql`
    SELECT mailbox, endpoint, state, count(*)::int AS n FROM google_contact_snapshots WHERE tenant_id = ${ctx.tenantId}
    GROUP BY mailbox, endpoint, state
  `, ctx.executor);
  const mailboxes = new Set<string>([
    ...(await listGoogleMailboxes(ctx.tenantId, ctx.executor).catch(() => [] as string[])),
    ...statuses.filter((s) => s.mailbox !== "*").map((s) => s.mailbox),
    ...cursors.map((c) => c.mailbox),
  ]);
  for (const mailbox of [...mailboxes].sort()) {
    const status = statuses.find((s) => s.mailbox === mailbox);
    for (const endpoint of CONTACT_ENDPOINTS) {
      const cursor = cursors.find((c) => c.mailbox === mailbox && c.endpoint === endpoint);
      const stateCounts: Record<string, number> = { ...numericCounts(status?.counts) };
      for (const c of counts) if (c.mailbox === mailbox && c.endpoint === endpoint) stateCounts[c.state] = Number(c.n);
      reports.push(endpointCoverage(provider, mailbox, endpoint, cursor, status?.state === "blocked" || status?.state === "rate_limited" ? status : undefined, stateCounts));
    }
  }
  return reports;
}

function endpointCoverage(
  provider: string,
  mailbox: string,
  endpoint: ContactEndpoint,
  cursor: CursorRow | undefined,
  mailboxProblem: { state: string; reason: string | null; last_error: string | null; last_error_at: string | null; next_attempt_at: string | null } | undefined,
  counts: Record<string, number>,
): CoverageReport {
  const scope = `mailbox:${mailbox}/${endpoint}`;
  const lastSuccessAt = isoOrNull(cursor?.last_success_at);
  const lastErrorAt = isoOrNull(cursor?.last_error_at ?? mailboxProblem?.last_error_at);
  const lastError = cursor?.last_error ?? mailboxProblem?.last_error ?? null;
  const common = {
    provider,
    scope,
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(lastErrorAt ? { lastErrorAt } : {}),
    ...(lastError ? { lastError } : {}),
    counts: { ...counts, fullSyncPagesDone: cursor?.full_sync_pages ?? 0 },
  };
  const failing = Boolean(cursor?.last_error_at && (!cursor.last_success_at || Date.parse(cursor.last_error_at) > Date.parse(cursor.last_success_at)));
  if (mailboxProblem?.state === "rate_limited") return { ...common, state: "partial", reason: `rate limited by Google; next attempt ${isoOrNull(mailboxProblem.next_attempt_at) ?? "soon"}` };
  if (failing && cursor?.last_error_code && /scope|reauth|dwd_not_approved|unauthorized|forbidden|credential|PERMISSION_DENIED/i.test(cursor.last_error_code)) {
    return { ...common, state: "blocked", reason: `credential or access blocked: ${cursor.last_error_code}` };
  }
  if (!cursor) return mailboxProblem ? { ...common, state: "blocked", reason: `credential or access blocked: ${mailboxProblem.reason ?? "unknown"}` } : { ...common, state: "pending", reason: "not synced yet" };
  if (failing) return { ...common, state: "partial", reason: `last sync failed (${cursor.last_error_code ?? "error"}); retrying with backoff` };
  if (!cursor.first_full_sync_completed_at) return { ...common, state: "partial", reason: `initial full listing in progress (resumable; ${cursor.full_sync_pages} pages checkpointed)` };
  if (cursor.full_sync_started_at) return { ...common, state: "partial", reason: "re-listing after a sync-token reset" };
  if (!lastSuccessAt || Date.now() - Date.parse(lastSuccessAt) > CONTACTS_MAX_LAG_MS) return { ...common, state: "partial", reason: `lagging: last check ${lastSuccessAt ?? "never"}` };
  return {
    ...common,
    state: "complete",
    reason: `current ${endpoint === "connections" ? "saved contacts" : "other contacts"} complete for the configured field mask${cursor.sync_token_present ? " (incremental sync token)" : " (full listing each run: no sync token returned)"}; `
      + `revision history only from first capture ${cursor.first_full_sync_completed_at.slice(0, 10)}`,
  };
}
