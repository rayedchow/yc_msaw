import { sql } from "drizzle-orm";
import type { AccountOwner, DbExecutor, SourceProviderModule } from "../../core/types.js";
import { registerGoogleAuthInternalRoutes, registerGoogleAuthPublicRoutes } from "./routes.js";
import { GOOGLE_AUTH_PROVIDER_ID, googleAuthCoverage } from "./status.js";

/**
 * Google provider grants (credential lane, no data of its own).
 *
 * Owns the per-(tenant, account) Google auth mode - domain-wide delegation
 * inside an operator-approved allowlist, direct per-user OAuth, or the optional
 * Composio proxy - plus the setup API and browser callbacks. The gmail,
 * google-docs, calendar and contacts modules consume it through
 * vault/google-auth.ts getGoogleAccessToken / getGoogleApiCredential.
 */
export const googleAuthProvider: SourceProviderModule = {
  id: GOOGLE_AUTH_PROVIDER_ID,
  eventSources: [],
  mirrorRoots: [],
  coverage: (ctx) => googleAuthCoverage(ctx.tenantId, ctx.executor),
  accountOwners: (ctx) => googleAccountOwners(ctx.tenantId, ctx.executor),
  publicRoutes: (app) => registerGoogleAuthPublicRoutes(app),
  internalRoutes: (app, deps) => registerGoogleAuthInternalRoutes(app, deps),
};

/** Unattributed Google data (a donor tenant-wide connection without a mailbox) is reported under this name. */
export const GOOGLE_UNATTRIBUTED_ACCOUNT = "unattributed@google.invalid";

/**
 * Every Google address of the tenant (connections and grants) with the yc_msaw principal that started its
 * newest OAuth/Composio grant. The callback refused any Google account other than the expected one, so that
 * subject proved control of the address. Domain-wide-delegation-only mailboxes have no subject.
 */
export async function googleAccountOwners(tenantId: string, executor: DbExecutor): Promise<AccountOwner[]> {
  const res = (await executor.execute(sql`
    WITH accounts AS (
      SELECT lower(external_account_id) AS email FROM connections
       WHERE tenant_id = ${tenantId} AND provider = 'google' AND external_account_id IS NOT NULL AND external_account_id <> ''
      UNION
      SELECT account_email FROM google_oauth_grants WHERE tenant_id = ${tenantId}
    )
    SELECT a.email, g.connected_by_subject AS subject, g.connected_by_issuer AS issuer
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT connected_by_subject, connected_by_issuer FROM google_oauth_grants
       WHERE tenant_id = ${tenantId} AND account_email = a.email
       ORDER BY updated_at DESC NULLS LAST LIMIT 1
    ) g ON true
    UNION ALL
    SELECT ${GOOGLE_UNATTRIBUTED_ACCOUNT}, NULL, NULL
     WHERE EXISTS (SELECT 1 FROM connections WHERE tenant_id = ${tenantId} AND provider = 'google'
                    AND (external_account_id IS NULL OR external_account_id = ''))
  `)) as unknown as { rows?: Array<{ email: string; subject: string | null; issuer: string | null }> } | Array<{ email: string; subject: string | null; issuer: string | null }>;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.map((r) => ({ account: String(r.email), subject: r.subject ?? null, issuer: r.issuer ?? null }));
}
