/**
 * Writes self-contained mcp-use projects (for Manufact) and deploys them with the official CLI.
 *
 *   writeProject(dir, files)            package.json + tsconfig + the given files
 *   runLocal(dir, env, port)            mcp-use build + start against this checkout's node_modules (verification)
 *   deployToManufact(dir, name, env)    `mcp-use deploy --no-github --json --yes`, returns the CLI's JSON result
 */
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import "../env.js";
import { REPO_DIR } from "../paths.js";

const REPO = REPO_DIR;

const LINK = ".mcp-use/cloud/link.json";
export const isLinked = (dir: string) => existsSync(path.join(dir, LINK));

export const PACKAGE_JSON = (name: string, description: string) => JSON.stringify({
  name, version: "0.1.0", description, type: "module", private: true, license: "UNLICENSED", engines: { node: ">=22" },
  scripts: { dev: "mcp-use dev", build: "mcp-use build", start: "mcp-use start" },
  dependencies: { "mcp-use": "2.10.0", zod: "4.6.7" },
  devDependencies: { "@types/node": "24.19.2", typescript: "5.9.3" },
}, null, 2) + "\n";

export const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2023", module: "ESNext", moduleResolution: "bundler", strict: true, skipLibCheck: true, noEmit: true,
    allowImportingTsExtensions: true, resolveJsonModule: true, types: ["node"] },
  include: ["index.ts", "src/**/*"],
}, null, 2) + "\n";

export async function writeProject(dir: string, name: string, description: string, files: Record<string, string>): Promise<void> {
  // Keep the CLI's link to the Manufact server so redeploys update it in place.
  const link = await fs.readFile(path.join(dir, LINK), "utf8").catch(() => null);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  if (link) {
    await fs.mkdir(path.dirname(path.join(dir, LINK)), { recursive: true });
    await fs.writeFile(path.join(dir, LINK), link);
  }
  const all: Record<string, string> = { "package.json": PACKAGE_JSON(name, description), "tsconfig.json": TSCONFIG, ".gitignore": "node_modules\n.mcp-use\ndist\n", ...files };
  for (const [rel, content] of Object.entries(all)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
}

export function run(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number; onLine?: (l: string) => void } ): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; opts.onLine?.(String(d)); });
    child.stderr.on("data", (d) => { err += d; opts.onLine?.(String(d)); });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** Build and start a project locally (node_modules linked from this checkout). Returns the base URL and a stop function. */
export async function runLocal(dir: string, env: Record<string, string>, port: number): Promise<{ url: string; stop: () => void }> {
  const nm = path.join(dir, "node_modules");
  if (!existsSync(nm)) await fs.symlink(path.join(REPO, "node_modules"), nm);
  const mcpUse = path.join(REPO, "node_modules", ".bin", "mcp-use");
  const b = await run(mcpUse, ["build"], { cwd: dir, timeoutMs: 180_000 });
  if (b.code !== 0) throw new Error(`mcp-use build failed:\n${(b.out + b.err).slice(-2000)}`);
  const child = spawn(mcpUse, ["start", "--port", String(port)], { cwd: dir, env: { ...process.env, ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url + "/health");
      if (r.status < 500) return { url, stop: () => child.kill("SIGTERM") };
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGKILL");
  throw new Error(`server did not start:\n${log.slice(-2000)}`);
}

export interface DeployResult { ok: boolean; url?: string; mcpUrl?: string; raw: unknown; log: string }

/** Deploy with the official CLI (managed upload, headless). Env values become the server's environment on Manufact. */
export async function deployToManufact(dir: string, name: string, env: Record<string, string>, opts: { org?: string; isNew?: boolean } = {}): Promise<DeployResult> {
  const mcpUse = path.join(REPO, "node_modules", ".bin", "mcp-use");
  await fs.rm(path.join(dir, "node_modules"), { force: true }); // the local-run symlink must not be uploaded
  await fs.rm(path.join(dir, "dist"), { recursive: true, force: true });
  const args = ["deploy", dir, "--no-github", "--json", "--yes", "--name", name, ...(opts.isNew ? ["--new"] : []), ...(opts.org ? ["--org", opts.org] : [])];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  const r = await run(mcpUse, args, { cwd: dir, timeoutMs: 20 * 60_000 });
  const secretFree = (s: string) => Object.values(env).reduce((acc, v) => (v.length >= 8 ? acc.split(v).join("<redacted>") : acc), s);
  let raw: unknown = null;
  for (const line of r.out.trim().split("\n").reverse()) {
    try { raw = JSON.parse(line); break; } catch { /* not JSON */ }
  }
  const j = (raw ?? {}) as Record<string, any>;
  const url = j.url ?? j.serverUrl ?? j.deployment?.url ?? j.server?.url;
  const mcpUrl = j.mcpUrl ?? j.deployment?.mcpUrl ?? (url ? String(url).replace(/\/$/, "") + "/mcp" : undefined);
  return { ok: r.code === 0 && j.ok !== false && !j.error, url, mcpUrl, raw, log: secretFree((r.out + r.err).slice(-4000)) };
}

/**
 * Wait until a deploy is live. Manufact may start more than one deployment for an upload (CLI + webhook) and its
 * status can lag, so the signal is the server itself: any deployment of this server whose /walter/health reports
 * the expected build hash (or, without a hash, a running deployment created after `since`).
 */
export async function waitForDeployment(serverId: string, opts: { since: number; expectHash?: string; timeoutMs?: number }): Promise<{ status: string; mcpUrl?: string; url?: string; raw: any }> {
  const mcpUse = path.join(REPO, "node_modules", ".bin", "mcp-use");
  const end = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  let mine: any[] = [];
  while (Date.now() < end) {
    const r = await run(mcpUse, ["deployments", "list", "--json"], { cwd: REPO, timeoutMs: 60_000 });
    let items: any[] = [];
    try { items = JSON.parse(r.out.trim().split("\n").pop() ?? "{}").items ?? []; } catch { items = []; }
    mine = items.filter((d) => d.serverId === serverId && Date.parse(d.createdAt) >= opts.since - 60_000);
    for (const d of mine) {
      if (!d.mcpUrl) continue;
      const base = String(d.mcpUrl).replace(/\/mcp$/, "");
      if (opts.expectHash) {
        const h = await fetch(base + "/walter/health", { signal: AbortSignal.timeout(10_000) }).then((x) => (x.ok ? x.json() : null), () => null);
        if (h?.hash === opts.expectHash) return { status: "running", mcpUrl: d.mcpUrl, url: base, raw: d };
      } else if (d.status === "running") {
        const ok = await fetch(base + "/health", { signal: AbortSignal.timeout(10_000) }).then((x) => x.ok, () => false);
        if (ok) return { status: "running", mcpUrl: d.mcpUrl, url: base, raw: d };
      }
    }
    if (mine.length && mine.every((d) => d.status === "failed" || d.error || /fail/.test(String(d.pipelinePhase)))) return { status: "failed", raw: mine };
    await new Promise((res) => setTimeout(res, 10_000));
  }
  return { status: "timeout", raw: mine };
}
