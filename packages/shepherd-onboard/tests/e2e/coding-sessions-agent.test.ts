import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM helper without types
import { materializeDonor, readVendor } from "../../scripts/verify-vendor.mjs";
import { clientEnv, PACKAGE_DIR, runCli } from "./client.js";
import { writeClaudeSession, writeCodexSession } from "./fixtures.js";
import { codingSessionsCoverage, startRuntime, type Runtime } from "./runtime.js";

/**
 * The vendored Mac coding-sessions agent (`coding-sessions-agent --once`, a child process with a synthetic HOME)
 * against the production runtime routes and the production HTTP device authority. Covers the full-inventory
 * source_sync fix past the 1,000-file default cap, honest receipts for an explicitly bounded sync, batches
 * within the runtime's 50-session limit, fail-closed revocation and yc_msaw outages with the client's retry queue.
 */

const DEFAULT_CAP = 1_000;
const CODEX_FILES = DEFAULT_CAP + 5;
let rt: Runtime;
let root: string;

function codexFixture(home: string): { codexDir: string; claudeDir: string } {
  const codexDir = path.join(home, ".codex", "sessions", "2026", "09");
  const claudeDir = path.join(home, ".claude", "projects");
  for (let i = 0; i < CODEX_FILES; i++) {
    const at = new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();
    // Older files get older mtimes, so a capped scan keeps the newest 1,000 and drops session-0000..0004.
    writeCodexSession(codexDir, `session-${String(i).padStart(4, "0")}`, at, `Synthetic request ${i}`, `Synthetic answer ${i}`, 1_780_000_000 + i);
  }
  writeClaudeSession(claudeDir, "claude-session-a", "2026-09-20T08:00:00.000Z", "Rename the helper.", "Renamed it and updated the call sites.");
  return { codexDir: path.join(home, ".codex", "sessions"), claudeDir };
}

function writeConfig(home: string, tenant: string, key: string, dirs: { codexDir: string; claudeDir: string }): string {
  const file = path.join(home, `coding-sessions-${key.slice(-6)}.json`);
  writeFileSync(file, JSON.stringify({ apiUrl: rt.url, userId: tenant, agentToken: key, providers: { openai: true, anthropic: true }, codexDirs: [dirs.codexDir], claudeProjectsDir: dirs.claudeDir }));
  return file;
}

async function command(tenant: string, bindingId: string, body: Record<string, unknown>) {
  const r = await rt.internal("POST", `/tenants/${tenant}/devices/coding-sessions/${bindingId}/commands`, tenant, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; payload: Record<string, unknown> };
}

const commandRow = async (id: string) => (await rt.query<{ status: string; result: Record<string, any> | null; error_message: string | null }>(`SELECT status, result, error_message FROM coding_session_commands WHERE id = $1`, [id]))[0]!;
const sessionCount = async (tenant: string) => Number((await rt.query<{ n: number }>(`SELECT count(*)::int AS n FROM coding_sessions WHERE tenant_id = $1`, [tenant]))[0]!.n);
const coverage = async (tenant: string) => (await codingSessionsCoverage({ tenantId: tenant, executor: rt.db }))[0]!;

beforeAll(async () => {
  rt = await startRuntime();
  root = mkdtempSync(path.join(os.tmpdir(), "shepherd-onboard-coding-e2e-"));
});

