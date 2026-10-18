import { afterEach, describe, expect, it } from "vitest";
import { googleRateLimitErrorFromResponse, parseRetryAfterSeconds, resetGoogleRateLimitCooldownsForTests, throwIfGoogleRateLimited } from "../../../src/vault/google-rate-limit.js";
import { MAX_RETRY_AFTER_SECONDS, parseHttpDate, parseRetryAfterSeconds as parseHeader } from "../../../src/lib/retry-after.js";

const DAY = 86_400;
const h = (retryAfter: string, date?: string) => new Headers({ "retry-after": retryAfter, ...(date ? { date } : {}) });

/** A valid Retry-After (RFC 9110 §10.2.3) is a floor: honoured in full, never shortened by a cap. */
describe("Google Retry-After", () => {
  afterEach(() => resetGoogleRateLimitCooldownsForTests());

  it("keeps any valid delay-seconds or HTTP-date wait, however long, up to the largest representable value", () => {
    expect(parseRetryAfterSeconds(h("3600"))).toBe(3600);
    expect(parseRetryAfterSeconds(h(String(30 * 3600)))).toBe(30 * 3600);
    expect(parseRetryAfterSeconds(h(String(14 * DAY)))).toBe(14 * DAY); // beyond the earlier 15 min / 24 h / 7 d bounds
    expect(parseRetryAfterSeconds(h("999999999"))).toBe(999_999_999);
    expect(parseRetryAfterSeconds(h(String(MAX_RETRY_AFTER_SECONDS)))).toBe(MAX_RETRY_AFTER_SECONDS);
    const in14days = new Date(Date.now() + 14 * DAY * 1000).toUTCString();
    expect(parseRetryAfterSeconds(h(in14days))).toBeGreaterThanOrEqual(14 * DAY - 2);
    expect(parseRetryAfterSeconds(h("0"))).toBe(1);
  });

  it("bounds only an unrepresentable delay (RFC 9111 §1.2.2: 2^31 - 1 s), never with a giant or non-finite value", () => {
    expect(parseRetryAfterSeconds(h(String(MAX_RETRY_AFTER_SECONDS + 1)))).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(parseRetryAfterSeconds(h("9".repeat(400)))).toBe(MAX_RETRY_AFTER_SECONDS); // Number() is Infinity
    expect(parseRetryAfterSeconds(h("Fri, 31 Dec 9999 23:59:59 GMT"))).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("accepts the three HTTP-date forms as UTC and repeated identical fields", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(parseHeader("Sun, 18 Oct 2026 13:00:00 GMT", { nowMs: now })).toBe(3600);
    expect(parseHeader("Sunday, 18-Oct-26 13:00:00 GMT", { nowMs: now })).toBe(3600);
    expect(parseHeader("Sun Oct 18 13:00:00 2026", { nowMs: now })).toBe(3600); // asctime: UTC, not local time
    expect(parseHeader("120, 120")).toBe(120);
    expect(parseHeader("60, 120")).toBe(120);
    expect(parseHeader("Sun, 18 Oct 2026 11:00:00 GMT", { nowMs: now })).toBe(1); // already past: retry allowed
  });

  it("measures an HTTP-date against the server's Date as well, so local clock skew never retries early", () => {
    const at = "Sun, 18 Oct 2026 13:00:00 GMT";
    // Local clock 10 min fast: local delta 50 min, server delta 60 min -> 60 min.
    expect(parseHeader(at, { nowMs: Date.parse("2026-10-18T12:10:00Z"), responseDate: "Sun, 18 Oct 2026 12:00:00 GMT" })).toBe(3600);
    // Local clock 10 min slow: local delta 70 min is the later deadline -> 70 min.
    expect(parseHeader(at, { nowMs: Date.parse("2026-10-18T11:50:00Z"), responseDate: "Sun, 18 Oct 2026 12:00:00 GMT" })).toBe(4200);
    // A malformed Date header is ignored rather than trusted.
    expect(parseHeader(at, { nowMs: Date.parse("2026-10-18T12:00:00Z"), responseDate: "yesterday" })).toBe(3600);
    // Through the Google helper: the response's own Date header is used.
    const serverNow = new Date(Date.now() - 10 * 60_000);
    const deadline = new Date(serverNow.getTime() + 3600_000).toUTCString();
    expect(parseRetryAfterSeconds(h(deadline, serverNow.toUTCString()))).toBeGreaterThanOrEqual(3600 - 2);
  });

  it("takes the fallback for malformed values instead of a lenient parse (no 1 s retry from Date.parse('-5'))", () => {
    for (const bad of ["soon", "-5", "1e3", "0x10", "1.5", " 12abc", "12 s", "Sun, 18 Oct 2026 13:00:00 PST", "2026-10-18T13:00:00Z", "120,"]) {
      expect(parseRetryAfterSeconds(h(bad), 60), bad).toBe(60);
    }
    expect(parseRetryAfterSeconds(new Headers(), 60)).toBe(60);
    expect(parseHttpDate("-5")).toBeNull();
  });

  it("holds the in-process cooldown for the provider's full wait, beyond a day", () => {
    const res = new Response("{}", { status: 429, headers: { "retry-after": String(14 * DAY) } });
    const err = googleRateLimitErrorFromResponse("drive:test", res, {});
    expect(err?.retryAfterSeconds).toBe(14 * DAY);
    expect(() => throwIfGoogleRateLimited("drive:test")).toThrow(new RegExp(`retry after (${14 * DAY - 1}|${14 * DAY})s`));
  });
});
