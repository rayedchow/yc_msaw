import { env } from "../env.js";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { enqueueTask, reapExpiredTasks } from "./queue.js";

/**
 * Schedule sweeper: a 1-minute loop over `task_schedules` that enqueues a
 * task for every due row and advances `due_at`.
 *
 * This replaces per-schedule queue resources (BullMQ repeatables /
 * EventBridge Scheduler objects): 100k+ tenant×connector schedules are just
 * rows, and the sweeper is a single indexed query. Overlap protection comes
 * from the queue itself - each enqueue carries a dedupe key per schedule, so
 * a still-running (or still-queued) previous run suppresses the next one.
 *
 * Claim, enqueue, and due_at advance happen in ONE data-modifying statement,
 * so a crash or insert failure can never advance a schedule without its task
 * existing (they commit or roll back together).
 */

type DbExecutor = Pick<typeof db, "execute">;

export const SWEEP_INTERVAL_MS = 60_000;

/**
 * One sweep pass: claim due schedules (SKIP LOCKED so concurrent sweepers
 * never double-fire), enqueue their tasks, and advance due_at - atomically.
 * Returns the number of tasks actually enqueued (dedupe-suppressed runs,
 * where the previous task is still queued/running, do not count).
 */
export async function sweepDueSchedules(executor: DbExecutor = db): Promise<number> {
  const rows = (await executor.execute(sql`
    WITH due AS (
      SELECT id, tenant_id, queue, group_key, kind, payload, frequency_seconds
      FROM task_schedules
      WHERE enabled = true AND due_at <= now()
      ORDER BY due_at ASC
      LIMIT 500
      FOR UPDATE SKIP LOCKED
    ),
    enqueued AS (
      INSERT INTO task_queue (
        queue, tenant_id, group_key, kind, payload, dedupe_key, run_at,
        priority, prev_run_id
      )
      SELECT
        due.queue,
        due.tenant_id,
        due.group_key,
        due.kind,
        due.payload,
        'schedule:' || due.id,
        now(),
        CASE WHEN due.queue = 'backfill' THEN -10 ELSE 0 END,
        (
          SELECT prev.id FROM task_queue prev
          WHERE prev.group_key = due.group_key
            AND prev.kind = due.kind
            AND prev.state IN ('succeeded', 'failed', 'expired', 'cancelled')
          ORDER BY prev.created_at DESC
          LIMIT 1
        )
      FROM due
      ON CONFLICT DO NOTHING
      RETURNING id
    ),
    advanced AS (
      UPDATE task_schedules s
      SET due_at = now() + make_interval(secs => s.frequency_seconds),
          last_enqueued_at = now(),
          updated_at = now()
      FROM due
      WHERE s.id = due.id
      RETURNING s.id
    )
    SELECT
      (SELECT count(*)::int FROM enqueued) AS enqueued_count,
      (SELECT count(*)::int FROM advanced) AS advanced_count
  `)) as unknown as Array<{ enqueued_count: number | string; advanced_count: number | string }>;

  return Number(rows[0]?.enqueued_count ?? 0);
}

export interface UpsertScheduleInput {
  tenantId: string;
  kind: string;
  frequencySeconds: number;
  queue?: string;
  groupKey?: string;
  payload?: Record<string, unknown>;
  /** First run time; defaults to now (fires on the next sweep). */
  firstRunAt?: Date;
}

/** Create or refresh a recurring schedule for (group_key, kind). */
export async function upsertTaskSchedule(input: UpsertScheduleInput, executor: DbExecutor = db): Promise<void> {
  const groupKey = input.groupKey ?? `${input.tenantId}:${input.kind}`;
  await executor.execute(sql`
    INSERT INTO task_schedules (tenant_id, queue, group_key, kind, payload, frequency_seconds, due_at, enabled)
    VALUES (
      ${input.tenantId},
      ${input.queue ?? "sync"},
      ${groupKey},
      ${input.kind},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.frequencySeconds},
      ${(input.firstRunAt ?? new Date()).toISOString()}::timestamptz,
      true
    )
    ON CONFLICT (group_key, kind) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      queue = EXCLUDED.queue,
      payload = EXCLUDED.payload,
      frequency_seconds = EXCLUDED.frequency_seconds,
      enabled = true,
      updated_at = now()
  `);
}

