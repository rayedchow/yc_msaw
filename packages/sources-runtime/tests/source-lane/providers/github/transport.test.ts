import { describe, expect, it } from "vitest";
import {
  decodeBlobContent,
  gitBlobSha,
  GithubApiError,
  GithubAuthError,
  GithubClient,
  GithubRateLimitedError,
  isTextContent,
  rateLimitedOf,
  rateLimitOf,
  refPath,
  repoEndpoint,
} from "../../../../src/source-lane/providers/github/api.js";
import { contentFilePath, contentTypeFor, encodeGitSegment, headFilePath, isOverflowPath, snapshotFilePath } from "../../../../src/source-lane/providers/github/paths.js";
import { NANGO_BASE, NANGO_KEY } from "./fake-github.js";

const CONN = { providerConfigKey: "github", connectionId: "conn-1" };

function clientWith(respond: (url: URL, init: RequestInit) => Response): { client: GithubClient; calls: Array<{ url: URL; init: RequestInit }> } {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const client = new GithubClient({
    apiKey: NANGO_KEY,
    baseUrl: NANGO_BASE,
    now: () => Date.parse("2026-10-17T00:00:00Z"),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init: init! });
      return respond(url, init!);
    },
  });
  return { client, calls };
}

describe("github transport: Nango proxy client", () => {
  it("calls only the Nango proxy with the secret + connection headers, never follows redirects", async () => {
    const { client, calls } = clientWith(() => Response.json({ ok: true }));
    await client.get(CONN, "/repos/acme/widgets/git/trees/abc", { recursive: 1 });
    const { url, init } = calls[0]!;
    expect(url.href).toBe(`${NANGO_BASE}/proxy/repos/acme/widgets/git/trees/abc?recursive=1`);
    expect(init.redirect).toBe("manual");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${NANGO_KEY}`);
    expect(h.get("connection-id")).toBe("conn-1");
    expect(h.get("provider-config-key")).toBe("github");
    expect(h.get("nango-proxy-x-github-api-version")).toBe("2022-11-28");
  });

  it("refuses paths outside the repository / installation API", async () => {
    const { client, calls } = clientWith(() => Response.json({}));
    for (const bad of ["/user", "/repos/acme/widgets/../../orgs", "https://evil.test/x", "/repos/acme", "/graphql", "/repos/acme/widgets/contents?x=1"]) {
      await expect(client.get(CONN, bad)).rejects.toMatchObject({ code: "bad_path" });
    }
    expect(calls).toHaveLength(0);
    expect(() => repoEndpoint("acme/../x")).toThrow(GithubApiError);
    expect(() => repoEndpoint("acme/wid gets")).toThrow(GithubApiError);
    expect(refPath("feature/a b")).toBe("feature/a%20b");
  });

  it("treats a redirect as an error unless tolerated (bearer never leaves the proxy)", async () => {
    const { client } = clientWith(() => new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/1" } }));
    await expect(client.get(CONN, "/repos/acme/old")).rejects.toMatchObject({ code: "unexpected_redirect" });
    await expect(client.get(CONN, "/repos/acme/old", undefined, [301])).resolves.toMatchObject({ status: 301, data: null });
  });

  it("classifies GitHub's documented rate-limit signals and never sleeps", async () => {
    const now = Date.parse("2026-10-17T00:00:00Z");
    const h = (o: Record<string, string>) => new Headers(o);
    const sec = rateLimitedOf(429, h({ "retry-after": "30" }), "", rateLimitOf(h({})), now);
    expect(sec).toMatchObject({ kind: "secondary", retryAfterMs: 30_000 });
    const sec403 = rateLimitedOf(403, h({ "retry-after": "Sat, 17 Oct 2026 00:02:00 GMT" }), "", rateLimitOf(h({})), now);
    expect(sec403).toMatchObject({ kind: "secondary", retryAfterMs: 120_000 });
    const msgOnly = rateLimitedOf(403, h({}), '{"message":"You have exceeded a secondary rate limit"}', rateLimitOf(h({ "x-ratelimit-remaining": "41" })), now);
    expect(msgOnly).toMatchObject({ kind: "secondary", retryAfterMs: null });
    const reset = now / 1000 + 600;
    const primary = rateLimitedOf(403, h({}), "", rateLimitOf(h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })), now);
    expect(primary).toMatchObject({ kind: "primary", retryAfterMs: 600_000 });
    // A plain 403 is a permission failure, not a rate limit.
    expect(rateLimitedOf(403, h({ "x-ratelimit-remaining": "4000" }), '{"message":"Resource not accessible by integration"}', rateLimitOf(h({ "x-ratelimit-remaining": "4000" })), now)).toBeNull();

    const { client } = clientWith(() => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }));
    const started = Date.now();
    const err = await client.get(CONN, "/repos/acme/w/git/blobs/x", undefined, [403]).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRateLimitedError);
    expect(err.retryAt.toISOString()).toBe(new Date(reset * 1000).toISOString());
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reports the budget headers of every response", async () => {
    const seen: unknown[] = [];
    const client = new GithubClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, onRateLimit: (r) => seen.push(r), fetchImpl: async () => Response.json({}, { headers: { "x-ratelimit-limit": "15000", "x-ratelimit-remaining": "14990", "x-ratelimit-reset": "1800000000", "x-ratelimit-resource": "core" } }) });
    await client.get(CONN, "/installation/repositories");
    expect(seen).toEqual([{ limit: 15000, remaining: 14990, resetAt: new Date(1800000000 * 1000), resource: "core" }]);
  });

  it("raises auth errors for 401 and Nango connection errors even on tolerated statuses", async () => {
    let body = { error: { code: "unknown_connection" } };
    const { client } = clientWith(() => Response.json(body, { status: 404 }));
    await expect(client.get(CONN, "/repositories/1", undefined, [404])).rejects.toBeInstanceOf(GithubAuthError);
    body = { message: "Not Found" } as never;
    await expect(client.get(CONN, "/repositories/1", undefined, [404])).resolves.toMatchObject({ status: 404 });
    const { client: c401 } = clientWith(() => new Response("", { status: 401 }));
    await expect(c401.get(CONN, "/repositories/1", undefined, [401])).rejects.toBeInstanceOf(GithubAuthError);
  });
});

describe("github transport: exact blob bytes", () => {
  it("decodes wrapped base64 strictly and verifies against git's object id", () => {
    const bytes = Buffer.from("hello\n");
    expect(gitBlobSha(bytes)).toBe("ce013625030ba8dba906f756967f9e9ca394464a"); // `git hash-object` of "hello\n"
    expect(gitBlobSha(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    const binary = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
    const wrapped = binary.toString("base64").replace(/(.{60})/gu, "$1\n");
    expect(decodeBlobContent({ content: `${wrapped}\n`, encoding: "base64", size: 300 }).equals(binary)).toBe(true);
    expect(decodeBlobContent({ content: "", encoding: "base64", size: 0 }).length).toBe(0);
    expect(() => decodeBlobContent({ content: "aGVsbG8*", encoding: "base64", size: 5 })).toThrow(/canonical base64/u);
    expect(() => decodeBlobContent({ content: "aGVsbG8", encoding: "base64", size: 5 })).toThrow(/canonical base64/u);
    expect(() => decodeBlobContent({ content: "aGVsbG8=", encoding: "base64", size: 6 })).toThrow(/declared 6/u);
    expect(() => decodeBlobContent({ content: "x", encoding: "latin1" })).toThrow(/unsupported/u);
    expect(decodeBlobContent({ content: "héllo", encoding: "utf-8", size: 6 }).toString("utf8")).toBe("héllo");
  });

  it("classifies text vs binary like git (NUL or invalid UTF-8 = binary)", () => {
    expect(isTextContent(Buffer.from("plain ✓ text\n"))).toBe(true);
    expect(isTextContent(Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
    expect(isTextContent(Buffer.from([0xc3, 0x28]))).toBe(false);
    expect(contentTypeFor("docs/README.md", true)).toBe("text/markdown; charset=utf-8");
    expect(contentTypeFor("src/a.ts", true)).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("img/a.PNG", false)).toBe("image/png");
    expect(contentTypeFor("bin/tool", false)).toBe("application/octet-stream");
  });
});

describe("github paths", () => {
  it("keeps ordinary git paths verbatim and encodes only what sources/ forbids", () => {
    const base = "sources/github/acme/widgets/code/main/files";
    expect(contentFilePath("acme/widgets", "main", "src/a b/ü.ts")).toBe(`${base}/src/a b/ü.ts`);
    expect(contentFilePath("acme/widgets", "main", "100%/back\\slash")).toBe(`${base}/100%25/back%5Cslash`);
    expect(contentFilePath("acme/widgets", "main", "ctl\u0001x")).toBe(`${base}/ctl%01x`);
    expect(encodeGitSegment("..")).toBe("%2E%2E");
    expect(encodeGitSegment(".")).toBe("%2E");
    expect(encodeGitSegment(".github")).toBe(".github");
    const long = "x".repeat(300);
    const enc = encodeGitSegment(long);
    expect(Buffer.byteLength(enc)).toBeLessThanOrEqual(255);
    expect(enc).not.toBe(encodeGitSegment(`${"x".repeat(299)}y`));
    expect(headFilePath("acme/widgets", "feature/x")).toBe("sources/github/acme/widgets/code/feature%2Fx/_head.json");
    expect(snapshotFilePath("acme/widgets", "main", 12)).toBe("sources/github/acme/widgets/code/main/_snapshots/g00000012.json");
  });

  it("maps paths deeper than the sources/ grammar allows to a stable overflow path", () => {
    const deep = Array.from({ length: 70 }, (_, i) => `d${i}`).join("/");
    const p = contentFilePath("acme/widgets", "main", deep);
    expect(isOverflowPath(p)).toBe(true);
    expect(p).toBe(contentFilePath("acme/widgets", "main", deep));
    expect(p).not.toBe(contentFilePath("acme/widgets", "main", `${deep}x`));
  });
});
