/**
 * Which Google credential lane a tenant's connection uses, and what that lane
 * can truthfully claim for Docs history.
 *
 * The private `/revisions/tiles` + `/revisions/load` changelog needs a real
 * OAuth bearer for a writer+ identity: domain-wide delegation (Aqueduct
 * b26d3f46 default) or direct 3-legged OAuth (gigabrain c9c55105a^, restored by
 * the google-auth agent). A Composio proxy connection cannot call it (the
 * proxy never hands out the bearer and does not expose the endpoint), so it is
 * reported `blocked` with `ot_requires_bearer` - never attempted, never
 * claimed. Snapshot diffs (documents.get) remain available in every lane.
 *
 * Mode is read from the stored `integration_tokens.metadata` written by the
 * connect flow; it is never inferred from request input.
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
}

export function docsHistoryCapability(mode: GoogleAuthMode): DocsHistoryCapability {
  if (mode === "composio_proxy") return { mode, changelog: false, reason: "ot_requires_bearer" };
  // DWD and direct OAuth hand us a bearer; the endpoint is still writer+-gated
  // and undocumented, so an attempt may end `blocked`/`partial` per doc.
  // `unknown` (legacy rows without authMode) is attempted: getGoogleAccessToken
  // decides, and a failure is recorded, not hidden.
  return { mode, changelog: true, reason: null };
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
