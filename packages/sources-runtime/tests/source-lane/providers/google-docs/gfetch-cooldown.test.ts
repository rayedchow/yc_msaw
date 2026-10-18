import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialCooldownKey, gFetch } from "../../../../src/polling/_archived-gdocs/gdocs-api.js";
import { GoogleRateLimitError, resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";

/** Coordinator patch: donor gFetch cools down per credential for per-user quota, process-wide for project limits. */
const userLimit = () => new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }), { status: 403, headers: { "retry-after": "30" } });
const projectLimit = () => new Response(JSON.stringify({ error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } }), { status: 429, headers: { "retry-after": "30" } });

beforeEach(() => resetGoogleRateLimitCooldownsForTests());
afterEach(() => vi.unstubAllGlobals());

describe("gFetch cooldown scope", () => {
  it("a per-user quota error backs off only that credential", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => (String((init?.headers as Record<string, string>).Authorization) === "Bearer tok-a" ? userLimit() : new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(gFetch("https://www.googleapis.com/drive/v3/changes", "tok-a")).rejects.toBeInstanceOf(GoogleRateLimitError);
    await expect(gFetch("https://www.googleapis.com/drive/v3/changes", "tok-a")).rejects.toMatchObject({ reason: "cooldown", service: credentialCooldownKey("tok-a") });
    expect((await gFetch("https://www.googleapis.com/drive/v3/changes", "tok-b")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentialCooldownKey("tok-a")).not.toContain("tok-a");
  });

  it("a project-wide limit keeps the donor's process-wide cooldown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => projectLimit()));
    await expect(gFetch("https://www.googleapis.com/drive/v3/changes", "tok-a")).rejects.toBeInstanceOf(GoogleRateLimitError);
    await expect(gFetch("https://www.googleapis.com/drive/v3/changes", "tok-b")).rejects.toMatchObject({ reason: "cooldown", service: "google-workspace" });
  });
});
