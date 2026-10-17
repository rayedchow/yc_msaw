import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxLease } from "../sandbox/types.js";
import { newId } from "../util.js";
import { normalizeWikiPath } from "../wiki/paths.js";

/**
 * Per-agent build workspace (AEye/Silicon layout, adapted):
 *   inputs/        read-only  daily trace cohort: manifest.json, sessions/<id>/{session.json,events.jsonl,payloads/*}
 *   published/     read-only  pinned published memory revision
 *   knowledge/     writable   this agent's draft (root: copy of published; child: parent's draft at spawn,
 *                             writable only inside its knowledgeWriteScope - enforced by tools.ts)
 *   parent-draft/  read-only  point-in-time snapshot of the root draft (only for includeParentDraft children)
 *   work/          writable   private scratch and handoff notes; never published, never copied to children
 *
 * The host validates every agent-supplied path (parseAgentPath) before any
 * backend call. Backends receive only (area, canonical relative path).
 */
export type BuildArea = "inputs" | "published" | "knowledge" | "parent-draft" | "work";
export type WritableArea = "knowledge" | "work";
export const BUILD_AREAS: readonly BuildArea[] = ["inputs", "published", "knowledge", "parent-draft", "work"];
export const WIKI_AREAS: ReadonlySet<BuildArea> = new Set(["published", "knowledge", "parent-draft"]);

export const MAX_READ_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_KNOWLEDGE_WRITE_BYTES = 64 * 1024;
export const MAX_WORK_WRITE_BYTES = 1024 * 1024;
/** SandboxLease implementations cap captured output at 16 MiB per stream; larger reads fail explicitly. */
const SANDBOX_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PLAIN_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._@+=-]{0,199}$/;
const MAX_PLAIN_DEPTH = 12;

export class WorkspaceError extends Error {
  constructor(
    readonly code: "invalid_path" | "read_only" | "not_found" | "not_mounted" | "too_large" | "backend_error" | "already_exists",
    message: string,
  ) {
    super(message);
  }
}

function checkPlainRel(area: BuildArea, rel: string, allowDirectory: boolean): string {
  const p = rel.replace(/\/+$/, "");
  if (p === "") {
    if (allowDirectory) return "";
    throw new WorkspaceError("invalid_path", `${area}/ is a directory; name a file`);
  }
  const segs = p.split("/");
  if (segs.length > MAX_PLAIN_DEPTH) throw new WorkspaceError("invalid_path", `Path deeper than ${MAX_PLAIN_DEPTH} levels`);
  for (const s of segs) {
    if (s === "." || s === ".." || !PLAIN_SEGMENT_RE.test(s)) {
      throw new WorkspaceError("invalid_path", `Invalid ${area}/ path segment ${JSON.stringify(s)} (allowed: A-Z a-z 0-9 _ . @ + = -, no traversal)`);
    }
  }
  return segs.join("/");
}

/** Validate an area-relative path. Wiki areas use the wiki path policy and must already be canonical. */
export function checkAreaPath(area: BuildArea, rel: string, opts: { allowDirectory?: boolean } = {}): string {
  if (!BUILD_AREAS.includes(area)) throw new WorkspaceError("invalid_path", `Unknown area ${area}`);
  if (typeof rel !== "string" || rel.includes("\0") || rel.includes("\\")) throw new WorkspaceError("invalid_path", "Path contains forbidden characters");
  if (!WIKI_AREAS.has(area)) return checkPlainRel(area, rel, opts.allowDirectory ?? false);
  const trimmed = rel.replace(/\/+$/, "");
  let normalized: string;
  try {
    normalized = normalizeWikiPath(trimmed, opts);
  } catch (error) {
    throw new WorkspaceError("invalid_path", `${area}/${rel}: ${(error as Error).message}`);
  }
  if (normalized !== trimmed) throw new WorkspaceError("invalid_path", `Non-canonical path ${area}/${rel} (use ${area}/${normalized})`);
  return normalized;
}

