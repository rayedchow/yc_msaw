# Google Docs

Code: `src/integrations/google/gdocs/` (poller/jobs re-export from
`src/polling/_archived-gdocs/` pending migration). Researched 2026-07-03 against
Fivetran, Airbyte, Elastic connectors, and Airweave — see the knowledge base
entries "Google Docs ingestion" and "Drive change detection: poll vs push".

## Content extraction: Docs API structured JSON, not Drive export

**Decision.** We read documents with Docs API `documents.get` (with
`includeTabsContent=true` and `SUGGESTIONS_INLINE`) and produce **two outputs**:

1. **`raw.md` — lossless (one redaction).** The complete `documents.get` JSON,
   wrapped in a markdown fence (the mirror is markdown-only). This is the
   faithful source of truth; anything the projection below can't represent is
   recoverable here. Materialized once per doc. The single modification:
   every `contentUri` is redacted (`redactEphemeralUris`,
   `src/mirror/materializer.ts`) before writing — those URLs are live
   requester-scoped credentials, not metadata (see the security rule below),
   and greploop review 2026-07-05 caught them leaking into `raw.md` verbatim.
   Image bytes are captured separately, so nothing is lost.
2. **Per-tab markdown — best-effort projection.** We walk the JSON tree
   (`gdocs/content.ts`) and render readable markdown: `HEADING_n` → `#`
   headings, links → `[text](url)`, **ordered/unordered lists with nesting**
   (via the doc `lists` map + `bullet.nestingLevel`), **bold/italic/
   strikethrough** styling, **markdown pipe tables** (row 1 treated as the
   header — Docs has no header concept, so it's a cosmetic assumption backstopped
   by `raw.md`; kept as markdown, not HTML, so the mirror stays greppable and
   LLM-friendly). Non-text elements (2026-07-03):
   - **Person chips** → `[@Jane Doe](mailto:jane@corp.com)` (email is always
     present in `personProperties`); **Drive/YouTube/Calendar chips** →
     `[title](uri)`; **date chips** → ISO date (or `[date]` when no timestamp).
   - **Footnotes** → real markdown footnotes: `[^n]` inline + `[^n]: text`
     definitions appended per tab (content from the doc/tab `footnotes` map).
   - **Inline images/drawings/charts** → alt-text placeholders
     `[image: <alt>]` / `[drawing: <alt>]` / `[chart: … linked Sheets chart]`
     from `embeddedObject.title`+`description`; **positioned (floating)
     objects** → same placeholder at their anchor paragraph.
   - **Equations** → `[equation]` — the API exposes **no equation content**
     (no LaTeX/MathML/text) at any role; even `raw.md` has nothing more. The
     only conceivable content path is a DOCX-export pipeline (OMML math),
     deliberately not built. This placeholder is the honest ceiling.
   - Chips/objects that are pending *suggested insertions* are excluded from
     base content, consistent with the as-if-rejected view — and (2026-07-05)
     they feed the suggestion collector as their rendered placeholders, same
     as text runs, so a suggestion that only inserts/deletes a chip, footnote,
     equation, or image is still a visible suggestion card and still moves the
     tab hash. Before this, chip-only suggestions were invisible to sync.
   Tabs are first-class (recurse `childTabs`, keyed by `tabId`, sha256 content
   hash). Each tab renders against doc-level object maps overlaid with **its
   own** tab maps only (2026-07-05) — accumulating maps across tabs let a
   reused footnote/object ID render another tab's content.

3. **Image bytes (`google_doc_images`, migration 0005).** During the mirror's
   live-fetch path, `storeDocImages` downloads each embedded image within the
   `contentUri`'s ~30-minute window and stores base64 bytes + sha256 + alt/kind
   in Postgres (no object store in the stack yet; revisit at scale). Bounded:
   `GDOCS_IMAGE_MAX_BYTES` (**50 MB** per image — matches Google's own
   insert-into-Doc limit, so in practice nothing real is skipped; a backstop
   against pathological payloads), `GDOCS_IMAGE_MAX_PER_DOC` (**1,000** —
   effectively "all images"; a runaway-doc backstop, not a working limit),
   `GDOCS_IMAGE_REFETCH_HOURS` (24) so unchanged docs don't re-download.
   The byte cap is enforced **before allocation** (2026-07-05): a
   `Content-Length` over the cap skips the fetch outright, and undeclared
   bodies are streamed and aborted at the cap (`readBodyCapped`) — reading via
   `arrayBuffer()` first meant an oversized payload allocated fully before the
   check, an OOM vector under concurrent backfills.
   **Known limitation of these permissive defaults:** the caps no longer
   meaningfully bound cost — worst case is 1,000 × 50 MB ≈ **67 GB of base64
   for a single doc in Postgres** (base64 inflates ~1.33×, and a single 50 MB
   image is a ~67 MB row), and the fetch loop is sequential, so image-heavy
   docs add real minutes to the materialization path. These defaults
   deliberately prefer completeness over cost; lower both env knobs per
   deployment if Postgres size or materialization latency bites. Every skip is
   logged (per-doc cap hits and per-image oversize skips), never silent. At
   real image volume the fix is an object store (S3/R2), not tighter caps —
   Postgres-as-blob-store is the launch shortcut, not the design.
   **SECURITY RULE: the `contentUri` is never persisted** — anywhere. It is
   tagged with the requester's account and grants requester-scoped access to
   any holder; it is consumed in-process within its window and discarded. The
   render tests assert it never leaks into mirror content.

**The projection is lossy and marked as such.** Every tab file carries a
`Rendering: best-effort markdown — VERIFY against ../raw.md` metadata line and
a blockquote caveat. Dropped/approximated: footnotes, equations, positioned
objects, merged cells, colors/fonts/sizes, alignment, and any list-glyph
nuance. Consumers that need structural fidelity must read `raw.md`. The
markdown is for readability and search, not as the authoritative structure.

## Graph ingestion

Graph ingestion sanitizes Google Docs tab files at ingest time: it strips the
source-metadata/caveat preamble and the pending-suggestions section before
extracting claims, and the mirror ingest hook excludes `raw.md` companions and
generated `index.md` navigation files. The mirror files themselves are
unchanged; the filtering is only for graph knowledge content.

**Why.** The industry default (Drive `files.export` to DOCX, then a parser
like Unstructured.io) loses tab structure, adds a docx parse step we don't
control, and caps exports at 10 MB. The structured JSON path has no export
size cap, gives us native tab names/hierarchy (`tabProperties.title`,
`parentTabId`), and keeps rendering under our control. Offering **both** the
raw JSON and a readable projection means we never silently lose fidelity (the
raw is always there) while still giving consumers something greppable — the
earlier design shipped only the lossy markdown, which quietly dropped lists
and styling with no recovery path.

