# Notion

## Source-record identity: workspace-scoped and fail closed

**Decision.** Notion event writers classify lifecycle observations explicitly
and populate `workspace:<workspaceId>` plus `object:<id>` only when both native
values are present in the captured payload (`src/integrations/notion/webhook.ts`,
`src/integrations/notion/tombstone.ts`). Missing workspace scope leaves both
identity columns null.

**Why.** A current parent page is mutable containment, not an authority scope.
Failing closed prevents a move or duplicate ID from fabricating source identity.

**Alternatives rejected.** Tenant scope and parent-page IDs are convenient but
do not prove the provider-native workspace authority.

**Revisit when.** Revisit when every Notion webhook and polling payload carries
the immutable workspace ID.

Code: `src/integrations/notion/`.

## Change detection: webhooks + last_edited_time polling

**Decision.** Dual path: Notion **webhooks** (`webhook.ts` — handles the
`verification_token` handshake and validates `x-notion-signature`) mark pages
dirty for immediate processing, while the poller reconciles via search/listing
against stored `last_edited_time` in `notion_page_summaries` (`dirty_at`
marking, upserts guarded by `IS DISTINCT FROM` comparisons so unchanged pages
don't churn).

**Why.** Notion webhooks are best-effort and don't cover every mutation shape;
`last_edited_time` polling is the reconciliation floor. Same
backbone-plus-accelerator pattern as Calendar.

**Caveat.** `last_edited_time` has minute granularity in Notion and doesn't
bump for some property-only changes — the webhook path masks most of this, but
it's why the poller compares more than just the timestamp.

## Poll-path update events: `page.content_updated` (2026-07-08)

**Decision.** When the poll detects a **known** page's `last_edited_time`
advancing (the same comparison that marks the page dirty for re-render), it
writes a `page_content_updated` activity_events row *before* the summary
upsert, via the same append-only writer as the tombstones (`tombstone.ts`),
keyed `notion:page_content_updated:<pageId>:<last_edited_time>` with
`ON CONFLICT DO NOTHING`. The row's timestamp/`source_updated_at` is the
page's `last_edited_time`. Mirror/re-render behavior is unchanged.

**Why.** Previously only the **webhook** path wrote signal events, and
webhooks may not be enabled on a tenant — so editing a page re-rendered the
mirror but left **no event row** (observed live on tenant `org_01KWZZ…`).
Edits must surface in the ledger, not just in the mirror.

**Scope.** One row per detected version (the versioned key makes repeat polls
idempotent). First-time discovery of a page (`previous === undefined` in
`syncNotionPages`) deliberately emits nothing — that's backfill, not an edit;
otherwise every initial sync would flood one row per page. The webhook path
does not emit `page.content_updated` signal rows (it only marks dirty), so
enabling webhooks later cannot double-count against these.

## Tombstones: trash + unshare are ledgered, never silent

**Decision (2026-07-08).** Every content removal writes an append-only
`activity_events` tombstone (versioned dedupe key
`notion:<event_type>:<id>:<last_edited_time-or-unknown>`, via
`tombstone.ts`) *before* the removal path
(`removeNotionPageContent`: mirror + native snapshot + summary row) runs.
Three detectors feed this:

- **Webhook** `page.deleted` — pre-existing signal event (`webhook.ts`),
  unchanged.
- **Poll-detected trash** — pages the search listing returns as
  `in_trash`/`archived` now emit a `page.deleted` tombstone in `poller.ts`
  before removal (previously the poll path removed content with no ledger
  row).
- **Unshare reconciliation** (`reconcile.ts`, task `notion.reconcile`,
  hourly, same `<tenant>:notion` group key so it never races poll/render) —
  pages that vanish from Notion's search listing produce no webhook and are
  invisible to the listing-based sweeps. The task diffs
  `notion_page_summaries` against a full listing and tombstones
  `page.unshared` for pages that are missing AND confirmed inaccessible.

**Why the double confirmation.** Notion search is eventually consistent and
paginated, so missing-from-listing alone is not evidence. A page is only
tombstoned when a direct fetch also fails with 404/403 — with data-source and
database fallbacks first, because standalone data-source pseudo-pages store
the data-source id in `page_id` and a page fetch on them always 404s. Any
other failure status defers to the next run (`skips.verifyErrors`), a
truncated listing skips the whole sweep (`capHit`), and per-run verification
is capped at 200 with real-titled pages ordered before webhook stubs
(`title === page_id`) so stubs can't starve the cap. A missing-but-fetchable
page that reports `in_trash` is tombstoned `page.deleted` (trashed pages drop
out of search, so the poll sweep never sees them).

**Caveat.** `page.unshared` means "no longer accessible to the integration" —
Notion doesn't let us distinguish an unshare from a deletion that happened
while the page was unlisted. A webhook deletion and a poll/reconcile detection
of the same page may both leave a ledger row (different dedupe-key shapes);
the ledger is append-only, so that's by design.

## Dirty-page render loop

**Decision.** `notion.render` runs every 60s per tenant and drains
`notion_page_summaries.dirty_at` oldest-first into the source-wiki mirror.
Each page is rendered through the existing Notion content fetch/materializer;
successful rows clear `dirty_at` only if the timestamp has not advanced since
the row was claimed. Backlogs re-enqueue a deduped `notion.render` task on the
same tenant Notion group.

**Why.** Webhooks and polling are change detectors, not renderers. Without
this loop, fresh tenants accumulate dirty summary rows but no Notion mirror
files for `/v1/files` or later graph pickup.

**Revisit when.** Dirty backlog age stays nonzero under normal Notion traffic,
or per-page failures need a persisted retry/backoff column instead of relying
on the next render pass.

## Content extraction: Blocks API with bounded recovery

**Decision.** Page content comes from the Blocks API (plus a markdown
retrieval path), walking children recursively with explicit budgets:
`NOTION_STRUCTURED_BLOCK_MAX_BLOCKS` (5,000), `..._MAX_REQUESTS` (500),
`..._MAX_DEPTH` (512), inline-database expansion caps (5 data sources /
500 rows / 100 row bodies, nesting ≤ 2), and an unknown-block recovery path
bounded at 300k chars / 300 requests. Block-type coverage is tracked
explicitly in `coverage.ts` (official, legacy/compat, media types) so new
Notion block types surface as gaps instead of silent drops.

**Why.** Notion's block tree is user-generated and unbounded — a single page
can reference inline databases that fan out to thousands of API calls. The
budgets convert a potential quota/latency blowup into a bounded, observable
degradation. Unlike the Google Docs no-truncation rule, these caps are
**fan-out bounds, not content truncation** — they limit how far we chase
references, and `markdown_truncated` is recorded on the summary row when a
budget is hit, so the state is never silently wrong.

**Revisit when.** Notion ships a bulk/export API, or budget-hit rates in
production show real pages regularly exceeding the caps.

## Persistence

Page summaries + section summaries with content hashes in
`notion_page_summaries`; comments fetched per page; the mirror materializes
page files with section-level content hashes (rename-stable paths keyed on
page ID, same convention as Google Docs tabs).

**Comments (2026-07-08).** Comment capture is two-lane: `comment.*` webhooks
land in `activity_events` (ids + parent only — Notion webhooks carry no
body), and comment bodies come from the per-page comment fetch during render,
persisted raw into `notion_comment_snapshots` (page-, row-, child-page-, and
block-level discussions). Because the webhook has no body, `comment.*` events
now also mark the affected page dirty (`shouldDirtyPageForNotionEvent`) so
the body lands on the next render pass instead of waiting for an unrelated
page edit.

**Database-row property changes** are captured as state, not per-change
ledger rows: row pages land in `notion_objects` with raw `properties` /
`propertyValues` (bounded by the expansion budgets above), page properties in
`notion_page_summaries.properties`, and `page.properties_updated` /
`data_source.content_updated` webhooks drive the dirty→render refresh.
Ordinary `page.content_updated` / `page.properties_updated` webhooks are
deliberately NOT emitted as activity events (volume); the mirror's
version-append envelope is the change ledger for content.

## Staged evidence refs: captured version identity, never URL-only

**Decision (2026-07-11).** New Notion page, row, and child-page projections
write a `sourceRefs` entry from their existing captured content-version hash
(`src/mirror/materializer.ts:438`). Embedded comment projections add a
second `Comments` ref when the renderer emits that stable heading
(`src/integrations/notion/source-wiki.ts:123`). A Notion URL is retained
only as navigation metadata; it is never evidence identity. Each newly written
ref has an anchor and exactly one identity (`sourceEventId` XOR `sha256`;
`src/mirror/envelope.ts:108`, `src/mirror/envelope.ts:258`).

**Why.** The native snapshot/content hash is the captured immutable version
identity for page, row, and comment bodies. The available Notion activity rows
are lifecycle signals: first discovery intentionally emits none, database rows
are state-only, and comment webhooks contain ids/parents but no body. Inventing
`notion:*` event IDs would therefore produce refs that do not resolve to an
actual captured `activity_events` row. Existing projections without a captured
hash remain unchanged; the renderer does not guess an identity from a URL or
retrofit legacy rows.

**Alternatives rejected.** Constructing a poll-style
`notion:page_content_updated:<id>:<time>` key for every page/row/comment;
using opaque comment webhook IDs for comment bodies; and treating the Notion
URL as a raw identifier. A future `sourceEventId` is valid only when it is the
exact captured, versioned activity-event ID, never a convention reconstructed
at staging time.

**Revisit when.** Notion capture writes a content-bearing, versioned
`activity_events` row for every page, row, and comment version (including
initial discovery), so staged projections can reference that ledger row
directly instead of the native snapshot's content-version hash.

**Native snapshot store (migration 0011, 2026-07-07).** The full-fidelity
snapshot layer (`snapshot.ts` / `native.ts`) persists normalized rows into
seven tables: `notion_objects` (union view of every synced object) +
`notion_object_edges` (parent/child relations), plus per-type
`notion_block_snapshots`, `notion_data_source_snapshots`,
`notion_database_snapshots`, `notion_view_snapshots`, and
`notion_comment_snapshots`. The code shipped **before** its migration — the
poller's page/data-source removal paths hit these tables live — so migration
0011 provisions the whole set at once; the unique indexes match
`snapshot.ts`'s `ON CONFLICT` targets exactly (`(user_id, object_id)`,
`(user_id, parent_object_id, child_object_id, relation_type)`,
`(user_id, block_id)`, `(user_id, data_source_id)`, `(user_id, database_id)`,
`(user_id, view_id)`, `(user_id, comment_id)`). All jsonb payloads pass
through `redactProviderPayload("notion")` inside `snapshot.ts` before write.

**Wired live (2026-07-07).** `persistNotionNativeSnapshot` previously had no
live caller (only the poller's removal paths touched the tables), so the
store never filled. It is now wired into the dirty→render funnel:
`fetchAndMaterializeNotionPageContentSourceWiki` (used by both `notion.render`
and the mirror backfill) builds the snapshot via `buildNotionNativeSnapshot`
from the `NotionPageContent` the walker already fetched — no second block-tree
walk — and persists it **before** staging the mirror files. Data-source/
database/view/template context the walker doesn't carry is loaded by the
pre-existing fail-soft supplemental reads inside `buildNotionNativeSnapshot`
(they only fire for pages that reference data sources). A persist failure
propagates and retries the render, so staged files never get ahead of raw
capture.
