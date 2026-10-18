import { sql } from "drizzle-orm";
import { db } from "./client.js";

type DbExecutor = Pick<typeof db, "execute">;

export type SourceSyncRunTerminalStatus = "completed" | "blocked" | "failed";

export interface StartSyncRunInput {
  userId: string;
  provider: string;
  requestedBy?: string;
  coverageTo: Date;
  coverageFrom?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface FinishSyncRunInput {
  status: SourceSyncRunTerminalStatus;
  result?: Record<string, unknown>;
  exhausted?: boolean;
  capHit?: boolean;
  errorMessage?: string | null;
}

export async function startSyncRun(input: StartSyncRunInput, executor: DbExecutor = db): Promise<string> {
  const rows = (await executor.execute(sql`
    INSERT INTO source_sync_runs (
      user_id, provider, status, phase, requested_by, coverage_from, coverage_to,
      metadata, started_at
    )
    VALUES (
      ${input.userId},
      ${input.provider},
      'running',
      'running',
      ${input.requestedBy ?? "api"},
      ${input.coverageFrom ? sql`${input.coverageFrom.toISOString()}::timestamptz` : sql`NULL`},
      ${input.coverageTo.toISOString()}::timestamptz,
      ${JSON.stringify(input.metadata ?? {})}::jsonb,
      now()
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  const id = rows[0]?.id;
  if (!id) throw new Error("source_sync_runs insert did not return an id");
  return id;
}

export async function finishSyncRun(
  id: string,
  input: FinishSyncRunInput,
  executor: DbExecutor = db,
): Promise<void> {
  if (!isTerminalStatus(input.status)) {
    throw new Error(`Invalid source_sync_runs terminal status: ${String(input.status)}`);
  }

  await executor.execute(sql`
    UPDATE source_sync_runs
    SET status = ${input.status},
        phase = ${input.status},
        result = result || ${JSON.stringify(input.result ?? {})}::jsonb,
        exhausted = ${input.exhausted === undefined ? sql`exhausted` : sql`${input.exhausted}`},
        cap_hit = ${input.capHit === undefined ? sql`cap_hit` : sql`${input.capHit}`},
        completed_at = ${input.status === "completed" ? sql`now()` : sql`completed_at`},
        failed_at = ${input.status === "completed" ? sql`failed_at` : sql`now()`},
        error_message = ${input.errorMessage === undefined ? sql`error_message` : sql`${input.errorMessage}`},
        updated_at = now()
    WHERE id = ${id}::uuid
  `);
}

function isTerminalStatus(status: string): status is SourceSyncRunTerminalStatus {
  return status === "completed" || status === "blocked" || status === "failed";
}
