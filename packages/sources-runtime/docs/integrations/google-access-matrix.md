# Google access matrix: auth method × file role × account type

The definitive reference for what Google data is available, partially
available, or unavailable — and under which conditions. Everything here was
verified against Google API references, role docs, and live code during the
2026-07-03 research sessions (knowledge base entries: "Google access gates
beyond scopes", "Suggestion placement, authorship, and discussion threads",
"People API actor resolution", "Drive change detection: poll vs push").

Access is gated on **three independent axes** — only the first is about
OAuth scopes:

1. **Auth method** — which principal you act as, which scopes you can hold.
2. **Per-file role** — reader/commenter/writer/owner *on each file*. Same
   token, same scope, different answer per file.
3. **Account type** — Workspace vs consumer (gmail.com). Gates whole feature
   families regardless of scopes or roles.

A fourth pseudo-axis runs underneath all three: **API ceilings** — signals
Google exposes to nobody (session diffs, comment-edit events in the Activity
API, suggestion authorship by ID). No auth method reaches those.

---

## Axis 1 — the three auth methods in detail

### Method A: 3-legged user OAuth

One human clicks Authorize on Google's consent screen; you store their
refresh token and act *as that user*. Capability equals that user's
visibility, one consenting user at a time.

- **Scope handling:** incremental — you can request additional scopes later
  (Fivetran uses this: labels/permissions scopes only when the feature is
  toggled on). Keeps the base consent minimal.
- **Compliance tax:** `gmail.readonly`-class scopes are **restricted**: apps
  requesting them from external users need Google's app verification plus an
  annual CASA security assessment, and must honor Limited Use. `calendar.*`
  is merely *sensitive* (lighter review). Drive read scopes sit in between.
  The burden attaches to the **app**, not the account type.
- **Reach:** works for both Workspace and consumer accounts — the only method
  that touches gmail.com users at all.
- **Aqueduct status:** disabled. `getGoogleAccessToken` throws
  "Per-user OAuth is disabled"; the callback route answers 410
  (`src/vault/google-auth.ts:436`, `src/integrations/google/index.ts`).

### Method B: service account + resource sharing (no impersonation)

A service account is its own principal — a "user" whose world contains only
what has been explicitly shared with its email address. Fivetran
auto-generates one per customer account for its Drive connector; the customer
shares a folder as Viewer.

- **No consent screen, no verification, no CASA** — nothing is requested
  from any human beyond a share action.
- **Structural limits:** an SA without delegation has **no mailbox, no
  calendar, no contacts, no directory**. Gmail and Calendar are simply
  impossible; People resolution is dead (every Drive Activity actor stays an
  opaque `people/…` ID forever).
- **Role reality:** shares are typically Viewer, so everything role-gated at
  commenter+ (suggestions view) or writer+ (revisions) is unavailable in
  practice, not just in theory.
- **The one attribution survivor:** `comments.get` embeds
  `author.displayName` in the thread itself, so comment authorship works
  without People access.
- **Aqueduct guidance:** if an SA-sharing connection mode ever ships, disable
  the People path for those connections outright (permanent negative rows
  otherwise).

### Method C: domain-wide delegation (ours)

A Workspace admin registers the SA's OAuth client ID with an allowed scope
list in the Admin Console; the SA mints tokens impersonating **any user in
the domain** via JWT-bearer grant (`urn:ietf:params:oauth:grant-type:jwt-bearer`).

- **No consent screens ever**; the admin's grant is the consent. No CASA
  (nothing is requested from external users).
- **Scope handling:** the inverse of Method A — the scope list is
  pre-registered in the Admin Console, all-or-nothing per scope, no
  incremental requests. Adding a scope means an admin touching the console.
- **Reach:** Workspace only. Consumer accounts **cannot be impersonated,
  period** — our code rejects personal emails explicitly
  (`google-auth.ts:427`).
- **Per-user semantics:** once impersonating a user, every per-file role gate
  applies exactly as if that user had OAuth'd. DWD does not elevate file
  access.
- **Directory power:** the impersonated user's full directory visibility for
  People resolution (subject to admin directory-visibility settings), plus
  Admin Directory API for enumerating domain users (calendar org rollout).
- **Aqueduct status:** the only enabled method. Per-scope-set token minting
  with an in-memory delegation cache (`src/vault/google-auth.ts`). Because it
  impersonates real users, it satisfies the writer+ role gate on the ported OT
  changelog client for any doc the impersonated user can edit — the one auth
  method that unlocks per-character attribution and suggestion authorship for
  our own users' docs without extra sharing.

---

## Axis 1 × capability matrix (everything we've built)

