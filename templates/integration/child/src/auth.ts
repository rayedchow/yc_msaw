import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Bearer verification for this child MCP (host-owned contract; keep in sync with
 * src/integrations/child-auth.ts in the parent product). Tokens are EdDSA JWTs minted
 * by the parent MCP for an authenticated customer principal. Configured by the host
 * publisher via CHILD_AUTH_PUBLIC_JWK / CHILD_AUTH_ISSUER / CHILD_AUTH_AUDIENCE.
 */
export interface ChildAuthConfig {
  key: KeyObject;
  issuer: string;
  audience: string;
}

export function childAuthFromEnv(env: NodeJS.ProcessEnv = process.env): ChildAuthConfig | null {
  if (!env.CHILD_AUTH_PUBLIC_JWK) return null;
  if (!env.CHILD_AUTH_ISSUER || !env.CHILD_AUTH_AUDIENCE) throw new Error("CHILD_AUTH_ISSUER and CHILD_AUTH_AUDIENCE are required with CHILD_AUTH_PUBLIC_JWK");
  const key = createPublicKey({ key: JSON.parse(env.CHILD_AUTH_PUBLIC_JWK), format: "jwk" });
  return { key, issuer: env.CHILD_AUTH_ISSUER, audience: env.CHILD_AUTH_AUDIENCE };
}

export function verifyBearer(cfg: ChildAuthConfig, authorization: string | undefined, nowMs = Date.now()): { ok: true; subject: string } | { ok: false; reason: string } {
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!m) return { ok: false, reason: "missing_bearer" };
  const [h, p, s] = m[1]!.split(".") as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "EdDSA") return { ok: false, reason: "alg" };
  if (!verify(null, Buffer.from(`${h}.${p}`), cfg.key, Buffer.from(s, "base64url"))) return { ok: false, reason: "signature" };
  const now = Math.floor(nowMs / 1000);
  if (claims.iss !== cfg.issuer) return { ok: false, reason: "issuer" };
  if (claims.aud !== cfg.audience) return { ok: false, reason: "audience" };
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > now + 5) return { ok: false, reason: "not_yet_valid" };
  if (typeof claims.iat !== "number" || claims.exp - claims.iat > 3600) return { ok: false, reason: "lifetime" };
  if (claims.scope !== "integration:call") return { ok: false, reason: "scope" };
  return { ok: true, subject: String(claims.sub ?? "") };
}
