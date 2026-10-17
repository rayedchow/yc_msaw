# SDK OAuth refresh provider

`src/sdk/oauth-refresh.ts` keeps an existing OAuth grant alive for the SDK's parent connection. It does **not** log
anyone in: the first login (authorization code + PKCE, with DCR or CIMD client registration) is done once by any
standard OAuth client, such as the mcp-use CLI. The provider then refreshes the access token before it expires. WorkOS
AuthKit access tokens last 300 s, so refreshing is required, not optional.

Static keys that never expire still work for headless use, but they do not replace OAuth refresh.

## Use

```ts
import { FileTokenStore, OAuthRefreshProvider, tokensFromTokenResponse } from "@procmem/sdk/oauth"; // subpath wired by the SDK owner

const provider = new OAuthRefreshProvider({
  tokenEndpoint: "https://sincere-umbrella-45-staging.authkit.app/oauth2/token",
  clientId: "<public DCR client_id>",              // token_endpoint_auth_method=none
  resource: "https://wild-zero-kq08i.run.mcp-use.com/mcp", // canonical MCP resource, sent on every refresh
  store: new FileTokenStore("~/.procmem/oauth/parent.json".replace("~", process.env.HOME!)),
  initialTokens: tokensFromTokenResponse(loginResponse), // only used when the store is empty
});

// Any `() => Promise<string>` credential slot, e.g. the live tools ParentEndpoint:
const parent = { baseUrl, credential: provider.getToken }; // called per request
// After a 401 on a request that was NOT executed (pre-execution), call once, then retry that request:
//   await provider.forceRefresh(rejectedAccessToken)
```

### API

| Member | Contract |
| --- | --- |
| `getToken(): Promise<string>` | Bound. Returns an access token valid for at least `minValidityMs` (default 10 s, capped at ¼ of the token lifetime). Refreshes `refreshSkewMs` (default 60 s, capped at ½ lifetime) before expiry. Never returns an expired token. |
| `forceRefresh(rejected?: string): Promise<string>` | Bound 401 hook. Pass the rejected access token. If a newer token already exists (another caller, instance or process refreshed), you get it back with no token request. Otherwise exactly one refresh is forced; concurrent calls share it. Without an argument, a call within `forceMinIntervalMs` (5 s) of the last refresh returns the current token. |
| `status()` | Credential-free snapshot: `state`, `expiresAt`, `refreshCount`, `adoptedCount`, `consecutiveFailures`, `backoffUntil`, `lastErrorCode`. |
| `replaceGrant(tokens)` | Supply a new grant after a re-login. Clears sticky failures and quarantine. |
| `reload()` | Re-read the store. A different grant in the store clears a sticky failure. |
| `dispose()` | Abort in-flight work and reject later calls. |
| `scrub(text)` | Remove every known token/secret value plus bearer/JWT patterns from `text`. |
| `createOAuthCredential(opts)` | Callable credential `() => Promise<string>` with `.provider` attached. |

Errors are `OAuthRefreshError { code, kind, reauthRequired, status?, retryAfterMs? }`. The kinds are:

- `transient`: retried later with backoff.
- `permanent`: config, store or response problem.
- `reauth`: sticky; a new grant is required.

## Guarantees

- **Single flight.** Concurrent `getToken` and `forceRefresh` calls share one token request.
- **Store-locked refresh.** Every refresh holds the store's exclusive lock and re-reads the store first. A grant that
  another instance or process already rotated is adopted, never replayed. `FileTokenStore` uses an
  `O_CREAT|O_EXCL` lock file, which serializes processes on one host.
- **Persist before use.** Rotated tokens are written atomically before any caller gets the new access token. The
  write is temp file + fsync + rename + directory fsync, with file mode 0600, a private directory, and symlinks refused.
- **Failed writes keep the lock.** If the write fails, the provider keeps the new tokens in memory and **keeps holding
  the store lock**. Other writers cannot load the now-consumed refresh token, so they wait, time out with
  `lock_timeout`, and send no request. The write is retried before anything else on the next call. That retry never
  overwrites a different grant written meanwhile, such as a fresh login; that grant is adopted instead.
- **No replay after an unknown outcome.** The refresh POST changes server state: sending it can consume the old
  refresh token. The provider only retries failures that provably happened before the request reached the server:
  connection refused, DNS failure, TLS failure, HTTP 408, 429 (`Retry-After` honored) and 503. Timeouts after the
  request was sent, dropped connections, other 5xx responses and unreadable 200s count as an **unknown outcome**. In
  that case the stored grant is quarantined (`refresh_outcome_unknown`, sticky) and no instance resends the old
  refresh token. A malformed 200 that carries a well-formed new `refresh_token` is salvaged: the new refresh token is
  persisted and the access token is not used.