| Capability | A: User OAuth | B: SA + sharing | C: DWD (ours) |
| --- | --- | --- | --- |
| Drive change detection (Changes cursor) | ✅ full corpus | ⚠️ shared corpus only | ✅ full corpus, every user |
| Docs content + tabs (`documents.get`) | ✅ | ✅ shared files | ✅ |
| Suggestions content (`SUGGESTIONS_INLINE`) | ⚠️ role-gated (axis 2) | ⚠️ Viewer shares → almost always preview-only | ⚠️ role-gated (axis 2) |
| Suggestion lifecycle events (Activity API) | ✅ | ⚠️ events visible, actors opaque | ✅ |
| Edit activity + attribution | ✅ | ⚠️ events yes, actors unresolvable | ✅ |
| Comment detection (Activity sweep) | ✅ | ⚠️ same actor caveat | ✅ |
| Comment thread text (`comments.get`) | ✅ | ✅ incl. author display names | ✅ |
| People resolution | ⚠️ Workspace user: good; consumer user: contacts-only | ❌ structurally dead | ✅ full directory |
| Gmail history sync | ⚠️ works; restricted scope → verification + CASA | ❌ no mailbox | ✅ |
| Calendar sync + watch channels | ✅ | ❌ only individually-shared calendars | ✅ |
| Calendar org rollout (Admin Directory) | ❌ | ❌ | ✅ DWD-only |
| Comment-edit refresh (`comments.list?startModifiedTime`) | ✅ | ⚠️ shared docs only | ✅ |
| Public Revisions API (unused by us) | ⚠️ writer+ only (axis 2) | ⚠️ Viewer shares → nothing | ⚠️ writer+ only |
| **OT changelog** — per-char attribution, sessions, suggestion authorship (ported, `/revisions/load`) | ⚠️ writer+ only (axis 2), expected-works | ❌ Viewer shares → nothing; SA token unverified on web endpoint | ⚠️ writer+ only; verified under DWD |
| Suggestion authorship + exact update times + content↔author bridge (via changelog `sugId`) | ⚠️ writer+ only | ❌ | ✅ **scheduled** (`gdocs.suggestion-sync`, hourly) at writer+ |

> The last two rows are the ported OT changelog client
> (`src/integrations/google/gdocs/revisions.ts`). Suggestion authorship +
> content/placement/timestamps are now **synced hourly** into
> `google_doc_suggestions` (`gdocs.suggestion-sync`); session diffs and
> per-character attribution remain opt-in via the façade. Their column marks
> are **role-bound**: even under DWD they need writer+ on the file (axis 2),
> because `/revisions/load` reads version-history data and DWD does not elevate
> file access. The job fails soft per doc and monitors the null rate.

---

## Axis 2 — per-file role gates (identical under every auth method)

| API behavior | reader | commenter | writer+ (incl. owner/organizer/fileOrganizer) |
| --- | --- | --- | --- |
| `documents.get` `PREVIEW_WITHOUT_SUGGESTIONS` | ✅ | ✅ | ✅ |
| `documents.get` `SUGGESTIONS_INLINE` / `PREVIEW_SUGGESTIONS_ACCEPTED` | ❌ **hard 403** ("permission to view suggested changes") | ✅ (per docs; unverified empirically) | ✅ |
| `documents.get` `DEFAULT_FOR_CURRENT_ACCESS` | ✅ silently downgrades to preview | ✅ inline | ✅ inline |
| Read comment threads (`comments.list/get`) | ✅ | ✅ | ✅ |
| Add comments | ❌ | ✅ | ✅ |
| Public Revisions API ("Access historical revisions") | ❌ | ❌ | ✅ |
| **OT changelog** `/revisions/load` (ported client) | ❌ likely 403/empty | ❓ untested | ✅ owner/organizer/fileOrganizer/writer |
| Drive Activity visibility | follows file access | | |

The OT changelog row is the load-bearing new gate: the ported client
(`fetchDocChangelog`) gives per-character attribution, editing sessions, and
deterministic suggestion authorship — but **only for docs the acting user can
edit**. Under DWD that means docs the impersonated user owns or has writer+ on;
a doc merely shared read-only with them yields no changelog. Commenter-role
behavior is untested (version-history UI is hidden from commenters, so likely
no). The client fails soft (returns null), so a role miss is a quiet "no data,"
not an error.

Consequences in our code: `fetchDocContent` requests `SUGGESTIONS_INLINE` and
falls back to `PREVIEW_WITHOUT_SUGGESTIONS` on 403 — reader-only shared docs
sync with content but without suggestions, under DWD exactly as under OAuth.
The degradation is **recorded, not silent**: `DocContent.suggestionsAccessible`
flows into the mirror, and affected tab files carry a
"Suggestions: not visible (view-only access)" metadata line so consumers can
distinguish "no pending suggestions" from "not allowed to see them".

---

## Axis 3 — account-type gates (Workspace vs consumer)

