import { beforeEach, describe, expect, it, vi } from "vitest";

const pollConversationsDetailedMock = vi.hoisted(() => vi.fn());
const pollThreadsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/integrations/slack/poller.js", () => ({
  discoverConversations: vi.fn(),
  discoverConversationsDetailed: vi.fn(),
  pollConversationsDetailed: pollConversationsDetailedMock,
  pollThreads: pollThreadsMock,
}));

import { runSlackPoll } from "../../../src/integrations/slack/jobs.js";
import {
  drainSlackSkips,
  recordSlackSkip,
  SLACK_UNATTRIBUTED_SKIP_BUCKET,
} from "../../../src/integrations/slack/skips.js";

describe("Slack poll sync-run skips", () => {
  beforeEach(() => {
    pollConversationsDetailedMock.mockReset().mockResolvedValue({
      conversationsSeen: 1,
      stored: 0,
      cappedConversations: 0,
      exhausted: true,
      capHit: false,
    });
    pollThreadsMock.mockReset().mockResolvedValue(0);
    // Drain any counters left over from other tests.
    drainSlackSkips("tenant-1");
    drainSlackSkips(SLACK_UNATTRIBUTED_SKIP_BUCKET);
  });

  it("drains accumulated skip counters into the poll result", async () => {
    recordSlackSkip("tenant-1", "file_bytes_over_25mb", 2);
    recordSlackSkip("tenant-1", "realtime_unhandled:mystery");
    recordSlackSkip(SLACK_UNATTRIBUTED_SKIP_BUCKET, "unattributed:message");

    const result = await runSlackPoll("tenant-1");

    expect(result.skips).toEqual({
      file_bytes_over_25mb: 2,
      "realtime_unhandled:mystery": 1,
      "unattributed:message": 1,
    });

    // Drained: the next run starts from zero.
    const next = await runSlackPoll("tenant-1");
    expect(next.skips).toEqual({});
  });

  it("does not leak one tenant's skip counters into another tenant's run", async () => {
    recordSlackSkip("tenant-1", "file_capture_error");

    const other = await runSlackPoll("tenant-2");
    expect(other.skips).toEqual({});

    const own = await runSlackPoll("tenant-1");
    expect(own.skips).toEqual({ file_capture_error: 1 });
  });
});