/** Disable every schedule for a tenant (optionally scoped to one kind). */
export async function disableTaskSchedules(tenantId: string, kind?: string, executor: DbExecutor = db): Promise<void> {
  await executor.execute(sql`
    UPDATE task_schedules
    SET enabled = false, updated_at = now()
    WHERE tenant_id = ${tenantId}
      ${kind ? sql`AND kind = ${kind}` : sql``}
  `);
}

/** Long-running sweeper loop: schedules + the task-expiry reaper. */
export async function runSweeper(signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    try {
      const enqueued = await sweepDueSchedules();
      const reaped = await reapExpiredTasks();
      const rearmed = await rearmStrandedExtractionShards();
      if (enqueued > 0 || reaped > 0 || rearmed > 0) {
        console.log(`sweeper: enqueued=${enqueued} reaped=${reaped} rearmed=${rearmed}`);
      }
    } catch (err) {
      console.error("sweeper pass failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS));
  }
}

/**
 * Self-healing for stranded extraction work: worker restarts and external
 * requeues repeatedly left claimable chunk_extractions with zero active
 * graph.extract_chunks tasks (observed 3x live, 2026-07-11/12 — each needed a
 * manual shard re-arm). When a KB has pending claimable work and no active
 * extract task, enqueue slot-0 shard tasks; the existing per-slot dedupe
 * keys make this idempotent against races.
 */
export async function rearmStrandedExtractionShards(): Promise<number> {
  const kbs = (await db.execute(sql`
    SELECT DISTINCT c.kb_id::text AS kb_id, c.tenant_id
    FROM chunk_extractions ce
    JOIN chunks c ON c.id = ce.chunk_id
    WHERE ce.status = 'pending'
      AND ce.attempts < 5
      AND COALESCE(ce.next_attempt_at, '-infinity'::timestamptz) <= now()
      AND NOT EXISTS (
        SELECT 1 FROM task_queue task
        WHERE task.kind = 'graph.extract_chunks'
          AND task.state = 'running'
          AND task.payload->>'kbId' = c.kb_id::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_queue task
        WHERE task.kind = 'graph.extract_chunks'
          AND task.state = 'queued'
          AND task.run_at <= now() + interval '2 minutes'
          AND task.payload->>'kbId' = c.kb_id::text
      )
    LIMIT 4
  `)) as unknown as Array<{ kb_id: string; tenant_id: string }>;
  let rearmed = 0;
  // A continuation task that scheduled itself for a far-future retry window
  // strands work that became claimable after the scheduling decision (seen
  // live: 32 chunks claimable, tasks parked 100 minutes out). Pull those
  // forward instead of enqueueing duplicates.
  for (const kb of kbs) {
    await db.execute(sql`
      UPDATE task_queue SET run_at = now()
      WHERE kind = 'graph.extract_chunks' AND state = 'queued'
        AND run_at > now() + interval '2 minutes'
        AND payload->>'kbId' = ${kb.kb_id}
    `);
  }
  for (const kb of kbs) {
    for (let shard = 0; shard < env.GRAPH_EXTRACTION_SHARDS; shard += 1) {
      const id = await enqueueTask({
        queue: "sync",
        tenantId: kb.tenant_id,
        groupKey: `graph:${kb.kb_id}:extract:${shard}`,
        kind: "graph.extract_chunks",
        payload: { kbId: kb.kb_id, tenantId: kb.tenant_id, shard, shardCount: env.GRAPH_EXTRACTION_SHARDS, continuationSlot: 0, codeVersion: env.APP_GIT_SHA ?? null },
        dedupeKey: `extract:${kb.kb_id}:${env.GRAPH_EXTRACTION_SHARDS}:${shard}:slot:0`,
      });
      if (id) rearmed += 1;
    }
  }
  return rearmed;
}
