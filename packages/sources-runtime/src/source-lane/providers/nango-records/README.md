# Generic Nango records lane (`nango-records`)

This lane captures raw records from any Nango integration the operator has actually set up
(Microsoft 365 / Outlook / OneDrive / SharePoint / Teams, Dropbox, Box, Linear, HubSpot,
Salesforce and others). Each record is stored as raw ledger versions plus a readable JSON file
under `sources/<source>/`.

Specialized integrations stay authoritative. A configured source is refused (reported as
`blocked`, never registered) if any of these is already owned by a specialized module or the
donor Nango lane:

- its directory;
- its `activity_events.source`;
- its Nango integration (`github`, `jira`, `confluence`, `bitbucket`, `google`, ...).

The same rule applies to a specialized module added later: it takes the name over, and the
generic source is refused.

## Configure (operator)

Nothing is discovered from an OAuth catalog. Configure only integrations and sync functions
that exist in your Nango environment.

Put the config in `NANGO_RECORDS_CONFIG` (JSON) or `NANGO_RECORDS_CONFIG_FILE` (a path):

```json
{"version": 1, "sources": [
  {"source": "outlook", "providerConfigKey": "<your Nango integration id>", "label": "Outlook",
   "models": ["<SyncModel>", {"model": "<SyncModel2>", "eventType": "outlook_event"}],
   "pollSeconds": 300, "maxConcurrentSyncs": 2, "redactKeys": ["someProviderSecretField"]},
  {"source": "hubspot", "providerConfigKey": "<id>", "discoverModels": true}
]}
```

Config fields:

- `source` is the directory and `activity_events.source` (`^[a-z0-9][a-z0-9-]{0,62}$`).
- `providerConfigKey` is the exact Nango integration ID.
- `models` lists the sync model names the lane should read.
- `discoverModels: true` also captures every model returned by a deployed, enabled sync function
  of that integration.
- With `discoverModels: false`, deployed but undeclared models are reported as `pending` and are
  not captured.

Unknown keys are rejected, so no `tenantId` can be configured. An invalid config captures
nothing and the reason appears in coverage.

Environment variables:

| Variable | Meaning |
|---|---|
| `NANGO_SECRET_KEY` | Environment API key. Needs the scopes `environment:records:read`, `environment:connections:list`, `environment:connect_sessions:write` and `environment:functions:list`. |
| `NANGO_API_BASE_URL` | Optional. https only (http only for loopback, e.g. self-hosted dev). |
| `NANGO_WEBHOOK_SIGNING_KEY` (or `NANGO_WEBHOOK_SECRET`) | From **Environment Settings > Webhooks > Signing key**. This is not the API key. |
| `NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS` | Old key during the 5-minute rotation window. |
| `NANGO_RECORDS_WEBHOOK_URL` | Optional per-connection `webhook_url_override` (https). It is never taken from a client. |
| `NANGO_RECORDS_MIN_REQUEST_INTERVAL_MS` (50) | Pacing of the request budget shared by the whole Nango account. |
| `NANGO_RECORDS_MAX_PAGES_PER_RUN` (50) | Pages one task reads before it yields. |
| `NANGO_RECORDS_PAGE_LIMIT` (100) | `/records` page size. |

Webhook URL: point the Nango environment's webhook at `https://<runtime>/webhooks/nango-records`.
Deliveries for other integrations are verified and then handed to the donor handler. After
shared patch request 2, the old `/webhooks/nango` URL also hands this lane's deliveries over. If
webhooks are missing, polling still binds connections and reads records; it only adds lag.

## Connect an account (tenant admin, through yc_msaw)

yc_msaw forwards these routes with the verified WorkOS/OIDC principal (shared patch request 4).
The runtime routes are internal-only, sit behind the service token and `x-procmem-principal`, and
are scope-gated.

| Route | Scope | Effect |
|---|---|---|
| `GET /v1/sources/nango-records` | memory:read | Configured vs refused sources, per-model capability (`available`/`disabled`/`not_deployed`/`missing`/`unverified`), connections, coverage. |
| `POST /v1/sources/nango-records/connect-sessions` `{"source":"outlook"}` | memory:build | Returns `{sessionId, token, connectLink, expiresAt}`. Hand `token` to Nango Connect UI, or open `connectLink`. |
| `GET /v1/sources/nango-records/connect-sessions/:sessionId` | memory:read | `pending` / `connected` / `expired` / `refused`. While pending, it looks the session tag up through the Nango API. |
| `DELETE /v1/sources/nango-records/connections/:source/:connectionId` | memory:build | Deletes the Nango connection, marks it revoked, cancels queued reads. Captured history stays. |
| `POST /v1/sources/nango-records/sync` `{"source"?}` | memory:build | Enqueues an incremental read now. |

How tenant binding works:

1. The runtime creates the Nango session with `allowed_integrations: [<that one integration>]` and
   one random tag, `procmem_session`. It stores tag → (tenant, principal subject/issuer, source,
   integration, expiry). The Nango session token is returned once and never stored.
