import type { AqueductIntegration } from "../types.js";
import type { TaskHandlerContext } from "../../queue/queue.js";
import { googleCallbackRoute } from "../../routes/google-callback.js";
import { googleCalendarWebhook } from "./calendar/webhook.js";
import { runGmailBackfill, runGmailPoll } from "../gmail/jobs.js";
import { GoogleRateLimitError } from "../../vault/google-rate-limit.js";
import { enqueueTask } from "../../queue/queue.js";
import { runGdocsActorRepair, runGdocsBackfill, runGdocsCommentRefresh, runGdocsCommentSweep, runGdocsContentSnapshot, runGdocsDiscovery, runGdocsPoll, runGdocsSuggestionSync } from "./gdocs/jobs.js";
import { runGoogleCalendarDelta, runGoogleCalendarSetup } from "./calendar/jobs.js";
import { runGoogleContactsSync } from "./contacts/jobs.js";
import { connectGoogleWorkspace, disconnectAllGoogleAccounts } from "./connect.js";
import { coverageFromDays, runRecordedSourceSyncTask } from "../source-sync-task.js";

const GOOGLE_TASK_KINDS = [
  "gmail.poll",
  "calendar.poll",
  "google.contacts_sync",
  "gdocs.poll",
  "gdocs.comment-sweep",
  "gdocs.actor-repair",
  "gdocs.comment-refresh",
  "gdocs.suggestion-sync",
  "gdocs.content-snapshot",
  "gdocs.account-snapshot",
];

