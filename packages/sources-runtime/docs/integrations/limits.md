# Enforced limits & bounds

Every cap, budget, and truncation the system enforces, in one place. Two
reasons this doc exists: (1) so a limit is never a *silent* surprise — if
output looks incomplete, check here first; and (2) so tuning is deliberate —
each entry says what it protects and what lowering/raising it costs.

**Categories:**
- **Content-affecting** ⚠️ — can drop or truncate data that would otherwise be
  captured. These are the ones that matter for fidelity; each is logged when
  hit (no silent truncation) unless noted.
- **Cost/pacing** — concurrency, delays, TTLs, retry/backoff. Tuning changes
  throughput/quota pressure, not what data exists.

Defaults are shown; env-tunable ones name their variable. When in doubt, the
integration's decision record (`docs/integrations/<name>.md`) has the rationale.

---

## Content-affecting limits ⚠️

### Google Docs

| Limit | Default | Env | What it bounds / on hit |
| --- | --- | --- | --- |
| Embedded image bytes | 50 MB/image | `GDOCS_IMAGE_MAX_BYTES` | Larger images not stored; **logged** per image. Enforced pre-allocation (Content-Length check, streamed cap for undeclared bodies). Matches Google's insert limit, so real images pass. |
| Embedded images per doc | 1,000 | `GDOCS_IMAGE_MAX_PER_DOC` | Excess not fetched; **logged** with count. Runaway-doc backstop; real bound is bytes (worst case ~67 GB base64/doc — see google-docs.md). |
| Suggestion content-hash input | full content | — | No truncation (a 50k cap was removed) — hashing a prefix silently missed late edits. |
| Backfill live content-fetch | 25 most-recent docs/run | `SOURCE_WIKI_GDOCS_CONTENT_FETCH_LIMIT` | Older docs materialize metadata-only until touched; protects the shared Docs quota. Not a permanent drop — recency-bounded. |
| Targeted suggestion-sync docs/sweep | 25 | `GDOCS_TARGETED_SYNC_MAX_DOCS` | A suggestion flood enqueues ≤25 targeted syncs; **logged** remainder deferred to the hourly full sweep (not lost). |
| Discovery folder walk | 200 folders/run | `GDOCS_DISCOVERY_MAX_FOLDERS` | Fan-out bound on the recursive folder crawl (`gdocs.discovery`); on hit, **logged** + `foldersTruncated: true` in the result so the caller re-scopes. Docs inside visited folders are never dropped. |
| Changelog pages | 500 pages × 1,000 entries = 500k ops | — | Safety valve for `/revisions/load`; a doc with >500k OT ops truncates its changelog. No real doc approaches this. |
| Equation content | n/a | — | **Hard API ceiling** — Google exposes no equation content at any role; rendered as `[equation]`. Not our limit. |
| Suggestion placement context | 80 chars each side | — | Anchor snippet length only; full content is elsewhere. Not a content drop. |

Google Docs markdown is a **lossy projection** by design — the lossless
`raw.md` is the companion source of truth (see google-docs.md "Content
extraction"). The projection limits above are about the *bytes/count* of what
we additionally fetch and store, not the structured content, which `raw.md`
always holds in full.

### Gmail

| Limit | Default | Env | What it bounds / on hit |
| --- | --- | --- | --- |
| Materialized body length | 60,000 chars | — | Mirror body truncated with an explicit "_body truncated…_" note pointing at the raw event, which keeps full text. Deliberate (quoted-reply/HTML noise); differs from Docs' never-truncate rule. See gmail.md. |
| Index recent-messages | 100 | — | The generated index lists the 100 most recent messages; older ones are still materialized as files, just not in the index. |

### Slack

| Limit | Default | Env | What it bounds / on hit |
| --- | --- | --- | --- |
| Thread window size | 80,000 chars | — | Slack threads ignore time gaps and split only before appending a rendered message line that would exceed the cap; no message line is split. |
| Unthreaded session gap | 5 hours | — | A new Slack session-window document starts only when the timestamp gap between consecutive unthreaded channel messages is greater than this. |
| Unthreaded session size | 80,000 chars | — | A new Slack session-window document starts before appending a rendered message line that would exceed the cap; no message line is split. |
| Slack crumb floor | 500 chars | — | Smaller thread/session windows are counted as crumbs and skipped for graph materialization; original text remains in `activity_events`. |

### Google Calendar

| Limit | Default | Env | What it bounds / on hit |
| --- | --- | --- | --- |
| Delegated users at setup | 500 | `GOOGLE_CALENDAR_SETUP_MAX_DELEGATED_USERS` | Org-rollout enumeration cap; more users need a raised limit. |
| Calendars per user at setup | 200 | `GOOGLE_CALENDAR_SETUP_MAX_CALENDARS_PER_USER` | Per-user calendar cap at setup. |
| Full-sync event pages/calendar | 20 pages | `GOOGLE_CALENDAR_SETUP_MAX_FULL_SYNC_EVENT_PAGES_PER_CALENDAR` | Bounds first-connect cost; incremental sync then keeps current. |
| Event window | 6-month rollback + 12-month future | — | Events outside the window aren't synced (mirrors Google's own practical bounds). |

