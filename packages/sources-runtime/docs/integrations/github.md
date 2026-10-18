# GitHub

Generic Nango capture now writes an explicit `snapshot` kind (or `tombstone`
for a deleted record). Source identity remains fail closed when a record does
not carry enough immutable repository/global scope; paths and display names are
never promoted into raw identity (`src/integrations/nango/capture.ts`).

Code: `src/integrations/github/`, `src/integrations/nango/`.

## Transport: Nango lane

**Decision.** GitHub auth and record transport run through a Nango GitHub App
configuration. `/v1/connect/github` creates the local connection row first,
then creates a Nango connect session for provider config key `github`.
Activation is pull-reconciled from Nango's connections API by dashboard status
polling and the `nango.poll` floor; the Nango auth webhook remains an
accelerant.

**Why.** The source-pipeline contract is capture completeness, redaction, and
deterministic mirror output. Nango handles GitHub App OAuth/installation
transport while Aqueduct owns persistence and rendering.

## Capture: every model, render issue, PR, and repo now

**Decision.** Every GitHub model emitted by Nango is captured. Registered
processors render `Issue`, `PullRequest`, `Commit`, and `Repository`; unknown
models such as releases or workflow records stay durable through generic Nango
capture until explicitly promoted.

**Decision.** The current github-app TEMPLATE names its models
`GithubPullRequest`/`GithubCommit` (GraphQL-shaped and slim: no body, number,
merged flag, or repo full name on PRs). Both are registered as raw-only
generic-capture aliases so whichever model naming the live environment runs,
records land in the ledger; asking for a model that doesn't exist is a safe
empty no-op (live-verified). The slim shapes are never mirror-rendered — the
proxy detail lane below owns complete PR content.

**Decision.** Issues materialize
`sources/github/<owner>/<repo>/issue-<number>.md`. Pull requests materialize
`sources/github/<owner>/<repo>/pr-<number>.md` with state, draft, merged, and
review-decision header fields when present. Repositories materialize
`sources/github/<owner>/<repo>/repo.md` as the repo existence record.

**Decision.** Repo keying prefers GitHub's immutable numeric repository id
(`repoId`, `repository.id`, or equivalent) and falls back to full name when the
id is absent. The mirror path and markdown metadata still include the full
name so humans can browse by owner/repo.

**Why.** Numeric ids survive rename and transfer. The full name remains the
best browsing affordance but is not the durable external id when Nango provides
the numeric repo id.

## Issues capture: via the Nango proxy, not a sync template

**Decision.** Nango's github-app sync template offers **no `issues` sync** (only
commits + pull-requests syncs and a repositories action). Issues are therefore
captured via Nango's **PROXY API** on our own schedule: a `nango.proxy_issues`
task (300s, scheduled per active github connection alongside the `nango.poll`
floor) pages `GET /repos/{owner}/{repo}/issues?state=all&since=<cursor>&per_page=100`
through the stored connection. The repos swept are exactly the tenant's
**enabled selection** (`github_repo_sync` rows with `syncing = true` — see the
selection section below); with nothing enabled the task is a counted no-op.
Every GitHub run opens with the selection reconcile (below). For a repo no
longer in the enabled set, it appends a `repository.moved_out_of_scope`
tombstone, then removes the current mirror projection; it does not destroy raw
history before sweeping the enabled repos.

**PR-filtering rule (load-bearing).** GitHub's issues endpoint returns pull
requests too. Items carrying a `pull_request` field are **filtered out** of the
`issues` model here — they're captured by the pull-requests sync, and capturing
them again would double-count. Only true issues are persisted as issues.

**PR detail fetch (rides the filter).** Because the sync template's PR model
is slim (no body/number/merged/repo), each filtered PR item triggers a full
REST `GET /repos/{owner}/{repo}/pulls/{number}` through the proxy, captured as
a DISTINCT kind `pull_request_detail`
(`nango:github:pull_request_detail:<owner>/<repo>#<number>:<updated_at>`) so
slim sync records and full details coexist in the append-only ledger. A newly
stored detail version re-materializes `pr-<number>.md` with the full body.
PR items also advance the repo's `since` cursor (the detail fetch is bounded
by it), and 404s on the detail fetch are tolerated skips.

