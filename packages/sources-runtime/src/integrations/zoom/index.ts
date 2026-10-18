import type { AqueductIntegration } from "../types.js";
import { connectZoom, disconnectZoom } from "./connect.js";
import { syncZoomLane } from "./poller.js";
import { zoomCallbackRoute } from "./callback.js";
import { enqueueTask } from "../../queue/queue.js";

// Ported from askshepherd/aqueduct c7e1415 src/integrations/zoom/index.ts. SOURCE-LANE PATCH (coordinator):
// the tenant is the queued task's own tenant; runs are bounded and resumable (the backfill re-enqueues itself
// until its durable cursor completes); sync-run bookkeeping comes from the lane's own cursor table. The 5-minute
// zoom.poll run also retries recorded transcript-file failures/processing files (audit M6, poller.ts).
const TASK_KINDS = ["zoom.poll"];
export const zoomIntegration: AqueductIntegration = {
  id: "zoom",
  connect: (input) => connectZoom(input),
  disconnect: (input) => disconnectZoom(input),
  registerHttp(app) {
    app.route("/auth/zoom/callback", zoomCallbackRoute);
  },
  taskKinds() {
    return TASK_KINDS;
  },
  taskHandlers() {
    return {
      "zoom.poll": async (_payload, ctx) => syncZoomLane(ctx.task.tenantId, "poll", 7),
      "zoom.backfill": async (payload, ctx) => {
        const days = typeof payload.days === "number" ? payload.days : 3650;
        const r = await syncZoomLane(ctx.task.tenantId, "backfill", days);
        if (r.status === "running" || r.status === "skipped" || r.status === "rate_limited" || r.status === "error") {
          // Provider-repairs (audit M6): a persisted Retry-After / backoff deadline is honoured by the next run's time.
          const delay = r.status === "running" ? 5_000 : 120_000;
          const runAt = new Date(Math.max(Date.now() + delay, r.retryAt ? Date.parse(r.retryAt) : 0));
          await enqueueTask({ queue: "backfill", tenantId: ctx.task.tenantId, kind: "zoom.backfill", payload: { days }, groupKey: `${ctx.task.tenantId}:zoom`, dedupeKey: `${ctx.task.tenantId}:zoom:backfill:after:${ctx.task.id}`, runAt });
        }
        return r;
      },
    };
  },
};
