import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { Clock, connectSlack, query, ready, resetAll } from "./harness.js";
import { FakeSlack } from "./fake-slack.js";
import { captureSlackMessageFiles, isAllowedSlackFileUrl } from "../../../../src/integrations/slack/files.js";
import { discoverSlackConversations, syncSlackHistory } from "../../../../src/integrations/slack/history-sync.js";
import { handleEvent, handleFileDeleted } from "../../../../src/integrations/slack/realtime.js";
import { getBlob, loadChunk } from "../../../../src/integrations/slack/source-store.js";
import { resetSlackRateBucketsForTests } from "../../../../src/integrations/slack/rate-limit.js";
import { db } from "./harness.js";

const T = "tenant-slack-files";
const TEAM = "T0FILES";
const TOKEN = "xoxp-synthetic-files";
let fake: FakeSlack;
let clock: Clock;

function hosted(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.bin`,
    title: `${id} title`,
    mimetype: "application/octet-stream",
    filetype: "binary",
    created: 1800000000,
    url_private: `https://files.slack.com/files-pri/${TEAM}-${id}/${id}.bin`,
    url_private_download: `https://files.slack.com/files-pri/${TEAM}-${id}/download/${id}.bin`,
    thumb_64: `https://files.slack.com/files-tmb/${TEAM}-${id}/thumb_64.png`,
    permalink_public: `https://slack-files.com/${TEAM}-${id}-secret`,
    ...extra,
  };
}

async function fileRow(fileId: string) {
  const [row] = await query<Record<string, any>>(`SELECT * FROM slack_source_files WHERE tenant_id = $1 AND file_id = $2`, [T, fileId]);
  return row;
}

async function storedBytes(fileId: string): Promise<Buffer> {
  const row = await fileRow(fileId);
  const blob = await getBlob(db as never, T, row!.sha256);
  return Buffer.concat(await Promise.all(blob!.chunks.map((c) => loadChunk(db as never, T, c.sha256))));
}

