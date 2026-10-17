import { MCPServer } from "mcp-use";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertAuthStartupSafe,
  assertSafeStartup,
  AuthConfigError,
  authenticateHttp,
  buildMcpOAuth,
  generateStaticKey,
  hashStaticKey,
  loadAuthConfig,
  matchStaticKey,
  parseAuthConfig,
  parseStaticKeys,
  principalFromAuth,
  protectedResourceMetadataUrl,
  SCOPES,
  tenantNsFor,
  type Principal,
  type ProcmemUser,
} from "../src/auth/index.js";
import { startMockIssuer, type MockIssuer } from "../src/auth/testing/mock-issuer.js";

const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

describe("config parsing and fail-closed startup", () => {
  it("infers modes and normalizes the resource URL", () => {
    const c = parseAuthConfig({ WORKOS_AUTHKIT_DOMAIN: "acme-1.authkit.app", MCP_PUBLIC_URL: "https://procmem.example.com" });
    expect(c.mode).toBe("workos");
    expect(c.resourceUrl).toBe("https://procmem.example.com/mcp");
    expect(c.basePath).toBe("/mcp");
    expect(c.workos?.issuer).toBe("https://acme-1.authkit.app");
    expect(c.workos?.jwksUrl).toBe("https://acme-1.authkit.app/oauth2/jwks");
    expect(parseAuthConfig({}).mode).toBe("none");
  });

  it("throws when AUTH_MODE=none on a public host or public URL", () => {
    expect(() => parseAuthConfig({ AUTH_MODE: "none", HOST: "0.0.0.0" })).toThrow(AuthConfigError);
    expect(() => parseAuthConfig({ AUTH_MODE: "none", MCP_PUBLIC_URL: "https://x.example.com/mcp" })).toThrow(/AUTH_MODE=none/);
    expect(() => parseAuthConfig({ HOST: "0.0.0.0" })).toThrow(/Refusing to start/);
    expect(() => parseAuthConfig({ AUTH_MODE: "none", HOST: "127.0.0.1" })).not.toThrow();
    const local = parseAuthConfig({ AUTH_MODE: "none" });
    expect(() => assertSafeStartup(local, "0.0.0.0")).toThrow(/Refusing to start/);
    expect(() => assertAuthStartupSafe(local, "::")).toThrow(/Refusing to start/);
    expect(() => assertAuthStartupSafe(local, "127.0.0.1")).not.toThrow();
  });

  it("static-only mode cannot be public; OAuth on public bind needs MCP_PUBLIC_URL", () => {
    const k = generateStaticKey("t-a", [SCOPES.tracesWrite]);
    expect(() => parseAuthConfig({ AUTH_MODE: "static", PROCMEM_STATIC_KEYS: k.entry, HOST: "0.0.0.0" })).toThrow(/static/);
    expect(() => parseAuthConfig({ AUTH_MODE: "workos", WORKOS_AUTHKIT_DOMAIN: "a.authkit.app", HOST: "0.0.0.0" })).toThrow(
      /MCP_PUBLIC_URL/,
    );
    expect(() =>
      parseAuthConfig({ AUTH_MODE: "workos", WORKOS_AUTHKIT_DOMAIN: "a.authkit.app", HOST: "0.0.0.0", MCP_PUBLIC_URL: "https://p.example.com/mcp" }),
    ).not.toThrow();
  });

  it("rejects misconfiguration", () => {
    expect(() => parseAuthConfig({ AUTH_MODE: "workos" })).toThrow(/WORKOS_AUTHKIT_DOMAIN/);
    expect(() => parseAuthConfig({ AUTH_MODE: "oidc" })).toThrow(/OIDC_ISSUER/);
    expect(() => parseAuthConfig({ AUTH_MODE: "bogus" })).toThrow(/AUTH_MODE/);
    expect(() => parseAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: "http://evil.example.com" })).toThrow(/https/);
    expect(() => parseAuthConfig({ AUTH_JWT_ALGORITHMS: "HS256" })).toThrow(/asymmetric/);
    expect(() => parseAuthConfig({ PROCMEM_STATIC_KEYS: "pmk_rawkey:t-a:memory:read" })).toThrow(/sha256/);
    expect(() => parseAuthConfig({ PROCMEM_STATIC_KEYS: `${"a".repeat(64)}:Bad_Tenant:memory:read` })).toThrow(/tenant/);
    expect(() => parseAuthConfig({ PROCMEM_STATIC_KEYS: `${"a".repeat(64)}:t-a:memory:wrte` })).toThrow(/unknown scope/);
  });
});

