import { emitOutboxEvent } from "../outbox/writer.js";
import type { db } from "../db/client.js";
import { enqueueTask } from "./queue.js";
import { upsertTaskSchedule } from "./sweeper.js";

type ScheduleExecutor = Pick<typeof db, "execute">;

/**
 * Connector-facing dispatch API.
 *
 * In the source codebase connectors handed collected events to Shepherd's
 * processing pipeline (BullMQ drain lanes / iii). Here that inversion IS the
 * product: a collected/changed event becomes an outbox row, and the webhook
 * dispatcher tells customers about it. Background work the connectors used to
 * schedule on BullMQ goes through the Postgres task queue instead.
 *
 * The function names intentionally mirror the old call sites to keep the
 * ported connector diff reviewable.
 */

/** Default poll cadences (seconds) per connector kind. */
export const DEFAULT_POLL_FREQUENCY_SECONDS = 60;

/**
 * Gmail history.list deltas are cheap (per-user quota ~250 units/s; a delta
 * poll is a handful of units), so gmail polls faster than the shared default.
 * Deliberately NOT lowering DEFAULT_POLL_FREQUENCY_SECONDS itself: calendar
 * shares it and must not speed up (its cycle fans out per delegated user).
 */
export const GMAIL_POLL_FREQUENCY_SECONDS = 30;

/**
 * Slack realtime (Socket Mode) is the PRIMARY capture path; slack.poll is the
 * backfill/gap-fill safety net, not the freshness path. Shepherd's Slack app
 * is a distributed non-Marketplace app, so conversations.history and
 * conversations.replies are limited to ~1 request/min (see
 * SLACK_HISTORY_RPM in integrations/slack/rate-limit.ts) — a 60s poll would
 * permanently saturate that bucket. 15 min honors the 1/min history limit
 * while still reconciling socket outages within a bounded window.
 */
export const SLACK_POLL_FREQUENCY_SECONDS = 900;

export async function ensureDefaultKbSchedule(
  tenantId: string,
  executor?: ScheduleExecutor,
): Promise<void> {
  await upsertTaskSchedule({
    tenantId,
    kind: "graph.ensure_default_kb",
    frequencySeconds: 900,
    groupKey: `${tenantId}:graph-ensure`,
    payload: { tenantId },
  }, executor);
}

/**
 * A connector collected (or updated) a raw event. Emits a customer-visible
 * outbox event; delivery is the dispatcher's problem.
 */
export async function enqueueCollectedEventForProcessing(
  eventId: string,
  tenantId?: string,
  source?: string,
): Promise<void> {
  await emitOutboxEvent({
    tenantId: tenantId ?? "unknown",
    eventType: "event.collected",
    payload: { eventId, ...(source ? { source } : {}) },
    orderingKey: tenantId && source ? `${tenantId}:${source}` : tenantId,
  });
}

/** Alias kept for ported webhook call sites. */
export async function enqueueEventProcessing(
  eventId: string,
  tenantId?: string,
  source?: string,
): Promise<void> {
  await enqueueCollectedEventForProcessing(eventId, tenantId, source);
}

/**
 * Schedule a one-shot background job on the task queue.
 * Replaces `enqueueCustomerBackendJob(queue, name, data)`.
 */
export async function enqueueBackendJob(
  queue: string,
  kind: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const tenantId = typeof data.userId === "string" ? data.userId : "system";
  await enqueueTask({
    queue: queue === "backfill" ? "backfill" : "sync",
    tenantId,
    kind,
    payload: data,
  });
}

/** Alias kept for ported call sites; tenancy is explicit in the payload. */
export const enqueueCustomerBackendJob = enqueueBackendJob;

// --- Recurring poll schedules -----------------------------------------------

