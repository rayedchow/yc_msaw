# Gmail

## Source-record identity: mailbox-scoped immutable observations

**Decision.** New Gmail `activity_events` rows carry namespace
`mailbox:<delegated-email>`, object id `message:<gmailId>`, and an explicit
`activity` or `tombstone` record kind. Label changes and deletions append their
own observations; they may rebuild/delete the staged mirror but never rewrite
the previously captured message payload (`src/integrations/gmail/poller.ts`).

**Why.** Gmail IDs are mailbox-scoped, while the RFC `Message-ID` header is not
the provider object ID. Append-only observations keep historical evidence
stable.

**Alternatives rejected.** Mutating `labelIds` or `_deleted` on the original
message row destroys the captured version and makes old evidence irreproducible.

**Revisit when.** Revisit only if Gmail documents a stronger cross-mailbox
native identity that remains stable under account migration.

Code: `src/integrations/gmail/`.

Access axes (see [google-access-matrix.md](google-access-matrix.md)): DWD-only
in aqueduct — consumer accounts cannot be impersonated, so gmail.com users are
out of reach until per-user OAuth is re-enabled, and that path carries the
restricted-scope verification + CASA burden. A service account without
delegation has no mailbox at all. No per-file role axis applies to Gmail.

## Multi-mailbox tenants: roster = active google connections (2026-07-12)

**Decision.** One tenant syncs MANY delegated mailboxes. The roster is the set
of active `connections` rows for provider `google` (external_account_id =
email); per-mailbox cursors (gmail `historyId`, backfill watermark) live in
`google_mailbox_sync_state` (migration 0070), one row per (tenant, mailbox),
with per-column updates. `pollGmail`/`backfillGmailDetailed` loop the roster
sequentially, impersonating each mailbox as its own DWD subject; a
`gmail.backfill` task accepts an optional `mailbox` payload to target one.
Connect no longer clobbers the admin token when adding a second mailbox: the
`integration_tokens` row keeps the FIRST-connected (admin) email + service
account facts, and only the connection row + sync-state row are added.

**Why.** The prior single token row (unique on user_id+provider) held one
email and one history cursor, capping every tenant at one mailbox; a second
connect overwrote the first mailbox's cursors.

**Cross-mailbox duplicates are deliberate.** The same thread captured from two
mailboxes produces two events/docs (`mailbox:<email>` namespaces, per-mailbox
gmail ids) — distinct provenance and ACLs. Dedup happens at the graph layer
(statement-hash fact convergence); RFC Message-ID is captured in payloads if a
convergence alias is ever wanted. Do NOT skip-if-seen at capture: it is
order-dependent and destroys per-mailbox coverage evidence.

**Empty roster** (no connection rows, no stored admin email) keeps legacy
behavior: one pass under the default delegation subject.

## Change detection: History API deltas

**Decision.** We persist a Gmail `historyId` per user and poll
`history.list?startHistoryId=...`, processing `messagesAdded`,
`messagesDeleted`, `labelsAdded`, `labelsRemoved` records. The initial cursor
comes from `getProfile`.

**Why.** The History API is a true delta stream — adds, deletes, and label
transitions arrive as typed records with no re-listing. Notably, Fivetran
judged this API not worth the complexity and full-re-imports every mailbox on
every sync; we took the opposite bet because per-user polling at our cadence
would be quota-prohibitive without deltas.

