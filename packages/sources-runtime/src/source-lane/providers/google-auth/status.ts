import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../../db/client.js";
import { listGoogleMailboxAccounts } from "../../../integrations/google/mailboxes.js";
import { googleWorkspaceDelegationSetup, isDelegationConfigured } from "../../../vault/google-auth.js";
import { isGoogleComposioConfigured } from "../../../vault/google-composio.js";
import { googleDwdPolicyFor, isGoogleDwdMailboxApproved, loadGoogleDwdPolicy } from "../../../vault/google-dwd-policy.js";
import {
  GOOGLE_OAUTH_CAPABILITY_SCOPES,
  isGoogleOAuthConfigured,
  missingGoogleScopes,
  rowsOf,
  type GoogleOAuthCapability,
  type GoogleOAuthGrantRow,
} from "../../../vault/google-oauth.js";
import type { CoverageReport, DbExecutor } from "../../core/types.js";

export const GOOGLE_AUTH_PROVIDER_ID = "google-auth";

/** What each mode can reach at all (independent of a particular grant). */
export const GOOGLE_AUTH_CAPABILITY_MATRIX = {
  domain_wide_delegation: {
    perUserData: "any mailbox inside the operator-approved domains, without per-user consent",
    tenantWideDirectory: true,
    gmailSettingsSharing: true,
    docsOtChangelog: "attempted (undocumented, writer+-gated; per-doc partial/blocked reported by google-docs)",
  },
  oauth_direct: {
    perUserData: "only the consenting account, only the scopes it granted",
    tenantWideDirectory: "only if a Workspace admin granted directory_admin",
    gmailSettingsSharing: false,
    docsOtChangelog: "attempted with the user's bearer (writer+-gated; not live-verified under 3LO)",
  },
  composio_proxy: {
    perUserData: "only the consenting account via Composio proxy; granted scopes are not reported by Composio",
    tenantWideDirectory: false,
    gmailSettingsSharing: false,
    docsOtChangelog: "blocked: ot_requires_bearer (Composio never exposes the bearer)",
  },
} as const;

type Executor = DbExecutor;

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return new Date(value).toISOString();
  return null;
}

function scopesOf(row: GoogleOAuthGrantRow): string[] {
  const v = row.granted_scopes;
  return Array.isArray(v) ? (v as string[]) : [];
}

async function grants(tenantId: string, executor: Executor): Promise<GoogleOAuthGrantRow[]> {
  return rowsOf<GoogleOAuthGrantRow>(await executor.execute(sql`
    SELECT * FROM google_oauth_grants WHERE tenant_id = ${tenantId} ORDER BY account_email
  `));
}

async function pendingAuthorizations(tenantId: string, executor: Executor): Promise<number> {
  const rows = rowsOf<{ n: number | string }>(await executor.execute(sql`
    SELECT count(*)::int AS n FROM google_oauth_states
    WHERE tenant_id = ${tenantId} AND consumed_at IS NULL AND expires_at > now()
  `));
  return Number(rows[0]?.n ?? 0);
}

async function dwdAdminEmail(tenantId: string, executor: Executor): Promise<string | null> {
  const rows = rowsOf<{ email: string | null; dwd: boolean | null }>(await executor.execute(sql`
    SELECT lower(metadata->>'email') AS email,
           (metadata->>'delegation' = 'true' OR metadata->>'authMode' = 'domain_wide_delegation') AS dwd
    FROM integration_tokens WHERE user_id = ${tenantId} AND provider = 'google'
  `));
  return rows[0]?.dwd ? rows[0].email : null;
}

/** Setup status for the internal API (no secrets: never ciphertexts, tokens or Composio link tokens). */
export async function googleAuthStatus(tenantId: string, executor: Executor = defaultDb) {
  const [accounts, grantRows, pending, admin] = await Promise.all([
    listGoogleMailboxAccounts(tenantId, executor),
    grants(tenantId, executor),
    pendingAuthorizations(tenantId, executor),
    dwdAdminEmail(tenantId, executor),
  ]);
  const policySet = loadGoogleDwdPolicy();
  const policy = googleDwdPolicyFor(tenantId, policySet);
  const byEmail = new Map(grantRows.map((g) => [g.account_email, g]));
  const emails = [...new Set([...accounts.map((a) => a.email), ...grantRows.map((g) => g.account_email)])].sort();
  const setup = googleWorkspaceDelegationSetup();
  return {
    tenantId,
    modes: {
      oauth_direct: { configured: isGoogleOAuthConfigured() },
      composio_proxy: { configured: isGoogleComposioConfigured() },
      domain_wide_delegation: {
        configured: isDelegationConfigured(),
        approved: policy ? { domains: policy.domains, mailboxes: policy.mailboxes } : null,
        policyErrors: policySet.errors.length,
        serviceAccountEmail: setup.serviceAccountEmail,
        clientId: setup.clientId,
        scopes: setup.scopes,
        directoryAdmin: admin,
      },
    },
    accounts: emails.map((email) => {
      const conn = accounts.find((a) => a.email === email);
      const grant = byEmail.get(email);
      const granted = grant ? scopesOf(grant) : [];
      return {
        email,
        authMode: grant?.mode ?? conn?.authMode ?? "domain_wide_delegation",
        connectionStatus: conn?.status ?? null,
        grantStatus: grant?.status ?? null,
        reauthReason: grant?.reauth_reason ?? null,
        dwdApproved: grant ? null : isGoogleDwdMailboxApproved(tenantId, email, policySet),
        grantedScopes: granted,
        capabilities: Object.fromEntries((Object.keys(GOOGLE_OAUTH_CAPABILITY_SCOPES) as GoogleOAuthCapability[]).map((cap) => [
          cap,
          grant?.mode === "oauth_direct" ? missingGoogleScopes(granted, GOOGLE_OAUTH_CAPABILITY_SCOPES[cap]).length === 0 : null,
        ])),
        accessTokenExpiresAt: grant ? iso(grant.access_token_expires_at) : null,
        refreshTokenExpiresAt: grant ? iso(grant.refresh_token_expires_at) : null,
        hasRefreshToken: grant ? Boolean(grant.refresh_token_ciphertext) : null,
        lastRefreshAt: grant ? iso(grant.last_refresh_at) : null,
        connectedBy: grant ? { subject: grant.connected_by_subject, issuer: grant.connected_by_issuer } : null,
      };
    }),
    pendingAuthorizations: pending,
    capabilityMatrix: GOOGLE_AUTH_CAPABILITY_MATRIX,
  };
}

