import { finishSyncRun, startSyncRun } from "../db/source-sync-runs.js";
import {
  classifyCredentialFailure,
  handlePermanentCredentialFailure,
  sanitizeCredentialErrorMessage,
} from "../vault/credential-failure.js";

export interface RecordedSourceSyncTaskInput {
  tenantId: string;
  provider: string;
  taskKind: string;
  taskKinds: string[];
  requestedBy?: string;
  coverageFrom?: Date | null;
  metadata?: Record<string, unknown>;
}

export async function runRecordedSourceSyncTask<T>(
  input: RecordedSourceSyncTaskInput,
  run: () => Promise<T>,
): Promise<T> {
  const runId = await startSyncRun({
    userId: input.tenantId,
    provider: input.provider,
    requestedBy: input.requestedBy ?? "task",
    coverageFrom: input.coverageFrom ?? null,
    coverageTo: new Date(),
    metadata: {
      taskKind: input.taskKind,
      ...input.metadata,
    },
  });

  try {
    const output = await run();
    const result = resultRecord(output);
    await finishSyncRun(runId, {
      status: "completed",
      result,
      exhausted: booleanField(result, "exhausted"),
      capHit: booleanField(result, "capHit"),
    });
    return output;
  } catch (err) {
    try {
      if (classifyCredentialFailure(err) === "permanent") {
        await handlePermanentCredentialFailure({
          tenantId: input.tenantId,
          provider: input.provider,
          taskKinds: input.taskKinds,
          error: err,
        });
      }
    } finally {
      await finishSyncRun(runId, {
        status: "failed",
        errorMessage: sanitizeCredentialErrorMessage(err),
      });
    }
    throw err;
  }
}

export function coverageFromDays(days: unknown): Date | null {
  if (typeof days !== "number" || !Number.isFinite(days)) return null;
  return new Date(Date.now() - Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000);
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}
