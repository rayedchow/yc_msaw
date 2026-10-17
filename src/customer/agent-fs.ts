import type { AgentFs, WalkEntry, WalkOptions, WalkResult } from "../sandbox/local.js";
import type { SandboxLease } from "../sandbox/types.js";
import { CustomerToolError } from "./paths.js";

/**
 * AgentFs over SandboxLease.exec: every scratch file operation runs inside the
 * sandbox as the unprivileged agent uid (so the OS, not the host, decides what is
 * writable), with the request on stdin and a JSON reply on stdout. Paths are argv-free:
 * they travel inside the JSON request, never through a shell.
 */
const AGENT_FS_JS = String.raw`
const fs = require("fs"), path = require("path");
const C = fs.constants;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  let out;
  try { out = run(JSON.parse(input)); }
  catch (e) { out = { ok: false, code: e.code || "error", message: String((e && e.message) || e) }; }
  process.stdout.write(JSON.stringify(out));
});
function kind(s) { return s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "dir" : "other"; }
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; } }
function readAll(p, max) {
  const fd = fs.openSync(p, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    const len = Math.min(max, s.size);
    const buf = Buffer.alloc(len); let n = 0;
    while (n < len) { const r = fs.readSync(fd, buf, n, len - n, n); if (r === 0) break; n += r; }
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
function run(req) {
  if (req.op === "stat") {
    const s = lstatOrNull(req.path);
    return { ok: true, stat: s ? { type: kind(s), size: s.size } : null };
  }
  if (req.op === "read") {
    const fd = fs.openSync(req.path, C.O_RDONLY | C.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile()) { const e = new Error(req.path + " is not a regular file"); e.code = "EISDIR"; throw e; }
      const start = Math.min(req.byteOffset || 0, s.size);
      const len = Math.max(0, Math.min(req.maxBytes, s.size - start));
      const buf = Buffer.alloc(len); let n = 0;
      while (n < len) { const r = fs.readSync(fd, buf, n, len - n, start + n); if (r === 0) break; n += r; }
      return { ok: true, size: s.size, data: buf.subarray(0, n).toString("base64") };
    } finally { fs.closeSync(fd); }
  }
  if (req.op === "write") {
    fs.mkdirSync(path.dirname(req.path), { recursive: true });
    const fd = fs.openSync(req.path, C.O_WRONLY | C.O_CREAT | C.O_TRUNC | C.O_NOFOLLOW, 0o644);
    try { fs.writeSync(fd, Buffer.from(req.data, "base64")); } finally { fs.closeSync(fd); }
    return { ok: true };
  }
  if (req.op === "walk") {
    const o = req.opts;
    const rs = lstatOrNull(req.path);
    if (!rs) return { ok: true, walk: { rootType: null, rootSize: 0, entries: [], truncated: false } };
    let budget = o.maxTotalBytes;
    const rootType = kind(rs);
    if (rootType !== "dir") {
      const w = { rootType, rootSize: rs.size, entries: [], truncated: false };
      if (rootType === "file" && o.withContent && rs.size <= o.maxFileBytes && rs.size <= budget) w.rootContent = readAll(req.path, o.maxFileBytes).toString("base64");
      return { ok: true, walk: w };
    }
    const entries = []; let truncated = false;
    const visit = (dir, rel, depth) => {
      if (truncated) return;
      let names;
      try { names = fs.readdirSync(dir).sort(); } catch (e) { if (e.code === "EACCES") return; throw e; }
      for (const name of names) {
        if (entries.length >= o.maxEntries) { truncated = true; return; }
        const p = path.join(dir, name);
        const r = rel ? rel + "/" + name : name;
        const s = lstatOrNull(p);
        if (!s) continue;
        const e = { rel: r, type: kind(s), size: s.size };
        if (e.type === "file" && o.withContent) {
          if (s.size <= o.maxFileBytes && s.size <= budget) {
            try { e.content = readAll(p, o.maxFileBytes).toString("base64"); budget -= s.size; }
            catch (err) { e.contentOmitted = true; }
          } else e.contentOmitted = true;
        }
        entries.push(e);
        if (e.type === "dir" && depth + 1 < o.maxDepth) visit(p, r, depth + 1);
      }
    };
    visit(req.path, "", 0);
    return { ok: true, walk: { rootType, rootSize: rs.size, entries, truncated } };
  }
  const e = new Error("unknown op"); e.code = "EINVAL"; throw e;
}
`;

