# Live tools: every tenant MCP, exposed to your agent at runtime

`@procmem/sdk/live` keeps a customer harness's tool list in sync with **all** MCP servers of the tenant:

- the parent's memory filesystem MCP (`/mcp`), exposed as `memory__<tool>`;
- every integration child MCP that the daily build deployed for the tenant (`GET /v1/integrations`), exposed as
  `integration__<slug>__<tool>`.

Children can be added, redeployed with new schemas, or retired. The SDK picks the change up without restarting the
harness or the MCP client connection. The parent `/mcp` stays filesystem-only: no integration tools are added to it.
The SDK connects to each child directly, using a short-lived child token.

```
            +-------------------- LiveToolRegistry (src/sdk/live/registry.ts) ---------------------+
 parent  -->| GET /v1/integrations (poll + backoff)   POST /v1/integrations/:slug/token (per child) |
 cred.      | MCP client -> parent /mcp (memory)      MCP client -> child mcpUrl (child bearer)     |
 provider   | snapshot {version, tools[], sources[], catalog}  +  onToolsChanged(added/updated/removed)|
            +--------+--------------------------+--------------------------+----------------------+
                     |                          |                          |
              ToolBoundary (any harness)   createPiLiveTools (Pi 1.3)   procmem-live-mcp (stdio MCP bridge)
```

## Quick start

```ts
import { LiveToolRegistry, ToolBoundary } from "@procmem/sdk/live";

const registry = new LiveToolRegistry({
  parent: { baseUrl: "https://wild-zero-kq08i.run.mcp-use.com", credential: () => getParentToken() }, // called per request
  pollIntervalMs: 30_000,
});
await registry.start();

const view = new ToolBoundary(registry);       // turn-stable view
for (;;) {
  view.sync();                                  // SAFE POINT: adopt the latest snapshot before building a request
  const reply = await model({ tools: view.getTools().map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) });
  for (const c of reply.toolCalls) results.push(await view.callTool(c.name, c.arguments)); // MCP CallToolResult
}
await registry.dispose();
```

The parent credential needs `memory:read` (for `/mcp`) and `integrations:read` (for the catalog and token route).
Without `integrations:read`, the catalog answers 403. All integration tools are then removed, and memory keeps working.

## Pi coding agent (1.3): live tools plus trace capture

```ts
import { attachPiTraceCapture } from "@procmem/sdk/pi";
import { createPiLiveTools } from "@procmem/sdk/live/pi";

const live = createPiLiveTools(registry);
const loader = new DefaultResourceLoader({ /* ... */ extensionFactories: [live.extension] });
await loader.reload();
const { session } = await createAgentSession({ /* ... */ resourceLoader: loader, noTools: "builtin" /* optional */ });
await session.bindExtensions({});                       // session_start registers every live tool
const detach = attachPiTraceCapture(session, traceSession); // full traces, including the live tool calls
await session.prompt("...");                            // tools change between prompts/turns with no restart
```

How the adapter uses the installed Pi 1.3 API:

| Change | Pi API used |
| --- | --- |
| tool added | `pi.registerTool(def)`. A new `direct` tool is activated when it is registered. |
| schema or metadata changed | `pi.registerTool(def)` again under the same name. Pi replaces the definition (Map.set), there is never a duplicate, and the active state is kept. |
| tool removed | Re-registered as `exposure: "hidden"`. Pi 1.3 has no `unregisterTool`. Hidden tools are never declared to the model, and `execute()` refuses the call. |
| active set | `pi.getActiveTools()` and `pi.setActiveTools()`. Only the adapter's own names are touched. Host tools stay exactly as they are. `setActiveTools` is called only when the set must change, because a deactivating call clears Pi's pending restored loadout. |

Timing rules:

- **When changes apply.** Changes are applied only at safe points: `session_start`, `before_agent_start`, `turn_end`,
  or immediately while the session is idle (`ctx.isIdle()`). They are never applied while a model request is in flight.
  Pi snapshots tools per turn.
- **Changes during a turn.** Each registered `execute()` carries the fingerprint of the definition the model was shown.
  If that tool changes in the middle of a turn, a call made with the old arguments returns `tool_changed` and is not
  forwarded. The next request in the same prompt carries the new schema. This is tested in
  `tests/sdk-live-tools-pi.test.ts`.
- **User-disabled tools.** A tool the user disabled stays disabled across updates, while it is absent, and across
  re-binds, until the user re-enables it.
