import { randomUUID } from "node:crypto";
import { ModalClient, type ContainerProcess, type Sandbox } from "modal";
import type { CommandHandle, CommandPoll, ExecOptions, ExecResult, SandboxLease } from "./types.js";

/**
 * Modal Sandbox implementation of SandboxLease.
 *
 * Isolation model (ported from the AEye/Silicon workspace patterns):
 *  - The sandbox is created with blockNetwork (default) and no secrets/env from the host.
 *  - Agent commands run as uid/gid 1000 through
 *    `setpriv --reuid --regid --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all`
 *    followed by `env -i` with an explicit allowlisted environment.
 *  - Every command (agent or root) runs under a root-owned wrapper (/opt/procmem/run.sh) that
 *    starts it in a fresh session/process group via `setsid timeout ...`, records the group id in a
 *    root-only directory, and kills the whole group when the command finishes, times out, or is
 *    cancelled. Arguments are passed only as argv elements; nothing is interpolated into a shell string.
 *  - Output is read incrementally and only the first maxOutputBytes per stream are retained.
 */

export const AGENT_UID = 1000;
export const AGENT_GID = 1000;
export const DEFAULT_MODAL_IMAGE = "node:22-slim";
export const DEFAULT_MODAL_APP = "procmem-sandbox";
const CONTROL_DIR = "/opt/procmem";
const RUNS_DIR = `${CONTROL_DIR}/runs`;
const RUN_SCRIPT = `${CONTROL_DIR}/run.sh`;
const KILL_SCRIPT = `${CONTROL_DIR}/kill.sh`;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const HARD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 60 * 60_000;
const HOST_GRACE_MS = 15_000;
const DRAIN_GRACE_MS = 2_000;
const AGENT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Environment keys an agent command may never receive, whatever the caller passes. */
const FORBIDDEN_ENV_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^MODAL_|^AWS_|^GOOGLE_|^AZURE_|^LD_|^NODE_OPTIONS$|^BASH_ENV$|^ENV$)/i;

const RUN_SH = `#!/bin/bash
# procmem host-owned command wrapper. argv: <run-id> <timeout-seconds> <command...>
set -u
run_id="$1"; timeout_s="$2"; shift 2
case "$run_id" in (""|*[!0-9a-f-]*) echo "procmem: invalid run id" >&2; exit 64;; esac
case "$timeout_s" in (""|*[!0-9.]*) echo "procmem: invalid timeout" >&2; exit 64;; esac
dir="${RUNS_DIR}/$run_id"
mkdir -m 0700 -- "$dir" || exit 65
/usr/bin/setsid /usr/bin/timeout -k 2 -s TERM "$timeout_s" "$@" 0<&0 &
group=$!
printf '%s' "$group" > "$dir/pgid"
wait "$group"
code=$?
printf '%s' "$code" > "$dir/exit"
# Reap anything the command left behind in its process group.
kill -KILL -- "-$group" 2>/dev/null || true
exit "$code"
`;

const KILL_SH = `#!/bin/bash
# procmem host-owned process-group killer. argv: <run-id>
set -u
run_id="$1"
case "$run_id" in (""|*[!0-9a-f-]*) exit 64;; esac
dir="${RUNS_DIR}/$run_id"
for _ in $(seq 1 30); do
  [ -s "$dir/pgid" ] && break
  [ -e "$dir/exit" ] && exit 0
  sleep 0.1
done
[ -s "$dir/pgid" ] || exit 0
group="$(cat -- "$dir/pgid")"
case "$group" in (""|*[!0-9]*) exit 64;; esac
kill -TERM -- "-$group" 2>/dev/null || exit 0
for _ in $(seq 1 20); do
  kill -0 -- "-$group" 2>/dev/null || exit 0
  sleep 0.1
done
kill -KILL -- "-$group" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 -- "-$group" 2>/dev/null || exit 0
  sleep 0.1
done
exit 70
`;

