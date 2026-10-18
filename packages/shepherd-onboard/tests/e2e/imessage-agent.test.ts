import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLI, runCli, startAgent, waitFor, type Agent } from "./client.js";
import { appendMessages, createAddressBook, createChatDb, mutateMessage } from "./fixtures.js";
import { imessageCoverage, startRuntime, type Runtime } from "./runtime.js";

/**
 * The vendored Mac Messages uploader end to end against the production runtime iMessage routes and the production
 * HTTP device authority:
 *  - capture: the real `messages-agent` child process (the LaunchAgent program) reads a SYNTHETIC
 *    ~/Library/Messages/chat.db through @photon-ai/imessage-kit, resolves names from a synthetic AddressBook,
 *    uploads only the chats selected in its config (written by the real `write-messages-config`), picks up a new
 *    message live from the WAL, answers an all-history `messages_source_sync` with a receipt, and stops storing
 *    the moment yc_msaw revokes the device (unsent messages stay in its local retry queue);
 *  - transport: the client's MessagesBatchSender splits a large upload into bounded batches.
 * imessage-kit only opens chat.db on macOS, so the capture test needs a Mac (this is the Mac client).
 */

const SELECTED_DM = "iMessage;-;+15550001111";
const SELECTED_GROUP = "iMessage;+;chat900000001";
const UNSELECTED_DM = "iMessage;-;+15550004444";
let rt: Runtime;
let root: string;

beforeAll(async () => {
  rt = await startRuntime();
  root = mkdtempSync(path.join(os.tmpdir(), "shepherd-onboard-imessage-e2e-"));
});

