/**
 * Length-preserving redaction for raw OT changelog pages.
 *
 * The OT replay addresses text by UTF-16 offset: every `is`/`ds`/`as` after an
 * insertion is positioned relative to the text that insertion added. The shared
 * provider redaction (`redactProviderPayload`) swaps a credential string for a
 * fixed-length placeholder, so a pasted signed URL (one `is` op whose `s` is the
 * whole URL) would shift every later index in that tab and corrupt deleted
 * text, session before/after states, revision chunks and suggestion matching.
 *
 * Here the shared policy still decides WHAT is a credential (same predicate,
 * same keys), but each redacted string inside `changelog` / `chunkedSnapshot`
 * is replaced by a placeholder of exactly the original `.length`, keeping its
 * leading/trailing whitespace (newlines are paragraph structure). The
 * credential is never stored, and the stored page is exactly what the parser
 * replays, so derived history is reproducible from the published raw pages and
 * identical to an unredacted replay except inside the redacted span.
 *
 * Pages stored before this scheme carry no `redaction` marker; if such a page
 * contains a fixed-length placeholder its original lengths are lost, so it is
 * never reused (see `hasLegacyFixedLengthRedaction`) and is refetched instead.
 */
import { redactProviderPayload } from "../../../vault/redaction.js";

/** Recorded on every stored changelog page body (`redaction` field). */
export const CHANGELOG_REDACTION_SCHEME = "google-docs/length-preserving-v1";

/** Response keys that carry positional OT data. */
const POSITIONAL_KEYS = ["changelog", "chunkedSnapshot"] as const;

/** The shared policy's fixed placeholders, probed (not copied) so they stay in sync with redaction.ts. */
const FIXED_PLACEHOLDERS: ReadonlySet<string> = (() => {
  const probe = redactProviderPayload("google-docs", {
    contentUri: "https://lh3.example/probe",
    contentUrl: "https://lh3.example/probe",
    s: "https://files.example/probe?token=probe",
  }) as Record<string, unknown>;
  return new Set(Object.values(probe).filter((v): v is string => typeof v === "string" && v.startsWith("[redacted")));
})();

/**
 * A placeholder of exactly `length` UTF-16 units derived from `label`:
 * long spans pad the label with `_` before its closing bracket, short spans
 * truncate it (`[redacted: cr]`). ASCII only, never a URL.
 */
export function fitPlaceholder(label: string, length: number): string {
  if (length <= 0) return "";
  if (length === 1) return "*";
  const open = label.startsWith("[") ? label.slice(1) : label;
  const inner = open.endsWith("]") ? open.slice(0, -1) : open;
  if (inner.length + 2 <= length) return `[${inner}${"_".repeat(length - inner.length - 2)}]`;
  return `[${inner.slice(0, length - 2)}]`;
}

function lengthPreserving(original: string, redacted: string): string {
  const lead = /^\s*/u.exec(original)?.[0] ?? "";
  const rest = original.slice(lead.length);
  const trail = /\s*$/u.exec(rest)?.[0] ?? "";
  const coreLength = rest.length - trail.length;
  return lead + fitPlaceholder(redacted, coreLength) + trail;
}

/** Walk the original and its policy-redacted copy together; every changed string keeps its length. */
function preserveLengths(original: unknown, redacted: unknown): unknown {
  if (typeof original === "string") {
    return typeof redacted === "string" && redacted !== original ? lengthPreserving(original, redacted) : redacted;
  }
  if (Array.isArray(original) && Array.isArray(redacted)) {
    return redacted.map((item, i) => preserveLengths(original[i], item));
  }
  if (original && redacted && typeof original === "object" && typeof redacted === "object"
      && !Array.isArray(original) && !Array.isArray(redacted)) {
    const src = original as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(redacted as Record<string, unknown>)) out[key] = preserveLengths(src[key], value);
    return out;
  }
  return redacted;
}

/**
 * The canonical stored/replayed representation of one parsed `/revisions/load`
 * response: shared google-docs redaction everywhere, length-preserving inside
 * the positional keys. Idempotent, so live pages and stored pages compare equal.
 */
export function redactChangelogResponse(response: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactProviderPayload("google-docs", response) as Record<string, unknown>;
  for (const key of POSITIONAL_KEYS) {
    if (key in response) redacted[key] = preserveLengths(response[key], redacted[key]);
  }
  return redacted;
}

function containsFixedPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return FIXED_PLACEHOLDERS.has(value);
  if (Array.isArray(value)) return value.some(containsFixedPlaceholder);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsFixedPlaceholder);
  return false;
}

/**
 * True when a stored page body predates `CHANGELOG_REDACTION_SCHEME` and its
 * positional data holds a fixed-length placeholder: the original string length
 * is unrecoverable, so replaying it would shift later indices.
 */
export function hasLegacyFixedLengthRedaction(body: { redaction?: unknown; response?: Record<string, unknown> | null }): boolean {
  if (body.redaction === CHANGELOG_REDACTION_SCHEME) return false;
  const response = body.response ?? {};
  return POSITIONAL_KEYS.some((key) => containsFixedPlaceholder(response[key]));
}