**Alternatives rejected.**
- `files.export` → DOCX/PDF (Fivetran, Airbyte, Airweave): 10 MB cap, tab
  structure flattened, foreign parser in the loop.
- `files.export` → text/plain (Elastic): cheapest, but destroys headings,
  links, and tables.
- `files.export` → markdown (newer Drive capability): closest competitor;
  still no tabs and still capped at 10 MB.

**Revisit when.** We need Sheets/Slides *content* (no structured-read
equivalent worth walking — use `files.export` for those), or Google adds
comments/suggestions to the export formats.

## Suggestions: content captured inline (2026-07-03)

**Decision.** `fetchDocContent` requests
`suggestionsViewMode=SUGGESTIONS_INLINE` and derives two views from the one
response: base content (suggested-insertion runs dropped, pending-deletion
runs kept — equivalent to the previous `PREVIEW_WITHOUT_SUGGESTIONS` fetch)
plus per-tab pending suggestions (`suggestionId`, `insertedText`,
`deletedText`), concatenated across runs and tables in document order. The
mirror renders them as a "Pending suggestions" section in each tab file, and
the tab content hash covers them (empty-suggestion docs hash identically to
the old scheme, so no re-sync churn). Suggestion *lifecycle* (who
suggested/accepted/rejected, when) continues to come from the Activity API
comment sweep as `doc_suggestion_*` events.

Role gate (see [google-access-matrix.md](google-access-matrix.md), axis 2):
`SUGGESTIONS_INLINE` hard-403s at reader role, so the fetch falls back to
`PREVIEW_WITHOUT_SUGGESTIONS` and sets `DocContent.suggestionsAccessible =
false`; the mirror tab file then carries a "Suggestions: not visible
(view-only access)" metadata line — degraded state is recorded, never silent.

**Why.** Suggestion text is visible only in the Docs API body as marked spans
— the Activity API events carry no content, and Drive export formats drop
suggestions entirely. One INLINE fetch replaces the old fetch at identical
API cost. Style-only suggestions (formatting) carry no text and are ignored.

**Suggestion cards (deterministic join).** `buildSuggestionCards`
(`src/integrations/google/gdocs/suggestion-cards.ts`) joins the three
suggestion signals into one record per suggestion: CONTENT + PLACEMENT (Docs
API `SUGGESTIONS_INLINE`, keyed `suggest.*`) + AUTHOR/status (OT changelog,
keyed `sugId`). The join is by **exact suggestion ID** — the two APIs share
the namespace — so no timing heuristic. Author display names come from the
changelog `userMap` (People-independent). Fails soft: if the changelog is
unavailable (reader role, or the undocumented endpoint is down), cards still
carry content + placement with `authorshipResolved: false`. A full card
(with author) needs writer+ on the doc — under DWD, docs the impersonated user
can edit. Verify end-to-end with `scripts/verify-suggestion-reply-access.ts`.

**"When was a suggestion updated?" — provided, not derived.** Each card carries
`createdAt`, `lastModifiedAt`, `modificationCount`, `resolvedAt`/`resolvedBy`,
all taken directly from the changelog operation timestamps (the millisecond
time Google logged for each edit). This is the ONLY non-heuristic source of
suggestion-modification time: Google emits no `EDITED` event in the Activity
API, and the Docs API body carries no per-suggestion timestamp. Without the
changelog you could only infer "changed sometime between poll N and N+1" from a
content-hash diff — poll-bounded, i.e. a heuristic. With it, the time is exact
(as exact as version history).

