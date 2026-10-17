import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId } from "../util.js";
import type { CommandHandle, ExecOptions, ExecResult, SandboxLease } from "./types.js";

export const LOCAL_EXEC_ERROR = "local lease cannot execute commands; production command execution requires Modal";

export class LocalLeaseExecError extends Error {
  readonly code = "exec_unavailable";
  constructor() {
    super(LOCAL_EXEC_ERROR);
  }
}

/** File-level operations performed "as the agent" (OS permissions enforced, symlinks never followed). */
export interface AgentFs {
  stat(absPath: string): Promise<{ type: "file" | "dir" | "symlink" | "other"; size: number } | null>;
  readFile(absPath: string, opts: { byteOffset?: number; maxBytes: number }): Promise<{ size: number; data: Buffer }>;
  writeFile(absPath: string, content: string | Uint8Array): Promise<void>;
  walk(absDir: string, opts: WalkOptions): Promise<WalkResult>;
}

export interface WalkOptions {
  maxEntries: number;
  maxDepth: number;
  withContent: boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface WalkEntry {
  /** Path relative to the walked directory ("" never appears). */
  rel: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  /** Present only when withContent and the file fit within the byte budgets. */
  content?: Buffer;
  contentOmitted?: boolean;
}

export interface WalkResult {
  rootType: "file" | "dir" | "symlink" | "other" | null;
  rootSize: number;
  rootContent?: Buffer;
  entries: WalkEntry[];
  truncated: boolean;
}

function kindOf(s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): WalkEntry["type"] {
  if (s.isSymbolicLink()) return "symlink";
  if (s.isFile()) return "file";
  if (s.isDirectory()) return "dir";
  return "other";
}

/**
 * Offline lease for tests: absolute sandbox paths map into a private temp dir.
 * Filesystem setup works (protectTree uses chmod, verified by a write probe);
 * exec/start always throw - there is no host execution fallback.
 */
export class LocalLease implements SandboxLease {
  readonly provider = "local" as const;
  readonly id: string;
  readonly agentFs: AgentFs;
  #terminated = false;
  #terminating: Promise<void> | null = null;

  private constructor(readonly root: string) {
    this.id = newId("local");
    this.agentFs = this.#makeAgentFs();
  }

