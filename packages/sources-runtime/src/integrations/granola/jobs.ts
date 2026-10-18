import {
  backfillGranola,
  pollGranola,
  type GranolaBackfillOptions,
  type GranolaIngestOptions,
  type GranolaIngestionResult,
} from "./poller.js";

export async function runGranolaPoll(userId: string, options?: GranolaIngestOptions): Promise<GranolaIngestionResult> {
  const result = await pollGranola(userId, options);
  if (result.stored > 0) {
    console.log(`Granola poll: ${result.stored} note event(s) stored for user ${userId}`);
  }
  if (result.failed > 0) {
    console.warn(`Granola poll: ${result.failed} note fetch(es) failed for user ${userId}`);
  }
  return result;
}

export async function runGranolaBackfill(userId: string, options?: GranolaBackfillOptions): Promise<GranolaIngestionResult> {
  const result = await backfillGranola(userId, options);
  console.log(`Granola backfill: ${result.stored} stored, ${result.skipped} skipped for user ${userId}`);
  return result;
}