- **Re-binding.** When the factory runs again (reload, or a new session), every tool is registered again.
- **Allowlists.** If you pass `createAgentSession({ tools: [...] })`, include `memory__*` and `integration__*` patterns.
  Pi silently filters out names that do not match.

## MCP clients that configure servers only at startup: `procmem-live-mcp`

One stdio MCP server, built on the official `@modelcontextprotocol/server`, exposes every live tool and sends
`notifications/tools/list_changed` whenever the snapshot changes. Clients that honor the notification, and re-list on
the same connection, see added, changed and removed tools with no reinitialize and no restart.

```json
{ "mcpServers": { "procmem": { "command": "npx", "args": ["procmem-live-mcp"],
  "env": { "PROCMEM_BASE_URL": "https://wild-zero-kq08i.run.mcp-use.com", "PROCMEM_OAUTH_CONFIG": "/home/me/.procmem/oauth.json" } } } }
```

Credentials come from the environment only. The bin refuses any argument, and stdout carries only protocol.

| Mode | Variables |
| --- | --- |
| `static` | `PROCMEM_API_KEY`: a headless static key. It never expires. It is not OAuth refresh. |
| `token-file` | `PROCMEM_TOKEN_FILE`, re-read for every request. Rotation is done by someone else. |
| `oauth` | `PROCMEM_OAUTH_CONFIG`: a JSON file `{tokenEndpoint, clientId, tokenStore, resource?, scope?, clientAuth?: {method}}`. It must not contain tokens or secrets. The grant lives in the 0600 `FileTokenStore`, and a confidential client's secret goes in `PROCMEM_OAUTH_CLIENT_SECRET`. The SDK OAuth provider (`docs/sdk-oauth.md`) refreshes before expiry and persists rotated refresh tokens atomically. `resource` defaults to `<base>/mcp`. |

- **Choosing a mode.** If more than one variable is set, the bin fails closed unless `PROCMEM_AUTH` picks the mode.
- **Other variables.** `PROCMEM_POLL_MS`, `PROCMEM_MEMORY=0`, `PROCMEM_INTEGRATIONS=0`, `PROCMEM_BRIDGE_LOG=quiet`, and
  `PROCMEM_ALLOW_INSECURE_LOCALHOST=1` (loopback testing only).

**Fallback for clients that ignore `list_changed`.** Two tools have fixed schemas that never change:

- `procmem_list_live_tools {query?, source?}` returns the current tools with their full schemas;
- `procmem_call_live_tool {name, arguments}` calls any current tool.

Such clients cannot gain new *individual* tools automatically. They can still reach every current tool through the
fallback pair, without a restart.

**Stale schemas.** The bridge remembers which definition of each tool it last showed to the client, through
`tools/list` or the fallback list. A call to a tool that changed since then returns `tool_changed` (re-list and retry).
A tool added after the client's last list returns `tool_not_listed`.

Protocol version is pinned to the 2025 era (`2025-11-25`, `2025-06-18`, `2025-03-26`), where `list_changed` is pushed
on the session's stream. The 2026 `subscriptions/listen` model is not negotiated.

## Parent OAuth refresh

WorkOS access tokens last 300 s. Use the SDK provider:

```ts
import { FileTokenStore, OAuthRefreshProvider } from "@procmem/sdk/oauth";
import { LiveToolRegistry, oauthParentCredential } from "@procmem/sdk/live";

const provider = new OAuthRefreshProvider({ tokenEndpoint, clientId, resource: `${baseUrl}/mcp`, store: new FileTokenStore(path) });
const registry = new LiveToolRegistry({ parent: { baseUrl, ...oauthParentCredential(provider) } });
```

- **Fresh token per request.** `credential` (`getToken`) is called for every parent request (catalog, token mint,
  memory MCP), and it never returns an expired token.
- **After a 401.** On a pre-execution 401 from the parent, the registry calls `onUnauthorized(rejected)`
  (`forceRefresh`) **once** and retries that request once. Concurrent 401s share one refresh.
- **Exact rejected credential.** `rejected` is the credential that the failed HTTP request actually carried. For
  catalog and token calls it is captured per request; for memory MCP calls it is captured per MCP operation. It is kept
  in a private WeakMap and never appears in errors or logs. A late 401 for an old token therefore adopts the newer
  token without another refresh: one token POST in total, also with two providers sharing one store, and without
  flapping. This is tested, and a mutant that passes the current token fails the tests.
- **Re-authentication required.** A `reauthRequired` error fails closed: the catalog becomes `unauthorized`, memory
  becomes `auth_failed`, and there are no further retries.
