#!/usr/bin/env node
/**
 * Installs a Mac uploader LaunchAgent that runs THIS package's pinned CLI.
 *
 * The donor CLI's `install-<agent>-agent` defaults the LaunchAgent program to `npx -y askshepherd@latest`, i.e. the
 * unpinned public npm package. This wrapper always passes `--program` so launchd runs
 * `<this node> <this package>/bin/shepherd-onboard.js <agent>-agent --config <path>`.
 *
 *   node scripts/install-launch-agent.mjs messages|coding-sessions --config <path> [--dry-run]
 *
 * --dry-run prints the plist without touching launchd. A real install starts collection: run it only on the Mac
 * that should upload, after granting Full Disk Access to this node binary (Messages) as macOS requires.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PACKAGE_DIR, "bin", "shepherd-onboard.js");
const AGENTS = { messages: "messages-agent", "coding-sessions": "coding-sessions-agent" };

const [kind, ...rest] = process.argv.slice(2);
const configIndex = rest.indexOf("--config");
const configPath = configIndex >= 0 ? rest[configIndex + 1] : undefined;
if (!AGENTS[kind] || !configPath) {
  console.error("usage: node scripts/install-launch-agent.mjs messages|coding-sessions --config <path> [--dry-run]");
  console.error("(office-audio is not supported by this package; see README.md)");
  process.exit(2);
}
if (!existsSync(path.join(PACKAGE_DIR, "node_modules", "ws"))) {
  console.error("Dependencies are missing: run `npm ci --prefix packages/shepherd-onboard` first.");
  process.exit(1);
}

const program = [process.execPath, CLI, AGENTS[kind]];
const args = [CLI, `install-${AGENTS[kind]}`, "--config", path.resolve(configPath), "--program", JSON.stringify(program)];
if (rest.includes("--dry-run")) args.push("--dry-run");
const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
