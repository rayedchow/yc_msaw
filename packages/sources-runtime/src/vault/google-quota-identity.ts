import { createHash } from "node:crypto";

/**
 * Which Google quota unit an access token draws on.
 *
 * Google's per-user quota belongs to the account reached through a credential (service account, OAuth client), not
 * to one access token: DWD tokens are re-minted after a restart and OAuth tokens rotate at expiry. getGoogleApiCredential
 * registers every bearer it hands out with its `quotaUser` (googleQuotaUser), so callers that only hold the bearer (the
 * legacy gFetch) can key a per-user cooldown by the stable unit. Tokens are kept only as a sha256 prefix; bounded.
 */
const MAX_ENTRIES = 10_000;
const quotaUserByToken = new Map<string, string>();

function tokenKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 32);
}

export function noteGoogleTokenQuotaUser(accessToken: string, quotaUser: string): void {
  const key = tokenKey(accessToken);
  quotaUserByToken.delete(key);
  quotaUserByToken.set(key, quotaUser);
  if (quotaUserByToken.size > MAX_ENTRIES) quotaUserByToken.delete(quotaUserByToken.keys().next().value!);
}

/** The quota unit of a bearer this process obtained from getGoogleApiCredential, or null when unknown. */
export function googleQuotaUserForToken(accessToken: string): string | null {
  return quotaUserByToken.get(tokenKey(accessToken)) ?? null;
}

export function resetGoogleTokenQuotaUsersForTests(): void {
  quotaUserByToken.clear();
}
