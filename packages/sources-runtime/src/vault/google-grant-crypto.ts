import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { env } from "../env.js";

/**
 * Row-bound encryption for Google provider grants.
 *
 * Same primitive as vault/encryption.ts (AES-256-GCM, scrypt-derived key from
 * ENCRYPTION_KEY) but with a distinct key-derivation salt and additional
 * authenticated data naming the row and field the ciphertext belongs to. A
 * refresh token copied into another tenant's row (or into the access-token
 * column) fails authentication instead of decrypting.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const FORMAT = "g1";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY environment variable is required");
  cachedKey = scryptSync(env.ENCRYPTION_KEY, "procmem-google-grant-v1", 32);
  return cachedKey;
}

export function googleGrantAad(tenantId: string, accountEmail: string, field: "access_token" | "refresh_token"): string {
  return `procmem.google.grant.v1|${tenantId}|${accountEmail.trim().toLowerCase()}|${field}`;
}

export function googleStateAad(stateSha256: string, field: "pkce_verifier"): string {
  return `procmem.google.state.v1|${stateSha256}|${field}`;
}

export function encryptBound(plaintext: string, aad: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FORMAT}:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

/** Throws on any tampering, wrong AAD, wrong key or unknown format (never returns the input as plaintext). */
export function decryptBound(value: string, aad: string): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT) throw new Error("Google grant ciphertext has an unknown format");
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) throw new Error("Google grant ciphertext is malformed");
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
