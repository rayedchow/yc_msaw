import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDeviceKey } from "../../../../src/source-lane/providers/imessage/device-auth.js";
import { mintBinding } from "./harness.js";

/**
 * Compatibility with the bundled Mac uploader (gigabrain@5448774e
 * packages/shepherd-onboard/bin/shepherd-onboard.js), and a guard that the donor's
 * global-admin-key auth path stays unreachable.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = path.resolve(here, "../../../../src");
// The Mac uploader is vendored and pinned in this repository: packages/shepherd-onboard (gigabrain@5448774e plus
// recorded patches, see its vendor.json). Install it with `npm ci --prefix packages/shepherd-onboard`.
const CLI = process.env.SHEPHERD_ONBOARD_BIN ?? path.resolve(here, "../../../../../shepherd-onboard/bin/shepherd-onboard.js");
if (!existsSync(CLI) || !existsSync(path.resolve(path.dirname(CLI), "../node_modules/ws"))) {
  throw new Error(`Mac uploader not runnable at ${CLI}: run \`npm ci --prefix packages/shepherd-onboard\`. These tests do not skip.`);
}

function run(args: string[], stdin: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin!.end(stdin);
  });
}

describe("bundled Mac uploader config", () => {
  it("accepts the setup route's messagesConfig on stdin and keeps the key and tenant exactly", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "imessage-mac-config-"));
    try {
      const b = mintBinding("acme");
      // What yc_msaw's setup route returns, plus the chats the user picked on the Mac.
      const messagesConfig = { apiUrl: "https://runtime.example.test", userId: "acme", agentToken: b.key, backfillDays: 30, allowedChatIds: ["iMessage;-;+15550001111"] };
      // The token travels on stdin only, never in process arguments.
      const r = await run(["write-messages-config"], JSON.stringify(messagesConfig), { PATH: process.env.PATH, HOME: home, SHEPHERD_ONBOARD_HOME: home });
      expect(r.code, r.stderr).toBe(0);
      const { configPath } = JSON.parse(r.stdout) as { configPath: string };
      expect(configPath.startsWith(home)).toBe(true);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({ apiUrl: "https://runtime.example.test", userId: "acme", agentToken: b.key, backfillDays: 30, allowedChatIds: ["iMessage;-;+15550001111"] });
      expect(parseDeviceKey(written.agentToken as string)).toEqual({ tenantNs: "acme", bindingId: b.bindingId });
      // Nothing was installed or started (no LaunchAgent written).
      expect(existsSync(path.join(home, "Library", "LaunchAgents"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("donor iMessage auth path", () => {
  it("is not imported anywhere (global admin key with a client-chosen userId)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.includes(`${path.sep}integrations${path.sep}imessage${path.sep}`)) {
          const text = readFileSync(p, "utf8");
          if (/integrations\/imessage\/(auth|connect)\.js/u.test(text) || /\bresolveImessageAuth\b|\bconnectImessage\b/u.test(text)) offenders.push(path.relative(RUNTIME_SRC, p));
        }
      }
    };
    walk(RUNTIME_SRC);
    expect(offenders).toEqual([]);
  });
});
