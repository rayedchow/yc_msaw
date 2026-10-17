import { DEFAULT_IMPLICIT_SCOPES, isScope, parseScopeList, type Scope } from "./scopes.js";
import { parseStaticKeys, type StaticKeyRecord } from "./static-keys.js";
import { assertTenantNs } from "./tenant.js";

export type AuthMode = "workos" | "oidc" | "static" | "none";

export interface WorkOSAuthConfig {
  /** AuthKit domain, e.g. `example-123.authkit.app` (or a custom auth domain). */
  domain: string;
  /** `https://<domain>` — the `iss` claim of AuthKit access tokens. */
  issuer: string;
  /** `https://<domain>/oauth2/jwks`. */
  jwksUrl: string;
  /** WorkOS environment client ID (informational; used by the smoke script). */
  clientId?: string;
  /**
   * Extra accepted `aud` values. Leave unset when the MCP URL is configured as
   * a Resource Indicator in WorkOS (recommended: then `aud` must equal the MCP
   * resource URL). Set to the client ID only for environments without
   * Resource Indicators (weaker binding: any token for the environment works).
   */
  audience?: string[];
}

export interface OidcAuthConfig {
  issuer: string;
  /** Resolved by {@link loadAuthConfig} from discovery when not given. */
  jwksUrl?: string;
  /** Expected `aud` values (Okta: the authorization server's audience, e.g. `api://procmem`). */
  audience?: string[];
  /** Claim holding the organization/tenant id (default `org_id`). */
  tenantClaim: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  /** True once discovery metadata was fetched and its issuer matched. */
  discovered?: boolean;
}

export interface AuthConfig {
  mode: AuthMode;
  /**
   * Canonical MCP resource URL (RFC 8707 / RFC 9728 `resource`), e.g.
   * `https://procmem.example.com/mcp`. Undefined for local listeners, where
   * mcp-use derives it from the bound port.
   */
  resourceUrl?: string;
  /** MCP endpoint path; pass as `basePath` to `new MCPServer`. */
  basePath: string;
  workos?: WorkOSAuthConfig;
  oidc?: OidcAuthConfig;
  /** Scopes required on every MCP request (provider `requiredScopes`). */
  requiredScopes: string[];
  /** Scopes advertised in protected-resource metadata. */
  scopesSupported?: string[];
  /** Scopes granted to every verified OAuth token from the trusted issuer. */
  implicitScopes: string[];
  /** Token subjects granted memory:build + traces:write (PROCMEM_ADMIN_SUBJECTS). */
  adminSubjects: string[];
  /** `role`/`roles` claim value -> procmem scopes (PROCMEM_ROLE_SCOPES). */
  roleScopes: Record<string, Scope[]>;
  staticKeys: StaticKeyRecord[];
  /** Also accept static keys as bearer tokens on the MCP endpoint (headless agents/CI). */
  staticKeysOnMcp: boolean;
  /** Accepted JWS algorithms (asymmetric only). */
  algorithms: string[];
  /** Tenant used for the anonymous principal in `none` mode (loopback dev only). */
  devTenantNs: string;
  /** Host the server will bind (from HOST or the option), used for the fail-closed check. */
  bindHost?: string;
}

export type Env = Record<string, string | undefined>;

export interface ParseAuthOptions {
  /** Bind host override (otherwise `HOST`). */
  host?: string;
}

export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

const DEFAULT_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function list(value: string | undefined): string[] | undefined {
  const v = nonEmpty(value);
  if (!v) return undefined;
  const out = v.split(/[\s,]+/).filter(Boolean);
  return out.length ? out : undefined;
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function httpsOrLocalUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new AuthConfigError(`${name} must be an absolute URL (got ${JSON.stringify(raw)})`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AuthConfigError(`${name} must not contain credentials, query or fragment`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new AuthConfigError(`${name} must use https (http is only allowed for localhost)`);
  }
  return url;
}

/** Normalize MCP_PUBLIC_URL: an origin gets `/mcp` appended; trailing slashes are removed. */
export function normalizeResourceUrl(raw: string): { resourceUrl: string; basePath: string } {
  const url = httpsOrLocalUrl(raw, "MCP_PUBLIC_URL");
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "") path = "/mcp";
  url.pathname = path;
  return { resourceUrl: url.href, basePath: path };
}

function normalizeIssuer(raw: string, name: string): string {
  const url = httpsOrLocalUrl(raw, name);
  return url.href.replace(/\/+$/, "");
}

