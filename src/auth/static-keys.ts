import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isScope, type Scope } from "./scopes.js";
import { assertTenantNs } from "./tenant.js";

/** Raw static keys look like `pmk_<43 base64url chars>`; only their sha256 is configured. */
export const STATIC_KEY_PREFIX = "pmk_";
const STATIC_KEY_BODY = /^pmk_[A-Za-z0-9_-]{32,128}$/;

export interface StaticKeyRecord {
  /** Short public identifier (first 12 hex chars of the hash), safe to log. */
  id: string;
  /** sha256 of the raw key (32 bytes). */
  hash: Buffer;
  tenantNs: string;
  scopes: Scope[];
}

export function hashStaticKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export function looksLikeStaticKey(token: string): boolean {
  return token.startsWith(STATIC_KEY_PREFIX);
}

/**
 * Parse `PROCMEM_STATIC_KEYS`: comma/newline separated entries of
 * `<sha256hex>:<tenantNs>:<scope1>+<scope2>`.
 */
export function parseStaticKeys(value: string | undefined): StaticKeyRecord[] {
  if (value === undefined || value.trim() === "") return [];
  const records: StaticKeyRecord[] = [];
  const seen = new Set<string>();
  const entries = value
    .split(/[,\n]/)
    .map((e) => e.trim())
    .filter(Boolean);
  for (const [index, entry] of entries.entries()) {
    // Scopes themselves contain ":" (memory:read), so split only on the first two colons.
    const first = entry.indexOf(":");
    const second = first < 0 ? -1 : entry.indexOf(":", first + 1);
    if (first < 0 || second < 0) {
      throw new Error(`PROCMEM_STATIC_KEYS entry #${index + 1} must be <sha256hex>:<tenant>:<scope+scope>`);
    }
    const hashHex = entry.slice(0, first);
    const tenant = entry.slice(first + 1, second);
    const scopeList = entry.slice(second + 1);
    const hex = hashHex.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error(
        `PROCMEM_STATIC_KEYS entry #${index + 1}: first field must be the 64-char sha256 hex of the key (never the raw key)`,
      );
    }
    if (seen.has(hex)) throw new Error(`PROCMEM_STATIC_KEYS entry #${index + 1}: duplicate key hash`);
    seen.add(hex);
    assertTenantNs(tenant, `PROCMEM_STATIC_KEYS entry #${index + 1} tenant`);
    const scopes = scopeList.split("+").map((s) => s.trim()).filter(Boolean);
    if (scopes.length === 0) throw new Error(`PROCMEM_STATIC_KEYS entry #${index + 1}: at least one scope is required`);
    for (const s of scopes) {
      if (!isScope(s)) throw new Error(`PROCMEM_STATIC_KEYS entry #${index + 1}: unknown scope ${JSON.stringify(s)}`);
    }
    records.push({ id: hex.slice(0, 12), hash: Buffer.from(hex, "hex"), tenantNs: tenant, scopes: [...new Set(scopes)] as Scope[] });
  }
  return records;
}

/**
 * Constant-time lookup: the presented key is hashed once and compared against
 * every configured hash with `timingSafeEqual`, without early exit.
 */
export function matchStaticKey(records: readonly StaticKeyRecord[], presented: string): StaticKeyRecord | undefined {
  if (!STATIC_KEY_BODY.test(presented)) return undefined;
  const digest = createHash("sha256").update(presented, "utf8").digest();
  let found: StaticKeyRecord | undefined;
  for (const record of records) {
    if (timingSafeEqual(record.hash, digest) && found === undefined) found = record;
  }
  return found;
}

/** Generate a new random static key and its configuration entry. */
export function generateStaticKey(tenantNs: string, scopes: readonly Scope[]): { key: string; hash: string; entry: string } {
  assertTenantNs(tenantNs);
  for (const s of scopes) if (!isScope(s)) throw new Error(`unknown scope ${s}`);
  const key = `${STATIC_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const hash = hashStaticKey(key);
  return { key, hash, entry: `${hash}:${tenantNs}:${scopes.join("+")}` };
}