describe("static keys", () => {
  it("stores only hashes and matches in constant time", () => {
    const a = generateStaticKey("t-alpha", [SCOPES.tracesWrite]);
    const b = generateStaticKey("t-beta", [SCOPES.memoryRead, SCOPES.memoryBuild]);
    expect(a.entry).not.toContain(a.key);
    expect(a.hash).toBe(hashStaticKey(a.key));
    const records = parseStaticKeys(`${a.entry},${b.entry}`);
    expect(matchStaticKey(records, a.key)?.tenantNs).toBe("t-alpha");
    expect(matchStaticKey(records, b.key)?.scopes).toEqual([SCOPES.memoryRead, SCOPES.memoryBuild]);
    expect(matchStaticKey(records, `${a.key}x`)).toBeUndefined();
    expect(matchStaticKey(records, "pmk_short")).toBeUndefined();
  });

  it("authenticateHttp: static key accepted, bad/missing key rejected with challenges, scope enforced", async () => {
    const k = generateStaticKey("t-ingest", [SCOPES.tracesWrite]);
    const config = parseAuthConfig({ AUTH_MODE: "static", PROCMEM_STATIC_KEYS: k.entry });
    const req = (auth?: string) => new Request("http://127.0.0.1/v1/traces", { method: "POST", headers: auth ? { authorization: auth } : {} });

    const ok = (await authenticateHttp(req(`Bearer ${k.key}`), config, SCOPES.tracesWrite)) as Principal;
    expect(ok).toMatchObject({ provider: "static", tenantNs: "t-ingest", scopes: [SCOPES.tracesWrite] });

    const bad = (await authenticateHttp(req(`Bearer ${generateStaticKey("t-ingest", [SCOPES.tracesWrite]).key}`), config, SCOPES.tracesWrite)) as Response;
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const missing = (await authenticateHttp(req(), config, SCOPES.tracesWrite)) as Response;
    expect(missing.status).toBe(401);

    const malformed = (await authenticateHttp(req("Basic abc"), config, SCOPES.tracesWrite)) as Response;
    expect(malformed.status).toBe(401);

    const jwtInStaticMode = (await authenticateHttp(req("Bearer eyJ.eyJ.sig"), config, SCOPES.tracesWrite)) as Response;
    expect(jwtInStaticMode.status).toBe(401);

    const forbidden = (await authenticateHttp(req(`Bearer ${k.key}`), config, SCOPES.memoryBuild)) as Response;
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(forbidden.headers.get("www-authenticate")).toContain('scope="memory:build"');
  });

  it("none mode gives the loopback dev principal", async () => {
    const config = parseAuthConfig({ AUTH_MODE: "none" });
    const p = (await authenticateHttp(new Request("http://127.0.0.1/x"), config, SCOPES.memoryBuild)) as Principal;
    expect(p).toMatchObject({ provider: "none", tenantNs: "local" });
    expect(principalFromAuth(undefined, config).tenantNs).toBe("local");
    expect(() => principalFromAuth(undefined)).toThrow(/Unauthenticated/);
  });
});

describe("tenant namespaces", () => {
  it("are deterministic, issuer-scoped, org-shared and valid", () => {
    const iss = "https://acme.authkit.app";
    const a = tenantNsFor(iss, { subject: "user_1", organizationId: "org_1" });
    expect(a).toMatch(TENANT_RE);
    expect(a).toMatch(/^t-[0-9a-f]{20}$/);
    expect(tenantNsFor(iss, { subject: "user_2", organizationId: "org_1" })).toBe(a);
    expect(tenantNsFor(iss, { subject: "user_1", organizationId: "org_2" })).not.toBe(a);
    expect(tenantNsFor("https://other.authkit.app", { subject: "user_1", organizationId: "org_1" })).not.toBe(a);
    expect(tenantNsFor(iss, { subject: "user_1" })).not.toBe(tenantNsFor(iss, { subject: "user_2" }));
    expect(tenantNsFor(`${iss}/`, { subject: "user_1", organizationId: "org_1" })).toBe(a);
  });

  it("protected resource metadata URL follows RFC 9728 path insertion", () => {
    expect(protectedResourceMetadataUrl("https://p.example.com/mcp")).toBe("https://p.example.com/.well-known/oauth-protected-resource/mcp");
    expect(protectedResourceMetadataUrl("https://p.example.com/")).toBe("https://p.example.com/.well-known/oauth-protected-resource");
  });
});

