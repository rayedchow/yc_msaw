# Running the sources pivot

This page lists the services, configuration and provider grants the `sources/` filesystem needs.
Nothing here has been deployed, and no live provider account is connected. Every test in this repository
uses synthetic fixtures (local fake provider APIs, PGlite and a local PostgreSQL 18 cluster). Each
provider's state is in [source providers](source-providers.md).

## Services

| Process | Command | Exposure |
|---|---|---|
| yc_msaw (existing server) | `npm start` | Public. Serves MCP, `/v1/sources/*`, WorkOS/OIDC auth (unchanged). |
| Runtime API | `npm --prefix packages/sources-runtime run start:api` | **Public port:** `/health`, OAuth callbacks, provider webhooks, device ingest (`/api/imessage/ingest*`). **Internal** `/internal/v1/*`, reachable by yc_msaw only, on `SOURCES_RUNTIME_INTERNAL_PORT` (or the same port). |
| Runtime worker | `npm --prefix packages/sources-runtime run start:worker` | None. Runs donor connector handlers plus provider task handlers (`sync`/`backfill` lanes only). |
| Runtime sweeper | `npm --prefix packages/sources-runtime run start:sweeper` | None. Runs the schedule sweeper and lease reaper. |
| Runtime exporter | `npm --prefix packages/sources-runtime run start:exporter` | Outbound only. Moves the journal to yc_msaw `POST /v1/sources/publish` and sends coverage heartbeats. |
| Migrations | `npm --prefix packages/sources-runtime run db:migrate` | One-shot. Applies the source-only plan; no pgvector or graph tables. |

The runtime needs PostgreSQL. It uses S3 for donor binary documents (`AWS_*`, as in the donor). yc_msaw keeps its
existing ObjectStore (a directory locally, a Modal Volume when hosted).

## yc_msaw configuration

| Variable | Meaning |
|---|---|
| `PROCMEM_SOURCES` | `0` disables the subsystem. On by default. |
| `MCP_PUBLIC_URL` | Required by the existing auth contract. Its origin is the default publish URL. |
| `SOURCES_RUNTIME_URL` | Internal base URL of the runtime. Must not embed credentials, a query or a fragment. When unset, the runtime-control routes are absent. |
| `SOURCES_RUNTIME_SERVICE_TOKEN` | Service secret, ≥ 32 chars, held only by yc_msaw. The runtime stores only its sha256. |
| `SOURCES_PUBLISH_URL` | Public origin the runtime publishes to. Default: the origin of `MCP_PUBLIC_URL`. Must be https (http only for loopback). The runtime refuses redirects. |
| `SOURCES_DEVICE_API_URL` | Runtime public origin handed to Mac uploaders as `apiUrl`. When unset, device setup answers 503. |

## Runtime configuration

The donor variables in `packages/sources-runtime/src/env.ts` (`DATABASE_URL`, `ENCRYPTION_KEY`,
`API_KEY_PEPPER`, `AWS_*`, `NANGO_*`, `WEBHOOK_BASE_URL`, `WORKER_*`, …) apply unchanged. The source lane adds:

| Variable | Meaning |
|---|---|
| `SOURCES_RUNTIME_SERVICE_TOKEN_SHA256` | sha256 (hex) of yc_msaw's `SOURCES_RUNTIME_SERVICE_TOKEN`. |
| `SOURCES_RUNTIME_INTERNAL_PORT`, `SOURCES_RUNTIME_INTERNAL_HOST` | Optional separate listener for `/internal/v1`. |
| `SOURCES_RUNTIME_PUBLIC_URL` | Public https origin of the runtime: OAuth launch/callback, webhooks, device host. The OAuth binding cookie is `__Host-`, so this must be https. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth web client for direct 3-legged grants. |
| `GOOGLE_OAUTH_REDIRECT_URI` | Default `${SOURCES_RUNTIME_PUBLIC_URL}/auth/google/oauth/callback`; register exactly this URI on the client. |
| `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON` (or `_CLIENT_EMAIL` + `_PRIVATE_KEY`) | Service account for domain-wide delegation. |
| `GOOGLE_DWD_TENANT_APPROVALS` | Operator allowlist that maps each tenant to the Workspace domains and mailboxes it may impersonate, e.g. `{"<tenantNs>":{"domains":["acme.com"],"directoryAdmin":"admin@acme.com"}}`. A domain listed for two tenants is refused for both. Without an entry, DWD is refused (403 `dwd_not_approved`). |
| `COMPOSIO_API_KEY`, `COMPOSIO_GOOGLE_AUTH_CONFIG_ID` (+ per-product `COMPOSIO_GOOGLE_{GMAIL,CALENDAR,DOCS,DRIVE,ADMIN}_AUTH_CONFIG_ID`), `COMPOSIO_API_BASE_URL` | Optional Composio broker for Google. |
| `NANGO_SECRET_KEY`, `NANGO_API_BASE_URL` | Nango API (environment secret key). |
| `NANGO_WEBHOOK_SECRET` | Donor `/webhooks/nango` route: set to the Nango webhook **signing key** (not the API key). Only `X-Nango-Hmac-Sha256` is accepted. |
| `NANGO_WEBHOOK_SIGNING_KEY` (+ `_PREVIOUS` during rotation), `NANGO_RECORDS_CONFIG` / `NANGO_RECORDS_CONFIG_FILE` | Generic records lane (`/webhooks/nango-records`): signing key, plus the operator catalog of Nango integration ids and models. See `packages/sources-runtime/src/source-lane/providers/nango-records/README.md`. |

