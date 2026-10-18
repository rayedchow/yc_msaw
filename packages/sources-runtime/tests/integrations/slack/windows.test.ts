import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueTaskMock = vi.hoisted(() => vi.fn());
const mirrorSlackWindowsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock("../../../src/mirror/backfill.js", () => ({
  mirrorSlackChannelWindows: mirrorSlackWindowsMock,
}));

import {
  enqueueSlackChannelWindows,
  SLACK_WINDOWS_DEDUPE_BUCKET_MS,
} from "../../../src/integrations/slack/windows.js";
import { slackIntegration } from "../../../src/integrations/slack/index.js";

describe("Slack window tasks", () => {
  beforeEach(() => {
    enqueueTaskMock.mockReset();
    mirrorSlackWindowsMock.mockReset().mockResolvedValue({
      files: [{ path: "sources/slack/engineering-channel-c123/sessions/2024-07-01T0601.md" }],
      threads: { writtenPaths: [], crumbsSkipped: 0 },
      sessions: {
        writtenPaths: ["sources/slack/engineering-channel-c123/sessions/2024-07-01T0601.md"],
        crumbsSkipped: 1,
      },
    });
  });

  it("registers slack.windows and materializes exactly the payload channel", async () => {
    const handler = slackIntegration.taskHandlers?.()["slack.windows"];
    expect(handler).toBeTypeOf("function");

    const result = await handler?.({ tenantId: "tenant-1", channelId: "C123" }, {
      task: {
        id: "task-1",
        queue: "sync",
        tenantId: "fallback-tenant",
        groupKey: "tenant-1:slack-windows:C123",
        kind: "slack.windows",
        payload: { tenantId: "tenant-1", channelId: "C123" },
        attempt: 1,
        maxAttempts: 3,
        priority: 0,
        prevRunId: null,
      },
      heartbeat: vi.fn(),
    });

    expect(mirrorSlackWindowsMock).toHaveBeenCalledWith("tenant-1", "C123");
    expect(result).toEqual({ files: 1, threadFiles: 0, sessionFiles: 1, crumbsSkipped: 1 });
  });

  it("uses one active dedupe key for two enqueues in the same five-minute bucket", async () => {
    enqueueTaskMock
      .mockResolvedValueOnce("task-1")
      .mockResolvedValueOnce(null);
    const now = 42 * SLACK_WINDOWS_DEDUPE_BUCKET_MS + 1_000;

    const taskIds = await Promise.all([
      enqueueSlackChannelWindows("tenant-1", "C123", now),
      enqueueSlackChannelWindows("tenant-1", "C123", now + 10_000),
    ]);

    expect(taskIds.filter(Boolean)).toEqual(["task-1"]);
    expect(enqueueTaskMock).toHaveBeenCalledTimes(2);
    expect(enqueueTaskMock.mock.calls[0]?.[0]).toEqual({
      queue: "sync",
      tenantId: "tenant-1",
      kind: "slack.windows",
      payload: { tenantId: "tenant-1", channelId: "C123" },
      groupKey: "tenant-1:slack-windows:C123",
      dedupeKey: "tenant-1:slack-windows:C123:42",
    });
    expect(enqueueTaskMock.mock.calls[1]?.[0]).toEqual(enqueueTaskMock.mock.calls[0]?.[0]);
  });
});
