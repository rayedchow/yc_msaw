# Server-side sources/ filesystem (`$SOURCES`)

procmem keeps an always-updated, server-side mirror of every connected source under
`sources/<provider>/...` and serves it through the existing filesystem MCP. Agents read
stored data; no MCP call reaches a provider API.

```
providers ─► packages/sources-runtime (Aqueduct sourcing code, Postgres + S3)
               pollers / webhooks / Nango ─► activity_events (raw ledger) + mirror_files (projections)
               triggers ─► source_lane_journal ─► exporter ─► POST /v1/sources/publish (binding token)
yc_msaw ─► SourceStore (ObjectStore) ─► MCP read/ls/find/grep on $SOURCES, sources_status, sources_history
```

## Reading (agents)

The usual verbs take `$SOURCES/...` paths and run host-side (no workspace or sandbox is opened):

| Tool | `$SOURCES` behaviour |
|---|---|
| `ls` | One directory window; `after: <nextAfter>` continues large directories. Deleted files are hidden (`deletedFiles` counts them). |
| `read` | Text: line slices (`offset`/`limit`, first 4 MiB) or byte slices. Binary: byte slices returned base64 (`encoding: "base64"`). Every receipt has `source` (versionId, sha256, size, `capturedAt`, `sourceUpdatedAt`, `ageSeconds`, `captureLagSeconds`, coverage state/health) and `provenance`. A deleted file answers with when and why it was deleted. |
| `find` | Glob over the tree (basename unless the pattern has `/`). |
| `grep` | Regex (worker-isolated, timeout) or literal over text files; binaries and files over 4 MiB are counted in `filesSkipped`, never coerced. |
| `sources_status` | Per provider: files, newest capture, data age, last successful check, last heartbeat, `health` (healthy/stale/unreported: stale when no heartbeat arrived within 3 report intervals, or a scope that declares `expectedIntervalSeconds` last succeeded more than 3 such intervals ago, i.e. a dead worker behind a live exporter) and `coverageState` (complete/partial/blocked/pending/unreported) with each collector's reasons. |
| `sources_history` | Versions of one path, newest first, including deletion tombstones; `versionId` + byte range reads an exact prior version. |

`$SOURCES` is not mounted in `shell` sandboxes. Data age, collector health and coverage
are separate on purpose: a provider can be `complete` but `stale` (collector stopped), or
`healthy` with old data (nothing changed upstream). `unreported` never means complete.

### Who can read `$SOURCES`: personal sources are owner-only

Login and tenant authority are unchanged (WorkOS/OIDC; `memory:read` for `$SOURCES`, `sources_status` and
`sources_history`). Members of one WorkOS organization still share a tenant. Within it, **personal sources are
served only to their owner** (`src/sources/access.ts`). The owner is a verified principal (token issuer + subject),
never a request field or provider payload:

| `$SOURCES/...` | Owner | Enrolment |
| --- | --- | --- |
| `imessage/`, `coding-sessions/`, `office-audio/` | the principal that created the device bindings (all of them, revoked ones included) | `POST /v1/sources/devices/<provider>/setup` (`traces:write` or `memory:build`) |
| `granola/`, `zoom/`, `cursor-agents/`, `whatsapp-personal/`, `instagram-personal/` | the principal that connected the account | `POST /v1/sources/connect/<provider>` (`memory:build`) |
| `gmail/<mailbox>/`, `calendar/accounts/<mailbox>/`, `google-contacts/accounts/<mailbox>/` | the principal that completed the Google OAuth (or Composio) grant for that address; Google's account check at the callback proves control of it | `POST /v1/sources/google/auth/oauth/start` (`memory:build`) |
| `google-docs/`, `binary/drive-pdf/`, and Google files outside a mailbox directory (e.g. the donor `calendar/<yyyy>/<mm>/` files, which mix mailboxes) | the principal that owns **every** Google address the tenant collects | as above |

How it is enforced:

- Every verb applies it: `ls`, `find`, `grep`, `read`, `sources_history` (listing and exact `versionId` reads),
  `sources_status`, and the admin `GET /v1/sources/status`. Admins are members too and get no exception.
- Another owner's path answers exactly like a missing path (`not_found`; empty history). Walks skip denied subtrees
  without reading them.
