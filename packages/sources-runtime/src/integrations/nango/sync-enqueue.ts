import { startNangoPolling } from "../../queue/dispatch.js";
import { enqueueTask } from "../../queue/queue.js";
import { registeredModelsForProvider, type NangoExecutor } from "./types.js";

export const NANGO_SYNC_RECORDS_TASK = "nango.sync_records";

export interface NangoSyncRecordsPayload {
  tenantId: string;
  provider: string;
  providerConfigKey: string;
  connectionId: string;
  model: string;
  cursor?: string;
}

export interface ActiveNangoConnectionInput {
  tenantId: string;
  provider: string;
  providerConfigKey?: string;
  connectionId: string;
}

export async function activateNangoConnection(
  executor: NangoExecutor,
  input: ActiveNangoConnectionInput,
): Promise<{ models: number; enqueued: number }> {
  await startNangoPolling(input.tenantId, input.provider);
  return enqueueNangoSyncFanout(executor, input);
}

export async function enqueueNangoSyncFanout(
  executor: NangoExecutor,
  input: ActiveNangoConnectionInput,
): Promise<{ models: number; enqueued: number }> {
  const models = registeredModelsForProvider(input.provider);
  let enqueued = 0;
  const providerConfigKey = input.providerConfigKey ?? input.provider;

  for (const model of models) {
    const syncPayload: NangoSyncRecordsPayload & Record<string, unknown> = {
      tenantId: input.tenantId,
      provider: input.provider,
      providerConfigKey,
      connectionId: input.connectionId,
      model,
    };
    const taskId = await enqueueTask({
      queue: "sync",
      tenantId: input.tenantId,
      groupKey: `nango:${input.tenantId}:${input.provider}:${input.connectionId}`,
      kind: NANGO_SYNC_RECORDS_TASK,
      payload: syncPayload,
      dedupeKey: nangoSyncDedupeKey(syncPayload),
    }, executor);
    if (taskId) enqueued += 1;
  }

  return { models: models.length, enqueued };
}

/**
 * Shared by the webhook and polling-floor enqueue paths: identical payloads
 * (both omit an explicit cursor) produce identical keys, so at most one
 * queued/running sync task exists per connection x model.
 */
export function nangoSyncDedupeKey(payload: NangoSyncRecordsPayload): string {
  return [
    "nango",
    "sync_records",
    payload.tenantId,
    payload.providerConfigKey,
    payload.provider,
    payload.connectionId,
    payload.model,
    payload.cursor ?? "start",
  ].join(":");
}