export interface ModalLeaseOptions {
  appName?: string;
  image?: string;
  /** Sandbox lifetime. */
  timeoutMs?: number;
  idleTimeoutMs?: number;
  cpu?: number;
  memoryMiB?: number;
  /** Default true. Leave on for anything that runs agent-authored code. */
  blockNetwork?: boolean;
  client?: ModalClient;
  tags?: Record<string, string>;
}

export class SandboxPathError extends Error {
  readonly code = "invalid_sandbox_path";
}

/** Validate an absolute sandbox path; it is only ever passed as an argv element or filesystem-API path. */
export function assertSandboxPath(p: string): string {
  if (typeof p !== "string" || !p.startsWith("/")) throw new SandboxPathError(`Sandbox path must be absolute: ${String(p)}`);
  if (p.length > 4096) throw new SandboxPathError("Sandbox path too long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new SandboxPathError("Sandbox path contains control characters");
  const segments = p.split("/").slice(1);
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") throw new SandboxPathError(`Sandbox path must be normalized (no empty, '.', or '..' segments): ${p}`);
  }
  if (p === "/" ) throw new SandboxPathError("Refusing to operate on /");
  return p;
}

const PROTECTED_PREFIXES = ["/opt/procmem", "/proc", "/sys", "/dev", "/__modal", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc", "/boot"];
function assertManagedPath(p: string): string {
  assertSandboxPath(p);
  for (const prefix of PROTECTED_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) throw new SandboxPathError(`Refusing to manage system path ${p}`);
  }
  return p;
}

function sanitizeEnv(extra: Record<string, string> | undefined, user: "agent" | "root"): string[] {
  const env: Record<string, string> = {
    PATH: AGENT_PATH,
    HOME: user === "agent" ? "/tmp" : "/root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/tmp",
  };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`Invalid environment variable name ${JSON.stringify(k)}`);
    if (FORBIDDEN_ENV_KEY_RE.test(k)) throw new Error(`Environment variable ${k} is not allowed in the sandbox`);
    if (typeof v !== "string" || v.includes("\0") || v.length > 8192) throw new Error(`Invalid value for environment variable ${k}`);
    env[k] = v;
  }
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function wrapArgv(argv: string[], opts: ExecOptions): string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("argv must be a non-empty array");
  for (const a of argv) {
    if (typeof a !== "string" || a.includes("\0")) throw new Error("argv elements must be strings without NUL bytes");
  }
  const env = sanitizeEnv(opts.env, opts.user);
  if (opts.user === "agent") {
    return [
      "/usr/bin/setpriv",
      `--reuid=${AGENT_UID}`,
      `--regid=${AGENT_GID}`,
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
  return ["/usr/bin/env", "-i", ...env, ...argv];
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("timeoutMs must be a positive number");
  return Math.min(Math.max(Math.floor(ms), 100), MAX_TIMEOUT_MS);
}

/** Modal exec deadlines must be whole seconds. */
function modalSeconds(ms: number): number {
  return Math.ceil(ms / 1000) * 1000;
}

function clampOutput(n: number | undefined): number {
  if (n === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  return Math.min(Math.max(Math.floor(n), 0), HARD_MAX_OUTPUT_BYTES);
}

/** Decode bytes as UTF-8, dropping a partial multi-byte sequence at the end of a truncated buffer. */
function decodeBounded(buf: Buffer, truncated: boolean): string {
  if (!truncated) return buf.toString("utf8");
  let end = buf.length;
  // Back off over continuation bytes of an incomplete trailing sequence.
  let i = end - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && ((buf[i] ?? 0) & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i >= 0) {
    const lead = buf[i] ?? 0;
    const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
    if (need > cont) end = i;
  }
  return buf.subarray(0, end).toString("utf8");
}

/** Bounded collector: keeps up to `limit` bytes, counts the rest, never stops draining. */
class BoundedSink {
  #chunks: Buffer[] = [];
  #stored = 0;
  total = 0;
  dropped = false;
  constructor(public limit: number) {}

  push(chunk: Uint8Array): void {
    this.total += chunk.byteLength;
    const room = this.limit - this.#stored;
    if (room <= 0) {
      if (chunk.byteLength > 0) this.dropped = true;
      return;
    }
    const take = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
    if (take.byteLength < chunk.byteLength) this.dropped = true;
    this.#chunks.push(Buffer.from(take));
    this.#stored += take.byteLength;
  }

  /** Remove and return the retained bytes (for incremental polling). */
  take(): { text: string; truncated: boolean } {
    const buf = Buffer.concat(this.#chunks);
    const truncated = this.dropped;
    this.#chunks = [];
    this.#stored = 0;
    this.dropped = false;
    return { text: decodeBounded(buf, truncated), truncated };
  }
}

async function pump(stream: ReadableStream<Uint8Array>, sink: BoundedSink, onData?: () => void): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) {
        sink.push(value);
        onData?.();
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve after `ms` or when `p` settles, whichever first. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true, () => true), t]);
  } finally {
    clearTimeout(timer);
  }
}

