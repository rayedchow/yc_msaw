/**
 * Runs the vendored Mac uploader (this package's bin/shepherd-onboard.js) as the LaunchAgent would: a child Node
 * process with its own HOME, so every ~/.shepherd state file, queue, chat.db and transcript is synthetic.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = path.resolve(here, "../..");
export const CLI = path.join(PACKAGE_DIR, "bin", "shepherd-onboard.js");
if (!existsSync(path.join(PACKAGE_DIR, "node_modules", "ws"))) {
  throw new Error("packages/shepherd-onboard dependencies are not installed. Run `npm ci --prefix packages/shepherd-onboard`.");
}

export function clientEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // No inherited SHEPHERD_* / API settings: only what the test sets. PATH keeps git and the system sqlite3.
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SHEPHERD_ONBOARD_HOME: home, TZ: "UTC", ...extra };
}

export function runCli(home: string, args: string[], opts: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: clientEnv(home, opts.env), timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  });
}

export interface Agent {
  child: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

/** Starts a long-running agent (e.g. `messages-agent --config …`) and captures its output. */
export function startAgent(home: string, args: string[], env: Record<string, string> = {}): Agent {
  const child = spawn(process.execPath, [CLI, ...args], { env: clientEnv(home, env), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (c) => { out += c; });
  child.stderr?.on("data", (c) => { out += c; });
  return {
    child,
    output: () => out,
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const t = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
      child.kill("SIGTERM");
    }),
  };
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; agent?: Agent } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (opts.agent && opts.agent.child.exitCode !== null) throw new Error(`agent exited (${opts.agent.child.exitCode}) while waiting for ${what}:\n${opts.agent.output().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ""}${opts.agent ? `\nagent output:\n${opts.agent.output().slice(-4000)}` : ""}`);
}
