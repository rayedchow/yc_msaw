/**
 * Which Google credential lane a tenant's connection uses, and what that lane
 * can truthfully claim for Docs history.
 *
 * The private `/revisions/tiles` + `/revisions/load` changelog needs a real
 * OAuth bearer for a writer+ identity. It is attempted under domain-wide
 * delegation (Aqueduct b26d3f46 default; donor research verified it on
 * Workspace docs via delegation) and under direct 3-legged OAuth (gigabrain
 * c9c55105a^, restored by the google-auth agent). For direct OAuth the donors
 * disagree: Aqueduct's live test and gigabrain's May research fetched it with
 * owner-role consumer OAuth tokens, while gigabrain 21feb713 lists it as not
 * reliably mirrorable per-user ("may require browser/editor credential
 * context"). It is not verified for this deployment, so an OAuth refusal is
 * reported as ambiguous rather than as a role problem.
 *
 * A Composio proxy connection never hands out the bearer, so the changelog is
 * reported `blocked` with `ot_requires_bearer` - never attempted, never
 * claimed. Docs content (`documents.get`) and therefore snapshot diffs are not
 * available there either: the Docs content consumers call
 * `getGoogleAccessToken`, which throws `GoogleBearerUnavailableError` for
 * Composio accounts until they move to `fetchGoogleApi`.
 *
 * Mode is resolved per account by google-auth (`resolveGoogleAuthMode`) or read
 * from the stored `integration_tokens.metadata`; it is never inferred from
 * request input.
 */
export type GoogleAuthMode = "domain_wide_delegation" | "oauth_direct" | "composio_proxy" | "unknown";

export function googleAuthModeFromMetadata(metadata: Record<string, unknown> | null | undefined): GoogleAuthMode {
  if (!metadata) return "unknown";
  const mode = typeof metadata.authMode === "string" ? metadata.authMode.trim().toLowerCase() : "";
  if (mode === "composio_proxy" || mode === "composio" || typeof metadata.composioConnectedAccountId === "string") {
    return "composio_proxy";
  }
  if (mode === "domain_wide_delegation" || mode === "dwd" || metadata.delegation === true) return "domain_wide_delegation";
  if (mode === "oauth_direct" || mode === "oauth") return "oauth_direct";
  return "unknown";
}

export interface DocsHistoryCapability {
  mode: GoogleAuthMode;
  /** Whether the private OT changelog may be attempted at all. */
  changelog: boolean;
  reason: string | null;
  /** Whether Docs content snapshots (documents.get) and snapshot diffs can be fetched in this lane. */
  content: boolean;
  contentReason: string | null;
}

export function docsHistoryCapability(mode: GoogleAuthMode): DocsHistoryCapability {
  if (mode === "composio_proxy") {
    return { mode, changelog: false, reason: "ot_requires_bearer", content: false, contentReason: "docs_content_requires_bearer" };
  }
  // DWD and direct OAuth hand us a bearer; the endpoint is still writer+-gated
  // and undocumented, so an attempt may end `blocked`/`partial` per doc.
  // `unknown` (legacy rows without authMode) is attempted: getGoogleAccessToken
  // decides, and a failure is recorded, not hidden.
  return { mode, changelog: true, reason: null, content: true, contentReason: null };
}

/** Status note for a lane that cannot attempt the changelog. */
export function docsHistoryBlockedNote(capability: DocsHistoryCapability): string {
  const parts = [
    "This connection's credential lane cannot call the private changelog endpoint; per-author OT history, sessions and changelog suggestions are not captured.",
  ];
  if (!capability.content) {
    parts.push(
      "Docs content snapshots and snapshot diffs (documents.get) are not captured for this account either: the Docs content path needs a Google bearer, which a Composio connection never provides.",
    );
  }
  return parts.join(" ");
}

/**
 * Reason for an access refusal from the changelog endpoint, by HTTP status and
 * credential lane. 401 is a credential problem (expired/revoked token, or the
 * endpoint not accepting it); 403 is the writer+ role gate under DWD, but under
 * direct OAuth (or an unknown lane) it may also be the endpoint refusing a
 * per-user OAuth token, which is unverified here.
 */
export function changelogRefusalReason(status: number, mode: GoogleAuthMode): string {
  if (status === 401) return "changelog_unauthorized";
  if (status === 404) return "changelog_not_found";
  if (mode === "domain_wide_delegation") return "changelog_forbidden_writer_role_required";
  return "changelog_forbidden_writer_role_or_oauth_unsupported";
}

/** Human-readable explanation for a `changelogRefusalReason` value (status files). */
export function changelogRefusalNote(reason: string | null): string {
  switch (reason) {
    case "changelog_unauthorized":
      return "The changelog endpoint rejected the credential (401): the token is expired, revoked or not accepted by this endpoint. Reconnect or re-approve the account; this is not a document role problem.";
    case "changelog_not_found":
      return "The changelog endpoint returned 404: the document is gone or no longer visible to this identity.";
    case "changelog_forbidden_writer_role_required":
      return "The changelog endpoint refused this delegated identity (403): writer+ role on the document is required.";
    case "changelog_forbidden_writer_role_or_oauth_unsupported":
      return "The changelog endpoint refused this identity (403). Either the account lacks writer+ role on the document, or the endpoint does not accept this per-user OAuth token; acceptance under direct OAuth is unverified for this deployment.";
    default:
      return "The changelog endpoint refused this identity (writer+ role required, endpoint blocked, or access lost).";
  }
}

/**
 * Per-account mode first (google-auth `resolveGoogleAuthMode`: an OAuth/Composio grant row wins, else an approved
 * DWD mailbox): OAuth-only tenants have no `integration_tokens` row, and one tenant may mix modes across mailboxes.
 * Falls back to the tenant-level token metadata for legacy DWD connections.
 */
export async function loadGoogleAuthMode(tenantId: string, mailbox?: string | null): Promise<GoogleAuthMode> {
  if (mailbox) {
    const { resolveGoogleAuthMode } = await import("../../../vault/google-auth.js");
    const resolved = typeof resolveGoogleAuthMode === "function" ? await resolveGoogleAuthMode(tenantId, mailbox).catch(() => null) : null;
    if (resolved) return resolved;
  }
  const { getTokenMetadata } = await import("../../../vault/tokens.js");
  return googleAuthModeFromMetadata(await getTokenMetadata(tenantId, "google"));
}
