import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { Clock, connectSlack, db, ready, resetAll, ts } from "./harness.js";
import { FakeSlack } from "./fake-slack.js";
import { bindingToken, FakePublishStore } from "./publish.js";
import { discoverSlackConversations, syncSlackHistory } from "../../../../src/integrations/slack/history-sync.js";
import { handleEvent, handleFileDeleted } from "../../../../src/integrations/slack/realtime.js";
import { resetSlackRateBucketsForTests } from "../../../../src/integrations/slack/rate-limit.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { slackProvider } from "../../../../src/source-lane/providers/slack/index.js";
import { conversationLabelPath, fileBytesPath, fileMetadataPath } from "../../../../src/source-lane/providers/slack/paths.js";

const T = "tenant-slack-export";
const TEAM = "T0EXP";
const TOKEN = "xoxp-synthetic-export-token";
const START = Date.parse("2027-01-20T12:00:00.000Z");
let fake: FakeSlack;
let clock: Clock;
let store: FakePublishStore;
let exporter: SourceExporter;

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const r = await exporter.runOnce();
    expect(r.deadLettered).toBe(0);
    if (r.claimed === 0) return;
  }
  throw new Error("exporter did not drain");
}

const BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(9 * 1024 * 1024), Buffer.from([0x00, 0xff])]);

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  resetSlackRateBucketsForTests();
  fake = new FakeSlack();
  fake.token(TOKEN, TEAM);
  clock = new Clock(START);
  vi.stubGlobal("fetch", fake.fetch);
  await connectSlack(T, TOKEN, TEAM);
  store = new FakePublishStore();
  await setTenantBinding(db as never, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
  exporter = new SourceExporter({ db: db as never, registry: new SourceProviderRegistry([slackProvider]), fetchImpl: store.fetch, log: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack direct messages are withheld from $SOURCES (owner-only personal sources)", () => {
  it("exports channels but no DM / group DM content, label or DM-only file", async () => {
    const dmFile = {
      id: "F2", name: "private.pdf", title: "Private", mimetype: "application/pdf", filetype: "pdf", size: 12, created: 1800000000,
      url_private: `https://files.slack.com/files-pri/${TEAM}-F2/private.pdf`,
      url_private_download: `https://files.slack.com/files-pri/${TEAM}-F2/download/private.pdf`,
    };
    fake.hostFile(dmFile, Buffer.from("%PDF-private"));
    fake.channel("C1", { name: "general" });
    fake.channel("D0DM12345", { name: "D0DM12345", is_channel: false, is_im: true, user: "U2" });
    fake.channel("G0MPIM123", { name: "mpdm-a--b--c-1", is_channel: false, is_mpim: true, is_group: true });
    fake.post("C1", { ts: ts(START - 3_600_000), user: "U1", text: "team update" });
    fake.post("D0DM12345", { ts: ts(START - 3_500_000), user: "U2", text: "private dm text", files: [dmFile] });
    fake.post("G0MPIM123", { ts: ts(START - 3_400_000), user: "U3", text: "group dm text" });
    await discoverSlackConversations(T, { now: clock.now, sleep: clock.sleep });
    await syncSlackHistory(T, { now: clock.now, sleep: clock.sleep, enqueueContinuation: false });
    await drain();
    const live = store.live("sources/slack/");
    const text = live.map((p) => store.current(p)!.bytes?.toString("utf8") ?? "").join("\n");
    expect(text).toContain("team update");
    expect(text).not.toContain("private dm text");
    expect(text).not.toContain("group dm text");
    expect(live.some((p) => p.includes("D0DM12345") || p.includes("G0MPIM123") || p.includes("/files/F2/"))).toBe(false);
    expect(store.current(conversationLabelPath(TEAM, "C1"))).toBeTruthy();
  });
});

describe("Slack export to sources/slack/", () => {
  it("publishes raw ledger rows, folded-ready projections, conversation labels and exact file bytes; deletions are tombstones", async () => {
    const file = {
      id: "F1", name: "report.pdf", title: "Report", mimetype: "application/pdf", filetype: "pdf", size: BYTES.length, created: 1800000000,
      url_private: `https://files.slack.com/files-pri/${TEAM}-F1/report.pdf`,
      url_private_download: `https://files.slack.com/files-pri/${TEAM}-F1/download/report.pdf`,
      thumb_pdf: `https://files.slack.com/files-tmb/${TEAM}-F1/thumb.png`,
    };
    fake.hostFile(file, BYTES);
    const m1 = ts(START - 3_600_000);
    const m2 = ts(START - 3_000_000);
    fake.channel("C1", { name: "general" });
    fake.post("C1", { ts: m1, user: "U1", text: "quarterly report", files: [file] });
    fake.post("C1", { ts: m2, user: "U2", text: "to be deleted" });
    await discoverSlackConversations(T, { now: clock.now, sleep: clock.sleep });
    await syncSlackHistory(T, { now: clock.now, sleep: clock.sleep, enqueueContinuation: false });
    await handleEvent({ event: { type: "message", subtype: "message_changed", channel: "C1", event_ts: ts(START), message: { ts: m1, user: "U1", text: "quarterly report (final)", edited: { user: "U1", ts: ts(START) }, files: [file] }, previous_message: { ts: m1, user: "U1", text: "quarterly report" } } }, T, TOKEN, TEAM);
    await handleEvent({ event: { type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: m2, event_ts: ts(START + 1000) } }, T, TOKEN, TEAM);
    await drain();

    // Raw: the base message raw file has exactly one version; edit and delete are their own raw files.
    const raw = store.live("sources/slack/_raw/");
    const baseRaw = raw.find((p) => p.includes(`message:C1:${m1}`) && p.endsWith(`${encodeURIComponent(`slack:C1:${m1}`).replace(/%3A/g, ":")}.json`));
    expect(baseRaw).toBeDefined();
    expect(store.versions.get(baseRaw!)).toHaveLength(1);
    expect(store.json(baseRaw!).raw_payload.text).toBe("quarterly report");
    expect(raw.some((p) => p.includes(`:edit:`))).toBe(true);
    expect(raw.some((p) => p.includes(`:delete:`))).toBe(true);
    expect(raw.every((p) => p.startsWith(`sources/slack/_raw/workspace:${TEAM}/`))).toBe(true);

    // Projection: the donor channel-day file.
    expect(store.live("sources/slack/C1/").length).toBeGreaterThan(0);

    // Conversation label.
    const label = store.json(conversationLabelPath(TEAM, "C1"));
    expect(label).toMatchObject({ team_id: TEAM, channel_id: "C1", access: { state: "listed" }, history: { coverage: "complete_from_channel_start" } });

    // Exact bytes as a binary version, chunked; metadata without credentialed URLs.
    const bytesPath = fileBytesPath(TEAM, "F1", "report.pdf");
    const bin = store.current(bytesPath)!;
    expect(bin.kind).toBe("binary");
    expect(bin.contentType).toBe("application/pdf");
    expect(bin.bytes!.equals(BYTES)).toBe(true);
    expect(bin.sourceVersion).toEqual({ ref: "F1:1800000000", ordinal: 1800000000 });
    const meta = store.json(fileMetadataPath(TEAM, "F1"));
    expect(meta).toMatchObject({ file_id: "F1", channels: ["C1"], capture: { status: "stored", bytes_path: bytesPath, size: BYTES.length } });

    // No credential or credentialed URL reaches any published file.
    for (const path of store.live()) {
      const v = store.current(path)!;
      if (v.kind === "binary") continue;
      const text = v.bytes!.toString("utf8");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("files-pri");
      expect(text).not.toContain("files-tmb");
    }

    // Slack deletes the file: bytes and metadata are tombstoned, earlier versions retained.
    await handleFileDeleted({ type: "file_deleted", file_id: "F1", event_ts: ts(START + 5000) }, T, TEAM);
    await drain();
    expect(store.current(bytesPath)).toBeUndefined();
    expect(store.versions.get(bytesPath)!.map((v) => [v.op, v.reason ?? null])).toEqual([["put", null], ["delete", "slack_file_deleted"]]);
    expect(store.current(fileMetadataPath(TEAM, "F1"))).toBeUndefined();

    // Lost access relabels the conversation (the label gets a new version; history is kept).
    fake.unlist("C1");
    await discoverSlackConversations(T, { now: clock.now, sleep: clock.sleep });
    await drain();
    expect(store.json(conversationLabelPath(TEAM, "C1")).access.state).toBe("not_listed");
    expect(store.versions.get(conversationLabelPath(TEAM, "C1"))!.length).toBe(2);

    const coverage = await exporter.coverage(T);
    const slack = coverage.filter((c) => c.provider === "slack");
    expect(slack.find((c) => c.scope === `conversation:${TEAM}/C1`)?.state).toBe("blocked");
    expect(slack.find((c) => c.scope === `edits-deletes:${TEAM}`)?.state).toBe("partial");
    expect(slack.some((c) => c.state === "complete" && c.scope.startsWith("conversation:"))).toBe(false);
  });
});
