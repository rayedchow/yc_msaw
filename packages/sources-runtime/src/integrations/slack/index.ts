import type { AqueductIntegration } from "../types.js";
import type { TaskHandler, TaskHandlerContext } from "../../queue/queue.js";
import { slackCallbackRoute } from "../../routes/slack-callback.js";
import { runSlackDiscover, runSlackPoll } from "./jobs.js";
import { connectSlack } from "./connect.js";
import { slackSocketModeEnabled } from "./config.js";
import { startSlackSockets } from "./realtime.js";
import { runRecordedSourceSyncTask } from "../source-sync-task.js";
import { runSlackWindowsTask } from "./windows.js";

const SLACK_TASK_KINDS = ["slack.discover", "slack.poll"];

export const slackIntegration: AqueductIntegration = {
  id: "slack",
  connect: connectSlack,
  registerHttp(app) {
    app.route("/auth/slack/callback", slackCallbackRoute);
  },
  taskKinds() {
    return SLACK_TASK_KINDS;
  },
  taskHandlers(): Record<string, TaskHandler> {
    return {
      "slack.discover": slackDiscoverTaskHandler,
      "slack.poll": slackPollTaskHandler,
      "slack.windows": slackWindowsTaskHandler,
    };
  },
  startRealtime() {
    if (!slackSocketModeEnabled()) return;
    void startSlackSockets();
  },
};

// The tenant is the queue row's server-assigned tenant; a payload naming another tenant is refused.
function slackTaskTenantId(payload: Record<string, unknown>, taskTenantId: string): string {
  const named = payload.userId ?? payload.tenantId;
  if (named !== undefined && String(named) !== taskTenantId) {
    throw new Error("slack task payload tenant does not match the task tenant");
  }
  return taskTenantId;
}

const slackDiscoverTaskHandler: TaskHandler = async (payload, ctx) => {
  const tenantId = slackTaskTenantId(payload, ctx.task.tenantId);
  const result = await recordSlackSourceTask(ctx, tenantId, "slack.discover", () => runSlackDiscover(tenantId));
  return { ...result };
};

const slackPollTaskHandler: TaskHandler = async (payload, ctx) => {
  const tenantId = slackTaskTenantId(payload, ctx.task.tenantId);
  const result = await recordSlackSourceTask(ctx, tenantId, "slack.poll", () => runSlackPoll(tenantId));
  return { ...result };
};

const slackWindowsTaskHandler: TaskHandler = async (payload, ctx) => (
  runSlackWindowsTask(payload, ctx.task.tenantId)
);

function recordSlackSourceTask<T>(
  ctx: TaskHandlerContext,
  tenantId: string,
  taskKind: string,
  run: () => Promise<T>,
): Promise<T> {
  return runRecordedSourceSyncTask({
    tenantId,
    provider: "slack",
    taskKind,
    taskKinds: SLACK_TASK_KINDS,
    metadata: { taskId: ctx.task.id, queue: ctx.task.queue },
  }, run);
}
