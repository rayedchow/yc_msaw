import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * Nango-style Postgres task queue.
 *
 * One table (`task_queue`), claimed with `FOR UPDATE SKIP LOCKED`. Design
 * points (see docs/aws-architecture.md):
 *
 * - **Group serialization**: `group_key` (usually `tenant:connector`) runs at
 *   most one task concurrently. Enforced by a NOT EXISTS check on running
 *   rows plus a transaction-scoped advisory lock that closes the race between
 *   two workers claiming different queued tasks in the same group.
 * - **Fairness in SQL**: candidates are ranked round-robin across tenants
 *   (`row_number() OVER (PARTITION BY tenant_id ...)`), so a tenant with a
 *   500k-file backlog cannot starve everyone else. The backfill lane sorts
 *   after sync work for the same tenant rank.
 * - **Heartbeats + reaper**: running tasks must heartbeat; the reaper requeues
 *   or expires tasks whose heartbeat went stale (worker died mid-run).
 * - **Denormalized prev-run pointer**: each task records the previous
 *   terminal run for its (group_key, kind), so "what happened last sync" is
 *   one indexed lookup, not a scan.
 * - **run_at + dedupe_key**: delayed execution and at-most-one active task
 *   per idempotency key (partial unique index on queued/running).
 */

export const WORKER_QUEUES = ["sync", "backfill", "wiki", "graph"] as const;

export type WorkerQueueName = typeof WORKER_QUEUES[number];
export type QueueName = WorkerQueueName | "outbox" | (string & {});

export type TaskState = "queued" | "running" | "succeeded" | "failed" | "expired" | "cancelled";

export interface EnqueueTaskInput {
  queue: QueueName;
  tenantId: string;
  /** Serialization group; defaults to `tenantId:kind`. */
  groupKey?: string;
  /** Handler name registered on the worker. */
  kind: string;
  payload?: Record<string, unknown>;
  /** Earliest execution time; defaults to now. */
  runAt?: Date;
  /** Higher runs earlier within a tenant's rank. Backfill work should stay <= -10. */
  priority?: number;
  /** At most one queued/running task per dedupe key; duplicate enqueues no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
  heartbeatTimeoutSeconds?: number;
}

export interface ClaimedTask {
  id: string;
  queue: string;
  tenantId: string;
  groupKey: string;
  kind: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  priority: number;
  prevRunId: string | null;
}

type DbExecutor = Pick<typeof db, "execute">;

/** How many due candidates to rank per dequeue round-trip. */
const DEQUEUE_CANDIDATE_WINDOW = 64;

/** Exponential retry backoff with a deterministic cap: 30s, 60s, 120s, ... 15m. */
export function retryBackoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 900);
}

/**
 * Insert a task. Returns the new task id, or null when a dedupe key already
 * has an active (queued/running) task.
 */
