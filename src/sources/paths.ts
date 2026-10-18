/**
 * Path grammar for the server-side sources/ filesystem.
 *
 * Provider paths are data, never object-store keys or host filesystem paths, so
 * they may carry the provider's own names (spaces, case, unicode). They are still
 * strictly normalized so a path has exactly one spelling:
 *
 *   wire form     sources/<provider>/<rel...>      (publish protocol, donor mirror paths)
 *   agent form    $SOURCES/<provider>/<rel...>     (MCP tools)
 *   stored form   <provider>/<rel...>              ("" is the root)
 */

export const SOURCES_VAR = "$SOURCES";
export const SOURCES_WIRE_ROOT = "sources";
export const MAX_SOURCE_PATH_BYTES = 4_096;
export const MAX_SOURCE_SEGMENTS = 64;
export const MAX_SOURCE_SEGMENT_BYTES = 255;
export const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type SourceErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_a_file"
  | "not_a_directory"
  | "invalid_input"
  | "path_conflict"
  | "forbidden_provider"
  | "missing_blobs"
  | "integrity"
  | "conflict"
  | "batch_conflict"
  | "too_large"
  | "owner_conflict";

export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

function invalid(message: string): never {
  throw new SourceError("invalid_path", message);
}

/** Validate and normalize relative segments (no traversal, no empty/dot segments, no control chars). */
export function normalizeSegments(rest: string, label: string): string[] {
  if (Buffer.byteLength(rest, "utf8") > MAX_SOURCE_PATH_BYTES) invalid(`${label} exceeds ${MAX_SOURCE_PATH_BYTES} bytes`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rest)) invalid(`${label} contains NUL or control characters`);
  if (rest.includes("\\")) invalid(`${label} must use forward slashes`);
  const segments: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "") continue;
    if (seg === "." || seg === "..") invalid(`${label}: '.' and '..' segments are not allowed`);
    if (Buffer.byteLength(seg, "utf8") > MAX_SOURCE_SEGMENT_BYTES) invalid(`${label}: segment is longer than ${MAX_SOURCE_SEGMENT_BYTES} bytes`);
    segments.push(seg);
  }
  if (segments.length > MAX_SOURCE_SEGMENTS) invalid(`${label} is deeper than ${MAX_SOURCE_SEGMENTS} levels`);
  return segments;
}

/**
 * Publish-protocol path (`sources/<provider>/<rel>`, a donor mirror path) to its stored
 * form. Must name a file below a provider directory. Duplicate or trailing slashes
 * are rejected rather than collapsed so two spellings never reach one entry.
 */
export function wireToStored(input: unknown): { stored: string; provider: string } {
  if (typeof input !== "string") invalid("path must be a string");
  if (!input.startsWith(`${SOURCES_WIRE_ROOT}/`)) invalid(`path ${JSON.stringify(input)} must start with ${SOURCES_WIRE_ROOT}/`);
  const rest = input.slice(SOURCES_WIRE_ROOT.length + 1);
  const segments = normalizeSegments(rest, "path");
  if (segments.join("/") !== rest) invalid(`path ${JSON.stringify(input)} is not in canonical form (no empty, '.' or trailing segments)`);
  const provider = segments[0];
  if (!provider || !PROVIDER_RE.test(provider)) invalid(`path ${JSON.stringify(input)} must start with sources/<provider>/ where provider matches ${PROVIDER_RE}`);
  if (segments.length < 2) invalid(`path ${JSON.stringify(input)} must name a file below sources/${provider}/`);
  return { stored: segments.join("/"), provider };
}

export function storedToWire(stored: string): string {
  return stored ? `${SOURCES_WIRE_ROOT}/${stored}` : SOURCES_WIRE_ROOT;
}

/** True when an MCP path argument addresses the sources root ($SOURCES or ${SOURCES}). */
export function isSourcesPath(input: unknown): boolean {
  if (typeof input !== "string") return false;
  const raw = input.trim();
  return raw === SOURCES_VAR || raw.startsWith(`${SOURCES_VAR}/`) || raw === "${SOURCES}" || raw.startsWith("${SOURCES}/");
}

/** Agent-form path ($SOURCES/...) to stored form. Trailing/duplicate slashes are tolerated (like a shell). */
export function agentToStored(input: unknown): string {
  if (typeof input !== "string") invalid("path must be a string");
  const raw = input.trim();
  let rest: string;
  if (raw === SOURCES_VAR || raw === "${SOURCES}") rest = "";
  else if (raw.startsWith(`${SOURCES_VAR}/`)) rest = raw.slice(SOURCES_VAR.length + 1);
  else if (raw.startsWith("${SOURCES}/")) rest = raw.slice("${SOURCES}/".length);
  else invalid(`path ${JSON.stringify(input)} is not below ${SOURCES_VAR}`);
  return normalizeSegments(rest, "path").join("/");
}

export function displaySourcePath(stored: string): string {
  return stored ? `${SOURCES_VAR}/${stored}` : SOURCES_VAR;
}

export function parentOf(stored: string): string {
  const i = stored.lastIndexOf("/");
  return i < 0 ? "" : stored.slice(0, i);
}

export function baseName(stored: string): string {
  return stored.slice(stored.lastIndexOf("/") + 1);
}

export function providerOf(stored: string): string | null {
  const first = stored.split("/")[0];
  return first ? first : null;
}
