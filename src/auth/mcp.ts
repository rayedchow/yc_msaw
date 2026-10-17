import { oauthCustomProvider, type OAuthMetadata, type OAuthProvider } from "mcp-use/oauth";
import { oauthWorkOSProvider } from "mcp-use/oauth/workos";
import type { AuthConfig } from "./config.js";
import { ALL_SCOPES } from "./scopes.js";
import { tenantNsFor } from "./tenant.js";
import { createProcmemVerifier, STATIC_ISSUER, userFromAuthInfo, type AuthProviderKind, type ProcmemUser } from "./verifier.js";

export interface Principal {
  /** Token subject (`sub`), or `static:<keyId>` for static keys, `anonymous` in none mode. */
  subject: string;
  /** Storage namespace for this caller; matches /^[a-z0-9][a-z0-9-]{0,79}$/. */
  tenantNs: string;
  /** Effective scopes (token scopes ∪ permissions ∪ implicit scopes, or the static key's scopes). */
  scopes: string[];
  provider: AuthProviderKind;
  issuer: string;
  organizationId?: string;
  clientId?: string;
  email?: string;
}

const RESOURCE_NAME = "procmem";

function resourceOptions(config: AuthConfig) {
  return {
    resourceName: RESOURCE_NAME,
    ...(config.resourceUrl !== undefined && { resource: config.resourceUrl }),
    ...(config.requiredScopes.length > 0 && { requiredScopes: config.requiredScopes }),
    ...(config.scopesSupported !== undefined && { scopesSupported: config.scopesSupported }),
  };
}

function oidcMetadata(config: AuthConfig): OAuthMetadata {
  const oidc = config.oidc;
  if (!oidc) throw new Error("oidc config missing");
  if (!oidc.authorizationEndpoint || !oidc.tokenEndpoint || !oidc.jwksUrl) {
    throw new Error(
      "OIDC metadata is unresolved: create the config with `await loadAuthConfig()` (discovery) " +
        "or set OIDC_JWKS_URL, OIDC_AUTHORIZATION_ENDPOINT and OIDC_TOKEN_ENDPOINT",
    );
  }
  return {
    issuer: oidc.issuer,
    authorization_endpoint: oidc.authorizationEndpoint,
    token_endpoint: oidc.tokenEndpoint,
    jwks_uri: oidc.jwksUrl,
    ...(oidc.registrationEndpoint !== undefined && { registration_endpoint: oidc.registrationEndpoint }),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    ...(config.scopesSupported !== undefined && { scopes_supported: config.scopesSupported }),
  };
}

/**
 * Build the mcp-use `oauth` provider for `new MCPServer({ oauth, basePath: config.basePath })`.
 *
 * - workos: AuthKit metadata from mcp-use's `oauthWorkOSProvider` (issuer
 *   `https://<domain>`, JWKS `/oauth2/jwks`, registration `/oauth2/register`),
 *   with procmem's verifier (resource-bound aud, scope/permission merge,
 *   optional static keys) and identity mapping.
 * - oidc (Okta etc.): `oauthCustomProvider` + `createJwtVerifier` against the
 *   discovered issuer/JWKS.
 * - static / none: `undefined` (no OAuth gate; `assertSafeStartup` restricts
 *   those modes to loopback).
 */
export function buildMcpOAuth(config: AuthConfig): OAuthProvider<ProcmemUser> | undefined {
  if (config.mode !== "workos" && config.mode !== "oidc") return undefined;
  const allowStatic = config.staticKeysOnMcp && config.staticKeys.length > 0;
  let metadata: OAuthMetadata;
  if (config.mode === "workos") {
    const workos = config.workos;
    if (!workos) throw new Error("workos config missing");
    // Reuse mcp-use's WorkOS AuthKit metadata (validates the domain, https only).
    metadata = oauthWorkOSProvider({ subdomain: workos.domain }).oauthMetadata;
  } else {
    metadata = oidcMetadata(config);
  }
  return oauthCustomProvider<ProcmemUser>({
    ...resourceOptions(config),
    oauthMetadata: metadata,
    createTokenVerifier: (resource) => createProcmemVerifier(config, resource, { allowStatic }),
    mapAuthInfo: (authInfo) => {
      const user = userFromAuthInfo(config, authInfo);
      const payload = ((authInfo.extra ?? {}) as Record<string, unknown>).payload as Record<string, unknown> | undefined;
      return { user, payload: payload ?? {}, permissions: [...authInfo.scopes] };
    },
  });
}

