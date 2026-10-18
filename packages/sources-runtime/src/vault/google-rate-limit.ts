import { parseRetryAfterSeconds as parseRetryAfterHeader } from "../lib/retry-after.js";

const DEFAULT_RETRY_AFTER_SECONDS = 60;
// SOURCE-LANE PATCH (rate-limit compliance): the donor clamped Retry-After to 15 minutes, so a valid longer wait
// from Google (e.g. a quota reset hours away) was retried early. Every source lane persists the returned wait durably
// instead of sleeping, so a valid value is honoured in full (RFC 9110 §10.2.3; see lib/retry-after.ts): only a value
// too large to represent is bounded (2^31 - 1 s, RFC 9111 §1.2.2), and a malformed one takes the fallback.

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

const cooldownUntilByKey = new Map<string, number>();

export class GoogleRateLimitError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly retryAfterSeconds: number,
    readonly reason: string | null = null,
  ) {
    super(`${service} rate limited (${status})${reason ? `: ${reason}` : ""}; retry after ${retryAfterSeconds}s`);
    this.name = "GoogleRateLimitError";
  }
}

export function parseRetryAfterSeconds(headers: Headers, fallbackSeconds = DEFAULT_RETRY_AFTER_SECONDS): number {
  return parseRetryAfterHeader(headers.get("retry-after"), { responseDate: headers.get("date") }) ?? fallbackSeconds;
}

export function googleErrorReasonFromPayload(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const error = (data as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;

  const errors = (error as Record<string, unknown>).errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const reason = (entry as Record<string, unknown>).reason;
        if (typeof reason === "string" && reason.trim()) return reason;
      }
    }
  }

  const status = (error as Record<string, unknown>).status;
  return typeof status === "string" && status.trim() ? status : null;
}

export function isGoogleRateLimit(status: number, data: unknown): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;

  const reason = googleErrorReasonFromPayload(data);
  if (reason && RATE_LIMIT_REASONS.has(reason)) return true;

  const message = googleErrorMessageFromPayload(data);
  return /rate limit|quota|too many requests/i.test(message ?? "");
}

export function googleErrorMessageFromPayload(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const error = (data as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return null;
}

export function throwIfGoogleRateLimited(service: string): void {
  const until = cooldownUntilByKey.get(service) ?? 0;
  const remainingMs = until - Date.now();
  if (remainingMs > 0) {
    throw new GoogleRateLimitError(service, 429, Math.ceil(remainingMs / 1000), "cooldown");
  }
  if (until > 0) cooldownUntilByKey.delete(service);
}

export function googleRateLimitErrorFromResponse(
  service: string,
  response: Response,
  data: unknown,
  fallbackSeconds = DEFAULT_RETRY_AFTER_SECONDS,
): GoogleRateLimitError | null {
  if (!isGoogleRateLimit(response.status, data)) return null;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers, fallbackSeconds);
  const reason = googleErrorReasonFromPayload(data);
  cooldownUntilByKey.set(service, Date.now() + retryAfterSeconds * 1000);
  return new GoogleRateLimitError(service, response.status, retryAfterSeconds, reason);
}

export function resetGoogleRateLimitCooldownsForTests(): void {
  cooldownUntilByKey.clear();
}
