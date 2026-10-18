# google-auth: Google provider grants for the source lane

yc_msaw WorkOS/OIDC stays the only identity for MCP and admin calls. Google data access is a separate grant
held by the runtime and resolved per (tenant, Google account) to exactly one mode. A failure in that mode is
reported. It never falls back to another mode.

| Mode | How it is connected | Per-user consent | Tenant-wide sweeps | Docs OT changelog |
|---|---|---|---|---|
| `domain_wide_delegation` | `POST …/google/auth/dwd/mailboxes {email}`; the mailbox must be inside `GOOGLE_DWD_TENANT_APPROVALS` | no (Workspace super admin authorizes the service account) | yes | attempted (writer+-gated) |
| `oauth_direct` | `POST …/google/auth/oauth/start {capabilities?, account?}` → browser `launchUrl` → Google → `/auth/google/oauth/callback` | yes, only granted scopes | only with an admin `directory_admin` grant | attempted with the user's bearer (not live-verified) |
| `composio_proxy` (optional) | same start with `broker:"composio"` → `/auth/google/composio/callback` | yes, via Composio | no | blocked: `ot_requires_bearer` |

## Operator configuration (runtime env)

* `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (legacy names `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are
  accepted). `SOURCES_RUNTIME_PUBLIC_URL` must be https (or loopback http). The redirect URI is
  `<public>/auth/google/oauth/callback` unless `GOOGLE_OAUTH_REDIRECT_URI` is set. Register that exact URI on the
  Google OAuth client. Restricted scopes (`gmail.readonly`, `drive.readonly`, …) need Google app verification
  before external users can consent.
* DWD: the existing service-account variables (`GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON`, …) plus
  `GOOGLE_DWD_TENANT_APPROVALS='{"<tenantNs>": {"domains": ["acme.com"], "mailboxes": ["ops@other.io"], "directoryAdmin": "admin@acme.com"}}'`.
  A domain or mailbox approved for more than one tenant is refused for every tenant that lists it.
  `GOOGLE_WORKSPACE_USER_EMAIL` is no longer used as a default mailbox, because a mailbox shared by every
  tenant is exactly the cross-tenant credential this lane must not have.
* Composio (optional): `COMPOSIO_API_KEY`, `COMPOSIO_GOOGLE_AUTH_CONFIG_ID` or per-toolkit
  `COMPOSIO_GOOGLE_{GMAIL,DRIVE,DOCS,CALENDAR,ADMIN}_AUTH_CONFIG_ID`, and optionally `COMPOSIO_API_BASE_URL`.

## Security properties (each one has a test in tests/source-lane/providers/google-auth/)

* **State.** 32 random bytes, stored only as sha256. The row is bound to tenant, yc_msaw principal (issuer + sub),
  mode and expected account. It expires after 10 minutes and is consumed once with a conditional UPDATE, so replay,
  tampering and expiry all fail. The tenant is never read from the callback query.
* **Launch and browser binding.** The launch step is one-time and sets a `__Host-` HttpOnly cookie. A Google consent
  URL forwarded to another browser cannot complete.
* **PKCE and ID token.** PKCE uses S256 and the OIDC nonce is derived from the state. The ID token is checked for
  iss, aud, exp, nonce, sub and email_verified. The consenting account must be the expected one: the principal's
  verified email by default, or `account:{email}` if the admin names it. A mismatch revokes the fresh token.
* **Encryption.** Tokens are AES-256-GCM encrypted with additional authenticated data (AAD) naming
  tenant, account and field, so a ciphertext copied to another row fails to decrypt.
* **Refresh.** Refresh runs under `SELECT … FOR UPDATE` with a re-read, plus in-process deduplication. A rotated
  refresh token is persisted.
  * `invalid_grant`, 400, 401 or 403 sets `reauth_required`, and only that account's connection goes to `error`.
  * 5xx is transient, and 429 honors Retry-After.
  * Missing scopes raise `insufficient_scope` (incremental consent through `include_granted_scopes`).
* **DWD guard.** The DWD allowlist is checked before the service-account-global token cache.
* **Composio.** The callback's `status` query parameter is ignored. The connected account is fetched server-side and
  must be ACTIVE, belong to our tenant-scoped Composio user and use the configured auth config. A connected account
  id binds to one tenant only.

## yc_msaw forwarding

The internal routes are under `/internal/v1/tenants/:tenantId/google/auth`. They expect the tenant from yc_msaw's
verified `principal.tenantNs` and the principal as `X-Procmem-Principal-{Subject,Issuer,Email,Scopes}`, or
`deps.principalOf`. See `AUDIT/implementation/patch-requests/google-auth.md`.