export const googleIntegration: AqueductIntegration = {
  id: "google",
  connect: connectGoogleWorkspace,
  // SOURCE-LANE PATCH (google-auth patch request 5): tenant disconnect revokes every OAuth/Composio grant.
  disconnect: disconnectAllGoogleAccounts,
  registerHttp(app) {
    // Legacy per-user callback path answers 410; the server-bound OAuth flow lives in
    // source-lane/providers/google-auth (/auth/google/oauth/*, /auth/google/composio/*).
    app.route("/auth/google/callback", googleCallbackRoute);
    app.route("/webhooks/google/calendar", googleCalendarWebhook);
  },
  taskKinds() {
    return GOOGLE_TASK_KINDS;
  },
  taskHandlers() {
    return {
      "gmail.poll": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await recordGoogleSourceTask(ctx, tenantId, "gmail.poll", () => runGmailPoll(tenantId));
      },
      "gmail.backfill": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        try {
          // SOURCE-LANE PATCH (gmail patch request 2): a run is a resumable slice of a full-mailbox capture,
          // not a days-bounded window; truthful completeness is the provider's mailbox:<email> coverage.
          const result = await recordGoogleSourceTask(ctx, tenantId, "gmail.backfill", () => runGmailBackfill(tenantId, {
            ...(typeof payload.mailbox === "string" && payload.mailbox ? { mailbox: payload.mailbox } : {}),
          }), null);
          return { scanned: result.scanned, stored: result.stored, attachments: result.attachments };
        } catch (error) {
          // A gmail 429 puts the whole service in a process-wide cooldown, so
          // immediate task retries fail instantly and burn max_attempts
          // (observed live: two mailbox backfills dead after 3 retries inside
          // one 60s cooldown). Reschedule at Google's own retry-after instead
          // of failing through; stored messages dedupe, so re-scans converge.
          if (error instanceof GoogleRateLimitError) {
            const reschedules = typeof payload.rateLimitReschedules === "number" ? payload.rateLimitReschedules : 0;
            if (reschedules < 40) {
              // Exponential: sustained quota windows outlive Google's own
              // retry-after hint (observed: 20 reschedules at exactly 120s
              // burned in 40min against a hot window). 2m -> 4m -> 8m ...
              // capped at 1h; a 365-day initial backfill can afford patience.
              // The cap bounds only that backoff: a longer Retry-After is still the floor.
              const delaySeconds = Math.max(error.retryAfterSeconds, Math.min(3_600, Math.max(error.retryAfterSeconds, 120) * 2 ** Math.min(reschedules, 5)));
              await enqueueTask({
                queue: "backfill",
                tenantId,
                kind: "gmail.backfill",
                groupKey: `${tenantId}:gmail`,
                payload: { ...payload, rateLimitReschedules: reschedules + 1 },
                dedupeKey: `${tenantId}:google:gmail.backfill:resume:${payload.mailbox ?? "all"}:${reschedules + 1}`,
                runAt: new Date(Date.now() + delaySeconds * 1000),
              });
              return { deferred: true, retryAfterSeconds: delaySeconds, reschedules: reschedules + 1 };
            }
          }
          throw error;
        }
      },
      "gdocs.poll": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await recordGoogleSourceTask(ctx, tenantId, "gdocs.poll", () => runGdocsPoll(tenantId));
      },
      "gdocs.backfill": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await deferAtGoogleFloor(ctx, tenantId, payload, async () => {
          const result = await recordGoogleSourceTask(ctx, tenantId, "gdocs.backfill", () => runGdocsBackfill(
            tenantId,
            typeof payload.days === "number" ? payload.days : null,
          ), coverageFromDays(payload.days));
          return { stored: result.stored };
        });
      },
      "gdocs.discovery": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await deferAtGoogleFloor(ctx, tenantId, payload, async () => {
          const result = await recordGoogleSourceTask(ctx, tenantId, "gdocs.discovery", () => runGdocsDiscovery(tenantId, {
            folderIds: Array.isArray(payload.folderIds) ? payload.folderIds.map(String) : undefined,
            query: typeof payload.query === "string" ? payload.query : undefined,
            driveIds: payload.driveIds === "all"
              ? "all"
              : Array.isArray(payload.driveIds) ? payload.driveIds.map(String) : undefined,
            days: typeof payload.days === "number" ? payload.days : null,
          }), coverageFromDays(payload.days));
          return {
            tracked: result.tracked,
            filesSeen: result.filesSeen,
            snapshotsEnqueued: result.snapshotsEnqueued,
            foldersTruncated: result.foldersTruncated,
            lineageFailures: result.lineageFailures,
          };
        });
      },
      "gdocs.comment-sweep": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await recordGoogleSourceTask(ctx, tenantId, "gdocs.comment-sweep", () => runGdocsCommentSweep(tenantId));
      },
      "gdocs.actor-repair": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await recordGoogleSourceTask(ctx, tenantId, "gdocs.actor-repair", () => runGdocsActorRepair(tenantId));
      },
      "gdocs.comment-refresh": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await recordGoogleSourceTask(ctx, tenantId, "gdocs.comment-refresh", () => runGdocsCommentRefresh(tenantId));
      },
      "gdocs.suggestion-sync": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        const docIds = Array.isArray(payload.docIds) ? payload.docIds.map(String) : undefined;
        return await recordGoogleSourceTask(ctx, tenantId, "gdocs.suggestion-sync", () => runGdocsSuggestionSync(tenantId, docIds));
      },
      "gdocs.content-snapshot": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        const docId = typeof payload.docId === "string" ? payload.docId : "";
        if (!docId) return { status: "skipped_invalid" };
        return await deferAtGoogleFloor(ctx, tenantId, payload, () => recordGoogleSourceTask(ctx, tenantId, "gdocs.content-snapshot", () => runGdocsContentSnapshot(tenantId, docId, {
          modifiedTime: payloadString(payload.modifiedTime),
          authorEmail: payloadString(payload.authorEmail),
          authorName: payloadString(payload.authorName),
          updatedByEmail: payloadString(payload.updatedByEmail),
          updatedByName: payloadString(payload.updatedByName),
        })));
      },
      // SOURCE-LANE PATCH (google-viewer-content, google-native-views): current view of a Doc, Sheet, Slides deck, Drive
      // file or PDF a mailbox may only read or comment on (and the comments Google returns to it), under its own credential.
      "gdocs.account-snapshot": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        const docId = typeof payload.docId === "string" ? payload.docId : "";
        const mailbox = typeof payload.mailbox === "string" ? payload.mailbox : "";
        if (!docId || !mailbox) return { status: "skipped_invalid" };
        return await recordGoogleSourceTask(ctx, tenantId, "gdocs.account-snapshot", async () => {
          const { captureAccountView } = await import("../../source-lane/providers/google-docs/account-capture.js");
          const r = await captureAccountView({ tenantId, docId, mailbox });
          return { status: r.state, reason: r.reason, apiCalls: r.apiCalls, imageFetches: r.imageFetches };
        });
      },
      "calendar.poll": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        // SOURCE-LANE PATCH (calendar-contacts patch request 2): a webhook ping targets its channel's calendar.
        return await recordGoogleSourceTask(ctx, tenantId, "calendar.poll", () => runGoogleCalendarDelta(tenantId, {
          channelId: typeof payload.channelId === "string" && payload.channelId ? payload.channelId : null,
        }));
      },
      "calendar.setup": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await recordGoogleSourceTask(ctx, tenantId, "calendar.setup", () => runGoogleCalendarSetup(tenantId, {
          forceFull: payload.forceFull === true,
        }));
      },
      "google.contacts_sync": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        return await recordGoogleSourceTask(ctx, tenantId, "google.contacts_sync", () => runGoogleContactsSync(tenantId, {
          delegatedEmails: Array.isArray(payload.delegatedEmails) ? payload.delegatedEmails.map(String) : null,
          forceFull: payload.forceFull === true,
        }));
      },
    };
  },
};