/**
 * Parse auth configuration from the environment. Pure and synchronous; for
 * `oidc` call {@link loadAuthConfig} (or {@link resolveOidcDiscovery}) to fill
 * the JWKS/authorize/token endpoints from discovery.
 *
 * Environment:
 *   AUTH_MODE                 workos | oidc | static | none (default: inferred)
 *   MCP_PUBLIC_URL            canonical MCP URL (falls back to MCP_URL)
 *   HOST                      bind host (fail-closed check)
 *   WORKOS_AUTHKIT_DOMAIN     e.g. example-123.authkit.app
 *   WORKOS_CLIENT_ID          optional, informational
 *   WORKOS_AUDIENCE           optional extra accepted aud values (comma list)
 *   OIDC_ISSUER               e.g. https://acme.okta.com/oauth2/default
 *   OIDC_JWKS_URL             optional (default: discovery jwks_uri)
 *   OIDC_AUDIENCE             expected aud values (default: the MCP resource URL)
 *   OIDC_TENANT_CLAIM         default org_id
 *   OIDC_AUTHORIZATION_ENDPOINT / OIDC_TOKEN_ENDPOINT / OIDC_REGISTRATION_ENDPOINT  optional overrides
 *   AUTH_REQUIRED_SCOPES      scopes required on every MCP request (alias OIDC_REQUIRED_SCOPES)
 *   AUTH_SCOPES_SUPPORTED     scopes advertised in protected-resource metadata
 *   AUTH_IMPLICIT_SCOPES      scopes granted to every verified OAuth user (default memory:read,integrations:read; "none" for none)
 *   PROCMEM_STATIC_KEYS       <sha256hex>:<tenant>:<scope+scope>,...
 *   PROCMEM_STATIC_KEYS_ON_MCP  1 to accept static keys on the MCP endpoint too
 *   PROCMEM_ADMIN_SUBJECTS    token subjects granted memory:build + traces:write (comma list)
 *   PROCMEM_ROLE_SCOPES       role->scopes, e.g. "admin=memory:build+traces:write,ingest=traces:write"
 *   AUTH_DEV_TENANT           tenant for the anonymous principal in none mode (default "local")
 */
