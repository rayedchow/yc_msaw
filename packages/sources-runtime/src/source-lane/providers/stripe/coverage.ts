/**
 * Truthful Stripe coverage, per connection (account + mode), from the durable cursors:
 *
 *  - `…:events`: `complete` only once the 30-day backfill finished and the missed-event poll succeeded
 *    within 3 sync intervals. Even then it is complete only from the backfill window start: Stripe lists
 *    events for 30 days, so older history is not retrievable, and the reason says so.
 *  - `…:webhook`: `partial` until a signing secret is configured (polling only, minutes of lag).
 *  - `…:objects:<resource>`: `complete` only after a full listing within 2 refresh intervals. A permission
 *    gap of a restricted key is `blocked` for that resource only.
 */
import { listConnections, listCursors, type StripeCursor } from "../../../integrations/stripe/store.js";
import { STRIPE_EVENTS_RETENTION_DAYS, STRIPE_SNAPSHOT_REFRESH_SECONDS, STRIPE_SYNC_FREQUENCY_SECONDS, configuredResources } from "../../../integrations/stripe/sync.js";
import type { CoverageReport, ExportContext } from "../../core/types.js";

export async function stripeCoverage(ctx: ExportContext, now: Date = new Date()): Promise<CoverageReport[]> {
  const executor = ctx.executor as never;
  const conns = await listConnections(ctx.tenantId, executor);
  if (!conns.length) return [{ provider: "stripe", scope: "connections", state: "pending", reason: "no Stripe connection" }];
  const cursors = await listCursors(ctx.tenantId, executor);
  const byLane = (connectionId: string, lane: string): StripeCursor | undefined => cursors.find((c) => c.connectionId === connectionId && c.lane === lane);
  const age = (iso: string | null) => (iso ? (now.getTime() - Date.parse(iso)) / 1000 : Number.POSITIVE_INFINITY);
  const reports: CoverageReport[] = [];
  for (const conn of conns) {
    const scope = `account:${conn.accountId}:${conn.livemode ? "live" : "test"}`;
    if (conn.status !== "active") {
      reports.push({ provider: "stripe", scope, state: "blocked", reason: `connection ${conn.status}${conn.statusReason ? `: ${conn.statusReason}` : ""}` });
      continue;
    }
    const backfill = byLane(conn.id, "events:backfill");
    const poll = byLane(conn.id, "events:poll");
    const windowFrom = typeof backfill?.state.windowFrom === "number" ? new Date(backfill.state.windowFrom * 1000).toISOString() : null;
    const pollFresh = age(poll?.lastSuccessAt ?? null) <= 3 * STRIPE_SYNC_FREQUENCY_SECONDS;
    const eventErrors = [backfill, poll].filter((c) => c && (c.status === "error" || c.status === "blocked")).map((c) => `${c!.lane}: ${c!.lastError ?? c!.status}`);
    let eventsState: CoverageReport["state"];
    if ([backfill, poll].some((c) => c?.status === "blocked")) eventsState = "blocked";
    else if (backfill?.status === "complete" && pollFresh) eventsState = "complete";
    else if (backfill || poll) eventsState = "partial";
    else eventsState = "pending";
    reports.push({
      provider: "stripe",
      scope: `${scope}:events`,
      state: eventsState,
      reason: [
        eventsState === "complete"
          ? `all events since ${windowFrom} (Stripe lists events for ${STRIPE_EVENTS_RETENTION_DAYS} days only; earlier history is not retrievable)`
          : backfill?.status === "complete" ? "backfill complete; missed-event poll not current" : `backfill ${backfill?.status ?? "not started"} (window: last ${STRIPE_EVENTS_RETENTION_DAYS} days at most)`,
        ...eventErrors,
      ].join("; "),
      ...(poll?.lastSuccessAt ? { lastSuccessAt: poll.lastSuccessAt } : backfill?.lastSuccessAt ? { lastSuccessAt: backfill.lastSuccessAt } : {}),
      ...(eventErrors.length ? { lastError: eventErrors.join("; ") } : {}),
      counts: { eventsListed: Number(backfill?.state.events ?? 0) },
    });
    reports.push({
      provider: "stripe",
      scope: `${scope}:webhook`,
      state: conn.hasWebhookSecret ? "complete" : "partial",
      reason: conn.hasWebhookSecret
        ? `signed webhook configured; last verified delivery ${conn.lastWebhookAt ?? "none yet"}`
        : "no webhook signing secret configured: events arrive by polling only (up to ~5 minutes late)",
      ...(conn.lastWebhookAt ? { lastSuccessAt: conn.lastWebhookAt } : {}),
    });
    for (const resource of configuredResources()) {
      const c = byLane(conn.id, `objects:${resource}`);
      const lastComplete = typeof c?.state.lastCompleteAt === "number" ? new Date(c.state.lastCompleteAt * 1000).toISOString() : null;
      let state: CoverageReport["state"];
      if (!c) state = "pending";
      else if (c.status === "blocked") state = "blocked";
      else if (lastComplete && age(lastComplete) <= 2 * STRIPE_SNAPSHOT_REFRESH_SECONDS() && c.status !== "error") state = "complete";
      else state = lastComplete || c.status === "running" || c.status === "error" ? "partial" : "pending";
      reports.push({
        provider: "stripe",
        scope: `${scope}:objects:${resource}`,
        state,
        reason: state === "complete"
          ? `full listing completed ${lastComplete}; webhook events keep it current`
          : c?.lastError ?? (c?.status === "running" ? "listing in progress" : "listing not started"),
        ...(c?.lastSuccessAt ? { lastSuccessAt: c.lastSuccessAt } : {}),
        ...(c?.lastError ? { lastError: c.lastError } : {}),
        counts: { objects: Number(c?.state.lastCompleteObjects ?? c?.state.objects ?? 0) },
      });
    }
  }
  return reports;
}
