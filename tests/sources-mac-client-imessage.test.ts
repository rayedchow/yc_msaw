import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";

/**
 * Full chain for the Mac Messages uploader (macOS: @photon-ai/imessage-kit opens chat.db only on a Mac): the real
 * yc_msaw app mints `messagesConfig`, the vendored client (packages/shepherd-onboard) writes it with
 * `write-messages-config` plus the chats chosen on the Mac and runs `messages-agent` (isolated HOME, SYNTHETIC
 * chat.db) against the real runtime, whose default authority asks yc_msaw on every request. The owner's
 * all-history source sync request through yc_msaw is answered with a receipt (coverage complete), and revoking the
 * binding in yc_msaw stops collection at the next upload; the message stays queued on the Mac.
 */
process.env.DATABASE_URL ??= "postgres://localhost:5432/aqueduct_test";
process.env.ENCRYPTION_KEY ??= "aqueduct-test-encryption-key";
process.env.API_KEY_PEPPER ??= "aqueduct-test-api-key-pepper";
process.env.WORKOS_API_KEY ??= "sk_test_workos";
process.env.WORKOS_CLIENT_ID ??= "client_test_workos";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let rt: Any;
let runtime: { url: string; close: () => Promise<void> };
let app: App;
let dir: string;
let base: string;
let keys: Record<"admin" | "owner" | "member", string>;
// The vendored Mac client and its synthetic fixtures (packages/shepherd-onboard); loaded by path like the runtime
// harness so the root typecheck does not pull in the other packages.
let runCli: Any, startAgent: Any, waitFor: Any, appendMessages: Any, createChatDb: Any;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const call = (method: string, route: string, key: string, body?: unknown) =>
  fetch(base + route, { method, headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

beforeAll(async () => {
  const mac = "../packages/shepherd-onboard/tests/e2e/";
  ({ runCli, startAgent, waitFor } = await import(/* @vite-ignore */ `${mac}client.js`));
  ({ appendMessages, createChatDb } = await import(/* @vite-ignore */ `${mac}fixtures.js`));
  const harness = "../packages/sources-runtime/tests/source-lane/providers/imessage/harness.js";
  rt = await import(/* @vite-ignore */ harness);
  await rt.ready;
  await rt.resetTenant("acme");
  runtime = await rt.serveApp();
  const { generateStaticKey } = await import("../src/auth/static-keys.js");
  const admin = generateStaticKey("acme", ["memory:build", "memory:read"]);
  const owner = generateStaticKey("acme", ["traces:write", "memory:read"]);
  const member = generateStaticKey("acme", ["traces:write", "memory:read"]);
  keys = { admin: admin.key, owner: owner.key, member: member.key };
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-mac-client-imessage-"));
  const port = await freePort();
  const { createApp } = await import("../src/app.js");
  const { DirectoryObjectStore } = await import("../src/store/objects.js");
  app = await createApp({
    env: {
      HOST: "127.0.0.1", AUTH_MODE: "static", PROCMEM_STATIC_KEYS: [admin.entry, owner.entry, member.entry].join(","), PROCMEM_STATIC_KEYS_ON_MCP: "1",
      PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: dir, SOURCES_RUNTIME_SERVICE_TOKEN: rt.SERVICE_TOKEN,
      SOURCES_RUNTIME_URL: `${runtime.url}/internal/v1`, SOURCES_PUBLISH_URL: `http://127.0.0.1:${port}`, SOURCES_DEVICE_API_URL: runtime.url,
    },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => { throw new Error("no builds"); },
    leaseFactory: async () => { throw new Error("no sandboxes"); },
    log: () => undefined,
  });
  await app.listen(port);
  base = `http://127.0.0.1:${port}`;
  expect((await call("POST", "/v1/sources/runtime/provision", keys.admin)).status).toBe(201);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin")("vendored Mac Messages client through yc_msaw setup, commands and revocation", () => {
  let agent: Any = null;
  afterAll(async () => { await agent?.stop(); });

  it("uploads the chosen chats with the issued config, completes an owner-requested source sync, and stops when revoked", async () => {
    const home = mkdtempSync(path.join(dir, "mac-home-"));
    const chosen = "iMessage;-;+15550001111";
    try {
      createChatDb(home, [
        { guid: chosen, identifier: "+15550001111", style: 45, handles: ["+15550001111"] },
        { guid: "iMessage;-;+15550004444", identifier: "+15550004444", style: 45, handles: ["+15550004444"] },
      ]);
      appendMessages(home, [
        { guid: "CHAIN-1", chat: chosen, from: "+15550001111", text: "Standup at 10?", at: "2026-09-10T12:00:00.000Z" },
        { guid: "CHAIN-2", chat: chosen, text: "Yes.", at: "2026-09-10T12:01:00.000Z" },
        { guid: "CHAIN-3", chat: "iMessage;-;+15550004444", from: "+15550004444", text: "Not chosen.", at: "2026-09-10T12:02:00.000Z" },
      ]);

      const setup = await call("POST", "/v1/sources/devices/imessage/setup", keys.owner, { label: "Synthetic Mac", backfillDays: null });
      expect(setup.status).toBe(201);
      const { messagesConfig: cfg, binding } = (await setup.json()) as Any;
      expect(cfg).toMatchObject({ apiUrl: runtime.url, userId: "acme", agentToken: expect.stringMatching(/^gimsg_acme\./) });
      const written = await runCli(home, ["write-messages-config"], { stdin: JSON.stringify({ ...cfg, allowedChatIds: [chosen] }) });
      expect(written.code, written.stderr).toBe(0);
      const configPath = JSON.parse(written.stdout).configPath as string;
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ agentToken: cfg.agentToken, allowedChatIds: [chosen], backfillDays: null, backfillAllHistory: true });

      agent = startAgent(home, ["messages-agent", "--config", configPath], { SHEPHERD_MESSAGES_COMMAND_INTERVAL_MS: "300", SHEPHERD_MESSAGES_QUEUE_DRAIN_INTERVAL_MS: "300" });
      // The Mac writes into its enroller's owner scope of the tenant (personal-connection-attribution).
      const t = ((await rt.pg.query(`SELECT scope_tenant_id FROM source_lane_personal_devices WHERE binding_id = $1`, [binding.bindingId])).rows[0] as Any).scope_tenant_id as string;
      expect(t).toMatch(/^acme\.u-[0-9a-f]{24}$/);
      const events = async () => ((await rt.pg.query(`SELECT raw_payload FROM activity_events WHERE user_id = $1 AND source = 'imessage' ORDER BY (raw_payload->>'rowId')::int`, [t])).rows as Any[]).map((r) => r.raw_payload);
      const stored = await waitFor("the chosen chat's backfill", async () => ((await events()).length >= 2 ? events() : null), { agent, timeoutMs: 90_000 });
      expect(stored.map((m: Any) => m.messageId)).toEqual(["CHAIN-1", "CHAIN-2"]);

      const route = `/v1/sources/devices/imessage/${binding.bindingId}/commands`;
      expect((await call("POST", route, keys.member, { type: "messages_source_sync", coverageFrom: null })).status).toBe(403);
      const queued = await call("POST", route, keys.owner, { type: "messages_source_sync", coverageFrom: null });
      expect(queued.status).toBeLessThan(300);
      const commandId = ((await queued.json()) as Any).command.id as string;
      await waitFor("the source-sync receipt", async () => {
        const [r] = (await rt.pg.query(`SELECT r.status FROM source_sync_runs r JOIN imessage_device_commands c ON c.source_sync_run_id = r.id WHERE c.id = $1::uuid`, [commandId])).rows as Any[];
        return r?.status === "completed";
      }, { agent, timeoutMs: 90_000 });
      const coverage = "../packages/sources-runtime/src/source-lane/providers/imessage/coverage.js";
      const { imessageCoverage } = (await import(/* @vite-ignore */ coverage)) as Any;
      // The uploader posts its final idle status without awaiting it, so coverage settles just after the receipt.
      await waitFor("coverage to become complete", async () =>
        (await imessageCoverage({ tenantId: t, executor: rt.db })).find((c: Any) => c.scope === `device:${binding.bindingId}:messages`)?.state === "complete", { agent, timeoutMs: 90_000 });

      expect((await call("DELETE", `/v1/sources/bindings/${binding.bindingId}`, keys.admin)).status).toBe(200);
      appendMessages(home, [{ guid: "CHAIN-4", chat: chosen, from: "+15550001111", text: "After revoke.", at: "2026-09-11T08:00:00.000Z" }]);
      const queueFile = path.join(home, ".shepherd", "raw-messages", "acme-queue.json");
      await waitFor("the post-revoke message to stay queued on the Mac", async () =>
        existsSync(queueFile) && (JSON.parse(readFileSync(queueFile, "utf8")) as Any[]).some((m) => m.messageId === "CHAIN-4"), { agent, timeoutMs: 90_000 });
      expect((await events()).map((m: Any) => m.messageId)).toEqual(["CHAIN-1", "CHAIN-2"]);
    } finally {
      await agent?.stop();
      agent = null;
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