export function parseAuthConfig(env: Env = process.env, options: ParseAuthOptions = {}): AuthConfig {
  const workosDomain = nonEmpty(env.WORKOS_AUTHKIT_DOMAIN);
  const oidcIssuer = nonEmpty(env.OIDC_ISSUER);
  const staticKeys = parseStaticKeys(env.PROCMEM_STATIC_KEYS);

  const rawMode = nonEmpty(env.AUTH_MODE)?.toLowerCase();
  let mode: AuthMode;
  if (rawMode === undefined) {
    mode = workosDomain ? "workos" : oidcIssuer ? "oidc" : staticKeys.length ? "static" : "none";
  } else if (rawMode === "workos" || rawMode === "oidc" || rawMode === "static" || rawMode === "none") {
    mode = rawMode;
  } else if (rawMode === "okta") {
    mode = "oidc";
  } else {
    throw new AuthConfigError(`AUTH_MODE must be one of workos | oidc | static | none (got ${JSON.stringify(rawMode)})`);
  }

  const publicUrl = nonEmpty(env.MCP_PUBLIC_URL) ?? nonEmpty(env.MCP_URL);
  const { resourceUrl, basePath } = publicUrl ? normalizeResourceUrl(publicUrl) : { resourceUrl: undefined, basePath: "/mcp" };

  const implicitRaw = nonEmpty(env.AUTH_IMPLICIT_SCOPES);
  const implicitScopes =
    implicitRaw === undefined ? [...DEFAULT_IMPLICIT_SCOPES] : implicitRaw.toLowerCase() === "none" ? [] : parseScopeList(implicitRaw);

  const supported = parseScopeList(env.AUTH_SCOPES_SUPPORTED);
  const config: AuthConfig = {
    mode,
    basePath,
    requiredScopes: parseScopeList(env.AUTH_REQUIRED_SCOPES ?? env.OIDC_REQUIRED_SCOPES),
    implicitScopes,
    adminSubjects: list(env.PROCMEM_ADMIN_SUBJECTS) ?? [],
    roleScopes: parseRoleScopes(env.PROCMEM_ROLE_SCOPES),
    staticKeys,
    staticKeysOnMcp: truthy(env.PROCMEM_STATIC_KEYS_ON_MCP),
    algorithms: list(env.AUTH_JWT_ALGORITHMS) ?? DEFAULT_ALGORITHMS,
    devTenantNs: assertTenantNs(nonEmpty(env.AUTH_DEV_TENANT) ?? "local", "AUTH_DEV_TENANT"),
    ...(resourceUrl !== undefined && { resourceUrl }),
    ...(supported.length > 0 && { scopesSupported: supported }),
  };
  const bindHost = options.host ?? nonEmpty(env.HOST);
  if (bindHost !== undefined) config.bindHost = bindHost;
  if (config.algorithms.some((a) => /^HS/i.test(a) || a === "none")) {
    throw new AuthConfigError("AUTH_JWT_ALGORITHMS must only list asymmetric algorithms");
  }

  if (mode === "workos") {
    if (!workosDomain) {
      throw new AuthConfigError(
        "AUTH_MODE=workos requires WORKOS_AUTHKIT_DOMAIN (WorkOS dashboard -> Domains -> AuthKit domain, e.g. example-123.authkit.app)",
      );
    }
    const issuer = normalizeIssuer(workosDomain, "WORKOS_AUTHKIT_DOMAIN");
    if (new URL(issuer).pathname !== "/") throw new AuthConfigError("WORKOS_AUTHKIT_DOMAIN must be a bare hostname");
    const clientId = nonEmpty(env.WORKOS_CLIENT_ID);
    const audience = list(env.WORKOS_AUDIENCE);
    config.workos = {
      domain: new URL(issuer).host,
      issuer,
      jwksUrl: `${issuer}/oauth2/jwks`,
      ...(clientId !== undefined && { clientId }),
      ...(audience !== undefined && { audience }),
    };
  }

  if (mode === "oidc") {
    if (!oidcIssuer) {
      throw new AuthConfigError(
        "AUTH_MODE=oidc requires OIDC_ISSUER (Okta: https://<org>.okta.com/oauth2/<authServerId>, e.g. .../oauth2/default)",
      );
    }
    const jwks = nonEmpty(env.OIDC_JWKS_URL);
    const audience = list(env.OIDC_AUDIENCE);
    const authz = nonEmpty(env.OIDC_AUTHORIZATION_ENDPOINT);
    const token = nonEmpty(env.OIDC_TOKEN_ENDPOINT);
    const reg = nonEmpty(env.OIDC_REGISTRATION_ENDPOINT);
    config.oidc = {
      issuer: normalizeIssuer(oidcIssuer, "OIDC_ISSUER"),
      tenantClaim: nonEmpty(env.OIDC_TENANT_CLAIM) ?? "org_id",
      ...(jwks !== undefined && { jwksUrl: httpsOrLocalUrl(jwks, "OIDC_JWKS_URL").href }),
      ...(audience !== undefined && { audience }),
      ...(authz !== undefined && { authorizationEndpoint: httpsOrLocalUrl(authz, "OIDC_AUTHORIZATION_ENDPOINT").href }),
      ...(token !== undefined && { tokenEndpoint: httpsOrLocalUrl(token, "OIDC_TOKEN_ENDPOINT").href }),
      ...(reg !== undefined && { registrationEndpoint: httpsOrLocalUrl(reg, "OIDC_REGISTRATION_ENDPOINT").href }),
    };
  }

  if (mode === "static" && staticKeys.length === 0) {
    throw new AuthConfigError("AUTH_MODE=static requires PROCMEM_STATIC_KEYS (generate with: npx tsx src/auth/keygen.ts)");
  }

  assertSafeStartup(config);
  return config;
}

