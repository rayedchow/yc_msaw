import { setConnectionStatus, upsertConnection } from "../../db/connections.js";
import { db } from "../../db/client.js";
import { ensureDefaultKbForTenant } from "../../graph/wiring/default-kb.js";
import { startGooglePolling } from "../../queue/dispatch.js";
import { enqueueTask } from "../../queue/queue.js";
import {
  connectGoogleWorkspaceDelegation,
  isGoogleWorkspaceDelegationEmailSupported,
} from "../../vault/google-auth.js";
import { composioGrantAccountId, revokeGoogleComposioAccount } from "../../vault/google-composio.js";
import { GoogleDwdNotApprovedError } from "../../vault/google-dwd-policy.js";
import {
  findGoogleOAuthGrant,
  GoogleOAuthError,
  listGoogleOAuthGrants,
  revokeGoogleOAuthGrant,
  type GoogleConnectedAccount,
} from "../../vault/google-oauth.js";
import { deleteToken, getTokenMetadata } from "../../vault/tokens.js";
import type { ConnectResult } from "../types.js";
import { stopCalendarWatches } from "../../source-lane/providers/calendar/watches.js";

const GOOGLE_INITIAL_BACKFILL_DAYS = 30;
// SOURCE-LANE PATCH (gmail patch request 1): Gmail has no bounded bootstrap; gmail.backfill continues a
// resumable full-mailbox capture (src/integrations/gmail/source-sync.ts). `mode: "full"` documents that.
const GOOGLE_DISCOVERY_ALL_RECENT_QUERY = "modifiedTime > '1970-01-01T00:00:00Z'";

interface GoogleConnectResult {
  success: boolean;
  email?: string;
  error?: string;
}

export async function connectGoogle(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Promise<GoogleConnectResult> {
  void userId;
  void accessToken;
  void refreshToken;
  void expiresIn;
  // Raw caller-supplied tokens carry no proof of which Google account or tenant
  // they belong to; per-user OAuth goes through the server-bound state flow
  // (startGoogleOAuthAuthorization -> completeGoogleOAuthCallback -> connectGoogleOAuthAccount).
  return {
    success: false,
    error: "Raw-token Google connect is not supported. Use the server-bound Google OAuth connect flow.",
  };
}

/**
 * Activates a Google account whose OAuth grant was just verified and stored by
 * completeGoogleOAuthCallback / completeGoogleComposioCallback. The tenant comes
 * from the consumed state row, never from the callback request.
 */
export async function connectGoogleOAuthAccount(account: GoogleConnectedAccount): Promise<ConnectResult> {
  await upsertConnection({
    tenantId: account.tenantId,
    provider: "google",
    externalAccountId: account.email,
    status: "active",
    metadata: {
      authMode: account.mode,
      grantedScopes: account.grantedScopes,
      missingScopes: account.missingScopes,
      capabilities: account.capabilities,
      ...(account.hostedDomain ? { hostedDomain: account.hostedDomain } : {}),
      connectedBy: account.connectedBy,
      connectedAt: new Date().toISOString(),
    },
  });
  await startGooglePolling(account.tenantId);
  await enqueueInitialGoogleTasks(account.tenantId, account.email);
  await ensureDefaultKbForTenant(db, account.tenantId);
  return {
    status: 200,
    body: {
      provider: "google",
      status: "active",
      authMode: account.mode,
      email: account.email,
      grantedScopes: account.grantedScopes,
      missingScopes: account.missingScopes,
    },
  };
}

/** Disconnects one Google account of a tenant in whatever mode it is connected. */
export async function disconnectGoogleAccount(input: { tenantId: string; email: string }): Promise<ConnectResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) return { status: 400, body: { error: "email is required" } };
  // SOURCE-LANE PATCH (calendar-contacts patch request 3): push channels need this account's credential to be
  // stopped at Google, so they are stopped before the grant is revoked (unresolvable ones are marked stopped locally).
  await stopCalendarWatches(input.tenantId, email).catch(() => undefined);
  const grant = await findGoogleOAuthGrant(input.tenantId, email);
  if (grant) {
    let providerRevoked: boolean | null = null;
    if (grant.mode === "composio_proxy") {
      const id = await composioGrantAccountId(input.tenantId, email);
      providerRevoked = id ? await revokeGoogleComposioAccount(id).catch(() => false) : null;
    }
    const result = await revokeGoogleOAuthGrant(input.tenantId, email);
    return {
      status: 200,
      body: { provider: "google", email, authMode: grant.mode, status: "revoked", providerRevoked: providerRevoked ?? result.providerRevoked },
    };
  }
  await setConnectionStatus(input.tenantId, "google", "revoked", email);
  // The integration_tokens row is the DWD marker for the tenant's admin subject (the
  // default mailbox for calls without one). Disconnecting that mailbox removes it so
  // nothing keeps impersonating it; other DWD mailboxes keep their connection rows.
  const metadata = await getTokenMetadata(input.tenantId, "google");
  if (typeof metadata?.email === "string" && metadata.email.trim().toLowerCase() === email) {
    await deleteToken(input.tenantId, "google");
  }
  return { status: 200, body: { provider: "google", email, authMode: "domain_wide_delegation", status: "revoked" } };
}