| Feature | Workspace | Consumer (gmail.com) |
| --- | --- | --- |
| DWD impersonation | ✅ admin installs | ❌ impossible |
| People directory (`directory.readonly`) | ✅ (admin visibility settings can still hide users) | ❌ no directory exists |
| Drive labels | ✅ | ❌ feature doesn't exist |
| Drive Activity API | ✅ | ✅ |
| Core Drive/Docs/Gmail/Calendar APIs | ✅ | ✅ (CASA applies to the app, not the account) |
| Shared drives | ✅ | ❌ (My Drive only) |

---

## The API ceiling — unavailable via *public* APIs

The middle column is what public Google APIs give any caller. The right column
is the **ported + now-scheduled** OT changelog client (`/revisions/load`,
`src/integrations/google/gdocs/revisions.ts`) — in-repo, tested, and consumed
hourly by `gdocs.suggestion-sync`. **Writer+-gated** (a caller needs edit
access to the file; under DWD, docs the impersonated user can edit). ✅ =
available, in-repo, and consumed by a scheduled job; ◐ = the client can do it
but no scheduled code path consumes it yet (opt-in via the façade); ❌ =
unreachable by that column at all. Undocumented endpoint: no SLA, may break or
be blocked anytime, ToS-gray — the client fails soft (returns null), and the
job warns on an all-null run.

