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
never a request field or provider payload. Enrolment is self-service: any member (`memory:read`) can enrol their own
device or account, and becomes its owner.

| `$SOURCES/...` | Owner | Enrolment |
| --- | --- | --- |
| `imessage/<segment>/`, `coding-sessions/<segment>/`, `office-audio/<segment>/` | the member whose device setup it is: every member enrols their own devices, and each device writes into that member's own runtime owner scope (revoking a Mac keeps its history with its enroller; a setup the runtime refused enrols nothing) | `POST /v1/sources/devices/<provider>/setup` |
| `granola/<segment>/`, `zoom/<segment>/`, `cursor-agents/<segment>/`, `whatsapp-personal/<segment>/`, `instagram-personal/<segment>/` | the member who connected the account: every member connects their own, into their own runtime owner scope (own credential, lane state and raw ids) | `POST /v1/sources/connect/<integration>` (`granola`, `zoom`, `cursor_background_agents`, `whatsapp_personal`, `instagram_personal`) |
| `<nango source>/<segment>/` (a Nango records source with `"audience": "personal"`, the default) | the member who connected it (their connect session, in their owner scope) | `POST /v1/sources/nango-records/connect-sessions` |
| `gmail/<mailbox>/`, `calendar/accounts/<mailbox>/`, `google-contacts/accounts/<mailbox>/` | the principal that last proved control of that address through Google: a data grant (OAuth/Composio), or for a domain-wide-delegated mailbox an identity-only ownership proof (`openid email`, no tokens kept, collection stays DWD) | `POST /v1/sources/google/auth/oauth/start` (data grant) or `POST /v1/sources/google/auth/ownership/start` (proof) |
| `google-docs/<doc>/`, `google-docs/_drive/…/<file>/`, `google-docs/_raw/document:<id>/`, `binary/drive-pdf/<id>/` | per unit: readable by the principal whose proven mailbox sees the file in Drive **and may read its revisions** (`capabilities.canReadRevisions`). A unit that mailbox can only view is withheld, since its history, changelog and comments are part of it. The runtime answers this attribution only for the calling principal (internal route; nobody can publish it). If the runtime is unreachable, nothing is served. | as above |
| `google-docs/_accounts/<mailbox>/` | the owner of `<mailbox>`. A Doc, Sheet, Slides deck, Drive file or Drive PDF that mailbox may only read or comment on is served as its own current view, captured with its own credential (Google decides what it sees: no suggestions for readers, only the comments Google returns to that account in `comments.json`, no OT history or permission list). Docs keep their layout; other files live under `_drive/<sheets\|slides\|files\|pdf>/<file>/` (`content/` export or bytes in the format that account's Drive offers, `native.json` for Sheets/Slides). The shared directories, with their OT history, byte versions, comment ledger, suggestions and permissions, stay with members whose mailbox may read revisions. Files whose download/copy is disabled for that account keep only metadata and comments from then on (`blocked: copy_restricted_for_account`), also when the restriction is switched on without a new version; content captured before the restriction stays in that account's own `sources_history` (readable by its owner only). | as above |
| Google files outside a mailbox or unit (e.g. the donor `calendar/<yyyy>/<mm>/` files, which mix mailboxes) | the principal that owns **every** Google address of the tenant. That covers every address the runtime reports and every mailbox directory present in `$SOURCES`. | as above |

`<segment>` is the member's owner segment, `@u-` + the first 24 hex of
`sha256("procmem.personal-owner/v1\n" + tenantNs + "\n" + issuer + "\n" + subject)`. It is derived from the verified
principal by yc_msaw (`access.ts personalSegment`) and by the runtime (`core/personal-scope.ts`), never from a payload.
The runtime keeps each member's personal connections and devices in a separate *scope tenant*
(`<tenantNs>.u-<hex>`, not addressable through the internal API), so two members' credentials, lane state and provider
ids never mix, and publishes it under `<provider>/<segment>/` only. A member sees their own segment; the provider
directory itself is listed only to members who have a subtree in it. Anything in such a provider directory outside a
segment was captured before owner scopes and belongs to nobody (devices: see the legacy note below).

How it is enforced:

- Every verb applies it: `ls`, `find`, `grep`, `read`, `sources_history` (listing and exact `versionId` reads),
  `sources_status`, and the admin `GET /v1/sources/status`. Admins are members too and get no exception.
- Another owner's path answers exactly like a missing path (`not_found`; empty history; an unknown and a foreign
  `versionId` give the same error). Walks skip denied subtrees without reading them.
- Directories that also hold other owners' data list only the caller's children. Their totals (`liveFiles`,
  `files`, `capturedAt`) are `null`. Mailbox containers (`gmail/`, `calendar/accounts/`, …) are always filtered per
  mailbox. The root sums only fully readable providers.
- In status, providers the caller cannot read are omitted. For a partly readable provider, a coverage report is kept
  only if its scope names one of the caller's own addresses (whole-address match) and its reason names no other.
  Device bindings are listed to their enroller only. The admin `GET /v1/sources/bindings` lists every binding so
  admins can manage them, but another member's device label is redacted (`label: null`).
- The runtime relays are filtered the same way:
  - `GET /v1/sources/runtime/status` drops other owners' coverage and every connection whose directory the caller
    cannot read. A runtime error is answered with a fixed 502, never the runtime's body.
  - `GET /v1/sources/nango-records` lists the caller's own personal connections (`personal`); organization
    sources' connections (`"audience": "organization"`) are listed to admins only. No view lists another member's
    personal connection. `GET /v1/sources/runtime/status` likewise carries only the caller's own `personal` block.
  - `GET /v1/sources/google/auth` lists the caller's own Google accounts only, admins included. Admins
    (`memory:build`) also see accounts nobody owns yet (the DWD mailboxes they add) and the DWD configuration, but
    never another member's account.
  - `GET /v1/sources/office-audio/consents` (participant names) is limited to the office-audio owner and admins.
