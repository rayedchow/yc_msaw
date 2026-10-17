import { createHash } from "node:crypto";

/**
 * Stable, provider-safe tool names for the live registry.
 *
 *   memory tool  "open_memory"            -> "memory__open_memory"
 *   child tool   "deliver" on "notify-hub" -> "integration__notify-hub__deliver"
 *
 * Rules (deterministic: a name depends only on the source id and the upstream tool name):
 *  - valid names match ^[A-Za-z0-9_-]{1,64}$ (the strictest common limit: OpenAI and Anthropic tool names).
 *  - if the plain form is valid it is used as is;
 *  - otherwise invalid characters become "_", the result is truncated and suffixed with "_h" + 10 hex
 *    chars of sha256(sourceId + "\0" + upstreamName), so two upstream names never map to the same name.
 * Collisions that still occur within one snapshot (a plain name equal to another tool's hashed form) are
 * resolved by `assignStableNames`, which hashes every colliding entry and drops any residual duplicate.
 */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_TOOL_NAME = 64;
export const MEMORY_PREFIX = "memory__";
export const INTEGRATION_PREFIX = "integration__";
/** Slugs as accepted by the parent token route (/v1/integrations/:slug/token). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type SourceId = "memory" | `integration:${string}`;

export function sourcePrefix(source: SourceId): string {
  if (source === "memory") return MEMORY_PREFIX;
  const slug = source.slice("integration:".length);
  return `${INTEGRATION_PREFIX}${slug}__`;
}

function hashSuffix(source: SourceId, upstream: string): string {
  return `_h${createHash("sha256").update(`${source}\0${upstream}`).digest("hex").slice(0, 10)}`;
}

export function hashedToolName(source: SourceId, upstream: string): string {
  const prefix = sourcePrefix(source);
  const suffix = hashSuffix(source, upstream);
  const cleaned = upstream.replace(/[^A-Za-z0-9_-]/g, "_");
  const room = Math.max(0, MAX_TOOL_NAME - suffix.length - prefix.length);
  const head = `${prefix}${cleaned.slice(0, room)}`.slice(0, MAX_TOOL_NAME - suffix.length);
  return `${head}${suffix}`;
}

export function stableToolName(source: SourceId, upstream: string): string {
  const plain = `${sourcePrefix(source)}${upstream}`;
  return TOOL_NAME_RE.test(plain) ? plain : hashedToolName(source, upstream);
}

export interface NamedEntry {
  source: SourceId;
  upstream: string;
}

/**
 * Assign collision-free names for one snapshot. Returns the name for each entry (same order), or null for an
 * entry that could not be named uniquely (reported, never silently merged with another tool).
 */
export function assignStableNames(entries: readonly NamedEntry[]): (string | null)[] {
  const first = entries.map((e) => stableToolName(e.source, e.upstream));
  const counts = new Map<string, number>();
  for (const n of first) counts.set(n, (counts.get(n) ?? 0) + 1);
  const second = entries.map((e, i) => (counts.get(first[i]!)! > 1 ? hashedToolName(e.source, e.upstream) : first[i]!));
  const seen = new Map<string, number>();
  for (const n of second) seen.set(n, (seen.get(n) ?? 0) + 1);
  return second.map((n) => (seen.get(n)! > 1 ? null : n));
}
