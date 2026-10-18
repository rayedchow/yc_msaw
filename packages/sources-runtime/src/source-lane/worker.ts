import { registerAtlassianProcessors } from "../integrations/atlassian/processors.js";
import { registerBitbucketProcessors } from "../integrations/bitbucket/processors.js";
import { registerNangoTasks } from "../integrations/nango/tasks.js";
import { collectIntegrationTaskHandlers } from "../integrations/registry.js";
import { backfillSourceWikiMirror } from "../mirror/backfill.js";
import type { TaskHandler } from "../queue/queue.js";
import type { SourceProviderRegistry } from "./registry.js";

/**
 * Task handlers of the source-only worker: the donor's connector handlers
 * (pollers, Nango record/proxy sweeps, mirror backfill) plus provider-module
 * handlers. Compared with aqueduct src/entrypoints/worker.ts this omits
 * registerGraphTasks entirely (no real or fixture graph/LLM handler exists here)
 * and consumes only the sync and backfill lanes.
 */

export const SOURCE_LANE_QUEUES = ["sync", "backfill"] as const;
const FORBIDDEN_KIND = /^(graph|wiki|chat|answer)\./;

export function assertSourceOnlyHandlers(handlers: Record<string, TaskHandler>): void {
  const bad = Object.keys(handlers).filter((k) => FORBIDDEN_KIND.test(k));
  if (bad.length) throw new Error(`source lane refuses graph/wiki task handlers: ${bad.join(", ")}`);
}

let processorsRegistered = false;

export function sourceLaneTaskHandlers(registry: SourceProviderRegistry): Record<string, TaskHandler> {
  if (!processorsRegistered) {
    registerBitbucketProcessors();
    registerAtlassianProcessors();
    processorsRegistered = true;
  }
  const handlers: Record<string, TaskHandler> = {
    ...collectIntegrationTaskHandlers(),
    ...registerNangoTasks(),
    "mirror.backfill": async (payload) => {
      const result = await backfillSourceWikiMirror({
        userId: String(payload.userId ?? payload.tenantId ?? ""),
        limitPerSource: typeof payload.limitPerSource === "number" ? payload.limitPerSource : null,
      });
      return { indexes: result.indexes };
    },
  };
  for (const m of registry.modules) {
    for (const [kind, handler] of Object.entries(m.taskHandlers?.() ?? {})) {
      if (handlers[kind]) throw new Error(`task kind ${kind} from provider ${m.id} collides with an existing handler`);
      handlers[kind] = handler;
    }
  }
  assertSourceOnlyHandlers(handlers);
  return handlers;
}
