# procmem auth

The MCP endpoint and the HTTP APIs (trace ingest, admin build trigger) are an OAuth 2.1 **resource server**.
The primary provider is WorkOS AuthKit. Okta and other OIDC servers work through generic OIDC. Static scoped keys exist only for headless SDK ingest and CI.
Code: `src/auth/` (entry: `src/auth/index.ts`).

## Server wiring (mcp-use)

```ts
import { MCPServer } from "mcp-use";
import { loadAuthConfig, buildMcpOAuth, principalFromAuth, authenticateHttp, assertAuthStartupSafe, SCOPES, type ProcmemUser } from "./src/auth/index.js";

const auth = await loadAuthConfig(process.env);            // parses env, runs OIDC discovery, fails closed
const oauth = buildMcpOAuth(auth);                          // undefined in none/static mode
const server = new MCPServer<ProcmemUser>({ name: "procmem", version, basePath: auth.basePath, oauth: oauth! });
server.tool({ name: "read_memory" }, async (args, ctx) => {
  const p = principalFromAuth(ctx.auth, auth);              // { subject, tenantNs, scopes, provider, issuer, organizationId? }
  ...
});
assertAuthStartupSafe(auth, listenHost);                    // call with the real bind host before listen()

// Non-MCP routes:
const p = await authenticateHttp(request, auth, SCOPES.tracesWrite);
if (p instanceof Response) return p;                        // 401/403 with a WWW-Authenticate challenge
```

mcp-use then serves the following:
- `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728). It returns `{ resource, authorization_servers: [issuer] }`.
- `/.well-known/oauth-authorization-server`, a mirror of the authorization server metadata.
- A bearer gate on `/mcp`. A missing or invalid token gets `401`. A missing tool scope gets `403`. Both carry `WWW-Authenticate: Bearer error=…, resource_metadata="…"`.
- `ctx.auth` in callbacks.

## Environment

| var | meaning |
|---|---|
| `AUTH_MODE` | `workos` \| `oidc` \| `static` \| `none`. If unset, the mode is inferred from the variables below. |
| `MCP_PUBLIC_URL` | Canonical MCP resource URL, e.g. `https://procmem.example.com/mcp`. A bare origin gets `/mcp` appended. Falls back to `MCP_URL`. |
| `HOST` | Bind host, used by the fail-closed check. |
| `WORKOS_AUTHKIT_DOMAIN` | e.g. `sincere-umbrella-45-staging.authkit.app` |
| `WORKOS_CLIENT_ID` | Optional and informational, e.g. `client_01M55NQW24M2N592XSVA0XA5G7` |
| `WORKOS_AUDIENCE` | Optional extra accepted `aud`. Set it to the client ID **only** if no Resource Indicator is configured. That is weaker: any token for the environment is accepted. |
| `OIDC_ISSUER` | e.g. `https://acme.okta.com/oauth2/default` |
| `OIDC_JWKS_URL` | Optional. Defaults to discovery `jwks_uri`. |
| `OIDC_AUDIENCE` | Expected `aud`, e.g. Okta `api://procmem`. Defaults to the MCP resource URL. |
| `OIDC_TENANT_CLAIM` | Claim naming the organization. Default `org_id`. |
| `OIDC_AUTHORIZATION_ENDPOINT` / `OIDC_TOKEN_ENDPOINT` / `OIDC_REGISTRATION_ENDPOINT` | Optional overrides of the discovered endpoints. |
| `AUTH_REQUIRED_SCOPES` | Scopes required on every MCP request. Leave empty for WorkOS. |
| `AUTH_SCOPES_SUPPORTED` | Scopes advertised in protected-resource metadata. |
| `AUTH_IMPLICIT_SCOPES` | Granted to every verified OAuth user. Default `memory:read,integrations:read`. Set to `none` to disable. |
| `PROCMEM_ADMIN_SUBJECTS` | Token `sub` values that get `memory:build` and `traces:write`. |
| `PROCMEM_ROLE_SCOPES` | Maps the `role`/`roles` claim to scopes, e.g. `admin=memory:build+traces:write,ingest=traces:write`. |
| `PROCMEM_STATIC_KEYS` | Comma-separated `sha256hex:tenant:scope1+scope2` entries. Only hashes are stored. |
| `PROCMEM_STATIC_KEYS_ON_MCP` | `1` makes the MCP endpoint accept static keys too, for headless agents and CI. |
| `AUTH_DEV_TENANT` | Tenant of the anonymous principal in `none` mode. Default `local`. |
| `AUTH_JWT_ALGORITHMS` | Accepted JWS algorithms. Default: asymmetric only. HS* is refused. |

**Fail closed.** Startup throws in these cases:
- `none` or `static` mode with a non-loopback `HOST` or a non-localhost `MCP_PUBLIC_URL`.
- OAuth on a public bind without `MCP_PUBLIC_URL`.

## WorkOS AuthKit setup (host / dashboard)

