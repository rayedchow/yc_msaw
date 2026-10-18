import type { AqueductIntegration } from "../types.js";
import { connectStripe, disconnectStripe } from "./connect.js";
import { runStripeBackfill, runStripeSync } from "./sync.js";
import { createStripeWebhook } from "./webhook.js";
import { enqueueTask } from "../../queue/queue.js";

/**
 * Stripe (ported from gigabrain 5448774 brain/src/integrations/stripe/index.ts): continuous webhook capture
 * plus scheduled catch-up and object listings. Raw events and snapshots only; no agent tools, no graph work.
 */
export const stripeIntegration: AqueductIntegration = {
  id: "stripe",
  connect: (input) => connectStripe(input),
  disconnect: (input) => disconnectStripe(input),
  registerHttp(app) {
    app.route("/webhooks/stripe", createStripeWebhook());
  },
  taskKinds: () => ["stripe.sync"],
  taskHandlers: () => ({
    // The tenant is the queued task's own tenant (server-side), never a payload field.
    "stripe.sync": async (_payload, ctx) => {
      const tenantId = ctx.task.tenantId;
      const r = await runStripeSync(tenantId);
      return { connections: r.connections, lanes: r.lanes.map((l) => `${l.lane}:${l.status}`) };
    },
    "stripe.backfill": async (_payload, ctx) => {
      const tenantId = ctx.task.tenantId;
      const r = await runStripeBackfill(tenantId);
      if (!r.complete) {
        // Bounded run: continue right away (cursor state is durable); a lane in its retry window waits for it.
        await enqueueTask({ queue: "backfill", tenantId, kind: "stripe.backfill", groupKey: `${tenantId}:stripe`, dedupeKey: `${tenantId}:stripe.backfill:after:${ctx.task.id}`, payload: { tenantId }, runAt: new Date(Date.now() + 5_000) });
      }
      return { connections: r.connections, complete: r.complete, lanes: r.lanes.map((l) => `${l.lane}:${l.status}`) };
    },
  }),
};
