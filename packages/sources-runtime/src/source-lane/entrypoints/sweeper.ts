import { reapExpiredTasks } from "../../queue/queue.js";
import { SWEEP_INTERVAL_MS, sweepDueSchedules } from "../../queue/sweeper.js";
import { assertSourceLaneMigrationsApplied } from "../core/boot.js";

/**
 * Source-only schedule sweeper: the donor's sweepDueSchedules + reapExpiredTasks.
 * The donor runSweeper also re-arms graph extraction shards; the source lane has none.
 */
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

await assertSourceLaneMigrationsApplied();
console.log("sources-runtime sweeper starting");
while (!abort.signal.aborted) {
  try {
    const enqueued = await sweepDueSchedules();
    const reaped = await reapExpiredTasks();
    if (enqueued || reaped) console.log(`sweeper: enqueued=${enqueued} reaped=${reaped}`);
  } catch (error) {
    console.error("sweeper pass failed:", error instanceof Error ? error.message : error);
  }
  await new Promise((r) => setTimeout(r, SWEEP_INTERVAL_MS));
}
