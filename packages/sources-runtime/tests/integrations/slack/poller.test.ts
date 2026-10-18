import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/client.js", () => ({
  db: {},
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: vi.fn(),
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  getToken: vi.fn(),
}));

vi.mock("../../../src/mirror/materializer.js", () => ({
  materializeSlackChannelDaySourceWiki: vi.fn(),
}));

import { slackDayKeyFromTs, slackUserDirectoryCacheKey } from "../../../src/integrations/slack/poller.js";

describe("Slack poller", () => {
  it("keys user-directory caches by tenant and token fingerprint", () => {
    const a = slackUserDirectoryCacheKey("tenant-a", "token-one");
    const b = slackUserDirectoryCacheKey("tenant-b", "token-one");
    const c = slackUserDirectoryCacheKey("tenant-a", "token-two");

    expect(a).toMatch(/^tenant-a:[a-f0-9]{16}$/u);
    expect(b).toMatch(/^tenant-b:[a-f0-9]{16}$/u);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("buckets Slack timestamps by UTC day", () => {
    expect(slackDayKeyFromTs("1800000000.000100")).toBe("2027-01-15");
  });
});
