import { env } from "../../env.js";
import { startIntegrationRealtime } from "../../integrations/registry.js";
import { runTaskWorker } from "../../queue/queue.js";
import { assertSourceLaneMigrationsApplied } from "../core/boot.js";
import { defaultRegistry } from "../registry.js";
import { SOURCE_LANE_QUEUES, sourceLaneTaskHandlers } from "../worker.js";

/** Source-only queue consumer: donor connector handlers, sync + backfill lanes, no graph. */
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

await assertSourceLaneMigrationsApplied();
const handlers = sourceLaneTaskHandlers(defaultRegistry());
const queues = (env.WORKER_QUEUE_LANES ?? [...SOURCE_LANE_QUEUES]).filter((q) => (SOURCE_LANE_QUEUES as readonly string[]).includes(q));
console.log(`sources-runtime worker: ${Object.keys(handlers).length} task kinds, lanes ${queues.join(",")}`);
startIntegrationRealtime();
await Promise.all(Array.from({ length: env.WORKER_TASK_LOOPS }, () => runTaskWorker({ queues, handlers, signal: abort.signal })));