Provider tuning knobs (`GMAIL_SOURCE_*`, `GDOCS_*`, `GOOGLE_CALENDAR_*`, `GOOGLE_CONTACTS_*`, `NANGO_RECORDS_*`, …)
have safe defaults and are documented next to the code that reads them. `GOOGLE_WORKSPACE_USER_EMAIL` is
deliberately ignored: a process-wide impersonation default would be a cross-tenant credential.

## Wiring a tenant

All admin calls use the tenant's existing WorkOS/OIDC token. The tenant is always the verified principal's
namespace; no body or query field can select it.

1. `POST /v1/sources/runtime/provision` (`memory:build`) mints a runtime publish binding and hands it,
   encrypted, to the runtime. The token is never returned.
2. Connect providers:
   - Google: see below.
   - Nango-backed providers (Confluence, Jira, GitHub, Bitbucket, …): `POST /v1/sources/connect/:provider`
     (`memory:build`) runs the donor connect flow in the runtime.
   - Devices: `POST /v1/sources/devices/imessage/setup`.
3. Agents read the data with the MCP `ls`/`read`/`find`/`grep` tools on `$SOURCES`, plus `sources_status` and
   `sources_history`.
4. Revoke:
   - `DELETE /v1/sources/connections/:provider` disconnects a provider (for Google, every OAuth grant is
     revoked at Google first).
   - `DELETE /v1/sources/bindings/:id` revokes a publish or device binding.

## Google grants

Each Google account resolves to exactly one mode. A failure in that mode is reported; it never silently
falls back to another mode.

| Mode | Use | Setup |
|---|---|---|
| Direct OAuth (`oauth_direct`) | Personal or Workspace accounts, one account per consent | `POST /v1/sources/google/auth/oauth/start` (`memory:build`) with `{"capabilities":["gmail","calendar","docs","contacts"]}` returns `launchUrl`. The admin opens it in a browser; the consenting account must be the principal's verified email unless `account` names another. Tokens are encrypted at rest; refresh failures mark only that account `reauth_required`. |
| Domain-wide delegation (`domain_wide_delegation`) | Workspace tenants, every mailbox in an approved domain | 1. A Workspace super-admin authorizes the service account's client ID for the scopes in `packages/sources-runtime/src/vault/google-auth.ts` (Admin console → Security → API controls → Domain-wide delegation). 2. The operator adds the tenant to `GOOGLE_DWD_TENANT_APPROVALS`. 3. `POST /v1/sources/google/auth/dwd/mailboxes` `{"email": …}`, or the donor `POST /v1/sources/connect/google` `{"userEmail": …}`. |
| Composio (`composio_proxy`) | When a Composio project already brokers Google | `POST /v1/sources/google/auth/oauth/start` with `{"broker":"composio"}`. The connected account is verified server-side. Gmail, Calendar and Contacts run through Composio's proxy. Composio never hands out a bearer, so the bearer-only Docs/Drive lane (content, OT changelog, Drive inventory) reports `blocked` (`ot_requires_bearer` / `composio_proxy_has_no_bearer`) for those accounts. |

Revocation limits that stay true:

- Disconnecting a DWD mailbox removes it from the roster, but the domain-level delegation stays in force until a
  Workspace admin removes it in the Admin console and the operator removes the tenant from
  `GOOGLE_DWD_TENANT_APPROVALS`.
- An OAuth disconnect calls Google's revoke endpoint.
- Calendar push channels are stopped at Google before grants are revoked.

## Mac iMessage uploader (device)

1. `POST /v1/sources/devices/imessage/setup` (`traces:write` or `memory:build`) with
   `{"label":"My Mac","backfillDays":30}` returns `messagesConfig` once (`apiUrl` = `SOURCES_DEVICE_API_URL`,
   `userId` = tenant namespace, `agentToken` = `gimsg_…`). The runtime keeps only its sha256.
2. On the Mac, pipe `messagesConfig` plus the chosen `allowedChatIds` to `shepherd-onboard write-messages-config` on
   stdin, then install the agent when ready to collect. This repository performs no install and no capture,
   and notarization is deferred.
3. Every uploader request is confirmed live with yc_msaw (`GET /v1/sources/devices/imessage/verify`, the key only).
   `DELETE /v1/sources/bindings/:id` therefore refuses the device on its next request, even if the forwarded
   runtime revoke is lost. If yc_msaw is unreachable, the runtime answers 503 and stores nothing (fail closed).
   The device key cannot use MCP, admin or publish routes.

Attachments arrive as metadata only (name, type, size, transfer state), never bytes, and coverage says so.

The Mac **coding-sessions** agent (Codex / Claude Code transcripts) uses the same model:
`POST /v1/sources/devices/coding-sessions/setup` with `{"label":"My Mac","intervalSeconds":300}` returns
`codingSessionsConfig` once (`agentToken` = `gcs_…`), for `shepherd-onboard write-coding-sessions-config`.

## Tests

```sh
npm test && npm run typecheck                                  # yc_msaw
cd packages/sources-runtime && npm test && npm run typecheck   # runtime (PGlite suites)
SOURCES_TEST_PG_URL=postgresql://user:pass@127.0.0.1:5432/postgres npm test   # + real PostgreSQL suites
npm run provenance:check                                       # donor fidelity
```

The real-PostgreSQL suites create and drop their own databases. Point them only at a disposable cluster.
