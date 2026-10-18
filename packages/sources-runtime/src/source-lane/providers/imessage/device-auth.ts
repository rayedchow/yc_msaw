import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Device credentials of the Mac iMessage uploader.
 *
 * yc_msaw is the authority. Its device setup route mints a `kind=device`,
 * `transport=runtime-ingest` source binding (providers ["imessage"]) whose token is
 * `psb_<tenantNs>.<bindingId>.<secret>`, and hands the Mac the same secret in the uploader's
 * own token family, `gimsg_<tenantNs>.<bindingId>.<secret>` (the bundled uploader only
 * requires a non-empty `agentToken` string and sends it as `x-api-key`). The runtime receives
 * only sha256(key) at enrolment.
 *
 * Every uploader request (public routes, routes.ts) passes two checks, both fail closed:
 *   1. an active imessage_devices row of the key's tenant/binding whose hash matches in
 *      constant time (revoked here when yc_msaw forwards the binding revoke);
 *   2. yc_msaw confirms the key is still an active device binding of that tenant
 *      (authority.ts; read per request, so a revoke in yc_msaw applies on the next request
 *      even if the forwarded runtime revoke was lost). A refusal also revokes the row here.
 * The tenant is the one inside the key and confirmed by yc_msaw; no body field can change it.
 * The key never authorizes MCP, admin or publish routes (yc_msaw refuses runtime-ingest
 * device bindings on publish).
 */

export const DEVICE_KEY_PREFIX = "gimsg_";
export const BINDING_TOKEN_PREFIX = "psb_";
export const DEVICE_KEY_HEADER = "x-api-key";

const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const BINDING_ID_RE = /^sb-[0-9a-f]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export interface DeviceKeyParts {
  tenantNs: string;
  bindingId: string;
}

export function isBindingId(value: unknown): value is string {
  return typeof value === "string" && BINDING_ID_RE.test(value);
}

export function isTokenSha256(value: unknown): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Parse `gimsg_<tenantNs>.<bindingId>.<secret>`; null for anything else (including the donor's opaque gimsg_ tokens). */
export function parseDeviceKey(key: string | null | undefined): DeviceKeyParts | null {
  if (typeof key !== "string" || !key.startsWith(DEVICE_KEY_PREFIX) || key.length > 200) return null;
  const parts = key.slice(DEVICE_KEY_PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  const [tenantNs, bindingId, secret] = parts as [string, string, string];
  if (!TENANT_RE.test(tenantNs) || !BINDING_ID_RE.test(bindingId) || !SECRET_RE.test(secret)) return null;
  return { tenantNs, bindingId };
}

/** The compatible Mac key for a yc_msaw device binding token (same secret, uploader token family). */
export function deviceKeyForBindingToken(bindingToken: string): string {
  if (!bindingToken.startsWith(BINDING_TOKEN_PREFIX)) throw new Error("not a source binding token");
  const key = `${DEVICE_KEY_PREFIX}${bindingToken.slice(BINDING_TOKEN_PREFIX.length)}`;
  if (!parseDeviceKey(key)) throw new Error("source binding token does not have the psb_<tenant>.<binding>.<secret> shape");
  return key;
}

/** The yc_msaw binding token a device key corresponds to (yc_msaw verifies it with SourceBindings.verify). */
export function bindingTokenForDeviceKey(key: string): string | null {
  if (!parseDeviceKey(key)) return null;
  return `${BINDING_TOKEN_PREFIX}${key.slice(DEVICE_KEY_PREFIX.length)}`;
}

/** Constant-time comparison of sha256(key) with a stored hex digest. */
export function deviceKeyMatches(key: string, storedSha256: string | null | undefined): boolean {
  const presented = createHash("sha256").update(key, "utf8").digest();
  const expected = storedSha256 && SHA_RE.test(storedSha256) ? Buffer.from(storedSha256, "hex") : Buffer.alloc(32);
  return timingSafeEqual(presented, expected) && Boolean(storedSha256 && SHA_RE.test(storedSha256));
}
