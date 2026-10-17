import { createJwtVerifier, OAuthError, OAuthErrorCode, type OAuthAuthInfo, type OAuthTokenVerifier } from "mcp-use/oauth";
import { oauthWorkOSProvider } from "mcp-use/oauth/workos";
import type { AuthConfig } from "./config.js";
import { ADMIN_SCOPES, isScope } from "./scopes.js";
import { looksLikeStaticKey, matchStaticKey } from "./static-keys.js";
import { tenantNsFor } from "./tenant.js";

/** Pseudo-issuer for static keys. JWTs can never carry it: the JWT verifier pins the real issuer. */
export const STATIC_ISSUER = "urn:procmem:static";
const STATIC_MARK = "procmemStaticKey";

export type AuthProviderKind = "workos" | "oidc" | "static" | "none";

/** Identity exposed as `ctx.auth.user` in mcp-use tool callbacks. */
export interface ProcmemUser {
  id: string;
  provider: AuthProviderKind;
  issuer: string;
  tenantNs: string;
  organizationId?: string;
  email?: string;
  roles: string[];
}

function invalidToken(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Issuer, JWKS and audience for the configured OAuth provider, or undefined when none. */
export function oauthIssuerSettings(config: AuthConfig): { issuer: string; jwksUrl: string; audience?: string[] } | undefined {
  if (config.mode === "workos" && config.workos) {
    const { issuer, jwksUrl, audience } = config.workos;
    return { issuer, jwksUrl, ...(audience !== undefined && { audience }) };
  }
  if (config.mode === "oidc" && config.oidc) {
    const { issuer, jwksUrl, audience } = config.oidc;
    if (!jwksUrl) {
      throw new Error("OIDC JWKS URL is unresolved: build auth config with `await loadAuthConfig()` (runs discovery) or set OIDC_JWKS_URL");
    }
    return { issuer, jwksUrl, ...(audience !== undefined && { audience }) };
  }
  return undefined;
}

/**
 * JWT verifier for the configured issuer, bound to `resource`.
 * - workos: mcp-use `oauthWorkOSProvider({ subdomain, resource })` verifier (issuer
 *   `https://<domain>`, AuthKit JWKS, `aud`/`resource` must equal the MCP resource URL).
 *   With WORKOS_AUDIENCE set, `createJwtVerifier` with those audiences plus the resource.
 * - oidc: `createJwtVerifier` (issuer, discovered JWKS, aud = OIDC_AUDIENCE or the resource).
 */
function innerJwtVerifier(config: AuthConfig, resource: URL): OAuthTokenVerifier | undefined {
  const settings = oauthIssuerSettings(config);
  if (!settings) return undefined;
  if (config.mode === "workos" && config.workos && settings.audience === undefined) {
    return oauthWorkOSProvider({ subdomain: config.workos.domain, resource: resource.href }).createTokenVerifier(resource);
  }
  return createJwtVerifier({
    issuer: settings.issuer,
    jwksUrl: new URL(settings.jwksUrl),
    resource,
    algorithms: config.algorithms,
    // A configured audience replaces mcp-use's aud==resource check, so keep the resource URL acceptable too.
    ...(settings.audience !== undefined && { audience: [...new Set([...settings.audience, resource.href])] }),
  });
}

/**
 * App privileges for a verified OAuth token. WorkOS only issues OIDC scopes,
 * so procmem privileges come from verified claims plus explicit config:
 *  - implicit scopes (default memory:read + integrations:read) for every verified user, on their own tenant;
 *  - procmem scopes present in `scope`/`scp` (Okta custom scopes) or `permissions` (WorkOS RBAC);
 *  - PROCMEM_ROLE_SCOPES mapping applied to `role`/`roles`;
 *  - PROCMEM_ADMIN_SUBJECTS -> memory:build + traces:write.
 * Raw token scopes are kept so AUTH_REQUIRED_SCOPES can still be enforced.
 */
export function effectiveScopes(config: AuthConfig, payload: Record<string, unknown>, tokenScopes: readonly string[]): string[] {
  const out = new Set<string>(tokenScopes);
  for (const s of config.implicitScopes) out.add(s);
  for (const s of [...strings(payload.scp), ...strings(payload.permissions)]) if (isScope(s)) out.add(s);
  const roles = [...strings(payload.roles), ...(typeof payload.role === "string" ? [payload.role] : [])];
  for (const role of roles) for (const s of config.roleScopes[role] ?? []) out.add(s);
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  if (sub !== undefined && config.adminSubjects.includes(sub)) for (const s of ADMIN_SCOPES) out.add(s);
  return [...out];
}

/**
 * Token verifier bound to the canonical MCP resource:
 *  - JWTs: signature via JWKS, `iss`, `exp`, `sub`, and resource binding
 *    (`aud`/`resource` must equal the resource URL, or the configured audience),
 *    asymmetric algorithms only (delegated to mcp-use `createJwtVerifier`).
 *  - Effective scopes from {@link effectiveScopes}.
 *  - Static keys (`pmk_…`) only when `allowStatic`.
 */
export function createProcmemVerifier(config: AuthConfig, resource: URL, options: { allowStatic: boolean }): OAuthTokenVerifier {
  const jwt = innerJwtVerifier(config, resource);

  return {
    async verifyAccessToken(token: string): Promise<OAuthAuthInfo> {
      if (looksLikeStaticKey(token)) {
        if (!options.allowStatic) throw invalidToken("Static keys are not accepted on this endpoint");
        const record = matchStaticKey(config.staticKeys, token);
        if (!record) throw invalidToken("Unknown static key");
        return {
          token,
          clientId: `static:${record.id}`,
          scopes: [...record.scopes],
          // Static keys do not expire; report a short horizon so callers re-check per request.
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          resource,
          extra: {
            [STATIC_MARK]: true,
            payload: { iss: STATIC_ISSUER, sub: `static:${record.id}`, procmem_tenant: record.tenantNs },
          },
        };
      }
      if (!jwt) throw invalidToken("Bearer JWTs are not accepted: no OAuth provider configured");
      const info = await jwt.verifyAccessToken(token);
      const payload = (info.extra?.payload ?? {}) as Record<string, unknown>;
      return { ...info, scopes: effectiveScopes(config, payload, info.scopes) };
    },
  };
}

/** Map verified AuthInfo into the procmem identity (tenant namespace derived here). */
export function userFromAuthInfo(config: AuthConfig, authInfo: OAuthAuthInfo): ProcmemUser {
  const extra = (authInfo.extra ?? {}) as Record<string, unknown>;
  const payload = (extra.payload ?? {}) as Record<string, unknown>;
  if (extra[STATIC_MARK] === true) {
    const tenantNs = str(payload.procmem_tenant);
    const sub = str(payload.sub);
    if (!tenantNs || !sub) throw invalidToken("Static key identity is incomplete");
    return { id: sub, provider: "static", issuer: STATIC_ISSUER, tenantNs, roles: [] };
  }
  const sub = str(payload.sub);
  const iss = str(payload.iss);
  if (!sub || !iss) throw invalidToken("Token is missing sub or iss");
  const tenantClaim = config.mode === "oidc" ? (config.oidc?.tenantClaim ?? "org_id") : "org_id";
  const organizationId = str(payload[tenantClaim]);
  const email = str(payload.email);
  const provider: AuthProviderKind = config.mode === "workos" ? "workos" : "oidc";
  return {
    id: sub,
    provider,
    issuer: iss,
    tenantNs: tenantNsFor(iss, { subject: sub, organizationId }),
    ...(organizationId !== undefined && { organizationId }),
    ...(email !== undefined && { email }),
    roles: strings(payload.roles),
  };
}

const verifierCache = new WeakMap<AuthConfig, Map<string, OAuthTokenVerifier>>();

/** Cached verifier (keeps the JWKS cache warm across HTTP requests). */
export function cachedVerifier(config: AuthConfig, resource: URL, allowStatic: boolean): OAuthTokenVerifier {
  let byResource = verifierCache.get(config);
  if (!byResource) {
    byResource = new Map();
    verifierCache.set(config, byResource);
  }
  const key = `${allowStatic ? "s" : "-"}|${resource.href}`;
  let verifier = byResource.get(key);
  if (!verifier) {
    verifier = createProcmemVerifier(config, resource, { allowStatic });
    byResource.set(key, verifier);
  }
  return verifier;
}
