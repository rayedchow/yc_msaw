/**
 * Local mock OAuth authorization server for tests: RS256 key pair, JWKS,
 * RFC 8414 + OIDC discovery metadata on 127.0.0.1:<ephemeral>, and token
 * minting with arbitrary claims (including expired / wrong-aud / wrong-iss /
 * bad-signature variants).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface MintOptions {
  sub?: string;
  /** Audience; usually the MCP resource URL. */
  aud?: string | string[];
  /** Override issuer (wrong-iss variant). */
  iss?: string;
  /** Space-delimited scope claim. */
  scope?: string;
  /** Lifetime in seconds; negative mints an already-expired token. Default 300. */
  expiresIn?: number;
  /** Sign with an unrelated key that reuses the published kid. */
  badSignature?: boolean;
  /** Omit the exp claim. */
  noExp?: boolean;
  /** Additional claims (org_id, permissions, scp, resource, ...). */
  claims?: Record<string, unknown>;
}

export interface MockIssuer {
  issuer: string;
  jwksUrl: string;
  /** Number of JWKS fetches served (to assert caching/reachability). */
  readonly jwksHits: number;
  mint(options?: MintOptions): Promise<string>;
  close(): Promise<void>;
}

export interface MockIssuerOptions {
  /** Issuer path, e.g. "/oauth2/default" to mimic an Okta custom authorization server. */
  path?: string;
}

export async function startMockIssuer(options: MockIssuerOptions = {}): Promise<MockIssuer> {
  const alg = "RS256";
  const kid = "mock-key-1";
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const attacker = await generateKeyPair(alg, { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  const path = (options.path ?? "").replace(/\/+$/, "");
  let jwksHits = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const p = url.pathname;
    if (
      p === `${path}/.well-known/openid-configuration` ||
      p === `/.well-known/oauth-authorization-server${path}` ||
      p === `${path}/.well-known/oauth-authorization-server`
    ) {
      return send(200, metadata());
    }
    if (p === `${path}/jwks`) {
      jwksHits++;
      return send(200, { keys: [jwk] });
    }
    if (p === `${path}/authorize` || p === `${path}/token` || p === `${path}/register`) {
      return send(400, { error: "unsupported", error_description: "mock issuer does not run interactive flows" });
    }
    return send(404, { error: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}${path}`;
  const jwksUrl = `${issuer}/jwks`;

  function metadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      jwks_uri: jwksUrl,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [alg],
    };
  }

  return {
    issuer,
    jwksUrl,
    get jwksHits() {
      return jwksHits;
    },
    async mint(o: MintOptions = {}) {
      const now = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT({ ...(o.scope !== undefined && { scope: o.scope }), ...o.claims })
        .setProtectedHeader({ alg, kid, typ: "at+jwt" })
        .setIssuer(o.iss ?? issuer)
        .setSubject(o.sub ?? "user_mock")
        .setIssuedAt(o.expiresIn !== undefined && o.expiresIn < 0 ? now + o.expiresIn - 60 : now)
        .setJti(Math.random().toString(36).slice(2));
      if (o.aud !== undefined) jwt.setAudience(o.aud);
      if (!o.noExp) jwt.setExpirationTime(now + (o.expiresIn ?? 300));
      return jwt.sign(o.badSignature ? attacker.privateKey : privateKey);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