/**
 * Coverage of the Google credential lane itself (data coverage is reported by
 * gmail / google-docs / calendar / contacts). States are derived from stored
 * grant/connection state on every call; nothing is statically "complete".
 */
export async function googleAuthCoverage(tenantId: string, executor: Executor = defaultDb): Promise<CoverageReport[]> {
  const status = await googleAuthStatus(tenantId, executor);
  const out: CoverageReport[] = [];
  const caps = Object.keys(GOOGLE_OAUTH_CAPABILITY_SCOPES) as GoogleOAuthCapability[];

  for (const account of status.accounts) {
    const base = `account:${account.email}`;
    if (account.authMode === "domain_wide_delegation") {
      if (account.connectionStatus !== "active") {
        out.push({ provider: GOOGLE_AUTH_PROVIDER_ID, scope: base, state: "blocked", reason: `dwd_connection_${account.connectionStatus ?? "missing"}` });
      } else if (!account.dwdApproved) {
        out.push({ provider: GOOGLE_AUTH_PROVIDER_ID, scope: base, state: "blocked", reason: "dwd_not_approved_for_tenant" });
      } else if (!status.modes.domain_wide_delegation.configured) {
        out.push({ provider: GOOGLE_AUTH_PROVIDER_ID, scope: base, state: "blocked", reason: "dwd_service_account_not_configured" });
      } else {
        // connect verified gmail.readonly via users.getProfile; the other scopes depend on
        // the Admin Console client grant, which we only learn from the first job per scope.
        out.push({ provider: GOOGLE_AUTH_PROVIDER_ID, scope: `${base}/gmail`, state: "complete", reason: "dwd_verified_at_connect" });
        for (const cap of caps.filter((c) => c !== "gmail")) {
          out.push({ provider: GOOGLE_AUTH_PROVIDER_ID, scope: `${base}/${cap}`, state: "pending", reason: "dwd_scope_unverified_until_first_job" });
        }
      }
      continue;
    }

    if (account.grantStatus !== "active") {
      out.push({
        provider: GOOGLE_AUTH_PROVIDER_ID,
        scope: base,
        state: "blocked",
        reason: account.grantStatus === "revoked" ? "oauth_revoked" : `oauth_reauth_required:${account.reauthReason ?? "unknown"}`,
      });
      continue;
    }

    if (account.authMode === "composio_proxy") {
      out.push({ provider: GOOGLE_AUTH_PROVIDER_ID, scope: `${base}/docs-changelog`, state: "blocked", reason: "ot_requires_bearer" });
      out.push({ provider: GOOGLE_AUTH_PROVIDER_ID, scope: `${base}/bearer-jobs`, state: "blocked", reason: "composio_proxy_has_no_bearer; jobs calling getGoogleAccessToken fail until they use fetchGoogleApi" });
      out.push({ provider: GOOGLE_AUTH_PROVIDER_ID, scope: `${base}/scopes`, state: "partial", reason: "composio_does_not_report_granted_scopes" });
      continue;
    }

    for (const cap of caps) {
      const ok = account.capabilities[cap];
      if (cap === "directory_admin" && !ok) continue; // optional; reported at tenant level
      out.push({
        provider: GOOGLE_AUTH_PROVIDER_ID,
        scope: `${base}/${cap}`,
        state: ok ? "complete" : "blocked",
        reason: ok ? "oauth_scopes_granted" : "oauth_scope_not_granted; reconnect with this capability",
        ...(account.lastRefreshAt ? { lastSuccessAt: account.lastRefreshAt } : {}),
      });
    }
  }

  const oauthDirectory = status.accounts.some((a) => a.authMode === "oauth_direct" && a.grantStatus === "active" && a.capabilities.directory_admin);
  const dwdDirectory = Boolean(status.modes.domain_wide_delegation.directoryAdmin && status.modes.domain_wide_delegation.configured && status.modes.domain_wide_delegation.approved);
  if (status.accounts.length > 0) {
    out.push({
      provider: GOOGLE_AUTH_PROVIDER_ID,
      scope: "tenant/workspace-directory",
      state: dwdDirectory || oauthDirectory ? "pending" : "blocked",
      reason: dwdDirectory
        ? "dwd_admin_present; directory sweep verified by contacts/calendar jobs"
        : oauthDirectory
          ? "oauth_admin_grant_present; directory sweep verified by contacts/calendar jobs"
          : "tenant_wide_directory_requires_dwd_or_admin_oauth; only individually connected accounts are covered",
    });
  }
  if (status.pendingAuthorizations > 0) {
    out.push({
      provider: GOOGLE_AUTH_PROVIDER_ID,
      scope: "authorizations",
      state: "pending",
      reason: "consent_in_progress",
      counts: { pending: status.pendingAuthorizations },
    });
  }
  return out;
}