**The one honest caveat — it's an access condition, not a heuristic.** "Exact
/ 100% true" holds provided two things: (1) the caller has **writer+** on the
doc (the changelog endpoint is version-history-gated — under DWD that means
docs the impersonated user can *edit*; see
[google-access-matrix.md](google-access-matrix.md) axis 2, "DWD does not
elevate file access"), and (2) the undocumented endpoint is **up**. When the
changelog is unavailable for either reason, the card **fails soft and visibly**:
`authorshipResolved: false`, null author, and null timestamps. So a consumer
always knows whether it's looking at an exact op timestamp or at *nothing* —
the fallback is explicit absence, never a silently-guessed value. That is the
whole point of the design: **it's either the real op timestamp or explicitly
absent — never a heuristic dressed up as truth.** Callers should branch on
`authorshipResolved` / non-null timestamps rather than assuming every card is
attributed.

Placement is captured as **text-context anchors**, not indexes: each
suggestion records ~80 chars of base content before/after the suggested span
(`contextBefore`/`contextAfter`), collected during the same walk at zero
extra API cost, rendered as a "Location: …before ⟦here⟧ after…" line. Raw
document indexes were deliberately not kept — they shift with every edit.
Context is derived from already-hashed base content, so it does not feed the
content hash (no churn). Activity-side lifecycle coverage is complete: all
eight suggestion subtypes map (`REPLY_DELETED` → `doc_suggestion_reply_deleted`;
`ACCEPT_DELETED`/`REJECT_DELETED` fold into `doc_suggestion_deleted` with the
original subtype preserved as `activitySubtype` in the payload).

**Revisit when.** Consumers need per-suggestion authorship. In the public
API surface that requires the transient Activity `ADDED` event or a DOCX
export. But it is **deterministically available via DWD** through the OT
changelog client below (`sugId` + `userId`, joined to Docs API content by
exact suggestion ID) — porting that is the real answer, not a heuristic.

## Comment/reply edit detection: periodic refresh (no Activity signal)

**Decision.** A scheduled `gdocs.comment-refresh` job (hourly,
`refreshCommentEdits` in `src/polling/_archived-gdocs/gdocs.ts`) re-lists
comments via `comments.list?startModifiedTime=` for docs active in the last
72h. For any comment whose `modifiedTime > createdTime`, it appends a
versioned `doc_comment_edited` observation keyed by file, comment, and
`modifiedTime`. The new row carries current content, a full `_currentThread`
snapshot (comment + all replies, freshest text), a `_content_refreshed_at`
stamp, and `_edited: true` when the text actually drifted. The original
`doc_comment_added` payload is never rewritten.

**Why.** The Activity API's `Post` subtypes have **no `EDITED`** — a reworded
comment or reply emits no event, so our stored content silently goes stale.
Re-listing is the only public-API way to catch it (comment edits aren't in the
OT changelog either). The versioned parent-thread observation is the durable
home for freshest thread state because reply events aren't deterministically
re-keyable (their id embeds epoch + actor).

**Mirror impact.** Comments aren't materialized into the file tree today; the
refreshed content lives on the latest versioned `activity_events` observation.
If comment threads are ever materialized, they fold `_currentThread` by source
object and source time.

**Revisit when.** The Workspace Events API GAs (issue #7): `comment.v3.edited`
/ `reply.v3.edited` give an exact real-time edit signal and this sweep can be
dropped (or kept as a cheap backstop).

## Ported: the OT changelog client (undocumented `/revisions/load` endpoint)

**Status.** Ported into aqueduct 2026-07-03. Three modules under
`src/polling/_archived-gdocs/` (`gdocs-revisions-load.ts` — the client;
`gdocs-suggestion-tracker.ts` — sugId lifecycle; `gdocs-style-humanizer.ts` —
style-suggestion prose) with the two upstream test suites (267 tests). A clean
façade lives at `src/integrations/google/gdocs/revisions.ts` exposing
`fetchDocChangelog`, `trackSuggestions`, `fetchSuggestionLifecycles`,
`extractPendingSuggestions`, `buildAuthorAttribution`. Reverse-engineered from
harvard-vpal/gdocrevisions; reads Google's **undocumented `/revisions/load`**
OT changelog behind the version-history UI.

**Scheduled: `gdocs.suggestion-sync`.** `syncDocSuggestions`
(`src/integrations/google/gdocs/suggestion-cards.ts`) runs `buildSuggestionCards`
and upserts results into `google_doc_suggestions`. It runs in **two modes**, a
cheap-backbone + reactive-accelerator pair (same shape as the poll-vs-push
design):

- **Full sweep (hourly, backstop):** every doc active in the last 72h from
  `conversation_watermarks`, paced ~200ms between docs.
- **Targeted (event-driven, near-60s):** the Cycle B comment sweep detects
  suggestion Activity events and enqueues a doc-scoped `gdocs.suggestion-sync`
  (`payload.docIds = [fileId]`) so a doc someone is actively suggesting in gets
  attribution within ~60s instead of waiting up to an hour, and docs with no
  suggestion activity never trigger a fetch at all. Three guards keep this from
  overloading rate limits: (1) a per-doc `dedupeKey` — at most one queued/
  running sync per doc, so a doc getting many events collapses to one; (2) a
  per-sweep burst cap (`GDOCS_TARGETED_SYNC_MAX_DOCS`, default 25) — a
  suggestion flood across many docs enqueues at most N targeted syncs and logs
  the deferred remainder (the hourly full sweep catches them); (3) `priority:
  -5` so targeted syncs yield the shared `<tenant>:gdocs` slot to the poll
  (the freshness backbone) and never delay it. Group serialization already
  guarantees these run one-at-a-time, not in a parallel burst.

**Cost control — three layers:**
1. **Skip-unchanged (watermark).** The full sweep skips any doc whose
   `last_seen_ts` (= modifiedTime) hasn't advanced since its last *successful*
   sync (`google_doc_sync_state`). Suggestions and tab changes both bump
   modifiedTime, so an unadvanced watermark means nothing to sync — no info
   lost. The watermark advances only on success (a needed-but-null changelog
   leaves it, so transient failures retry). This drops the sweep from "all ≤200
   active docs" to "only docs changed since last sync." Targeted (event-driven)
   syncs never skip.
2. **Skip-empty gate.** For docs that *did* change, the changelog is fetched
   only when there are pending suggestions OR the tab tree drifted (cheap
   Docs-API signature vs. stored `google_doc_tabs`) OR stored rows are still
   open for suggestions that left the pending view (see close-out below). A
   changed doc with none of these skips the undocumented endpoint entirely.
3. **Event-driven acceleration + full-sweep backstop.** Suggestion Activity
   events enqueue targeted syncs (~60s); the hourly sweep remains the backstop —
   required because tab changes have *no* Activity event to trigger on.

Together these mean the undocumented, writer+-gated endpoint is hit only for
docs that changed *and* have suggestions or tab drift — a small fraction of
active docs. A doc that reached the changelog reports `changelogAttempted:
true`; skipped/empty docs are excluded from the null-rate ratio.

**Resolution close-out (2026-07-05).** A suggestion that is accepted,
rejected, or deleted disappears from `SUGGESTIONS_INLINE`, so upserting only
the current pending set left stored rows open ("pending"/"modified") forever.
The sync now diffs stored-open rows against the current pending set; rows that
left it get their terminal status + `resolved_at`/`resolved_by` from the
changelog lifecycle (`trackSuggestions` — deterministic, same `sugId` join).
When the changelog can't say (endpoint down, view-only role), the row is
marked `unknown` rather than left falsely pending — "no longer open" is the
one fact the pending view proves on its own. `unknown` is settled, not open
(greploop round 3): it never drives a changelog fetch or a rewrite of its own
— otherwise view-only docs would refetch and rewrite the same rows every sweep
forever — but it is upgraded to the true terminal status opportunistically
whenever a later sync fetched the changelog for other reasons.

Access is handled by **fail-soft, not a pre-check**: the changelog is
writer+-gated, so for docs the impersonated user can only view (or if the
undocumented endpoint is down), `fetchDocChangelog` returns null and the doc
persists content+placement only (`changelog_resolved = false`); no crash.
**Monitoring:** the job counts `changelogOk` vs `changelogNull` over docs it
*attempted* (had suggestions) and warns when the changelog is null for *all*
attempted docs (≥5) — the tripwire for a blocked endpoint, not just read-only
docs.

The heuristic timestamp-window `enrichPhase1Events` was **deleted** (not just
un-exported) — the deterministic sugId/sessionId paths replace it.

**Auth methods it works with:**
- **DWD (ours): yes** — verified in gigabrain with `drive.readonly` +
  `documents` + `drive.activity.readonly`.
- **3-legged user OAuth: yes (expected)** — it consumes a normal OAuth bearer
  token via `gFetch`; nothing distinguishes a DWD token from an OAuth token to
  the endpoint. Same scopes.
- **Service account + folder sharing: effectively no** — it reads
  version-history data (writer+ gated, below) and SA shares are typically
  Viewer; and it's a `docs.google.com` web endpoint, not `googleapis.com`, so
  bare-SA token acceptance is itself unverified.
- **Per-file role gate: writer+.** `/revisions/load` surfaces the same data as
  the version-history UI, which the Drive role table gates to
  owner/organizer/fileOrganizer/writer ("Access historical revisions").
  Readers/commenters likely get 403/empty. This binds under EVERY auth method,
  DWD included — DWD does not elevate file access. (Empirically confirmable;
  the fetch returns null on failure so a call just yields no changelog.)

**What it provides that no public API does:**
- Per-character edit attribution: every operation is a tuple carrying
  `userId`, ms timestamp, **`sessionId`/`sessionIndex`** (true editing
  sessions), and tab ID.
- Real diffs: insert/delete strings with positions; `replayWithDiffs`
  reconstructs chunked content diffs.
- **Deterministic suggestion authorship + content bridge:** suggestion ops
  (`iss`/`dss`/`msfd`/`usfd`/`ras`) carry `sugId` **and** `userId`. The
  `gdocs-suggestion-tracker` groups ops by `sugId` into a full lifecycle
  (created/modified/accepted/rejected, with author and resolver). Because the
  changelog's `sugId` is the SAME `suggest.*` namespace the Docs API's
  `SUGGESTIONS_INLINE` returns, pending-suggestion content (Docs API) joins to
  authorship (changelog) by **exact ID — no timing heuristic**. This is the
  deterministic bridge the public APIs lack.
- A `userMap` (id → display name/photo) from `/revisions/tiles`, independent
  of the People API.

**What the changelog does NOT carry (but is available elsewhere):**
- Suggestion **reply text** is not in the OT stream (the `ac`/`mch`/`mkch` op
  codes are tab operations in practice, not comment bodies). But it is NOT
  unreachable — do not repeat that error. A suggestion's reply thread is a
  Drive comment/discussion resource, and our live comment pipeline already
  fetches it: `doc_suggestion_reply_added` extracts the Activity event's
  `fileComment.legacyCommentId`, calls `getComment`, and stores `replyContent`.
  See the access matrix "Suggestion reply text" note — ✅ very likely available
  via the public Drive comments API, pending only a prod-populated confirmation
  (`scripts/verify-suggestion-reply-access.ts`).

**No heuristic in the scheduled path:** the upstream `enrichPhase1Events`
(±5-min timestamp window joining Activity events to OT ops) was **deleted**.
The scheduled sync uses only the changelog-native join: `sugId` and `sessionId`
are native to the ops, so authorship and update times need no window.

**Mechanics:** fetch `/revisions/tiles` for total entry count + userMap, then
paginate `/revisions/load` in ~1000-entry chunks; responses carry an anti-XSSI
`)]}'` prefix to strip. Works with our DWD bearer tokens via `gFetch`. Do NOT
correlate with Drive Revisions API IDs (those merge/compact; changelog indices
don't map).

**Standing risk (now scheduled — mitigated, not eliminated):** undocumented —
no SLA, can break or be blocked by Google at any time, and sits in ToS gray
territory. The client fails soft (returns null), so a broken endpoint degrades
to "no changelog / content-only cards," never a crash. The `gdocs.suggestion-sync`
job records the changelog-null rate and warns when it's null for all docs in a
run — the tripwire for "endpoint blocked." If that fires persistently, disable
the schedule (`gdocs.suggestion-sync` in `startGooglePolling`); the rest of the
gdocs pipeline is unaffected.

## Tab changes: attributed events + current tab tree (2026-07-03)

**Decision.** The same `gdocs.suggestion-sync` job — from the **one** changelog
fetch per doc — also extracts tab operations (`extractTabChanges` in
`tab-changes.ts`) and persists them: attributed events into
`google_doc_tab_events` (one row per create/rename/move/delete with actor +
`occurred_at` + old/new name or from/to position, keyed by changelog index) and
the reconstructed current tree into `google_doc_tabs` (id, name, position,
parentTabId, created/deleted). Tab titles, hierarchy, order, re-nesting, and
create/delete — with who and when — are all surfaced.

**Changelog-fetch gate broadened.** The fetch was previously gated on "has
pending suggestions" (skip-empty). It's now `pending suggestions OR tab tree
drifted`: a cheap Docs-API tab-tree signature (`tabTreeSignature` — id + name +
parent + order) is compared to the stored `google_doc_tabs`, so a doc with **no
suggestions but a renamed/moved tab** still triggers the changelog fetch, while
a truly unchanged doc still skips it. The Docs API reveals *that* tabs changed
cheaply; the changelog supplies *who/when*.

**Why the changelog is the only source.** The Drive Activity API has **no tab
events at all** (tabs postdate its model), and the Docs API gives only current
tab state, not history. Tab-change attribution lives solely in the OT
changelog — same writer+ gate, fail-soft, and undocumented-endpoint risk as
suggestions. If the changelog is unavailable, tab data is simply absent for
that run (current tree still updates on the next successful fetch).

## Scheduling, concurrency, and suggestion-attribution latency

**Who made a suggestion is NOT unknown for an hour — that was a misread.** Two
independent latencies apply, and they're different questions:

- **Suggester identity + roughly-when: ~60s.** The Cycle B Activity sweep
  (`detail.action_detail_case:COMMENT`, 60s) captures `doc_suggestion_added`
  with the actor resolved to email/name (`actorEmail`/`actorName` on the
  payload, via the People identity cache). So "Jane made a suggestion on this
  doc at 2:14" lands within a minute.
- **Deterministic binding of that author to the specific suggested TEXT:
  hourly.** The Activity event carries the actor but no `sugId` and no
  suggested text. Joining "this exact pending suggestion → this author"
  without a timing heuristic is what `gdocs.suggestion-sync` does via the
  changelog `sugId`. For a doc with one suggester this is trivial (only one
  candidate); the hourly latency only matters when multiple people have
  concurrent pending suggestions and you need to know which text is whose,
  deterministically.
- **Suggestion text itself: ~5min** — `fetchDocContent` re-materializes the
  mirror when the content hash changes on the poll cycle.

So the honest gap is narrow: not "author unknown," but "deterministic
text↔author binding in the multi-suggester case waits for the hourly sync."
The **event-driven trigger** closes even that to ~60s and is **built**: the
Cycle B comment sweep enqueues a doc-scoped `gdocs.suggestion-sync` when a
suggestion Activity event fires (see the two-mode description above).

**Why hourly, and how the gdocs jobs mesh (DWD context).** Every gdocs job —
`gdocs.poll` (300s), `gdocs.comment-sweep` (60s), `gdocs.comment-refresh`
(3600s), `gdocs.suggestion-sync` (3600s), `gdocs.actor-repair` (21600s) —
runs under **DWD impersonation of the connected user** and shares one queue
`group_key` (`<tenant>:gdocs`). The task
queue serializes a group to **at most one running task at a time** (a
`NOT EXISTS` check on running rows plus a transaction-scoped advisory lock). So
these jobs never overlap for a tenant; a longer/heavier job delays the others
behind it. Three consequences drive the cadence:

1. **The poll is the freshness backbone** and must stay responsive on its 300s
   slot. Making `suggestion-sync` more frequent competes for the *same single
   slot* and would push polls back.
2. **The changelog is writer+-gated *and* hits an undocumented endpoint.** Under
   DWD it works for docs the impersonated user can edit (impersonation does not
   elevate file access — see [google-access-matrix.md](google-access-matrix.md)
   axis 2); it returns null otherwise. Higher frequency multiplies load on the
   one non-public surface we depend on — the exact thing the null-rate tripwire
   guards.
3. **Cost scales with active docs** (~3 API calls each: one Docs `documents.get`
   + `/revisions/tiles` + a `/revisions/load` page), run sequentially with no
   inter-doc pacing. Hourly keeps that burst rare.

The deliberate spread — frequent cheap poll, infrequent expensive/undocumented
jobs — keeps the freshness path fast while bounding load and block-risk. To get
fresher attribution, prefer the per-doc event trigger over shortening the
global interval.

## Change detection: Changes API cursor polling, deliberately

**Decision.** We persist a Drive `pageToken` per user in token metadata and
poll `changes.list` (Cycle A, 30s). Edit attribution comes from the Drive
Activity API (`activity.query`); comments from a second Activity sweep filtered
to `detail.action_detail_case:COMMENT` (Cycle B, 60s). Actor person-IDs resolve
to emails via the People API with a 10-minute TTL cache.

**Why.** Polling the Changes cursor is the only **lossless, corpus-wide**
mechanism Google offers — the token only advances when we consume the page, so
nothing is ever missed, deletes included. And our richest signal, the Activity
API (who edited, who commented), is **query-only** — Google offers no push for
it — so a poll loop exists no matter what the detection layer does. Every
serious production system (rclone, Elastic, Airweave) polls; Fivetran uses
plain mtime listing, which is weaker than what we have.

**Alternatives rejected.**
- **`changes.watch` push channels**: the webhook carries *no payload* — on
  every ping you still call `changes.list` with the same cursor, so it is a
  latency optimization, not a replacement. Channels expire fast (empirically
  ~1h–24h; docs deliberately vague), demand per-user renewal fleets and a
  public domain-verified HTTPS endpoint, and miss deliveries silently. Note
  Calendar is different: its channels live 7 days, which is why the Calendar
  integration *does* use watch (see google-calendar.md).
- **Workspace Events API for Drive** (Pub/Sub, CloudEvents — public preview
  since July 2025): the right event shapes (`file.v3.contentChanged`,
  `comment.v3.*`, `reply.v3.*`), but a subscription targets a **single file or
  shared drive** — there is no whole-My-Drive target — subscriptions expire
  (≤7 days), and it requires GCP Pub/Sub plus preview enrollment.

**Revisit when.** The Workspace Events API goes GA — tracked in
[#7](https://github.com/askshepherd/aqueduct/issues/7). The upgrade path is
additive, not a rewrite: keep cursor polling as the lossless backbone, and add
per-file subscriptions (`comment.v3.*`, `file.v3.contentChanged`) on the N
most-active docs per user (we already rank activity in
`conversation_watermarks`) for near-instant events on the hot path. If sub-30s
latency becomes a requirement before GA, `changes.watch` as a poll-trigger is
the cheap interim.

## Edit-event freshness: changes-feed fast path + Activity dedupe (2026-07-08)

**Decision.** Cycle A emits a `doc_edited` activity_events row **directly from
the changes feed** (`emitDocEditedEventsForChangedDocs`,
`src/polling/_archived-gdocs/gdocs.ts`) for every changed workspace file, in
the same pass that enqueues the content snapshot. The Activity API emission in
`processEditActivity` is kept unchanged as the authoritative, actor-attributed
edit stream.

**Why.** The two paths have very different latency: the changes feed is what
the 30s poll actually consumes (this is what makes the mirror update promptly),
while the Activity API consolidates and can lag an edit by ~15 minutes.
Before this, an edit updated the mirror immediately but its *event* appeared
much later — observed live on tenant `org_01KWZZ…` (fresh snapshot, no fresh
`doc_edited` for ~15 min). Users expect the edit to surface as an event as
fast as the content does.

**Keying and dedupe.** Fast rows are one-per-detected-version:
`gdocs:edit_detected:<fileId>:<headRevisionId ?? modifiedTime>` (native Docs
files don't get `headRevisionId` from the changes feed, so `modifiedTime` is
the usual version ref). Repeat deliveries of the same revision collapse on the
`(user_id, source_event_id)` unique index. A source_event_id literally shared
with the Activity edit event is impossible — the Activity API exposes neither
revisionId nor modifiedTime, and the changes feed exposes neither the activity
time range nor actor person-IDs — so double-counting is prevented the other
way around: `processEditActivity` skips an Activity **edit** whose time window
(±3 min slack) already contains a fast row for the same file with a compatible
actor (`changesFeedAlreadyCoveredEdit`, `gdocs-edits.ts`). When both sides
know an actor email and they differ, both rows are kept (they are different
actors' edits); activities older than 48h skip the lookup entirely (backfill
re-scans predate fast rows). Fast rows carry `_detected_via: "changes-feed"`
plus the Drive `lastModifyingUser` identity, and their
`timestamp`/`source_updated_at` are the file's `modifiedTime` (the edit time),
not the poll time.

**Known trade-offs.** (1) A metadata-only change that bumps `modifiedTime`
(e.g. a rename) also emits one fast `doc_edited` — same over-trigger the
content-snapshot path already accepts. (2) In a multi-actor window, if the
fast row's actor is unknown, the Activity events it covers are suppressed
conservatively (no double-count is preferred over per-actor completeness; the
comment/suggestion streams are unaffected).

## Deletion propagation: trashed/removed docs deactivate their watermark (2026-07-05)

**Decision.** Cycle A consumes `removed: true` and `file.trashed: true` changes
instead of filtering them out: each one flips the doc's
`conversation_watermarks.is_active` to `false`
(`deactivateDocConversations`, `src/polling/_archived-gdocs/gdocs.ts`). Every
downstream sweep (comment refresh, suggestion sync) already selects on
`is_active = true`, so deactivation removes the doc from all recurring work in
one place. Untrash needs no special case — the next change for the file
re-upserts `is_active = true` through `trackDocConversation`.

**Why.** Before this, dead changes were silently dropped
(`!c.removed && !c.file.trashed`), so a trashed doc's watermark stayed active
forever: sweeps kept polling its comments and suggestions indefinitely — wasted
quota and a stale-data leak. `changes.list` already carried the signal
(`includeRemoved=true` was always set); we just threw it away. Note `removed`
also fires on *access loss* (file removed from the user's view), which
deserves identical treatment: stop sweeping what we can no longer read.

**Capture-time tombstones (2026-07-07).** Deactivating the watermark stops
future work but left the event stream with no record that the doc
disappeared. Each removed/trashed change now also writes an explicit
`activity_events` tombstone row (`writeDocTombstones`): event type
`doc_removed` for `removed: true` (file deleted **or** access lost — Drive
sends no file payload either way) and `doc_trashed` for `file.trashed`,
deterministically keyed `gdocs:tombstone:<fileId>:<kind>` so repeat
deliveries dedupe on the `(user_id, source_event_id)` unique index, with
`_deleted: true` / `_deleted_at` payload markers matching the gmail deletion
convention. Deletion is a capture-time-irreversible fact (AGENTS.md raw
capture rules); the tombstone is additive — existing doc events are never
mutated, and untrash resumes normal change events with no special case.

Two follow-ons (greploop round 2, 2026-07-05): deactivation also closes the
doc's still-open suggestion rows to `unknown` (the doc has left every sweep,
so nothing else would ever close them), and the **targeted** sync path skips
docs whose watermark is explicitly deactivated — a suggestion event racing
the removal must not resurrect derived rows (untracked docs still process;
only explicit deactivation skips).

**Alternatives rejected.**
- **Row deletion** — destroys `last_seen_ts` history and breaks re-activation
  on untrash; the boolean is the existing convention.
- **Cascading hard-delete of suggestion/tab rows** — those are historical
  events tied to a doc that *did* exist; keep them (same rationale as
  `google_doc_tabs.deleted_at` for deleted tabs).

**Revisit when.** Persisted artifacts get retention/erasure requirements
(e.g. org offboarding) — then trash/removal likely needs to propagate to
`google_doc_suggestions` / `google_doc_images` as a purge, not just a
deactivation.

## Scoped discovery: folder / query / shared-drive crawls (2026-07-05)

**Decision.** `gdocs.discovery` is an on-demand task (`discoverGoogleDocs`,
`src/polling/_archived-gdocs/gdocs.ts`) that seeds `conversation_watermarks`
from one of three scopes: recursive folder walk (`folderIds`), arbitrary Drive
`q` fragment (`query`), or per-shared-drive crawl (`driveIds`, or `"all"` via
`drives.list`). Discovery is deliberately **shallow** — it only upserts
watermarks; the existing poll/sweep/suggestion-sync cycles pick the docs up
from there on their own cadence. Per-drive crawls use `corpora=drive` +
`driveId` (Google's recommended form — `corpora=allDrives` is documented as
potentially incomplete and stays confined to the broad backfill). The folder
walk is BFS with explicit subfolder listing (Drive's `q` cannot express
recursion), deduped, and capped at `GDOCS_DISCOVERY_MAX_FOLDERS` (default
200) — a fan-out bound, reported via `foldersTruncated`, never a content
truncation. Not scheduled: scopes are caller-supplied config, so there is
nothing meaningful to run hourly; org-scoped ingestion (issue #8) will decide
what to enqueue.

**Why.** The change-feed and backfill only cover the corpus the impersonated
user already touches; onboarding an org's shared drive or a team folder needs
an explicit crawl. Prior art: Nango ships exactly these three discovery shapes
for Google Docs (folders / query / shared drives) as its non-auto-start syncs —
the scopes are proven; our difference is that discovery feeds the watermark
table instead of storing raw document blobs.

**Alternatives rejected.**
- **Fusing discovery into backfill** — backfill does per-doc Activity +
  comment hydration (expensive); pointing that at a whole shared drive would
  burn quota on docs nobody may care about. Seed cheaply, let the sweeps
  hydrate docs as they change.
- **`corpora=allDrives` for per-drive crawls** — flagged in Google's docs as
  potentially incomplete for large corpora; fine for the heuristic backfill,
  wrong for a crawl whose contract is completeness.

**Revisit when.** Issue #8 (org-scoped storage) lands — discovery then needs
an owner: which drives/folders each tenant crawls, on what schedule, and with
ACL awareness.

## Connect-time content backfill chain (2026-07-08)

**Decision.** Connecting Google enqueues the full content-capture chain, not
just watermark seeding:

1. `gdocs.discovery` (query mode, **no time bound** — the whole visible
   corpus). Discovery still seeds `conversation_watermarks`, and now also
   enqueues one `gdocs.content-snapshot` task per discovered **Google Doc**
   (Sheets/Slides have no structured-read content path — unchanged decision).
2. Each snapshot task captures `google_doc_tab_snapshots` rows AND
   materializes the per-tab mirror files (existing capture path in
   `content-snapshot.ts`), so a doc that **never changes after connect** is
   still fully captured.
3. `gdocs.backfill` (30 days, matching the gmail initial window) hydrates
   Activity edit/comment history for recently-active docs.

**Why.** Before this, connect enqueued only discovery, and discovery only
tracked watermarks; content snapshots fired exclusively from the change feed
(`changes.list`). A doc that existed at connect time and never changed again
was never content-captured — the critical backfill gap. The fix reuses the
existing snapshot task end-to-end: same dedupe key (at most one queued/running
snapshot per doc), same `priority: -5` (snapshots yield the shared
`<tenant>:gdocs` slot to the poll), same `modifiedTime`/revision dedupe
(`skipped_fresh` skips the Docs fetch entirely for already-captured
revisions). Re-connects and repeated discovery crawls are therefore idempotent
and cost ~one DB check per already-captured doc, not a re-fetch.

**Self-heal for later-discovered docs.** Newly shared/changed docs enter via
the change feed, which already enqueues snapshots; any later discovery run
(folder/drive/query crawls, KB-source attach) now snapshots what it finds too.
Rate limits: snapshot tasks serialize one-at-a-time on the tenant's gdocs
group key, so a large corpus drains gradually behind the poll instead of
bursting.

## Envelope authorship on mirror writes (2026-07-08)

**Decision.** The gdocs mirror envelope (`mirror_files.meta`) now carries
authorship + container identity, populated only from data already captured:

- `authorEmail`/`authorName` = the doc's first Drive **owner** — from
  `owners(displayName,emailAddress)` added to the *existing* `changes.list` /
  `files.list` field masks (no new API calls). Absent for shared-drive files
  (they have no owner) — absent, never guessed.
- `updatedByEmail` = Drive `lastModifyingUser` as seen with the change /
  discovery listing that triggered the capture.
- `sourceAcl` = `{ driveFolderIds: [...], readers?: [...], writers?: [...] }`.
  Folder lineage comes from already-captured
  `google_doc_sync_state.folder_ids`; per-principal access is read
  best-effort with Drive `permissions.list`
  (`permissions(emailAddress,role,type)`, `supportsAllDrives=true`) so
  person-document `HAS_ACCESS` evidence can be derived. Permission fetch
  failures leave `readers`/`writers` absent and never block the mirror write.
- `aliases` = email aliases for the owner + last editor.

Identity rides the `gdocs.content-snapshot` payload, is persisted on the
snapshot rows' `content` jsonb (additive keys: `authorEmail`, `authorName`,
`updatedByEmail`, `updatedByName`), and the mirror backfill reads it back from
the latest snapshot — reshape stays a DB operation, never a provider re-fetch.
Snapshots captured before this threading render with the fields absent.

Adjacent surfaces checked: gmail mirror writes already populate
`authorEmail`/`authorName`/`aliases` from the From header (messages are
immutable — there is no separate "last editor" to record); calendar mirror
writes already populate creator/organizer + attendee aliases, and the Calendar
API exposes **no last-modifying actor** on the event resource, so
`updatedByEmail` stays absent there.

## Drive folder KB selectors (2026-07-07)

Google Docs KB sources can now use provider terms:

```json
{ "driveFolderIds": ["folder-id"] }
```

`driveFolderIds` is recursive. During Google Docs sync, Aqueduct stores each
doc's direct Drive parent folders and all reachable ancestor folders in
`google_doc_sync_state.folder_ids`, plus the current mirror directory prefix
for that doc. If an ancestor folder cannot be read because the connector lacks
permission, sync continues with the reachable lineage and reports the failure
count in the sync summary or poll warning.

Graph ingestion treats selector clauses as OR terms. A source with both
`mirrorPathPrefixes` and `driveFolderIds` matches when either the mirror path is
under one of the prefixes or the Google Doc's stored Drive lineage overlaps a
selected folder. Backfills expand matching lineage rows into per-doc mirror
prefixes, then enqueue the same ingestable mirror files as live writes.

Pure folder moves are handled on sync: when a doc's stored lineage changes and
the new folder set enters a KB's `driveFolderIds` scope, the doc's existing
mirror files are enqueued for that KB even if document content did not change.
Leaving a folder scope stops future matching naturally; cleanup of claims
already ingested while the doc was in scope is intentionally out of scope for
this slice.

## Invariant: every Drive listing call is shared-drive-aware

All `files.list` / `changes.list` / `files.get` calls set
`supportsAllDrives=true` (+ `includeItemsFromAllDrives=true` on listings) —
audited 2026-07-05 across every call site in
`src/polling/_archived-gdocs/gdocs-api.ts` and the backfill. Omitting these
silently hides shared-drive files, which reads as "no data" rather than an
error; any new Drive call must keep the invariant. (The comments endpoints
take no such params — they're per-file.)

## Quota strategy

Drive's default per-user quota is 12,000 queries/100s (~120/s). Backfill runs
8 docs concurrently with an inter-doc stagger (~10–25 req/s, an order of
magnitude under the ceiling); the quota math lives in a comment at
`src/polling/_archived-gdocs/gdocs.ts:24`. Docs API calls go through
`throwIfGoogleRateLimited` / `googleRateLimitErrorFromResponse`
(`src/vault/google-rate-limit.ts`).

## Persistence: events, summaries, and content snapshots (2026-07-07)

**Decision.** Edits/comments become `activity_events`; docs are watermarked in
`conversation_watermarks`; LLM summaries live in `document_summaries`; and —
since migration 0012 — **doc content is persisted at capture time**. When
Cycle A sees a changed Google Doc in the change feed, it enqueues a
`gdocs.content-snapshot` task (one per doc, deduped while queued/running via
`dedupeKey`, `priority: -5` so it yields the shared `<tenant>:gdocs` slot to
the poll — same shape as the targeted suggestion sync). The task fetches the
doc **once** through the same `fetchDocContent` renderer the mirror uses and
appends one row per tab to `google_doc_tab_snapshots`, keyed
`(user_id, doc_id, tab_id, revision_id)`. **Version-append:** a new
`revisionId` is a new row set, never an overwrite; a revision already stored
is a no-op insert, and a change whose `modifiedTime` is already covered by a
stored snapshot skips the Docs fetch entirely
(`src/integrations/google/gdocs/content-snapshot.ts`). Rows carry the
rendered per-tab representation (markdown projection + pending suggestions +
`suggestionsAccessible`), `content_sha`, and `source_updated_at`.

**Redaction is structural, not best-effort:** the raw `documents.get` JSON is
run through `redactProviderPayload("google-docs")` and **re-rendered from the
redacted JSON** before anything is persisted, so a `contentUri` cannot reach
a row by any path. Image bytes are still captured from the unredacted
response via `storeDocImages` within the URI's ~30-minute window, exactly
like the backfill path.

**Why.** The locked maximal-capture principle: reshaping later must be a DB
operation, never a re-fetch. The previous design ("content is never
persisted") left doc content recoverable only by live-fetching from Google —
the one source in the stack whose raw material wasn't in our store, and a
gap the graph layer cannot read across.

**Mirror wiring (rewired 2026-07-07).** The snapshot task materializes the
per-tab mirror docs live right after persisting a new revision's rows (same
`materializeGoogleDocSourceWiki` renderer the backfill uses; staged envelope
`versionRef` = the revision id; rendered from the redacted JSON only).
Fail-soft: a staging error warns and never fails/retries the capture task.
The mirror backfill (`src/mirror/backfill.ts`) now renders tab content **from
`google_doc_tab_snapshots`** (latest revision per tab) — reshape is a DB
operation, never a provider re-fetch. The live Docs fetch survives only as a
self-healing fallback for docs that predate the snapshot table, and it runs
*through* `snapshotDocContent` so the fallback also persists the snapshot
rows; `SOURCE_WIKI_GDOCS_CONTENT_FETCH_LIMIT` (default 25) now caps only that
fallback. Snapshot-backed backfill renders have no raw JSON in hand, so they
preserve any capture-written `raw.md` instead of sweeping it.

## Staged projection evidence: exact snapshot refs (2026-07-11)

**Decision.** New Google Docs staged projections identify the immutable
snapshot used to render them in `sourceRefs`, not only in `versionRef`.
`materializeGoogleDocSourceWiki` (`src/mirror/materializer.ts:2365`) emits tab
content refs as `gdoc:<docId>:<tabId>:<revisionId>` and its capture-written
`raw.md` companion as `gdoc:<docId>:<revisionId>`
(`src/mirror/materializer.ts:355`). This extends the existing `gdoc` locator
with the already-persisted `google_doc_tab_snapshots.revision_id`; it does not
introduce a second locator vocabulary. Capture passes that revision to each
live tab (`src/integrations/google/gdocs/content-snapshot.ts:133`), and the
backfill threads each selected tab row's own revision rather than applying one
document-wide value (`src/mirror/backfill.ts:514`).

Each substantive pending suggestion is rendered at its existing
`### Suggestion <suggestionId>` heading and gets a source ref anchored to that
heading, pointing to the same exact tab snapshot. `contentUri` remains absent
from both evidence refs and persisted content; the deep-link URL is navigation
only. Comments and replies are still **not** folded into Google Docs tab
projections (see the settled comment-refresh decision above), so this change
does not synthesize a comment source ref. If they are rendered later, every
item must use its actual captured activity `source_event_id`; suggestion IDs
cannot be guessed into Activity rows because that API does not expose them.
Revisionless legacy projections retain their existing unqualified `gdoc` ref
rather than inferring a snapshot version.

**Why.** A document revision in envelope metadata alone does not let an
evidence resolver distinguish which immutable tab snapshot supplied a rendered
section. The per-tab snapshot key is already version-append and exact; using it
also avoids falsely attributing a tab that survives after a later revision
removes another tab.

**Alternatives rejected.** Using the newest document-wide revision for every
backfilled tab can point an older tab projection at a different raw snapshot.
Linking a rendered suggestion to a suggestion lifecycle event is also invalid:
the Docs body and Activity API do not share an event ID, while the snapshot
does preserve the exact rendered item. A `contentUri` is a requester-scoped
credential, not evidence or navigation metadata.

**Revisit when.** Comment/reply materialization is added to tab projections or
capture persists a direct raw event association for a suggestion; then add
per-item anchors only where the corresponding versioned raw record is known.

**Rate limits.** Only docs that actually changed in the poll window hydrate;
snapshot tasks serialize one-at-a-time on the tenant's gdocs group key, and
the modifiedTime/revision dedupe means a doc changed N times between polls
costs one `documents.get`, not N.

## No truncation (2026-07-03)

**Decision.** Google Docs content is never truncated anywhere in the pipeline.
The 100k-char cap on materialized tab content and the 50k-char cap on the
change-detection hash input were both removed. The hash now covers full
normalized content — the old cap meant edits past 50k chars never changed the
hash, so change detection silently missed them.

**Why.** Truncated mirrors are silently wrong for exactly the long documents
that matter most, and a hash over a prefix is a correctness bug, not a
performance win.

## Actor resolution: persistent identity cache + repair sweep (2026-07-03)

**Decision.** Drive Activity person IDs (`people/ACCOUNT_ID`) resolve through
a persistent `google_actor_identities` table (user-scoped, since People API
visibility is per-requester) with an in-memory 10-min L1 cache in front.
Successes, partials (display name visible, email hidden), and misses are all
persisted; non-resolved rows carry exponential retry backoff (1h → 4h → 16h →
64h, capped at 7 days). Partial identities surface the actor's real display
name with a null email instead of `"Unresolved Google actor"`. A scheduled
`gdocs.actor-repair` job (every 6h) appends one deduplicated
`actor_identity_resolved` observation for rows written while their actor was
unresolved, keyed on the original row id and stored `_google_actor_id`. It does
not patch the original raw event.

**Why.** Resolution runs on every poll cycle and quota was never the
constraint (People API critical reads: 90/min/user; `people:batchGet` takes
200 IDs — we batch 50). The real gaps were code defects: only successes were
cached, so permanently invisible actors were re-fetched every cycle forever;
the cache was memory-only, so restarts re-resolved everyone; and events
written during a People API hiccup stayed unresolved permanently despite the
person ID being stored on the payload.

**Unresolvable by design (not bugs).** Drive Activity's `User` union includes
`deletedUser` and `unknownUser` — no person ID exists, nothing to resolve.
And for `knownUser`, People API returns an email only if the actor's profile
is visible to the requesting user: out-of-domain collaborators typically
resolve to name-only (partial). The Docs UI can show an email where the API
does not, because the UI reads Drive *permission* entries (ACL data), not
People profiles — a future fallback could read `permissions.list` for
files the actor touched, but permission entries only cover collaborators,
not link viewers.

**Resolution quality depends on the auth model.** Today aqueduct is DWD-only,
which is the best case: the impersonated user's full Workspace directory
visibility. If plain per-user OAuth is ever re-enabled, People resolution
degrades to partial — `directory.readonly` only means something inside a
Workspace, so personal (gmail.com) accounts resolve only their own contacts
and most actors land as name-only or unresolved. Under a service-account +
folder-sharing model (Fivetran's Drive mode) it's structurally dead: an SA
has no contacts and no directory, every actor stays an opaque `people/…` ID,
and the identity table would fill with permanent negative rows — the only
attribution survivor is comment authorship, because `comments.get` embeds
`author.displayName` without a People lookup. If an SA-sharing connection
mode ever ships, disable the People path for those connections outright.

**Revisit when.** Unresolved-actor rates stay high for in-domain actors
(would suggest a scope problem, not a visibility one), or a Drive-permissions
fallback becomes worth the extra API surface.

## Tab naming

Tab names come from `tabProperties.title` (real user-visible names, nested tabs
included). Materialized paths key on `tabId` (rename-stable); the name is
display-only with `tabId` fallback. Single-tab docs surface Google's default
name "Tab 1" — the synthesized "Main" fallback in `content.ts` only triggers if
the API returns no tabs array at all.

## Live verification: harnesses + what is proven vs still blocked (2026-07-05)

**Decision.** Two runnable harnesses pin the integration to reality; run them
against a real doc after any change to the parse/sync surface:

- `scripts/oauth-live-test.ts` — the full read surface against a live doc
  (`ACCESS_TOKEN=$(gcloud auth print-access-token) DOC_ID=… npx tsx …`).
  Accepts a pre-minted token (gcloud path) or runs its own loopback OAuth
  flow (`GOOGLE_OAUTH_CLIENT_ID/SECRET`, Desktop-type client, port 4700).
- `scripts/db-persist-live-test.ts` — the persistence path: runs
  `syncDocSuggestions` against a local Postgres and dumps
  `google_doc_suggestions` / `google_doc_tabs` / `google_doc_tab_events`.

**Verified live 2026-07-04/05** (consumer `gmail.com` OAuth token, `drive`
scope, owner role): content/lists/styling/pipe tables; person/richLink/date
chips; OT changelog (120 ops) with deterministic suggestion authorship,
exact created/modified timestamps, modification counts; comment **and reply
edit detection**; attributed tab create/rename/move events; current tab tree
+ doc title; image bytes (tab-level image, PNG). DB persistence confirmed
idempotent across repeat runs. Three bugs were caught **only** by these live
runs (date-chip field name, stale changelog tab names, drizzle array
binding) — unit fixtures had encoded the same wrong assumptions.

**Still blocked — needs a `drive.activity.readonly` token:** the Drive
Activity API paths — the suggestion/comment event stream (targeted-sync
trigger), doc title-*change events* (current title works), and the
suggestion→`legacyCommentId` reply-text join. gcloud's default client cannot
mint that scope (Google blocks `drive` scopes for it; ADC `--scopes` requires
`cloud-platform` and its own client), and Composio/Nango managed apps do not
carry it either (no managed app exists for restricted Drive scopes — CASA).
The unblock is a one-time browser consent through our own OAuth client
(Desktop client + harness loopback flow, or `gcloud auth application-default
login --client-id-file=…`). Until then those three paths are
mechanism-implemented but production-population-unverified (see
google-access-matrix.md).

**Revisit when.** The Activity-scoped token lands — re-run harness steps 2/3
and the title-events probe, then upgrade the access-matrix cells from
"mechanism live, unconfirmed" to verified.
