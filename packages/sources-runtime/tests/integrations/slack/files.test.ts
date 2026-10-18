import { beforeEach, describe, expect, it, vi } from "vitest";

const intakeMock = vi.hoisted(() => vi.fn());
const throttleMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../src/integrations/binary/intake.js", () => ({
  intakeBinaryDocument: intakeMock,
}));

vi.mock("../../../src/integrations/slack/rate-limit.js", () => ({
  slackThrottle: throttleMock,
}));

import { captureSlackMessageFiles, SLACK_FILE_MAX_BYTES } from "../../../src/integrations/slack/files.js";

describe("captureSlackMessageFiles", () => {
  beforeEach(() => {
    intakeMock.mockReset().mockResolvedValue({ status: "stored", id: "bd-1" });
    throttleMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("stores file bytes through the binary lane with the user token", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("file bytes"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      files: [{
        id: "F123",
        name: "notes.txt",
        mimetype: "text/plain",
        size: 10,
        timestamp: 1800000000,
        url_private_download: "https://files.slack.com/files-pri/T1-F123/download/notes.txt",
      }],
    });

    expect(result).toEqual({ stored: 1, skips: {} });
    expect(intakeMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      provider: "slack",
      externalId: "F123",
      mimeType: "text/plain",
      acceptAnyMimeType: true,
      versionRef: "F123:1800000000",
      sourceAcl: { channelId: "C123" },
    }));

    // The download itself is throttled and authenticated with the bot/user token.
    const { fetchBytes } = intakeMock.mock.calls[0][0] as { fetchBytes: () => Promise<Buffer> };
    const bytes = await fetchBytes();
    expect(Buffer.from(bytes).toString()).toBe("file bytes");
    expect(throttleMock).toHaveBeenCalledWith("xoxp-token", "files.download");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://files.slack.com/files-pri/T1-F123/download/notes.txt",
      { headers: { Authorization: "Bearer xoxp-token" } },
    );
  });

  it("skips oversized files with a visible counter and keeps metadata-only capture", async () => {
    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      files: [{
        id: "F-big",
        size: SLACK_FILE_MAX_BYTES + 1,
        url_private_download: "https://files.slack.com/big",
      }],
    });

    expect(result).toEqual({ stored: 0, skips: { file_bytes_over_25mb: 1 } });
    expect(intakeMock).not.toHaveBeenCalled();
  });

  it("counts files without a private download URL or id instead of silently dropping them", async () => {
    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      files: [
        { id: "F-ext", name: "external.doc" }, // external file, no url_private*
        { name: "no-id.txt", url_private: "https://files.slack.com/x" },
      ],
    });

    expect(result).toEqual({
      stored: 0,
      skips: { file_no_download_url: 1, file_missing_id: 1 },
    });
    expect(intakeMock).not.toHaveBeenCalled();
  });

  it("surfaces fetch failures from the binary lane as skip counters", async () => {
    intakeMock.mockResolvedValue({ status: "failed_fetch", id: "bd-2" });

    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      files: [{ id: "F-err", size: 5, url_private: "https://files.slack.com/err" }],
    });

    expect(result).toEqual({ stored: 0, skips: { file_failed_fetch: 1 } });
  });

  it("treats version-dedupe skips from the binary lane as already stored", async () => {
    intakeMock.mockResolvedValue({ status: "skipped", id: "bd-3" });

    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      files: [{ id: "F-dup", size: 5, url_private: "https://files.slack.com/dup" }],
    });

    expect(result).toEqual({ stored: 1, skips: {} });
  });
});
