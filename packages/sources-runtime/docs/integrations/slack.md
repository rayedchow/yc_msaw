# Slack

Code: `src/integrations/slack/`.

## Auth: user-token OAuth v2

**Decision.** Slack connects through OAuth v2 using `user_scope` and stores the
`authed_user.access_token` in the Aqueduct vault. Bot-token sync is out of
scope.

- Threaded messages: messages sharing `thread_ts` are one conversation window
  regardless of time gaps. Threads only split when the 80,000-character cap
  would be exceeded; split parts use deterministic suffixes. Threads never
  crumb-skip, because even short threads are intentional conversation structure.
- Unthreaded channel chatter: messages without `thread_ts` are cut by the
  source-agnostic session assembler using the defaults: 5-hour timestamp gap,
  80,000-character cap, and a 500-character crumb floor.
- Crumbs: unthreaded session windows under 500 characters are counted and
  skipped for mirror materialization. The original text remains retained in
  `activity_events`.
- Duplicate stored rows: when channel history and thread polling store the same
  Slack message under different source IDs, the bridge dedupes by Slack `ts`
  and keeps the row with threaded attribution when present.
- Slack mrkdwn fidelity: user mentions are resolved at storage time where
  possible by stamping `_mentions` on the message payload. The window bridge
  uses that per-message stamp first, then a deterministic workspace fallback
  directory built from the latest stored `_user_name` for each Slack user ID.
  Unresolved `<@U...>` tokens remain verbatim so the ID is never lost. If a
  display name changes, fallback-rendered windows may re-render; that rename
  churn is accepted because the rendered content changed.
- Reactions: message `reactions` arrays render inline as a suffix on the same
  message line, for example `[reactions: :thumbsup:×3 (Dana Ruiz, Alex, Blair),
  :white_check_mark: (Zach)]`. Reaction names stay in Slack `:name:` form,
  counts render only when greater than one, users resolve through the same
  mention directory, and long user lists are capped with `+N more`.
- Poll-path reconciliation: history re-polls insert new messages, but on an
  existing `(user_id, source_event_id)` row they compare text, edit timestamp,
  and reactions. Changed text appends `_edit_history`, changed reactions update
  the payload, and either case resets the event for processing. Identical
  re-polls are no-ops and do not enqueue work.

**Why.** The product contract is per-user visibility: DMs, private channels,
MPIMs, and any public/private channels the user can see. Bot-token sync only
sees conversations the bot can access and would miss user-private surfaces.

Reconnects are workspace-locked. If token metadata already has `slackTeamId`,
or a non-revoked `connections` row pins a team (`external_account_id` /
`metadata.slackTeamId`), the connect path rejects an incoming token for a
different workspace — silently switching would corrupt per-channel watermarks
and raw continuity. The OAuth callback surfaces the rejection reason verbatim
(our own message, never provider payload); a tenant must disconnect before
changing workspaces. Same-team reconnects proceed normally.

## Change detection: socket-primary, polling as gap-fill

**Decision.** Socket Mode is the PRIMARY capture path for messages, edits,
deletions, and reactions; it is on by default (opt out with
`SLACK_SOCKET_MODE_ENABLED=false`; it no-ops with a log if `SLACK_APP_TOKEN`
is unset). Polling remains enabled at all times as the backfill/gap-fill
safety net: `slack.discover` every 180 seconds and `slack.poll` every 900
seconds (15 min) in the same `${tenantId}:slack` task group.

**Why.** Shepherd's Slack app is a distributed non-Marketplace app, so
`conversations.history`/`conversations.replies` are capped at ~1 request/min
(see Rate notes) — polling cannot be the freshness path; a 60s poll would
permanently saturate that budget. Sockets alone can still miss events during
app/socket outages, so the poller stays on as the reconciliation floor at a
cadence that honors the 1/min history limit; socket outage recovery
additionally runs a poll gap-fill.

## Capture and mirror shape

Messages land in `activity_events` with:

- `source = 'slack'`
- `event_type = 'message'` for message rows, including thread replies and bot
  messages
- `source_event_id = slack:<channelId>:<ts>`
- `source_namespace = workspace:<teamId>` and
  `source_object_id = message:<channelId>:<ts>`
- `record_kind = activity` for messages/edits/reactions/lifecycle and
  `tombstone` for deletes
