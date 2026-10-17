import { IntegrationError } from "./types.js";

/** Integration slug: lowercase, hyphenated, 3..40 chars. Used as directory, ref and git-safe names. */
export const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function assertSlug(slug: string): string {
  if (typeof slug !== "string" || slug.length < 3 || slug.length > 40 || !SLUG_RE.test(slug)) {
    throw new IntegrationError("invalid_slug", `Invalid integration slug ${JSON.stringify(slug)} (lowercase letters, digits, single hyphens; 3-40 chars)`);
  }
  return slug;
}

/** Build id from the host (daily build run id). Branch is always codex/build-<id>. */
export const BUILD_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

export function assertBuildId(id: string): string {
  if (!BUILD_ID_RE.test(id)) throw new IntegrationError("invalid_build_id", `Invalid build id ${JSON.stringify(id)}`);
  return id;
}

export function buildBranch(buildId: string): string {
  return `codex/build-${assertBuildId(buildId)}`;
}

const SEGMENT_RE = /^[A-Za-z0-9_@+][A-Za-z0-9._@+-]*$/;
/** Paths the agent may never address directly; git state is host-owned. */
const FORBIDDEN_TOP = new Set([".git", "node_modules", ".mcp-use"]);
const FORBIDDEN_NAMES = new Set([".git", ".gitmodules"]);

/**
 * Normalize a repo-relative path supplied by a model. Rejects absolute paths,
 * traversal, empty/dot segments, control/shell-special characters, and the
 * host-owned .git / dependency / build-output trees. "" is the repo root
 * (directories only).
 */
export function normalizeRepoPath(raw: string, opts: { allowRoot?: boolean } = {}): string {
  if (typeof raw !== "string") throw new IntegrationError("invalid_path", "Path must be a string");
  const p = raw.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (p === "" || p === ".") {
    if (opts.allowRoot) return "";
    throw new IntegrationError("invalid_path", "A file path inside the repository is required");
  }
  if (p.startsWith("/")) throw new IntegrationError("invalid_path", `Path must be repository-relative: ${JSON.stringify(raw)}`);
  if (p.length > 512) throw new IntegrationError("invalid_path", "Path too long");
  const segments = p.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === ".." || !SEGMENT_RE.test(s) && !/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) {
      throw new IntegrationError("invalid_path", `Invalid path segment ${JSON.stringify(s)} in ${JSON.stringify(raw)}`);
    }
    if (FORBIDDEN_NAMES.has(s)) throw new IntegrationError("forbidden_path", `${s} is host-owned; use the integration_git_* tools`);
  }
  if (FORBIDDEN_TOP.has(segments[0]!)) {
    throw new IntegrationError("forbidden_path", `${segments[0]}/ is host-owned (git state, pre-baked dependencies or build output)`);
  }
  return segments.join("/");
}
