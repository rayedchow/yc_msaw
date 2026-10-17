import { Worker } from "node:worker_threads";
import { CustomerToolError, displayPath, joinRel, type VirtualPath, type VirtualRoot } from "./paths.js";

/**
 * In-memory view of one subtree (knowledge revision or a bounded scratch snapshot)
 * and the read/ls/find/grep semantics shared by both roots, so host-side
 * knowledge results are identical to scratch results produced from the sandbox.
 */

export const MAX_READ_BYTES = 50 * 1024;
export const MAX_READ_LINES = 2_000;
export const MAX_LIST_LIMIT = 2_000;
export const MAX_GREP_LINE_CHARS = 500;
export const MAX_GREP_PATTERN_CHARS = 1_000;
export const MAX_GREP_SCAN_BYTES = 32 * 1024 * 1024;
export const GREP_REGEX_TIMEOUT_MS = 2_000;

export type NodeType = "file" | "dir" | "symlink" | "other";

export interface TreeNode {
  type: NodeType;
  size: number;
  content?: Buffer;
  /** Content exists but was not loaded (too large for the snapshot budget). */
  contentOmitted?: boolean;
}

export class VTree {
  readonly nodes = new Map<string, TreeNode>();
  #children = new Map<string, Set<string>>();
  /** True if the snapshot that produced this tree hit an entry limit. */
  truncated = false;

  constructor(readonly root: VirtualRoot) {
    this.nodes.set("", { type: "dir", size: 0 });
  }

