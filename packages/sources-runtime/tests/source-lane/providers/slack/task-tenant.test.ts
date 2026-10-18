import { describe, expect, it, vi } from "vitest";

const syncMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/integrations/source-sync-task.js", () => ({
  runRecordedSourceSyncTask: async (_input: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("../../../../src/integrations/slack/jobs.js", () => ({
  runSlackPoll: syncMock,
  runSlackDiscover: syncMock,
}));

import { slackIntegration } from "../../../../src/integrations/slack/index.js";

function ctx(tenantId: string) {
  return { task: { id: "task-1", queue: "sync", tenantId, groupKey: `${tenantId}:slack`, kind: "slack.poll", payload: {}, attempt: 1 }, heartbeat: async () => {} } as never;
}

describe("Slack task tenant binding", () => {
  it("runs for the queue row's tenant and refuses a payload naming another tenant", async () => {
    const handlers = slackIntegration.taskHandlers!();
    syncMock.mockReset().mockResolvedValue({ ok: true });
    await handlers["slack.poll"]!({ tenantId: "tenant-a" }, ctx("tenant-a"));
    expect(syncMock).toHaveBeenCalledWith("tenant-a");
    await handlers["slack.poll"]!({}, ctx("tenant-a"));
    expect(syncMock).toHaveBeenLastCalledWith("tenant-a");
    await expect(handlers["slack.poll"]!({ tenantId: "tenant-b" }, ctx("tenant-a"))).rejects.toThrow(/does not match/);
    await expect(handlers["slack.discover"]!({ userId: "tenant-b" }, ctx("tenant-a"))).rejects.toThrow(/does not match/);
    expect(syncMock).toHaveBeenCalledTimes(2);
  });
});