- Directories that also hold other owners' data list only the caller's children. Their totals (`liveFiles`,
  `files`, `capturedAt`) are `null`; the root sums only fully readable providers.
- In status, providers the caller cannot read are omitted. For a partly readable provider, only coverage
  reports naming one of the caller's own accounts are kept.
- Device bindings are listed in `sources_status` to their enroller only.
- **Fail closed:**
  - unowned data is readable by nobody. That covers a domain-wide-delegation-only mailbox, data captured before
    owners were recorded, a donor Google connection without a mailbox, and an owner list the runtime could not
    report;
  - so is data with more than one claimed owner;
  - a provider directory has exactly one owner. A second member's device setup or connect is refused with
    `409 owner_conflict`, and so is an enrolment over pre-existing unowned data (`reason: unowned_legacy_data`).
    That data stays sealed and is not handed to whoever enrols first.
- Google owners come from the runtime's status heartbeat (`googleAccounts`). They are accepted only from the
  tenant's active `*` runtime binding, so a new grant becomes readable at the next heartbeat (≤ 5 min by default).
- Shared workspace providers stay readable by every member of the tenant: Slack channels, Notion, Confluence, Jira,
  GitHub, Bitbucket, Linear, Discord, Stripe and Nango generic records.
- Slack direct messages and group DMs are personal, but their participants are Slack users, not yc_msaw
  principals. So nobody may read them: the runtime withholds them at export. That covers their projections, raw
  records, conversation labels, and files shared only in DMs (delete reason `slack_direct_message_withheld`;
  `providers/slack/direct.ts`). yc_msaw also denies any `D…` conversation path. The data stays in the runtime
  database. Exception: Slack files captured by the donor before this lane (`binary/slack/`) carry no conversation
  and stay shared. No tenant has such legacy rows yet.
- `binary/upload/` has no recorded owner and is denied.

Migration and enrolment:

- A domain-wide-delegated mailbox becomes readable once its owner completes the Google OAuth grant for the same
  address.
- Device and connected-account data captured before this change is sealed. To re-capture it under an owner, the
  operator removes that provider's runtime data, then the owner enrols.
- Ownership of a provider directory cannot be transferred.
- Per-account layouts (several owners per tenant) exist only for Gmail, Calendar and Contacts. For the other
  personal providers, one member per tenant can own the provider (for example one Mac owner's iMessage).

## Layout

* Projections: the donor mirror paths verbatim, e.g. `sources/confluence/<spaceId>/<pageId>.md`,
  `sources/jira/<PROJECT>/<KEY>.md`, `sources/slack/...`. The donor's staged envelope is the
  file's provenance (`envelope`), or a sidecar under `sources/<provider>/_meta/` when larger than 32 KiB.
* Raw ledger: `sources/<provider>/_raw/<namespace|_>/<object|_>/<yyyy-mm>/<source_event_id>.json`,
  one file per captured record. `raw_payload` is PostgreSQL's stored jsonb text (post-redaction,
  exactly as the donor stored it; large integers are not re-encoded).
* Binary: exact bytes, chunked (8 MiB) and range-readable.
* Provider modules may add files (snapshots, images, attachments) through their export mappers.

## Storage model (`src/sources/store.ts`)

Per tenant namespace, on the existing ObjectStore (Directory locally, Modal Volume hosted):
immutable content chunks (`blobs/<sha>`), immutable versions (`sources/v/`), a Merkle tree of
directory nodes that pages beyond 2,000 entries per directory (hard cap 4,000,000), commits,
and a batch index. The only mutable state is the `sources/head` ref, advanced by
compare-and-swap with rebase on conflict.

* Every batch's receipt is committed into the batch index inside the head CAS: a replay of the
  same `batchId` returns the original receipt even after a crash; the same `batchId` with a
  different request is `409 batch_conflict`.
* Ordering: a put older than the current entry (provider version ordinal, else provider
  modification time, else capture time) is `stale` and never applied; after a deletion only
  capture order counts (provider restores keep old modification times). Deletes older than the
  last provider change are stale.
* Deleted files stay as tombstone entries, so history survives; listings hide them.
* Shape conflicts (a path that is both file and directory) and limits reject only that change
  (`rejected`); the runtime dead-letters such rows instead of acknowledging them.
* All name-keyed dictionaries are null-prototype, so names like `__proto__` are ordinary entries.