- redacted `raw_payload` through `redactProviderPayload("slack", ...)`
- Slack user entities plus `email_contact` when `users.list` exposes email

The dual mirror is regenerated from stored events, never live Slack:

```text
sources/slack/<channelId>/<YYYY-MM-DD>.md
sources/slack/<stable-channel-directory>/threads/<thread-ts>.md
sources/slack/<stable-channel-directory>/sessions/<window-start>.md
```

The channel-day path is channel-ID based, not channel-name based, so Slack
channel renames do not move it. The day key is UTC. Day files remain the
operational projection; session/thread window files carry the conversation
clock and are Slack's graph representation.

## Append-only change ledger (edits, deletes, reactions)

**Decision.** `activity_events` is the change ledger. Every observed edit,
deletion, and reaction is ALSO appended as a NEW row with a versioned
`source_event_id` (idempotent via `ON CONFLICT DO NOTHING`):

- edit: `event_type = 'message.edited'`,
  `slack:<channelId>:<ts>:edit:<editTs>` (full `message_changed` payload,
  including Slack's `previous_message` snapshot)
- delete: `event_type = 'message.deleted'`,
  `slack:<channelId>:<deletedTs>:delete:<eventTs>` — appended even when the
  original message was never captured
- reaction: `event_type = 'message.reaction_added' | 'message.reaction_removed'`,
  `slack:<channelId>:<itemTs>:reaction:<name>:<user>:<eventTs>` — versioned by
  the reaction event's own ts, so re-adding after removal stays distinct

Original message payloads are immutable. Edit/delete/reaction rows carry the
target message timestamp in `_object_ts`; no handler rewrites `_edit_history`,
`_deleted`, or `reactions[]` on the original row. Ledger rows carry
`_ledger: true`. Folding these rows into the current staged day/window view is
renderer work and remains outside this Phase-1 capture change.

Edits/deletes/reactions are only observed via Socket Mode; the poller does not
re-fetch already-stored messages (watermark-bounded), so socket outages can
miss ledger rows for old messages. The gap-fill poll recovers new messages,
not historical edit diffs — accepted.

## Subtypes, bots, lifecycle events, and no-silent-skips

**Decision.** Capture EVERY message subtype, including `channel_join` and
`channel_leave` (they are real channel-timeline messages and render in the
day file). Bot messages are captured; when no Slack user id is present, the
bot id/name is retained as metadata instead of fabricating a user.

**Decision.** Channel lifecycle events without a message `ts`
(`channel_rename`, `channel_archive`, `member_joined_channel`, ... — whatever
the socket delivers) are captured as append-only ledger rows keyed
`slack:<channelId>:<eventType>:<eventTs>`.

**Decision.** Nothing is silently dropped. Any event the capture paths cannot
store increments a skip counter (`src/integrations/slack/skips.ts`); the next
`slack.poll` / backfill sync run drains the counters into its
`source_sync_runs` result JSON as a `skips` object keyed by reason.
Realtime events that cannot be attributed to a connected tenant are counted
worker-globally (counts only, never content) and drain into whichever
tenant's poll run happens next.

## Files and attachments

**Decision.** File metadata always lands (redacted) inside the message's raw
payload. File BYTES are additionally captured into the existing S3 +
`binary_documents` lane (`provider = 'slack'`, `external_id` = Slack file id,
version-deduped on `<fileId>:<created>`):

- Downloads use the stored user token against `url_private_download` /
  `url_private` with a Bearer header, throttled in the `files.download` rate
  bucket. Credentialed URLs still never persist — the redaction pass scrubs
  `url_private*`, `permalink_public`, and `thumb_*` from raw payloads; only
  file ids/names do.
- Files >25MB skip bytes with a `file_bytes_over_25mb` counter (metadata-only
  capture). External/tombstoned files without a private URL count
  `file_no_download_url`.
- PDFs enter as `parse_status = 'pending'` (parse pipeline); all other mime
  types are stored as `parse_status = 'stored'` (raw capture, no parser).

Canvas/snippet content extraction remains out of scope beyond the bytes and
metadata above.

## Threads and windowing

Conversation history polling advances `conversation_watermarks.last_seen_ts`
per channel. Messages with replies register `thread_watermarks`; the thread
poller then fetches replies with `conversations.replies`. Thread replies keep
their own Slack message timestamp in the source event id and keep `thread_ts`
inside raw payload metadata.

The first poll of a conversation with no watermark issues
`conversations.history` with NO `oldest` bound and paginates to exhaustion
(`maxPagesPerChannel` defaults to unlimited), so connecting Slack backfills
the FULL visible history of every discovered conversation — not just
connect-time-forward. Threads found on that pass register with a null
`lastReplyTs`, so the thread poller fetches all replies. This is
watermark-driven, not a separate backfill job: an interrupted first poll
leaves the watermark unset and retries from scratch (dedup via
`ON CONFLICT DO NOTHING`). Verified in
`tests/integrations/slack/poller-backfill.test.ts`. Under the non-Marketplace
rate regime (see Rate notes) a full-history first poll proceeds at ~15
messages/minute/workspace — connect-time backfill of large workspaces takes
correspondingly long; this is the stated cost of staying inside the budget,
and Socket Mode keeps new traffic fresh in the meantime.

## Session-window generation: queued per channel after day rewrites

**Decision.** Every poller or Socket Mode mutation that rewrites a channel-day
file also enqueues `slack.windows` for that channel
(`src/integrations/slack/poller.ts:243`,
`src/integrations/slack/realtime.ts:201`). The enqueue helper in
`src/integrations/slack/windows.ts:6` serializes by
`${tenantId}:slack-windows:<channelId>` and dedupes active tasks with a
channel-specific five-minute bucket. `mirror.backfill` includes Slack and
enumerates stored message channels in `src/mirror/backfill.ts:320`, so existing
history gets windows without waiting for a new Slack event. The window loader
in `src/mirror/backfill.ts:194` renders current-state rows marked
`_deleted=true` as `[deleted]`, matching the day renderer without retaining the
original message text.

**Why.** Window materialization rebuilds and atomically replaces one channel's
complete thread/session directory. A per-channel queue group prevents two
rebuilds from racing, while the bucketed dedupe collapses poll pages and Socket
Mode bursts. Writing the mirror files already invokes graph ingestion, so the
window task must not enqueue graph work separately.

**Alternatives rejected.** Graphing channel-day files was rejected because
they lack the conversation-clock boundaries. Rebuilding windows synchronously
for every individual message was rejected because history pages and realtime
bursts would repeatedly scan and replace the same channel directory.

**Revisit when.** Replace the full-channel rebuild only when the window
materializer supports an incremental update that preserves deterministic
thread/session splitting, crumb removal, and vanished-file deletion.

## Rate notes

**Decision (2026-07-08, classification confirmed).** Shepherd's Slack app is
a DISTRIBUTED, non-Marketplace app (installed on multiple workspaces,
unpublished). Under Slack's 2025 non-Marketplace regime that means
`conversations.history` and `conversations.replies` are limited to
**~1 request/minute and 15 messages/request**. Enforced proactively in
`src/integrations/slack/rate-limit.ts`:

- `SLACK_HISTORY_RPM` (default 1) sets the history/replies bucket rate;
  `SLACK_HISTORY_PAGE_LIMIT` (default 15) caps the `limit` param on every
  history/replies page. Both are env-overridable so a future Marketplace
  listing (which restores the `50+`/min, 1,000-object tier) needs no code
  change.
- Other methods keep their per-method tiers (`conversations.list`/`users.list`
  18/min, `users.info` 90/min, ...); the 2025 change affects only
  history/replies.
- Reactive handling is unchanged: `ratelimited` responses honor `Retry-After`
  with bounded retries.

Because of this budget, Socket Mode is the primary capture path and
`slack.poll` runs at a 900s gap-fill cadence (see Change detection).

Background, per Slack docs:

- Slack’s Web API limits are per method, per workspace/team, per app; rate
  windows are per minute.
- Slack’s May 29, 2025 changelog: commercially distributed non-Marketplace
  apps created after that date, and net-new installs of existing apps, are
  limited to 1 request/minute and 15 objects/request for
  `conversations.history` and `conversations.replies`.
- Marketplace apps and internal customer-built apps are not impacted; those
  retain the higher `50+` requests/minute and `1,000` object limit for those
  methods.

Sources:

- https://docs.slack.dev/apis/web-api/rate-limits/
- https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/
