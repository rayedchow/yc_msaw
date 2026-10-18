# Jira

Code: `src/integrations/atlassian/`, `src/integrations/nango/`.

## Transport: Nango lane

**Decision.** Jira auth and record transport run through Nango. `/v1/connect/jira`
creates a provisional `connections` row with `status='pending'`, then creates a
Nango connect session for the tenant. Activation is pull-reconciled from
Nango's connections API by dashboard status polling and the `nango.poll` floor;
the Nango auth webhook remains an accelerant. Reconciliation records
`metadata.nangoConnectionId`.

**Why.** Atlassian OAuth setup and sync transport are not the product surface
here; the product contract is uniform raw capture plus markdown mirror. Nango
handles auth and model syncs while Aqueduct owns persistence, redaction,
outbox, and rendering.

## Capture: every model, render Issue now

All generic Nango records now carry an explicit `snapshot` kind (or
`tombstone` when Nango marks deletion). Source namespace/object columns remain
null unless the captured record itself proves both immutable site scope and
object ID; Nango connection IDs and project keys are not substituted for
provider authority (`src/integrations/nango/capture.ts`).

**Decision.** Every Jira model Nango emits is captured into `activity_events`
through the generic Nango processor: full redacted record payload,
`source='jira'`, `event_type=<model>`, version-appended
`source_event_id`, email extraction, and `event.collected` outbox emission.
Unknown models are never skipped.

**Decision.** The polling-floor fan-out only asks Nango for REGISTERED models,
so every sync model the live environment produces is registered
(live-verified 2026-07-08 against the configured Nango env): `Issue`
(rendered) plus raw-only `Project`, `User`, `Field`, `IssueType`,
`ProjectComponent`, `ProjectVersion`. Asking for a model the environment
doesn't know is a safe empty no-op (HTTP 200, zero records — live-verified),
so registration can lead the dashboard config.

**Decision.** `Issue` records additionally materialize
`sources/jira/<PROJECT>/<KEY>.md` with a compact header, ADF description, and
captured comments when present.

**Why.** Capture completeness is irreversible; rendering quality is
regenerable. Issues are useful immediately, while projects/users/changelog and
other models remain available in raw for later renderers.

## Deep content: full issues + comments via the Nango proxy

**Gap (live-verified).** The Nango `issues` sync (v3, JQL search) delivers
`description` but NO comments, and people only as accountIds
(`reporter_id`/`assignee_id`/`creator_id` — no emails or display names). The
template also has no delete tracking, so Jira-side deletions are not surfaced
by the sync.

**Decision.** A `nango.proxy_details` task (300s, scheduled per active jira
connection beside `nango.poll`, disabled together on disconnect) sweeps every
accessible site (`oauth/token/accessible-resources` → cloudId), paging
`/ex/jira/<cloudId>/rest/api/3/search/jql` with
`jql=updated >= "<cursor>" ORDER BY updated ASC`, `fields=*all`, and
`expand=changelog`. Each updated issue captures:

- the FULL issue payload (all fields, attachment metadata, reporter/assignee
  objects with `emailAddress`/`displayName`, edit changelog) as
  `event_type='issue_detail'`, keyed
  `nango:jira:issue_detail:<id>:<fields.updated>` — a distinct kind from the
  slim sync record so both stay in the append-only ledger;
- every comment individually as `event_type='issue_comment'`, keyed
  `nango:jira:issue_comment:<commentId>:<updated|created>`, with
  `issueId`/`issueKey` flattened in; when the search payload's comment
  container is truncated (`total > returned`) the per-issue comment endpoint
  is paged for the rest; the inline and paged sets are deduplicated by comment
  id, sorted chronologically, and merged into the payload handed to the mirror
  writer (`src/integrations/nango/proxy-details.ts`);
- a re-materialized mirror file from the full payload (real description +
  comments + reporter identity), and envelope `authorEmail`/`authorName` from
  the reporter plus `updatedByEmail` from the latest changelog history author.

**Decision: standalone comment versions rebuild locally.** `IssueComment` is a
registered processor as well as a proxy-capture kind. When a comment arrives
without a simultaneous detail refresh, it queries the latest locally captured
`issue_detail` (falling back to `issue`) plus the issue's comment-version rows,
then upserts the parent issue mirror. If no parent issue record exists locally,
the comment remains safely captured raw and no mirror is guessed; the next
issue/detail capture supplies the parent. This path is implemented by
`rematerializeJiraIssueFromCapturedComments` in
`src/mirror/materializer.ts`.

**Fan-out bound.** The detail sweep fetches at most 50 comment pages × 100
comments. This is a rendering/fetch fan-out bound, not raw-content truncation:
every fetched comment is still captured independently. If Jira reports more
comments than the merged payload contains, the issue header records the exact
`Comments omitted` count.

**Why.** The issue mirror is the graph trigger, so it must receive the same
complete comment set the raw capture just obtained. Rebuilding standalone
versions from `activity_events` keeps that invariant without another Jira API
call, while the explicit omission count makes the existing provider fan-out
guard visible instead of silently incomplete.

**Alternatives rejected.** Rendering only the search payload preserves the
known overflow gap. Refetching the parent issue for every standalone comment
adds provider traffic even though the parent snapshot normally exists locally.
Writing graph records directly bypasses the mirror-upsert contract.

