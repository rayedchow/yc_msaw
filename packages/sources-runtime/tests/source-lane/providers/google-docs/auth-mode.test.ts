import { describe, expect, it, vi } from "vitest";

const resolveMock = vi.hoisted(() => vi.fn(async (_tenant: string, mailbox: string) => (mailbox === "proxy@corp.example" ? "composio_proxy" : mailbox === "oauth@corp.example" ? "oauth_direct" : null)));
const metadataMock = vi.hoisted(() => vi.fn(async () => null as Record<string, unknown> | null));

vi.mock("../../../../src/vault/google-auth.js", () => ({ resolveGoogleAuthMode: resolveMock }));
vi.mock("../../../../src/vault/tokens.js", () => ({ getTokenMetadata: metadataMock }));

import { docsHistoryCapability, loadGoogleAuthMode } from "../../../../src/source-lane/providers/google-docs/auth-mode.js";

/**
 * google-auth patch request 7 (applied by the coordinator): the Docs lane resolves the credential lane per
 * mailbox through google-auth, because OAuth/Composio grants live in google_oauth_grants (no integration_tokens row)
 * and one tenant may mix modes.
 */
describe("google-docs auth mode per mailbox", () => {
  it("uses the per-account grant mode for OAuth-only tenants", async () => {
    expect(await loadGoogleAuthMode("t1", "proxy@corp.example")).toBe("composio_proxy");
    expect(docsHistoryCapability(await loadGoogleAuthMode("t1", "proxy@corp.example"))).toMatchObject({ changelog: false, reason: "ot_requires_bearer" });
    expect(await loadGoogleAuthMode("t1", "oauth@corp.example")).toBe("oauth_direct");
    expect(resolveMock).toHaveBeenCalledWith("t1", "oauth@corp.example");
  });

  it("falls back to legacy tenant metadata only when the account has no resolvable grant", async () => {
    metadataMock.mockResolvedValueOnce({ authMode: "domain_wide_delegation" });
    expect(await loadGoogleAuthMode("t1", "legacy@corp.example")).toBe("domain_wide_delegation");
    metadataMock.mockResolvedValueOnce(null);
    expect(await loadGoogleAuthMode("t1")).toBe("unknown");
  });
});