### Notion (fan-out bounds, not content truncation)

These limit how far reference-chasing goes; `markdown_truncated` is recorded
on the page summary when a budget is hit, so the state is observable.

| Limit | Default | Env |
| --- | --- | --- |
| Structured blocks / requests / depth | 5,000 / 500 / 512 | `NOTION_STRUCTURED_BLOCK_MAX_BLOCKS` / `_MAX_REQUESTS` / `_MAX_DEPTH` |
| Inline DB data sources / rows / row bodies / comment fetches / nesting | 5 / 500 / 100 / 100 / 2 | `NOTION_INLINE_DATABASE_MAX_*` |
| Child-page depth / pages | (see `NOTION_CHILD_PAGE_MAX_DEPTH` / `_MAX_PAGES`) | env |
| Unknown-block recovery | 300,000 chars / 300 requests | — |
| Property hydration items / properties | `NOTION_PROPERTY_HYDRATION_MAX_ITEMS` / `_MAX_PROPERTIES` | env |
| Breadcrumb ancestors, comment/view snapshot caps | various | `NOTION_*` env |

### Granola

| Limit | Default | What it bounds |
| --- | --- | --- |
| Transcript extraction context (accumulated previous chunks, tail-capped) | 80,000 chars | One transcript document per meeting; no windowing layer (window-target constants removed 2026-07-07 — were never wired). |
| Graph claim `event_at` | transcript chunk end time, else source_updated_at | Deterministic valid-from clock only; no LLM timestamping and no wall-clock fallback for backfills. |

### Raw PDFs

| Limit | Default | What it bounds / on hit |
| --- | --- | --- |
| Upload body | 50 MB | `POST /v1/pdfs` rejects larger raw PDF uploads with 413 before/while reading the body. Drive PDF intake uses provider bytes directly and records fetch failures. |

### Mirror — raw-payload rendering (all sources)

`boundJsonValue` bounds how much of a raw event payload is rendered into
markdown (the raw event row keeps everything). Truncation is marked inline
(`_truncated_items`, `_truncated_keys`, `…`):
- Standard: depth 8, 40 array items, 80 object keys, 600-char strings.
- Compact (nested contexts): depth 5, 12 items, 30 keys, 200-char strings.

### GitHub / Bitbucket issues (Nango proxy capture)

| Limit | Default | Env | What it bounds / on hit |
| --- | --- | --- | --- |
| Issue pages per repo per run | 100 pages | — | GitHub `per_page=100` / Bitbucket `pagelen=50`, so ≤10k / ≤5k issues/repo/run. Incremental cursor (`since` / `updated_on` filter) means steady-state runs page a handful; the cap is a runaway backstop, not a steady-state truncation. |

### Pending connectors (`_pending/`, not in launch registry)

Jira: description/comment text 5,000 chars each; 20 issue pages × 50; 30-day
backfill window. GitHub: 100 comment-issue-reference fetches. Documented here
for completeness; these light up when the connector graduates.

---

## Cost / pacing limits (no data impact)

### Concurrency (per-connector, env-tunable via `parseConcurrencyEnv`, hard max 10)