1. **Domains:** copy the AuthKit domain into `WORKOS_AUTHKIT_DOMAIN`. The staging domain is `sincere-umbrella-45-staging.authkit.app`.
2. **Connect → Configuration:** enable **Client ID Metadata Document (CIMD)**, which the MCP spec recommends. Also enable **Dynamic Client Registration** for older MCP clients. Both are done on staging: `/.well-known/oauth-authorization-server` lists `registration_endpoint` and `client_id_metadata_document_supported: true`.
3. **Resource Indicators:** add the exact deployed MCP URL, e.g. `https://<manufact-host>/mcp`. It must equal `MCP_PUBLIC_URL`, with no trailing slash. Optionally mark it as the default, so clients that omit `resource` still get `aud=<MCP URL>`. Without a Resource Indicator, AuthKit sets `aud` to the client ID, and tokens are rejected unless `WORKOS_AUDIENCE` is set.
4. **Redirects:** MCP clients bring their own redirect URIs through CIMD or DCR. No per-client setup is needed.
5. **Organizations / RBAC (optional):** tokens with `org_id` map all org members to one tenant. Grant admin privileges with permissions named `memory:build` / `traces:write`, with `PROCMEM_ROLE_SCOPES`, or with `PROCMEM_ADMIN_SUBJECTS`.
6. Deploy with `AUTH_MODE=workos`, `WORKOS_AUTHKIT_DOMAIN=…`, `MCP_PUBLIC_URL=https://<host>/mcp`.

WorkOS issues only OIDC scopes (`openid profile email offline_access`). procmem therefore **never requires custom scopes on WorkOS tokens**. Privileges come from verified claims plus the config above.

## Okta (generic OIDC)

1. Use a **custom authorization server** (Security → API → Authorization Servers). The org authorization server's tokens cannot be validated by third parties.
2. Set `OIDC_ISSUER=https://<org>.okta.com/oauth2/<id>`. JWKS is `<issuer>/v1/keys`, found through discovery.
3. Set the authorization server **Audience**. Either use the MCP URL, or set `OIDC_AUDIENCE` to it (e.g. `api://procmem`).
4. Optionally create the scopes `memory:read traces:write memory:build integrations:read`. Okta puts them in `scp`, which is honored. Then set `AUTH_SCOPES_SUPPORTED` to advertise them.
5. Optionally add an `org_id` claim, or set `OIDC_TENANT_CLAIM`, to share a tenant across users.

## Static keys (SDK ingest / CI only)

```sh
npx tsx src/auth/keygen.ts --tenant t-0123456789abcdef0123 --scopes traces:write
# or derive the tenant of a WorkOS org:
npx tsx src/auth/keygen.ts --tenant-from-issuer https://<domain>.authkit.app --org org_01ABC --scopes traces:write
```

The command prints the client key (`pmk_…`, shown once) and the `PROCMEM_STATIC_KEYS` entry (`sha256:tenant:scopes`).
- Send the key as `Authorization: Bearer pmk_…`.
- The server hashes the presented key and compares it against every configured hash with `timingSafeEqual`.
- A static key gets exactly its listed scopes.

Static keys are **not** the WorkOS proof. The OAuth path is.

## What is verified

- **OAuth access tokens:**
  - The JWS signature is checked against the issuer JWKS, with asymmetric algorithms only.
  - `iss` must exactly equal the configured issuer.
  - `exp` must be present and in the future. `sub` must be present.
  - **Resource binding:** `aud` (or `resource`) must equal the canonical MCP URL, or `OIDC_AUDIENCE` / `WORKOS_AUDIENCE`.
  - WorkOS uses mcp-use `oauthWorkOSProvider({ subdomain, resource })`. Okta and OIDC use `createJwtVerifier`.
- **Scopes:**
  - The endpoint-wide `AUTH_REQUIRED_SCOPES` apply to every request.
  - Per-tool scopes come from `toolSecuritySchemes(auth, SCOPES.memoryBuild)`. The mcp-use gate enforces them with a `403 insufficient_scope`.
  - `authenticateHttp` enforces the route scope.

## Tenant isolation model

`tenantNs = "t-" + sha256(issuer + "|org:" + org_id)[:20]`. When the token has no org, `"|sub:" + sub` is used instead.
- The namespace is deterministic. It matches `^[a-z0-9][a-z0-9-]{0,79}$`.
- Issuer-scoped: two IdPs never collide.
- Members of one WorkOS organization share a namespace. Different orgs, and personal accounts, are isolated.
- The tenant is always derived server-side from verified claims. Clients never supply it.
- Static keys carry an explicit tenant, fixed in config.

## Smoke checks

```sh
npx vitest run tests/auth*      # real MCPServer + mock issuer + MCP SDK client
PROCMEM_MCP_URL=https://<host>/mcp PROCMEM_SMOKE_EXPECT_ISSUER=https://sincere-umbrella-45-staging.authkit.app \
  [PROCMEM_TEST_ACCESS_TOKEN=<token>] [PROCMEM_SMOKE_TOOL=<tool>] npx tsx scripts/auth-smoke.ts
```

The smoke script checks the following, in order:
1. Protected-resource metadata.
2. AuthKit metadata, and DCR/CIMD availability.
3. JWKS is reachable.
4. An unauthenticated MCP `initialize` gets `401` with the right `resource_metadata`.
5. A forged token gets `401`.
6. With a token: an authorized `initialize` + `tools/list` (and the optional tool call) through the MCP SDK client.

Evidence is written to `reports/auth-smoke.json`. The token is never printed or stored.
