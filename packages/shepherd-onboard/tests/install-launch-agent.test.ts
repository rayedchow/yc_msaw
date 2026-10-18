import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The LaunchAgent installer wrapper pins launchd to this package's CLI (the donor default is
 * `npx -y askshepherd@latest`, the unpinned public package). Dry runs only: nothing is written to ~/Library and
 * launchd is never called.
 */

const PACKAGE_DIR = path.resolve(__dirname, "..");
let home: string | null = null;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function dryRun(kind: string, extra: string[] = []) {
  home = mkdtempSync(path.join(os.tmpdir(), "shepherd-onboard-install-"));
  const config = path.join(home, `${kind}.json`);
  writeFileSync(config, JSON.stringify({ apiUrl: "http://127.0.0.1:9", userId: "acme", agentToken: "synthetic", allowedChatIds: ["iMessage;-;+15550001111"] }));
  const out = execFileSync(process.execPath, [path.join(PACKAGE_DIR, "scripts", "install-launch-agent.mjs"), kind, "--config", config, "--dry-run", ...extra], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  });
  return { config, install: JSON.parse(out) as { label: string; programArguments: string[]; plist: string } };
}

describe("install-launch-agent wrapper", () => {
  it.each([["messages", "messages-agent", "raw-messages"], ["coding-sessions", "coding-sessions-agent", "coding-sessions"]])(
    "runs the vendored %s agent under launchd, never the npm package",
    (kind, agent, label) => {
      const { config, install } = dryRun(kind);
      expect(install.label).toBe(`ai.shepherd.${label}.acme`);
      expect(install.programArguments).toEqual([process.execPath, path.join(PACKAGE_DIR, "bin", "shepherd-onboard.js"), agent, "--config", config]);
      expect(install.plist).not.toMatch(/npx|askshepherd@/);
      expect(existsSync(path.join(home!, "Library"))).toBe(false);
    },
  );

  it("refuses office-audio and unknown agents", () => {
    home = mkdtempSync(path.join(os.tmpdir(), "shepherd-onboard-install-"));
    expect(() => execFileSync(process.execPath, [path.join(PACKAGE_DIR, "scripts", "install-launch-agent.mjs"), "office-audio", "--config", "x.json", "--dry-run"], { stdio: "pipe" }))
      .toThrow(/office-audio is not supported by this package/);
  });
});
