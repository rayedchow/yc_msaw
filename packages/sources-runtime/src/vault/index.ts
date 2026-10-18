/**
 * Token vault - the module boundary that sees plaintext provider tokens.
 *
 * Everything else in the codebase should ask the vault for an access token
 * (or call a vault helper that proxies the provider call) instead of reading
 * `integration_tokens` directly. This module is designed to be promoted to a
 * separate service (with its own `_credentials` API scope) when enterprise
 * attestation demands it - see docs/aws-architecture.md.
 */

import { getGoogleAccessToken } from "./google-auth.js";
import { getToken } from "./tokens.js";

export {
  decrypt,
  encrypt,
} from "./encryption.js";
export {
  deleteToken,
  getToken,
  getTokenFull,
  getTokenMetadata,
  getTokenWithMetadata,
  mergeTokenMetadata,
  storeToken,
  updateTokenMetadata,
} from "./tokens.js";
export * from "./google-auth.js";
export * from "./google-rate-limit.js";
export * from "./redaction.js";

/**
 * Resolve a live access token for (tenant, provider).
 *
 * Google resolves through domain-wide delegation (minting a fresh delegated
 * token); other providers decrypt the stored OAuth token. Refresh flows hang
 * off this single entry point as they land per provider.
 */
export async function getAccessToken(
  tenantId: string,
  provider: string,
  options: { scopes?: readonly string[] } = {},
): Promise<string | null> {
  if (provider === "google") {
    return getGoogleAccessToken(tenantId, undefined, options.scopes);
  }
  return getToken(tenantId, provider);
}
