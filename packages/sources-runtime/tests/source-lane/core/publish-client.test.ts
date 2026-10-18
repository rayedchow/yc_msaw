import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertPublishUrl, CHUNK_BYTES, INLINE_BYTES, SourcePublishClient, splitChunks } from "../../../src/source-lane/export/publish-client.js";

describe("publish client", () => {
  it("only targets https or loopback http without embedded credentials", () => {
    expect(assertPublishUrl("https://procmem.example.com").href).toBe("https://procmem.example.com/");
    expect(assertPublishUrl("http://127.0.0.1:3000").port).toBe("3000");
    expect(assertPublishUrl("http://localhost:3000").hostname).toBe("localhost");
    for (const bad of ["http://procmem.example.com", "https://u:p@procmem.example.com", "https://procmem.example.com/?x=1", "ftp://x"]) {
      expect(() => new SourcePublishClient(bad, "psb_x"), bad).toThrow();
    }
  });

  it("refuses redirects and never sends the token anywhere but the configured origin", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ batchId: "b", commitId: "c", seq: 1, results: [] }), { status: 200 });
    }) as typeof fetch;
    const client = new SourcePublishClient("https://procmem.example.com", "psb_tenant.sb-0000000000000000.secret", fetchImpl);
    await client.publish("b", []);
    expect(calls[0]!.url).toBe("https://procmem.example.com/v1/sources/publish");
    expect(calls[0]!.init!.redirect).toBe("error");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer psb_tenant.sb-0000000000000000.secret");
  });

  it("inlines small content and uploads large content as exact chunks", async () => {
    const uploads: string[] = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      if (String(url).includes("/v1/sources/blobs/")) uploads.push(Buffer.from(String(init!.body), "base64").toString("hex").slice(0, 8));
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    const client = new SourcePublishClient("http://127.0.0.1:1", "psb_x", fetchImpl);
    const small = await client.preparePut({ op: "put", path: "sources/x/a", kind: "raw", contentType: "application/json", capturedAt: "2026-10-17T00:00:00Z", sourceUpdatedAt: null }, Buffer.alloc(INLINE_BYTES, 1));
    expect(small.inline).toBeTruthy();
    const bigBuf = Buffer.alloc(CHUNK_BYTES + 10, 2);
    const big = await client.preparePut({ op: "put", path: "sources/x/b", kind: "binary", contentType: "application/octet-stream", capturedAt: "2026-10-17T00:00:00Z", sourceUpdatedAt: null }, bigBuf);
    expect(big.inline).toBeUndefined();
    expect(big.chunks).toHaveLength(2);
    expect(uploads).toHaveLength(2);
    expect(splitChunks(bigBuf).map((c) => c.length)).toEqual([CHUNK_BYTES, 10]);
  });
  it("streams pre-chunked stored content chunk by chunk and verifies every digest", async () => {
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const parts = [Buffer.alloc(CHUNK_BYTES, 3), Buffer.alloc(1024 * 1024, 4)];
    const whole = Buffer.concat(parts);
    const store = new Map(parts.map((b) => [sha(b), b] as const));
    const uploaded: string[] = [];
    const loads: string[] = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      const m = /\/v1\/sources\/blobs\/([0-9a-f]{64})$/.exec(String(url));
      if (m) {
        expect(sha(Buffer.from(String(init!.body), "base64"))).toBe(m[1]);
        uploaded.push(m[1]!);
      }
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    const client = new SourcePublishClient("http://127.0.0.1:1", "psb_x", fetchImpl);
    const head = { op: "put" as const, path: "sources/google-docs/f/a.bin", kind: "binary" as const, contentType: "application/octet-stream", capturedAt: "2026-10-17T00:00:00Z", sourceUpdatedAt: null };
    const chunked = {
      sha256: sha(whole),
      size: whole.length,
      chunks: parts.map((b) => ({ sha256: sha(b), size: b.length })),
      load: async (s: string) => { loads.push(s); return store.get(s)!; },
    };
    const wire = await client.preparePutChunked(head, chunked);
    expect(wire).toMatchObject({ sha256: sha(whole), size: whole.length, chunks: parts.map(sha) });
    expect(wire.inline).toBeUndefined();
    expect(uploaded).toEqual(parts.map(sha));
    expect(loads).toEqual(parts.map(sha));
    // A stored chunk that no longer matches its digest, or a wrong whole-file sha, is refused (never published).
    await expect(client.preparePutChunked(head, { ...chunked, load: async () => Buffer.alloc(CHUNK_BYTES, 9) })).rejects.toThrow(/digest/);
    await expect(client.preparePutChunked(head, { ...chunked, sha256: "0".repeat(64) })).rejects.toThrow(/sha256/);
    await expect(client.preparePutChunked(head, { ...chunked, size: whole.length + 1 })).rejects.toThrow(/sum/);
  });
});
