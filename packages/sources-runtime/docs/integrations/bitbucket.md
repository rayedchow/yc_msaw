# Bitbucket

Generic Nango capture now writes an explicit `snapshot` kind (or `tombstone`
for a deleted record). Source identity remains fail closed when a record does
not carry an immutable repository UUID/global scope; workspace/repository
display paths are not raw identity (`src/integrations/nango/capture.ts`).

Code: `src/integrations/bitbucket/`, `src/integrations/nango/`.

## Transport: Nango lane

**Decision.** Bitbucket auth and record transport run through Nango. `/v1/connect/bitbucket`
creates the local connection row first, then creates a Nango connect session
for provider config key `bitbucket`. Activation is pull-reconciled from
Nango's connections API by dashboard status polling and the `nango.poll` floor;
the Nango auth webhook remains an accelerant.

**Why.** Bitbucket is in the shared Nango lane: Aqueduct owns durable capture,
redaction, outbox emission, and mirror rendering while Nango owns OAuth and
provider sync transport.

## Capture: every model, render issues, PRs, and repos

**Decision.** Every Bitbucket model emitted by Nango is captured. Registered
processors render `PullRequest` and `Repository`; commits, branches, tags,
pipelines, and future models ride generic Nango capture. Issues are captured
and rendered by the proxy sweep described below.

**Decision.** The polling-floor fan-out only asks Nango for REGISTERED models,
so all eight live sync models are registered (live-verified 2026-07-08):
the three rendered ones plus raw-only `Branch`, `Pipeline`, `Tag`,
`Workspace`, `WorkspaceMember`.

**Decision.** Pull requests materialize
`sources/bitbucket/<workspace>/<repo>/pr-<id>.md` with title, state, author,
and description. Repositories materialize
`sources/bitbucket/<workspace>/<repo>/repo.md` as the repo existence record.
Commits remain raw events only and emit author email identity when available.

**Why.** PR and repository docs are useful immediately and regenerable from
raw. Commit payloads are an identity and future S5 wake signal; no code content
belongs in this sourcing-plane connector.

## Issues capture: via the Nango proxy, not a sync template

**Decision.** Nango's bitbucket sync template offers **no `issues` sync** (only
branches/commits/pipelines/pull-requests/repositories/tags/workspace-members/
workspaces). Issues are captured via Nango's **PROXY API** on our own schedule:
a `nango.proxy_issues` task (300s, scheduled per active bitbucket connection
alongside the `nango.poll` floor) pages
`GET /repositories/{workspace}/{repo}/issues?sort=updated_on` through the stored
connection. Repos are discovered from already-captured `event_type =
'repository'` events for the tenant (no new repo discovery added); with none
captured yet the task is a counted no-op.

**Issue tracker disabled → 404 is not an error.** Many Bitbucket repos have the
issue tracker turned off, so the endpoint returns **404**. That's treated as
"no issue tracker" — a counted skip (`trackersDisabled`), never a failure.

