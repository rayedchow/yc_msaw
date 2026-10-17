/**
 * End-to-end: a real mcp-use MCPServer on 127.0.0.1:0 guarded by the procmem
 * OIDC provider, a local mock authorization server, and the real MCP SDK
 * StreamableHTTP client.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCPServer } from "mcp-use";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticateHttp,
  buildMcpOAuth,
  generateStaticKey,
  loadAuthConfig,
  principalFromAuth,
  SCOPES,
  tenantNsFor,
  toolSecuritySchemes,
  type AuthConfig,
  type Principal,
  type ProcmemUser,
} from "../src/auth/index.js";
import { startMockIssuer, type MockIssuer } from "../src/auth/testing/mock-issuer.js";

let issuer: MockIssuer;
let config: AuthConfig;
let server: MCPServer<ProcmemUser>;
let mcpUrl: string;
const ingestKey = generateStaticKey("t-ingest-demo", [SCOPES.tracesWrite, SCOPES.memoryRead]);

beforeAll(async () => {
  issuer = await startMockIssuer({ path: "/oauth2/default" });
  config = await loadAuthConfig(
    {
      AUTH_MODE: "oidc",
      OIDC_ISSUER: issuer.issuer,
      PROCMEM_STATIC_KEYS: ingestKey.entry,
      PROCMEM_STATIC_KEYS_ON_MCP: "1",
    },
    { host: "127.0.0.1" },
  );
  const oauth = buildMcpOAuth(config);
  if (!oauth) throw new Error("expected oauth provider");
  server = new MCPServer<ProcmemUser>({ name: "procmem-auth-test", version: "0.0.0", oauth, basePath: config.basePath });
  server.tool({ name: "whoami", description: "Return the authenticated principal" }, async (_args, ctx) => ({
    content: [{ type: "text", text: JSON.stringify(principalFromAuth(ctx.auth)) }],
  }));
  server.tool(
    {
      name: "admin_build",
      description: "Requires memory:build",
      securitySchemes: toolSecuritySchemes(config, SCOPES.memoryBuild) ?? [{ type: "oauth2", scopes: [SCOPES.memoryBuild] }],
    },
    async () => ({ content: [{ type: "text", text: "build-started" }] }),
  );
  const listening = await server.listen(0, { host: "127.0.0.1" });
  mcpUrl = listening.url;
});

afterAll(async () => {
  await server?.close();
  await issuer?.close();
});

async function connect(token?: string): Promise<Client> {
  const client = new Client({ name: "auth-e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    ...(token !== undefined && { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  });
  await client.connect(transport);
  return client;
}

function rawInitialize(token?: string): Promise<Response> {
  return fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }),
  });
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

describe("MCP endpoint with OIDC provider (mock issuer)", () => {
  it("serves RFC 9728 protected-resource metadata pointing at the issuer", async () => {
    const res = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", mcpUrl));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(mcpUrl);
    expect(body.authorization_servers).toEqual([issuer.issuer]);
  });

  it("rejects unauthenticated initialize with 401 + resource_metadata challenge", async () => {
    const res = await rawInitialize();
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", mcpUrl).href}"`);
  });

  it("real MCP client: unauthenticated connect fails", async () => {
    await expect(connect()).rejects.toThrow();
  });

  it("valid token: initialize, tools/list, tools/call via the real client", async () => {
    const token = await issuer.mint({ sub: "user_alice", aud: mcpUrl, claims: { org_id: "org_acme", email: "a@acme.test" } });
    const client = await connect(token);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["admin_build", "whoami"]);
      const result = await client.callTool({ name: "whoami", arguments: {} });
      const principal = JSON.parse(textOf(result)) as Principal;
      expect(principal.subject).toBe("user_alice");
      expect(principal.provider).toBe("oidc");
      expect(principal.organizationId).toBe("org_acme");
      expect(principal.tenantNs).toBe(tenantNsFor(issuer.issuer, { subject: "user_alice", organizationId: "org_acme" }));
      expect(principal.tenantNs).toMatch(/^[a-z0-9][a-z0-9-]{0,79}$/);
      expect(principal.scopes).toEqual(expect.arrayContaining([SCOPES.memoryRead, SCOPES.integrationsRead]));
      expect(principal.scopes).not.toContain(SCOPES.memoryBuild);
    } finally {
      await client.close();
    }
  });

  it("users of the same org share a tenant; different orgs get different tenants", async () => {
    const who = async (sub: string, org: string) => {
      const client = await connect(await issuer.mint({ sub, aud: mcpUrl, claims: { org_id: org } }));
      try {
        return JSON.parse(textOf(await client.callTool({ name: "whoami", arguments: {} }))) as Principal;
      } finally {
        await client.close();
      }
    };
    const a1 = await who("user_a1", "org_a");
    const a2 = await who("user_a2", "org_a");
    const b1 = await who("user_b1", "org_b");
    expect(a1.tenantNs).toBe(a2.tenantNs);
    expect(a1.tenantNs).not.toBe(b1.tenantNs);
  });

  const rejected: Array<[string, () => Promise<string>]> = [
    ["expired", () => issuer.mint({ aud: mcpUrl, expiresIn: -120 })],
    ["wrong audience", () => issuer.mint({ aud: "https://other.example.com/mcp" })],
    ["wrong resource claim", () => issuer.mint({ aud: mcpUrl, claims: { resource: "https://other.example.com/mcp" } })],
    ["no audience", () => issuer.mint({})],
    ["wrong issuer", () => issuer.mint({ aud: mcpUrl, iss: "https://evil.example.com" })],
    ["bad signature", () => issuer.mint({ aud: mcpUrl, badSignature: true })],
    ["missing exp", () => issuer.mint({ aud: mcpUrl, noExp: true })],
    ["garbage", async () => "not-a-jwt"],
    ["unknown static key", async () => generateStaticKey("t-x", [SCOPES.memoryRead]).key],
  ];
  for (const [name, mint] of rejected) {
    it(`rejects ${name} token with 401 invalid_token`, async () => {
      const res = await rawInitialize(await mint());
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"');
      await expect(connect(await mint())).rejects.toThrow();
    });
  }

  it("missing tool scope -> 403 insufficient_scope; granted via scope/scp/permissions", async () => {
    const plain = await issuer.mint({ sub: "user_c", aud: mcpUrl, claims: { org_id: "org_c" } });
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${plain}`,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "admin_build", arguments: {} } }),
    });
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain("memory:build");

    for (const claims of [{ scope: "memory:build" }, { scp: ["memory:build"] }, { permissions: ["memory:build"] }]) {
      const client = await connect(await issuer.mint({ sub: "user_admin", aud: mcpUrl, claims }));
      try {
        expect(textOf(await client.callTool({ name: "admin_build", arguments: {} }))).toBe("build-started");
      } finally {
        await client.close();
      }
    }
  });

  it("static key is accepted on MCP when PROCMEM_STATIC_KEYS_ON_MCP=1", async () => {
    const client = await connect(ingestKey.key);
    try {
      const principal = JSON.parse(textOf(await client.callTool({ name: "whoami", arguments: {} }))) as Principal;
      expect(principal.provider).toBe("static");
      expect(principal.tenantNs).toBe("t-ingest-demo");
      expect(principal.scopes.sort()).toEqual([SCOPES.memoryRead, SCOPES.tracesWrite].sort());
    } finally {
      await client.close();
    }
  });

  it("authenticateHttp accepts the same OAuth JWTs (bound to the MCP resource) and enforces scopes", async () => {
    const req = (token: string) => new Request("http://127.0.0.1/v1/traces", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const reader = await issuer.mint({ sub: "user_d", aud: mcpUrl, claims: { org_id: "org_d" } });
    const ok = await authenticateHttp(req(reader), config, SCOPES.memoryRead, { resource: mcpUrl });
    expect(ok).not.toBeInstanceOf(Response);
    expect((ok as Principal).tenantNs).toBe(tenantNsFor(issuer.issuer, { subject: "user_d", organizationId: "org_d" }));

    const forbidden = await authenticateHttp(req(reader), config, SCOPES.tracesWrite, { resource: mcpUrl });
    expect(forbidden).toBeInstanceOf(Response);
    expect((forbidden as Response).status).toBe(403);

    const writer = await issuer.mint({ sub: "user_d", aud: mcpUrl, claims: { org_id: "org_d", permissions: ["traces:write"] } });
    expect(await authenticateHttp(req(writer), config, SCOPES.tracesWrite, { resource: mcpUrl })).not.toBeInstanceOf(Response);

    const wrongAud = await issuer.mint({ sub: "user_d", aud: "https://elsewhere.example/mcp" });
    const denied = (await authenticateHttp(req(wrongAud), config, SCOPES.memoryRead, { resource: mcpUrl })) as Response;
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain(
      `resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", mcpUrl).href}"`,
    );
  });
});