afterAll(async () => {
  await rt?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const events = (tenant: string) => rt.query<{ source_event_id: string; raw_payload: Record<string, any> }>(
  `SELECT source_event_id, raw_payload FROM activity_events WHERE user_id = $1 AND source = 'imessage' ORDER BY (raw_payload->>'rowId')::int`, [tenant]);

describe.runIf(process.platform === "darwin")("vendored messages-agent capture -> production runtime (macOS)", () => {
  let agent: Agent | null = null;
  afterAll(async () => { await agent?.stop(); });

  it("uploads only the selected chats from chat.db, live and on source_sync, and stops at revocation", async () => {
    const tenant = "acme";
    const home = mkdtempSync(path.join(root, "home-"));
    createChatDb(home, [
      { guid: SELECTED_DM, identifier: "+15550001111", style: 45, handles: ["+15550001111"] },
      { guid: SELECTED_GROUP, identifier: "chat900000001", style: 43, displayName: "Synthetic launch group", handles: ["+15550002222", "+15550003333"] },
      { guid: UNSELECTED_DM, identifier: "+15550004444", style: 45, handles: ["+15550004444"] },
    ]);
    appendMessages(home, [
      { guid: "SYN-1", chat: SELECTED_DM, from: "+15550001111", text: "Lunch tomorrow?", at: "2026-09-10T12:00:00.000Z" },
      { guid: "SYN-2", chat: SELECTED_DM, text: "Yes, noon works.", at: "2026-09-10T12:01:00.000Z" },
      { guid: "SYN-3", chat: SELECTED_DM, from: "+15550001111", text: "Loved “Yes, noon works.”", at: "2026-09-10T12:02:00.000Z", reactionTo: { guid: "SYN-2", type: 2000 } },
      { guid: "SYN-4", chat: SELECTED_DM, from: "+15550001111", text: "￼", at: "2026-09-10T12:03:00.000Z", attachment: { guid: "ATT-1", name: "menu.jpg", mime: "image/jpeg", bytes: 48213 } },
      { guid: "SYN-5", chat: SELECTED_GROUP, from: "+15550002222", text: "Ship it Friday.", at: "2026-09-11T09:00:00.000Z" },
      { guid: "SYN-6", chat: UNSELECTED_DM, from: "+15550004444", text: "This chat was never selected.", at: "2026-09-11T10:00:00.000Z" },
    ]);
    createAddressBook(home, [
      { first: "Grace", last: "Hopper", phone: "+1 (555) 000-1111" },
      { first: "Alan", last: "Turing", phone: "+15550002222" },
      { first: "Never", last: "Selected", phone: "+15550004444" },
    ]);

    await rt.bindTenant(tenant);
    const device = await rt.enrollImessage(tenant);
    // The config exactly as yc_msaw's setup route returns it (messagesConfig), written by the real CLI command.
    const written = await runCli(home, ["write-messages-config"], {
      stdin: JSON.stringify({ apiUrl: rt.url, userId: tenant, agentToken: device.key, backfillDays: null, allowedChatIds: [SELECTED_DM, SELECTED_GROUP] }),
    });
    expect(written.code, written.stderr).toBe(0);
    const { configPath } = JSON.parse(written.stdout) as { configPath: string };
    expect(configPath).toBe(path.join(home, ".shepherd", "raw-messages", "acme.json"));

    agent = startAgent(home, ["messages-agent", "--config", configPath], {
      SHEPHERD_MESSAGES_COMMAND_INTERVAL_MS: "300",
      SHEPHERD_MESSAGES_QUEUE_DRAIN_INTERVAL_MS: "300",
      SHEPHERD_MESSAGES_BACKFILL_RETRY_INTERVAL_MS: "300",
      SHEPHERD_MESSAGES_EDIT_SCAN_INTERVAL_MS: "300",
      // Edits to messages older than the 30-minute edit-scan window are found by the mutation reconciler (15 min).
      SHEPHERD_MESSAGES_MUTATION_RECONCILE_INTERVAL_MS: "300",
    });

    // All-history backfill of the selected chats only.
    const stored = await waitFor("the selected chats' backfill", async () => ((await events(tenant)).length >= 5 ? events(tenant) : null), { agent });
    expect(stored.map((e) => e.raw_payload.messageId)).toEqual(["SYN-1", "SYN-2", "SYN-3", "SYN-4", "SYN-5"]);
    const byId = Object.fromEntries(stored.map((e) => [e.raw_payload.messageId, e.raw_payload]));
    // Donor quirk kept as is: the AddressBook query joins first/middle/last with single spaces, so an empty middle
    // name yields "Grace  Hopper" (two spaces). Cosmetic; recorded in the delivery report.
    const name = (v: unknown) => String(v).replace(/\s+/g, " ");
    expect(byId["SYN-1"]).toMatchObject({ text: "Lunch tomorrow?", chatId: SELECTED_DM, chatKind: "dm", participant: "+15550001111", isFromMe: false, agentVersion: "0.1.45" });
    expect(name(byId["SYN-1"]._resolved_name)).toBe("Grace Hopper");
    expect(byId["SYN-2"]).toMatchObject({ isFromMe: true, createdAt: "2026-09-10T12:01:00.000Z" });
    // chat.db stores tapback targets as "p:<part>/<guid>"; the client sends them as stored.
    expect(byId["SYN-3"].reaction).toMatchObject({ kind: "love", targetMessageId: "p:0/SYN-2", isRemoved: false });
    expect(byId["SYN-4"].attachments).toEqual([expect.objectContaining({ fileName: "menu.jpg", mimeType: "image/jpeg", sizeBytes: 48213, transferStatus: "complete" })]);
    expect(byId["SYN-5"]).toMatchObject({ chatId: SELECTED_GROUP, chatKind: "group", participant: "+15550002222" });
    expect(name(byId["SYN-5"]._resolved_name)).toBe("Alan Turing");
    expect(JSON.stringify(stored)).not.toContain("never selected");

    // Contact names for the selected chats' handles reach the runtime's contacts table.
    const contacts = await waitFor("contact sync", async () => {
      const rows = await rt.query<{ handle: string; name: string }>(`SELECT handle, name FROM imessage_contacts WHERE tenant_id = $1 ORDER BY name`, [tenant]);
      return rows.length >= 2 ? rows : null;
    }, { agent });
    expect(contacts.map((c) => name(c.name))).toEqual(expect.arrayContaining(["Alan Turing", "Grace Hopper"]));
    expect(contacts.map((c) => name(c.name))).not.toContain("Never Selected");

    // Live: a new message written to chat.db (WAL) is picked up by the watcher.
    appendMessages(home, [
      { guid: "SYN-7", chat: SELECTED_DM, from: "+15550001111", text: "See you there.", at: "2026-09-12T08:00:00.000Z" },
      { guid: "SYN-8", chat: UNSELECTED_DM, from: "+15550004444", text: "Still not selected.", at: "2026-09-12T08:01:00.000Z" },
    ]);
    await waitFor("the live message", async () => (await events(tenant)).some((e) => e.raw_payload.messageId === "SYN-7"), { agent });

    // Edits and unsends in chat.db: older messages through the mutation reconciler, a just-sent one through the
    // 30-minute edit scan. The runtime keeps each earlier version.
    const justNow = new Date(Date.now() - 60_000).toISOString();
    appendMessages(home, [{ guid: "SYN-10", chat: SELECTED_DM, text: "On my way", at: justNow }]);
    await waitFor("the just-sent message", async () => (await events(tenant)).some((e) => e.raw_payload.messageId === "SYN-10"), { agent });
    mutateMessage(home, "SYN-2", { text: "Yes, 12:30 works.", editedAt: "2026-09-10T12:05:00.000Z" });
    mutateMessage(home, "SYN-7", { text: null, retractedAt: "2026-09-12T08:01:30.000Z" });
    mutateMessage(home, "SYN-10", { text: "On my way, 5 min", editedAt: new Date().toISOString() });
    const mutated = await waitFor("the edits and unsend", async () => {
      const rows = await rt.query<{ source_event_id: string; kinds: string[]; previous_payload: Record<string, any> }>(
        `SELECT source_event_id, kinds, previous_payload FROM imessage_message_mutations WHERE tenant_id = $1 ORDER BY observed_at`, [tenant]);
      return rows.length >= 3 ? rows : null;
    }, { agent, timeoutMs: 20_000 });
    expect(mutated.find((m) => m.previous_payload.messageId === "SYN-10")).toMatchObject({ previous_payload: { text: "On my way" } });
    expect(mutated.find((m) => m.previous_payload.messageId === "SYN-2")).toMatchObject({ previous_payload: { text: "Yes, noon works." } });
    expect(mutated.find((m) => m.previous_payload.messageId === "SYN-7")).toMatchObject({ previous_payload: { text: "See you there." } });
    const current = Object.fromEntries((await events(tenant)).map((e) => [e.raw_payload.messageId, e.raw_payload]));
    expect(current["SYN-2"]).toMatchObject({ text: "Yes, 12:30 works.", editedAt: "2026-09-10T12:05:00.000Z" });
    expect(current["SYN-7"]).toMatchObject({ retractedAt: "2026-09-12T08:01:30.000Z" });

    // An all-history source sync requested through the runtime is answered with a validated receipt.
    const sync = await rt.internal("POST", `/tenants/${tenant}/devices/imessage/${device.bindingId}/commands`, tenant, { type: "messages_source_sync", coverageFrom: null });
    expect(sync.status, JSON.stringify(sync.body)).toBeLessThan(300);
    const run = await waitFor("the source-sync receipt", async () => {
      const [r] = await rt.query<{ status: string }>(`SELECT r.status FROM source_sync_runs r JOIN imessage_device_commands c ON c.source_sync_run_id = r.id WHERE c.id = $1::uuid`, [sync.body.command.id]);
      return r?.status === "completed" ? r : null;
    }, { agent });
    expect(run.status).toBe("completed");
    // The uploader posts its final idle status without awaiting it, so coverage settles just after the receipt.
    const cov = await waitFor("coverage to become complete", async () => {
      const c = await imessageCoverage({ tenantId: tenant, executor: rt.db });
      return c.find((r) => r.scope === `device:${device.bindingId}:messages`)?.state === "complete" ? c : null;
    }, { agent });
    expect(cov.find((c) => c.scope === `device:${device.bindingId}:messages`)).toMatchObject({ state: "complete", counts: { messages: 7 } });
    expect(cov.find((c) => c.scope === "attachments")).toMatchObject({ state: "partial", counts: { attachmentsWithMetadataOnly: 1 } });

    // The exported files carry the selected conversations only.
    const files = await rt.exportAll(tenant);
    expect(files.some((c) => c.op === "put" && c.path.startsWith("sources/imessage/conversations/"))).toBe(true);
    expect(JSON.stringify(files.map((c) => c.path))).not.toContain("5550004444");
    const months = files.filter((c) => c.op === "put" && /^sources\/imessage\/conversations\/.*\/2026-09\.md$/.test(c.path)).map((c) => Buffer.from(c.inline, "base64").toString("utf8"));
    const dm = months.find((m) => m.includes("Conversation ID: imessage:dm:+15550001111"))!;
    expect(dm).toContain("Grace Hopper: Lunch tomorrow?");
    expect(dm).toMatch(/me: Yes, 12:30 works\./u);
    expect(dm).toContain("Yes, noon works."); // the earlier version stays visible in the edit history
    expect(dm).toMatch(/- reactions: ❤️ Grace +Hopper/u);
    expect(dm).toContain("[attachment: menu.jpg (image/jpeg, 47 KB); metadata only]");
    expect(dm).toContain("See you there."); // unsent, rendered with the text it had
    expect(months.find((m) => m.includes("# Synthetic launch group - 2026-09"))).toContain("Alan Turing: Ship it Friday.");
    expect(months).toHaveLength(2);

    // Revoked in yc_msaw: the next upload is refused, the runtime revokes the device, and the message stays queued
    // on the Mac.
    rt.yc.revoked.add(device.bindingId);
    appendMessages(home, [{ guid: "SYN-9", chat: SELECTED_DM, from: "+15550001111", text: "After revocation.", at: "2026-09-13T08:00:00.000Z" }]);
    const queueFile = path.join(home, ".shepherd", "raw-messages", "acme-queue.json");
    const queued = await waitFor("the revoked upload to be queued locally", async () => {
      if (!existsSync(queueFile)) return null;
      const q = JSON.parse(readFileSync(queueFile, "utf8")) as Array<{ messageId: string }>;
      return q.some((m) => m.messageId === "SYN-9") ? q : null;
    }, { agent });
    expect(queued.map((m) => m.messageId)).toContain("SYN-9");
    expect((await events(tenant)).map((e) => e.raw_payload.messageId)).not.toContain("SYN-9");
    expect((await rt.query(`SELECT status FROM imessage_devices WHERE binding_id = $1`, [device.bindingId]))[0]).toEqual({ status: "revoked" });
    const blocked = await imessageCoverage({ tenantId: tenant, executor: rt.db });
    expect(blocked.find((c) => c.scope === `device:${device.bindingId}:messages`)).toMatchObject({ state: "blocked" });
    await agent.stop();
    agent = null;
    // Nothing in the agent's local state names the unselected chat either.
    const state = readdirSync(path.join(home, ".shepherd", "raw-messages")).map((f) => readFileSync(path.join(home, ".shepherd", "raw-messages", f), "utf8")).join("\n");
    expect(state).not.toContain("never selected");
  }, 120_000);
});

describe("vendored MessagesBatchSender -> production runtime (any platform)", () => {
  it("splits a large upload into bounded batches (500 per request) that the runtime accepts and dedupes on replay", async () => {
    const tenant = "batches";
    const home = mkdtempSync(path.join(root, "home-"));
    vi.stubEnv("HOME", home);
    try {
      const { __test } = await import(/* @vite-ignore */ `${pathToFileURL(CLI).href}?batches=${Date.now()}`);
      await rt.bindTenant(tenant);
      const device = await rt.enrollImessage(tenant);
      const sender = new __test.MessagesBatchSender(rt.url, device.key, tenant, "test", { deviceId: "11111111-1111-4111-8111-111111111111" });
      const messages = Array.from({ length: 1_201 }, (_, i) => ({
        messageId: `BATCH-${i}`, providerMessageGuid: `BATCH-${i}`, _provider_guid_explicit: true, deviceId: "11111111-1111-4111-8111-111111111111",
        agentVersion: "0.1.45", agentChannel: "test", localRowId: i + 1, rowId: i + 1, text: `synthetic ${i}`, service: "iMessage",
        chatId: SELECTED_DM, chatKind: "dm", chatName: null, participant: "+15550001111", isFromMe: i % 2 === 0,
        createdAt: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(), deliveredAt: null, readAt: null, editedAt: null, retractedAt: null,
        reaction: null, hasAttachments: false, attachments: [], replyToMessageId: null, threadRootMessageId: null, sendEffect: null, kind: "text",
        isAudioMessage: false, isForwarded: false, affectedParticipant: null, newGroupName: null, _resolved_name: null, _is_self_handle: false,
      }));
      const before = rt.yc.calls;
      const r = await sender.send(messages);
      expect(r).toMatchObject({ queued: 0 });
      // ceil(1201 / 500) = 3 requests, each verified with yc_msaw once.
      expect(rt.yc.calls - before).toBe(3);
      expect((await events(tenant)).length).toBe(1_201);
      const replay = await sender.send(messages.slice(0, 600));
      expect(Number(replay.stored)).toBe(0);
      expect((await events(tenant)).length).toBe(1_201);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);
});
