/**
 * @procmem/sdk/live: live MCP tool exposure for customer harnesses.
 *
 *   const registry = await startLiveTools({ parent: { baseUrl, credential: () => getToken() } });
 *   registry.getTools();                       // memory__* + integration__<slug>__* with full schemas
 *   registry.onToolsChanged((c) => ...);       // added / updated / removed
 *   await registry.callTool(name, args);       // MCP CallToolResult, verbatim
 *
 * Harness adapters: ToolBoundary (generic, applies changes at safe turn boundaries), createPiLiveTools
 * ("@procmem/sdk/live/pi"), createLiveToolsBridge (an MCP server; the `procmem-live-mcp` stdio bin).
 */
export { LiveToolRegistry, startLiveTools, type LiveToolRegistryOptions } from "./registry.js";
export { ToolBoundary } from "./boundary.js";
export { createLiveToolsBridge, FALLBACK_CALL, FALLBACK_LIST, type LiveToolsBridge } from "./bridge.js";
export { ParentClient, ChildTokenError, ParentCredentialError, type CatalogEntry, type CatalogResult, type CredentialProvider, type ParentEndpoint } from "./parent.js";
export { PINNED_PROTOCOL_VERSIONS } from "./connection.js";
export { assignStableNames, stableToolName, hashedToolName, TOOL_NAME_RE, MEMORY_PREFIX, INTEGRATION_PREFIX, type SourceId } from "./names.js";
export { scrubSecrets, trustedUrl, UntrustedUrlError } from "./security.js";
export { diffSnapshots, errorResult } from "./types.js";
export type { CallOptions, CatalogStatus, JsonObject, LiveTool, LiveToolResult, LiveToolSource, SourceStatus, ToolsChange, ToolsSnapshot } from "./types.js";

/**
 * Parent credential wiring for a refreshable OAuth grant, e.g. `OAuthRefreshProvider` from "@procmem/sdk/oauth":
 *   new LiveToolRegistry({ parent: { baseUrl, ...oauthParentCredential(provider) } })
 * `getToken` is called for every parent request (never an expired token); after a pre-execution 401 the registry calls
 * `forceRefresh(rejected)` once with the EXACT credential that request carried (captured per HTTP request, never
 * exposed) and retries that request once; a late 401 for an old token adopts the newer one without another refresh.
 * A reauth-required error fails closed.
 */
export function oauthParentCredential(provider: { getToken(): Promise<string>; forceRefresh(rejected?: string): Promise<string> }): { credential: () => Promise<string>; onUnauthorized: (rejected: string | undefined) => Promise<string> } {
  return { credential: () => provider.getToken(), onUnauthorized: (rejected) => provider.forceRefresh(rejected) };
}
