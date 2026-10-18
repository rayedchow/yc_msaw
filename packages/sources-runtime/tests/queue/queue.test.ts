import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

import {
  buildDequeueSql,
  cancelTask,
  dequeueTask,
  enqueueTask,
  failTask,
  heartbeatTask,
  reapExpiredTasks,
  retryBackoffSeconds,
  succeedTask,
  WORKER_QUEUES,
} from "../../src/queue/queue.js";

describe("postgres task queue", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
  });

  describe("enqueue", () => {
    it("keeps every graph/wiki lane consumed by the production worker", () => {
      expect(new Set(WORKER_QUEUES)).toEqual(new Set(["sync", "backfill", "wiki", "graph"]));
    });

    it("inserts a task with defaults and returns its id", async () => {
      executeMock.mockResolvedValueOnce([{ id: "task-1" }]);

      const id = await enqueueTask({
        queue: "sync",
        tenantId: "t1",
        kind: "gmail.poll",
        payload: { userId: "t1" },
      });

      expect(id).toBe("task-1");
      expect(executeMock).toHaveBeenCalledTimes(1);
      const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
      expect(parts).toContain("INSERT INTO task_queue");
      expect(parts).toContain("ON CONFLICT DO NOTHING");
      // denormalized prev-run pointer subquery
      expect(parts).toContain("SELECT id FROM task_queue prev");
      expect(parts).toContain("ORDER BY prev.created_at DESC");
      const params = sqlParams(executeMock.mock.calls[0][0]);
      // default group key tenant:kind
      expect(params).toContain("t1:gmail.poll");
      // default sync priority
      expect(params).toContain(0);
    });

    it("deprioritizes the backfill lane by default", async () => {
      executeMock.mockResolvedValueOnce([{ id: "task-2" }]);
      await enqueueTask({ queue: "backfill", tenantId: "t1", kind: "gmail.backfill" });
      expect(sqlParams(executeMock.mock.calls[0][0])).toContain(-10);
    });

    it("returns null when the dedupe key already has an active task", async () => {
      executeMock.mockResolvedValueOnce([]); // ON CONFLICT DO NOTHING -> no row
      const id = await enqueueTask({
        queue: "sync",
        tenantId: "t1",
        kind: "gmail.poll",
        dedupeKey: "schedule:abc",
      });
      expect(id).toBeNull();
    });
  });

  describe("dequeue SQL (fairness + locking)", () => {
    it("claims with FOR UPDATE SKIP LOCKED and an advisory group lock", () => {
      const parts = sqlParts(buildDequeueSql(["sync", "backfill"])).join(" ");
      expect(parts).toContain("FOR UPDATE OF q SKIP LOCKED");
      expect(parts).toContain("pg_try_advisory_xact_lock(hashtext(q.group_key))");
    });

    it("ranks candidates round-robin across tenants", () => {
      const parts = sqlParts(buildDequeueSql(["sync"])).join(" ");
      expect(parts).toContain("row_number() OVER (");
      expect(parts).toContain("PARTITION BY tenant_id");
      expect(parts).toContain("ORDER BY tenant_rank ASC, priority DESC, run_at ASC");
    });

    it("enforces group max-concurrency 1 via a running-task exclusion", () => {
      const parts = sqlParts(buildDequeueSql(["sync"])).join(" ");
      expect(parts).toContain("NOT EXISTS");
      expect(parts).toContain("running.group_key = task_queue.group_key");
      expect(parts).toContain("running.state = 'running'");
    });

    it("only considers due queued tasks in the requested lanes", () => {
      const statement = buildDequeueSql(["sync", "backfill"]);
      const parts = sqlParts(statement).join(" ");
      expect(parts).toContain("state = 'queued'");
      expect(parts).toContain("run_at <= now()");
      expect(parts).toContain("queue IN (");
      expect(sqlParams(statement)).toEqual(expect.arrayContaining(["sync", "backfill"]));
    });

    it("flips the claimed row to running and bumps the attempt in the same statement", () => {
      const parts = sqlParts(buildDequeueSql(["sync"])).join(" ");
      expect(parts).toContain("SET state = 'running'");
      expect(parts).toContain("attempt = t.attempt + 1");
      expect(parts).toContain("last_heartbeat_at = now()");
    });
  });

  describe("dequeue", () => {
    it("maps the claimed row into a task", async () => {
      executeMock.mockResolvedValueOnce([{
        id: "task-1",
        queue: "sync",
        tenant_id: "t1",
        group_key: "t1:gmail",
        kind: "gmail.poll",
        payload: { userId: "t1" },
        attempt: 1,
        max_attempts: 3,
        priority: 0,
        prev_run_id: "task-0",
      }]);

      const task = await dequeueTask(["sync", "backfill"]);
      expect(task).toEqual({
        id: "task-1",
        queue: "sync",
        tenantId: "t1",
        groupKey: "t1:gmail",
        kind: "gmail.poll",
        payload: { userId: "t1" },
        attempt: 1,
        maxAttempts: 3,
        priority: 0,
        prevRunId: "task-0",
      });
    });

    it("returns null when no task is claimable (empty or all skip-locked)", async () => {
      executeMock.mockResolvedValueOnce([]);
      expect(await dequeueTask(["sync"])).toBeNull();
    });
  });

  describe("lifecycle", () => {
    it("heartbeats only running tasks", async () => {
      await heartbeatTask("task-1");
      const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
      expect(parts).toContain("SET last_heartbeat_at = now()");
      expect(parts).toContain("state = 'running'");
    });

    it("marks success with output", async () => {
      await succeedTask("task-1", { stored: 3 });
      const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
      expect(parts).toContain("state = 'succeeded'");
      expect(sqlParams(executeMock.mock.calls[0][0])).toContain(JSON.stringify({ stored: 3 }));
    });

    it("failTask requeues with backoff until attempts are exhausted", async () => {
      await failTask("task-1", "boom");
      const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
      expect(parts).toContain("CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'queued' END");
      expect(parts).toContain("make_interval");
    });

    it("reaps running tasks whose heartbeat expired", async () => {
      executeMock.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
      const reaped = await reapExpiredTasks();
      expect(reaped).toBe(2);
      const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
      expect(parts).toContain("CASE WHEN attempt >= max_attempts THEN 'expired' ELSE 'queued' END");
      expect(parts).toContain("last_heartbeat_at < now() - make_interval(secs => heartbeat_timeout_seconds)");
    });
  });

  describe("cancellation", () => {
    it("cancels queued or running tasks and reports whether a transition happened", async () => {
      executeMock.mockResolvedValueOnce([{ id: "task-1" }]);
      expect(await cancelTask("task-1", "superseded")).toBe(true);
      const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
      expect(parts).toContain("state = 'cancelled'");
      expect(parts).toContain("finished_at = now()");
      expect(parts).toContain("state IN ('queued', 'running')");
      expect(sqlParams(executeMock.mock.calls[0][0])).toContain("superseded");
    });

    it("returns false for tasks already in a terminal state", async () => {
      executeMock.mockResolvedValueOnce([]);
      expect(await cancelTask("task-done")).toBe(false);
    });

    it("cancelled tasks leave dequeue eligibility (dequeue only claims queued rows)", () => {
      const parts = sqlParts(buildDequeueSql(["sync"])).join(" ");
      expect(parts).toContain("state = 'queued'");
      expect(parts).not.toContain("'cancelled'");
    });

    it("cancelled counts as a terminal run for the prev-run pointer", async () => {
      executeMock.mockResolvedValueOnce([{ id: "task-2" }]);
      await enqueueTask({ queue: "sync", tenantId: "t1", kind: "gmail.poll" });
      const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
      expect(parts).toContain("prev.state IN ('succeeded', 'failed', 'expired', 'cancelled')");
    });

    it("a finished handler cannot overwrite a cancellation (success guards on running)", async () => {
      await succeedTask("task-1", { late: true });
      const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
      expect(parts).toContain("state = 'running'");
    });
  });

  describe("retry backoff", () => {
    it("doubles from 30s and caps at 15 minutes", () => {
      expect(retryBackoffSeconds(1)).toBe(30);
      expect(retryBackoffSeconds(2)).toBe(60);
      expect(retryBackoffSeconds(3)).toBe(120);
      expect(retryBackoffSeconds(10)).toBe(900);
    });
  });
});

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [];
  });
}

function sqlParams(value: any): unknown[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return [chunk]; // inline bind param
    if (Array.isArray(chunk.queryChunks)) return sqlParams(chunk); // nested sql
    if (Array.isArray(chunk.value)) return []; // StringChunk
    if ("value" in chunk) return [chunk.value]; // Param wrapper
    return [];
  });
}
