import { afterEach, describe, expect, it } from "vitest";
import { googleRateLimitErrorFromResponse, parseRetryAfterSeconds, resetGoogleRateLimitCooldownsForTests, throwIfGoogleRateLimited } from "../../../src/vault/google-rate-limit.js";

/** A valid Retry-After longer than the donor's 15-minute clamp is honoured, never shortened. */
describe("Google Retry-After", () => {
  afterEach(() => resetGoogleRateLimitCooldownsForTests());

  it("keeps a valid wait above 15 minutes or a day (delta-seconds and HTTP-date) and bounds only absurd values (7 days)", () => {
    expect(parseRetryAfterSeconds(new Headers({ "retry-after": "3600" }))).toBe(3600);
    const at = new Date(Date.now() + 2 * 3600_000).toUTCString();
    expect(parseRetryAfterSeconds(new Headers({ "retry-after": at }))).toBeGreaterThanOrEqual(2 * 3600 - 2);
    expect(parseRetryAfterSeconds(new Headers({ "retry-after": String(30 * 3600) }))).toBe(30 * 3600);
    const in3days = new Date(Date.now() + 3 * 86_400_000).toUTCString();
    expect(parseRetryAfterSeconds(new Headers({ "retry-after": in3days }))).toBeGreaterThanOrEqual(3 * 86_400 - 2);
    expect(parseRetryAfterSeconds(new Headers({ "retry-after": "999999999" }))).toBe(7 * 86_400);
    expect(parseRetryAfterSeconds(new Headers({ "retry-after": "soon" }), 60)).toBe(60);
    expect(parseRetryAfterSeconds(new Headers({ "retry-after": "0" }))).toBe(1);
  });

  it("holds the in-process cooldown for the provider's full wait", () => {
    const res = new Response("{}", { status: 429, headers: { "retry-after": "5400" } });
    const err = googleRateLimitErrorFromResponse("drive:test", res, {});
    expect(err?.retryAfterSeconds).toBe(5400);
    expect(() => throwIfGoogleRateLimited("drive:test")).toThrow(/retry after (539\d|5400)s/);
  });
});
