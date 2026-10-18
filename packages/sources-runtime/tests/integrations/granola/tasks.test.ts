import { beforeEach, describe, expect, it, vi } from "vitest";

const runGranolaPollMock = vi.hoisted(() => vi.fn());
const runGranolaBackfillMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/integrations/granola/jobs.js", () => ({
  runGranolaPoll: runGranolaPollMock,
  runGranolaBackfill: runGranolaBackfillMock,
}));

vi.mock("../../../src/integrations/granola/connect.js", () => ({
  connectGranola: vi.fn(),
}));

vi.mock("../../../src/routes/granola-callback.js", () => ({
  granolaCallbackRoute: {},
}));

vi.mock("../../../src/integrations/source-sync-task.js", () => ({
  runRecordedSourceSyncTask: vi.fn((_input: unknown, run: () => Promise<unknown>) => run()),
  coverageFromDays: vi.fn(() => null),
}));

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

import { granolaIntegration } from "../../../src/integrations/granola/index.js";

const ctx = { task: { id: "task-1", queue: "sync", tenantId: "tenant-1" } } as never;

describe("granola.poll cap-hit resume", () => {
  beforeEach(() => {
    runGranolaPollMock.mockReset();
    enqueueTaskMock.mockReset().mockResolvedValue("task-2");
  });

  it("re-enqueues an immediate deduped follow-up poll when the run hit the note cap", async () => {
    runGranolaPollMock.mockResolvedValue(pollResult({ capHit: true, watermarkAdvancedTo: null }));
    const handlers = granolaIntegration.taskHandlers!();

    const result = await handlers["granola.poll"]({ tenantId: "tenant-1" }, ctx);

    expect(result).toMatchObject({ capHit: true, watermarkAdvancedTo: null });
    expect(enqueueTaskMock).toHaveBeenCalledWith({
      queue: "sync",
      tenantId: "tenant-1",
      kind: "granola.poll",
      payload: { tenantId: "tenant-1" },
      groupKey: "tenant-1:granola",
      dedupeKey: "tenant-1:granola:poll:resume",
    });
  });

  it("does not re-enqueue when the poll drained the window (non-full page)", async () => {
    runGranolaPollMock.mockResolvedValue(pollResult({ capHit: false, watermarkAdvancedTo: "2024-01-01T00:04:00.000Z" }));
    const handlers = granolaIntegration.taskHandlers!();

    const result = await handlers["granola.poll"]({ tenantId: "tenant-1" }, ctx);

    expect(result).toMatchObject({ capHit: false, watermarkAdvancedTo: "2024-01-01T00:04:00.000Z" });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });
});

describe("granola.backfill bounded retry", () => {
  beforeEach(() => {
    runGranolaBackfillMock.mockReset();
    enqueueTaskMock.mockReset().mockResolvedValue("task-3");
  });

  it("re-enqueues a deduped retry when per-note fetches failed during backfill", async () => {
    runGranolaBackfillMock.mockResolvedValue(backfillResult({ failed: 3 }));
    const handlers = granolaIntegration.taskHandlers!();

    const result = await handlers["granola.backfill"]({ tenantId: "tenant-1" }, ctx);

    expect(result).toMatchObject({ failed: 3 });
    expect(enqueueTaskMock).toHaveBeenCalledWith({
      queue: "backfill",
      tenantId: "tenant-1",
      kind: "granola.backfill",
      payload: { tenantId: "tenant-1", attempt: 1 },
      groupKey: "tenant-1:granola",
      dedupeKey: "tenant-1:granola:backfill:retry:1",
    });
  });

  it("stops retrying after the attempt cap", async () => {
    runGranolaBackfillMock.mockResolvedValue(backfillResult({ failed: 3 }));
    const handlers = granolaIntegration.taskHandlers!();

    await handlers["granola.backfill"]({ tenantId: "tenant-1", attempt: 2 }, ctx);

    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it("does not retry a clean backfill", async () => {
    runGranolaBackfillMock.mockResolvedValue(backfillResult({ failed: 0 }));
    const handlers = granolaIntegration.taskHandlers!();

    await handlers["granola.backfill"]({ tenantId: "tenant-1" }, ctx);

    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });
});

function pollResult(overrides: { capHit: boolean; watermarkAdvancedTo: string | null }) {
  return {
    listed: 200,
    processed: 200,
    failed: 0,
    stored: 180,
    skipped: 20,
    tombstoned: 0,
    newestUpdatedAt: "2024-01-01T00:04:00.000Z",
    exhausted: !overrides.capHit,
    ...overrides,
  };
}

function backfillResult(overrides: { failed: number }) {
  return {
    listed: 50,
    processed: 50 - overrides.failed,
    stored: 40,
    skipped: 10 - overrides.failed,
    tombstoned: 0,
    newestUpdatedAt: "2024-01-01T00:04:00.000Z",
    watermarkAdvancedTo: null,
    exhausted: overrides.failed === 0,
    capHit: false,
    ...overrides,
  };
}
