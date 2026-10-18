import { beforeEach, describe, expect, it, vi } from "vitest";
import { googleCalendarChannelTokenHash } from "../../../src/integrations/google/calendar/common.js";

const enqueueCustomerBackendJobMock = vi.hoisted(() => vi.fn());
const selectLimitMock = vi.hoisted(() => vi.fn());
const updateWhereMock = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: selectLimitMock,
      })),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: updateWhereMock,
    })),
  })),
}));

vi.mock("../../../src/db/client.js", () => ({ db: dbMock }));
vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCustomerBackendJob: enqueueCustomerBackendJobMock,
}));

import { handleGoogleCalendarWebhook } from "../../../src/integrations/google/calendar/webhook.js";

describe("Google Calendar webhook", () => {
  beforeEach(() => {
    enqueueCustomerBackendJobMock.mockReset();
    selectLimitMock.mockReset();
    updateWhereMock.mockReset();
    dbMock.select.mockClear();
    dbMock.update.mockClear();
    updateWhereMock.mockResolvedValue([]);
  });

  it("enqueues the registered calendar.poll handler for valid push notifications", async () => {
    selectLimitMock.mockResolvedValueOnce([{
      userId: "user-1",
      channelId: "channel-1",
      resourceId: "resource-1",
      tokenHash: googleCalendarChannelTokenHash("token-1"),
      resourceUri: "https://calendar.example/resource",
    }]);

    const result = await handleGoogleCalendarWebhook({
      channelId: "channel-1",
      channelToken: "token-1",
      resourceId: "resource-1",
      resourceState: "exists",
      messageNumber: "12",
    });

    expect(result.status).toBe(204);
    expect(enqueueCustomerBackendJobMock).toHaveBeenCalledWith("google-calendar-sync", "calendar.poll", {
      userId: "user-1",
      channelId: "channel-1",
      resourceState: "exists",
      messageNumber: "12",
    });
  });
});
