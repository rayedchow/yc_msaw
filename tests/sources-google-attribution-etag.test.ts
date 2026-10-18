import { describe, expect, it } from "vitest";
import { googleAttributionFrom, SourceRuntimeClient } from "../src/sources/runtime-client.js";

/**
 * perf-verification-2: every 5 s viewer refresh re-sent ~1.1 MB of Google attribution (12k units) even when nothing
 * changed. yc_msaw revalidates with the runtime's ETag; an unchanged answer is a body-less 304 and the cached units
 * object is reused (so the viewer built from it is too). A changed answer, or a 304 without a known ETag, is not.
 */
describe("Google attribution revalidation", () => {
  it("sends If-None-Match per principal and reuses the previous answer on 304", async () => {
    let version = "v1";
    const seen: Array<{ who: string; ifNoneMatch: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const who = (JSON.parse(headers.get("x-procmem-principal")!) as { subject: string }).subject;
      seen.push({ who, ifNoneMatch: headers.get("if-none-match") });
      expect(url).toBe("http://runtime.test/tenants/acme/google/auth/attribution");
      const etag = `"${who}-${version}"`;
      if (headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
      const body = { schema: "procmem.google-attribution/v1", units: [{ path: `google-docs/${who}-${version}-doc-x`, accounts: [`${who}@acme.test`], revisions: true }], truncated: false };
      return new Response(JSON.stringify(body), { status: 200, headers: { etag, "content-type": "application/json" } });
    }) as typeof fetch;
    const source = googleAttributionFrom(new SourceRuntimeClient({ url: "http://runtime.test", serviceToken: "svc", publishUrl: "http://yc.test" }, fetchImpl));
    const alice = { subject: "alice", issuer: "https://issuer.test" };
    const first = await source("acme", alice);
    expect(first.units.map((u) => u.path)).toEqual(["google-docs/alice-v1-doc-x"]);
    const second = await source("acme", alice);
    expect(second).toBe(first);
    // Another principal never revalidates against alice's answer.
    expect((await source("acme", { subject: "bob", issuer: "https://issuer.test" })).units[0]!.path).toBe("google-docs/bob-v1-doc-x");
    version = "v2";
    const third = await source("acme", alice);
    expect(third.units.map((u) => u.path)).toEqual(["google-docs/alice-v2-doc-x"]);
    expect(seen).toEqual([
      { who: "alice", ifNoneMatch: null },
      { who: "alice", ifNoneMatch: '"alice-v1"' },
      { who: "bob", ifNoneMatch: null },
      { who: "alice", ifNoneMatch: '"alice-v1"' },
    ]);
  });

  it("fails closed on a 304 it cannot match", async () => {
    const fetchImpl = (async () => new Response(null, { status: 304, headers: { etag: '"x"' } })) as unknown as typeof fetch;
    const source = googleAttributionFrom(new SourceRuntimeClient({ url: "http://runtime.test", serviceToken: "svc", publishUrl: "http://yc.test" }, fetchImpl));
    await expect(source("acme", { subject: "alice", issuer: "https://issuer.test" })).rejects.toThrow(/unavailable/);
  });
});