export async function enqueueTask(input: EnqueueTaskInput, executor: DbExecutor = db): Promise<string | null> {
  const groupKey = input.groupKey ?? `${input.tenantId}:${input.kind}`;
  const rows = (await executor.execute(sql`
    INSERT INTO task_queue (
      queue, tenant_id, group_key, kind, payload, dedupe_key, run_at, priority,
      max_attempts, heartbeat_timeout_seconds, prev_run_id
    )
    VALUES (
      ${input.queue},
      ${input.tenantId},
      ${groupKey},
      ${input.kind},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.dedupeKey ?? null},
      ${(input.runAt ?? new Date()).toISOString()}::timestamptz,
      ${input.priority ?? (input.queue === "backfill" ? -10 : 0)},
      ${input.maxAttempts ?? 3},
      ${input.heartbeatTimeoutSeconds ?? 120},
      (
        SELECT id FROM task_queue prev
        WHERE prev.group_key = ${groupKey}
          AND prev.kind = ${input.kind}
          AND prev.state IN ('succeeded', 'failed', 'expired', 'cancelled')
        ORDER BY prev.created_at DESC
        LIMIT 1
      )
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * The dequeue statement, exported for unit-testing the fairness ordering.
 *
 * Shape: rank due candidates round-robin across tenants, excluding groups
 * that already have a running task; lock the best claimable row with
 * `FOR UPDATE SKIP LOCKED` (+ a transaction-scoped advisory lock per group);
 * flip it to running in the same statement.
 */
export function buildDequeueSql(queues: readonly string[]): SQL {
  return sql`
    WITH candidates AS (
      SELECT
        id,
        group_key,
        row_number() OVER (
          PARTITION BY tenant_id
          ORDER BY priority DESC, run_at ASC, created_at ASC
        ) AS tenant_rank,
        priority,
        run_at,
        created_at
      FROM task_queue
      WHERE state = 'queued'
        AND run_at <= now()
        AND queue IN (${sql.join(queues.map((queue) => sql`${queue}`), sql`, `)})
        AND NOT EXISTS (
          SELECT 1 FROM task_queue running
          WHERE running.group_key = task_queue.group_key
            AND running.state = 'running'
        )
      ORDER BY tenant_rank ASC, priority DESC, run_at ASC, created_at ASC
      LIMIT ${sql.raw(String(DEQUEUE_CANDIDATE_WINDOW))}
    ),
    claimed AS (
      SELECT q.id
      FROM task_queue q
      JOIN candidates c ON c.id = q.id
      WHERE q.state = 'queued'
        AND pg_try_advisory_xact_lock(hashtext(q.group_key))
      ORDER BY c.tenant_rank ASC, c.priority DESC, c.run_at ASC, c.created_at ASC
      FOR UPDATE OF q SKIP LOCKED
      LIMIT 1
    )
    UPDATE task_queue t
    SET state = 'running',
        started_at = now(),
        last_heartbeat_at = now(),
        attempt = t.attempt + 1
    FROM claimed
    WHERE t.id = claimed.id
    RETURNING
      t.id, t.queue, t.tenant_id, t.group_key, t.kind, t.payload,
      t.attempt, t.max_attempts, t.priority, t.prev_run_id
  `;
}

/** Claim the next runnable task from the given queue lanes, or null. */
export async function dequeueTask(queues: readonly string[], executor: DbExecutor = db): Promise<ClaimedTask | null> {
  const rows = (await executor.execute(buildDequeueSql(queues))) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    queue: String(row.queue),
    tenantId: String(row.tenant_id),
    groupKey: String(row.group_key),
    kind: String(row.kind),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    priority: Number(row.priority),
    prevRunId: row.prev_run_id ? String(row.prev_run_id) : null,
  };
}

/** Refresh a running task's heartbeat. Long handlers call this periodically. */
export async function heartbeatTask(taskId: string, executor: DbExecutor = db): Promise<void> {
  await executor.execute(sql`
    UPDATE task_queue
    SET last_heartbeat_at = now()
    WHERE id = ${taskId}::uuid AND state = 'running'
  `);
}

export async function succeedTask(
  taskId: string,
  output?: Record<string, unknown>,
  executor: DbExecutor = db,
): Promise<void> {
  await executor.execute(sql`
    UPDATE task_queue
    SET state = 'succeeded',
        finished_at = now(),
        output = ${output ? sql`${JSON.stringify(output)}::jsonb` : sql`NULL`}
    WHERE id = ${taskId}::uuid AND state = 'running'
  `);
}

/**
 * Record a failed attempt: requeue with exponential backoff while attempts
 * remain, otherwise mark the task failed.
 */
export async function failTask(taskId: string, errorMessage: string, executor: DbExecutor = db): Promise<void> {
  await executor.execute(sql`
    UPDATE task_queue
    SET state = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'queued' END,
        finished_at = CASE WHEN attempt >= max_attempts THEN now() ELSE NULL END,
        run_at = CASE
          WHEN attempt >= max_attempts THEN run_at
          ELSE now() + make_interval(secs => LEAST(30 * power(2, GREATEST(attempt - 1, 0)), 900))
        END,
        error_message = ${errorMessage.slice(0, 2000)}
    WHERE id = ${taskId}::uuid AND state = 'running'
  `);
}

/**
 * Cancel a task. Queued tasks are cancelled immediately; running tasks are
 * marked cancelled so their in-flight handler's success/failure update
 * no-ops (those updates guard on state = 'running'). Cancelled is a terminal
 * state and participates in the prev-run pointer like any other outcome.
 * Returns true when a task was actually transitioned.
 */
export async function cancelTask(taskId: string, reason = "cancelled", executor: DbExecutor = db): Promise<boolean> {
  const rows = (await executor.execute(sql`
    UPDATE task_queue
    SET state = 'cancelled',
        finished_at = now(),
        error_message = ${reason.slice(0, 2000)}
    WHERE id = ${taskId}::uuid AND state IN ('queued', 'running')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Expiry reaper: tasks whose heartbeat went stale are either requeued (when
 * attempts remain) or marked expired. Run periodically from the sweeper loop.
 */
export async function reapExpiredTasks(executor: DbExecutor = db): Promise<number> {
  const rows = (await executor.execute(sql`
    UPDATE task_queue
    SET state = CASE WHEN attempt >= max_attempts THEN 'expired' ELSE 'queued' END,
        finished_at = CASE WHEN attempt >= max_attempts THEN now() ELSE NULL END,
        run_at = CASE WHEN attempt >= max_attempts THEN run_at ELSE now() END,
        error_message = 'heartbeat expired'
    WHERE state = 'running'
      AND last_heartbeat_at < now() - make_interval(secs => heartbeat_timeout_seconds)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length;
}

export interface TaskHandlerContext {
  task: ClaimedTask;
  /** Extend the heartbeat lease; call inside long-running handlers. */
  heartbeat: () => Promise<void>;
}

export type TaskHandler = (payload: Record<string, unknown>, ctx: TaskHandlerContext) => Promise<Record<string, unknown> | void>;

export interface RunWorkerOptions {
  queues: readonly string[];
  handlers: Record<string, TaskHandler>;
  /** Poll interval when the queue is empty. */
  idleDelayMs?: number;
  /** Automatic heartbeat interval while a handler runs. */
  heartbeatIntervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Simple single-slot consumer loop: claim -> run handler -> succeed/fail.
 * Run several processes (or several loops) for parallelism; group_key keeps
 * per-connection work serialized regardless of worker count.
 */
export async function runTaskWorker(options: RunWorkerOptions): Promise<void> {
  const idleDelayMs = options.idleDelayMs ?? 2_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;

  while (!options.signal?.aborted) {
    let task: ClaimedTask | null = null;
    try {
      task = await dequeueTask(options.queues);
    } catch (err) {
      console.error("task dequeue failed:", err instanceof Error ? err.message : err);
    }

    if (!task) {
      await sleep(idleDelayMs, options.signal);
      continue;
    }

    const handler = options.handlers[task.kind];
    if (!handler) {
      await failTask(task.id, `no handler registered for kind "${task.kind}"`);
      continue;
    }

    const heartbeatTimer = setInterval(() => {
      void heartbeatTask(task.id).catch(() => undefined);
    }, heartbeatIntervalMs);

    try {
      const output = await handler(task.payload, {
        task,
        heartbeat: () => heartbeatTask(task.id),
      });
      await succeedTask(task.id, output ?? undefined);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`task ${task.kind} (${task.id}) failed:`, message);
      await failTask(task.id, message);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