function taskTenantId(payload: Record<string, unknown>, taskTenantId: string): string {
  return String(payload.userId ?? payload.tenantId ?? taskTenantId);
}

function payloadString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

// SOURCE-LANE PATCH (legacy Docs durable floor): a one-shot Docs task (content snapshot, discovery, backfill) that meets
// Google's Retry-After floor is re-enqueued at the floor instead of failing through its attempts inside it (as
// gmail.backfill does); the run itself is still recorded as failed. Scheduled tasks just fail and refire.
async function deferAtGoogleFloor<T>(
  ctx: TaskHandlerContext,
  tenantId: string,
  payload: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T | { deferred: true; retryAfterSeconds: number; reschedules: number }> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof GoogleRateLimitError)) throw error;
    const reschedules = typeof payload.rateLimitReschedules === "number" ? payload.rateLimitReschedules : 0;
    if (reschedules >= 40) throw error;
    const target = typeof payload.docId === "string" && payload.docId ? payload.docId : "all";
    await enqueueTask({
      queue: ctx.task.queue,
      tenantId: ctx.task.tenantId,
      kind: ctx.task.kind,
      groupKey: ctx.task.groupKey,
      payload: { ...payload, rateLimitReschedules: reschedules + 1 },
      dedupeKey: `${tenantId}:google:${ctx.task.kind}:rate-limit:${target}:${ctx.task.id}`,
      runAt: new Date(Date.now() + error.retryAfterSeconds * 1000),
      priority: ctx.task.priority,
    });
    return { deferred: true, retryAfterSeconds: error.retryAfterSeconds, reschedules: reschedules + 1 };
  }
}

function recordGoogleSourceTask<T>(
  ctx: TaskHandlerContext,
  tenantId: string,
  taskKind: string,
  run: () => Promise<T>,
  coverageFrom?: Date | null,
): Promise<T> {
  return runRecordedSourceSyncTask({
    tenantId,
    provider: "google",
    taskKind,
    taskKinds: GOOGLE_TASK_KINDS,
    coverageFrom,
    metadata: { taskId: ctx.task.id, queue: ctx.task.queue },
  }, run);
}
