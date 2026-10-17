import { formatDurationMilliseconds } from "../../lib/duration-format.js";

export function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function formatActivityDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** 45 s, 3 min 12 s, 14 h 44 min. */
export function formatActivitySpan(ms: number): string {
  if (ms < 60_000) return formatDurationMilliseconds(ms);
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min ${Math.floor((ms % 60_000) / 1000)} s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

/** Cut to `max` characters on a word boundary when one is near, with an ellipsis. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/u, "")}…`;
}

/** `["claims", 0, "residualKey"]` as `claims[0].residualKey`. */
function issuePath(path: unknown): string {
  if (!Array.isArray(path)) return typeof path === "string" ? path : "";
  return path.reduce<string>((text, part) =>
    typeof part === "number" ? `${text}[${part}]` : typeof part === "string" ? (text ? `${text}.${part}` : part) : text, "");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One readable sentence from a structured error (a Zod issue list, `{ message }`, `{ error }`), or null. */
function structuredSummary(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    // A message that is itself JSON (a Zod error's message is its issue list).
    if (/^[[{]/u.test(text)) {
      const parsed = parseJson(text);
      if (parsed !== undefined) return structuredSummary(parsed, depth + 1);
    }
    return text || null;
  }
  if (Array.isArray(value)) {
    const issues = value.map((item) => structuredSummary(item, depth + 1)).filter((item): item is string => item !== null);
    if (issues.length === 0) return null;
    return issues.length === 1 ? issues[0]! : `${issues[0]!} (and ${issues.length - 1} more)`;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.issues)) return structuredSummary(record.issues, depth + 1);
  const message = typeof record.message === "string" ? structuredSummary(record.message, depth + 1) : null;
  if (message !== null) {
    const path = issuePath(record.path);
    return path ? `${path}: ${message}` : message;
  }
  for (const key of ["error", "errors", "detail", "reason"]) {
    if (key in record) {
      const nested = structuredSummary(record[key], depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * A failed call's error as one readable line: a JSON error (a validation
 * issue list, an object with a message) reads as its first issue's path and
 * message ("claims[0].residualKey: Required (and 1 more)"); other text as its
 * first line with words in it, never a lone bracket. Clipped to `max`.
 */
export function errorSummary(text: string, max = 180): string {
  const trimmed = text.trim();
  // The JSON may follow a short lead-in ("Invalid input: [...]").
  const start = trimmed.search(/[[{]/u);
  const parsed = start >= 0 && start <= 80 ? parseJson(trimmed.slice(start)) : undefined;
  if (parsed !== undefined) {
    const lead = trimmed.slice(0, start).trim().replace(/[:\s]+$/u, "");
    // Without a message to show, the JSON itself on one line.
    const summary = structuredSummary(parsed) ?? JSON.stringify(parsed);
    return clip(lead ? `${lead}: ${summary}` : summary, max);
  }
  const line = trimmed.split("\n")
    .map((part) => part.replace(/^[#>*\-\s]+/u, "").trim())
    .find((part) => /[\p{L}\p{N}]/u.test(part)) ?? "";
  return clip(line, max);
}
