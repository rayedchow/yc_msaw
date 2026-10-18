import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

import { finishSyncRun, startSyncRun } from "../../src/db/source-sync-runs.js";

describe("source sync run helpers", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
  });

  it("starts a running source sync run and returns the row id", async () => {
    executeMock.mockResolvedValueOnce([{ id: "run-1" }]);

    const id = await startSyncRun({
      userId: "tenant-1",
      provider: "google",
      requestedBy: "task",
      coverageFrom: new Date("2026-01-01T00:00:00.000Z"),
      coverageTo: new Date("2026-01-02T00:00:00.000Z"),
      metadata: { taskKind: "gmail.poll" },
    });

    expect(id).toBe("run-1");
    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("INSERT INTO source_sync_runs");
    expect(parts).toContain("status, phase");
    expect(parts).toContain("RETURNING id");
    expect(sqlParams(executeMock.mock.calls[0][0])).toEqual([
      "tenant-1",
      "google",
      "task",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "{\"taskKind\":\"gmail.poll\"}",
    ]);
  });

  it("finishes a completed run with result fields and flags", async () => {
    await finishSyncRun("00000000-0000-0000-0000-000000000001", {
      status: "completed",
      result: { stored: 2 },
      exhausted: true,
      capHit: false,
    });

    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("UPDATE source_sync_runs");
    expect(parts).toContain("result = result ||");
    expect(parts).toContain("completed_at =");
    expect(parts).toContain("failed_at =");
    expect(sqlParams(executeMock.mock.calls[0][0])).toEqual([
      "completed",
      "completed",
      "{\"stored\":2}",
      true,
      false,
      "00000000-0000-0000-0000-000000000001",
    ]);
  });

  it("rejects non-terminal finish statuses before writing", async () => {
    await expect(finishSyncRun("00000000-0000-0000-0000-000000000001", {
      status: "running" as any,
    })).rejects.toThrow("Invalid source_sync_runs terminal status");
    expect(executeMock).not.toHaveBeenCalled();
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
    if (chunk === null || typeof chunk !== "object") return [chunk];
    if (Array.isArray(chunk.queryChunks)) return sqlParams(chunk);
    if (Array.isArray(chunk.value)) return [];
    if ("value" in chunk) return [chunk.value];
    return [];
  });
}