const OP_TIMEOUT_MS = 60_000;

/** Map a filesystem errno (from the sandbox helper or a local lease) to a typed customer error. */
export function mapFsError(error: unknown): Error {
  if (error instanceof CustomerToolError) return error;
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === "string" ? errorFor(code, message) : error instanceof Error ? error : new Error(message);
}

function errorFor(code: string, message: string): Error {
  if (code === "ENOENT" || code === "ENOTDIR") return new CustomerToolError("not_found", message);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new CustomerToolError("read_only", `Permission denied: ${message}`);
  if (code === "EISDIR") return new CustomerToolError("not_a_file", message);
  if (code === "ELOOP") return new CustomerToolError("invalid_path", `Refusing to follow a symlink: ${message}`);
  return Object.assign(new Error(message), { code });
}

export class ExecAgentFs implements AgentFs {
  constructor(readonly lease: SandboxLease) {}

  async #call<T>(req: Record<string, unknown>, maxOutputBytes: number): Promise<T> {
    const r = await this.lease.exec(["node", "-e", AGENT_FS_JS], {
      user: "agent",
      cwd: "/",
      timeoutMs: OP_TIMEOUT_MS,
      stdin: JSON.stringify(req),
      maxOutputBytes,
    });
    if (r.timedOut) throw new CustomerToolError("limit", "Sandbox filesystem operation timed out");
    if (r.stdoutTruncated) throw new CustomerToolError("too_large", "Sandbox filesystem reply exceeded the output bound; narrow the path");
    let parsed: { ok: boolean; code?: string; message?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new Error(`Sandbox filesystem helper failed (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}`);
    }
    if (!parsed.ok) throw errorFor(parsed.code ?? "error", parsed.message ?? "sandbox filesystem error");
    return parsed as unknown as T;
  }

  async stat(absPath: string) {
    const r = await this.#call<{ stat: { type: WalkEntry["type"]; size: number } | null }>({ op: "stat", path: absPath }, 64 * 1024);
    return r.stat;
  }

  async readFile(absPath: string, opts: { byteOffset?: number; maxBytes: number }) {
    const r = await this.#call<{ size: number; data: string }>(
      { op: "read", path: absPath, byteOffset: opts.byteOffset ?? 0, maxBytes: opts.maxBytes },
      Math.ceil((opts.maxBytes * 4) / 3) + 64 * 1024,
    );
    return { size: r.size, data: Buffer.from(r.data, "base64") };
  }

  async writeFile(absPath: string, content: string | Uint8Array) {
    const data = Buffer.from(typeof content === "string" ? Buffer.from(content, "utf8") : content).toString("base64");
    await this.#call({ op: "write", path: absPath, data }, 64 * 1024);
  }

  async walk(absDir: string, opts: WalkOptions): Promise<WalkResult> {
    const budget = (opts.withContent ? Math.ceil((opts.maxTotalBytes * 4) / 3) : 0) + opts.maxEntries * 600 + 64 * 1024;
    const r = await this.#call<{
      walk: Omit<WalkResult, "entries" | "rootContent"> & { rootContent?: string; entries: Array<Omit<WalkEntry, "content"> & { content?: string }> };
    }>({ op: "walk", path: absDir, opts }, Math.min(budget, 16 * 1024 * 1024));
    const w = r.walk;
    return {
      rootType: w.rootType,
      rootSize: w.rootSize,
      truncated: w.truncated,
      ...(w.rootContent !== undefined ? { rootContent: Buffer.from(w.rootContent, "base64") } : {}),
      entries: w.entries.map((e) => ({ ...e, content: e.content !== undefined ? Buffer.from(e.content, "base64") : undefined })),
    };
  }
}

/** LocalLease exposes a host AgentFs; any other lease gets the sandboxed exec implementation. */
export function agentFsFor(lease: SandboxLease): AgentFs {
  const candidate = (lease as SandboxLease & { agentFs?: AgentFs }).agentFs;
  return candidate ?? new ExecAgentFs(lease);
}
