import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueTaskMock = vi.hoisted(() => vi.fn());
const startNotionPollingMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  startNotionPolling: startNotionPollingMock,
}));

import { scheduleNotionIngestion } from "../../../src/integrations/notion/connect.js";

describe("Notion task scheduling", () => {
  beforeEach(() => {
    enqueueTaskMock.mockReset();
    startNotionPollingMock.mockReset();
  });

  it("schedules the registered notion.backfill task kind on connect", async () => {
    await scheduleNotionIngestion("user-1");

    expect(startNotionPollingMock).toHaveBeenCalledWith("user-1");
    expect(enqueueTaskMock).toHaveBeenCalledWith({
      queue: "backfill",
      tenantId: "user-1",
      kind: "notion.backfill",
      payload: { userId: "user-1", days: null, maxPages: null },
      groupKey: "user-1:notion",
      dedupeKey: "user-1:notion:backfill:initial",
    });
  });
});