- **Owner evidence can't be forged by a tenant admin:**
  - Google owners come from the runtime's status heartbeat (`googleAccounts`). They are accepted only from a binding
    minted by `POST /v1/sources/runtime/provision`. Its token goes to the runtime and is never returned.
  - `POST /v1/sources/bindings` refuses `*`, `binary`, every personal provider and every provider whose data lives
    in members' owner segments, i.e. anything not shared (`400 use_runtime_provision`). Only the provisioned
    collector writes a `<provider>/@u-…/` path or reports an `owner:` coverage scope; any other binding, including
    one minted before owner scopes, gets `403 forbidden_provider`.
  - A new grant becomes readable at the next heartbeat (≤ 5 min by default). Owner evidence is cached per tenant for
    5 s: a change made by the same process applies at once, one made on another replica within 5 s.
  - Bindings provisioned before this change carry no such origin. Re-provision once.
- **Default deny:** only the shared workspace providers are readable by every member: Slack channels, Notion,
  Confluence, Jira, GitHub, Bitbucket, Linear, Discord and Stripe, plus any directory the operator lists in yc_msaw's
  `SOURCES_SHARED_PROVIDERS` (e.g. an org-wide Nango records source). Any other provider directory, including Nango
  generic records sources such as a personal Outlook, is served only as the caller's own owner segment.
- **Fail closed:**
  - unowned data is readable by nobody. That covers a domain-wide-delegation-only mailbox, data captured before
    owners were recorded, a donor Google connection without a mailbox, and a mailbox the runtime no longer
    reports;
  - so is data with more than one claimed owner;
  - nobody claims a provider: connected personal accounts and owner-scoped devices are published only under their
    member's segment, which never held legacy data. Unsegmented data captured before owner scopes (including rows
    exported only later, re-dated by an exporter backfill, or purged with ordinary tombstones) is never served to
    anyone who connects or enrols afterwards.
  - A refused connect or device setup leaves nothing behind.
  - Owners stop their own collection: a member revokes a device they enrolled (`DELETE /v1/sources/bindings/:id`)
    and disconnects their own personal account (`DELETE /v1/sources/connections/<integration>`; it reaches only the
    caller's own scope). Their history is kept. Admins can revoke any binding, and stop an organization-level legacy
    connection of a personal integration with `?legacy=organization` (its data stays sealed).
- **Slack direct messages and group DMs** are personal, but their participants are Slack users, not yc_msaw
  principals. So nobody may read them:
  - The runtime withholds them at export (`providers/slack/direct.ts`). That covers projections, raw records,
    conversation labels, and files shared only in DMs. A projection whose conversation cannot be determined is
    withheld too. When a conversation turns out to be a DM later, its already exported projections are withheld.
  - Withheld paths are published as tombstones with reason `slack_direct_message_withheld`. yc_msaw treats any
    `*_withheld` tombstone as a missing path, so `read` and `sources_history` (earlier versions included) are sealed.
    Withholding is sticky: a later put to that path is ignored (`stale`) and never restores it.
  - yc_msaw also denies any `D…` conversation path, and denies `binary/slack/` (legacy donor Slack files carry no
    conversation).
  - The data stays in the runtime database.
- `binary/upload/` has no recorded owner and is denied.

Migration, enrolment and current limits (owner-only is enforced; these are decisions pending the user):

- **DWD:** a domain-wide-delegated mailbox is collected, but sealed until its user completes the identity-only
  ownership proof for that address (`POST /v1/sources/google/auth/ownership/start`). This needs a Google OAuth client
  with the runtime's redirect URI registered. Collection stays DWD. Everything captured under the mailbox (and the
  Docs/Drive units it can read revisions of) then becomes theirs.
- **Owner scopes:** connected personal accounts (Granola, Zoom, Cursor, WhatsApp/Instagram), personal Nango sources
  and devices (iMessage, coding sessions, office audio) are per member: each connects or enrols their own. One
  account of each connect integration per member (the donor lanes keep one credential per scope; Cursor and Unipile
  keep several connections per scope). A WhatsApp/Instagram account is attached only through Unipile hosted auth
  started by the member (`POST /v1/sources/connect/whatsapp_personal` with `{apiKey}` returns a single-use link,
  valid 15 minutes; Unipile's notify for that link, carrying a secret only Unipile was given, attaches the account it
  created to that member's scope). A workspace API key plus an account id is refused (`hosted_auth_required`),
  because the key reads every account in the Unipile workspace and proves nothing about whose account it is. Office-audio recording consent stays organization-wide (admin), and a consent
  revocation with `deleteCaptured` reaches every member's scope.
- **Legacy devices:** data a device enrolled before owner scopes captured stays in the provider directory itself and
  is served to its single legacy enroller (if exactly one); devices enrolled since do not affect it.
- **Google Docs/Drive** are attributed per unit, so several members each read their own. Units captured before the
  per-mailbox visibility records existed are re-attributed when the inventory next lists them; units no current
  mailbox sees stay sealed. The donor calendar month files (which mix mailboxes) still need one owner of every
  Google account.
- Legacy data captured before owners existed stays sealed, and so does everything an organization-level connection
  of a personal integration (made before owner scopes) captures. A purge does not release it, because its history
  stays in `$SOURCES`; only a new tenant does.
- Ownership cannot be transferred. A static SDK key that enrols a device owns it like any principal.

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
