import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { sha256 } from "../util.js";
import { assertSlug } from "./paths.js";
import { IntegrationError } from "./types.js";

/**
 * Access tokens for deployed child integration MCPs.
 *
 * The parent (customer-facing, WorkOS-authenticated) MCP mints short-lived EdDSA
 * JWTs for an authenticated principal; each child verifies them offline with the
 * PUBLIC key the host publisher configured as CHILD_AUTH_PUBLIC_JWK. Claims:
 *   iss = INTEGRATION_CHILD_ISSUER, aud = urn:procmem:integration:<ns>:<slug>,
 *   sub = caller subject, tenant = ns, scope = "integration:call", iat/nbf/exp (<=1h), jti.
 * Audience is per tenant+integration, so a token for one child is rejected by every
 * other child. The private key never leaves the host (no sandbox/model/child sees it).
 */
export interface ChildAuthKeys {
  issuer: string;
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
}

export const DEFAULT_CHILD_ISSUER = "procmem-parent";
export const MAX_CHILD_TOKEN_TTL_S = 3600;

function keysFromPrivate(privateKey: KeyObject, issuer: string): ChildAuthKeys {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new IntegrationError("child_auth_invalid_key", "Child signing key must be Ed25519");
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" }) as JsonWebKey;
  const kid = sha256(`${publicJwk.kty}|${publicJwk.crv}|${publicJwk.x}`).slice(0, 16);
  return { issuer, kid, privateKey, publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, kid, alg: "EdDSA", use: "sig" } as JsonWebKey };
}

export function generateChildAuthKeys(issuer = DEFAULT_CHILD_ISSUER): ChildAuthKeys {
  return keysFromPrivate(generateKeyPairSync("ed25519").privateKey, issuer);
}

/** Private JWK (with "d") for persisting in a host secret store. */
export function exportChildSigningJwk(keys: ChildAuthKeys): string {
  return JSON.stringify(keys.privateKey.export({ format: "jwk" }));
}

/** INTEGRATION_CHILD_SIGNING_JWK (private Ed25519 JWK) + INTEGRATION_CHILD_ISSUER. Null when unset. */
export function loadChildAuthFromEnv(env: NodeJS.ProcessEnv = process.env): ChildAuthKeys | null {
  const raw = env.INTEGRATION_CHILD_SIGNING_JWK;
  if (!raw) return null;
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw new IntegrationError("child_auth_invalid_key", "INTEGRATION_CHILD_SIGNING_JWK is not valid JSON");
  }
  if (!jwk.d) throw new IntegrationError("child_auth_invalid_key", "INTEGRATION_CHILD_SIGNING_JWK must be a private JWK");
  return keysFromPrivate(createPrivateKey({ key: jwk as import("node:crypto").JsonWebKey, format: "jwk" }), env.INTEGRATION_CHILD_ISSUER || DEFAULT_CHILD_ISSUER);
}

export function childAudience(ns: string, slug: string): string {
  return `urn:procmem:integration:${ns}:${assertSlug(slug)}`;
}

/** Env the publisher configures on the child (all public values). */
export function childAuthEnv(keys: ChildAuthKeys, ns: string, slug: string): Record<string, string> {
  return { CHILD_AUTH_PUBLIC_JWK: JSON.stringify(keys.publicJwk), CHILD_AUTH_ISSUER: keys.issuer, CHILD_AUTH_AUDIENCE: childAudience(ns, slug) };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function mintChildToken(keys: ChildAuthKeys, p: { ns: string; slug: string; subject: string; ttlSeconds?: number; now?: Date }): { token: string; expiresAt: string; audience: string; jti: string } {
  const ttl = Math.min(Math.max(Math.floor(p.ttlSeconds ?? 900), 30), MAX_CHILD_TOKEN_TTL_S);
  if (!p.subject || p.subject.length > 256) throw new IntegrationError("invalid_subject", "Token subject is required");
  const iat = Math.floor((p.now ?? new Date()).getTime() / 1000);
  const jti = randomUUID();
  const audience = childAudience(p.ns, p.slug);
  const header = { alg: "EdDSA", typ: "JWT", kid: keys.kid };
  const claims = { iss: keys.issuer, aud: audience, sub: p.subject, tenant: p.ns, scope: "integration:call", iat, nbf: iat - 5, exp: iat + ttl, jti };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = sign(null, Buffer.from(input), keys.privateKey);
  return { token: `${input}.${b64u(sig)}`, expiresAt: new Date((iat + ttl) * 1000).toISOString(), audience, jti };
}

/** Reference verifier (same rules as templates/integration/child/src/auth.ts). */
export function verifyChildToken(publicJwk: JsonWebKey, token: string, expect: { issuer: string; audience: string; now?: Date }): { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "EdDSA") return { ok: false, reason: "alg" };
  const key = createPublicKey({ key: publicJwk as import("node:crypto").JsonWebKey, format: "jwk" });
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"))) return { ok: false, reason: "signature" };
  const now = Math.floor((expect.now ?? new Date()).getTime() / 1000);
  if (claims.iss !== expect.issuer) return { ok: false, reason: "issuer" };
  if (claims.aud !== expect.audience) return { ok: false, reason: "audience" };
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > now + 5) return { ok: false, reason: "not_yet_valid" };
  if (typeof claims.iat !== "number" || claims.exp - claims.iat > MAX_CHILD_TOKEN_TTL_S) return { ok: false, reason: "lifetime" };
  if (claims.scope !== "integration:call") return { ok: false, reason: "scope" };
  return { ok: true, claims };
}
