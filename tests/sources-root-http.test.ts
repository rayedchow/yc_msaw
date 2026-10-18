import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { startMockIssuer, type MockIssuer } from "../src/auth/testing/mock-issuer.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

let resource: string;
let fixturePort: number;
let issuer: MockIssuer;
let app: App;
let dir: string;
let base: string;
let mcpUrl: string;
let admin: string;
let reader: string;
let other: string;
const bytes = Buffer.from([0, 0xff, 0x80, 0x41, 0, 0xfe]);
const sourcePath = "sources/github/repo/file.bin";
const agentPath = "$SOURCES/github/repo/file.bin";
const clients: Client[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-root-http-"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  fixturePort = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  resource = `http://127.0.0.1:${fixturePort}/mcp`;
  issuer = await startMockIssuer();
  app = await createApp({
    env: { HOST: "127.0.0.1", PORT: "0", AUTH_MODE: "oidc", MCP_PUBLIC_URL: resource, OIDC_ISSUER: issuer.issuer, PROCMEM_ADMIN_SUBJECTS: "user_admin", PROCMEM_STORE: "directory", PROCMEM_SANDBOX: "local", PROCMEM_DATA_DIR: dir },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => { throw new Error("Source reads must not invoke a memory builder"); },
    leaseFactory: async () => { throw new Error("Source reads must not open an agent sandbox"); },
    log: () => undefined,
  });
  ({ url: base, mcpUrl } = await app.listen(fixturePort));
  admin = await issuer.mint({ sub: "user_admin", aud: resource, scope: "openid", claims: { org_id: "org_sources_a" } });
  reader = await issuer.mint({ sub: "user_reader", aud: resource, scope: "openid", claims: { org_id: "org_sources_a" } });
  other = await issuer.mint({ sub: "user_other", aud: resource, scope: "openid", claims: { org_id: "org_sources_b" } });
});
afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  await app?.close();
  await issuer?.close();
  await rm(dir, { recursive: true, force: true });
});
async function post(route: string, token: string, data: unknown) {
  return fetch(base + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
async function connect(token: string) {
  const c = new Client({ name: "source-root-review", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
function unpack(result: unknown): Record<string, any> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
}

describe("OIDC source publication to the real filesystem MCP", () => {
  it("requires the existing admin authority for runtime bindings and rejects wrong audiences", async () => {
    expect((await post("/v1/sources/bindings", reader, { providers: ["github"] })).status).toBe(403);
    const wrong = await issuer.mint({ sub: "user_admin", aud: "https://unrelated.invalid/mcp", scope: "openid" });
    expect((await post("/v1/sources/bindings", wrong, { providers: ["github"] })).status).toBe(401);
    expect((await post("/v1/sources/bindings", admin, { providers: ["github"], tenantNs: "org_sources_b" })).status).toBe(400);
  });

  it("archives exact binary bytes and history, serves them without a sandbox, isolates tenants and revokes publication", async () => {
    const created = await post("/v1/sources/bindings", admin, { providers: ["github"], label: "Synthetic root integration test" });
    expect(created.status).toBe(201);
    const binding = await created.json() as { token: string; binding: { bindingId: string } };
    const capturedAt = new Date().toISOString();
    const put = { op: "put", path: sourcePath, kind: "binary", contentType: "application/octet-stream", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt };
    expect((await post("/v1/sources/publish", admin, { batchId: "wrong-auth", changes: [put] })).status).toBe(401);
    expect((await post("/v1/sources/publish", binding.token, { batchId: "wrong-provider", changes: [{ ...put, path: "sources/slack/private.bin" }] })).status).toBe(403);
    expect((await post("/v1/sources/publish", binding.token, { batchId: "body-tenant", tenantNs: "elsewhere", changes: [put] })).status).toBe(400);
    const published = await post("/v1/sources/publish", binding.token, { batchId: "binary-first", changes: [put] });
    expect(published.status).toBe(200);
    const receipt = await published.json() as { results: Array<{ versionId: string }> };
    const firstVersion = receipt.results[0]!.versionId;
    const client = await connect(reader);
    const read = await client.callTool({ name: "read", arguments: { path: agentPath, byteOffset: 1, byteLimit: 4 } });
    expect((read as { isError?: boolean }).isError).not.toBe(true);
    const data = unpack(read);
    expect(Buffer.from(data.content, "base64")).toEqual(bytes.subarray(1, 5));
    const foreign = await connect(other);
    const denied = await foreign.callTool({ name: "read", arguments: { path: agentPath, byteOffset: 0, byteLimit: 6 } });
    expect((denied as { isError?: boolean }).isError).toBe(true);
    await expect(connect(binding.token)).rejects.toThrow();
    const deletedAt = new Date(Date.now() + 1).toISOString();
    expect((await post("/v1/sources/publish", binding.token, { batchId: "binary-delete", changes: [{ op: "delete", path: sourcePath, reason: "Synthetic fixture deletion", deletedAt, capturedAt: deletedAt }] })).status).toBe(200);
    const historical = await client.callTool({ name: "sources_history", arguments: { path: agentPath, versionId: firstVersion, byteOffset: 0, byteLimit: 6 } });
    expect((historical as { isError?: boolean }).isError).not.toBe(true);
    expect(Buffer.from(unpack(historical).content, "base64")).toEqual(bytes);
    const revoked = await fetch(`${base}/v1/sources/bindings/${binding.binding.bindingId}`, { method: "DELETE", headers: { Authorization: `Bearer ${admin}` } });
    expect(revoked.status).toBe(200);
    expect((await post("/v1/sources/publish", binding.token, { batchId: "after-revoke", changes: [] })).status).toBe(401);
  });
  it("preserves a binary larger than one chunk and reads across the chunk boundary", async () => {
    const created = await post("/v1/sources/bindings", admin, { providers: ["github"] });
    expect(created.status).toBe(201);
    const { token } = await created.json() as { token: string };
    const first = Buffer.alloc(8 * 1024 * 1024, 0xf1);
    const last = Buffer.from([0, 0xff, 0x80, 0x42]);
    const all = Buffer.concat([first, last]);
    for (const chunk of [first, last]) {
      const uploaded = await fetch(`${base}/v1/sources/blobs/${sha256(chunk)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.procmem.source-blob; encoding=base64" },
        body: chunk.toString("base64"),
      });
      expect(uploaded.status).toBe(201);
    }
    const published = await post("/v1/sources/publish", token, {
      batchId: "large-binary",
      changes: [{ op: "put", path: "sources/github/repo/large.bin", kind: "binary", contentType: "application/octet-stream", size: all.length, sha256: sha256(all), chunks: [sha256(first), sha256(last)], capturedAt: new Date().toISOString() }],
    });
    expect(published.status).toBe(200);
    const client = await connect(reader);
    const read = await client.callTool({ name: "read", arguments: { path: "$SOURCES/github/repo/large.bin", byteOffset: first.length - 2, byteLimit: 6 } });
    expect((read as { isError?: boolean }).isError).not.toBe(true);
    expect(Buffer.from(unpack(read).content, "base64")).toEqual(all.subarray(first.length - 2));
  });

});
