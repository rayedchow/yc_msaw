import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { codingSessionsCoverage } from "../../../../src/integrations/coding-sessions/lane.js";
import { app, db, enroll, fakeAuthority, internal, pg, ready, resetTenant, serveApp } from "./harness.js";

/**
 * Client -> server end to end: the bundled Mac agent (gigabrain@5448774e packages/shepherd-onboard
 * `coding-sessions-agent --once`, run unmodified from the audit clone as a child process with an isolated HOME)
 * scans a synthetic Codex transcript and talks over a loopback socket to this runtime's coding-sessions routes:
 * upload, the source_sync command and its receipt, and fail-closed revocation. Synthetic transcripts only.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.SHEPHERD_ONBOARD_BIN ?? path.resolve(here, "../../../../../../../gigabrain/packages/shepherd-onboard/bin/shepherd-onboard.js");
const T = "acme";

function runAgent(home: string, configPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, "coding-sessions-agent", "--config", configPath, "--once"], { env: { PATH: process.env.PATH, HOME: home, SHEPHERD_ONBOARD_HOME: home }, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const q = async <T = Record<string, any>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows;

describe.skipIf(!existsSync(CLI))("bundled Mac coding-sessions agent against the runtime routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let home: string;
  let configFor: (key: string) => string;

  beforeAll(async () => {
    await ready;
    server = await serveApp(app);
    home = await mkdtemp(path.join(os.tmpdir(), "coding-sessions-mac-client-"));
    const codexDir = path.join(home, ".codex", "sessions");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(codexDir, "session-e2e.jsonl"), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-09-24T10:00:00.000Z", payload: { session_id: "session-e2e", timestamp: "2026-09-24T10:00:00.000Z", cwd: path.join(home, "repo") } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-24T10:01:00.000Z", payload: { id: "user-1", type: "message", role: "user", content: [{ type: "input_text", text: "Add a retry to the uploader." }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-24T10:03:00.000Z", payload: { id: "agent-1", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Added exponential backoff and a test." }] } }),
    ].join("\n") + "\n");
    configFor = (key: string) => {
      const p = path.join(home, `config-${key.slice(-6)}.json`);
      writeFileSync(p, JSON.stringify({ apiUrl: server.url, userId: T, agentToken: key, providers: { openai: true, anthropic: false }, codexDirs: [codexDir], claudeProjectsDir: null }));
      return p;
    };
  });

  afterAll(async () => {
    await server?.close();
    if (home) await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTenant(T);
    fakeAuthority.down = false;
  });

  it("uploads the scanned transcript and completes a source_sync command with an honest receipt", async () => {
    const d = await enroll(T);
    const sync = await (await internal("POST", `/tenants/${T}/devices/coding-sessions/${d.bindingId}/commands`, T, { type: "source_sync", coverageFrom: null })).json() as { id: string };
    const r = await runAgent(home, configFor(d.key));
    expect(r.code, r.stderr).toBe(0);
    const rows = await q(`SELECT * FROM coding_sessions WHERE tenant_id = $1`, [T]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain("session-e2e");
    expect(JSON.stringify(rows[0])).toContain("Added exponential backoff and a test.");
    const [cmd] = await q<{ status: string; result: Record<string, unknown> }>(`SELECT status, result FROM coding_session_commands WHERE id = $1`, [sync.id]);
    expect(cmd!.status).toBe("completed");
    // One file, under the agent's cap: a genuine full inventory, so coverage may say complete.
    expect(cmd!.result).toMatchObject({ provider: "coding_sessions", fullInventory: true, exhausted: true, capHit: false });
    expect((await codingSessionsCoverage({ tenantId: T, executor: db as never }))[0]!.state).toBe("complete");
  });

  it("stores nothing once the key is revoked", async () => {
    const d = await enroll(T);
    fakeAuthority.revoked.add(d.bindingId);
    await runAgent(home, configFor(d.key));
    expect(await q(`SELECT 1 FROM coding_sessions WHERE tenant_id = $1`, [T])).toEqual([]);
    expect((await q<{ status: string }>(`SELECT status FROM coding_session_devices WHERE binding_id = $1`, [d.bindingId]))[0]!.status).toBe("revoked");
  });
});
