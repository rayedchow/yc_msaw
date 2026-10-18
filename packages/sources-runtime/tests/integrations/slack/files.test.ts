import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Patched for the source lane: Slack file bytes moved from the donor S3 binary_documents
// lane (mocked here before) to the Slack lane tables (drizzle/9400), so these cases run
// against real SQL (PGlite). Each donor case keeps its semantics: bytes stored with the
// user token through the files.download throttle, oversize / missing URL / missing id /
// fetch failure counted as skips, and an already-stored version is not fetched again.

const throttleMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../src/db/client.js", async () => {
  const h = await import("../../source-lane/providers/slack/harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../src/vault/tokens.js", async () => (await import("../../source-lane/providers/slack/harness.js")).tokenVault);
vi.mock("../../../src/integrations/slack/rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/integrations/slack/rate-limit.js")>()),
  slackThrottle: throttleMock,
}));

import { query, ready, resetAll } from "../../source-lane/providers/slack/harness.js";
import { captureSlackMessageFiles, SLACK_FILE_MAX_BYTES } from "../../../src/integrations/slack/files.js";

async function fileRow(fileId: string) {
  const [row] = await query<Record<string, any>>(`SELECT * FROM slack_source_files WHERE tenant_id = 'tenant-1' AND file_id = $1`, [fileId]);
  return row;
}

describe("captureSlackMessageFiles", () => {
  beforeAll(async () => {
    await ready;
  });

  beforeEach(async () => {
    await resetAll();
    throttleMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("stores file bytes through the Slack lane with the user token", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("file bytes"), { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      teamId: "T1",
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
    const row = await fileRow("F123");
    expect(row).toMatchObject({ team_id: "T1", status: "stored", version_ref: "F123:1800000000", mimetype: "text/plain" });
    expect(Number(row!.size)).toBe(10);
    expect(row!.channel_ids).toEqual(["C123"]);
    // Credentialed URLs never persist in the stored metadata.
    expect(row!.metadata_json).not.toContain("files.slack.com");
    const [chunk] = await query<{ bytes: Uint8Array }>(`SELECT bytes FROM slack_source_chunks WHERE tenant_id = 'tenant-1'`);
    expect(Buffer.from(chunk!.bytes).toString()).toBe("file bytes");

    // The download itself is throttled and authenticated with the user token, redirects refused.
    expect(throttleMock).toHaveBeenCalledWith("xoxp-token", "files.download");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://files.slack.com/files-pri/T1-F123/download/notes.txt",
      { headers: { Authorization: "Bearer xoxp-token" }, redirect: "manual" },
    );
  });

  it("skips oversized files with a visible counter and keeps metadata-only capture", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      teamId: "T1",
      files: [{
        id: "F-big",
        size: SLACK_FILE_MAX_BYTES + 1,
        url_private_download: "https://files.slack.com/big",
      }],
    });

    expect(result).toEqual({ stored: 0, skips: { file_bytes_over_25mb: 1 } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fileRow("F-big")).toMatchObject({ status: "skipped_oversize" });
  });

  it("counts files without a private download URL or id instead of silently dropping them", async () => {
    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      teamId: "T1",
      files: [
        { id: "F-ext", name: "external.doc" }, // no url_private*
        { name: "no-id.txt", url_private: "https://files.slack.com/x" },
      ],
    });

    expect(result).toEqual({
      stored: 0,
      skips: { file_no_download_url: 1, file_missing_id: 1 },
    });
    expect(await fileRow("F-ext")).toMatchObject({ status: "no_download_url" });
  });

  it("surfaces fetch failures as skip counters and schedules a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const result = await captureSlackMessageFiles({
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      teamId: "T1",
      files: [{ id: "F-err", size: 5, url_private: "https://files.slack.com/err" }],
    });

    expect(result).toEqual({ stored: 0, skips: { file_failed_fetch: 1 } });
    const row = await fileRow("F-err");
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row!.next_attempt_at).not.toBeNull();
  });

  it("treats an already-stored file version as stored without downloading again", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("dup!!"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      userId: "tenant-1",
      token: "xoxp-token",
      channelId: "C123",
      teamId: "T1",
      files: [{ id: "F-dup", size: 5, created: 1800000000, url_private: "https://files.slack.com/dup" }],
    };
    expect(await captureSlackMessageFiles(input)).toEqual({ stored: 1, skips: {} });
    expect(await captureSlackMessageFiles(input)).toEqual({ stored: 1, skips: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
