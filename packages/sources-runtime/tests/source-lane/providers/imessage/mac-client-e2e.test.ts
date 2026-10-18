import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app, enroll, events, fakeAuthority, internal, message, query, ready, resetTenant, serveApp } from "./harness.js";

/**
 * Client -> server end to end: the bundled Mac uploader's real HTTP client (gigabrain@5448774e
 * packages/shepherd-onboard/bin/shepherd-onboard.js `MessagesBatchSender`, loaded from the audit clone, never
 * copied) talks over a loopback socket to this runtime's public iMessage routes. It covers batched ingest with the
 * client's own batching and retry queue, contact sync, local status, the command/ack round trip, and
 * fail-closed revocation. chat.db reading (@photon-ai/imessage-kit, Full Disk Access) is the only layer not
 * exercised; the payloads use the uploader wire shape from ./harness.ts.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.SHEPHERD_ONBOARD_BIN ?? path.resolve(here, "../../../../../../../gigabrain/packages/shepherd-onboard/bin/shepherd-onboard.js");
const T = "acme";
const AGENT = { deviceId: "11111111-1111-4111-8111-111111111111", agentVersion: "0.9.0-test", agentChannel: "test" };

describe.skipIf(!existsSync(CLI))("bundled Mac uploader client against the runtime iMessage routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let home: string;
  let Sender: new (apiUrl: string, token: string, userId: string, channel: string, options: Record<string, unknown>) => any;

  beforeAll(async () => {
    await ready;
    server = await serveApp(app);
    home = await mkdtemp(path.join(os.tmpdir(), "imessage-mac-client-"));
    vi.stubEnv("HOME", home);
    const mod = await import(/* @vite-ignore */ `${pathToFileURL(CLI).href}?e2e=${Date.now()}`);
    Sender = mod.__test.MessagesBatchSender;
  });

  afterAll(async () => {
    await server?.close();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTenant(T);
    fakeAuthority.down = false;
  });

  it("uploads in client-sized batches, syncs contacts and status, and completes a command round trip", async () => {
    const d = await enroll(T);
    const sender = new Sender(server.url, d.key, T, "test", { ...AGENT, batchSize: 2 });
    const sent = [message({ rowId: 1 }), message({ rowId: 2, text: "second" }), message({ rowId: 3, text: "third é😀" })];
    const r = await sender.send(sent);
    expect(r).toMatchObject({ queued: 0 });
    expect(Number(r.stored) + Number(r.updated)).toBe(3);
    const stored = (await events(T)).filter((e) => e.record_kind !== "contact");
    expect(stored.map((e) => e.raw_payload.text).sort()).toEqual(["hello", "second", "third é😀"]);
    // Replaying the same batch (the client's retry-from-first-failure behaviour) is deduped server-side.
    const replay = await sender.send(sent);
    expect(Number(replay.stored)).toBe(0);
    expect((await events(T)).filter((e) => e.record_kind !== "contact")).toHaveLength(3);

    await expect(sender.syncContacts([{ handle: "+15550001111", name: "Grace Hopper" }])).resolves.toBeTruthy();
    expect(await query(`SELECT tenant_id FROM imessage_contacts`)).toEqual([{ tenant_id: T }]);
    await expect(sender.postLocalStatus({ status: "idle", queuedMessages: 0 })).resolves.toBeTruthy();

    // A backfill command requested by an admin reaches the client, and its ack retires it.
    expect((await internal("POST", `/tenants/${T}/devices/imessage/${d.bindingId}/commands`, { tenant: T, body: { backfillDays: 30 } })).status).toBeLessThan(300);
    const cmd = await sender.fetchCommand();
    expect(cmd).toMatchObject({ id: expect.any(String) });
    await expect(sender.ackCommand(cmd.id, { status: "completed", result: { scannedMessages: 3 } })).resolves.toBeTruthy();
    expect(await sender.fetchCommand()).toBeNull();
  });

  it("fails closed when yc_msaw is unreachable or the key is revoked, keeping unsent messages in the client queue", async () => {
    const d = await enroll(T);
    const sender = new Sender(server.url, d.key, T, "test", AGENT);

    fakeAuthority.down = true;
    const unavailable = await sender.send([message({ rowId: 7, text: "while yc_msaw is down" })]);
    expect(unavailable.queued).toBe(1);
    expect(await events(T)).toEqual([]);
    await expect(sender.fetchCommand()).rejects.toThrow();

    fakeAuthority.down = false;
    fakeAuthority.revoked.add(d.bindingId);
    const revoked = await sender.send([message({ rowId: 8, text: "after revoke" })]);
    expect(revoked.queued).toBe(2);
    expect(await events(T)).toEqual([]);
    await expect(sender.syncContacts([{ handle: "+15550001111", name: "Grace" }])).rejects.toThrow();
    expect((await query(`SELECT status FROM imessage_devices WHERE binding_id = $1`, [d.bindingId]))[0]!.status).toBe("revoked");
    // The client's durable retry queue (under its HOME) still holds both messages for a re-enrolled device.
    const queue = JSON.parse(readFileSync(sender.queueFile, "utf8")) as Array<{ text: string }>;
    expect(queue.map((m) => m.text).sort()).toEqual(["after revoke", "while yc_msaw is down"]);
  });
});
