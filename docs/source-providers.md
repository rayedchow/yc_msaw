# Source providers: what is implemented and what is connected

**Connected live: none.** The pivot has not been deployed. Every provider below is implemented in code and tested
only against synthetic fixtures (fake provider APIs, PGlite, a local PostgreSQL 18 cluster). Account setup that
needs a human is listed at the end.

Terms used in the tables:

- **Content**: the provider's data is exported as files.
- **Raw**: the stored provider record, post-redaction.
- **Bytes**: exact binary bytes.
- **Coverage** is what the provider reports through `sources_status`. `complete` is reported only when the module
  can prove it; anything unreported shows `pending` or `unreported`.

## Google (runtime `providers/google-auth`, `gmail`, `calendar`, `google-contacts`, `google-docs`)

| Source | Paths | What is captured | Coverage and limits |
|---|---|---|---|
| Google auth | none | Direct OAuth, domain-wide delegation, or Composio, resolved per account | DWD scopes other than Gmail stay `pending` until a job uses them. Composio has no bearer, so bearer-only lanes are `blocked`. |
| Gmail | `sources/gmail/<mailbox>/…` | The whole mailbox, resumably: readable pages with full bodies, raw message JSON, `.eml` (withheld when redaction changed the payload), attachment bytes (≤ 50 MiB), threads, raw history pages, `state.json`. Labels and deletes are applied in order. | Per mailbox, `complete` only after the current full pass finishes and history was checked within 15 minutes. No push (`users.watch`). Mail deleted before the first pass is unrecoverable. |
| Calendar | `sources/calendar/accounts/<mailbox>/calendars/<id>/events/…`, plus the donor `sources/calendar/<yyyy>/<mm>/*.md` | Per-mailbox event snapshots (exact jsonb), append-only revisions with raw diffs, calendar metadata. Resumable full sync, 410 reset without losing snapshots, removal tombstones, push channels with polling fallback. | `complete` = current state complete; edit history only from first capture. The shared mirror buckets by UTC date (raw keeps zoned times). |
| Contacts | `sources/google-contacts/accounts/<mailbox>/{connections,other-contacts}/<id>.{json,md}` | People API connections and other contacts, incremental via sync tokens, merges and deletions tracked, revisions with diffs. Synced every 15 minutes. | Photos are not requested. A missing `contacts.other.readonly` blocks only that endpoint. |
| Docs / Drive | `sources/google-docs/…` | Docs: native document and per-tab JSON (never `contentUri`), image bytes, permissions, snapshot diffs, the OT changelog (raw `/revisions/load` pages, parsed ops, 5-minute per-user sessions with true-order before/after text, suggestions, tabs). Sheets/Slides: `files.export` plus native JSON. Other Drive files: exact bytes (size caps). PDFs go through the donor drive-pdf binary lane. A **full Drive inventory** per mailbox (My Drive, shared-with-me, every shared drive) checkpoints files that never changed after connect. | `drive-inventory` is `complete` only after a gap-free listing of every roster mailbox. `docs-history` relies on an undocumented, writer+-gated endpoint and is `blocked` under Composio. A partial changelog never advances. Access lost in one mailbox does not tombstone a file another mailbox still sees. Table/list/image edits are recorded but not replayed into text. |

## Devices

| Source | What is captured | Coverage and limits |
|---|---|---|
| iMessage (Mac uploader) | The bundled uploader protocol (`/api/imessage/ingest`, `sync-contacts`, `local-status`, `command`, `command/ack`) on the runtime public host. Canonical, legacy and GUID identity with alias dedupe. Edit and unsend history. Durable command queue. Per-chat projections. | `complete` only after a validated all-history source-sync receipt. Attachments are metadata only (`partial`). yc_msaw confirms every request and revocation is immediate. Nothing was installed or captured. |

## Other providers

Each provider's per-integration agent results are recorded here as they are merged. Baseline export (raw ledger
plus the donor mirror projection) exists for Confluence, Jira, GitHub, Bitbucket, Slack, Notion and Granola.

| Provider | State |
|---|---|
| Confluence, Jira, GitHub, Bitbucket, Slack, Notion, Granola, binary/Drive PDF | Integration in progress (per-provider agents) |
| Nango generic records lane | Integration in progress |
| Zoom, Linear, coding sessions, office audio, Stripe, Cursor agents, Instagram/WhatsApp personal, Discord | Queued |

## Account setup that needs a human

- **Nango:** sign-in and acceptance of Nango's terms are pending the user's explicit decision. No account was
  created.
- **Google Cloud (askshepherd.ai):** the organization's "Verify it's you" password challenge is pending the user. No
  OAuth client, API key or service account was created.
- **Google Workspace DWD:** needs a Workspace super-admin to authorize the service account's client ID.
- **Mac uploader:** installation and Full Disk Access are the user's action. Notarization is deferred.