  add(rel: string, node: TreeNode): void {
    if (rel === "") return;
    // Ancestors are directories.
    const parts = rel.split("/");
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const next = joinRel(cur, parts[i]!);
      if (!this.nodes.has(next)) this.nodes.set(next, { type: "dir", size: 0 });
      this.#link(cur, parts[i]!);
      cur = next;
    }
    this.nodes.set(rel, node);
    this.#link(cur, parts[parts.length - 1]!);
  }

  #link(parent: string, name: string): void {
    let set = this.#children.get(parent);
    if (!set) this.#children.set(parent, (set = new Set()));
    set.add(name);
  }

  get(rel: string): TreeNode | undefined {
    return this.nodes.get(rel);
  }

  children(rel: string): string[] {
    return [...(this.#children.get(rel) ?? [])].sort(compareNames);
  }

  /** Depth-first, name-sorted descendants of rel (excluding rel itself). */
  *descendants(rel: string): Generator<[string, TreeNode]> {
    for (const name of this.children(rel)) {
      const child = joinRel(rel, name);
      const node = this.nodes.get(child);
      if (!node) continue;
      yield [child, node];
      if (node.type === "dir") yield* this.descendants(child);
    }
  }

  static fromFiles(root: VirtualRoot, files: ReadonlyMap<string, string>): VTree {
    const tree = new VTree(root);
    for (const [p, content] of [...files.entries()].sort(([a], [b]) => compareNames(a, b))) {
      const buf = Buffer.from(content, "utf8");
      tree.add(p, { type: "file", size: buf.byteLength, content: buf });
    }
    return tree;
  }
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function notFound(vp: VirtualPath, tree?: VTree): CustomerToolError {
  let hint = "";
  if (tree) {
    const parent = vp.rel.includes("/") ? vp.rel.slice(0, vp.rel.lastIndexOf("/")) : "";
    const near = tree.children(parent).slice(0, 10);
    if (tree.get(parent)?.type === "dir" && near.length) {
      hint = ` Entries in ${displayPath({ root: vp.root, rel: parent })}: ${near.join(", ")}`;
    }
  }
  return new CustomerToolError("not_found", `No such file or directory: ${displayPath(vp)}.${hint}`);
}

// ---------------------------------------------------------------- read

export interface ReadOptions {
  offset?: number;
  limit?: number;
  byteOffset?: number;
  byteLimit?: number;
}

export interface ReadReceipt {
  path: string;
  content: string;
  totalBytes: number;
  mode: "lines" | "bytes";
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  nextOffset?: number;
  byteOffset?: number;
  nextByteOffset?: number;
  truncated: boolean;
  /** The file was larger than the host-side load bound; line numbers cover only the loaded prefix. */
  fileTruncated?: boolean;
}

/** Byte-slice receipt; `data` must already be the requested window (or the whole file). */
export function readBytesSlice(path: string, data: Buffer, totalBytes: number, windowStart: number, opts: ReadOptions): ReadReceipt {
  const byteOffset = opts.byteOffset ?? 0;
  const byteLimit = Math.min(opts.byteLimit ?? MAX_READ_BYTES, MAX_READ_BYTES);
  if (byteOffset > totalBytes) throw new CustomerToolError("invalid_input", `byteOffset ${byteOffset} is beyond the end of ${path} (${totalBytes} bytes)`);
  const rel = byteOffset - windowStart;
  const slice = data.subarray(Math.max(0, rel), Math.max(0, rel) + byteLimit);
  const end = byteOffset + slice.byteLength;
  const truncated = end < totalBytes;
  return {
    path,
    content: slice.toString("utf8"),
    totalBytes,
    mode: "bytes",
    byteOffset,
    truncated,
    ...(truncated ? { nextByteOffset: end } : {}),
  };
}

/** Line-slice receipt over a whole (or prefix-loaded) file. */
export function readLinesSlice(path: string, data: Buffer, totalBytes: number, opts: ReadOptions): ReadReceipt {
  const fileTruncated = data.byteLength < totalBytes;
  const text = data.toString("utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const offset = opts.offset ?? 1;
  const limit = Math.min(opts.limit ?? MAX_READ_LINES, MAX_READ_LINES);
  if (totalLines === 0) {
    if (offset > 1) throw new CustomerToolError("invalid_input", `offset ${offset} is beyond the end of ${path} (empty file)`);
    return { path, content: "", totalBytes, mode: "lines", startLine: 1, endLine: 0, totalLines: 0, truncated: false };
  }
  if (offset > totalLines) {
    throw new CustomerToolError("invalid_input", `offset ${offset} is beyond the end of ${path} (${totalLines} lines)`);
  }
  const out: string[] = [];
  let bytes = 0;
  let cut = false;
  let i = offset - 1;
  for (; i < totalLines && out.length < limit; i++) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > MAX_READ_BYTES) {
      if (out.length === 0) {
        // A single oversized line: return its first bytes and point at byte reads.
        out.push(Buffer.from(line, "utf8").subarray(0, MAX_READ_BYTES).toString("utf8"));
        i++;
      }
      cut = true;
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }
  const endLine = offset - 1 + out.length;
  const truncated = cut || endLine < totalLines || fileTruncated;
  return {
    path,
    content: out.join("\n"),
    totalBytes,
    mode: "lines",
    startLine: offset,
    endLine,
    totalLines,
    truncated,
    ...(endLine < totalLines ? { nextOffset: endLine + 1 } : {}),
    ...(fileTruncated ? { fileTruncated: true } : {}),
  };
}

export function readFromTree(tree: VTree, vp: VirtualPath, opts: ReadOptions): ReadReceipt {
  const node = tree.get(vp.rel);
  const path = displayPath(vp);
  if (!node) throw notFound(vp, tree);
  if (node.type === "dir") throw new CustomerToolError("not_a_file", `${path} is a directory; use ls or find`);
  if (node.type !== "file" || !node.content) throw new CustomerToolError("not_a_file", `${path} is not a readable regular file`);
  if (opts.byteOffset !== undefined || opts.byteLimit !== undefined) return readBytesSlice(path, node.content, node.size, 0, opts);
  return readLinesSlice(path, node.content, node.size, opts);
}

// ---------------------------------------------------------------- ls

export interface LsEntry {
  name: string;
  type: NodeType;
  size: number;
}

export interface LsReceipt {
  path: string;
  type: NodeType;
  entries: LsEntry[];
  total: number;
  truncated: boolean;
}

export function lsTree(tree: VTree, vp: VirtualPath, limit = MAX_LIST_LIMIT): LsReceipt {
  const node = tree.get(vp.rel);
  const path = displayPath(vp);
  if (!node) throw notFound(vp, tree);
  if (node.type !== "dir") {
    const name = vp.rel.split("/").pop() ?? vp.rel;
    return { path, type: node.type, entries: [{ name, type: node.type, size: node.size }], total: 1, truncated: false };
  }
  const names = tree.children(vp.rel);
  const cap = Math.min(limit, MAX_LIST_LIMIT);
  const entries = names.slice(0, cap).map((name) => {
    const child = tree.get(joinRel(vp.rel, name))!;
    return { name: child.type === "dir" ? `${name}/` : name, type: child.type, size: child.size };
  });
  return { path, type: "dir", entries, total: names.length, truncated: names.length > cap || tree.truncated };
}

// ---------------------------------------------------------------- glob

/** Convert a glob (`*`, `**`, `?`, `[...]`, `{a,b}`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  if (glob.length > 500) throw new CustomerToolError("invalid_input", "Glob pattern is too long");
  let re = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        const atSegStart = i === 0 || glob[i - 1] === "/";
        if (atSegStart && slashAfter) {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) {
        re += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, "\\\\").replace(/\[/g, "\\[")}]`;
      i = close;
    } else if (c === "{") {
      braceDepth++;
      re += "(?:";
    } else if (c === "}" && braceDepth > 0) {
      braceDepth--;
      re += ")";
    } else if (c === "," && braceDepth > 0) {
      re += "|";
    } else {
      re += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
    }
  }
  while (braceDepth-- > 0) re += ")";
  try {
    return new RegExp(`^${re}$`);
  } catch {
    throw new CustomerToolError("invalid_input", `Invalid glob pattern: ${glob}`);
  }
}

/** fd/rg semantics: a glob without "/" matches the basename at any depth; otherwise the path relative to the search root. */
export function globMatcher(glob: string): (relToSearchRoot: string) => boolean {
  const re = globToRegExp(glob);
  const full = glob.includes("/");
  return (rel) => re.test(full ? rel : rel.slice(rel.lastIndexOf("/") + 1));
}

// ---------------------------------------------------------------- find

export interface FindReceipt {
  path: string;
  pattern: string;
  matches: string[];
  truncated: boolean;
}

export function findTree(tree: VTree, vp: VirtualPath, pattern: string, limit = MAX_LIST_LIMIT): FindReceipt {
  const node = tree.get(vp.rel);
  const path = displayPath(vp);
  if (!node) throw notFound(vp, tree);
  const match = globMatcher(pattern);
  const cap = Math.min(limit, MAX_LIST_LIMIT);
  const matches: string[] = [];
  let truncated = tree.truncated;
  if (node.type !== "dir") {
    const name = vp.rel.split("/").pop() ?? "";
    if (match(name)) matches.push(path);
    return { path, pattern, matches, truncated: false };
  }
  for (const [rel, child] of tree.descendants(vp.rel)) {
    const relToRoot = vp.rel ? rel.slice(vp.rel.length + 1) : rel;
    if (!match(relToRoot)) continue;
    if (matches.length >= cap) {
      truncated = true;
      break;
    }
    const shown = displayPath({ root: vp.root, rel });
    matches.push(child.type === "dir" ? `${shown}/` : shown);
  }
  return { path, pattern, matches, truncated };
}

// ---------------------------------------------------------------- grep

export interface GrepOptions {
  pattern: string;
  glob?: string;
  literal: boolean;
  ignoreCase: boolean;
  limit: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepReceipt {
  path: string;
  pattern: string;
  matches: GrepMatch[];
  filesSearched: number;
  /** Files skipped because they were binary or too large to load. */
  filesSkipped: number;
  truncated: boolean;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function clipLine(line: string): string {
  return line.length > MAX_GREP_LINE_CHARS ? `${line.slice(0, MAX_GREP_LINE_CHARS)}…` : line;
}

const GREP_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { pattern, flags, files, limit, maxLine } = workerData;
const re = new RegExp(pattern, flags);
const out = [];
let truncated = false;
outer: for (const [p, text] of files) {
  const lines = text.split("\\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.endsWith("\\r")) line = line.slice(0, -1);
    if (re.test(line)) {
      if (out.length >= limit) { truncated = true; break outer; }
      out.push([p, i + 1, line.length > maxLine ? line.slice(0, maxLine) + "\\u2026" : line]);
    }
  }
}
parentPort.postMessage({ out, truncated });
`;

/** Run regex matching in a worker thread with a hard wall-clock limit (catastrophic-backtracking guard). */
function grepRegexInWorker(
  pattern: string,
  flags: string,
  files: Array<[string, string]>,
  limit: number,
): Promise<{ out: Array<[string, number, string]>; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(GREP_WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, flags, files, limit, maxLine: MAX_GREP_LINE_CHARS },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(
        new CustomerToolError(
          "pattern_timeout",
          `Regex search exceeded ${GREP_REGEX_TIMEOUT_MS}ms (pattern may backtrack catastrophically); simplify it or use literal: true`,
        ),
      );
    }, GREP_REGEX_TIMEOUT_MS);
    worker.once("message", (msg: { out: Array<[string, number, string]>; truncated: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(msg);
    });
    worker.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CustomerToolError("invalid_input", `Regex search failed: ${err.message}`));
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CustomerToolError("invalid_input", `Regex search worker exited (${code})`));
    });
  });
}

export async function grepTree(tree: VTree, vp: VirtualPath, opts: GrepOptions): Promise<GrepReceipt> {
  const node = tree.get(vp.rel);
  const path = displayPath(vp);
  if (!node) throw notFound(vp, tree);
  if (opts.pattern.length === 0) throw new CustomerToolError("invalid_input", "Pattern must not be empty");
  if (opts.pattern.length > MAX_GREP_PATTERN_CHARS) throw new CustomerToolError("invalid_input", `Pattern exceeds ${MAX_GREP_PATTERN_CHARS} characters`);
  const flags = opts.ignoreCase ? "i" : "";
  if (!opts.literal) {
    try {
      new RegExp(opts.pattern, flags);
    } catch (error) {
      throw new CustomerToolError("invalid_input", `Invalid regular expression: ${(error as Error).message}`);
    }
  }
  const globMatch = opts.glob ? globMatcher(opts.glob) : null;
  const limit = Math.min(Math.max(1, opts.limit), MAX_LIST_LIMIT);

  const candidates: Array<[string, TreeNode]> = node.type === "dir" ? [...tree.descendants(vp.rel)] : [[vp.rel, node]];
  const files: Array<[string, string]> = [];
  let filesSkipped = 0;
  let scanned = 0;
  let truncated = tree.truncated;
  for (const [rel, n] of candidates) {
    if (n.type !== "file") continue;
    if (globMatch && node.type === "dir") {
      const relToRoot = vp.rel ? rel.slice(vp.rel.length + 1) : rel;
      if (!globMatch(relToRoot)) continue;
    }
    if (!n.content || n.contentOmitted || looksBinary(n.content)) {
      filesSkipped++;
      continue;
    }
    if (scanned + n.content.byteLength > MAX_GREP_SCAN_BYTES) {
      truncated = true;
      break;
    }
    scanned += n.content.byteLength;
    files.push([displayPath({ root: vp.root, rel }), n.content.toString("utf8")]);
  }

  let matches: GrepMatch[] = [];
  if (opts.literal) {
    const needle = opts.ignoreCase ? opts.pattern.toLowerCase() : opts.pattern;
    outer: for (const [p, text] of files) {
      const lines = text.split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i]!;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const hay = opts.ignoreCase ? line.toLowerCase() : line;
        if (hay.includes(needle)) {
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
          matches.push({ path: p, line: i + 1, text: clipLine(line) });
        }
      }
    }
  } else if (files.length > 0) {
    const r = await grepRegexInWorker(opts.pattern, flags, files, limit);
    matches = r.out.map(([p, line, text]) => ({ path: p, line, text }));
    truncated = truncated || r.truncated;
  }
  return { path, pattern: opts.pattern, matches, filesSearched: files.length, filesSkipped, truncated };
}