describe("OIDC discovery (Okta-style issuer path)", () => {
  let issuer: MockIssuer;
  beforeAll(async () => {
    issuer = await startMockIssuer({ path: "/oauth2/aus123" });
  });
  afterAll(() => issuer.close());

  it("fills JWKS/authorize/token from discovery and builds an oauth provider", async () => {
    const config = await loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: issuer.issuer, OIDC_AUDIENCE: "api://procmem" });
    expect(config.oidc?.jwksUrl).toBe(issuer.jwksUrl);
    expect(config.oidc?.authorizationEndpoint).toBe(`${issuer.issuer}/authorize`);
    const oauth = buildMcpOAuth(config);
    expect(oauth?.oauthMetadata).toMatchObject({ issuer: issuer.issuer, jwks_uri: issuer.jwksUrl });
  });

  it("accepts Okta-style aud=api://… tokens with scp claims, rejects others", async () => {
    const config = await loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: issuer.issuer, OIDC_AUDIENCE: "api://procmem", OIDC_TENANT_CLAIM: "tenant" });
    const resource = "http://127.0.0.1:9/mcp";
    const call = async (token: string, scope: string) =>
      authenticateHttp(new Request("http://127.0.0.1/v1/traces", { headers: { authorization: `Bearer ${token}` } }), config, scope, { resource });
    const okta = await issuer.mint({ sub: "00u1", aud: "api://procmem", claims: { scp: ["traces:write"], cid: "0oa1", tenant: "acme" } });
    const p = (await call(okta, SCOPES.tracesWrite)) as Principal;
    expect(p.organizationId).toBe("acme");
    expect(p.tenantNs).toBe(tenantNsFor(issuer.issuer, { subject: "00u1", organizationId: "acme" }));
    expect(((await call(await issuer.mint({ aud: "api://other" }), SCOPES.memoryRead)) as Response).status).toBe(401);
  });

  it("refuses to build an OIDC provider without resolved metadata", () => {
    const config = parseAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: issuer.issuer });
    expect(() => buildMcpOAuth(config)).toThrow(/loadAuthConfig/);
  });
});

