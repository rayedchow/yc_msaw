/**
 * Path policy for the procedural memory wiki. All paths are POSIX, relative to
 * the knowledge root, lowercase-hyphenated, and end in `.md`. Anything else is
 * rejected before it can reach a filesystem or a sandbox argv.
 */
export const SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_PATH_LENGTH = 200;
export const MAX_DEPTH = 8;

/**
 * The contract only forbids the status-journal shape (a status/ directory and
 * plan.md). Ordinary subject words such as "plans" remain legitimate.
 */
export const FORBIDDEN_DIRECTORIES = new Set(["status"]);
export const FORBIDDEN_FILES = new Set(["plan.md"]);

export class PathError extends Error {
  readonly code = "invalid_path";
}

/** Normalize a user-supplied wiki path (e.g. "/knowledge/a/b.md", "a/b.md", "a/b/") into canonical form. */
export function normalizeWikiPath(input: string, opts: { allowDirectory?: boolean } = {}): string {
  if (typeof input !== "string") throw new PathError("Path must be a string");
  if (input.length > MAX_PATH_LENGTH) throw new PathError(`Path exceeds ${MAX_PATH_LENGTH} characters`);
  if (input.includes("\0") || input.includes("\\")) throw new PathError("Path contains forbidden characters");
  let p = input.trim().replace(/^\/+/, "");
  if (p === "knowledge") p = "";
  if (p.startsWith("knowledge/")) p = p.slice("knowledge/".length);
  p = p.replace(/\/+$/, "");
  if (p === "" || p === ".") {
    if (opts.allowDirectory) return "";
    throw new PathError("Path must name a Markdown page");
  }
  const segments = p.split("/");
  if (segments.length > MAX_DEPTH) throw new PathError(`Path is deeper than ${MAX_DEPTH} levels`);
  for (const [i, seg] of segments.entries()) {
    if (seg === "." || seg === ".." || seg === "") throw new PathError("Path traversal segments are not allowed");
    const isLast = i === segments.length - 1;
    const stem = isLast && seg.endsWith(".md") ? seg.slice(0, -3) : seg;
    if (!SEGMENT_RE.test(stem)) {
      throw new PathError(`Segment "${seg}" must be lowercase-hyphenated (a-z, 0-9, -)`);
    }
    if ((isLast && FORBIDDEN_FILES.has(seg)) || (!isLast && FORBIDDEN_DIRECTORIES.has(seg))) {
      throw new PathError(`"${seg}" is not allowed: memory is a subject wiki (index.md + subject/workflow pages), not a status/plan journal`);
    }
  }
  const last = segments[segments.length - 1]!;
  if (!last.endsWith(".md")) {
    if (opts.allowDirectory) return segments.join("/");
    throw new PathError("Pages must end in .md");
  }
  return segments.join("/");
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function joinWiki(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** Resolve a relative Markdown link target against the page that contains it. Returns null if it escapes the root. */
export function resolveLink(fromPage: string, target: string): string | null {
  const base = dirOf(fromPage).split("/").filter(Boolean);
  const parts = target.split("/");
  const stack = target.startsWith("/") ? [] : [...base];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else stack.push(part);
  }
  return stack.join("/");
}
