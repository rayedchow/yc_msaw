import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn());
const fetchAndMaterializeNotionMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock("../../../src/integrations/notion/source-wiki.js", () => ({
  fetchAndMaterializeNotionPageContentSourceWiki: fetchAndMaterializeNotionMock,
}));

import { runNotionRender } from "../../../src/integrations/notion/render.js";

describe("Notion dirty render loop", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    enqueueTaskMock.mockReset().mockResolvedValue("task-1");
    fetchAndMaterializeNotionMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("claims dirty rows oldest-first, clears only rendered rows, and re-enqueues remaining backlog", async () => {
    const dirtyAt = new Date("2026-07-01T12:00:00.123Z");
    executeMock
      .mockResolvedValueOnce([
        dirtyRow({ page_id: "page-1", title: "Page One", dirty_at: dirtyAt }),
        dirtyRow({ page_id: "page-2", title: "Page Two", dirty_at: new Date("2026-07-01T12:01:00.000Z") }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ remaining: 1 }]);
    fetchAndMaterializeNotionMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("fetch failed"));

    const result = await runNotionRender("tenant-1", { limit: 2 });

    expect(result).toEqual({ rendered: 1, failed: 1, remaining: 1 });
    expect(fetchAndMaterializeNotionMock).toHaveBeenCalledWith({
      userId: "tenant-1",
      pageId: "page-1",
      overview: "",
      sectionSummaries: {},
      refreshIndexes: false,
    });
    expect(fetchAndMaterializeNotionMock).toHaveBeenCalledWith({
      userId: "tenant-1",
      pageId: "page-2",
      overview: "",
      sectionSummaries: {},
      refreshIndexes: false,
    });

    const claimSql = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(claimSql).toContain("ORDER BY dirty_at ASC, page_id ASC");
    expect(claimSql).toContain("FOR UPDATE SKIP LOCKED");

    const clearSql = sqlParts(executeMock.mock.calls[1][0]).join(" ");
    expect(clearSql).toContain("SET dirty_at = NULL");
    expect(clearSql).toContain("dirty_at <=");
    expect(sqlParams(executeMock.mock.calls[1][0])).toEqual(expect.arrayContaining([
      "tenant-1",
      "page-1",
      dirtyAt.toISOString(),
    ]));

    expect(enqueueTaskMock).toHaveBeenCalledWith({
      queue: "sync",
      tenantId: "tenant-1",
      kind: "notion.render",
      payload: { userId: "tenant-1", limit: 2 },
      groupKey: "tenant-1:notion",
      dedupeKey: "tenant-1:notion:render",
    });
  });
});

function dirtyRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    page_id: "page-1",
    title: "Page One",
    parent_type: null,
    parent_id: null,
    data_source_id: null,
    overview: "",
    section_summaries: {},
    dirty_at: new Date("2026-07-01T12:00:00.000Z"),
    ...overrides,
  };
}

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