**Capture path + key.** Each issue is redacted (provider redaction registry,
pre-persist) and fed through the same generic Nango capture as every other
record, model `issues`, keyed `nango:github:issues:<issue-id>:<updated_at>`
(GitHub issue ids are globally unique; `updated_at` is the version so a re-fetch
of an unchanged issue dedupes and an edit appends a new version). Each newly
stored proxy issue then uses the shared registered-processor render helper in
`src/integrations/github/processors.ts:82` to materialize
`sources/github/<owner>/<repo>/issue-<number>.md`; there is one issue markdown
format, not a proxy-specific fork. Cursor: the
max `updated_at` seen is stored per (tenant, connection, repo) in the shared
`conversation_watermarks` cursor (`issues:<owner>/<repo>`) and passed back as
`since`. Nango owns provider backoff; the proxy honors `Retry-After`.

VERIFY-LIVE (blocked on a real GitHub connection): repositories-action output
shape (`full_name` presence for repo discovery), issue payload fields, and that
the proxy connection scope permits reading issues.

## Comments + repo discovery: the `nango.proxy_details` sweep

**Decision.** No comments sync exists in the github-app template, so a
`nango.proxy_details` task (300s, scheduled per active github connection,
disabled together on disconnect) sweeps two repo-wide REST endpoints per
captured repo, both `sort=updated&direction=asc` with a per-repo `since`
cursor in `conversation_watermarks`:

- `GET /repos/{owner}/{repo}/issues/comments` → `event_type='issue_comment'`,
  keyed `nango:github:issue_comment:<id>:<updated_at>` — covers conversation
  comments on BOTH issues and PRs;
- `GET /repos/{owner}/{repo}/pulls/comments` →
  `event_type='pr_review_comment'`, keyed
  `nango:github:pr_review_comment:<id>:<updated_at>` — inline review comments.

First run has no cursor → full comment history backfills. 404s are counted
skips.

## Comment rendering: current state folded into parent mirrors

**Decision.** GitHub issue and PR mirrors include a `## Comments` section.
Conversation comments are matched to the parent by `issue_url`; inline review
comments are matched by `pull_request_url`. The renderer queries versioned
`activity_events` with `DISTINCT ON (raw_payload->>'id')`, keeps the latest
version of each comment, excludes a latest `.deleted` version, selects the
latest 200 live comments, then renders that bounded set in chronological order
with author, updated timestamp, and body (`src/mirror/materializer.ts:3230`).
When more than 200 are live, the section states the rendered total and exact
number of earlier comments omitted. A newly stored comment batch collects its
affected issue/PR parents and rematerializes each once through the standard
mirror upsert (`src/integrations/nango/proxy-details.ts:693`); content changes
therefore use the existing graph-ingest hook with no direct graph enqueue.

**Why.** The graph ingests mirror files rather than raw events, while GitHub
comments are append-only versioned capture rows. Rebuilding current state from
the ledger makes edits and tombstones deterministic, and the explicit 200-row
fan-out bound prevents a single conversation from making its parent mirror
unbounded without silently losing the fact that older comments exist.

**Alternatives rejected.** A separate comments mirror would split issue/PR
context across graph documents. Rendering each captured version would expose
stale edits and deleted bodies. Adding graph enqueues in the sweep would bypass
the standard content-change detection already owned by mirror upsert.

**Revisit when.** Revisit the 200-comment fan-out bound when graph chunking can
preserve complete parent-conversation context across multiple deterministic
mirror documents, or when product requirements call for full comment history
in a separate browsable artifact.

## Exact evidence: folded comments retain their raw-row refs

**Decision.** Each currently rendered GitHub comment contributes an envelope
`sourceRef` whose stable anchor is `Comment <comment id>` and whose
`sourceEventId` is the exact selected versioned raw key. The selector carries
the stored key forward (`src/mirror/materializer.ts:3230`),
`githubCommentSourceRefs` maps it into the envelope
(`src/mirror/materializer.ts:3288`), and the issue/PR writers attach those refs
beside their parent refs (`src/mirror/materializer.ts:1057` and
`src/mirror/materializer.ts:1090`). The rendered heading uses the same stable
anchor (`src/mirror/materializer.ts:3354`). The raw comment key is globally
scoped and versioned at capture
(`src/integrations/nango/proxy-details.ts:752`), so the ref uses that exact
Nango value as-is rather than re-keying it by mutable `owner/repo`. This is
distinct from the parent source-object namespace: parent issue/PR raw ids keep
the immutable `repoKey` convention (`src/integrations/github/processors.ts:67`
and `src/integrations/github/processors.ts:120`).

**Why.** An extracted claim from a folded comment must resolve to the precise
append-only raw version that supplied it, including a later edit. The parent
record ref alone can only identify the issue/PR snapshot, not the specific
comment body.

