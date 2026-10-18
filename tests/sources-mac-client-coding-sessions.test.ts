import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";

/**
 * Full chain for the Mac coding-sessions uploader: the real yc_msaw app mints the device config, the vendored
 * client (packages/shepherd-onboard) writes it with `write-coding-sessions-config` and runs
 * `coding-sessions-agent --once` (isolated HOME, synthetic Codex/Claude transcripts) against the real runtime,
 * whose default authority asks yc_msaw on every request. The device owner requests a source sync through yc_msaw
 * (another member of the same org cannot), the receipt makes coverage complete, and revoking the binding in
 * yc_msaw stops collection while unsent sessions stay on the Mac.
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
let runCli: Any, writeClaudeSession: Any, writeCodexSession: Any;

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
  ({ runCli } = await import(/* @vite-ignore */ `${mac}client.js`));
  ({ writeClaudeSession, writeCodexSession } = await import(/* @vite-ignore */ `${mac}fixtures.js`));
  const harness = "../packages/sources-runtime/tests/source-lane/providers/coding-sessions/harness.js";
  rt = await import(/* @vite-ignore */ harness);
  await rt.ready;
  await rt.resetTenant("acme");
  runtime = await rt.serveApp();
  const { generateStaticKey } = await import("../src/auth/static-keys.js");
  const admin = generateStaticKey("acme", ["memory:build", "memory:read"]);
  const owner = generateStaticKey("acme", ["traces:write", "memory:read"]);
  const member = generateStaticKey("acme", ["traces:write", "memory:read"]);
  keys = { admin: admin.key, owner: owner.key, member: member.key };
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-mac-client-coding-"));
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

describe("vendored Mac coding-sessions client through yc_msaw setup, commands and revocation", () => {
  it("collects with the issued config, completes an owner-requested source sync, and stops when revoked", async () => {
    const home = mkdtempSync(path.join(dir, "mac-home-"));
    try {
      writeCodexSession(path.join(home, ".codex", "sessions", "2026", "09"), "chain-codex-1", "2026-09-20T10:00:00.000Z", "Add retries.", "Added retries with jitter.");
      writeCodexSession(path.join(home, ".codex", "archived_sessions"), "chain-codex-0", "2026-08-02T10:00:00.000Z", "Old work.", "Done.");
      writeClaudeSession(path.join(home, ".claude", "projects"), "chain-claude-1", "2026-09-21T09:00:00.000Z", "Rename helper.", "Renamed.");

      const setup = await call("POST", "/v1/sources/devices/coding-sessions/setup", keys.owner, { label: "Synthetic Mac", intervalSeconds: 300 });
      expect(setup.status).toBe(201);
      const { codingSessionsConfig: cfg, binding } = (await setup.json()) as Any;
      const written = await runCli(home, ["write-coding-sessions-config"], { stdin: JSON.stringify({ ...cfg, providers: { openai: true, anthropic: true } }) });
      expect(written.code, written.stderr).toBe(0);
      const configPath = JSON.parse(written.stdout).configPath as string;
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ apiUrl: runtime.url, userId: "acme", agentToken: cfg.agentToken, intervalSeconds: 300 });

      // Only the enrolling member may command the device; bad bodies and unknown bindings are refused.
      const route = `/v1/sources/devices/coding-sessions/${binding.bindingId}/commands`;
      expect((await call("POST", route, keys.member, { type: "source_sync" })).status).toBe(403);
      expect((await call("POST", route, keys.admin, { type: "source_sync" })).status).toBe(403);
      expect((await call("POST", route, keys.owner, { type: "source_sync", maxFiles: 5 })).status).toBe(400);
      expect((await call("POST", route, keys.owner, { type: "delete_everything" })).status).toBe(400);
      expect((await call("POST", "/v1/sources/devices/coding-sessions/sb-0000000000000000/commands", keys.owner, { type: "source_sync" })).status).toBe(404);
      expect((await call("POST", `/v1/sources/devices/office-audio/${binding.bindingId}/commands`, keys.owner, { type: "source_sync" })).status).toBe(404);
      const queued = await call("POST", route, keys.owner, { type: "source_sync", coverageFrom: null });
      expect(queued.status).toBe(201);
      const command = (await queued.json()) as Any;

      const run = await runCli(home, ["coding-sessions-agent", "--config", configPath, "--once"]);
      expect(run.code, run.stderr).toBe(0);
      // The device writes into its enroller's owner scope of the tenant (personal-connection-attribution).
      const t = ((await rt.pg.query(`SELECT scope_tenant_id FROM source_lane_personal_devices WHERE binding_id = $1`, [binding.bindingId])).rows[0] as Any).scope_tenant_id as string;
      expect(t).toMatch(/^acme\.u-[0-9a-f]{24}$/);
      const rows = (await rt.pg.query(`SELECT provider, session_id FROM coding_sessions WHERE tenant_id = $1 ORDER BY session_id`, [t])).rows as Any[];
      expect(rows.map((r) => `${r.provider}:${r.session_id}`)).toEqual(["claude:chain-claude-1", "codex:chain-codex-0", "codex:chain-codex-1"]);
      const [cmd] = (await rt.pg.query(`SELECT status, result FROM coding_session_commands WHERE id = $1`, [command.id])).rows as Any[];
      expect(cmd).toMatchObject({ status: "completed", result: { fullInventory: true, exhausted: true, capHit: false, sessionsSeen: 3 } });
      const lane = "../packages/sources-runtime/src/integrations/coding-sessions/lane.js";
      const { codingSessionsCoverage } = (await import(/* @vite-ignore */ lane)) as Any;
      expect((await codingSessionsCoverage({ tenantId: t, executor: rt.db }))[0]).toMatchObject({ state: "complete" });

      // Revoked in yc_msaw: the next run is refused and the new transcript stays in the Mac's retry queue.
      expect((await call("DELETE", `/v1/sources/bindings/${binding.bindingId}`, keys.admin)).status).toBe(200);
      expect((await call("POST", route, keys.owner, { type: "source_sync" })).status).toBe(404);
      writeCodexSession(path.join(home, ".codex", "sessions", "2026", "09"), "chain-codex-2", "2026-09-22T10:00:00.000Z", "After revoke.", "Not uploaded.");
      expect((await runCli(home, ["coding-sessions-agent", "--config", configPath, "--once"])).code).toBe(0);
      expect(((await rt.pg.query(`SELECT count(*)::int AS n FROM coding_sessions WHERE tenant_id = $1`, [t])).rows[0] as Any).n).toBe(3);
      const queueDir = path.join(home, ".shepherd", "coding-sessions");
      const queue = readdirSync(queueDir).filter((f) => f.endsWith("-queue.json")).flatMap((f) => JSON.parse(readFileSync(path.join(queueDir, f), "utf8")) as Any[]);
      expect(queue.map((s) => s.sessionId)).toEqual(["chain-codex-2"]);
      expect(existsSync(path.join(home, "Library", "LaunchAgents"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