function parseRoleScopes(value: string | undefined): Record<string, Scope[]> {
  const out: Record<string, Scope[]> = {};
  for (const entry of (value ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const role = entry.slice(0, eq).trim();
    if (eq <= 0 || !role) throw new AuthConfigError(`PROCMEM_ROLE_SCOPES entry ${JSON.stringify(entry)} must be role=scope+scope`);
    const scopes = parseScopeList(entry.slice(eq + 1));
    const bad = scopes.filter((s) => !isScope(s));
    if (bad.length || scopes.length === 0) throw new AuthConfigError(`PROCMEM_ROLE_SCOPES ${role}: unknown or empty scopes ${bad.join(" ")}`);
    out[role] = scopes as Scope[];
  }
  return out;
}

/**
 * Fail closed: the MCP endpoint is only unauthenticated (`none`, or `static`
 * where no OAuth provider guards MCP) on loopback. Call again with the actual
 * listen host if it differs from HOST.
 */
export function assertSafeStartup(config: AuthConfig, host: string | undefined = config.bindHost): void {
  const publicHost = host !== undefined && !isLoopbackHost(host);
  const publicUrl = config.resourceUrl !== undefined && !isLoopbackHost(new URL(config.resourceUrl).hostname);
  if (!publicHost && !publicUrl) return;
  const where = publicUrl ? `MCP_PUBLIC_URL=${config.resourceUrl}` : `HOST=${host}`;
  if (config.mode === "none") {
    throw new AuthConfigError(
      `Refusing to start: AUTH_MODE=none but the server is publicly reachable (${where}). ` +
        "Set AUTH_MODE=workos with WORKOS_AUTHKIT_DOMAIN (or AUTH_MODE=oidc with OIDC_ISSUER), " +
        "or bind to 127.0.0.1 for local development.",
    );
  }
  if (config.mode === "static") {
    throw new AuthConfigError(
      `Refusing to start: AUTH_MODE=static leaves the MCP endpoint without an OAuth gate (${where}). ` +
        "Use AUTH_MODE=workos or oidc; static keys still work for the HTTP ingest API (and on MCP with PROCMEM_STATIC_KEYS_ON_MCP=1).",
    );
  }
  if (publicHost && config.resourceUrl === undefined) {
    throw new AuthConfigError(
      `Refusing to start: OAuth on a public bind (${where}) needs the canonical resource URL. Set MCP_PUBLIC_URL=https://<your-host>/mcp.`,
    );
  }
}

/** Alias used by the server entrypoint: `assertAuthStartupSafe(config, listenHost)`. */
export const assertAuthStartupSafe = assertSafeStartup;

export interface OidcDiscoveryDocument {
  issuer: string;
  jwks_uri?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  [key: string]: unknown;
}

/** Candidate discovery URLs: RFC 8414 path-inserted, Okta's suffix form, then OIDC `<issuer>/.well-known/openid-configuration`. */
export function discoveryUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  // RFC 8414 first (what MCP clients use; AuthKit only lists registration/CIMD there), then OIDC.
  const urls = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/oauth-authorization-server`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
  return [...new Set(urls)];
}

export async function fetchDiscovery(issuer: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<OidcDiscoveryDocument> {
  const errors: string[] = [];
  for (const candidate of discoveryUrls(issuer)) {
    try {
      const res = await fetchImpl(candidate, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        errors.push(`${candidate}: HTTP ${res.status}`);
        continue;
      }
      const doc = (await res.json()) as OidcDiscoveryDocument;
      if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== issuer) {
        errors.push(`${candidate}: issuer mismatch (${String(doc.issuer)})`);
        continue;
      }
      return doc;
    } catch (error) {
      errors.push(`${candidate}: ${(error as Error).message}`);
    }
  }
  throw new AuthConfigError(`OIDC discovery failed for ${issuer}: ${errors.join("; ")}`);
}

/** Fill missing OIDC endpoints from discovery (never overrides explicit env values). */
export async function resolveOidcDiscovery(config: AuthConfig, fetchImpl: typeof fetch = fetch): Promise<AuthConfig> {
  const oidc = config.oidc;
  if (config.mode !== "oidc" || !oidc) return config;
  if (oidc.jwksUrl && oidc.authorizationEndpoint && oidc.tokenEndpoint) return config;
  const doc = await fetchDiscovery(oidc.issuer, fetchImpl);
  const pick = (v: unknown, name: string) => (typeof v === "string" ? httpsOrLocalUrl(v, name).href : undefined);
  const jwks = oidc.jwksUrl ?? pick(doc.jwks_uri, "jwks_uri");
  if (!jwks) throw new AuthConfigError(`OIDC discovery for ${oidc.issuer} has no jwks_uri; set OIDC_JWKS_URL`);
  const authz = oidc.authorizationEndpoint ?? pick(doc.authorization_endpoint, "authorization_endpoint");
  const token = oidc.tokenEndpoint ?? pick(doc.token_endpoint, "token_endpoint");
  const reg = oidc.registrationEndpoint ?? pick(doc.registration_endpoint, "registration_endpoint");
  return {
    ...config,
    oidc: {
      ...oidc,
      jwksUrl: jwks,
      discovered: true,
      ...(authz !== undefined && { authorizationEndpoint: authz }),
      ...(token !== undefined && { tokenEndpoint: token }),
      ...(reg !== undefined && { registrationEndpoint: reg }),
    },
  };
}

/** Parse env and, for OIDC, resolve discovery. Use this at server startup. */
export async function loadAuthConfig(
  env: Env = process.env,
  options: ParseAuthOptions & { fetch?: typeof fetch } = {},
): Promise<AuthConfig> {
  const config = parseAuthConfig(env, options);
  return resolveOidcDiscovery(config, options.fetch);
}