/** Parse an agent-facing path such as "knowledge/a/b.md" or "inputs/sessions/s1/events.jsonl". */
export function parseAgentPath(p: unknown, opts: { allowDirectory?: boolean } = {}): { area: BuildArea; rel: string } {
  if (typeof p !== "string" || p.length === 0 || p.length > 1000) throw new WorkspaceError("invalid_path", "path must be a non-empty string");
  const clean = p.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  // Longest area name first so "parent-draft" is never mistaken for another area.
  for (const area of [...BUILD_AREAS].sort((a, b) => b.length - a.length)) {
    if (clean === area || clean === `${area}/`) {
      if (!opts.allowDirectory) throw new WorkspaceError("invalid_path", `${area}/ is a directory; name a file`);
      return { area, rel: "" };
    }
    if (clean.startsWith(`${area}/`)) return { area, rel: checkAreaPath(area, clean.slice(area.length + 1), opts) };
  }
  throw new WorkspaceError("invalid_path", `Path must start with one of ${BUILD_AREAS.map((a) => `${a}/`).join(", ")} (got ${JSON.stringify(p)})`);
}

export function agentPath(area: BuildArea, rel: string): string {
  return rel ? `${area}/${rel}` : `${area}/`;
}

export interface FileEntry {
  path: string;
  bytes: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepOptions {
  pattern: string;
  match: "literal" | "regex";
  ignoreCase: boolean;
  maxMatches: number;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  /** Exact engine that ran (receipts name it; literal mode is identical across backends). */
  engine: string;
}

export interface WorkspaceSeed {
  inputs: ReadonlyMap<string, string>;
  published: ReadonlyMap<string, string>;
  knowledge: ReadonlyMap<string, string>;
  parentDraft: ReadonlyMap<string, string> | null;
}

export interface BuildWorkspace {
  readonly kind: "local" | "modal";
  readonly id: string;
  /** Materialize all areas. inputs/, published/ and parent-draft/ become read-only. */
  init(seed: WorkspaceSeed): Promise<void>;
  mounted(area: BuildArea): boolean;
  readFile(area: BuildArea, rel: string): Promise<Buffer>;
  writeFile(area: WritableArea, rel: string, content: string): Promise<void>;
  /** Remove a file and prune now-empty parent directories inside the area. */
  removeFile(area: WritableArea, rel: string): Promise<void>;
  exists(area: BuildArea, rel: string): Promise<boolean>;
  /** Recursive regular-file listing under a directory ("" = area root), sorted by path. */
  list(area: BuildArea, relDir: string): Promise<FileEntry[]>;
  grep(area: BuildArea, relDir: string, opts: GrepOptions): Promise<GrepResult>;
  /** Exact file map of an area (used for knowledge snapshots, patches and validation). */
  snapshot(area: "knowledge" | "work"): Promise<Map<string, string>>;
  dispose(): Promise<void>;
}

export interface WorkspaceSpec {
  buildId: string;
  agentId: string;
  depth: number;
}
export type BuildWorkspaceFactory = (spec: WorkspaceSpec) => BuildWorkspace;

function compileGrep(opts: GrepOptions): (line: string) => boolean {
  if (opts.match === "literal") {
    const needle = opts.ignoreCase ? opts.pattern.toLowerCase() : opts.pattern;
    return opts.ignoreCase ? (l) => l.toLowerCase().includes(needle) : (l) => l.includes(needle);
  }
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, opts.ignoreCase ? "i" : "");
  } catch (error) {
    throw new WorkspaceError("invalid_path", `Invalid regex: ${(error as Error).message}`);
  }
  return (l) => re.test(l);
}

const MATCH_TEXT_MAX = 300;

/**
 * Host temp-directory workspace. Only validated file operations run here (no
 * command execution), so it is safe for offline builds and tests.
 */
export class LocalBuildWorkspace implements BuildWorkspace {
  readonly kind = "local" as const;
  readonly id = newId("ws");
  #root = "";
  #mounted = new Set<BuildArea>();