**Alternatives rejected.** Numbering comments by rendered position makes an
anchor change when truncation or ordering changes. Synthesizing an event key
from the visible document risks drifting from the capture key. Separate
comment documents would break the settled parent-conversation projection.

**Revisit when.** Revisit this mapping if GitHub changes comment identity or
version semantics, or if the graph gains a native threaded-conversation source
object that supersedes folded parent mirrors.

**Repository-record re-seed (enabled repos only).** The github sweep set here
is also the enabled selection. An enabled repo can lack a current materialized
`repository` record — its prior in-scope record was followed by an
out-of-scope tombstone and its projection was removed while the repo was
unselected (the template only ships a repositories *action*, so nothing
re-delivers it). For exactly those repos the sweep lists
`GET /installation/repositories` and feeds the matching entries through the
registered Repository processor — raw `repository` event (sync-convention key
`github:repo:<id>:<updated>`) + `repo.md` mirror — restoring the numeric-repo-id
identity for the newly enabled projection. Unselected repos are deliberately
NOT captured here (the reconcile will tombstone their current projection on the
next cycle).
401/403/404 (app-permission gaps) are counted, logged stops, never crash
loops.

## Per-repo sync selection (`github_repo_sync`)

**Decision.** Which repos sync is a per-tenant selection stored in
`github_repo_sync(tenant_id, repo_full_name, syncing, updated_at)`. The
default is **OPT-IN**: a repo syncs ONLY when it has an explicit selection row
with `syncing = true`. No row (or `syncing = false`) = not synced — a fresh
connection syncs nothing until the tenant adds a repo. (This reversed the
original sync-all default by explicit product direction: "don't sync any repos
by default, they have to add one".)

**The selection IS the sweep set.** For github, `discoverRepos` (the shared
chokepoint feeding `nango.proxy_issues` and `nango.proxy_details`) returns the
enabled selection directly — deliberately NOT derived from captured
`repository` events, because the reconcile below removes the current projection
for unselected repos and a just-enabled repo must sweep (backfill) before a
current record of it exists. An enabled repo the installation lost access to
404s as a counted skip. Bitbucket keeps event-based discovery (no selection
table).

**Opt-in is enforced against data at rest (reconcile).**
`reconcileGithubRepoSelection` (`src/integrations/github/repo-sync.ts`) runs
at the start of every github `nango.proxy_issues` sweep (300s, inside the
task's `source_sync_run` recording): it enumerates the repos that currently
have captured data — distinct full names from `repository` events UNION repo
directories under `sources/github/<owner>/<repo>/` in `mirror_files` — and
appends a `repository.moved_out_of_scope` tombstone and removes the current
mirror projection for every repo not in the enabled set. It preserves the prior
`activity_events` rows, so raw history remains available while the current
source-library projection contains only enabled repos. Fail-soft: an enumeration
failure changes nothing (never tombstone on incomplete info); a failed per-repo
reconcile is retried next sweep (idempotent). Re-enabling a repo returns it to
the sweep set, and the following sweep materializes fresh current state,
including its `repository` record + `repo.md`.

**User purge is DESTRUCTIVE (deliberate privacy exception).** An explicit
user-initiated disconnect or purge — including the POST that flips a GitHub repo
to `syncing = false` — is the deliberate exception to raw immutability. For
GitHub repos, that action purges the repo's captured data via
`purgeGithubRepoData`, always scoped to `(tenant, repo)`:

- `activity_events`: all github event types for the repo, matched across every
  key/payload shape github events use (payload full names incl. PR base repo,
  proxy-issue `repository_url`, comment `issue_url`/`pull_request_url`,
  `html_url`s under the repo, and `source_event_id` prefixes for both the
  full-name and numeric-repo-id key forms plus
  `nango:github:pull_request_detail:<owner>/<repo>#`);
- `mirror_files` under `sources/github/<owner>/<repo>/` (prefix-matched with
  `starts_with`, not `LIKE`, so `_` in a repo name never wildcards into a
  sibling repo's directory), followed by a source-wiki index refresh;
- the repo's per-lane sweep cursors in `conversation_watermarks`
  (`issues:` / `issue_comments:` / `pr_review_comments:`), so re-adding the
  repo recaptures history from scratch.

`binary_documents` stores no github rows (its provider CHECK allows only
`drive-pdf`/`upload`), so there is nothing to purge there. The purge is
idempotent and runs in the POST endpoint after the selection upsert, so a
mid-purge failure leaves the repo stopped and a re-toggle retries the delete.

**Dashboard surface.** `GET /session/:id/github/repos` returns the merged repo
list — union of the GitHub App installation's repos (via the Nango proxy,
authoritative) and captured `repository` events — each annotated with the
selection (`{fullName, id, private, syncing, lastEventAt}`; no row =
`syncing: false`). The proxy leg is fail-soft: on 401/403/404 or a
missing/unconfigured connection the captured repos still render
(`installationReposAvailable: false`). Since the reconcile removes unselected
repos' current projections while retaining raw history, a retained fallback row
is annotated `syncing: false`; the authoritative installation leg keeps the
repo listed and addable regardless.
`POST` with `{repoFullName, syncing}`
upserts one selection row and purges the repo's data when `syncing` is false.
The dashboard's GitHub source panel lists repos (bounded-height, scrollable
list) with a per-repo toggle defaulting to "Not syncing"; turning a repo off
first shows a confirm dialog warning that its captured data will be removed.
The panel links out to GitHub's installation settings
(`github.com/settings/installations`) for adding/removing repos from the App
itself — repo *access* is granted on GitHub, only sync participation is
managed here.

**Scope.** The selection table is github-only; bitbucket repo discovery passes
through unfiltered. The older single-repo hint (`/session/github/repository`,
which stores `repoFullName` in connection metadata) is unchanged and coexists.

## Commit identity

Commits remain raw events only. Commit author emails are emitted as
`email_contact` identity aliases except `*@users.noreply.github.com`; noreply
addresses are not email aliases and are represented by GitHub login when the
record includes one.

## Deletions and redaction

Deleted records use Nango deletion metadata (`_nango_metadata.last_action`) and
are stored as tombstone events. Rendered issue/PR/repo files are removed when
the tombstone still carries enough repo/number shape to address the mirror
path.

GitHub redaction removes private-user-images signed URLs and signed asset URLs
inside `body_html`. Renderers prefer raw `body` over `body_html` so HTML asset
URLs are not promoted into mirror markdown.

## Code indexing is out of scope

No cloning, file listing, README capture, tree parsing, diff indexing, or code
document ingestion is part of this connector. Code indexing is deferred to
Ishan's S5 code-indexer track; commit events are only a future wake signal.

## Rate notes

Nango owns GitHub sync cadence and provider backoff. Aqueduct pages Nango
records with cursor recovery and the shared `nango.sync_records` source-sync
wrapper. VERIFY-LIVE: GitHub App provider config key, template model names,
`track_deletes`, repo id presence, and fork PR base-vs-head record shape must
be confirmed against the live Nango environment.

## Connect flow — GitHub App setup (LOAD-BEARING, verified live 2026-07-08)

The `github` integration is a **GitHub App** (`github-app`), not OAuth. The
in-dashboard "Connecting…" hang with **zero connections created** in Nango is
almost always the GitHub App itself, not our code or the Nango credentials.
The App (`shepherd-nango-dev`, app id 4244258) must have, in its GitHub
settings (github.com/settings/apps/<app>):
- **Post-installation → Setup URL = `https://api.nango.dev/app-auth/connect`**
  — THE load-bearing one. Without it the install completes on GitHub but never
  calls back into Nango, so no connection row is created (eternal "Connecting…").
- **Callback URL = `https://api.nango.dev/oauth/callback`** (was empty).
- **Redirect on update = enabled** — lets an already-installed App re-call
  Nango without a fresh install.
- **"Request user authorization (OAuth) during installation"** enabled.
Install access "All repositories" gives full capture; permissions are
read-only (contents/code, issues, pull requests, metadata). Verified: connection
`efee365f-…` created, dev tile reached 5,136 events / 160 files. This mirrors
per lane (dev/prod each install the App) — see AGENTS.md cutover checklist.

## Repository→Organization edges: directory-declared, never inferred (2026-07-12)

**Decision.** A Repository mention's `owner/` segment produces an
Organization mention + OWNS assertion ONLY when the operator declared that
owner handle on an Organization identity-directory group
(`identity-directory.ts add <tenant> <group> <name> handle:github <owner>
--entity-type Organization`). Injection happens at the writer seam
(`src/graph/extract/v2/owner-orgs.ts`), spans the owner substring (honest
evidence), and resolves through the directory's synthetic strong key.

**Why not inference.** GitHub's owner segment does not distinguish users from
organizations: auto-linking would spawn noise orgs (pyserini) or mistype
people (a personal handle as an Organization, colliding with their Person
directory entry). No declaration, no edge.

**Bitbucket** follows the same seam once `bitbucket` joins HANDLE_NAMESPACES;
not wired while the tenant has zero bitbucket documents.