- **Definitive rejections fail closed.** `invalid_grant` (revoked, expired or reused), `invalid_client` and other 4xx
  rejections fail closed and stay sticky until a different grant arrives. There is no silent browser re-login.
- **Backoff fallback.** While backing off after a transient failure, the current token is returned only if it is
  still valid with a safe margin.
- **Strict validation.** `token_type` must be Bearer, `expires_in` must be positive, and `access_token` must be
  non-empty with no whitespace. If the server omits `refresh_token`, the previous one is kept (RFC 6749 §6). Expiry
  is measured from before the request was sent.
- **Request contents.** The canonical `resource` (RFC 8707) is sent on every refresh. `scope` is sent only when
  configured, and never beyond the granted scope (`scope_not_granted`).
- **Client authentication.** `none` (public client: `client_id` in the body), `client_secret_post` and
  `client_secret_basic` (form-urlencoded credentials in the Basic header). The configuration is validated.
- **Endpoint restrictions.** The token endpoint must use https; loopback http is allowed only with
  `allowInsecureLocalhost`. Redirects are refused (`redirect_blocked`), and the redirect target never sees the token.
- **No secrets in output.** No token, client secret or Basic credential appears in errors, events, `status()`,
  `toJSON()` or `util.inspect`. Server `error_description` text is truncated and scrubbed.
- **Pre-request only.** The provider only obtains credentials. It never retries or replays MCP requests, including
  mutating tool calls.

## Stores

- `FileTokenStore(path)` uses the SDK's own JSON format (`procmem-oauth-token-store` v1). Tokens are bound to
  `{tokenEndpoint, clientId, resource}`; a mismatch raises `grant_binding_mismatch`. `clear()` logs out: providers
  fail with `grant_removed`.
- `MemoryTokenStore` keeps tokens in memory, for a single process.
- A custom `TokenStore { load, save, acquireLock? }` works too. The no-replay guarantee across instances requires an
  `acquireLock` that is shared by every writer and never taken over automatically. Without `acquireLock`, providers
  are serialized only per store object in one process, so the store must have a single owner. If you persist
  `quarantine`, it must round-trip.

### Lock recovery (operator only)

Lock files are **never broken automatically**, whether by age or by a dead-pid check: neither can prove that the
holder is gone. A process killed during a refresh, or one that could not persist rotated tokens, leaves
`<store>.lock` behind. Every provider then fails with `lock_timeout`, and the message names the holder pid and how
long it has held the lock.

To recover, stop **every** process that uses the store, then call `new FileTokenStore(path).removeLock()` (or delete
the file). If the stored refresh token was already consumed, the next refresh returns `invalid_grant`; log in again.

## Live smoke (host only)

`scripts/oauth-refresh-smoke.ts` checks this provider against an existing approved WorkOS DCR grant stored by the
mcp-use CLI. It needs no new consent. It performs **one real rotation**, so run it only while no other writer (such
as the CLI) uses those files.

```sh
D=~/.mcp-use/client/credentials/<hash>/oauth/<id>
npx tsx scripts/oauth-refresh-smoke.ts \
  --tokens "$D/mcp-use-cli_procmem-yc_33bd51ab_tokens" \
  --alias "$D/mcp-use-cli_procmem-yc_33bd51ab_tokens_https_3A_2F_2Fsincere-umbrella-45-staging.authkit.app" \
  --client-info "$D/mcp-use-cli_procmem-yc_33bd51ab_client_info" \
  --parent-url https://wild-zero-kq08i.run.mcp-use.com/mcp \
  --issuer https://sincere-umbrella-45-staging.authkit.app/oauth2/token
```

The script:

1. Forces expiry, then runs two provider instances with 4 concurrent `getToken()` calls each. It expects exactly one
   network refresh and one distinct token.
2. Persists the rotated tokens to the CLI token file and its alias in CLI format, keeping unknown fields.
3. Runs a real authenticated MCP `tools/list` against the parent.

The report at `reports/oauth-sdk-refresh.json` contains only statuses, timings, counts, booleans, key names and file
modes. The script refuses to write a report that would contain a known secret. Arguments must be paths or URLs;
tokens are never accepted on argv and never printed. The CLI adapter exists only in the script; the SDK store format
is separate.