**Capture path + key.** Each issue is redacted (provider redaction registry,
pre-persist) and fed through the same generic Nango capture as every other
record, model `issues`, keyed `nango:bitbucket:issues:<workspace>/<repo>#<id>:<updated_on>`
— the id component is **repo-qualified** because Bitbucket issue ids are only
unique per repo (unlike GitHub's global ids), and `updated_on` is the version.
Cursor: the max `updated_on` seen is stored per (tenant, connection, repo) in
the shared `conversation_watermarks` cursor and applied as a
`q=updated_on > "<cursor>"` filter on the next run. Nango owns provider backoff;
the proxy honors `Retry-After`.

VERIFY-LIVE (blocked on a real Bitbucket connection): repository record
`full_name` shape for repo discovery, issue payload fields, and the `q`/`sort`
query behavior on the live issues endpoint.

**Issue comments (rides the issues sweep).** Bitbucket has no repo-wide
comments endpoint, so when an issue stores a NEW version, its comments are
paged from `/repositories/{ws}/{repo}/issues/{id}/comments` and captured as
`event_type='issue_comment'`, keyed
`nango:bitbucket:issue_comment:<ws>/<repo>#<issue>#<comment>:<updated_on>`.
Unchanged issue versions (dedupe no-op) skip the comment fetch; re-fetch
overlap dedupes on the versioned keys. 403/404 are tolerated stops.

**Issue mirror.** After each newly captured issue and its comment batch, the
sweep materializes
`sources/bitbucket/<workspace>/<repo>/issue-<id>.md` with title, state,
reporter, created/updated timestamps, body, and current comments
(`src/integrations/nango/proxy-issues.ts`, `src/mirror/materializer.ts`).
The sweep-to-render handoff is at
`src/integrations/nango/proxy-issues.ts:217`; the issue writer begins at
`src/mirror/materializer.ts:828`.

**Why.** Issues are graph-covered source documents, and the raw issue/comment
ledger makes the mirror deterministic and regenerable without another
provider request.

**Alternatives rejected.** Keeping issues raw-only leaves an audit-confirmed
graph coverage gap. A separate comments document would split the discussion
from the issue/PR users navigate and search.

**Revisit when.** Revisit the file shape if graph ingestion gains a native
threaded issue/PR conversation document kind.

## PR details + comments: the `nango.proxy_details` sweep

**Gap (live-verified).** The bitbucket pull-requests sync model is SLIM:
id/title/state/dates/author_uuid/branches/counters — **no description, no repo
full name, no author display name**. The rendered `pr-<id>.md` would carry no
content from sync records alone.

**Decision.** A `nango.proxy_details` task (300s, per active bitbucket
connection, disabled together on disconnect) lists updated PRs per captured
repo — `GET /repositories/{ws}/{repo}/pullrequests` with
`sort=updated_on` and a `q` filter that opts into EVERY state
(`state = "OPEN" OR "MERGED" OR "DECLINED" OR "SUPERSEDED"` — the endpoint
defaults to OPEN only) plus `updated_on > "<cursor>"` — then per updated PR:

- fetches the full detail `GET .../pullrequests/{id}` (description,
  reviewers, participants) and captures it as `pull_request_detail`, keyed
  `nango:bitbucket:pull_request_detail:<ws>/<repo>#<id>:<updated_on>` — a
  distinct kind, coexisting with the slim sync record;
- pages `GET .../pullrequests/{id}/comments`, capturing each as
  `event_type='pr_comment'`, keyed
  `nango:bitbucket:pr_comment:<ws>/<repo>#<pr>#<comment>:<updated_on>`;
- re-materializes `pr-<id>.md` from the full payload.

Cursor: max `updated_on` per repo in `conversation_watermarks`
(`pr_details:<ws>/<repo>`). First run has no cursor → full PR history
backfills. Unchanged PR versions skip comments + mirror via key dedupe.

## Mirror comments: fold current state and bound fan-out

**Decision.** Issue and PR mirrors rebuild their `## Comments` section from
captured `issue_comment` / `pr_comment` rows. Versions fold by provider comment
id; deleted current states are omitted. Mirrors keep the latest 200 live
comments and print both the total count and earlier-comments omitted count when
truncated (`BITBUCKET_COMMENTS_MAX`; folding begins at
`src/mirror/materializer.ts:3025`). Each rendered `Comment <id>` heading also
has a staged-envelope `sourceRef` whose anchor is that stable heading and whose
`sourceEventId` is the exact selected comment-version row —
`nango:bitbucket:<issue_comment|pr_comment>:<ws>/<repo>#<parent>#<comment>:<updated_on>`.
The PR and issue materializers add those refs at
`src/mirror/materializer.ts:926` and `src/mirror/materializer.ts:976`;
the ref uses `sourceEventId`, never a content-hash fallback.

**Why.** Rebuilding from the raw version ledger preserves edits while bounding
document size and graph fan-out for unusually busy threads. Counting the
truncation makes the loss visible instead of silently presenting a partial
thread as complete. The per-comment ref lets evidence extracted from folded
comment text resolve to the durable raw version that supplied that exact text.

**Alternatives rejected.** Rendering every captured version duplicates edits;
unbounded current comments can produce pathological mirror documents; silently
dropping older comments hides the boundary. A parent-only source ref would make
comment evidence ambiguous, while separate comment documents would split the
discussion from its issue or PR.

**Revisit when.** Revisit the 200-comment bound if graph ingestion supports
paged comment subdocuments or production telemetry shows legitimate threads
routinely exceeding the cap, or if the capture key no longer contains a
versioned comment identity.

## PR path reconciliation: remove provisional unknown-repo mirrors

**Decision.** When a later PR detail identifies the real repository, the PR
materializer deletes the provisional
`sources/bitbucket/unknown-repo/pr-<id>.md` through the standard mirror deletion
helper before writing the repository-qualified path.
The reconciliation is in `src/mirror/materializer.ts:788`.

**Why.** Slim Nango PR records can arrive without repository identity. Keeping
the provisional file after full proxy detail arrives creates two graph-visible
documents for one PR; the standard helper also preserves graph delete
propagation.

**Alternatives rejected.** Direct SQL deletion bypasses graph delete hooks;
leaving the provisional row creates an orphan; delaying all slim PR rendering
would discard useful early state.

**Revisit when.** Remove this reconciliation only if the Nango Bitbucket PR
model always includes stable repository identity before any record is emitted.

## PR review activity: approvals rides the `nango.proxy_details` sweep

**Gap.** The Nango template ships a `list-pr-activity` **action** but no sync —
approvals, requested changes, and update events were invisible.

**Decision.** The bitbucket `nango.proxy_details` sweep also pages
`GET /repositories/{ws}/{repo}/pullrequests/{id}/activity` and captures each
non-comment entry as a raw `event_type='pr_activity'` event. The raw entry keeps
its kind member (`approval` / `changes_requested` / `update`) plus a flattened
`activity_kind`, `repo_full_name`, and `pull_request_id` so downstream can split
approval vs changes-requested vs update from `raw_payload` alone. Raw-only —
no dedicated mirror file; the PR detail mirror (`pr-<id>.md`) renders a
"Reviews" section (current verdict per reviewer) from the detail payload's
`participants`.

**Key scheme.** Activity entries have **no ids**, so keys are built
deterministically from stable parts:
`nango:bitbucket:pr_activity:<ws>/<repo>#<prId>:<kind>:<actor>:<date>`
(actor = user/author `uuid` > `account_id` > `nickname` > `display_name`).
Entries missing any component fall back to the generic content-hash key —
still deterministic, so re-scans dedupe to ON CONFLICT no-ops either way.
**Comment-type entries are skipped (counted `activityCommentEntries`)** — the
comments lane already captures those payloads with real ids.

**Cursor / trigger — the updated_on assumption is NOT relied on.** Bitbucket
does not document that approvals bump the PR's `updated_on`, and its
webhook/pipeline taxonomy treats reviewer-status changes
(`pullrequest-reviewer-status-updated`) as a separate category from
`pullrequest-updated` — so approvals are assumed NOT to re-enter the
cursor-filtered PR listing. Activity is therefore swept on two triggers:

1. **Riding the detail capture**: when a PR stores a NEW detail version
   (first-run backfill captures the full historical activity feed this way,
   and any content/state change re-sweeps).
2. **Bounded window re-scan, every run**: per repo, PRs matching
   `state = "OPEN" OR (any state AND updated_on > now-14d)` (newest first,
   ≤ 4 listing pages) get their activity re-paged. Overlap with trigger 1 is
   deduped per run (a shared swept-set) and across runs by the deterministic
   keys. VERIFY-LIVE: if approvals turn out to bump `updated_on`, the window
   pass is redundant-but-free and could be dropped.

**Paging + caps.** The activity endpoint paginates with opaque-`ctx` `next`
URLs (numeric `page` is not honored); the sweep follows `next` up to
20 pages per PR at `pagelen=50`. 403/404 on the feed or window listing are
counted, logged skips (`activityForbidden`), same as the other bitbucket
lanes. Sweep stats expose `activityPrs` / `activityPages` /
`activityCaptured` / `activityCommentEntries` / `activityForbidden`.

**Repo discovery fallback.** When no `repository` events exist yet, the sweep
walks `GET /workspaces` → `GET /repositories/{workspace}` and feeds each repo
through the registered Repository processor (raw event + `repo.md`), seeding
both proxy lanes' discovery.

**KNOWN-EXTERNAL (2026-07-08).** The dev Bitbucket connections currently get
HTTP 403 Forbidden on repository-scoped proxy endpoints (`/repositories?...`,
`/user`) while `/workspaces` works — the Nango dashboard's Bitbucket OAuth
consumer lacks the `repository`/`issue`/`pullrequest` scopes. All proxy lanes
tolerate 403 as counted, logged skips, so they idle visibly until the scopes
are added in the Nango dashboard (external action).

## Deletions and redaction

Deleted records use Nango deletion metadata (`_nango_metadata.last_action`) and
are stored as tombstone events. Rendered PR/repo files are removed when the
tombstone still carries enough repo/id shape to address the mirror path.

Bitbucket `links.*.href` values are not credentials by default and are kept.
Global signed/tokenized URL redaction still applies.

## Code indexing is out of scope

No cloning, parsing, README capture, file ingestion, pipelines rendering, tags,
or codebase descriptions are part of this lane. Code indexing is deferred to
Ishan's S5 code-indexer track.

## Rate notes

Nango owns Bitbucket sync cadence and API backoff. Aqueduct pages Nango records
with cursor recovery and the shared `nango.sync_records` source-sync wrapper.
VERIFY-LIVE: provider config key, exact model names, repo UUID/full-name fields,
and PR base/head fields must be confirmed against the configured Nango syncs.