function capture(files: unknown[]) {
  return captureSlackMessageFiles({ userId: T, token: TOKEN, channelId: "C1", teamId: TEAM, messageTs: "1800000000.000100", files, fetchImpl: fake.fetch, now: clock.now });
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  resetSlackRateBucketsForTests();
  fake = new FakeSlack();
  fake.token(TOKEN, TEAM);
  clock = new Clock();
  vi.stubGlobal("fetch", fake.fetch);
  await connectSlack(T, TOKEN, TEAM);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Slack file bytes (source lane)", () => {
  it("stores exact non-UTF-8 bytes across 8 MiB chunks and keeps credentialed URLs out of metadata", async () => {
    const bytes = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x80]), randomBytes(9 * 1024 * 1024)]);
    const file = hosted("FBIG", { size: bytes.length });
    fake.hostFile(file, bytes);
    expect(await capture([file])).toEqual({ stored: 1, skips: {} });
    const row = await fileRow("FBIG");
    expect(row).toMatchObject({ status: "stored" });
    expect(Number(row!.size)).toBe(bytes.length);
    expect((await getBlob(db as never, T, row!.sha256))!.chunks.map((c) => c.size)).toEqual([8 * 1024 * 1024, bytes.length - 8 * 1024 * 1024]);
    expect((await storedBytes("FBIG")).equals(bytes)).toBe(true);
    for (const secret of ["files-pri", "files-tmb", "slack-files.com"]) expect(row!.metadata_json).not.toContain(secret);
  });

  it("never sends the token to a non-Slack or non-https URL", async () => {
    const external = hosted("FEXT", { url_private: "https://docs.google.com/document/d/abc", url_private_download: undefined });
    const plain = hosted("FHTTP", { url_private_download: "http://files.slack.com/files-pri/x", url_private: undefined });
    const lookalike = hosted("FLOOK", { url_private_download: "https://files.slack.com.evil.example/x", url_private: undefined });
    const creds = hosted("FCRED", { url_private_download: "https://user:pw@files.slack.com/x", url_private: undefined });
    const result = await capture([external, plain, lookalike, creds]);
    expect(result).toEqual({ stored: 0, skips: { file_download_host_not_allowed: 4 } });
    expect(fake.requests.filter((r) => r.url.hostname !== "slack.com")).toHaveLength(0);
    expect((await fileRow("FEXT"))!.status).toBe("disallowed_host");
    expect(isAllowedSlackFileUrl("https://files.slack.com/files-pri/T-F/x")).toBe(true);
    expect(isAllowedSlackFileUrl("https://files.slack.com:8443/x")).toBe(false);
  });

  it("refuses redirects and sign-in HTML instead of storing them as file bytes", async () => {
    const redirected = hosted("FREDIR");
    fake.hostFile(redirected, Buffer.from("x"), { status: 302, location: "https://evil.example/collect" });
    const html = hosted("FHTML", { mimetype: "application/pdf" });
    fake.hostFile(html, Buffer.from("<html>sign in</html>"), { contentType: "text/html; charset=utf-8" });
    const result = await capture([redirected, html]);
    expect(result).toEqual({ stored: 0, skips: { file_failed_fetch: 2 } });
    expect(fake.requests.filter((r) => r.url.hostname === "evil.example")).toHaveLength(0);
    expect((await fileRow("FREDIR"))!.last_error).toMatch(/redirect refused/);
    expect((await fileRow("FHTML"))!.last_error).toMatch(/HTML response/);
  });

  it("tombstones a file Slack replaced by a tombstone (message edit) and on realtime file_deleted", async () => {
    const file = hosted("FGONE");
    fake.hostFile(file, Buffer.from("bytes"));
    await capture([file]);
    expect(await capture([{ id: "FGONE", mode: "tombstone" }])).toEqual({ stored: 0, skips: { file_tombstoned: 1 } });
    expect(await fileRow("FGONE")).toMatchObject({ deleted_reason: "file_tombstoned" });

    const other = hosted("FDEL");
    fake.hostFile(other, Buffer.from("bytes2"));
    await capture([other]);
    await handleFileDeleted({ type: "file_deleted", file_id: "FDEL", event_ts: "1800000500.000000" }, T, TEAM);
    expect(await fileRow("FDEL")).toMatchObject({ deleted_reason: "file_deleted" });
    expect(new Date((await fileRow("FDEL"))!.deleted_at).toISOString()).toBe(new Date(1800000500 * 1000).toISOString());
  });

  it("captures bytes of a file attached to a realtime message, keyed by the routed workspace", async () => {
    const file = hosted("FRT");
    const bytes = randomBytes(1000);
    fake.hostFile(file, bytes);
    await handleEvent({ event: { type: "message", channel: "C1", user: "U1", ts: "1800000000.000200", text: "see file", files: [file] } }, T, TOKEN, TEAM);
    expect(await fileRow("FRT")).toMatchObject({ team_id: TEAM, status: "stored" });
    expect((await storedBytes("FRT")).equals(bytes)).toBe(true);
    const [raw] = await query<{ raw: string }>(`SELECT raw_payload::text AS raw FROM activity_events WHERE user_id = $1`, [T]);
    expect(raw!.raw).not.toContain("files-pri");
  });

  it("retries a failed download through files.info (fresh URL) and tombstones files Slack no longer has", async () => {
    const file = hosted("FRETRY");
    fake.hostFile(file, Buffer.from("later"), { status: 503 });
    expect(await capture([file])).toEqual({ stored: 0, skips: { file_failed_fetch: 1 } });
    fake.hostFile(file, Buffer.from("later"));
    await query(`INSERT INTO slack_source_files (tenant_id, team_id, file_id, status) VALUES ($1, $2, 'FMISSING', 'failed')`, [T, TEAM]);
    fake.channel("C1");
    await discoverSlackConversations(T, { now: clock.now, sleep: clock.sleep });
    clock.advance(24 * 60 * 60_000);
    await syncSlackHistory(T, { now: clock.now, sleep: clock.sleep, enqueueContinuation: false });
    expect(fake.calls("files.info").map((r) => r.url.searchParams.get("file")).sort()).toEqual(["FMISSING", "FRETRY"]);
    expect(await fileRow("FRETRY")).toMatchObject({ status: "stored" });
    expect((await storedBytes("FRETRY")).toString()).toBe("later");
    expect(await fileRow("FMISSING")).toMatchObject({ deleted_reason: "file_not_found" });
  });

  it("does not download external or plan-hidden files and labels them", async () => {
    const result = await capture([
      { id: "FX", is_external: true, external_type: "gdrive", url_private: "https://docs.google.com/x" },
      { id: "FH", mode: "hidden_by_limit" },
    ]);
    expect(result).toEqual({ stored: 0, skips: { file_external: 1, file_hidden_by_limit: 1 } });
    expect(fake.requests).toHaveLength(0);
  });
});
