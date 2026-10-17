/**
 * Virtual path policy for the customer filesystem session.
 *
 *  $KNOWLEDGE/...      published procedural-memory revision (read-only), sandbox /memory/knowledge
 *  $WORK/scratch/...   private writable scratch for this workspace,       sandbox /work/scratch
 *
 * Relative paths resolve against $WORK/scratch (the shell's cwd). Anything else
 * (other absolute paths, traversal, NUL/control characters, quoted paths, other
 * variables) is rejected on the host before reaching a filesystem or argv.
 */

export const KNOWLEDGE_MOUNT = "/memory/knowledge";
export const WORK_MOUNT = "/work";
export const SCRATCH_MOUNT = "/work/scratch";
export const KNOWLEDGE_VAR = "$KNOWLEDGE";
export const SCRATCH_VAR = "$WORK/scratch";
export const MAX_VIRTUAL_PATH_LENGTH = 2_000;
const MAX_SEGMENTS = 64;
const MAX_SEGMENT_BYTES = 255;

export type VirtualRoot = "knowledge" | "scratch";

export interface VirtualPath {
  root: VirtualRoot;
  /** POSIX path relative to the root; "" is the root itself. */
  rel: string;
}

export class CustomerToolError extends Error {
  constructor(
    readonly code:
      | "invalid_path"
      | "read_only"
      | "not_found"
      | "not_a_file"
      | "not_a_directory"
      | "invalid_input"
      | "too_large"
      | "unknown_command"
      | "limit"
      | "pattern_timeout"
      | "sandbox_unavailable"
      | "workspace_not_found"
      | "edit_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "CustomerToolError";
  }
}

const ROOT_ALIASES: ReadonlyArray<[prefix: string, root: VirtualRoot]> = [
  ["${KNOWLEDGE}", "knowledge"],
  ["$KNOWLEDGE", "knowledge"],
  [KNOWLEDGE_MOUNT, "knowledge"],
  ["${WORK}/scratch", "scratch"],
  ["$WORK/scratch", "scratch"],
  ["${SCRATCH}", "scratch"],
  ["$SCRATCH", "scratch"],
  [SCRATCH_MOUNT, "scratch"],
];

function invalid(message: string): never {
  throw new CustomerToolError("invalid_path", message);
}

/** Normalize a user-supplied path into a (root, rel) pair or throw `invalid_path`. */
export function normalizeVirtualPath(input: unknown): VirtualPath {
  if (typeof input !== "string") invalid("Path must be a string");
  const raw = input.trim();
  if (raw.length === 0) invalid("Path must not be empty");
  if (raw.length > MAX_VIRTUAL_PATH_LENGTH) invalid(`Path exceeds ${MAX_VIRTUAL_PATH_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) invalid("Path contains NUL or control characters");
  if (raw.includes("\\")) invalid("Path must use forward slashes");
  if (/^['"`]/.test(raw) || /['"`]$/.test(raw)) invalid("Do not wrap tool path values in shell quotes");
  if (raw.startsWith("~")) invalid("Home-directory paths are not available; use $KNOWLEDGE/... or $WORK/scratch/...");

  let root: VirtualRoot | undefined;
  let rest = raw;
  for (const [prefix, r] of ROOT_ALIASES) {
    if (raw === prefix || raw.startsWith(`${prefix}/`)) {
      root = r;
      rest = raw.slice(prefix.length);
      break;
    }
  }
  if (!root) {
    if (raw === "$WORK" || raw === "${WORK}" || raw === WORK_MOUNT || raw === `${WORK_MOUNT}/` || raw === "$WORK/" || raw === "${WORK}/") {
      invalid("Only $WORK/scratch is available below $WORK; use $WORK/scratch/...");
    }
    if (raw.startsWith("$")) {
      const name = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(raw)?.[1] ?? raw;
      invalid(`Unknown root ${name}. Customer workspaces expose only $KNOWLEDGE (published memory, read-only) and $WORK/scratch (private scratch).`);
    }
    if (raw.startsWith("/")) {
      invalid("Absolute paths outside $KNOWLEDGE (/memory/knowledge) and $WORK/scratch (/work/scratch) are not accessible");
    }
    root = "scratch";
    rest = raw;
  }

  const segments: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") invalid("Path traversal ('..') is not allowed");
    if (Buffer.byteLength(seg, "utf8") > MAX_SEGMENT_BYTES) invalid("Path segment is too long");
    segments.push(seg);
  }
  if (segments.length > MAX_SEGMENTS) invalid(`Path is deeper than ${MAX_SEGMENTS} levels`);
  return { root, rel: segments.join("/") };
}

export function displayPath(vp: VirtualPath): string {
  const base = vp.root === "knowledge" ? KNOWLEDGE_VAR : SCRATCH_VAR;
  return vp.rel ? `${base}/${vp.rel}` : base;
}

export function sandboxPath(vp: VirtualPath): string {
  const base = vp.root === "knowledge" ? KNOWLEDGE_MOUNT : SCRATCH_MOUNT;
  return vp.rel ? `${base}/${vp.rel}` : base;
}

/** Normalize a path that must be a writable file below $WORK/scratch. */
export function normalizeScratchFilePath(input: unknown): VirtualPath {
  const vp = normalizeVirtualPath(input);
  if (vp.root !== "scratch") {
    throw new CustomerToolError("read_only", `${displayPath(vp)} is published procedural memory and is read-only; write only below $WORK/scratch`);
  }
  if (vp.rel === "") throw new CustomerToolError("invalid_path", "Path must name a file below $WORK/scratch, not the scratch root");
  return vp;
}

export function joinRel(a: string, b: string): string {
  return a ? (b ? `${a}/${b}` : a) : b;
}