| Signal | Public APIs | Ported OT changelog (writer+ only) |
| --- | --- | --- |
| Session-level edit diffs ("See changes") | ❌ | ◐ full OT ops with `sessionId`/`sessionIndex`, per-character attribution, `replayWithDiffs` |
| Named-version list | ❌ | ❌ (not in changelog either) |
| Revision granularity | ⚠️ writer+, metadata + whole-revision export; purgeable revisions auto-merge/delete (~30 days) | ◐ complete changelog, no merge loss |
| **Comment edit events** | ⚠️ no Activity `EDITED`; **now mitigated** by our hourly `gdocs.comment-refresh` (`comments.list?startModifiedTime`); Events API preview `comment.v3.edited` (issue #7) closes it real-time | ❌ (comments aren't body ops beyond annotations) |
| Suggestion edit events | ❌ no `EDITED` subtype; our content hash detects state change, unattributed | ◐ `iss`/`dss` ops carry userId + timestamp |
| Suggestion authorship by `suggest.*` ID | ❌ (open Google feature request); substitutes: Activity `ADDED` event at creation, DOCX export tracked changes | ✅ **deterministic** — `trackSuggestions` groups `sugId`+`userId`; no heuristic |
| Suggestion reply/discussion **text** | ✅ **very likely available** — suggestion-reply Activity events carry `fileComment.legacyCommentId`; our live code feeds it to `comments.get` and stores `replyContent` (`gdocs-comments.ts` `doc_suggestion_reply_added`). Only "confirmed populated in prod" is pending (`verify-suggestion-reply-access.ts`). | ❌ not in the OT stream — but the public comments-API path above covers it |
| **Content ↔ authorship bridge** (which pending suggestion, whose) | ❌ | ✅ **deterministic** — Docs API `SUGGESTIONS_INLINE` and the changelog share the SAME `suggest.*`/`sugId` namespace; join by exact ID, no timing window |
| Actor identity for `deletedUser` / `unknownUser` | ❌ no person ID exists | ⚠️ changelog `userMap` may still name them (id → display name, People-independent) |
| Actor email when profile hidden | ⚠️ name often visible, email not; `permissions.list` ACL emails are now captured as access evidence, not edit authorship | ⚠️ display names via `userMap`, no emails |

### Suggestion reply text — the honest state (mechanism is live; population unconfirmed)

This doc twice claimed reply text is flatly unavailable. **Both times that was
wrong**, and the second time contradicted this very section. The real state:

- When you reply to a suggestion in Google Docs, the reply thread is a
  **comment/discussion resource**, and its Activity events carry a
  `fileComment.legacyCommentId`. Google documents that ID as "compatible with
  the Drive API; see comments/get."
- **Our own live code already retrieves it.** `gdocs-comments.ts` classifies
  `doc_suggestion_reply_added`, extracts the `legacyCommentId`, calls
  `getComment(fileId, commentId)`, and stores `replyContent` +
  author from the returned reply thread. gigabrain ships the same path. Two
  independent pipelines are built on "this works" — it is not an untried idea.
- The only thing NOT yet confirmed is whether `enriched` comes back **populated
  vs null** in production. If null, we'd store `replyContent: null` and lose
  nothing else. `scripts/verify-suggestion-reply-access.ts` (or just inspecting
  a stored `doc_suggestion_reply_added` event's `replyContent` for a real doc)
  confirms it in minutes.
- The earlier "unavailable" sources were about **different lookups** — the
  `suggest.*`-ID query (SO 63698770, genuinely fails) and Docs-body extraction
  (no reply data by that method). Neither touched the `legacyCommentId` →
  `comments.get` path we actually use.
- So the cell is **✅ very likely available** (mechanism implemented and live),
  pending only a prod-populated confirmation — NOT ❌.

---

## Operational nuances that cut across everything

- **Change-signal mechanics:** Drive `changes.watch` webhooks carry **no
  payload** (poll triggers only) and expire in ~1h–24h; Calendar channels
  live 7 days (why Calendar uses push and Drive polls); Gmail push is
  Pub/Sub-based and also just delivers a `historyId`. Workspace Events API
  (Pub/Sub, real payloads, `comment.v3.edited`) is preview-only and targets
  single files / shared drives — no whole-My-Drive subscription (issue #7).
- **Cursor expiry:** Gmail `historyId`s expire (~a week of inactivity) —
  `history.list` 404 means full re-list. Calendar `syncToken` expiry
  surfaces as 410 GONE → full re-sync (handled). Drive page tokens are
  long-lived.
- **Export ceiling:** `files.export` caps at 10 MB per export; native
  Workspace files report `size: 0` in Drive metadata.
- **Quota quick reference (per user):** Drive ~12,000 queries/100s · Gmail
  250 units/s (`messages.get` = 5) · Calendar 600 queries/min (tightest) ·
  People 90 critical reads/min, `people:batchGet` ≤ 200 IDs.
- **mtime is a trap** (for anyone using it as a change signal — we don't):
  IMPORTRANGE-fed and Forms-populated Sheets don't bump modified time.
- **Undocumented endpoint in the tree:** the ported OT changelog client hits
  `docs.google.com/.../revisions/load` (not `googleapis.com`). It's the one
  non-public surface we depend on; fails soft to null; **now consumed hourly by
  `gdocs.suggestion-sync`**, which logs the changelog-null rate and warns on an
  all-null run. Disable that schedule if the tripwire fires persistently.

## What changed 2026-07-05 (live verification)

Everything below was exercised against a **real doc** with a consumer-account
OAuth token carrying the full `drive` scope (owner role), via
`scripts/oauth-live-test.ts` + `scripts/db-persist-live-test.ts`:

- **Confirmed live:** `SUGGESTIONS_INLINE` content+placement; the OT changelog
  (`/revisions/load`) with deterministic suggestion authorship, exact
  timestamps, and modification counts; comment **and reply edit detection**;
  attributed tab create/rename/move events; current doc title; image bytes via
  `contentUri`. So the Method A column for these rows is now *verified*, not
  inferred — including that the changelog works under plain user OAuth with
  owner role (the writer+ gate, not the auth method, is the binding axis).
- **Still unverified (scope-blocked, not role-blocked):** the three Drive
  Activity API paths — suggestion/comment event stream, title-*change* events,
  and the suggestion-reply `legacyCommentId` join (the section above). Our
  test token lacks `drive.activity.readonly`: gcloud's default client refuses
  Drive scopes, and Composio/Nango ship **no managed Google app** (restricted
  scopes force bring-your-own-client everywhere — Google's CASA regime makes a
  shared multi-tenant OAuth app for full-Drive access unviable). Unblock = one
  browser consent through our own OAuth client.

## What changed recently (2026-07-03)

- **Comment/reply edits** are no longer a silent staleness hole: the hourly
  `gdocs.comment-refresh` job re-lists comments for active docs and patches
  drifted content (the Activity API has no `EDITED` signal). Real-time closure
  waits on the Events API (`comment.v3.edited`, issue #7).
- **Suggestion content** is captured (`SUGGESTIONS_INLINE`) with placement
  anchors and full lifecycle subtypes; reader-role docs degrade to
  content-without-suggestions, recorded via `suggestionsAccessible`.
- **Deterministic suggestion authorship + exact update timestamps** are now
  synced hourly (`gdocs.suggestion-sync` → `google_doc_suggestions`) via the
  ported OT changelog client — writer+-gated, fail-soft, null-rate monitored.
  Editing sessions and per-character diffs are in the client but not yet
  consumed by a scheduled path (opt-in via the façade).
- **Actor identity** is a persistent user-scoped cache with negative-result
  backoff and a repair sweep, replacing the old memory-only resolve-every-cycle
  path.

## The one-line summary

Scopes decide what your *token* may ask; role decides what each *file*
answers; account type decides which *features exist*; and above all three
sits a ceiling of signals Google keeps for itself — into which the ported
changelog client reaches, at the price of an undocumented endpoint. Our DWD
deployment maxes out axes 1 and 3; axes 2 (role) and 4 (ceiling) bind us like
everyone else, the changelog client included — it needs writer+ on the file no
matter how we authenticate.
