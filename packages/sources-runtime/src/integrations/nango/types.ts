import type { db } from "../../db/client.js";
import { processGenericNangoRecord } from "./capture.js";

export type NangoRecord = Record<string, unknown>;
export type NangoExecutor = Pick<typeof db, "execute">;

export interface NangoRecordProcessorContext {
  tenantId: string;
  providerConfigKey?: string;
  connectionId?: string;
}

export interface NangoRecordProcessResult {
  stored?: boolean;
  skipped?: boolean;
}

export interface NangoRecordProcessor {
  provider: string;
  model: string;
  process(
    executor: NangoExecutor,
    record: NangoRecord,
    ctx: NangoRecordProcessorContext,
  ): Promise<NangoRecordProcessResult | void>;
}

const processors: NangoRecordProcessor[] = [];

export function registerProcessor(processor: NangoRecordProcessor): void {
  const provider = normalizeKey(processor.provider);
  const model = normalizeKey(processor.model);
  const existing = processors.findIndex((item) =>
    normalizeKey(item.provider) === provider && normalizeKey(item.model) === model
  );
  if (existing >= 0) {
    processors.splice(existing, 1, processor);
  } else {
    processors.push(processor);
  }
}

export function clearProcessorsForTests(): void {
  processors.length = 0;
}

export interface GenericNangoModelRegistration {
  /** Exact Nango sync model name (what the /records API is asked for). */
  model: string;
  /** snake_case activity_events event_type for records of this model. */
  eventType: string;
}

/**
 * Register sync models that have no dedicated renderer: records flow through
 * the generic lossless capture only (raw ledger + outbox). Registration is
 * what puts a model on the polling-floor fan-out list - unregistered models
 * are never pulled from Nango, even when the dashboard sync produces them.
 * Asking /records for a model the environment doesn't know is a safe no-op
 * (HTTP 200, empty page - live-verified), so over-registering never errors.
 */
export function registerGenericNangoModels(provider: string, models: GenericNangoModelRegistration[]): void {
  for (const { model, eventType } of models) {
    registerProcessor({
      provider,
      model,
      process: (executor, record, ctx) => processGenericNangoRecord(executor, {
        tenantId: ctx.tenantId,
        provider,
        model,
        record,
        eventType,
      }),
    });
  }
}

/**
 * Models the scheduled polling floor must sweep for a provider, enumerated
 * from the live processor registry so the floor and the processors cannot
 * drift silently. Providers without registered processors get no floor
 * fan-out (the generic capture path only runs for records we ask Nango for).
 */
export function registeredModelsForProvider(provider: string): string[] {
  const key = normalizeKey(provider);
  return processors
    .filter((processor) => normalizeKey(processor.provider) === key)
    .map((processor) => processor.model);
}

export async function dispatchRecords(
  executor: NangoExecutor,
  input: {
    provider: string;
    model: string;
    records: NangoRecord[];
    ctx: NangoRecordProcessorContext;
    registry?: NangoRecordProcessor[];
  },
): Promise<{ processed: number; skipped: number; matched: number; generic: number }> {
  if (input.records.length === 0) return { processed: 0, skipped: 0, matched: 0, generic: 0 };
  const registry = input.registry ?? processors;
  const processor = registry.find((item) =>
    normalizeKey(item.provider) === normalizeKey(input.provider)
    && normalizeKey(item.model) === normalizeKey(input.model)
  );

  let processed = 0;
  let skipped = 0;
  let matched = 0;
  let generic = 0;
  for (const record of input.records) {
    const result = processor
      ? await processor.process(executor, record, input.ctx)
      : await processGenericNangoRecord(executor, {
        tenantId: input.ctx.tenantId,
        provider: input.provider,
        model: input.model,
        record,
      });
    processed += 1;
    if (processor) matched += 1;
    else generic += 1;
    if (isSkippedResult(result)) skipped += 1;
  }

  console.log(
    `[nango] dispatched ${input.provider}/${input.model}: records=${input.records.length} matched=${matched} generic=${generic} skipped=${skipped}`,
  );
  return { processed, skipped, matched, generic };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function isSkippedResult(result: NangoRecordProcessResult | { stored?: boolean } | void): boolean {
  return result?.stored === false || (result as NangoRecordProcessResult | undefined)?.skipped === true;
}