/** Minimal shape of mcp-use `ctx.auth` (OAuthAuth<TUser>). */
export interface CtxAuthLike {
  user: unknown;
  payload: Record<string, unknown>;
  scopes: string[];
  clientId?: string | undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Turn an mcp-use `ctx.auth` into a principal. When `ctxAuth` is undefined
 * (no OAuth provider), returns the loopback dev principal only if
 * `config.mode === "none"`; otherwise throws.
 */
export function principalFromAuth(ctxAuth: CtxAuthLike | undefined, config?: AuthConfig): Principal {
  if (!ctxAuth) {
    if (config?.mode === "none") {
      return { subject: "anonymous", tenantNs: config.devTenantNs, scopes: [...ALL_SCOPES], provider: "none", issuer: "urn:procmem:none" };
    }
    throw new Error("Unauthenticated: no verified identity on this request");
  }
  const user = (ctxAuth.user ?? {}) as Partial<ProcmemUser>;
  const payload = ctxAuth.payload ?? {};
  const clientId = ctxAuth.clientId ? { clientId: ctxAuth.clientId } : {};
  if (typeof user.tenantNs === "string" && typeof user.id === "string" && typeof user.provider === "string") {
    return {
      subject: user.id,
      tenantNs: user.tenantNs,
      scopes: [...ctxAuth.scopes],
      provider: user.provider,
      issuer: user.issuer ?? str(payload.iss) ?? "",
      ...(user.organizationId !== undefined && { organizationId: user.organizationId }),
      ...(user.email !== undefined && { email: user.email }),
      ...clientId,
    };
  }
  // Fallback for providers not built by buildMcpOAuth (e.g. plain oauthWorkOSProvider).
  const iss = str(payload.iss);
  const sub = str(payload.sub);
  if (!iss || !sub || iss === STATIC_ISSUER) throw new Error("Unauthenticated: token lacks iss/sub");
  const organizationId = str(payload.org_id) ?? str((user as { organizationId?: unknown }).organizationId);
  return {
    subject: sub,
    tenantNs: tenantNsFor(iss, { subject: sub, organizationId }),
    scopes: [...ctxAuth.scopes],
    provider: "oidc",
    issuer: iss,
    ...(organizationId !== undefined && { organizationId }),
    ...clientId,
  };
}

/**
 * `securitySchemes` for a tool requiring `scopes`. Returns undefined when no
 * OAuth provider is configured, since mcp-use rejects `oauth2` schemes then.
 *
 * Returns undefined as well when every requested scope is host-implicit.
 * Scopes the host grants implicitly to every verified user (AUTH_IMPLICIT_SCOPES,
 * default memory:read + integrations:read) are NOT advertised to OAuth clients:
 * providers such as WorkOS AuthKit only issue OIDC scopes, so asking clients to
 * request them would make consent fail. The scheme still requires OAuth, and the
 * server enforces the full scope on every call via the verified principal
 * (requireScope), which also covers static keys that lack it.
 */
export function toolSecuritySchemes(config: AuthConfig, ...scopes: string[]): readonly [{ type: "oauth2"; scopes: string[] }] | undefined {
  if (config.mode !== "workos" && config.mode !== "oidc") return undefined;
  const implicit = new Set(config.implicitScopes);
  const advertised = scopes.filter((s) => !implicit.has(s));
  // With nothing left to advertise, omit the scheme: mcp-use then applies the provider's
  // default (OAuth required, no extra scope), and it rejects oauth2 schemes with empty scopes.
  if (advertised.length === 0) return undefined;
  return [{ type: "oauth2", scopes: advertised }] as const;
}
