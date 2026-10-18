import type { AqueductIntegration } from "../types.js";
import type { TaskHandlerContext } from "../../queue/queue.js";
import { notionCallbackRoute } from "../../routes/notion-callback.js";
import { notionWebhookRoute } from "./webhook.js";
import { runNotionBackfill, runNotionPoll, runNotionReconcile, runNotionRenderDirtyPages } from "./jobs.js";
import { connectNotion } from "./connect.js";
import { coverageFromDays, runRecordedSourceSyncTask } from "../source-sync-task.js";

const NOTION_TASK_KINDS = ["notion.poll", "notion.render", "notion.reconcile"];

export const notionIntegration: AqueductIntegration = {
  id: "notion",
  connect: connectNotion,
  registerHttp(app) {
    app.route("/auth/notion/callback", notionCallbackRoute);
    app.route("/webhooks/notion", notionWebhookRoute);
  },
  taskKinds() {
    return NOTION_TASK_KINDS;
  },
  taskHandlers() {
    return {
      "notion.poll": async (payload, ctx) => {
        const tenantId = notionTaskTenantId(payload, ctx.task.tenantId);
        return await recordNotionSourceTask(ctx, tenantId, "notion.poll", () => runNotionPoll(tenantId));
      },
      "notion.backfill": async (payload, ctx) => {
        const tenantId = notionTaskTenantId(payload, ctx.task.tenantId);
        const result = await recordNotionSourceTask(ctx, tenantId, "notion.backfill", () => runNotionBackfill(tenantId, {
          days: typeof payload.days === "number" ? payload.days : null,
          maxPages: typeof payload.maxPages === "number" ? payload.maxPages : null,
        }), coverageFromDays(payload.days));
        return { discovered: result.discovered, markedDirty: result.markedDirty };
      },
      "notion.reconcile": async (payload, ctx) => {
        const tenantId = notionTaskTenantId(payload, ctx.task.tenantId);
        return await recordNotionSourceTask(ctx, tenantId, "notion.reconcile", () => runNotionReconcile(tenantId));
      },
      "notion.render": async (payload, ctx) => {
        const tenantId = notionTaskTenantId(payload, ctx.task.tenantId);
        return await recordNotionSourceTask(ctx, tenantId, "notion.render", () => runNotionRenderDirtyPages(tenantId, {
          limit: typeof payload.limit === "number" ? payload.limit : null,
          heartbeat: ctx.heartbeat,
        }));
      },
    };
  },
};

function notionTaskTenantId(payload: Record<string, unknown>, taskTenantId: string): string {
  return String(payload.userId ?? payload.tenantId ?? taskTenantId);
}

function recordNotionSourceTask<T>(
  ctx: TaskHandlerContext,
  tenantId: string,
  taskKind: string,
  run: () => Promise<T>,
  coverageFrom?: Date | null,
): Promise<T> {
  return runRecordedSourceSyncTask({
    tenantId,
    provider: "notion",
    taskKind,
    taskKinds: NOTION_TASK_KINDS,
    coverageFrom,
    metadata: { taskId: ctx.task.id, queue: ctx.task.queue },
  }, run);
}
