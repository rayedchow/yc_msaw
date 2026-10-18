import { afterEach, describe, expect, it, vi } from "vitest";
import { slackSocketModeEnabled } from "../../../src/integrations/slack/config.js";

describe("Slack Socket Mode gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is enabled by default (Socket Mode is the primary capture path)", () => {
    vi.stubEnv("SLACK_SOCKET_MODE_ENABLED", "");
    expect(slackSocketModeEnabled()).toBe(true);
  });

  it("can be explicitly disabled", () => {
    vi.stubEnv("SLACK_SOCKET_MODE_ENABLED", "false");
    expect(slackSocketModeEnabled()).toBe(false);
    vi.stubEnv("SLACK_SOCKET_MODE_ENABLED", "0");
    expect(slackSocketModeEnabled()).toBe(false);
  });

  it("stays enabled for affirmative values", () => {
    vi.stubEnv("SLACK_SOCKET_MODE_ENABLED", "true");
    expect(slackSocketModeEnabled()).toBe(true);
  });
});
