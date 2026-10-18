import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertTaskScheduleMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../src/queue/sweeper.js", () => ({
  upsertTaskSchedule: upsertTaskScheduleMock,
}));
vi.mock("../../src/outbox/writer.js", () => ({
  emitOutboxEvent: vi.fn(),
}));
vi.mock("../../src/queue/queue.js", () => ({
  enqueueTask: vi.fn(),
}));

import { SLACK_POLL_FREQUENCY_SECONDS, startSlackPolling } from "../../src/queue/dispatch.js";

describe("Slack poll schedule", () => {
  beforeEach(() => {
    upsertTaskScheduleMock.mockClear();
  });

  it("registers slack.poll at the gap-fill cadence (realtime is the primary capture path)", async () => {
    // Socket Mode carries freshness; the poller only reconciles gaps within
    // the 1 request/min conversations.history budget, so it must NOT run at
    // the old 60s freshness cadence.
    expect(SLACK_POLL_FREQUENCY_SECONDS).toBe(900);

    await startSlackPolling("tenant-1");

    expect(upsertTaskScheduleMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "slack.poll",
      frequencySeconds: 900,
      groupKey: "tenant-1:slack",
    }));
    expect(upsertTaskScheduleMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "slack.discover",
      frequencySeconds: 180,
      groupKey: "tenant-1:slack",
    }));
    expect(upsertTaskScheduleMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      kind: "graph.ensure_default_kb",
      frequencySeconds: 900,
      groupKey: "tenant-1:graph-ensure",
      payload: { tenantId: "tenant-1" },
    }, undefined);
  });
});