export async function startGooglePolling(tenantId: string): Promise<void> {
  await ensureDefaultKbSchedule(tenantId);
  await upsertTaskSchedule({ tenantId, kind: "gmail.poll", frequencySeconds: GMAIL_POLL_FREQUENCY_SECONDS, groupKey: `${tenantId}:gmail` });
  // Drive changes-cursor polling is one cheap request per cycle against a
  // 12k/100s quota; 60s keeps docs freshness aligned with gmail/calendar.
  await upsertTaskSchedule({ tenantId, kind: "gdocs.poll", frequencySeconds: 60, groupKey: `${tenantId}:gdocs` });
  await upsertTaskSchedule({ tenantId, kind: "gdocs.comment-sweep", frequencySeconds: 60, groupKey: `${tenantId}:gdocs` });
  // Actor repair: backfill identity onto events written while their actor was
  // unresolved (People API hiccup, or identity that resolved later). Cheap -
  // resolution hits the persistent identity cache; unresolvable actors are
  // backoff-limited.
  await upsertTaskSchedule({ tenantId, kind: "gdocs.actor-repair", frequencySeconds: 21_600, groupKey: `${tenantId}:gdocs` });
  // Comment-edit refresh: the Activity API has no comment EDITED signal, so we
  // periodically re-list comments for recently-active docs and update stored
  // event content that drifted. Hourly is well under the comment churn rate.
  await upsertTaskSchedule({ tenantId, kind: "gdocs.comment-refresh", frequencySeconds: 3_600, groupKey: `${tenantId}:gdocs` });
  // Suggestion sync: deterministic suggestion cards (content + placement +
  // author + exact update timestamps) from the OT changelog, for docs the
  // user can edit. Fails soft per doc (writer+-gated, undocumented endpoint);
  // the job logs the changelog-null rate for monitoring. Hourly.
  await upsertTaskSchedule({ tenantId, kind: "gdocs.suggestion-sync", frequencySeconds: 3_600, groupKey: `${tenantId}:gdocs` });
  await upsertTaskSchedule({ tenantId, kind: "calendar.poll", frequencySeconds: DEFAULT_POLL_FREQUENCY_SECONDS, groupKey: `${tenantId}:calendar` });
  // SOURCE-LANE PATCH (calendar-contacts patch request 4): the contacts lane syncs incrementally with People API
  // sync tokens (two cheap requests per mailbox in steady state), so 15 minutes keeps contacts current instead of
  // the donor's 6h full resync.
  await upsertTaskSchedule({ tenantId, kind: "google.contacts_sync", frequencySeconds: 900, groupKey: `${tenantId}:google-contacts` });
}

export async function startNotionPolling(tenantId: string): Promise<void> {
  await ensureDefaultKbSchedule(tenantId);
  await upsertTaskSchedule({
    tenantId,
    kind: "notion.poll",
    frequencySeconds: 60,
    groupKey: `${tenantId}:notion`,
    payload: { tenantId },
  });
  await upsertTaskSchedule({
    tenantId,
    kind: "notion.render",
    frequencySeconds: 60,
    groupKey: `${tenantId}:notion`,
    payload: { tenantId },
  });
  // Unshare reconciliation: known pages vs a full listing, with a direct-fetch
  // 404/403 confirmation before tombstoning (search is eventually consistent).
  // Hourly and on the same group key, so it never races poll/render.
  await upsertTaskSchedule({
    tenantId,
    kind: "notion.reconcile",
    frequencySeconds: 3_600,
    groupKey: `${tenantId}:notion`,
    payload: { tenantId },
  });
}

export async function startGranolaPolling(tenantId: string): Promise<void> {
  await ensureDefaultKbSchedule(tenantId);
  await upsertTaskSchedule({ tenantId, kind: "granola.poll", frequencySeconds: 120, groupKey: `${tenantId}:granola` });
}

/**
 * Nango polling floor: one nango.poll schedule per tenant x provider. The
 * floor is the source of truth for Nango record ingestion - only one lane
 * receives Nango webhooks, so the other lane gets NO data without it; the
 * sync webhook is just an accelerant (dedupe collapses the two enqueue paths).
 */