- **Provider failures.** Errors from the credential provider surface as `ParentCredentialError`. They are never
  reported as an ambiguous tool failure.

## Behavior reference

**Names.**
- Format: `memory__<tool>` and `integration__<slug>__<tool>`. A slug cannot contain `_`, so the format is unambiguous.
- Valid names match `^[A-Za-z0-9_-]{1,64}$`. They depend only on the source and the upstream name.
- Invalid or over-long names get a `_h<sha256[0..10]>` suffix.
- Residual collisions, and duplicated upstream names, are skipped and reported in `sources[].skippedTools`. They are
  never merged.

**Definitions** are full upstream JSON: `inputSchema`, `outputSchema`, `annotations`, `title`, `_meta` and `icons`.
- The description is a short source tag followed by the upstream text verbatim.
- `fingerprint` hashes the whole published descriptor, including catalog identity (deploymentId, commit, title, mcpUrl).
- **Attestation.** By default, only child tools that appear in the catalog's attested manifest (`tools`) are exposed.
  A child whose receipt has no manifest therefore exposes no tools; they show up in `skippedTools`. Opt out with
  `attestedToolsOnly: false`.

**Results.** The MCP `CallToolResult` is passed through: text, image, audio, resource, resource_link,
`structuredContent`, `isError` and `_meta`.
- Every known credential value (recent parent credentials, minted child tokens) is replaced by `[REDACTED]` in results,
  definitions, statuses and logs. This applies to every string value and every object key; no field name is exempt.
- Removal is by exact value. Ordinary data that merely looks like a token stays intact, and ordinary binary data
  (image/audio `data`, resource `blob`) stays byte-identical.
- An image or audio block whose bytes contain a credential is replaced by a text notice.
- The SDK's own errors are `isError` results with `_meta["procmem/error"] = {code, mayHaveExecuted?, retried?}`.

**Lifecycle.**

| Event | Effect |
| --- | --- |
| new slug | New handle, token manager and connection. |
| slug gone from a **successful** catalog | Tools removed immediately, calls refused (`tool_not_found`). |
| mcpUrl, deploymentId, commit or audience changed | Brand-new handle and connection. |
| same deployment | `tools/list` again every `relistIntervalMs` (default: each poll). |
| `list_changed` | Debounced relist of that source on the same connection. |
| `tools/list` | All pages (cursor loop, at most 64 pages and 512 tools, repeated-cursor detection). |

**Catalog failures.**

| Catalog result | Effect |
| --- | --- |
| 401 or 403 | All integrations dropped. |
| transient (network, 5xx, malformed) | Last good set kept until `maxStaleMs` (default 10 min), then dropped (`stale_dropped`). |
| successful empty list | A real removal of everything. |
| `catalogConfigured:false` | Valid and empty. |
| `childAuthConfigured:false` | Integrations listed but `excluded`; no token is ever requested. |

**Child tokens** (`POST /v1/integrations/:slug/token`).
- **Preflight.** The token is obtained before any MCP traffic, single-flight.
- **Expiry.** The token is refreshed `min(tokenRefreshSkewMs, lifetime/2)` before it expires. Lifetime is measured on
  the server clock (from the `Date` header) and anchored to the local clock, so clock skew cannot produce an expired
  bearer or a mint on every request.
- **Expired tokens.** Tokens with less than 5 s left are rejected (`mismatch`).

Token route failures (contract in `.context/token-route-ready`):

| Response | Effect |
| --- | --- |
| 404 `integration_not_found` | `excluded` |
| 503 `child_auth_not_configured` | `excluded` (not retryable) |
| 502 `token_failed` | Transient: tools kept, backoff |
| 401 | One parent refresh, then `auth_failed` |
| slug, mcpUrl, audience or type mismatch | `excluded` (namespace mismatch) |

**No hot loops.** Each failing source gets its own backoff (`sourceRetryMs` doubling up to `maxBackoffMs`). A failure
inside a refresh never triggers another refresh. Calls may request one refresh, limited to one per
`minRefreshIntervalMs`.

**Retries.** Each call gets at most one retry, and the tool and source are re-validated first. Retries happen only in
these cases:

- 401/403: the request was rejected before execution; the retry uses a fresh child token or a refreshed parent credential;
- provably unsent failures: connect refused, 404 session not found (one reconnect, single-flight across concurrent calls);
- ambiguous failures (network drop, timeout, 5xx after send), and **only** for `readOnlyHint: true` tools.

