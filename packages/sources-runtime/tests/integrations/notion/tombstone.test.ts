import { beforeEach, describe, expect, it, vi } from "vitest";

const insertValuesMock = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => ({
  insert: vi.fn(() => ({ values: insertValuesMock })),
}));
const enqueueEventProcessingMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({ db: dbMock }));
vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueEventProcessing: enqueueEventProcessingMock,
}));

import { emitNotionTombstoneEvent } from "../../../src/integrations/notion/tombstone.js";

function mockInsertReturning(rows: Array<{ id: string }>): void {
  insertValuesMock.mockReturnValue({
    onConflictDoNothing: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue(rows),
    })),
  });
}

describe("Notion tombstone events", () => {
  beforeEach(() => {
    dbMock.insert.mockClear();
    insertValuesMock.mockReset();
    enqueueEventProcessingMock.mockReset();
  });

  it("writes a versioned append-only ledger row and enqueues processing", async () => {
    mockInsertReturning([{ id: "event-1" }]);

    const inserted = await emitNotionTombstoneEvent("user-1", {
      eventType: "page.unshared",
      externalId: "page-1",
      versionRef: "2026-07-01T10:00:00.000Z",
      timestamp: new Date("2026-07-01T10:00:00.000Z"),
      payload: { pageId: "page-1" },
    });

    expect(inserted).toBe(true);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      source: "notion",
      eventType: "page_unshared",
      sourceEventId: "notion:page_unshared:page-1:2026-07-01T10:00:00.000Z",
      rawPayload: { pageId: "page-1" },
      processingStatus: "received",
    }));
    expect(enqueueEventProcessingMock).toHaveBeenCalledWith("event-1", "user-1");
  });

  it("is idempotent: a conflicting source_event_id inserts nothing and enqueues nothing", async () => {
    mockInsertReturning([]);

    const inserted = await emitNotionTombstoneEvent("user-1", {
      eventType: "page.deleted",
      externalId: "page-1",
      versionRef: "unknown",
      payload: { pageId: "page-1" },
    });

    expect(inserted).toBe(false);
    expect(enqueueEventProcessingMock).not.toHaveBeenCalled();
  });
});
