import type { AqueductIntegration } from "../types.js";
import { enqueueTask, type TaskHandlerContext } from "../../queue/queue.js";
import { granolaCallbackRoute } from "../../routes/granola-callback.js";
import { runGranolaBackfill, runGranolaPoll } from "./jobs.js";
import { connectGranola } from "./connect.js";
import { coverageFromDays, runRecordedSourceSyncTask } from "../source-sync-task.js";

const GRANOLA_TASK_KINDS = ["granola.poll"];

export const granolaIntegration: AqueductIntegration = {
  id: "granola",
  connect: connectGranola,
  registerHttp(app) {
    app.route("/auth/granola/callback", granolaCallbackRoute);
  },
  taskKinds() {
    return GRANOLA_TASK_KINDS;
  },
  taskHandlers() {
    return {
      "granola.poll": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        const result = await recordGranolaSourceTask(ctx, tenantId, "granola.poll", () => runGranolaPoll(tenantId));
        if (result.capHit) {
          // A capped run left backlog behind (granolaResume cursor). Follow up
          // immediately instead of waiting for the next 300s schedule tick so
          // a >cap window drains at queue speed; dedupe keeps at most one
          // pending follow-up, and group serialization runs it after this task.
          await enqueueTask({
            queue: "sync",
            tenantId,
            kind: "granola.poll",
            payload: { tenantId },
            groupKey: `${tenantId}:granola`,
            dedupeKey: `${tenantId}:granola:poll:resume`,
          });
        }
        return {
          processed: result.processed,
          failed: result.failed,
          tombstoned: result.tombstoned,
          ...(result.skips ? { skips: result.skips } : {}),
          capHit: result.capHit,
          watermarkAdvancedTo: result.watermarkAdvancedTo,
          deletionSweep: result.deletionSweep ?? null,
        };
      },
      "granola.backfill": async (payload, ctx) => {
        const tenantId = taskTenantId(payload, ctx.task.tenantId);
        const days = typeof payload.days === "number" ? payload.days : null;
        const result = await recordGranolaSourceTask(ctx, tenantId, "granola.backfill", () => runGranolaBackfill(tenantId, {
          days,
        }), coverageFromDays(payload.days));
        const attempt = typeof payload.attempt === "number" && Number.isFinite(payload.attempt)
          ? Math.floor(payload.attempt)
          : 0;
        if (result.failed > 0 && attempt < 2) {
          // Per-note failures during the initial backfill would otherwise be
          // lost for good: the poll watermark (set at connect time) never
          // re-lists notes whose updated_at predates it. Bounded re-run;
          // already-stored notes dedupe on their versioned source_event_id.
          await enqueueTask({
            queue: "backfill",
            tenantId,
            kind: "granola.backfill",
            payload: { tenantId, attempt: attempt + 1, ...(days == null ? {} : { days }) },
            groupKey: `${tenantId}:granola`,
            dedupeKey: `${tenantId}:granola:backfill:retry:${attempt + 1}`,
          });
        }
        return {
          stored: result.stored,
          skipped: result.skipped,
          processed: result.processed,
          failed: result.failed,
          tombstoned: result.tombstoned,
          ...(result.skips ? { skips: result.skips } : {}),
          capHit: result.capHit,
          watermarkAdvancedTo: result.watermarkAdvancedTo,
        };
      },
    };
  },
};

function taskTenantId(payload: Record<string, unknown>, taskTenantId: string): string {
  return String(payload.userId ?? payload.tenantId ?? taskTenantId);
}

function recordGranolaSourceTask<T>(
  ctx: TaskHandlerContext,
  tenantId: string,
  taskKind: string,
  run: () => Promise<T>,
  coverageFrom?: Date | null,
): Promise<T> {
  return runRecordedSourceSyncTask({
    tenantId,
    provider: "granola",
    taskKind,
    taskKinds: GRANOLA_TASK_KINDS,
    coverageFrom,
    metadata: { taskId: ctx.task.id, queue: ctx.task.queue },
  }, run);
}