Mutating tools are never replayed after an ambiguous failure. The result is `ambiguous_failure` with
`mayHaveExecuted: true`.

**Credential hygiene.**
- The parent credential is only sent to the parent origin, and child tokens only to that child's origin.
- `redirect: "error"` is set everywhere.
- https is required. http is allowed only on loopback, with `allowInsecureLocalhost`.
- URLs with embedded credentials are refused.
- Child URLs come only from the authenticated catalog, and the token response must name the same URL.
- All text in errors, statuses and logs is scrubbed.

**Polling.** Configurable interval, exponential backoff with jitter on catalog failure, `unref()` timers. `dispose()`
stops all timers, closes every connection (including in-flight connects) and refuses later calls.

## Evidence

Offline suites (real MCP over loopback; parent = real app, upstream children SIMULATED):

| Suite | What it covers |
| --- | --- |
| `tests/sdk-live-tools.test.ts` | Names, URL policy, memory and scratch, full pass-through (image, resource_link, structuredContent, isError), add, `list_changed` schema change on the same connection, attested manifest, redeploy, removal, ToolBoundary, transient vs empty catalog. |
| `tests/sdk-live-tools-resilience.test.ts` | Polling and backoff, stale drop, dispose; short-TTL refresh with concurrent dedupe, clock skew, expired token, single 401 retry without flapping, persistent 401 fail-closed, parent 401; token-route 404/503/502 with no hot loop, `childAuthConfigured:false`; preflight on an existing connection; single-flight reconnect; mutating no-replay; read-only retry; refresh plus mutating at the same time; stale definitions refused; deployment-only fingerprint change; scrubbing of results and metadata; redirects and untrusted URLs. |
| `tests/sdk-live-tools-pi.test.ts` | Real Pi 1.3 session, Pi faux SCRIPTED model: add, mid-turn change refused then the new schema on the next request, removal, user-disabled memory, re-bind. |
| `tests/sdk-live-tools-bridge.test.ts` | Spawned stdio bin, one connection: add, change (`tool_changed` until re-list), fallback, removal, argv and stdout hygiene. |
| `tests/sdk-live-tools-oauth.test.ts` | Rotating parent OAuth (3 s tokens) plus child re-mint under concurrent calls, revocation (exactly one refresh), late old-token 401s on the memory MCP, catalog and token route (one POST; the hook only ever receives the rejected token), two providers sharing one store (one POST), grant revocation fails closed with no storm, mutating calls exactly once. |
| `tests/sdk-live-tools-bridge-oauth.test.ts` | Bridge in OAuth mode with FileTokenStore rotation persisted; ambiguous config and secrets in config fail closed. |

Live scripts:

- `scripts/sdk-live-tools-hosted.ts` → `reports/sdk-live-tools-hosted.json`: **LIVE, read-only**, against the deployed
  parent and its LLM-authored child `notify-hub`. That child's third-party API is simulated in-process. Only
  `readOnlyHint` tools are called. Uses a static headless key, so OAuth refresh is not exercised there.
- `scripts/sdk-live-tools-pi-live.ts` → `reports/sdk-live-tools-pi-live.json`: **LIVE Fireworks models** (Kimi K3,
  GLM 5p3, MiniMax M3) in one Pi session each, with trace capture attached. Children are SIMULATED. A tool is added,
  changed (new required argument) and removed with no restart, and pass/fail comes from host-side checks.
- `scripts/sdk-live-tools-pack-check.ts` → `reports/sdk-live-tools-pack.json`: npm pack, install into a fresh consumer,
  imports of `@procmem/sdk`, `/live`, `/live/pi` and `/oauth`, and the installed bin over stdio.

## Requirements

- The SDK package (`@procmem/sdk`) needs Node >= 20, because its MCP 2.3.x dependencies require it. The Pi adapter
  needs the Pi peers (Node >= 22.19).
- The repository root (parent server with mcp-use 2.10) needs Node >= 22.22.2.

## Limits

- Clients that ignore `list_changed` only gain new tools through the fallback pair.
- Pi cannot unregister a tool. A removed tool stays in `getAllTools()` with `exposure: "hidden"` and cannot be called.
- Hosted add/change/remove was not exercised live, so as not to alter the hosted tenant. Hosted evidence is read-only
  discovery and calls; the dynamic lifecycle is proven on loopback with the real parent app and with live models.
- Only one MCP connection is kept per source. The registry does not multiplex several tenants; use one registry per
  parent credential.