interface RunningProcess {
  runId: string;
  proc: ContainerProcess<Uint8Array>;
  stdout: BoundedSink;
  stderr: BoundedSink;
  startedAt: number;
  timeoutMs: number;
  exitCode: number | null;
  finished: boolean;
  timedOut: boolean;
  cancelled: boolean;
  done: Promise<void>;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  stdinClosed: boolean;
  hostTimer?: NodeJS.Timeout;
  waiters: Set<() => void>;
}

class ModalLease implements SandboxLease {
  readonly provider = "modal" as const;
  readonly id: string;
  #terminating: Promise<void> | null = null;
  #terminated = false;
  #running = new Map<string, RunningProcess>();

  constructor(
    readonly sandbox: Sandbox,
    readonly client: ModalClient,
    readonly ownsClient: boolean,
  ) {
    this.id = sandbox.sandboxId;
  }

  #assertLive(): void {
    if (this.#terminated || this.#terminating) throw new Error(`Sandbox lease ${this.id} has been terminated`);
  }

  /** One-time setup of root-owned control files. */
  async init(): Promise<void> {
    await this.sandbox.filesystem.writeText(RUN_SH, RUN_SCRIPT);
    await this.sandbox.filesystem.writeText(KILL_SH, KILL_SCRIPT);
    const r = await this.#rawExec(
      [
        "/bin/bash",
        "-c",
        'set -e; chown -R 0:0 -- "$1"; chmod 0755 -- "$1"; chmod 0755 -- "$2" "$3"; mkdir -p -- "$4"; chown 0:0 -- "$4"; chmod 0700 -- "$4"; chmod 1777 /tmp',
        "procmem-init",
        CONTROL_DIR,
        RUN_SCRIPT,
        KILL_SCRIPT,
        RUNS_DIR,
      ],
      30_000,
    );
    if (r.exitCode !== 0) throw new Error(`Sandbox control setup failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500)}`);
  }

  /** Root exec that does not go through the wrapper (setup/kill only). */
  async #rawExec(argv: string[], timeoutMs: number, stdin?: Uint8Array): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const proc = await this.sandbox.exec(argv, { mode: "binary", timeoutMs: modalSeconds(timeoutMs + 5_000) });
    const out = new BoundedSink(256 * 1024);
    const err = new BoundedSink(64 * 1024);
    const writer = proc.stdin.getWriter();
    try {
      if (stdin && stdin.byteLength) await writer.write(stdin);
      await writer.close();
    } catch {
      /* process may not read stdin */
    }
    const pumps = Promise.all([pump(proc.stdout, out), pump(proc.stderr, err)]);
    const exited = proc.wait().then((c) => c, () => null);
    const finished = await settleWithin(exited, timeoutMs + HOST_GRACE_MS);
    if (!finished) return { exitCode: null, stdout: out.take().text, stderr: `${err.take().text}\n[procmem] host deadline exceeded` };
    const code = await exited;
    await settleWithin(pumps, DRAIN_GRACE_MS);
    return { exitCode: code, stdout: out.take().text, stderr: err.take().text };
  }

  async #launch(argv: string[], opts: ExecOptions, keepStdinOpen: boolean): Promise<RunningProcess> {
    this.#assertLive();
    const timeoutMs = clampTimeout(opts.timeoutMs);
    const maxOut = clampOutput(opts.maxOutputBytes);
    if (opts.cwd !== undefined && opts.cwd !== "/") assertSandboxPath(opts.cwd);
    const runId = randomUUID();
    const inner = wrapArgv(argv, opts);
    const full = [RUN_SCRIPT, runId, (timeoutMs / 1000).toFixed(3), ...inner];
    const proc = await this.sandbox.exec(full, {
      mode: "binary",
      timeoutMs: modalSeconds(timeoutMs + 10_000),
      ...(opts.cwd ? { workdir: opts.cwd } : {}),
    });
    const run: RunningProcess = {
      runId,
      proc,
      stdout: new BoundedSink(maxOut),
      stderr: new BoundedSink(maxOut),
      startedAt: Date.now(),
      timeoutMs,
      exitCode: null,
      finished: false,
      timedOut: false,
      cancelled: false,
      done: Promise.resolve(),
      stdinWriter: null,
      stdinClosed: false,
      waiters: new Set(),
    };
    const notify = () => {
      for (const w of run.waiters) w();
    };
    run.stdinWriter = proc.stdin.getWriter();
    if (opts.stdin !== undefined && opts.stdin.length > 0) {
      await run.stdinWriter.write(Buffer.from(opts.stdin, "utf8"));
    }
    if (!keepStdinOpen) {
      run.stdinClosed = true;
      await run.stdinWriter.close().catch(() => undefined);
    }
    const pumps = Promise.all([pump(proc.stdout, run.stdout, notify), pump(proc.stderr, run.stderr, notify)]).catch(() => undefined);
    const exited = proc.wait().then(
      (c) => c,
      () => null,
    );
    run.hostTimer = setTimeout(() => {
      if (run.finished) return;
      run.timedOut = true;
      void this.#killGroup(runId).catch(() => undefined);
    }, timeoutMs + HOST_GRACE_MS);
    run.hostTimer.unref?.();
    this.#running.set(runId, run);
    run.done = (async () => {
      // Host-side backstop: never wait past timeout + grace for the remote exit.
      const ok = await settleWithin(exited, timeoutMs + HOST_GRACE_MS + 5_000);
      const code = ok ? await exited : null;
      await settleWithin(pumps, DRAIN_GRACE_MS);
      const elapsed = Date.now() - run.startedAt;
      run.exitCode = code;
      if (code === null) run.timedOut = run.timedOut || !run.cancelled;
      else if ((code === 124 || code === 137) && elapsed >= timeoutMs - 50 && !run.cancelled) run.timedOut = true;
      run.finished = true;
      if (run.hostTimer) clearTimeout(run.hostTimer);
      this.#running.delete(runId);
      notify();
    })();
    return run;
  }

  async #killGroup(runId: string): Promise<void> {
    const r = await this.#rawExec([KILL_SCRIPT, runId], 10_000);
    if (r.exitCode !== 0) throw new Error(`Process-group kill for ${runId} failed (exit ${r.exitCode})`);
  }

  async writeFiles(files: ReadonlyArray<{ path: string; content: string | Uint8Array }>): Promise<void> {
    this.#assertLive();
    if (files.length === 0) return;
    for (const f of files) assertManagedPath(f.path);
    // Stage one payload (root-only dir) and unpack it as root with node: one round trip regardless of file count.
    const payload = JSON.stringify(
      files.map((f) => [f.path, Buffer.from(typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content).toString("base64")]),
    );
    const stage = `${RUNS_DIR}/stage-${randomUUID()}.json`;
    await this.sandbox.filesystem.writeText(payload, stage);
    const unpack = `
const fs = require("fs"), path = require("path");
const stage = process.argv[1];
const items = JSON.parse(fs.readFileSync(stage, "utf8"));
fs.rmSync(stage, { force: true });
for (const [p, b64] of items) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
  try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeSync(fd, Buffer.from(b64, "base64")); fs.fchownSync(fd, 0, 0); } finally { fs.closeSync(fd); }
}
`;
    const r = await this.#rawExec(["/usr/local/bin/node", "-e", unpack, stage], 120_000);
    if (r.exitCode !== 0) throw new Error(`writeFiles failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500)}`);
  }

  async protectTree(absDir: string): Promise<void> {
    this.#assertLive();
    assertManagedPath(absDir);
    const r = await this.#rawExec(
      [
        "/bin/bash",
        "-c",
        [
          "set -euo pipefail",
          'dir="$1"',
          'mkdir -p -- "$dir"',
          'chown -R -h 0:0 -- "$dir"',
          // Symlinks inside a protected tree could point anywhere; remove them.
          'find "$dir" -type l -delete',
          'chmod -R a-w,a+rX -- "$dir"',
          // Ancestors must not be writable by the agent either (no rename/replace of the tree).
          'p="$dir"; while [ "$p" != "/" ]; do p="$(dirname -- "$p")"; [ "$p" = "/" ] && break; [ "$p" = "/tmp" ] && { echo "refusing tree under /tmp" >&2; exit 3; }; chown 0:0 -- "$p"; chmod go-w -- "$p"; done',
        ].join("\n"),
        "procmem-protect",
        absDir,
      ],
      120_000,
    );
    if (r.exitCode !== 0) throw new Error(`protectTree(${absDir}) failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500)}`);
    // Verify as the agent uid that writes fail (fail closed).
    const probe = await this.exec(
      [
        "/bin/bash",
        "-c",
        [
          'dir="$1"; leaks=0',
          'if ( : > "$dir/.procmem-write-probe" ) 2>/dev/null; then echo "LEAK create $dir"; leaks=1; fi',
          'if mkdir -- "$dir/.procmem-dir-probe" 2>/dev/null; then echo "LEAK mkdir $dir"; leaks=1; fi',
          'f="$(find "$dir" -type f -print -quit)"',
          'if [ -n "$f" ]; then if ( : >> "$f" ) 2>/dev/null; then echo "LEAK append $f"; leaks=1; fi; if rm -f -- "$f" 2>/dev/null && [ ! -e "$f" ]; then echo "LEAK unlink $f"; leaks=1; fi; fi',
          'd="$(find "$dir" -mindepth 1 -type d -print -quit)"',
          'if [ -n "$d" ]; then if ( : > "$d/.procmem-write-probe" ) 2>/dev/null; then echo "LEAK create $d"; leaks=1; fi; fi',
          'if mv -- "$dir" "$dir.procmem-moved" 2>/dev/null; then echo "LEAK rename $dir"; leaks=1; fi',
          'exit $leaks',
        ].join("\n"),
        "procmem-verify",
        absDir,
      ],
      { user: "agent", timeoutMs: 30_000, cwd: "/" },
    );
    if (probe.exitCode !== 0) {
      throw new Error(`protectTree(${absDir}) verification failed: agent uid could write (${probe.stdout.trim().slice(0, 300) || `exit ${probe.exitCode}`})`);
    }
  }

  async makeAgentDir(absDir: string): Promise<void> {
    this.#assertLive();
    assertManagedPath(absDir);
    const r = await this.#rawExec(
      [
        "/bin/bash",
        "-c",
        'set -euo pipefail; mkdir -p -m 0755 -- "$(dirname -- "$1")"; mkdir -p -- "$1"; chown -h "$2:$3" -- "$1"; chmod 0700 -- "$1"',
        "procmem-agentdir",
        absDir,
        String(AGENT_UID),
        String(AGENT_GID),
      ],
      30_000,
    );
    if (r.exitCode !== 0) throw new Error(`makeAgentDir(${absDir}) failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500)}`);
  }

  async exec(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    const run = await this.#launch(argv, opts, false);
    await run.done;
    const out = run.stdout.take();
    const err = run.stderr.take();
    return {
      exitCode: run.exitCode,
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      timedOut: run.timedOut,
      durationMs: Date.now() - run.startedAt,
    };
  }

  async start(argv: string[], opts: ExecOptions): Promise<CommandHandle> {
    const run = await this.#launch(argv, opts, true);
    const lease = this;
    const handle: CommandHandle = {
      commandId: run.runId,
      async poll(waitMs: number): Promise<CommandPoll> {
        if (!run.finished && waitMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, Math.min(Math.max(0, waitMs), 5 * 60_000));
            function done() {
              clearTimeout(timer);
              run.waiters.delete(check);
              resolve();
            }
            function check() {
              if (run.finished) done();
            }
            run.waiters.add(check);
            check();
          });
        }
        const finished = run.finished;
        const out = run.stdout.take();
        const err = run.stderr.take();
        return {
          commandId: run.runId,
          running: !finished,
          exitCode: finished ? run.exitCode : null,
          stdout: out.text,
          stderr: err.text,
          outputTruncated: out.truncated || err.truncated,
          timedOut: run.timedOut,
          cancelled: run.cancelled,
        };
      },
      async writeStdin(text: string, close: boolean): Promise<void> {
        if (run.finished) throw new Error(`Command ${run.runId} has already finished`);
        if (run.stdinClosed || !run.stdinWriter) throw new Error(`stdin of command ${run.runId} is closed`);
        if (text.length > 0) await run.stdinWriter.write(Buffer.from(text, "utf8"));
        if (close) {
          run.stdinClosed = true;
          await run.stdinWriter.close().catch(() => undefined);
        }
      },
      async cancel(): Promise<void> {
        if (run.finished) return;
        run.cancelled = true;
        try {
          await lease.#killGroup(run.runId);
        } finally {
          await settleWithin(run.done, 10_000);
        }
      },
    };
    return handle;
  }

  terminate(): Promise<void> {
    if (this.#terminating) return this.#terminating;
    this.#terminating = (async () => {
      for (const run of this.#running.values()) {
        run.cancelled = true;
        if (run.hostTimer) clearTimeout(run.hostTimer);
      }
      try {
        await settleWithin(this.sandbox.terminate(), 30_000);
      } finally {
        this.#terminated = true;
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

/** Create a Modal sandbox lease. Credentials come from the Modal profile/env of the host process; nothing is forwarded into the sandbox. */
export async function createModalLease(opts: ModalLeaseOptions = {}): Promise<SandboxLease> {
  const ownsClient = !opts.client;
  const client = opts.client ?? new ModalClient();
  let sandbox: Sandbox | undefined;
  try {
    const app = await client.apps.fromName(opts.appName ?? DEFAULT_MODAL_APP, { createIfMissing: true });
    const image = client.images.fromRegistry(opts.image ?? DEFAULT_MODAL_IMAGE);
    sandbox = await client.sandboxes.create(app, image, {
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
      idleTimeoutMs: opts.idleTimeoutMs ?? 10 * 60_000,
      cpu: opts.cpu ?? 0.5,
      memoryMiB: opts.memoryMiB ?? 1024,
      blockNetwork: opts.blockNetwork ?? true,
      workdir: "/",
      ...(opts.tags ? { tags: opts.tags } : {}),
    });
    const lease = new ModalLease(sandbox, client, ownsClient);
    try {
      await lease.init();
    } catch (error) {
      await lease.terminate().catch(() => undefined);
      throw error;
    }
    return lease;
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

/** Factory with fixed defaults (per-call overrides allowed). */
export function createModalLeaseFactory(defaults: ModalLeaseOptions = {}): (overrides?: ModalLeaseOptions) => Promise<SandboxLease> {
  return (overrides = {}) => createModalLease({ ...defaults, ...overrides, tags: { ...(defaults.tags ?? {}), ...(overrides.tags ?? {}) } });
}