2. A connection is bound only by consuming that session. The session is used once and only for
   that integration.
3. For the signed auth webhook, binding happens within the session's validity plus a 10-minute
   delivery grace. For reconciliation, binding requires Nango's own connection `created` time to
   fall within the validity window.
4. Webhook tags such as `end_user_id` or `organization_id`, and request bodies, are never treated
   as tenant identity.
5. `(providerConfigKey, connectionId)` is a primary key, so a connection can never move to
   another tenant.

## What is captured and where

- **Raw versions.** Each record version goes to `activity_events` (source = the configured
  `source`):
  - `source_event_id = nango-records:<pck>:<connectionId>:<model>:<recordId>:<last_modified_at>~<sha256[:20]>`,
    percent-encoded;
  - `source_namespace = nango:<pck>:<connectionId>`;
  - `source_object_id = <model>:<recordId>`.

  The raw payload is the provider record including `_nango_metadata`, after redaction. Nothing
  about the tenant or connection is added to it. Repeated polls of an unchanged record are
  idempotent. Any change gets a new version, including A→B→A and deletes; deletes become
  `tombstone` rows.
- **Redaction.** Removes OAuth tokens, cookies, `Authorization` values and operator `redactKeys`.
  It also removes pre-authenticated URLs: OneDrive/SharePoint `@microsoft.graph.downloadUrl`
  (`tempauth`), Box/Dropbox download or temporary links, and signed `sig` / `X-Amz-Signature` /
  `X-Goog-Signature` URLs. The donor provider redaction then runs as well.
- **Exported files.**
  - `sources/<source>/_raw/<namespace>/<object>/<yyyy-mm>/<event id>.json` holds every version
    (the core raw document, with stored jsonb text spliced in).
  - `sources/<source>/<pck>/<connectionId>/<model>/<recordId>.json` holds the latest payload,
    re-indented token by token (number and string text is untouched).
  - When a record is deleted, its readable file is tombstoned; a re-add restores it. Versions are
    ordered by Nango `last_modified_at`, so out-of-order export converges to the latest state.

## Sync, quotas, retries

- **Cursors.** The checkpoint for each (tenant, connection, model) is the last committed record's
  `_nango_metadata.cursor`. Paging follows `next_cursor` until it is null.
- **Rejected cursor.** The lane resumes with `modified_after = high-water - 1h`; overlap is
  deduplicated by version. If nothing was captured yet, a new full pass starts.
- **Page budget.** A task reads at most `maxPagesPerRun` pages, then enqueues a continuation.
  The queue group key serializes reads per connection.
- **Rate limits.**
  - Nango limits its API per account, so there is one quota bucket per API key, shared by all
    tenants.
  - On a 429 or 503, `Retry-After` (or `X-RateLimit-Reset`) is stored in the database. The task is
    re-enqueued for that time and never sleeps while holding its lease.
  - An exhausted `X-RateLimit-Remaining: 0` blocks until the reset, before any 429 arrives.
  - At most `maxConcurrentSyncs` reads run per integration, using database leases shared by all
    workers.
  - Provider-side API quotas are spent by Nango's own sync functions. The lane cannot attribute
    them.
- **Polling floor** (`nango_records.poll`, per tenant):
  - re-verifies deployed functions (`GET /integrations/{key}/functions?type=sync`, at most every
    15 minutes);
  - reconciles pending sessions;
  - health-checks connections (`GET /connections?connectionId=`, every 15 minutes);
  - enqueues reads that are due (`pollSeconds`) or have a backlog.

  A sync webhook only speeds this up.
- **Auth webhooks.** Refresh, deletion and failure webhooks trigger an authenticated health check;
  their payload is not trusted as connection state. An exact re-delivery within 10 minutes is
  acknowledged without effect.

## Coverage (never `complete`)

Each (connection × model) reports one of:

- `pending` until the first full read of the Nango cache finishes;
- then `partial`, with reasons:
  - the cache keeps the latest payload only;
  - history depth is set by the Nango sync function;
  - file contents are not downloaded;
  - whether deletes are tracked (`track_deletes`);
  - payloads already pruned by Nango (not updated for 30 days);
  - the last failed Nango sync run;
  - rate-limit cooldown;
  - backlog.
- `blocked` for a revoked or erroring connection, a missing integration, or a missing API key.

Configured sources with no connected account, models that are not deployed, and deployed models
that are not enabled show as `pending`.

## Known limits

- **No intermediate versions.** Nango's cache holds the latest state only. Changes between two
  Nango sync runs cannot be observed.
- **Metadata only.** The lane stores the record JSON Nango returns. File bytes (OneDrive, Dropbox,
  Box, SharePoint) and mail attachments are not fetched.
- **Pruned payloads.** Records whose payload Nango pruned before the first capture are skipped and
  counted.
- **Numbers.** Values are JSON numbers as produced by Nango's JavaScript sync functions; no
  further precision is lost here.
- **Sync variants and partitioned models** (the `variant` parameter) are not addressed.