export async function startNangoPolling(tenantId: string, provider: string): Promise<void> {
  await ensureDefaultKbSchedule(tenantId);
  await upsertTaskSchedule({
    tenantId,
    kind: "nango.poll",
    frequencySeconds: 60,
    groupKey: `${tenantId}:nango:${provider}`,
    payload: { tenantId, provider },
  });
  // GitHub/Bitbucket issues have no Nango sync template, so they're captured
  // via the Nango proxy on their own 300s sweep (same group_key → serialized
  // with the record-sync floor for the connection).
  if (isNangoProxyIssuesProvider(provider)) {
    await upsertTaskSchedule({
      tenantId,
      kind: "nango.proxy_issues",
      frequencySeconds: 300,
      groupKey: `${tenantId}:nango:${provider}`,
      payload: { tenantId, provider },
    });
  }
  // Deep-content proxy sweep: jira full issues + comments; github issue/PR
  // comments (+ repo discovery fallback); bitbucket PR details + comments.
  // Confluence's page sync carries the current body only; its deep sweep is below.
  if (isNangoProxyDetailsProvider(provider)) {
    await upsertTaskSchedule({
      tenantId,
      kind: "nango.proxy_details",
      frequencySeconds: 300,
      groupKey: `${tenantId}:nango:${provider}`,
      payload: { tenantId, provider },
    });
  }
  // SOURCE-LANE PATCH (confluence request 1): REST deep sweep through the Nango proxy
  // (src/source-lane/providers/confluence/sweep.ts): version bodies, comments, attachment
  // bytes, permissions, 404-confirmed deletions. Own group so it never blocks nango.poll.
  if (provider.trim().toLowerCase() === "confluence") {
    await upsertTaskSchedule({
      tenantId,
      kind: "confluence.sweep",
      frequencySeconds: 300,
      groupKey: `${tenantId}:confluence:sweep`,
      payload: { tenantId },
    });
  }
  // SOURCE-LANE PATCH (jira request 1): REST deep sweep through the Nango proxy
  // (src/source-lane/providers/jira/sweep.ts): paged changelogs, comment deletions, attachment
  // bytes, permission-aware tombstones, project selection. Own group so it never blocks nango.poll.
  if (provider.trim().toLowerCase() === "jira") {
    await upsertTaskSchedule({
      tenantId,
      kind: "jira.sweep",
      frequencySeconds: 300,
      groupKey: `${tenantId}:jira:sweep`,
      payload: { tenantId },
    });
  }
  // SOURCE-LANE PATCH (github request 1): repository CONTENT sweep through the Nango proxy
  // (src/source-lane/providers/github/content.ts): Git trees/blobs of selected repositories,
  // per-scan generations, deletes/renames. Own group so it never blocks nango.poll / proxy sweeps.
  if (provider.trim().toLowerCase() === "github") {
    await upsertTaskSchedule({
      tenantId,
      kind: "github.content_sweep",
      frequencySeconds: 300,
      groupKey: `${tenantId}:github:content`,
      payload: { tenantId },
    });
  }
}

function isNangoProxyIssuesProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase().replace(/_/gu, "-");
  return normalized === "github" || normalized === "bitbucket";
}

function isNangoProxyDetailsProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase().replace(/_/gu, "-");
  return normalized === "jira" || normalized === "github" || normalized === "bitbucket";
}

export async function startSlackPolling(tenantId: string): Promise<void> {
  await ensureDefaultKbSchedule(tenantId);
  await upsertTaskSchedule({
    tenantId,
    kind: "slack.discover",
    frequencySeconds: 180,
    groupKey: `${tenantId}:slack`,
    payload: { tenantId },
  });
  await upsertTaskSchedule({
    tenantId,
    kind: "slack.poll",
    frequencySeconds: SLACK_POLL_FREQUENCY_SECONDS,
    groupKey: `${tenantId}:slack`,
    payload: { tenantId },
  });
}