  static async create(): Promise<LocalLease> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "procmem-lease-"));
    return new LocalLease(await fs.realpath(root));
  }

  /** Map an absolute sandbox path to the host temp dir (validated, no traversal). */
  hostPath(absPath: string): string {
    if (typeof absPath !== "string" || !absPath.startsWith("/")) throw new Error(`Sandbox path must be absolute: ${String(absPath)}`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(absPath)) throw new Error("Sandbox path contains control characters");
    const segs = absPath.split("/").slice(1);
    for (const s of segs) if (s === "" || s === "." || s === "..") throw new Error(`Sandbox path must be normalized: ${absPath}`);
    return path.join(this.root, ...segs);
  }

  #assertLive(): void {
    if (this.#terminated || this.#terminating) throw new Error(`Sandbox lease ${this.id} has been terminated`);
  }

  async writeFiles(files: ReadonlyArray<{ path: string; content: string | Uint8Array }>): Promise<void> {
    this.#assertLive();
    for (const f of files) {
      const host = this.hostPath(f.path);
      await fs.mkdir(path.dirname(host), { recursive: true });
      await fs.rm(host, { force: true });
      await fs.writeFile(host, f.content, { mode: 0o644 });
    }
  }

  async protectTree(absDir: string): Promise<void> {
    this.#assertLive();
    const host = this.hostPath(absDir);
    await fs.mkdir(host, { recursive: true });
    const walk = async (p: string): Promise<void> => {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) {
        await fs.unlink(p);
        return;
      }
      if (st.isDirectory()) {
        for (const name of await fs.readdir(p)) await walk(path.join(p, name));
        await fs.chmod(p, 0o555);
      } else {
        await fs.chmod(p, 0o444);
      }
    };
    await walk(host);
    // Fail closed: if this process can still create files (e.g. running as root), protection is not enforced.
    const probe = path.join(host, ".procmem-write-probe");
    let leaked = false;
    try {
      await fs.writeFile(probe, "x", { flag: "wx" });
      leaked = true;
    } catch {
      /* expected */
    }
    if (leaked) {
      await fs.rm(probe, { force: true }).catch(() => undefined);
      throw new Error(`protectTree(${absDir}) verification failed: tree is still writable (running as root?)`);
    }
  }

  async makeAgentDir(absDir: string): Promise<void> {
    this.#assertLive();
    const host = this.hostPath(absDir);
    await fs.mkdir(host, { recursive: true });
    await fs.chmod(host, 0o700);
  }

  async exec(_argv: string[], _opts: ExecOptions): Promise<ExecResult> {
    throw new LocalLeaseExecError();
  }

  async start(_argv: string[], _opts: ExecOptions): Promise<CommandHandle> {
    throw new LocalLeaseExecError();
  }

  terminate(): Promise<void> {
    if (this.#terminating) return this.#terminating;
    this.#terminating = (async () => {
      const unlock = async (p: string): Promise<void> => {
        const st = await fs.lstat(p).catch(() => null);
        if (!st || st.isSymbolicLink()) return;
        if (st.isDirectory()) {
          await fs.chmod(p, 0o700).catch(() => undefined);
          for (const name of await fs.readdir(p).catch(() => [] as string[])) await unlock(path.join(p, name));
        }
      };
      await unlock(this.root);
      await fs.rm(this.root, { recursive: true, force: true });
      this.#terminated = true;
    })();
    return this.#terminating;
  }

  /** Resolve a host path and ensure no component (including the leaf) is a symlink escaping the lease root. */
  async #safeHost(absPath: string): Promise<string> {
    const host = this.hostPath(absPath);
    let cur = this.root;
    for (const seg of path.relative(this.root, host).split(path.sep)) {
      cur = path.join(cur, seg);
      const st = await fs.lstat(cur).catch(() => null);
      if (!st) break;
      if (st.isSymbolicLink()) throw Object.assign(new Error(`Refusing to follow symlink at ${absPath}`), { code: "ELOOP" });
    }
    return host;
  }

  #makeAgentFs(): AgentFs {
    return {
      stat: async (absPath) => {
        this.#assertLive();
        const host = await this.#safeHost(absPath);
        const st = await fs.lstat(host).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
          throw e;
        });
        return st ? { type: kindOf(st), size: st.size } : null;
      },
      readFile: async (absPath, opts) => {
        this.#assertLive();
        const host = await this.#safeHost(absPath);
        const handle = await fs.open(host, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const st = await handle.stat();
          if (!st.isFile()) throw Object.assign(new Error(`${absPath} is not a regular file`), { code: "EISDIR" });
          const start = Math.min(opts.byteOffset ?? 0, st.size);
          const len = Math.max(0, Math.min(opts.maxBytes, st.size - start));
          const buf = Buffer.alloc(len);
          let n = 0;
          while (n < len) {
            const { bytesRead } = await handle.read(buf, n, len - n, start + n);
            if (bytesRead === 0) break;
            n += bytesRead;
          }
          return { size: st.size, data: buf.subarray(0, n) };
        } finally {
          await handle.close();
        }
      },
      writeFile: async (absPath, content) => {
        this.#assertLive();
        const host = await this.#safeHost(absPath);
        await fs.mkdir(path.dirname(host), { recursive: true });
        const handle = await fs.open(host, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
        try {
          await handle.writeFile(content);
        } finally {
          await handle.close();
        }
      },
      walk: async (absDir, opts) => {
        this.#assertLive();
        const host = await this.#safeHost(absDir);
        return walkHost(host, opts);
      },
    };
  }
}

async function walkHost(host: string, opts: WalkOptions): Promise<WalkResult> {
  const rootStat = await fs.lstat(host).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  });
  if (!rootStat) return { rootType: null, rootSize: 0, entries: [], truncated: false };
  const rootType = kindOf(rootStat);
  let budget = opts.maxTotalBytes;
  if (rootType !== "dir") {
    const result: WalkResult = { rootType, rootSize: rootStat.size, entries: [], truncated: false };
    if (rootType === "file" && opts.withContent && rootStat.size <= opts.maxFileBytes && rootStat.size <= budget) {
      result.rootContent = await fs.readFile(host);
    }
    return result;
  }
  const entries: WalkEntry[] = [];
  let truncated = false;
  const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (truncated) return;
    const names = (await fs.readdir(dir)).sort();
    for (const name of names) {
      if (entries.length >= opts.maxEntries) {
        truncated = true;
        return;
      }
      const p = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = await fs.lstat(p).catch(() => null);
      if (!st) continue;
      const entry: WalkEntry = { rel: r, type: kindOf(st), size: st.size };
      if (entry.type === "file" && opts.withContent) {
        if (st.size <= opts.maxFileBytes && st.size <= budget) {
          entry.content = await fs.readFile(p);
          budget -= st.size;
        } else {
          entry.contentOmitted = true;
        }
      }
      entries.push(entry);
      if (entry.type === "dir" && depth + 1 < opts.maxDepth) await visit(p, r, depth + 1);
    }
  };
  await visit(host, "", 0);
  return { rootType, rootSize: rootStat.size, entries, truncated };
}

export async function createLocalLease(): Promise<LocalLease> {
  return LocalLease.create();
}