**Alternatives rejected.**
- Full re-import per sync (Fivetran's approach): simple, captures everything,
  but burns quota linearly with mailbox size on every cycle.
- Gmail push via Cloud Pub/Sub (`users.watch`): the eventual latency upgrade —
  the notification only carries `historyId`, so the History cursor machinery
  stays identical. Requires Pub/Sub infra and 7-day watch renewal.

**Revisit when.** Latency below the poll interval matters; `users.watch` slots
in front of the existing cursor without rearchitecting. Also note `historyId`s
expire (typically after ~a week of inactivity) — a 404 on `history.list` means
falling back to a full re-list, which the poller must keep handling.

## Deletion tombstones: `message_deleted` ledger rows (2026-07-08)

**Decision.** A `messagesDeleted` history record for a message we captured
writes an append-only `message_deleted` activity_events row keyed
`gmail:<id>:deleted` (stable key + `ON CONFLICT DO NOTHING`, same
stable-delete-key pattern as granola's `granola:<id>:deleted`), with
`source_updated_at` = the delete-*detected* time (Gmail doesn't report when
the deletion happened). The pre-existing behavior — mutating the original
`gmail:<id>` row's payload with `_deleted: true` in place and removing the
mirror file — is kept unchanged; the tombstone is added before it.

**Why.** Previously the deletion only mutated the existing row's payload, so
the deletion itself never surfaced as an event. Scoped to messages with an
existing base row so spam/auto-purge of never-ingested mail doesn't emit
contentless noise.

## Content and quota

Messages are fetched with `messages.get` (full MIME payload; body normalized in
`body.ts`, attachments recorded as metadata). Quota math (comment at
`poller.ts:18`): Gmail allows 250 quota units/s/user and `messages.get` costs
5 units, so the ceiling is ~50 fetches/s; we run 10 concurrent fetches with a
100ms stagger (~20–30/s) and back off on `GoogleRateLimitError`.

Auth is the readonly delegation scope set
(`GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES`) through the vault.

## Attachments: full metadata in raw, bytes in the binary lane (2026-07-08)

**Metadata (verified).** Every attachment's metadata is in the raw event
payload twice over: the full `messages.get` MIME tree is stored verbatim
(including `body.attachmentId`, `filename`, `mimeType`, `body.size` per part —
only inline base64 `data` on attachment parts is stripped), and the
convenience `attachments` array carries `filename`, `mimeType`, `size`, plus
(since 2026-07-08) `attachmentId` and `partId`. Metadata always lands even
when bytes are skipped.

**Bytes.** Attachment bytes go to the existing S3 + `binary_documents` lane
(provider `gmail-attachment`; migration widened the provider CHECK). Rows are
keyed `external_id = <messageId>:<partId>` — Gmail `attachmentId`s are
volatile across fetches and must never key anything. `version_ref` is the same
stable key (messages are immutable), so re-scans skip without a fetch — which
also means **re-running `gmail.backfill` backfills attachment bytes for
messages captured before this lane existed** (capture runs on every message
pass, before the event-insert dedupe). Inline attachments whose base64 data
arrived with the message are stored from that data; detached ones fetch via
`attachments.get`.

**Scope + caps (all visible, never silent):**
- **Size cap:** bytes over `GMAIL_ATTACHMENT_MAX_BYTES` (default 25 MB —
  Gmail's own send limit, so nothing real is skipped) are not fetched;
  counted in `skippedOversize`.
- **Type scope:** common document + image types (PDF, Office, OpenDocument,
  RTF/JSON/text/CSV/TSV/markdown/HTML, PNG/JPEG/GIF/WebP/TIFF/BMP/SVG).
  Anything else (archives, audio, video, executables — deliberately out of
  scope) still gets a metadata-only `failed_unsupported` row in
  `binary_documents` and a `skippedUnsupportedType` count.
- Counters (`seen/stored/skippedExisting/skippedOversize/
  skippedUnsupportedType/failed`) are returned by both poll and backfill and
  recorded in the `source_sync_runs` result JSON.

Attachment problems never fail message ingestion (fail-soft per attachment).

## Persistence and truncation

Raw events land in `activity_events`; threads are watermarked in
`conversation_watermarks`; the mirror materializes one markdown file per
message. **Deliberate truncation:** materialized bodies cap at
`GMAIL_BODY_MAX_CHARS` (60,000 chars) with an explicit "body truncated" note
pointing at the raw event, which always holds full text. This differs from
Google Docs (never truncated) on purpose: email bodies past 60k are almost
always quoted-reply chains and inline HTML noise, and the full text remains
one lookup away. Revisit if consumers start needing full fidelity in the
mirror itself.

## Label policy: raw events and mailbox placement only (2026-07-09)

**Decision.** Gmail labels remain in raw message and label-change events, but
the message renderer emits no label list (`src/mirror/materializer.ts:2427`).
Only `INBOX` and `SENT` affect the mailbox-style path; their changes re-path
the file between inbox, sent, and archive. `TRASH` and `SPAM` retain their
existing mirror-exclusion behavior, while the content-hash upsert skips graph
ingestion for label-only changes that keep the same path
(`src/mirror/materializer.ts:1202`, `src/mirror/materializer.ts:1949`).

**Why.** Labels such as `UNREAD`, `STARRED`, `IMPORTANT`, and category tabs are
volatile mailbox state. Rendering them caused content rewrites, re-chunking,
and claim churn without changing the message's knowledge content. The path
still preserves the sanctioned mailbox placement, and label transitions stay
queryable as raw `label_added` / `label_removed` events.

**Alternatives rejected.** Rendering every current label leaks operational
mailbox state into graph content. Maintaining a stable-label allowlist is also
rejected for now because no stable label semantics are sanctioned by the
source plan.

**Revisit when.** Reopen only if the source pipeline plan explicitly sanctions
a stable Gmail-label allowlist with defined graph semantics and a churn
analysis.