| Connector | Var | Default |
| --- | --- | --- |
| Gmail message fetch | `GMAIL_MESSAGE_CONCURRENCY` | 10 |
| gdocs backfill docs | `GDOCS_BACKFILL_DOC_CONCURRENCY` | 8 |
| Calendar sync / event store | `GOOGLE_CALENDAR_SYNC_CONCURRENCY` / `..._EVENT_STORE_CONCURRENCY` | 5 / 8 |
| Notion data source / metadata write | `NOTION_DATA_SOURCE_CONCURRENCY` / `NOTION_METADATA_WRITE_CONCURRENCY` | 5 / 8 |
| Granola notes | `GRANOLA_NOTE_CONCURRENCY` | 5 |
| Source-wiki backfill | `SOURCE_WIKI_BACKFILL_CONCURRENCY` | 8 |

Concurrency defaults are sized against per-API per-user quotas (the math lives
in code comments at each connector — e.g. Gmail 250 units/s, Drive 12k/100s,
Calendar 600/min is the tightest).

### Inter-request pacing / batch sizes

- gdocs: 300 ms inter-API, 500 ms inter-doc; People API batch 50 (API max
  200); actor-cache TTL 10 min; suggestion-sync 200 ms inter-doc.
- Granola: 220 ms between calls (no published quota — empirical).
- Slack history/replies: 1 request/min (`SLACK_HISTORY_RPM`) and 15
  messages/page (`SLACK_HISTORY_PAGE_LIMIT`) — Slack's 2025 non-Marketplace
  distributed-app limit (classification confirmed 2026-07-08); Socket Mode is
  the primary capture path, `slack.poll` is a 900 s gap-fill. Raise the env
  vars only if the app becomes Marketplace-listed. Other Slack methods keep
  their per-method buckets, keyed per workspace token (`slack/rate-limit.ts`).
- Changelog pagination: 1,000 entries/page.

### Watch channels & cursors

- Calendar watch TTL: 7 days (`GOOGLE_CALENDAR_WATCH_TTL_SECONDS`), renewed
  within a 24 h window.
- Drive push channels (if used): ~1 h–24 h; Gmail history cursor: expires
  ~weekly → full re-list; Calendar syncToken: 410 → full re-sync.

### Poll schedules (`startGooglePolling` etc.)

| Job | Interval |
| --- | --- |
| gmail.poll / calendar.poll | 120 s (`DEFAULT_POLL_FREQUENCY_SECONDS`) |
| gdocs.poll / notion.poll / granola.poll | 300 s |
| nango.poll (per tenant×provider polling floor) | 300 s |
| nango.proxy_issues (github/bitbucket issues via Nango proxy) | 300 s |
| slack.poll (gap-fill only; Socket Mode is the freshness path) | 900 s |
| slack.discover | 180 s |
| gdocs.comment-sweep | 60 s |
| gdocs.comment-refresh / gdocs.suggestion-sync | 3,600 s (+ event-driven) |
| gdocs.actor-repair | 21,600 s |

### Task queue (`enqueueTask` defaults)

- Max attempts: 3 · heartbeat timeout: 120 s · priority: 0 (sync) / -10
  (backfill) · group serialization: 1 running task per `group_key`.
- Source tasks now write one `source_sync_runs` row per poll/backfill-style
  run with the task kind in metadata and result counters where the poller
  returns them. Permanent credential failures mark the connection `error`,
  disable that integration's schedules, and emit `connection.credential_failed`
  with a sanitized error summary.

### Outbox dispatcher

- Max delivery attempts: 8 · backoff 30 s → 3,600 s · circuit opens after 5
  failures for 300 s · delivery timeout 10 s · lease 300 s.

### Agent/actor caches, OAuth state TTLs

- iMessage agent-token cache: 60 s. gdocs actor identity: persistent + 10-min
  in-memory L1. OAuth state TTLs (Granola/GitHub/Jira): 10 min.

---

## The rule behind all of these

**No silent caps.** Any limit that can drop or shorten data logs when it fires
(image size/count, targeted-sync burst, Notion budgets via `markdown_truncated`,
mirror payload via inline `_truncated_*` markers, Gmail body via its note).
Pure cost/pacing limits don't log — they change *how fast*, not *what*.

When raising a content-affecting limit, check its cost note (image bytes →
Postgres size; concurrency → per-user quota). When you add a new bound, add a
row here and make sure it's observable when hit.
