# Confluence

Code: `src/integrations/atlassian/`, `src/integrations/nango/`.

## Transport: Nango lane

**Decision.** Confluence auth and record transport run through Nango. `/v1/connect/confluence`
writes a provisional `connections` row first, then creates a Nango connect
session scoped to the tenant. Activation is pull-reconciled from Nango's
connections API by dashboard status polling and the `nango.poll` floor; the
Nango auth webhook remains an accelerant. Reconciliation records
`metadata.nangoConnectionId`.

**Why.** This keeps Atlassian auth/transport out of the native vault lane while
still landing every record in Aqueduct's uniform capture surface:
`activity_events`, outbox `event.collected`, and markdown mirror files.

## Capture: every model, render Page and comments

All generic Nango records now carry an explicit `snapshot` kind (or
`tombstone` when Nango marks deletion). Source namespace/object columns remain
null unless the record proves both immutable site scope and object ID; space
keys and current parents are containment, not authority
(`src/integrations/nango/capture.ts`).

**Decision.** Every Confluence model Nango emits is captured generically:
pages, attachments, blogposts, comments, and any future model. The full
redacted Nango record is stored; records without renderers are still durable
and reprocessable.

**Decision.** The polling-floor fan-out only asks Nango for REGISTERED models,
so all six live sync models are registered (live-verified 2026-07-08):
`Page` (rendered) plus `Space`, `Attachment`, `BlogPost` (raw-only) and
`FooterComment`, `InlineComment` (raw capture + rendered comments doc, below).
Page and blog comments arrive as raw versioned
`footer_comment`/`inline_comment` events the moment the dashboard syncs
deliver — no proxy lane is needed for Confluence comments.

**Decision.** No deep-content proxy sweep for Confluence: the live `pages`
sync model carries the FULL page body (`bodyStorage`, storage-format XHTML —
verified in the current template, which requests `body-format=storage`), so
the sync record is already lossless for content. `renderConfluencePage`
converts it to markdown for the mirror.

**KNOWN-EXTERNAL (2026-07-08).** All six Confluence syncs are in ERROR on the
dev Nango environment (dashboard/scope issue on the Nango side). Capture code
on our side is ready and idle; nothing to fix in this repo. Fix is a Nango
dashboard action.

**Decision.** `Page` records additionally materialize
`sources/confluence/<spaceId>/<pageId>.md` using storage-format XHTML to
markdown. Page source event ids use explicit version numbers when present
(`...:v<versionNumber>`), so each captured page version is durable.

**Limit.** The synced models expose people only as `authorId` accountIds (no
emails/display names — Confluence v2 API behavior), so page envelopes cannot
populate `authorEmail`/`updatedByEmail` from what the provider exposes.

## Comments doc: one rendered file per page

**Decision.** `FooterComment`/`InlineComment` records have dedicated
processors (`processConfluenceCommentRecord`): the generic lossless capture is
unchanged (same event types and source event ids), and additionally the
container's aggregated comments doc is materialized at
`sources/confluence/<spaceId>/<pageId>-comments.md` (blog posts:
`<blogPostId>-comments.md`). The doc renders each live comment's author
(display name when present, else the bare accountId), created/updated stamps,
version, storage-XHTML body via the shared storage-format renderer, inline
comments' highlighted-text context (`inlineOriginalSelection`) and resolution
status, and reply threading by `parentCommentId` (replies nest one heading
level deeper; orphaned replies render top-level).

**Decision — rebuild, not incremental.** Every comment event (live or
tombstone) rebuilds the doc from ALL captured comment rows for that container
in `activity_events` (latest state per comment id: `.deleted` is terminal,
higher version numbers win, else the most recently updated row). This mirrors
the Jira issue renderer's re-render-everything shape and makes the doc
derivable from the raw ledger alone.

**Decision — deletions.** A `<comment>.deleted` tombstone stays in the raw
ledger; the rebuilt doc simply omits the comment. When no live comments remain
or the container itself is tombstoned, the comments doc is deleted from the
mirror. Page deletion removes the page mirror file AND its comments doc
(`deleteConfluencePageSourceWiki`).

**Decision — ordering.** Comments can sync before their page. A comments doc
needs the page's `spaceId` (comment records don't carry it), so materialization
is skipped until the container record is captured; the Page processor
re-triggers the rebuild after each page materialize, which also picks up
early-arriving comments.

**Envelope.** provider `confluence`, `externalId` `<pageId>:comments`, kind
`comments`, `sourceUpdatedAt`/`versionRef` = latest comment update, sourceRefs
to the container record plus one per rendered `Comment <id>` heading.
Author emails populate only if the payload ever carries them (see accountId
limit above).

**Limit.** Blog posts have no dedicated processor, so a deleted blog post
leaves its comments doc in place until the next comment event for it arrives
(the rebuild then sees the `blog_post.deleted` tombstone and removes the doc).

## Deletions and redaction

Deleted records are captured as `<model>.deleted` tombstone events. Confluence
redaction shares the Atlassian rules: avatar URLs, media/file URLs, and
signed/tokenized URLs are removed before any DB or mirror persistence.

## Rate notes

Nango owns Confluence sync polling. Aqueduct's Nango task pages Nango records
with cursor recovery and a max-page guard. VERIFY-LIVE: confirm provider
config key, model strings, version field names, and deletion metadata shape
against the live Nango environment.
