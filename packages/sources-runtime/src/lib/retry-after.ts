/**
 * Retry-After (RFC 9110 §10.2.3): `Retry-After = HTTP-date / delay-seconds`, `delay-seconds = 1*DIGIT`.
 *
 * A valid value is a floor the provider sets; it is returned unshortened. Only a value too large to represent is
 * bounded, at MAX_RETRY_AFTER_SECONDS (RFC 9111 §1.2.2 takes an unrepresentable delta-seconds as 2^31, "infinity,
 * over 68 years"; 2^31 - 1 also fits the int4 `last_retry_after_seconds` columns). Anything else is malformed and
 * returns null, so the caller applies its own conservative fallback instead of a lenient parse (`Number("1e3")`,
 * `Date.parse("-5")` -> a date in 2001 -> retry at once). Callers persist the wait durably; nothing sleeps for it.
 */
export const MAX_RETRY_AFTER_SECONDS = 2_147_483_647;

const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const LONG_DAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const TIME = "\\d{2}:\\d{2}:\\d{2}";
const IMF_FIXDATE = new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`);
const RFC850_DATE = new RegExp(`^${LONG_DAY}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} (?: \\d|\\d{2}) ${TIME} \\d{4}$`);

/** RFC 9110 §5.6.7 HTTP-date (IMF-fixdate, or the obsolete rfc850/asctime forms), in ms since the epoch; else null. */
export function parseHttpDate(raw: string | null | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  let ms = Number.NaN;
  if (IMF_FIXDATE.test(value) || RFC850_DATE.test(value)) ms = Date.parse(value);
  // asctime carries no zone; it is UTC, not the local time Date.parse would assume.
  else if (ASCTIME_DATE.test(value)) ms = Date.parse(`${value} GMT`);
  return Number.isFinite(ms) ? ms : null;
}

function boundedSeconds(seconds: number): number {
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
}

/**
 * Seconds to wait (>= 1), or null when the header is absent or malformed.
 *
 * delay-seconds is taken as is. Repeated identical fields ("120, 120") use the largest. An HTTP-date is measured
 * against the local clock and also against the response's own `Date` (RFC 9110 §6.6.1), and the later of the two is
 * used: a local clock running ahead of the server's can never pull the retry before the server's deadline.
 */
export function parseRetryAfterSeconds(
  raw: string | null | undefined,
  options: { nowMs?: number; responseDate?: string | null } = {},
): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const parts = value.split(",").map((p) => p.trim());
  if (parts.every((p) => /^\d+$/.test(p))) {
    // Number() of a long digit string is finite (up to ~1.8e308) or Infinity; both bound to the maximum.
    return boundedSeconds(Math.max(...parts.map((p) => Number(p))));
  }
  const at = parseHttpDate(value);
  if (at === null) return null;
  let waitMs = at - (options.nowMs ?? Date.now());
  const serverNow = parseHttpDate(options.responseDate);
  if (serverNow !== null) waitMs = Math.max(waitMs, at - serverNow);
  return boundedSeconds(waitMs / 1000);
}