/**
 * Tenant-level disconnect (AqueductIntegration.disconnect): revokes every OAuth /
 * Composio grant of the tenant at the provider. DWD mailboxes have nothing to
 * revoke on our side beyond the connection rows the caller marks revoked.
 */
export async function disconnectAllGoogleAccounts(input: { tenantId: string }): Promise<void> {
  await stopCalendarWatches(input.tenantId).catch(() => undefined);
  for (const grant of await listGoogleOAuthGrants(input.tenantId)) {
    if (grant.status === "revoked") continue;
    await disconnectGoogleAccount({ tenantId: input.tenantId, email: grant.account_email });
  }
}

export async function connectGoogleWorkspace(input: { tenantId: string; body: unknown }): Promise<ConnectResult> {
  const rawEmail = isRecord(input.body) && typeof input.body.userEmail === "string" ? input.body.userEmail : "";
  const userEmail = rawEmail.trim().toLowerCase();
  if (!userEmail) {
    return { status: 400, body: { error: "Google Workspace delegated user email is required." } };
  }
  if (!isGoogleWorkspaceDelegationEmailSupported(userEmail)) {
    return {
      status: 400,
      body: { error: "Google Workspace domain-wide delegation requires a managed Google Workspace email, not a personal email account." },
    };
  }

  try {
    const connected = await connectGoogleWorkspaceDelegation(input.tenantId, userEmail);
    await upsertConnection({
      tenantId: input.tenantId,
      provider: "google",
      externalAccountId: connected.email,
      status: "active",
      metadata: { authMode: "domain_wide_delegation" },
    });
    await startGooglePolling(input.tenantId);
    await enqueueInitialGoogleTasks(input.tenantId);
    await ensureDefaultKbForTenant(db, input.tenantId);
    return { status: 200, body: { provider: "google", status: "active", email: connected.email } };
  } catch (err) {
    if (err instanceof GoogleDwdNotApprovedError) {
      return { status: 403, body: { error: err.message, code: err.code } };
    }
    if (err instanceof GoogleOAuthError && err.code === "mode_conflict") {
      return { status: 409, body: { error: err.message, code: err.code } };
    }
    const message = errorMessage(err);
    if (isGoogleConnectValidationError(message)) {
      return { status: 400, body: { error: message } };
    }
    if (isGoogleDelegationSetupError(message)) {
      return {
        status: 502,
        body: {
          error: "Google Workspace delegation verification failed",
          hint: "Complete the Google Admin Console domain-wide delegation setup, then retry.",
        },
      };
    }
    return { status: 500, body: { error: "Google connection failed" } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isGoogleConnectValidationError(message: string): boolean {
  return message === "Google Workspace delegated user email is required." ||
    message === "Google Workspace domain-wide delegation requires a managed Google Workspace email, not a personal email account.";
}

function isGoogleDelegationSetupError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("unauthorized_client") ||
    lower.includes("invalid_grant") ||
    lower.includes("gmail profile request failed (401)") ||
    lower.includes("gmail profile request failed (403)");
}

async function enqueueInitialGoogleTasks(tenantId: string, mailbox?: string): Promise<void> {
  if (mailbox) {
    // An OAuth account joining an already-polling tenant: the tenant-level
    // ":initial" dedupe keys may be taken, so seed this mailbox's own backfill.
    await enqueueTask({
      queue: "backfill",
      tenantId,
      kind: "gmail.backfill",
      payload: { tenantId, mailbox, mode: "full" },
      groupKey: `${tenantId}:gmail`,
      dedupeKey: `${tenantId}:google:gmail.backfill:initial:${mailbox}`,
    });
  }
  await Promise.all([
    enqueueTask({
      queue: "sync",
      tenantId,
      kind: "calendar.setup",
      payload: { tenantId },
      groupKey: `${tenantId}:calendar`,
      dedupeKey: `${tenantId}:google:calendar.setup`,
      priority: 5,
    }),
    enqueueTask({
      queue: "backfill",
      tenantId,
      kind: "gmail.backfill",
      payload: { tenantId, mode: "full" },
      groupKey: `${tenantId}:gmail`,
      dedupeKey: `${tenantId}:google:gmail.backfill:initial`,
    }),
    // Content backfill chain: discovery (unbounded - the whole visible corpus)
    // seeds watermarks AND enqueues one gdocs.content-snapshot per discovered
    // Google Doc, which captures content rows + materializes the mirror. A doc
    // that never changes after connect is still fully captured. Idempotent on
    // reconnect: snapshot tasks dedupe per doc while queued, and an
    // already-captured revision skips the Docs fetch entirely.
    enqueueTask({
      queue: "backfill",
      tenantId,
      kind: "gdocs.discovery",
      payload: { tenantId, query: GOOGLE_DISCOVERY_ALL_RECENT_QUERY },
      groupKey: `${tenantId}:gdocs`,
      dedupeKey: `${tenantId}:google:gdocs.discovery:initial`,
    }),
    // History hydration (Activity edits + comments) for docs active in the last 30 days.
    enqueueTask({
      queue: "backfill",
      tenantId,
      kind: "gdocs.backfill",
      payload: { tenantId, days: GOOGLE_INITIAL_BACKFILL_DAYS },
      groupKey: `${tenantId}:gdocs`,
      dedupeKey: `${tenantId}:google:gdocs.backfill:initial`,
    }),
  ]);
}
