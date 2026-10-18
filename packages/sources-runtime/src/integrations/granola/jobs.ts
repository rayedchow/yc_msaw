import type { GranolaBackfillOptions, GranolaIngestOptions } from "./poller.js";
// SOURCE-LANE PATCH (granola): the poll/backfill tasks run through the source
// lane (durable inventory checkpoints, cooldowns, retries by id, state for
// coverage); it calls the donor pollGranola/backfillGranola unchanged in shape.
import {
  runGranolaSourceBackfill,
  runGranolaSourcePoll,
  type GranolaLaneBackfillResult,
  type GranolaLanePollResult,
} from "../../source-lane/providers/granola/lane.js";

export async function runGranolaPoll(userId: string, options?: GranolaIngestOptions): Promise<GranolaLanePollResult> {
  const result = await runGranolaSourcePoll(userId, options);
  if (result.stored > 0) {
    console.log(`Granola poll: ${result.stored} note event(s) stored for user ${userId}`);
  }
  if (result.failed > 0) {
    console.warn(`Granola poll: ${result.failed} note fetch(es) failed for user ${userId}`);
  }
  return result;
}

export async function runGranolaBackfill(userId: string, options?: GranolaBackfillOptions & { force?: boolean }): Promise<GranolaLaneBackfillResult> {
  const result = await runGranolaSourceBackfill(userId, options);
  console.log(`Granola backfill: ${result.stored} stored, ${result.skipped} skipped for user ${userId}`);
  return result;
}
