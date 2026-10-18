import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

const enqueueTaskMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/queue/queue.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueTask: enqueueTaskMock,
}));

import { rearmStrandedExtractionShards, sweepDueSchedules, upsertTaskSchedule } from "../../src/queue/sweeper.js";

describe("schedule sweeper", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
  });

  it("claims, enqueues, and advances due_at in a single atomic statement", async () => {
    executeMock.mockResolvedValueOnce([{ enqueued_count: 0, advanced_count: 0 }]);

    await sweepDueSchedules();

    expect(executeMock).toHaveBeenCalledTimes(1);
    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("FOR UPDATE SKIP LOCKED");
    expect(parts).toContain("due_at <= now()");
    // enqueue + advance live in the same data-modifying CTE statement, so a
    // failed insert can never advance the schedule on its own
    expect(parts).toContain("INSERT INTO task_queue");
    expect(parts).toContain("ON CONFLICT DO NOTHING");
    expect(parts).toContain("'schedule:' || due.id");
    expect(parts).toContain("due_at = now() + make_interval(secs => s.frequency_seconds)");
    expect(parts).toContain("SELECT prev.id FROM task_queue prev");
  });

  it("reports how many tasks were actually enqueued", async () => {
    executeMock.mockResolvedValueOnce([{ enqueued_count: 3, advanced_count: 5 }]);
    expect(await sweepDueSchedules()).toBe(3);
  });

  it("counts dedupe-suppressed runs as zero (previous task still active)", async () => {
    executeMock.mockResolvedValueOnce([{ enqueued_count: 0, advanced_count: 1 }]);
    expect(await sweepDueSchedules()).toBe(0);
  });

  it("re-arms shard tasks for a KB with claimable pending extractions and no active extract task", async () => {
    enqueueTaskMock.mockReset();
    executeMock.mockResolvedValueOnce([{ kb_id: "kb-1", tenant_id: "t1" }]);
    enqueueTaskMock.mockResolvedValue("task-id");

    const rearmed = await rearmStrandedExtractionShards();

    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("ce.status = 'pending'");
    expect(parts).toContain("ce.attempts < 5");
    expect(parts).toContain("next_attempt_at");
    expect(parts).toContain("task.kind = 'graph.extract_chunks'");
    expect(parts).toContain("task.state = 'running'");
    expect(parts).toContain("task.run_at <= now() + interval '2 minutes'");
    expect(rearmed).toBeGreaterThan(0);
    expect(enqueueTaskMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(enqueueTaskMock.mock.calls[0][0]).toMatchObject({
      queue: "sync",
      tenantId: "t1",
      kind: "graph.extract_chunks",
      groupKey: "graph:kb-1:extract:0",
      payload: expect.objectContaining({ kbId: "kb-1", tenantId: "t1", shard: 0, continuationSlot: 0 }),
    });
    expect(enqueueTaskMock.mock.calls[0][0].dedupeKey).toMatch(/^extract:kb-1:\d+:0:slot:0$/);
  });

  it("re-arms nothing when no KB is stranded", async () => {
    enqueueTaskMock.mockReset();
    executeMock.mockResolvedValueOnce([]);
    expect(await rearmStrandedExtractionShards()).toBe(0);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it("upserts schedules keyed by (group_key, kind)", async () => {
    await upsertTaskSchedule({ tenantId: "t1", kind: "notion.poll", frequencySeconds: 300 });
    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("INSERT INTO task_schedules");
    expect(parts).toContain("ON CONFLICT (group_key, kind) DO UPDATE");
    expect(sqlParams(executeMock.mock.calls[0][0])).toContain("t1:notion.poll");
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