## Writing (collectors) and auth

The existing auth stays the only authority: WorkOS/OIDC (or static keys on loopback) through
`authenticateHttp` and `principalFromAuth`. The namespace is always `principal.tenantNs`.

| Route | Credential | Purpose |
|---|---|---|
| `POST /v1/sources/bindings` | `memory:build` | Mint a runtime publish binding for the caller's tenant; token shown once. `kind:"device"` is refused (400 `use_device_setup`): devices enrol only through `/v1/sources/devices/<provider>/setup` |
| `GET /v1/sources/bindings`, `DELETE /v1/sources/bindings/:id` | `memory:build` | List (no secrets) / revoke |
| `GET /v1/sources/status` | `memory:read` | Same data as `sources_status` |
| `PUT /v1/sources/blobs/:sha256`, `POST /v1/sources/publish`, `POST /v1/sources/status-report` | binding token `psb_<tenant>.<id>.<secret>` only | Collector publication |
| `POST /v1/sources/runtime/provision` | `memory:build` | Mint a runtime binding and hand it to the runtime (token never returned). Once the runtime accepts it, earlier `sources-runtime` bindings are revoked (`revokedPrevious`) |
| `GET /v1/sources/runtime/status` | `memory:read` | Runtime connections, binding and coverage |
| `POST /v1/sources/connect/:provider`, `DELETE /v1/sources/connections/:provider` | `memory:build` | Donor connect / disconnect flows in the runtime |
| `POST /v1/sources/devices/:provider` | `traces:write` | Device enrolment for providers without a dedicated setup route |
| `POST /v1/sources/devices/{imessage,coding-sessions,office-audio}/setup` | `traces:write` or `memory:build` | Mac iMessage uploader / coding-sessions agent: server-minted device binding (`transport=runtime-ingest`); returns the agent config once |
| `GET /v1/sources/devices/:provider/verify` | device key in `x-api-key` | Runtime asks this on every uploader request; 200 only for an active device binding of that provider |
| `GET /v1/sources/google/auth` | `memory:read` | Google grants and per-account mode/coverage (no secrets) |
| `GET/PUT /v1/sources/jira/selection`, `GET /v1/sources/github/repositories`, `PUT /v1/sources/github/repositories/selection`, `GET /v1/sources/bitbucket/repositories`, `PUT /v1/sources/bitbucket/repositories/selection` | `memory:read` / `memory:build` | Jira project selection and GitHub / Bitbucket repository selection for the deep lanes (strict bodies; the runtime only accepts this tenant's own connections) |
| `GET/POST /v1/sources/office-audio/consents`, `DELETE /v1/sources/office-audio/consents/:participantKey[?deleteCaptured=true]` | `memory:read` / `memory:build` | Recording consent per participant for office audio (server authority) |
| `/v1/sources/nango-records/*` | `memory:read` / `memory:build` | Generic Nango records lane: status, connect sessions, disconnect, sync now |
| `POST /v1/sources/google/auth/oauth/start`, `POST /v1/sources/google/auth/dwd/mailboxes`, `DELETE /v1/sources/google/auth/accounts/:email` | `memory:build` | Start direct OAuth / Composio consent, add an approved DWD mailbox, disconnect one account |

Binding tokens never authorize MCP or reads; OAuth and static keys never authorize publication.
A binding only writes the provider directories it lists. Runtime routes exist only when
`SOURCES_RUNTIME_URL` and `SOURCES_RUNTIME_SERVICE_TOKEN` are set; yc_msaw forwards the verified
principal as `x-procmem-principal`, and the runtime rejects a URL tenant that differs from it.

Device bindings (always `transport=runtime-ingest`, minted only by device setup) cannot call the publish routes at all;
their raw uploads go to the runtime receiver, which confirms each request with yc_msaw. Revoking such a
binding also revokes the runtime device credential and is authoritative immediately.

Configuration and setup: [running the sources pivot](sources-setup.md). Per-provider state:
[source providers](source-providers.md).

## Known limits

* Raw fidelity is the donor's: post-redaction jsonb, not byte-exact HTTP bodies, unless a provider
  module captures more.
* Coverage is only as complete as each provider module reports; modules that report nothing show
  `pending`/`unreported`.
* The in-process coverage cache refreshes on reports received by this instance and otherwise every 15 s.
