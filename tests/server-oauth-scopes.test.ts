/**
 * The REAL procmem server (createApp) in OAuth mode against a local mock OIDC
 * issuer. WorkOS-style tokens carry only OIDC scopes; memory:read is granted by
 * the host to every verified user, so it must not be advertised in tool
 * security schemes (clients could not obtain it), while the server still
 * enforces it per call: a static key without memory:read is denied.
 */
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/index.js";
import { startMockIssuer, type MockIssuer } from "../src/auth/testing/mock-issuer.js";
import { LocalLease } from "../src/sandbox/local.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

let issuer: MockIssuer;
let app: App;
let mcpUrl: string;
const buildOnly = generateStaticKey("t-build-only", ["memory:build", "traces:write"]);

beforeAll(async () => {
  issuer = await startMockIssuer({ path: "/oauth2/default" });
  const dir = path.join(os.tmpdir(), `procmem-oauth-scopes-${process.pid}`);
  app = await createApp({
    env: {
      PORT: "0",
      HOST: "127.0.0.1",
      AUTH_MODE: "oidc",
      OIDC_ISSUER: issuer.issuer,
      PROCMEM_STATIC_KEYS: buildOnly.entry,
      PROCMEM_STATIC_KEYS_ON_MCP: "1",
      PROCMEM_STORE: "directory",
      PROCMEM_SANDBOX: "local",
      PROCMEM_DATA_DIR: dir,
    },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => ({ status: "failed", error: "not used" }),
    leaseFactory: () => LocalLease.create(),
    log: () => undefined,
  });
  mcpUrl = (await app.listen(0)).mcpUrl;
});

afterAll(async () => {
  await app?.close();
  await issuer?.close();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "scopes", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

describe("OAuth scope advertisement vs enforcement on the real server", () => {
  it("does not advertise host-implicit memory:read, yet an OIDC-scoped token can use memory tools", async () => {
    const token = await issuer.mint({ sub: "user_oidc_only", aud: mcpUrl, scope: "openid profile email" });
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      const advertised = JSON.stringify(tools.map((t) => ({ name: t.name, meta: (t as { _meta?: unknown })._meta, schemes: (t as { securitySchemes?: unknown }).securitySchemes })));
      expect(advertised).not.toContain("memory:read");
      const opened = await client.callTool({ name: "open_memory", arguments: {} });
      expect((opened as { isError?: boolean }).isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it("still denies memory tools to a verified static key without memory:read", async () => {
    const client = await connect(buildOnly.key);
    try {
      const res = await client.callTool({ name: "open_memory", arguments: {} });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(res)).toContain("missing scope memory:read");
      const read = await client.callTool({ name: "read", arguments: { path: "$KNOWLEDGE/index.md" } });
      expect((read as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