describe("WorkOS AuthKit provider", () => {
  const domain = "procmem-test.authkit.app";
  const authkit = `https://${domain}`;
  const resource = "https://procmem.example.com/mcp";
  let issuer: MockIssuer;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    issuer = await startMockIssuer();
    // Serve the AuthKit JWKS URL from the local mock key set (no network).
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${authkit}/oauth2/jwks`) return realFetch(issuer.jwksUrl, init);
      return realFetch(input, init);
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await issuer.close();
  });

  const workosConfig = () => parseAuthConfig({ AUTH_MODE: "workos", WORKOS_AUTHKIT_DOMAIN: domain, MCP_PUBLIC_URL: resource, HOST: "0.0.0.0" });

  it("verifies AuthKit tokens bound to the MCP resource and maps org_id to the tenant", async () => {
    const config = workosConfig();
    const call = async (token: string) =>
      authenticateHttp(new Request("https://procmem.example.com/v1/traces", { headers: { authorization: `Bearer ${token}` } }), config, SCOPES.memoryRead);
    const good = await issuer.mint({ iss: authkit, aud: resource, sub: "user_01", claims: { org_id: "org_01", sid: "session_1" } });
    const p = (await call(good)) as Principal;
    expect(p).toMatchObject({ provider: "workos", subject: "user_01", organizationId: "org_01", issuer: authkit });
    expect(p.tenantNs).toBe(tenantNsFor(authkit, { subject: "user_01", organizationId: "org_01" }));

    // Without Resource Indicators AuthKit sets aud=<client id>; rejected unless WORKOS_AUDIENCE opts in.
    const clientAud = await issuer.mint({ iss: authkit, aud: "client_01ABC", sub: "user_01" });
    expect(((await call(clientAud)) as Response).status).toBe(401);
    const lax = parseAuthConfig({ AUTH_MODE: "workos", WORKOS_AUTHKIT_DOMAIN: domain, MCP_PUBLIC_URL: resource, WORKOS_AUDIENCE: "client_01ABC" });
    const laxed = await authenticateHttp(new Request(resource, { headers: { authorization: `Bearer ${clientAud}` } }), lax, SCOPES.memoryRead);
    expect(laxed).not.toBeInstanceOf(Response);

    expect(((await call(await issuer.mint({ aud: resource }))) as Response).status).toBe(401); // wrong issuer (mock, not AuthKit)
  });

  it("WorkOS users get memory:read only; admin/trace-write come from explicit config", async () => {
    const env = { AUTH_MODE: "workos", WORKOS_AUTHKIT_DOMAIN: domain, MCP_PUBLIC_URL: resource };
    const req = (t: string) => new Request(resource, { headers: { authorization: `Bearer ${t}` } });
    const plain = await issuer.mint({ iss: authkit, aud: resource, sub: "user_p", scope: "openid profile email offline_access" });
    const base = parseAuthConfig(env);
    const p = (await authenticateHttp(req(plain), base, SCOPES.memoryRead)) as Principal;
    expect(p.scopes).toContain(SCOPES.memoryRead);
    expect(p.tenantNs).toBe(tenantNsFor(authkit, { subject: "user_p" }));
    expect(((await authenticateHttp(req(plain), base, SCOPES.tracesWrite)) as Response).status).toBe(403);
    expect(((await authenticateHttp(req(plain), base, SCOPES.memoryBuild)) as Response).status).toBe(403);

    const admins = parseAuthConfig({ ...env, PROCMEM_ADMIN_SUBJECTS: "user_p" });
    expect(await authenticateHttp(req(plain), admins, [SCOPES.memoryBuild, SCOPES.tracesWrite])).not.toBeInstanceOf(Response);

    const roles = parseAuthConfig({ ...env, PROCMEM_ROLE_SCOPES: "ingest=traces:write" });
    const ingest = await issuer.mint({ iss: authkit, aud: resource, sub: "user_r", claims: { org_id: "org_r", role: "ingest" } });
    expect(await authenticateHttp(req(ingest), roles, SCOPES.tracesWrite)).not.toBeInstanceOf(Response);
    expect(((await authenticateHttp(req(ingest), roles, SCOPES.memoryBuild)) as Response).status).toBe(403);
    // Unknown permission strings are ignored; procmem permission slugs are honored.
    const perm = await issuer.mint({ iss: authkit, aud: resource, sub: "user_s", claims: { permissions: ["billing:write", "memory:build"] } });
    const ps = (await authenticateHttp(req(perm), base, SCOPES.memoryBuild)) as Principal;
    expect(ps.scopes).not.toContain("billing:write");
  });

  it("MCPServer with the WorkOS provider advertises AuthKit and challenges unauthenticated calls", async () => {
    const config = workosConfig();
    const oauth = buildMcpOAuth(config);
    if (!oauth) throw new Error("expected provider");
    expect(oauth.oauthMetadata).toMatchObject({
      issuer: authkit,
      authorization_endpoint: `${authkit}/oauth2/authorize`,
      token_endpoint: `${authkit}/oauth2/token`,
      registration_endpoint: `${authkit}/oauth2/register`,
    });
    const server = new MCPServer<ProcmemUser>({ name: "wk", version: "0.0.0", oauth });
    server.tool({ name: "whoami" }, async (_a, ctx) => ({ content: [{ type: "text", text: JSON.stringify(principalFromAuth(ctx.auth)) }] }));
    const prm = await server.fetch(new Request("https://procmem.example.com/.well-known/oauth-protected-resource/mcp"));
    expect(prm.status).toBe(200);
    expect(await prm.json()).toMatchObject({ resource, authorization_servers: [authkit] });

    const init = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    };
    const unauth = await server.fetch(new Request(resource, init));
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://procmem.example.com/.well-known/oauth-protected-resource/mcp"',
    );

    const token = await issuer.mint({ iss: authkit, aud: resource, sub: "user_02", claims: { org_id: "org_02" } });
    const authed = await server.fetch(new Request(resource, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }));
    expect(authed.status).toBe(200);
    await server.close();
  });
});