**Revisit when.** Revisit the 5,000-comment bound if real Jira issues exceed it,
or the local rebuild if Jira supplies a standalone comment without either an
`issueId`/`issueKey` or a previously captured parent issue record.

## Folded-comment provenance: exact raw ref per rendered comment

**Decision.** Jira continues to fold current comments into the parent issue
mirror, but every identifiable `### Comment <id>` section receives a matching
envelope `sourceRefs` entry. Fresh detail renders forward the exact captured
`nango:jira:issue_comment:<commentId>:<updated|created>` key from the comment
capture (`src/integrations/nango/proxy-details.ts:294` and
`src/integrations/nango/proxy-details.ts:389`) into the materializer
(`src/mirror/materializer.ts:572` and `src/mirror/materializer.ts:3874`). A
standalone-comment rebuild instead passes through the exact `source_event_id`
from the selected current ledger row (`src/mirror/materializer.ts:650`),
preserving legacy capture keys rather than reconstructing them. A folded
comment without a captured comment row still renders, but has no invented raw
ref.

**Why.** Evidence extracted from one folded comment must resolve to its own
versioned `activity_events` row, not merely the parent issue snapshot. Keeping
the parent document preserves the settled issue-conversation projection while
the stable heading supplies an anchor usable by the staged-document envelope.

**Alternatives rejected.** Creating one mirror file per comment would split a
single Jira conversation across graph documents. Reconstructing a source key
during local rebuild would point old rows at a key that may never have existed.
Using the parent issue event for every comment loses exact evidence provenance.

**Revisit when.** Revisit the folded shape only when graph ingestion supports
threaded Jira comments as first-class children while retaining a single
parent-conversation retrieval unit.

**Cursor + backfill.** Max `fields.updated` per site is stored in
`conversation_watermarks` (`issue_details:<cloudId>`). First run has no cursor
→ `updated >= "1970-01-01"` = full-history backfill (the same initial filter
the Nango template uses). JQL naive datetimes are read in the API user's Jira
timezone, so the cursor is formatted with a 26h lookback window — any offset
is safe, and the re-scan overlap dedupes on versioned keys (stored=false also
skips the comment fetch and mirror write).

## Deletions and redaction

Deleted Nango records (`_nango_metadata.last_action='DELETED'`) are stored as
`issue.deleted` tombstone events, not overwrites. Jira redaction removes
avatar URLs, ADF media/file URLs, and signed/tokenized URLs before persistence.

**Gap (live-verified).** The `issues` sync template does no delete tracking —
unlike every other jira model — and the proxy detail sweep reads live REST
(deleted issues simply stop appearing from `updated >=` pages), so neither
lane ever surfaces an issue deletion on its own.

**Decision: deletion reconcile sweep (not webhooks).** A Jira deletion webhook
needs admin registration plus a public receiver contract; a pull-based
reconcile inside the existing `nango.proxy_details` jira lane
(`maybeReconcileJiraIssueDeletions` in `src/integrations/nango/proxy-details.ts`)
is cheaper and self-contained:

- **Cadence.** The task fires every 300s, but the reconcile is gated to once
  an hour by a `conversation_watermarks` row (model `issue_deletion_sweep`,
  granola-style). First run only baselines the watermark — the sweep starts
  one interval later, after the initial backfill has filled the captured set.
- **Enumeration.** Captured issue ids come from one GROUP BY over the tenant's
  `activity_events` (`issue`/`issue_detail` kinds plus their `.deleted`
  tombstones; already-tombstoned ids are excluded). Keys carry no cloudId
  (`nango:jira:issue:<id>:<version>`), so the diff spans every accessible site.
- **Listing diff.** Each site is paged with `search/jql`
  (`jql=ORDER BY created ASC`, `fields=id`, 1000/page, 100-page cap) — ids
  only, cheap. Captured ids absent from the union listing are candidates. A
  truncated listing is flagged (`listingIncomplete`) but stays safe: it can
  only cause extra confirm fetches, never false tombstones.
- **404-confirm guard.** Only a direct
  `GET /rest/api/3/issue/{id}?fields=id` returning 404 on EVERY accessible
  site proves deletion — moved/renamed issues still fetch by id, and 403/5xx
  or network failures count as `confirmFailed` and retry next sweep. At most
  500 confirms per sweep; the remainder defers.
- **Tombstone.** Confirmed deletions append an `issue.deleted`
  `activity_events` row with the stable key `nango:jira:issue:<id>:deleted`
  (ON CONFLICT DO NOTHING — idempotent re-runs), then delete the mirror file
  via `deleteJiraIssueSourceWiki`, with a single index refresh per sweep.
- **Fail-soft.** Enumeration/listing failure logs, tombstones nothing, and
  backs the watermark off a full interval; all outcomes are counted in the
  sync-run stats (`deletionReconcile`), never silently skipped.

## Rate notes

Nango owns Jira sync polling and provider API backoff. Aqueduct only pages
Nango records and uses the local task queue's per-tenant group serialization.
VERIFY-LIVE: exact Jira provider config key, model names, and webhook payload
shape must be confirmed against the configured Nango environment before a live
lane is declared done.
