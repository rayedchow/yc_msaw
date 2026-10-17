import { OAuthError } from "mcp-use/oauth";
import type { AuthConfig } from "./config.js";
import { principalFromAuth, type Principal } from "./mcp.js";
import { matchStaticKey, looksLikeStaticKey } from "./static-keys.js";
import { cachedVerifier, userFromAuthInfo } from "./verifier.js";

/** RFC 9728 metadata URL for a resource: `<origin>/.well-known/oauth-protected-resource<path>`. */
export function protectedResourceMetadataUrl(resource: string | URL): string {
  const url = new URL(resource);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path === "/" ? "" : path}`;
}

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&").replace(/[\r\n]/g, " ")}"`;
}

export interface ChallengeOptions {
  status: 401 | 403;
  error: "invalid_token" | "insufficient_scope" | "invalid_request";
  description: string;
  scope?: string;
  resource?: string | URL | undefined;
}

/** RFC 6750 bearer challenge with RFC 9728 `resource_metadata`. */
export function bearerChallenge(options: ChallengeOptions): Response {
  const params = [`error=${quote(options.error)}`, `error_description=${quote(options.description)}`];
  if (options.scope) params.push(`scope=${quote(options.scope)}`);
  if (options.resource !== undefined) params.push(`resource_metadata=${quote(protectedResourceMetadataUrl(options.resource))}`);
  return Response.json(
    { error: options.error, error_description: options.description },
    {
      status: options.status,
      headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}`, "Cache-Control": "no-store" },
    },
  );
}

export interface AuthenticateHttpOptions {
  /**
   * Canonical MCP resource URL the OAuth tokens are bound to (defaults to
   * `config.resourceUrl`). Needed for local listeners where MCP_PUBLIC_URL is unset.
   */
  resource?: string | URL;
}

/**
 * Authenticate a non-MCP HTTP request (trace ingest, admin build trigger).
 *
 * Accepts `Authorization: Bearer <token>` where token is either an OAuth
 * access token from the configured issuer (same checks and audience binding
 * as the MCP endpoint) or a static key (`pmk_…`, constant-time hash compare).
 * Returns the principal, or a ready-to-send 401/403 Response with a
 * `WWW-Authenticate` challenge.
 *
 * In `none` mode (loopback only) a request without credentials gets the
 * anonymous dev principal.
 */
export async function authenticateHttp(
  request: Request,
  config: AuthConfig,
  requiredScope: string | readonly string[] | undefined,
  options: AuthenticateHttpOptions = {},
): Promise<Principal | Response> {
  const required = requiredScope === undefined ? [] : typeof requiredScope === "string" ? [requiredScope] : [...requiredScope];
  const resource = options.resource ?? config.resourceUrl;
  const scope = required.join(" ") || undefined;
  const header = request.headers.get("authorization");

  let principal: Principal;
  if (header === null || header.trim() === "") {
    if (config.mode === "none") {
      principal = principalFromAuth(undefined, config);
    } else {
      return bearerChallenge({ status: 401, error: "invalid_token", description: "Authentication is required", scope, resource });
    }
  } else {
    const match = /^Bearer[ ]+([^\s]+)\s*$/i.exec(header);
    const token = match?.[1];
    if (!token) {
      return bearerChallenge({ status: 401, error: "invalid_request", description: "Expected Authorization: Bearer <token>", scope, resource });
    }
    if (looksLikeStaticKey(token)) {
      const record = matchStaticKey(config.staticKeys, token);
      if (!record) return bearerChallenge({ status: 401, error: "invalid_token", description: "Invalid static key", scope, resource });
      principal = {
        subject: `static:${record.id}`,
        tenantNs: record.tenantNs,
        scopes: [...record.scopes],
        provider: "static",
        issuer: "urn:procmem:static",
      };
    } else {
      if (config.mode !== "workos" && config.mode !== "oidc") {
        return bearerChallenge({ status: 401, error: "invalid_token", description: "OAuth tokens are not accepted (no OAuth provider configured)", scope, resource });
      }
      if (resource === undefined) {
        throw new Error("authenticateHttp: OAuth resource URL unknown; set MCP_PUBLIC_URL or pass options.resource");
      }
      try {
        const info = await cachedVerifier(config, new URL(resource), false).verifyAccessToken(token);
        const user = userFromAuthInfo(config, info);
        principal = {
          subject: user.id,
          tenantNs: user.tenantNs,
          scopes: [...info.scopes],
          provider: user.provider,
          issuer: user.issuer,
          ...(user.organizationId !== undefined && { organizationId: user.organizationId }),
          ...(user.email !== undefined && { email: user.email }),
          ...(info.clientId ? { clientId: info.clientId } : {}),
        };
      } catch (error) {
        if (error instanceof OAuthError) {
          return bearerChallenge({ status: 401, error: "invalid_token", description: error.message || "Invalid access token", scope, resource });
        }
        throw error;
      }
    }
  }

  const missing = required.filter((s) => !principal.scopes.includes(s));
  if (missing.length > 0) {
    return bearerChallenge({
      status: 403,
      error: "insufficient_scope",
      description: `Missing required scope: ${missing.join(" ")}`,
      scope,
      resource,
    });
  }
  return principal;
}
