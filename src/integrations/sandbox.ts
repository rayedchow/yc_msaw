import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModalClient, type Sandbox } from "modal";
import type { ExecResult } from "../sandbox/types.js";
import { canonicalJson } from "../util.js";

/**
 * Isolated compute for integration repositories (mcps/<slug>/).
 *
 * Three identities inside the sandbox:
 *  - "agent"   (uid 1000): model-authored commands, child MCP servers, repo tests.
 *              Owns the working trees; cannot write .git, dependencies or harness files.
 *  - "harness" (uid 1001): host-owned smoke/held-out clients and API fixtures, so the
 *              child server (agent uid) cannot ptrace, signal or rewrite them.
 *  - "root":   host-owned setup and git ref/object writes, issued only by host code
 *              with validated argv (never model-supplied shell text).
 *
 * The Modal image pre-bakes git and a pinned dependency set (mcp-use, zod, tsx,
 * typescript, MCP client) at <root>/node_modules, so sandboxes run with
 * blockNetwork=true and generated package scripts never need the network or
 * the host. Isolation patterns follow src/sandbox/modal.ts (setpriv + env -i +
 * timeout), themselves ported from AEye/Silicon's Modal workspace.
 */
export type SandboxUser = "agent" | "harness" | "root";

export interface IntegrationExecOptions {
  user: SandboxUser;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
}

export interface SandboxLayout {
  /** Root of the integration area, e.g. /srv/integ. node_modules lives here. */
  root: string;
  /** Parent of all repos: <root>/mcps. */
  mcpsDir: string;
  /** Sealed harness: suite client, fixtures (root:harness-group 0750, files 0640; unreadable by the agent uid). */
  harnessDir: string;
  /** Host-owned helper scripts the agent uid executes (fsop.mjs; root-owned 0755/0644). */
  toolsDir: string;
  /** Root-owned git dirs, one per repo (<gitDir>/<slug>.git), OUTSIDE every agent-writable tree. */
  gitDir: string;
  /** Host-owned scratch for bundles/archives/indexes (root-only). */
  runsDir: string;
  /** Exact-tree validation checkouts (agent-owned per run). */
  stageDir: string;
  /** PATH for agent/harness commands. */
  path: string;
}

export interface SandboxPolicy {
  provider: "modal" | "host-test";
  blockNetwork: boolean;
  image: string;
  imageSpecSha256: string;
  agentUid: number;
  harnessUid: number;
  secretsInjected: false;
}

export interface IntegrationSandbox {
  readonly provider: "modal" | "host-test";
  readonly id: string;
  readonly layout: SandboxLayout;
  readonly policy: SandboxPolicy;
  exec(argv: string[], opts: IntegrationExecOptions): Promise<ExecResult>;
  /** Root write (parents created). Default root:root 0644; `gid`/`mode` for sealed harness files. */
  writeFile(absPath: string, content: string | Uint8Array, opts?: { mode?: number; gid?: number }): Promise<void>;
  /** Root read of a file produced by host-owned commands. */
  readFile(absPath: string): Promise<Buffer>;
  terminate(): Promise<void>;
}

export const AGENT_UID = 1000;
export const HARNESS_UID = 1001;
export const INTEGRATION_ROOT = "/srv/integ";
export const DEFAULT_INTEGRATION_APP = "procmem-integrations";
export const BASE_IMAGE = "node:22-bookworm-slim";

/** Exact pre-baked dependency set. Generated repos may only depend on these. */
export const PREBAKED_DEPENDENCIES: Readonly<Record<string, string>> = {
  "mcp-use": "2.10.0",
  zod: "4.6.7",
  tsx: "4.23.15",
  typescript: "5.9.3",
  "@types/node": "24.19.2",
  "@modelcontextprotocol/client": "2.3.1",
};

/** Pre-baked packages a generated child repo may declare (the harness client is host-only). */
export const CHILD_ALLOWED_DEPENDENCIES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PREBAKED_DEPENDENCIES).filter(([name]) => name !== "@modelcontextprotocol/client"),
);