afterAll(async () => {
  await rt?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("vendored coding-sessions agent -> production runtime", () => {
  it("answers the runtime's source_sync with a full inventory past the 1,000-file cap, in batches of at most 50", async () => {
    const tenant = "acme";
    const home = mkdtempSync(path.join(root, "home-"));
    const dirs = codexFixture(home);
    await rt.bindTenant(tenant);
    const device = await rt.enrollCodingSessions(tenant);
    // Exactly what the runtime queues today: maxFiles 1000, force, no fullInventory flag.
    const sync = await command(tenant, device.bindingId, { type: "source_sync", coverageFrom: null });
    expect(sync.payload).toMatchObject({ maxFiles: DEFAULT_CAP, force: true });
    expect(sync.payload).not.toHaveProperty("fullInventory");

    const before = rt.yc.calls;
    const run = await runCli(home, ["coding-sessions-agent", "--config", writeConfig(home, tenant, device.key, dirs), "--once"], { timeoutMs: 180_000 });
    expect(run.code, run.stderr).toBe(0);

    expect(await sessionCount(tenant)).toBe(CODEX_FILES + 1);
    // The oldest Codex files (the ones a capped scan drops) and the Claude session all arrived.
    const ids = (await rt.query<{ session_id: string; provider: string }>(`SELECT session_id, provider FROM coding_sessions WHERE tenant_id = $1`, [tenant])).map((r) => `${r.provider}:${r.session_id}`);
    expect(ids).toEqual(expect.arrayContaining(["codex:session-0000", "codex:session-0004", `codex:session-${CODEX_FILES - 1}`, "claude:claude-session-a"]));

    const cmd = await commandRow(sync.id);
    expect(cmd.status).toBe("completed");
    expect(cmd.result).toMatchObject({ provider: "coding_sessions", fullInventory: true, exhausted: true, capHit: false, filesDiscovered: CODEX_FILES + 1, sessionsSeen: CODEX_FILES + 1, pendingUploads: 0, failedUploads: 0 });
    expect(await coverage(tenant)).toMatchObject({ state: "complete" });

    // Every request is verified with yc_msaw once: 1 command fetch + ceil(1006/50) = 21 ingest batches + 1 ack.
    // The runtime refuses batches over 50, so this also proves the client stayed within the bound.
    expect(rt.yc.calls - before).toBe(1 + Math.ceil((CODEX_FILES + 1) / 50) + 1);

    const files = (await rt.exportAll(tenant)).filter((c) => c.op === "put" && String(c.path).startsWith("sources/coding-sessions/"));
    const normalized = files.filter((c) => !c.path.startsWith("sources/coding-sessions/_raw/"));
    const raw = files.filter((c) => c.path.startsWith(`sources/coding-sessions/_raw/device:${device.bindingId}/`));
    // One normalized session (.json) and readable transcript (.md) per session, plus its immutable raw record.
    expect(normalized.filter((c) => c.path.endsWith(".json"))).toHaveLength(CODEX_FILES + 1);
    expect(normalized.filter((c) => c.path.endsWith(".md"))).toHaveLength(CODEX_FILES + 1);
    expect(raw).toHaveLength(CODEX_FILES + 1);
    expect(files.map((c) => c.path)).toEqual(expect.arrayContaining(["sources/coding-sessions/codex/2026-09/session-0000.json", "sources/coding-sessions/claude/2026-09/claude-session-a.md"]));
  }, 300_000);

  it("the unpatched donor client (gigabrain@5448774e) reproduces the capped receipt, so the test above guards the fix", async () => {
    const tenant = "donor-check";
    const home = mkdtempSync(path.join(root, "home-"));
    const dirs = codexFixture(home);
    // Rebuild the donor bytes (shipped files minus the recorded patch) next to this package's node_modules.
    const donorDir = mkdtempSync(path.join(PACKAGE_DIR, ".donor-check-"));
    try {
      materializeDonor(donorDir);
      const donorCli = path.join(donorDir, "bin", "shepherd-onboard.js");
      const vendor = readVendor() as { files: Array<{ path: string; donorSha256: string }> };
      expect(createHash("sha256").update(readFileSync(donorCli)).digest("hex")).toBe(vendor.files.find((f) => f.path === "bin/shepherd-onboard.js")!.donorSha256);

      await rt.bindTenant(tenant);
      const device = await rt.enrollCodingSessions(tenant);
      const sync = await command(tenant, device.bindingId, { type: "source_sync", coverageFrom: null });
      const run = await new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(process.execPath, [donorCli, "coding-sessions-agent", "--config", writeConfig(home, tenant, device.key, dirs), "--once"],
          { env: clientEnv(home), timeout: 180_000 }, (error, _stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr }));
      });
      expect(run.code, run.stderr).toBe(0);
      const cmd = await commandRow(sync.id);
      // The donor scans only the newest 1,000 Codex files: honest receipt, so coverage can never become complete.
      expect(cmd.result).toMatchObject({ fullInventory: false, capHit: true, exhausted: false, filesDiscovered: CODEX_FILES + 1, sessionsSeen: DEFAULT_CAP + 1 });
      expect(await sessionCount(tenant)).toBe(DEFAULT_CAP + 1);
      expect(await coverage(tenant)).toMatchObject({ state: "partial" });
    } finally {
      rmSync(donorDir, { recursive: true, force: true });
    }
  }, 300_000);

  it("an explicitly bounded sync gets an honest capped receipt, coverage drops to partial, and nothing captured is deleted", async () => {
    const tenant = "bounded";
    const home = mkdtempSync(path.join(root, "home-"));
    const codexDir = path.join(home, ".codex", "sessions");
    const claudeDir = path.join(home, ".claude", "projects");
    for (let i = 0; i < 4; i++) writeCodexSession(codexDir, `b-${i}`, `2026-09-0${i + 1}T10:00:00.000Z`, `Ask ${i}`, `Answer ${i}`, 1_780_000_000 + i);
    writeClaudeSession(claudeDir, "b-claude", "2026-09-05T10:00:00.000Z", "Ask claude", "Answer claude");
    await rt.bindTenant(tenant);
    const device = await rt.enrollCodingSessions(tenant);
    const config = writeConfig(home, tenant, device.key, { codexDir, claudeDir });

    const full = await command(tenant, device.bindingId, { type: "source_sync", coverageFrom: null });
    expect((await runCli(home, ["coding-sessions-agent", "--config", config, "--once"])).code).toBe(0);
    expect((await commandRow(full.id)).result).toMatchObject({ fullInventory: true, capHit: false, exhausted: true });
    expect(await coverage(tenant)).toMatchObject({ state: "complete" });
    const firstExport = await rt.exportAll(tenant);
    expect(firstExport.filter((c) => c.op === "put" && /^sources\/coding-sessions\/(codex|claude)\/.*\.json$/.test(c.path))).toHaveLength(5);

    // An operator-bounded sync (the runtime API never sends one; written straight to the queue as a donor-shaped
    // command): the newest 2 files per provider only.
    writeCodexSession(codexDir, "b-new", "2026-09-09T10:00:00.000Z", "Ask new", "Answer new", 1_780_000_100);
    await rt.query(`INSERT INTO coding_session_commands (id, tenant_id, binding_id, command_type, payload, requested_by)
      VALUES ('csc_bounded', $1, $2, 'source_sync', $3::jsonb, 'test')`, [tenant, device.bindingId,
      JSON.stringify({ sourceSyncRunId: "srs_bounded", coverageFrom: null, coverageTo: new Date().toISOString(), maxFiles: 2, fullInventory: false, force: true })]);
    expect((await runCli(home, ["coding-sessions-agent", "--config", config, "--once"])).code).toBe(0);
    const bounded = await commandRow("csc_bounded");
    expect(bounded.status).toBe("completed");
    expect(bounded.result).toMatchObject({ fullInventory: false, capHit: true, exhausted: false, filesDiscovered: 6, sessionsSeen: 3 });
    expect(await coverage(tenant)).toMatchObject({ state: "partial" });

    // The capped receipt removes nothing: every session captured earlier is still stored, and the exporter
    // publishes only the new session, never a delete.
    expect(await sessionCount(tenant)).toBe(6);
    const after = (await rt.exportAll(tenant)).slice(firstExport.length);
    expect(after.filter((c) => c.op === "delete")).toEqual([]);
    expect(after.filter((c) => c.op === "put" && /^sources\/coding-sessions\/codex\/.*\.json$/.test(c.path)).map((c) => c.path)).toEqual(["sources/coding-sessions/codex/2026-09/b-new.json"]);
  }, 120_000);

  it("fails closed when yc_msaw is down or the device is revoked, keeping unsent sessions in the client's retry queue", async () => {
    const tenant = "revoked";
    const home = mkdtempSync(path.join(root, "home-"));
    const codexDir = path.join(home, ".codex", "sessions");
    const claudeDir = path.join(home, ".claude", "projects");
    writeCodexSession(codexDir, "r-1", "2026-09-01T10:00:00.000Z", "Ask", "Answer", 1_780_000_000);
    await rt.bindTenant(tenant);
    const device = await rt.enrollCodingSessions(tenant);
    const config = writeConfig(home, tenant, device.key, { codexDir, claudeDir });
    const queueFiles = () => {
      const dir = path.join(home, ".shepherd", "coding-sessions");
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith("-queue.json")).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Array<{ sessionId: string }>) : [];
    };

    // yc_msaw unreachable: the runtime answers 503, stores nothing, and the client queues the session.
    rt.yc.down = true;
    expect((await runCli(home, ["coding-sessions-agent", "--config", config, "--once"])).code).toBe(0);
    expect(await sessionCount(tenant)).toBe(0);
    expect(queueFiles().flat().map((s) => s.sessionId)).toEqual(["r-1"]);
    expect((await rt.query(`SELECT status FROM coding_session_devices WHERE binding_id = $1`, [device.bindingId]))[0]).toEqual({ status: "active" });

    // yc_msaw back: the queued session drains on the next run.
    rt.yc.down = false;
    expect((await runCli(home, ["coding-sessions-agent", "--config", config, "--once"])).code).toBe(0);
    expect(await sessionCount(tenant)).toBe(1);
    expect(queueFiles()).toEqual([]);

    // Revoked in yc_msaw: the next request is refused, the runtime revokes its row and cancels pending commands,
    // and the new session stays only on the Mac.
    const pending = await command(tenant, device.bindingId, { type: "source_sync", coverageFrom: null });
    rt.yc.revoked.add(device.bindingId);
    writeCodexSession(codexDir, "r-2", "2026-09-02T10:00:00.000Z", "Ask 2", "Answer 2", 1_780_000_050);
    expect((await runCli(home, ["coding-sessions-agent", "--config", config, "--once"])).code).toBe(0);
    expect(await sessionCount(tenant)).toBe(1);
    expect(queueFiles().flat().map((s) => s.sessionId)).toEqual(["r-2"]);
    expect((await rt.query(`SELECT status FROM coding_session_devices WHERE binding_id = $1`, [device.bindingId]))[0]).toEqual({ status: "revoked" });
    expect((await commandRow(pending.id)).status).toBe("cancelled");
    expect(await coverage(tenant)).toMatchObject({ state: "blocked" });
    // Re-allowing the key in yc_msaw does not resurrect the revoked runtime device.
    rt.yc.revoked.delete(device.bindingId);
    expect((await runCli(home, ["coding-sessions-agent", "--config", config, "--once"])).code).toBe(0);
    expect(await sessionCount(tenant)).toBe(1);
  }, 120_000);
});