  async init(seed: WorkspaceSeed): Promise<void> {
    this.#root = await fs.mkdtemp(path.join(os.tmpdir(), "procmem-build-"));
    const put = async (area: BuildArea, rel: string, content: string, mode: number) => {
      const file = this.#abs(area, checkAreaPath(area, rel));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, { mode });
    };
    for (const area of ["inputs", "published", "knowledge", "work"] as const) {
      await fs.mkdir(path.join(this.#root, area), { recursive: true });
      this.#mounted.add(area);
    }
    for (const [rel, c] of seed.inputs) await put("inputs", rel, c, 0o444);
    for (const [rel, c] of seed.published) await put("published", rel, c, 0o444);
    for (const [rel, c] of seed.knowledge) await put("knowledge", rel, c, 0o644);
    if (seed.parentDraft) {
      await fs.mkdir(path.join(this.#root, "parent-draft"), { recursive: true });
      this.#mounted.add("parent-draft");
      for (const [rel, c] of seed.parentDraft) await put("parent-draft", rel, c, 0o444);
    }
  }

  mounted(area: BuildArea): boolean {
    return this.#mounted.has(area);
  }

  #abs(area: BuildArea, rel: string): string {
    if (!this.#root) throw new WorkspaceError("backend_error", "Workspace not initialized");
    const base = path.resolve(this.#root, area);
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new WorkspaceError("invalid_path", "Path escapes workspace");
    return abs;
  }

  #requireMounted(area: BuildArea) {
    if (!this.#mounted.has(area)) throw new WorkspaceError("not_mounted", `${area}/ is not mounted in this workspace`);
  }

  async readFile(area: BuildArea, rel: string): Promise<Buffer> {
    this.#requireMounted(area);
    const abs = this.#abs(area, rel);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new WorkspaceError("not_found", `No such file: ${agentPath(area, rel)}`);
    if (st.size > MAX_READ_FILE_BYTES) throw new WorkspaceError("too_large", `${agentPath(area, rel)} is ${st.size} bytes (max ${MAX_READ_FILE_BYTES})`);
    return fs.readFile(abs);
  }

  async writeFile(area: WritableArea, rel: string, content: string): Promise<void> {
    this.#requireMounted(area);
    const abs = this.#abs(area, rel);
    const parentDir = path.dirname(abs);
    await fs.mkdir(parentDir, { recursive: true });
    const st = await fs.lstat(abs).catch(() => null);
    if (st && !st.isFile()) throw new WorkspaceError("invalid_path", `${agentPath(area, rel)} exists and is not a regular file`);
    await fs.writeFile(abs, content, { mode: 0o644 });
  }

  async removeFile(area: WritableArea, rel: string): Promise<void> {
    this.#requireMounted(area);
    const abs = this.#abs(area, rel);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new WorkspaceError("not_found", `No such file: ${agentPath(area, rel)}`);
    await fs.rm(abs);
    const base = path.resolve(this.#root, area);
    let dir = path.dirname(abs);
    while (dir.startsWith(base + path.sep)) {
      if ((await fs.readdir(dir)).length > 0) break;
      await fs.rmdir(dir);
      dir = path.dirname(dir);
    }
  }

  async exists(area: BuildArea, rel: string): Promise<boolean> {
    if (!this.#mounted.has(area)) return false;
    const st = await fs.lstat(this.#abs(area, rel)).catch(() => null);
    return !!st && st.isFile();
  }

  async list(area: BuildArea, relDir: string): Promise<FileEntry[]> {
    this.#requireMounted(area);
    const start = this.#abs(area, relDir);
    const st = await fs.lstat(start).catch(() => null);
    if (!st || !st.isDirectory()) throw new WorkspaceError("not_found", `No such directory: ${agentPath(area, relDir)}`);
    const base = path.join(this.#root, area);
    const out: FileEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) out.push({ path: path.relative(base, abs).split(path.sep).join("/"), bytes: (await fs.stat(abs)).size });
      }
    };
    await walk(start);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async grep(area: BuildArea, relDir: string, opts: GrepOptions): Promise<GrepResult> {
    const test = compileGrep(opts);
    const matches: GrepMatch[] = [];
    for (const entry of await this.list(area, relDir)) {
      const bytes = await this.readFile(area, entry.path);
      if (bytes.includes(0)) continue; // binary files are skipped, like grep -I
      const lines = bytes.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!test(lines[i]!)) continue;
        if (matches.length >= opts.maxMatches) return { matches, truncated: true, engine: opts.match === "literal" ? "literal" : "ecmascript-regexp" };
        matches.push({ path: entry.path, line: i + 1, text: lines[i]!.slice(0, MATCH_TEXT_MAX) });
      }
    }
    return { matches, truncated: false, engine: opts.match === "literal" ? "literal" : "ecmascript-regexp" };
  }

  async snapshot(area: "knowledge" | "work"): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const e of await this.list(area, "")) out.set(e.path, (await this.readFile(area, e.path)).toString("utf8"));
    return out;
  }

  async dispose(): Promise<void> {
    if (this.#root) await fs.rm(this.#root, { recursive: true, force: true });
    this.#root = "";
  }
}

/**
 * Build workspace inside an isolated SandboxLease (Modal in production).
 * inputs/, published/ and parent-draft/ are root-owned and protected with
 * protectTree (OS-enforced read-only for the agent uid); knowledge/ and work/
 * are agent-owned. Every operation is a fixed argv with host-validated paths
 * passed as separate argv elements (never interpolated into a script).
 */
export class ModalBuildWorkspace implements BuildWorkspace {
  readonly kind = "modal" as const;
  readonly id = newId("ws");
  #lease: SandboxLease | null = null;
  #mounted = new Set<BuildArea>();
  readonly root: string;

  constructor(
    private readonly leaseFactory: () => Promise<SandboxLease>,
    opts: { root?: string; execTimeoutMs?: number } = {},
  ) {
    this.root = opts.root ?? "/build";
    if (!/^\/[a-z0-9/_-]+$/.test(this.root) || this.root.includes("..")) throw new WorkspaceError("invalid_path", "Invalid sandbox build root");
    this.#timeoutMs = opts.execTimeoutMs ?? 60_000;
  }
  readonly #timeoutMs: number;

  get leaseId(): string | null {
    return this.#lease?.id ?? null;
  }

  #dir(area: BuildArea): string {
    return `${this.root}/${area}`;
  }
  #abs(area: BuildArea, rel: string): string {
    return rel ? `${this.#dir(area)}/${rel}` : this.#dir(area);
  }
  #l(): SandboxLease {
    if (!this.#lease) throw new WorkspaceError("backend_error", "Workspace not initialized");
    return this.#lease;
  }
  async #exec(argv: string[], opts: { user?: "agent" | "root"; stdin?: string; maxOutputBytes?: number } = {}) {
    const r = await this.#l().exec(argv, { user: opts.user ?? "agent", timeoutMs: this.#timeoutMs, stdin: opts.stdin, maxOutputBytes: opts.maxOutputBytes ?? 1024 * 1024 });
    if (r.timedOut) throw new WorkspaceError("backend_error", `Sandbox command ${argv[0]} timed out after ${this.#timeoutMs}ms`);
    return r;
  }

  async init(seed: WorkspaceSeed): Promise<void> {
    this.#lease = await this.leaseFactory();
    const lease = this.#lease;
    const areas: BuildArea[] = ["inputs", "published", ...(seed.parentDraft ? (["parent-draft"] as const) : [])];
    const mk = await this.#exec(["mkdir", "-p", "--", ...areas.map((a) => this.#dir(a)), `${this.root}/.seed/knowledge`], { user: "root" });
    if (mk.exitCode !== 0) throw new WorkspaceError("backend_error", `mkdir failed: ${mk.stderr.slice(0, 400)}`);
    const files: Array<{ path: string; content: string }> = [];
    for (const [rel, c] of seed.inputs) files.push({ path: this.#abs("inputs", checkAreaPath("inputs", rel)), content: c });
    for (const [rel, c] of seed.published) files.push({ path: this.#abs("published", checkAreaPath("published", rel)), content: c });
    for (const [rel, c] of seed.parentDraft ?? []) files.push({ path: this.#abs("parent-draft", checkAreaPath("parent-draft", rel)), content: c });
    for (const [rel, c] of seed.knowledge) files.push({ path: `${this.root}/.seed/knowledge/${checkAreaPath("knowledge", rel)}`, content: c });
    if (files.length) await lease.writeFiles(files);
    for (const a of areas) {
      await lease.protectTree(this.#dir(a));
      this.#mounted.add(a);
    }
    await lease.makeAgentDir(this.#dir("knowledge"));
    await lease.makeAgentDir(this.#dir("work"));
    // Copy the seed as the agent uid so the draft is agent-owned, then remove the root-owned seed.
    const cp = await this.#exec(["cp", "-R", "--", `${this.root}/.seed/knowledge/.`, `${this.#dir("knowledge")}/`]);
    if (cp.exitCode !== 0) throw new WorkspaceError("backend_error", `Seeding knowledge/ failed: ${cp.stderr.slice(0, 400)}`);
    const rm = await this.#exec(["rm", "-rf", "--", `${this.root}/.seed`], { user: "root" });
    if (rm.exitCode !== 0) throw new WorkspaceError("backend_error", `Removing seed failed: ${rm.stderr.slice(0, 400)}`);
    this.#mounted.add("knowledge");
    this.#mounted.add("work");
  }

  mounted(area: BuildArea): boolean {
    return this.#mounted.has(area);
  }
  #requireMounted(area: BuildArea) {
    if (!this.#mounted.has(area)) throw new WorkspaceError("not_mounted", `${area}/ is not mounted in this workspace`);
  }

  async readFile(area: BuildArea, rel: string): Promise<Buffer> {
    this.#requireMounted(area);
    const r = await this.#exec(["cat", "--", this.#abs(area, rel)], { maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES });
    if (r.exitCode !== 0) throw new WorkspaceError("not_found", `No such file: ${agentPath(area, rel)} (${r.stderr.trim().slice(0, 200)})`);
    if (r.stdoutTruncated) throw new WorkspaceError("too_large", `${agentPath(area, rel)} exceeds ${SANDBOX_MAX_OUTPUT_BYTES} bytes`);
    return Buffer.from(r.stdout, "utf8");
  }

  async writeFile(area: WritableArea, rel: string, content: string): Promise<void> {
    this.#requireMounted(area);
    const r = await this.#exec(["bash", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "bash", this.#abs(area, rel)], { stdin: content });
    if (r.exitCode !== 0) throw new WorkspaceError("backend_error", `Write failed for ${agentPath(area, rel)}: ${r.stderr.trim().slice(0, 300)}`);
  }

  async removeFile(area: WritableArea, rel: string): Promise<void> {
    this.#requireMounted(area);
    if (!(await this.exists(area, rel))) throw new WorkspaceError("not_found", `No such file: ${agentPath(area, rel)}`);
    const r = await this.#exec(["bash", "-c", 'rm -- "$1" && find "$2" -mindepth 1 -type d -empty -delete', "bash", this.#abs(area, rel), this.#dir(area)]);
    if (r.exitCode !== 0) throw new WorkspaceError("backend_error", `Delete failed for ${agentPath(area, rel)}: ${r.stderr.trim().slice(0, 300)}`);
  }

  async exists(area: BuildArea, rel: string): Promise<boolean> {
    if (!this.#mounted.has(area)) return false;
    const r = await this.#exec(["test", "-f", this.#abs(area, rel)]);
    return r.exitCode === 0;
  }

  async list(area: BuildArea, relDir: string): Promise<FileEntry[]> {
    this.#requireMounted(area);
    const r = await this.#exec(["find", this.#abs(area, relDir), "-type", "f", "-printf", "%P\\t%s\\n"], { maxOutputBytes: 8 * 1024 * 1024 });
    if (r.exitCode !== 0) throw new WorkspaceError("not_found", `No such directory: ${agentPath(area, relDir)} (${r.stderr.trim().slice(0, 200)})`);
    if (r.stdoutTruncated) throw new WorkspaceError("too_large", `Listing of ${agentPath(area, relDir)} exceeded the output bound`);
    const out: FileEntry[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      const tab = line.lastIndexOf("\t");
      const sub = line.slice(0, tab);
      out.push({ path: relDir ? `${relDir}/${sub}` : sub, bytes: Number(line.slice(tab + 1)) });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async grep(area: BuildArea, relDir: string, opts: GrepOptions): Promise<GrepResult> {
    this.#requireMounted(area);
    const dir = this.#abs(area, relDir);
    const flags = ["-rnI", opts.match === "literal" ? "-F" : "-E", ...(opts.ignoreCase ? ["-i"] : []), "-e", opts.pattern];
    const limit = String(opts.maxMatches + 1);
    const r = await this.#exec(
      ["bash", "-c", 'set -o pipefail; d="$1"; n="$2"; shift 2; grep "$@" -- "$d" | head -n "$n"; s=$?; [ "$s" -eq 1 ] || [ "$s" -eq 141 ] && exit 0; exit "$s"', "bash", dir, limit, ...flags],
      { maxOutputBytes: 4 * 1024 * 1024 },
    );
    if (r.exitCode !== 0) throw new WorkspaceError("backend_error", `grep failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 300)}`);
    const matches: GrepMatch[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.startsWith(`${this.#dir(area)}/`)) continue;
      const rest = line.slice(this.#dir(area).length + 1);
      const c1 = rest.indexOf(":");
      const c2 = rest.indexOf(":", c1 + 1);
      if (c1 < 0 || c2 < 0) continue;
      matches.push({ path: rest.slice(0, c1), line: Number(rest.slice(c1 + 1, c2)), text: rest.slice(c2 + 1, c2 + 1 + MATCH_TEXT_MAX) });
    }
    const truncated = matches.length > opts.maxMatches || r.stdoutTruncated;
    return { matches: matches.slice(0, opts.maxMatches), truncated, engine: opts.match === "literal" ? "literal (grep -F)" : "posix-ere (grep -E)" };
  }

  async snapshot(area: "knowledge" | "work"): Promise<Map<string, string>> {
    this.#requireMounted(area);
    const r = await this.#exec(
      ["bash", "-c", 'cd -- "$1" && find . -type f -print0 | while IFS= read -r -d "" f; do printf "%s\\t" "${f#./}"; base64 -w0 -- "$f"; printf "\\n"; done', "bash", this.#dir(area)],
      { maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES },
    );
    if (r.exitCode !== 0) throw new WorkspaceError("backend_error", `Snapshot of ${area}/ failed: ${r.stderr.trim().slice(0, 300)}`);
    if (r.stdoutTruncated) throw new WorkspaceError("too_large", `Snapshot of ${area}/ exceeded the output bound`);
    const out = new Map<string, string>();
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      out.set(line.slice(0, tab), Buffer.from(line.slice(tab + 1), "base64").toString("utf8"));
    }
    return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  async dispose(): Promise<void> {
    const lease = this.#lease;
    this.#lease = null;
    if (lease) await lease.terminate();
  }
}

/** Factory helpers. */
export const localWorkspaceFactory: BuildWorkspaceFactory = () => new LocalBuildWorkspace();
export function modalWorkspaceFactory(leaseFactory: (spec: WorkspaceSpec) => Promise<SandboxLease>, opts: { execTimeoutMs?: number } = {}): BuildWorkspaceFactory {
  return (spec) => new ModalBuildWorkspace(() => leaseFactory(spec), opts);
}