export function layoutFor(root: string): SandboxLayout {
  return {
    root,
    mcpsDir: `${root}/mcps`,
    harnessDir: `${root}/harness`,
    toolsDir: `${root}/tools`,
    gitDir: `${root}/git`,
    runsDir: `${root}/runs`,
    stageDir: `${root}/stage`,
    path: `${root}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  };
}

export function integrationImageCommands(root = INTEGRATION_ROOT): string[] {
  const pkg = JSON.stringify({ name: "integration-prebaked-deps", private: true, type: "module", dependencies: PREBAKED_DEPENDENCIES });
  return [
    "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps util-linux coreutils findutils && rm -rf /var/lib/apt/lists/*",
    `RUN groupadd --gid ${HARNESS_UID} integ-harness && useradd --uid ${HARNESS_UID} --gid ${HARNESS_UID} --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin integ-harness`,
    `RUN mkdir -p ${root} && cd ${root} && echo '${pkg}' > package.json && npm install --no-audit --no-fund && npm cache clean --force && chown -R 0:0 ${root} && chmod -R go-w ${root}`,
    "RUN git config --system safe.directory '*' && git config --system core.hooksPath /dev/null && git config --system init.defaultBranch main && git config --system core.fsmonitor false && git config --system advice.detachedHead false",
    `RUN mkdir -p ${root}/mcps ${root}/harness ${root}/tools ${root}/git ${root}/runs ${root}/stage && chmod 0755 ${root}/mcps ${root}/tools ${root}/git ${root}/stage && chown 0:${HARNESS_UID} ${root}/harness && chmod 0750 ${root}/harness && chmod 0700 ${root}/runs && chmod 1777 /tmp`,
  ];
}

export function integrationImageSpecSha256(root = INTEGRATION_ROOT): string {
  return createHash("sha256").update(canonicalJson({ base: BASE_IMAGE, commands: integrationImageCommands(root) })).digest("hex");
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Never forwarded into agent/harness commands, whatever the caller passes. */
const FORBIDDEN_ENV_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^MODAL_|^MCP_USE_|^EXA_|^AWS_|^LD_|^NODE_OPTIONS$|^BASH_ENV$|^ENV$|^GIT_CONFIG)/i;
const GROUP_WRAPPER =
  't="$1"; shift; /usr/bin/setsid /usr/bin/timeout -k 2 -s TERM "$t" "$@" 0<&0 & g=$!; wait "$g"; c=$?; kill -KILL -- "-$g" 2>/dev/null; exit "$c"';
const DEFAULT_MAX_OUTPUT = 64 * 1024;
const HARD_MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 20 * 60_000;

export function sanitizeEnv(layout: SandboxLayout, user: SandboxUser, extra: Record<string, string> | undefined): string[] {
  const env: Record<string, string> = {
    PATH: layout.path,
    HOME: user === "root" ? "/root" : "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/tmp",
    // Read-only git for unprivileged users: never try to refresh/lock the root-owned index.
    GIT_OPTIONAL_LOCKS: "0",
    NO_COLOR: "1",
    CI: "1",
  };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`Invalid environment variable name ${JSON.stringify(k)}`);
    if (user !== "root" && FORBIDDEN_ENV_KEY_RE.test(k)) throw new Error(`Environment variable ${k} is not allowed in sandbox commands`);
    if (typeof v !== "string" || v.includes("\0") || v.length > 8192) throw new Error(`Invalid value for environment variable ${k}`);
    env[k] = v;
  }
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function wrapArgv(layout: SandboxLayout, argv: string[], opts: IntegrationExecOptions): string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("argv must be a non-empty array");
  for (const a of argv) if (typeof a !== "string" || a.includes("\0")) throw new Error("argv elements must be strings without NUL bytes");
  const timeoutS = (clampTimeout(opts.timeoutMs) / 1000).toFixed(3);
  const env = sanitizeEnv(layout, opts.user, opts.env);
  // Run in a fresh session/process group under GNU timeout, then kill whatever the
  // command left behind in that group (background servers would otherwise keep the
  // exec streams open). Same shape as src/sandbox/modal.ts run.sh.
  const timed = ["/bin/bash", "-c", GROUP_WRAPPER, "integ-run", timeoutS];
  if (opts.user === "root") return [...timed, "/usr/bin/env", "-i", ...env, ...argv];
  const uid = opts.user === "agent" ? AGENT_UID : HARNESS_UID;
  return [
    ...timed,
    "/usr/bin/setpriv",
    `--reuid=${uid}`,
    `--regid=${uid}`,
    "--clear-groups",
    "--no-new-privs",
    "--inh-caps=-all",
    "--bounding-set=-all",
    "--",
    "/usr/bin/env",
    "-i",
    ...env,
    ...argv,
  ];
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("timeoutMs must be a positive number");
  return Math.min(Math.max(Math.floor(ms), 100), MAX_TIMEOUT_MS);
}

function clampOutput(n: number | undefined): number {
  if (n === undefined) return DEFAULT_MAX_OUTPUT;
  return Math.min(Math.max(Math.floor(n), 0), HARD_MAX_OUTPUT);
}

class Sink {
  #chunks: Buffer[] = [];
  #stored = 0;
  truncated = false;
  constructor(readonly limit: number) {}
  push(chunk: Uint8Array) {
    const room = this.limit - this.#stored;
    if (room <= 0) {
      if (chunk.byteLength) this.truncated = true;
      return;
    }
    const take = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
    if (take.byteLength < chunk.byteLength) this.truncated = true;
    this.#chunks.push(Buffer.from(take));
    this.#stored += take.byteLength;
  }
  text(): string {
    const buf = Buffer.concat(this.#chunks);
    // Drop a partial trailing UTF-8 sequence when truncated.
    return this.truncated ? buf.toString("utf8").replace(/�$/, "") : buf.toString("utf8");
  }
}

async function pump(stream: ReadableStream<Uint8Array>, sink: Sink): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) sink.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  return Promise.race([p.then(() => true, () => true), t]).finally(() => clearTimeout(timer));
}

export interface ModalIntegrationSandboxOptions {
  appName?: string;
  client?: ModalClient;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  cpu?: number;
  memoryMiB?: number;
  tags?: Record<string, string>;
}

class ModalIntegrationSandbox implements IntegrationSandbox {
  readonly provider = "modal" as const;
  readonly layout = layoutFor(INTEGRATION_ROOT);
  readonly policy: SandboxPolicy;
  #terminated = false;
  #terminating: Promise<void> | null = null;

  constructor(private readonly sandbox: Sandbox, private readonly client: ModalClient, private readonly ownsClient: boolean, imageId: string) {
    this.policy = {
      provider: "modal",
      blockNetwork: true,
      image: `${BASE_IMAGE}+integration-prebaked (${imageId})`,
      imageSpecSha256: integrationImageSpecSha256(),
      agentUid: AGENT_UID,
      harnessUid: HARNESS_UID,
      secretsInjected: false,
    };
  }

  get id() {
    return this.sandbox.sandboxId;
  }

  async exec(argv: string[], opts: IntegrationExecOptions): Promise<ExecResult> {
    if (this.#terminated) throw new Error("Sandbox has been terminated");
    const timeoutMs = clampTimeout(opts.timeoutMs);
    const max = clampOutput(opts.maxOutputBytes);
    const full = wrapArgv(this.layout, argv, opts);
    const started = Date.now();
    const proc = await this.sandbox.exec(full, { mode: "binary", timeoutMs: Math.ceil((timeoutMs + 15_000) / 1000) * 1000, ...(opts.cwd ? { workdir: opts.cwd } : {}) });
    const out = new Sink(max);
    const err = new Sink(max);
    const writer = proc.stdin.getWriter();
    try {
      if (opts.stdin !== undefined && opts.stdin.length > 0) await writer.write(typeof opts.stdin === "string" ? Buffer.from(opts.stdin, "utf8") : opts.stdin);
      await writer.close();
    } catch {
      /* command may exit without reading stdin */
    }
    const pumps = Promise.all([pump(proc.stdout, out), pump(proc.stderr, err)]).catch(() => undefined);
    const exited = proc.wait().then((c) => c, () => null);
    const finished = await settleWithin(exited, timeoutMs + 20_000);
    const code = finished ? await exited : null;
    await settleWithin(pumps, 2_000);
    const durationMs = Date.now() - started;
    // GNU timeout exits 124 (TERM) or 137 (KILL after -k grace) when the deadline fires.
    const timedOut = code === null || ((code === 124 || code === 137) && durationMs >= timeoutMs - 100);
    return { exitCode: code, stdout: out.text(), stderr: err.text(), stdoutTruncated: out.truncated, stderrTruncated: err.truncated, timedOut, durationMs };
  }

  async writeFile(absPath: string, content: string | Uint8Array, opts: { mode?: number; gid?: number } = {}): Promise<void> {
    assertAbs(absPath, this.layout.root);
    const dir = absPath.slice(0, absPath.lastIndexOf("/"));
    const mk = await this.exec(["/bin/mkdir", "-p", "--", dir], { user: "root", timeoutMs: 30_000 });
    if (mk.exitCode !== 0) throw new Error(`mkdir ${dir} failed: ${mk.stderr.slice(0, 300)}`);
    await this.sandbox.filesystem.writeBytes(typeof content === "string" ? Buffer.from(content, "utf8") : content, absPath);
    const mode = (opts.mode ?? 0o644).toString(8);
    const gid = String(opts.gid ?? 0);
    const ch = await this.exec(["/bin/sh", "-c", 'chown "0:$2" -- "$1" && chmod "$3" -- "$1"', "chown", absPath, gid, mode], { user: "root", timeoutMs: 30_000 });
    if (ch.exitCode !== 0) throw new Error(`chown ${absPath} failed: ${ch.stderr.slice(0, 300)}`);
  }

  async readFile(absPath: string): Promise<Buffer> {
    assertAbs(absPath, this.layout.root);
    return Buffer.from(await this.sandbox.filesystem.readBytes(absPath));
  }

  terminate(): Promise<void> {
    if (this.#terminating) return this.#terminating;
    this.#terminated = true;
    this.#terminating = (async () => {
      try {
        await this.sandbox.terminate();
      } finally {
        if (this.ownsClient) {
          try {
            this.client.close();
          } catch {
            /* ignore */
          }
        }
      }
    })();
    return this.#terminating;
  }
}

function assertAbs(p: string, root: string) {
  if (!p.startsWith(`${root}/`) || p.split("/").some((s, i) => i > 0 && (s === "" || s === "." || s === ".."))) {
    throw new Error(`Refusing sandbox path outside ${root}: ${p}`);
  }
}

/**
 * Create a network-blocked Modal sandbox from the pre-baked integration image.
 * Modal credentials come from the host process profile/env; nothing is forwarded in.
 */
export async function createModalIntegrationSandbox(opts: ModalIntegrationSandboxOptions = {}): Promise<IntegrationSandbox> {
  const ownsClient = !opts.client;
  const client = opts.client ?? new ModalClient();
  let sandbox: Sandbox | undefined;
  try {
    const app = await client.apps.fromName(opts.appName ?? DEFAULT_INTEGRATION_APP, { createIfMissing: true });
    const image = await client.images.fromRegistry(BASE_IMAGE).dockerfileCommands(integrationImageCommands()).build(app);
    sandbox = await client.sandboxes.create(app, image, {
      timeoutMs: opts.timeoutMs ?? 45 * 60_000,
      idleTimeoutMs: opts.idleTimeoutMs ?? 15 * 60_000,
      cpu: opts.cpu ?? 1,
      memoryMiB: opts.memoryMiB ?? 2048,
      blockNetwork: true,
      workdir: "/",
      tags: { component: "integration-workspace", ...(opts.tags ?? {}) },
    });
    return new ModalIntegrationSandbox(sandbox, client, ownsClient, image.imageId);
  } catch (error) {
    if (sandbox) await sandbox.terminate().catch(() => undefined);
    if (ownsClient) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
}

/**
 * TEST-ONLY sandbox that runs host-issued argv on this machine under a temp
 * root (no uid separation, no network isolation). It exists so unit tests can
 * exercise git/fs/receipt logic offline. Never wire it into a production
 * manager: IntegrationManager rejects it unless `allowHostTestSandbox` is set.
 */
export async function createHostTestSandbox(): Promise<IntegrationSandbox> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "integ-test-"));
  const root = path.join(base, "srv-integ");
  const layout = { ...layoutFor(root) };
  layout.path = `${layout.path}:${path.dirname(process.execPath)}`;
  for (const d of [layout.mcpsDir, layout.harnessDir, layout.toolsDir, layout.gitDir, layout.runsDir, layout.stageDir]) await fs.mkdir(d, { recursive: true });
  // Resolve pre-baked deps from this checkout's node_modules (tests only).
  const repoNodeModules = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../node_modules");
  await fs.symlink(repoNodeModules, path.join(root, "node_modules"));
  const gitConfig = path.join(base, "gitconfig");
  await fs.writeFile(gitConfig, "[safe]\n\tdirectory = *\n[core]\n\thooksPath = /dev/null\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");
  let terminated = false;
  return {
    provider: "host-test",
    id: `host-test-${randomUUID().slice(0, 8)}`,
    layout,
    policy: { provider: "host-test", blockNetwork: false, image: "host", imageSpecSha256: "host-test", agentUid: process.getuid?.() ?? -1, harnessUid: process.getuid?.() ?? -1, secretsInjected: false },
    async exec(argv, opts) {
      if (terminated) throw new Error("Sandbox has been terminated");
      const env: Record<string, string> = {};
      for (const kv of sanitizeEnv(layout, opts.user, opts.env)) env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
      env.GIT_CONFIG_GLOBAL = gitConfig;
      env.GIT_CONFIG_NOSYSTEM = "1";
      const max = clampOutput(opts.maxOutputBytes);
      const started = Date.now();
      return await new Promise<ExecResult>((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd ?? root, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
        const out = new Sink(max);
        const err = new Sink(max);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* gone */
          }
        }, clampTimeout(opts.timeoutMs));
        child.stdout.on("data", (b: Buffer) => out.push(b));
        child.stderr.on("data", (b: Buffer) => err.push(b));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: timedOut ? null : code, stdout: out.text(), stderr: err.text(), stdoutTruncated: out.truncated, stderrTruncated: err.truncated, timedOut, durationMs: Date.now() - started });
        });
        child.stdin.on("error", () => undefined);
        if (opts.stdin !== undefined) child.stdin.end(typeof opts.stdin === "string" ? Buffer.from(opts.stdin) : Buffer.from(opts.stdin));
        else child.stdin.end();
      });
    },
    async writeFile(absPath, content) {
      assertAbs(absPath, root);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
    },
    async readFile(absPath) {
      assertAbs(absPath, root);
      return fs.readFile(absPath);
    },
    async terminate() {
      if (terminated) return;
      terminated = true;
      await fs.rm(base, { recursive: true, force: true });
    },
  };
}
