# Source Pipeline Plan — connect → pull → raw → stage, ready for the graph

Status: committed plan of record for the **sourcing plane** (2026-07-07).
Scope: 11 surfaces — Gmail, Calendar, Google Docs (DWD-only), Granola (API key + OAuth),
Notion, Slack, raw PDFs, Jira, Confluence, Bitbucket, GitHub. Snowflake dropped.
Derived from the graded per-source audits and adversarial verification passes
(working ledgers in the planning workspace `.context/kg-dod/`, `.context/kg-plans/`);
this document is the durable summary those ledgers back.

## 0. Plain-language summary (read this first)

1. A company admin clicks "Connect" on the website for each tool the company
   uses; teammates connect their personal ones (their Granola, their Slack).
2. Our backend continuously pulls everything from those tools and saves **two
   copies**: the exact original data (nothing ever lost; we can always change
   our minds later), and a clean readable version with consistent labels —
   who wrote it, when, where it came from.
3. Every clean document traces back to its exact original — this email, that
   meeting transcript, that specific Slack message.
4. Ishan's graph later reads only the clean copies. It never needs to know
   which tool anything came from, and nothing here touches his code.
5. If a source quietly stops syncing, hits a rate limit, or drops something,
   that must show up where a human sees it. Silence is a bug.

Everything below is making those five sentences true for eleven tools that
each fail in their own ways. **Acceptance is by demo, not checklist** — each
stage in §8 names what you can see working; if the demo fails, the stage
isn't done.

## 1. The two-plane split

Everything in this repo divides at one boundary:

- **Plane 1 — sourcing (this plan):** auth/connection → pull → raw capture →
  preprocess/render → **land in staging**. Site-facing, graph-agnostic,
  runnable with the graph entirely off.
- **Plane 2 — graph (Ishan's):** pickup from staging → `source_documents` →
  chunks → claims → entities → pages. Nothing in this plan modifies plane 2
  except two additive channels it already expects (`meta.aliases`, chunk-level
  timestamps).

The frozen interface between the planes is the ingest envelope (§4). Plane 2
can change freely above it; plane 1 can change freely below it. A source is
"done" here when its data sits in staging in the correct format with complete
metadata — whether or not any graph exists yet.

## 2. Pipeline shape (identical for every source)

```
CONNECT (site API) ─→ PULL (cursors/webhooks on task_queue) ─→ RAW (layer 0)
                                                                   │
                                              PREPROCESS (render to markdown,
                                              redact, bound, normalize)
                                                                   │
                                                            STAGE (layer 1)
                                                                   │
                                        [graph pickup — plane 2, later]
```

Two auth/transport lanes, one landing place:

- **Vault lane** (native connectors): Google (DWD service-account impersonation,
  per-user OAuth stays disabled), Granola (API key + OAuth-MCP), Notion
  (OAuth + manual token), Slack (user-token OAuth — Nango's bot-token Slack sync
  stays rejected per `docs/integrations/sync-platform.md`; user tokens are what
  capture per-user visibility incl. DMs).
- **Nango lane** (everything we haven't built natively): Jira, Confluence,
  Bitbucket, GitHub. Nango holds OAuth and runs the syncs; we consume records.
  **Rule: nothing Nango-shaped survives past the processor** — every record is
  preprocessed into the same raw rows and staged documents as the native lane.
- New sources default to the Nango lane unless a native connector exists or the
  provider's auth/visibility model requires one.

## 2a. Deployment (AWS, minimal)

**AWS target (recorded 2026-07-07):** account **137787521396**, region
**us-west-2**, admin IAM user `aqueduct-admin` (AdministratorAccess for
bootstrap; narrow after infra exists). CLI creds live in `~/.aws/credentials`
(+ mirrored in `~/.aws/aqueduct-secrets.env`), mode 600, never committed.
Greenfield account — no pre-existing infra to protect. **Rotate the bootstrap
key after infra is up** (it was transmitted in plaintext once). All resources
are `aqueduct-`prefixed; dev lane built first, prod identical beside it.

**Maximal-raw-capture principle (locked):** capture EVERYTHING a source
exposes now — the fullest redacted provider payload into
`activity_events.raw_payload` (and bytes into S3 for binaries) — so that
*reprocessing* (better rendering, new derived fields, richer graph extraction)
is later a pure database/S3 operation in AWS, never a re-fetch from the
provider. Redaction of credentialed/ephemeral URLs is the only transform
allowed at capture; everything else stays regenerable. This applies to the
Nango lane too: store the complete Nango record, not a projection.

**Nango = capture-all-models, render-incrementally (locked 2026-07-07):**
Capture is NOT gated on having a per-model renderer. A single generic
Nango→`activity_events` path stores EVERY record of EVERY model Nango emits
per provider — Jira issues + comments + projects + users + changelog;
Confluence pages + attachments + blogposts + comments; Bitbucket PRs + commits
+ repos + branches; GitHub issues + PRs + commits + repos + releases — full
redacted payload, keyed `nango:<provider>:<model>:<id>:<version>`. Nothing is
dropped for lack of a renderer. A thin rendering layer then materializes mirror
docs for the high-value models now (issues, pages, PRs); every other captured
model sits in raw, reprocessable into mirror docs / derived fields / graph
inputs later as a pure DB job. `graph.ingest_document` is Ishan's plane-2 task
and is NOT our capture path — the graph reads from `activity_events`/mirror.


- **One RDS Postgres** — all tables (task queue, raw events, mirror/staging,
  graph). Migrations via `drizzle/` + `assertMigrationsApplied`.
- **S3** — binary raw store (§5c). **Secrets Manager** — `ENCRYPTION_KEY`
  (key-versioned per S0), `NANGO_SECRET_KEY`, LLM keys.
- **Three processes**, matching `src/entrypoints/`: API (Hono), worker (queue
  lanes + outbox dispatcher), and the **sweeper** (fires `task_schedules`) —
  without the sweeper nothing polls and no raw data flows. Workers scale
  horizontally; group-key discipline makes that safe.
- **Provisioning prerequisite:** `tenants`, `api_keys`, `kb_containers` have
  **no writers anywhere in the repo** — a tenant + API-key minting
  script/endpoint is S0 work before any onboarding; the kb_containers/
  kb_members writer belongs to the graph-phase provisioning.

## 3. The landing place (the "filter/structuring" layer)

Two layers, both in the one Postgres (plus S3 for bytes). No new subsystems.

**Layer 0 — raw (immutable-ish, the drill-into layer):**
- `activity_events` — one row per provider item/version, full (redacted) provider
  JSON in `raw_payload`, deduped on `(user_id, source_event_id)`. Deletions are
  captured as tombstone events, never as overwrites.
- `binary_documents` (new, content-addressed by sha256) + S3 — bytes for PDFs
  and future attachments.
- Connector state tables (snapshots, watermarks) as they exist today.

**Maximum-leverage raw rules** (so anything can be reshaped later without
re-fetching providers):
- Capture the **fullest redacted API payload**, never an allowlisted projection.
  (Granola currently persists a trimmed projection — widen it; the Nango lane
  stores full records; keep provider fields we don't use yet.)
- **Version-append for mutating sources**: where the provider mutates content
  in place (Jira issues, Confluence pages, Granola notes, Notion pages), the
  `source_event_id` scheme includes the version/updated stamp
  (`jira:issue:<id>:<updated_at>`, `confluence:page:<id>:v<n>`) so each version
  is a new raw row rather than an overwrite. Immutable items (gmail messages,
  slack message events, commits) stay one-row. [Pending sign-off — see open
  decisions; storage is the only cost, replay leverage is the win.]
- Redaction is the **only** transformation permitted at capture; everything
  else (rendering, bounding, normalization) happens at staging, where it is
  regenerable.

**Layer 1 — staged documents (regenerable, the graph's pickup surface):**
- `mirror_files` — one rendered **markdown** file per unit-of-document under
  `sources/<provider>/...`, content-sha gated, plus **one additive column**:

```
mirror_files.meta jsonb — the staged-document envelope:
{
  provider, externalId,          // IMMUTABLE native id (never names/titles/paths/keys)
  sourceNamespace?, representedType?,
  kind: document | conversation_window | code_file,
  title, versionRef, sourceUpdatedAt,
  sourceAcl: { ...access metadata... },           // containment is not ACL
  authorEmail, authorName, updatedByEmail,
  aliases: [{kind, value}],                        // identity contributions
  sourceRefs: [{anchor, sourceEventId?, sha256?, url?}], // anchor + event id or sha required
  sourceLinks?: [{role, target:{provider, namespace, id}}]
}
```

Properties that make this the stable base "no matter what changes":
- **Regenerable:** layer 1 can always be re-rendered from layer 0 (renderer fix →
  re-render sweep → content-sha changes → downstream re-processes). Layer 0 can
  be regenerated from nothing — so every irreversible rule (redaction, identity,
  tombstones, timestamps) is enforced at capture, and rendering quality can
  iterate safely afterward.
- **Uniform:** a Jira issue, a Slack day, and a Google Doc tab are
  indistinguishable rows here. The graph (or anything else — search, exports,
  the site's file browser via `/v1/files`) picks up staged docs without knowing
  which lane produced them.
- **Graph pickup:** the existing mirror-ingest hook, upgraded to read
  `meta` (stable externalId + full envelope) instead of inferring from paths,
  becomes the single pickup mechanism when Ishan turns the graph on. Until
  then, staging just accumulates.

## 4. The frozen envelope (plane boundary)

Graph pickup consumes exactly the staged envelope via `graph.ingest_document`
(+ `graph.delete_document`): payload `{kbId, tenantId, provider, externalId,
content, meta:{…as §3…, mirrorPath}}`; dedupe key
`ingest:<kb>:<provider>:<sha256(externalId:versionRef:contentSha)>`; delete key
`delete:<kb>:<provider>:<sha256(externalId)>`; all graph tasks serialize on
`graph:<kbId>`; version-skip comparison matches the ref type (numeric vs
string/checksum equality); selectors fail closed (empty = nothing, wildcard
explicit `"*"`); `event_at` cascade at extraction: explicit in-text date →
per-section timestamp (sourceRefs/chunk meta) → `sourceUpdatedAt` → null, and
world-time beats arrival-time in contradiction adjudication.

## 5. Raw-referenceability (query-time drill-down, per source)

Every staged doc must let an LLM (or a human) walk from any answer back to the
exact raw thing. `meta.sourceRefs` maps rendered sections (anchors = the stable
section headings the renderer already emits) to raw identifiers:

| Source | Unit of staged doc | Raw ref granularity (`sourceRefs`) | Deep link |
|---|---|---|---|
| Gmail | thread (conversation_window) | per message: `gmail:<messageId>` event row | message webUrl |
| Calendar | event (document) | event snapshot + `gcal:<calendarId>:<eventId>` | event htmlLink |
| Google Docs | tab (document) | tab snapshot `gdoc:<docId>:<tabId>:<revisionId>`; raw companion `gdoc:<docId>:<revisionId>` | doc URL#tab |
| Granola | meeting summary + transcript | note event row + `calendar_event_id`; transcript sections per speaker-turn window | note webUrl |
| Notion | page / row / child page | page + per-block ids (block `last_edited_time` feeds section timestamps) | page URL |
| Slack | channel-day (conversation_window) | per message: `slack:<channel>:<ts>` event row | permalink |
| Jira | issue (document) | `jira:issue:<id>:<updated_at>` event rows; per comment: comment id | issue URL |
| Confluence | page; comments doc | `confluence:page:<id>:v<n>` event rows | page URL |
| Bitbucket/GitHub | PR/issue (document); repo record (document) | record event rows; commits `<repo>:<sha>` (identity only) | PR/issue/repo URL |
| PDFs | one PDF (document) | `sha256(bytes)` → S3 object + origin id (driveId / attachment id / upload UUID); sections = `## Page N` | origin URL |

Rules: refs use immutable ids only; every ref requires an `anchor` plus either
the exact versioned `sourceEventId` or blob `sha256` (`url` is navigation-only).
Revisionless legacy Google Docs projections retain their existing unqualified
`gdoc` refs until a known snapshot revision can render them; no revision is
inferred.
`representedType` is valid only with native `provider`, `sourceNamespace`, and
`externalId`. Containment uses `sourceLinks` roles `PARENT`, `REPLY_TO`,
`ATTACHED_TO`, or `INSTANCE_OF`; `sourceAcl` is access metadata only. Every event row keeps the provider deep-link
URL when one exists (redacted if requester-scoped); per-item timestamps ride the
sections (messages/turns/comments/blocks are inherently timestamped — this is
what makes per-card `event_at` cheap for conversational sources).

## 5a. Decisions locked (2026-07-07)

1. **Raw version-append** for mutating sources: approved. Each version of a
   Jira issue / Confluence page / Granola note / Notion page is a new
   `activity_events` row (versioned `source_event_id`); immutable items
   (gmail messages, slack events, commits) stay one-row.
2. **Slack Socket Mode**: approved. The 10-connection limit is an app-wide
   load-balanced pool (each event is delivered to any one open socket), not a
   per-workspace ceiling — workspace count does not consume connections. Scale
   limit is event volume through ≤10 sockets; migration path if outgrown is
   the HTTP Events API (no cap, needs public endpoint — we already run signed
   webhooks). Polling floor remains the correctness backstop either way.
   VERIFY-LIVE: multi-workspace delivery over one app's pool.
3. **Connection uniqueness constraint lifted**: migration replaces
   `uq_connection_tenant_provider` with unique
   `(tenant_id, provider, external_account_id)` — N Jira sites / GitHub orgs /
   Slack member tokens per tenant.
4. **Tenancy = org-tenant** (see §5b): one tenant per organization; admin
   connects org-scoped sources, members add personal ones into the same
   tenant; dedupe of shared content is automatic at the tenant scope.
5. **S3 from day one** for binary raw (see §5c).

## 5b. Onboarding & tenancy model (admin-first, then members, no duplication)

One **tenant = one organization** (mapped to the site's WorkOS organization).
Members are the org's users; roles: `admin | member`.

- **Org-scoped sources — admin connects once:** Google Workspace (DWD is
  domain-level by nature), Jira, Confluence, Bitbucket, GitHub, Notion
  workspace. Connect endpoints for these require the admin role.
- **Member-scoped sources — each person connects their own:** Granola
  (personal account), Slack (user token per member — required for per-user
  visibility incl. DMs), uploads. Each `connections` row records
  `scope: org|member` and `connectedBy` (site user id).
- **No duplication, by construction:** raw capture is keyed
  `(tenant_id, source_event_id)` — when two members' Slack tokens can both see
  the same channel message, the second insert is an `ON CONFLICT DO NOTHING`
  no-op. Shared-workspace dedupe is therefore a property of the existing
  unique index at org scope, not new machinery. What *is* added: per-channel
  **collector assignment** in the Slack poller (one member token polls each
  shared channel; reassign on revocation) — an API-economy optimization, not a
  correctness mechanism.
- **Privacy carve-out:** member DMs land in the org tenant. DM capture is a
  per-member opt-in surfaced at connect time; captured DMs carry
  `sourceAcl: {audience: [...]}` so plane-2 visibility enforcement has what it
  needs. This is a capture-side marking, not enforcement.
- **Critique, stated:** org-tenancy means the raw layer has no per-person
  isolation — accepted because visibility enforcement was always designed at
  the KB/container layer (plane 2), and the alternative (per-member tenants +
  cross-tenant dedupe) breaks the tenancy key everywhere for no capture-side
  gain. Existing single-user tenants remain valid as "orgs of one."

## 5c. Binary raw store — S3 design (and its critique)

- **Layout:** one bucket per env (`aqueduct-raw-<env>`); keys
  `binary/<tenantId>/<sha256>`; SSE-KMS (env-level key now; per-tenant keys
  are the later crypto-shred path from `docs/aws-architecture.md` — tenant
  prefix + per-tenant key makes offboarding a prefix delete + key retire);
  Block Public Access on; bucket versioning off (content-addressed objects
  are immutable); lifecycle rule: `AbortIncompleteMultipartUpload` after 1
  day; no archival tiering v1 (raw is the source of truth).
- **Write path:** stream the request body (never buffer 50MB in process) via
  multipart upload to `tmp/<uuid>` while hashing; on completion, CopyObject to
  the final sha256 key and delete the temp; **then** insert the
  `binary_documents` row. Object-before-row ordering: a crash in between
  leaves an orphan object (harmless; a sweeper diffing bucket vs rows reaps
  them) — chosen over row-before-object, which can leave a dangling pointer
  (a lie in the DB is worse than a stray object).
- **Read path:** workers read via IAM role (no static keys). Site downloads
  get short-TTL presigned GETs minted per request — presigned URLs are
  requester-scoped credentials under our own redaction rule: never persisted,
  never logged.
- **Dedupe:** same bytes re-uploaded in a tenant → same key, idempotent.
  Cross-tenant dedupe deliberately NOT done (tenant-prefixed keys): isolation
  and prefix-offboarding beat the storage savings.
- **Rejected alternatives:** Postgres bytea (atomic with the row, but bloats
  WAL/backups and caps growth — the repo already brands blob-in-Postgres "the
  launch shortcut, not the design"); per-tenant buckets (bucket limits, ops
  overhead); S3 event notifications driving processing (we already have the
  task queue — intake enqueues directly; no second processing path).

## 5d. Retrieval indexes + change-feed view (additive migration)

One migration (`drizzle/9702_retrieval_indexes.sql`, renumbered by the
integrator) adds read-side queryability with zero writer changes:

- `idx_event_user_created` `(user_id, created_at, id)` — the **capture
  cursor**: "everything that arrived since T", correct under backfills
  (arrival time, not event time).
- `idx_event_user_source_event_prefix` `(user_id, source_event_id
  text_pattern_ops)` — prefix scans over the frozen id schemes (§5a
  version-append): latest version of an entity, all events for a
  channel/issue/doc.
- `idx_mirror_file_user_path_prefix` `(user_id, path text_pattern_ops)` —
  subtree listings of the mirror. (Both `text_pattern_ops` indexes are
  redundant — drop them — if the DB has `lc_collate = 'C'`.)
- Envelope expression indexes on `mirror_files.meta` (§3):
  `(user_id, meta->>'provider', meta->>'externalId')`,
  `(user_id, meta->>'authorEmail')`, `(user_id, meta->>'sourceUpdatedAt')`,
  plus `(user_id, updated_at)` — staged-doc lookup by native id, by author,
  by source freshness.
- `idx_mirror_file_meta_aliases` — GIN (`jsonb_path_ops`) over
  `meta->'aliases'`: identity/alias containment queries seeding entity
  resolution.
- `idx_event_user_source_updated` `(user_id, source_updated_at)` — "recently
  changed by source-time" (the column is populated by all sources but was
  previously unindexed; only `(user_id, timestamp)` existed).
- `idx_binary_document_tenant_sha` `(tenant_id, sha256) WHERE sha256 IS NOT
  NULL` — content-addressed byte lookup / dedup (§5c keys are
  `binary/<tenantId>/<sha256>`).
- View `activity_change_feed` — cross-source change feed over
  `activity_events` (zero storage): per-row `entity_hint` (split from the
  frozen `source_event_id` scheme; jira ids are
  `jira:<cloudId>:issue:<issueId>:…` so the hint is part 4, others part 2)
  and best-effort `actor_email` COALESCEd from known `raw_payload` shapes
  (slack/gmail `_user_email`, calendar `organizer.email`, jira
  `comment.author.emailAddress` / `issue.fields.reporter.emailAddress`).
  It also normalizes the inconsistent per-source `event_type` naming (5+
  spellings of "deleted", unlabeled "update" for Nango sources) into a single
  `change_kind` lifecycle vocabulary — `created | updated | deleted |
  reaction | lifecycle | comment` — via a best-effort top-down pattern CASE
  (first match wins, so `deleted` patterns beat the `lifecycle` catch-alls for
  e.g. `member_removed` / `channel_deleted`). Read-model, refine freely.

## 6. Site wiring (the backend API the website calls)

**The site already defines the protocol** (`apps/site` in the main repo,
Next.js 16 App Router + WorkOS): all browser calls go through its
`/api/dashboard/[...action]` proxy, which forwards to a backend origin
(`DASHBOARD_RAW_API_ORIGIN`) under `/onboarding/raw/session/...` with an
`x-shepherd-onboarding-token` session header (HttpOnly signed cookies; tokens
never reach browser JS). It expects: `GET session` → `{account, providers:
{<source>: ProviderInfo}, authUrls, capabilities}`, `POST session/reauth/
<provider>`, `POST session/<source>/disconnect`, and a `team-access` snapshot
(WorkOS organization + members + per-source grants) that matches §5b's
org-tenant model directly.

**Integration decision: aqueduct implements that existing surface** (same
routes, same token scheme, same response shapes) rather than a parallel
`/v1/connect/*` API — the site then needs only an origin config change and
zero frontend work. The endpoint table below maps our lane work onto that
surface; internal names may differ, the wire contract is the site's.
`connections` rows are written by **every** lane so the `providers` map
reflects all sources.

| Endpoint | Lane | Notes |
|---|---|---|
| `POST /v1/connect/google` `{delegatedEmail}` | vault | calls `connectGoogleWorkspaceDelegation` + `startGooglePolling` + `calendar.setup` (all currently caller-less) |
| `POST /v1/connect/granola` `{apiKey}` or `{mode:"oauth"}` → `{url}` | vault | OAuth initiation exists as library code only; reconnect must preserve watermark + folder scope |
| `POST /v1/connect/notion` → `{url}` (+ manual-token variant) | vault | initiation function has zero callers today |
| `POST /v1/connect/slack` → `{url}` + `GET /auth/slack/callback` | vault | callback route missing; workspace-change guard (reject silent team switch) |
| `POST /v1/connections/:provider/connect-session` → `{sessionToken}` | Nango | provisional `connections` row first (`pending` status — needs check-constraint migration), then Nango connect session; frontend opens ConnectUI; `type:"auth"` webhook branch (new) reconciles connectionId |
| `POST /v1/pdfs` (raw body) / `DELETE /v1/pdfs/:id` | — | bytes-only upload: hash → S3 → `binary_documents` row; ACL = `{tenantId, apiKeyId}` (api keys are tenant-scoped, not user-scoped — stated, not faked) |
| `DELETE /v1/connections/:provider` | both | stop-collection disconnect: provider-side revoke/Nango delete → status `revoked` → `disableTaskSchedules` → deactivate watermarks; purge stays a separate lifecycle action |
| `GET /v1/connections` (+ `/:provider/status`) | both | per-connection status + last `source_sync_runs` counts — the site's proof that raw is flowing |
| `GET /v1/files`, `/v1/files/content` | — | exists; the staging browse surface |

Constraint to resolve at provisioning design: `uq_connection_tenant_provider`
allows one connection per (tenant, provider) — blocks GitHub multi-org / Jira
multi-site; either lift it or ship documented single-org-per-tenant v1.

## 7. Per-source work, split RAW-READY vs GRAPH-READY

**RAW-READY** = a tenant connects on the site and correct, well-identified,
redacted raw + staged data accumulates, graph off. **GRAPH-READY** = the
remaining items to pass full pickup. The split rule: anything
capture-irreversible (identity, redaction, tombstones, timestamps, lossy
cursors) is raw-blocking; anything regenerable from raw (render fidelity,
selector wiring, claim emission) can follow.

| Source | RAW-READY (blocking) | GRAPH-READY (follows) |
|---|---|---|
| **Gmail** | connect endpoint; DWD failure taxonomy (drop the global-mailbox env fallback); HISTORY_EXPIRED recovery made lossless-or-loud; trash tombstones | thread staging docs (bound, volatile labels excluded), Route-B-style enqueue via pickup, `gcal_event`/recipient identity |
| **Calendar** | connect (rides google); live staging materialization (today backfill-only); cancelled→tombstone | event docs + start-time claims + meeting alias |
| **Google Docs** | live tab materialization; comment-sweep scheduled; deletion→tombstone | per-tab staged docs excl. pending-suggestions; sheets/slides export docs |
| **Granola** | fix watermark deadlock (>200 notes), reconnect scope-wipe, index-file exclusion; onboarding wiring; per-note failure quarantine; both-mode 404 taxonomy | stable-id staged docs, calendar-alias join, transcript window kind |
| **Notion** | **build the dirty→render task** (staging is empty without it); connect endpoint; per-file stable ids; S3-URL scrub on persisted raw; delete/unshare sweeps → tombstones | selector row, alias emission, comments/rows polish |
| **Slack** | full compile-out (table, `ws` dep, env schema, remaps); cross-tenant directory-cache fix (corrupts raw); `permalink_public`/`url_private` scrub; workspace guard; revocation taxonomy; rate-regime VERIFY-LIVE; socket-vs-poller decision (poller-only permanently loses edits/deletes in raw) | day-file staging materializer, selector, mention aliases |
| **PDFs** | `binary_documents`+S3; Drive intake branch (own mime filter, widened fields, enqueue-before-cursor-advance); upload route; deletion-tracking set; Drive-field redaction | the parse stage (multimodal client, page-render, checkpointing, tiered parse, budget) + staged markdown |
| **Jira** | Nango provisioning + provider-string pin + webhook signing-key VERIFY-LIVE; **unconditional raw capture before kb-match** (today records are discarded); immutable `issue:<cloudId>:<id>` ids; tombstone branch; cursor recovery + polling floor; poison-record isolation; auth-webhook teardown | staged issue docs (full header render), comments, status/assignee claims |
| **Confluence** | same lane items; `confluence:page:<id>:v<n>` raw rows; deleted-record guard (never capture as empty version) | staged page docs (bodied-macro/task-list fixes + re-render sweep), comments doc, attachments→PDF |
| **Bitbucket** | same lane items; repo-UUID ids; selector-scoped commit capture; raw redaction audit | PR staged docs (dedupe/version fix, state header); repo-record docs (repos sync) |
| **GitHub** | Nango github-app config + template/`track_deletes` VERIFY-LIVE; processors built (from corrected bitbucket shape) with unconditional raw capture; numeric repo ids; base-repo matching | staged PR/issue docs, review/draft state, noreply rule, delete `_pending/github` |

## 7a. Rate-limit budget, per source (every endpoint accounted)

Poll cadences and per-method pacing are the enforced budget; backfills are
bounded and recorded. Every cap has (or gets) a `docs/integrations/limits.md`
row — that file stays the registry of record; this table is the summary.

| Source | Governing limits | Our pacing (steady / backfill) | Budget owner |
|---|---|---|---|
| Gmail | ~50 fetch/s/user quota; history API | 30s history-delta poll (gmail-specific constant; the shared 60s default is untouched), concurrency 10 + 100ms stagger (~20–30/s); backfill capped msgs/scanned, `capHit` recorded | us (per-user quota attribution header) |
| Calendar | 600 queries/min/user (tightest Google) | 60s incremental poll, concurrency 5; workspace directory (users.list) cached per tenant, 1h TTL, forceFull bypass — steady-state cycle is per-user calendarList delta + events.list for changed calendars only; setup caps 500 users / 200 cals / 20 pages | us |
| Drive/Docs | 12k/100s; export 10MB hard cap | 60s changes-cursor poll (one cheap request/cycle); per-doc hydration concurrency 8; hourly comment/suggestion sweeps | us |
| Granola | **unpublished** — empirical | 120s poll; Retry-After honored on 429 (≤3 bounded retries, 30s delay cap); 220ms inter-call, note concurrency 5, page 30, poll cap 200 w/ resume fix; VERIFY-LIVE MCP-path limits | us |
| Notion | ~3 req/s avg | 60s poll floor + webhooks; proactive client pacer spaces every API request ≥334ms apart (~3 rps, process-wide) on top of reactive 429/Retry-After; block fan-out budgets (5k blocks/500 req/depth) with `markdown_truncated` marking | us |
| Slack | **Distributed non-Marketplace app (confirmed 2026-07-08)**: history/replies ~1 req/min, 15 msgs/request (2025 regime); other methods keep their per-method tiers | **Socket Mode primary** (on by default); `slack.poll` = 900s gap-fill/reconcile; per-method buckets keyed **per workspace token** — history/replies bucket 1/min + `limit=15` pages (`SLACK_HISTORY_RPM`/`SLACK_HISTORY_PAGE_LIMIT` env, so a Marketplace listing raises them without code); socket pool ≤10 app-wide | us |
| Jira/Confluence | Atlassian Tier-1 **65k points/hr per app across ALL tenants**; Tier-2 application filed at pilot | Nango owns sync polling; our proxy calls (comments, attachments, view-HTML) are the only direct spend — paced, Retry-After honored, per-tenant group serialization, aggregate counter | split: Nango (records) / us (proxy) |
| Bitbucket | API 1k/hr | Nango records only (no direct API calls in scope) | Nango |
| GitHub | Installation tokens 5k→~12.5k/hr; GraphQL points | Nango records; comment fetches paced; `updated_at` churn absorbed by contentSha gate (row in limits.md) | split |
| PDFs / VLM | provider image-size caps; $/page cost | per-tenant parse budget cap + spend counter (observable when hit); group-key serialized per tenant | us |
| S3 | n/a materially | multipart streaming; abort-incomplete lifecycle | us |

Rules: Retry-After honored everywhere (NangoClient now honors it on both the
JSON and proxy paths; Granola honors it with bounded retries); backfill always
on the deprioritized lane; every run in `source_sync_runs`; no cap fires
silently.

Follow-ups (not done here, deliberately):

- **Slack classification gate — RESOLVED (2026-07-08).** The app is confirmed
  unlisted-distributed (2025 non-Marketplace regime): the history/replies
  buckets in `slack/rate-limit.ts` now run at 1/min with 15-message pages,
  Socket Mode is the primary capture path (on by default), and `slack.poll`
  is a 900s gap-fill. Do not raise any Slack cadence unless the app becomes
  Marketplace-listed — then bump `SLACK_HISTORY_RPM` /
  `SLACK_HISTORY_PAGE_LIMIT` instead of editing code.
- **Calendar deeper cache.** The directory cache removes the users.list sweep
  from the 60s cycle; the remaining fixed cost is one incremental calendarList
  request per delegated user per cycle. A further step (skip calendarList
  between TTLs and drive incremental events.list from stored sync states,
  with push notifications as the accelerant) would cut that too, but it
  restructures the setup/delta split and is left as a follow-up.

## 7b. Data-coverage inventory — nothing left behind

For each source: what we capture and **how the graph will use it**, plus what
we exclude — where every exclusion is a *stated decision* in that source's
`docs/integrations/<name>.md`, never a silent drop. (Querying individual
sources directly is a separate, later track — this table is graph-usage only.)

**How captured data becomes graph material (the universal mapping):**
content → chunks → LLM claims • identity fields → deterministic aliases
(email, github, jira_key, slack uid, gcal_event, …) → Person/entity joins •
structural metadata → deterministic docmeta claims (authored/updated_by;
status/assignee planned) • hierarchy/links → doc-relations (closed vocabulary;
`transcript_of`/`summary_of` live, `child_of`/`cites` pending) • timestamps →
`event_at` (staleness adjudication + freshness display) • ACL → `source_acl`
(future enforcement hatch) • deletions → tombstones → claim supersession •
binary attachments → PDF pipeline → their own documents.

| Source | Captured for the graph | Excluded — by stated decision |
|---|---|---|
| Gmail | Thread content, participants (From/To/Cc → aliases), timestamps per message, labels-as-events (raw only), deletions/trash | Attachment *content* until PDF-lane intake (metadata captured now); write scopes unused; volatile labels out of graph content |
| Calendar | Events + attendees/RSVP (→ Meeting joins + attended claims), recurrence instances, start-time → event_at, cancellations | conferenceData join-URLs captured-but-flagged (credential-class accepted line) |
| Google Docs | Full tab content, comments + suggestions (events + mirror), per-actor attribution, revisions client available | Pending suggestions excluded from graph render (churn); raw.md never ingested; revision-replay per-paragraph timestamps deferred |
| Sheets/Slides | Values/text via export (S4) | Formulas/formatting; charts as images deferred to VLM lane |
| Granola | Notes + full diarized transcripts, attendees → aliases, calendar_event join key, folder membership | Audio n/a (Granola-side); `includeTranscript=false` tenants documented as needing manual backfill on enable |
| Notion | Page/row/child content, block timestamps, people properties → aliases, comments, references/URLs, deletions/unshares | DB rows beyond fan-out caps (marked, revisit trigger recorded); synced-block duplication accepted + documented |
| Slack | All message events incl. edits/deletes/reactions (socket), threads, participants → aliases, channel lifecycle | Files/canvases/snippets content OUT v1 (names rendered); bot-message policy per decision record; huddles pending VERIFY-LIVE |
| Jira | Issues (all rendered fields: status/assignee/reporter/type/labels/links/epic), comments, transitions state-at-poll, issue keys → jira_key aliases | Changelog history v2; worklogs/boards/sprints out; attachments → PDF lane later |
| Confluence | Pages (full storage-format incl. macro bodies post-fix), versions, comments, hierarchy → child_of, labels (VERIFY model) | Blogposts/whiteboards/databases out v1 (stated); per-page restrictions deferred (space-level ACL captured) |
| Bitbucket/GitHub | PRs/issues (+state/review headers), comments, commits (→ identity events only), repo existence + description (Repo entity record) | **All code content out of scope** (no clone/indexer — deferred indefinitely); README/docs files out; pipelines/tags/members out; releases/discussions/wikis/GHES out v1 (each a stated line); fork-PR head repos matched on base |
| PDFs | Bytes (all origins), full per-page transcription incl. tables, origin ACL, author/owner | Non-PDF binaries policy stated (docx/xlsx deferred with skip counter); embedded-figure crop path deferred (whole-page covers it) |

Completeness enforcement: (1) unknown/unhandled object types must surface as
counters, never silent skips (Notion's `coverage.ts` is the model — replicate
the pattern in the Nango dispatch and Slack subtype handling); (2) each
source's decision record carries this inventory and its exclusions; (3) the
live-test script asserts the captured set against a real tenant.

## 7c. What each source extracts, precisely (natural language)

For each source: how we notice changes, what we then fetch, what we keep, and
what it becomes. "Staged doc" = the clean markdown document in the landing
place; every item listed also lands as a raw event first.

**Gmail.** Every 2 minutes we ask Gmail's history feed "what changed since the
last cursor" (new messages, deletions, label changes). For each new message we
fetch the complete message: every header (from, to, cc, bcc, message-id,
reply-chain references), and the body — plain text preferred, HTML converted
to clean text, invisible characters stripped. Attachments: name, type, and
size now; the bytes themselves only when the PDF lane requests them. Each
message is classified (received / sent / reply / promotional). If the cursor
expires we re-anchor and backfill by date query — loudly, recording any gap.
Becomes: one staged doc per email **thread**, with each message as its own
dated, attributed section.

**Google Calendar.** At setup we list the org's users (Admin Directory) and
each user's calendars; then every 2 minutes per calendar we pull incremental
changes (sync token), with Google's push notifications accelerating that.
Each event is fetched whole: title, description, start/end, organizer, every
attendee with their RSVP status, recurrence instances, meeting-link details,
and cancellation status. We content-hash so a no-op update produces nothing.
Becomes: one staged doc per event — this is the "raw source of truth" hub that
meeting notes join onto.

**Google Docs.** Every 5 minutes we pull the Drive change feed (which files
changed) plus the Drive Activity feed (who edited/commented). For each changed
document we fetch the full structured body — every tab, all text, tables,
footnotes, person-mentions resolved to emails, embedded images — plus the
comment threads (hourly refresh) and the suggestion/revision stream for exact
authorship. Deletions and untrashing arrive on the same feed. Becomes: a
lossless raw copy per doc plus one clean staged doc per tab. (Sheets/Slides:
values and slide text via export, later stage.)

**Granola.** We poll the notes list ordered by last-update (every 5 minutes,
both auth modes) and fetch each changed note completely: title, owner,
attendee/invitee/organizer emails, folder, the written summary, the **full
diarized transcript** (who said what, in order), and the attached calendar
event reference (id, scheduled time) — the join key back to Calendar.
Becomes: two staged docs per meeting — summary, and transcript with speaker
turns.

**Notion.** Webhooks tell us instantly when pages change; a 5-minute poll of
the search listing is the safety net. For each dirty page we walk the entire
block tree (every paragraph, list, table, embed — with an explicit budget and
a visible marker if a giant page exceeds it), fetch page properties, expand
database rows into their own documents, pull page and block comments, and
resolve authors to emails where the workspace allows. Unknown block types are
counted, never silently dropped. Becomes: one staged doc per page; each
database row and child page its own doc.

**Slack.** With each member's user token: discover their conversations (every
5 minutes), then pull message history per channel from a time watermark (every
2 minutes) plus thread replies, while a realtime socket streams live messages,
**edits, deletions, and reactions** (things polling can never see). The
workspace directory gives us real names and emails for every user id.
Becomes: one staged doc per channel per day — chronological, attributed
messages with edits marked. Files and canvases: recorded by name only for now
(stated exclusion).

**Jira (via Nango).** Nango's issue sync delivers every created/updated issue
with full fields: key, summary, status, assignee, reporter, type, labels,
parent/epic links, and the complete rich-text description. When an issue
changes we additionally fetch its comments (paced against Atlassian's shared
rate budget). Rich text converts to markdown. Becomes: one staged doc per
issue — header block (status/people/labels/links), description, dated
comments.

**Confluence (via Nango).** The pages sync delivers each page's complete
storage-format body with its version number, parent, and space. We convert to
markdown preserving tables and macro contents (panels, expandable sections —
the current converter drops these; fixing that is in scope). Comments are
fetched separately (they don't bump page versions). Attachment metadata syncs;
binaries route to the PDF lane. Deletion flags arrive on the same sync.
Becomes: one staged doc per page plus a comments doc per page.

**Bitbucket (via Nango).** The pull-request sync delivers PR title,
description, state, branches, author, and timestamps; the commit sync delivers
each commit's hash, author (name + email — our best identity source for
engineers), message, and date, kept as raw events only. The repos sync gives
each repository's name, description, language, and visibility. Becomes: one
staged doc per PR, and one small staged doc per **repository** (its
existence + description — the graph's Repo entity record). **Code content is
out of scope** (see §11): no cloning, no file ingestion, no codebase
descriptions.

**GitHub (via Nango, to build).** Same shape as Bitbucket through a GitHub
App installation: PRs (including draft state and review decisions), issues,
comments, commit events, and the per-repository existence/description doc.
Template coverage is a first-day live verification. Code content likewise out
of scope.

**Raw PDFs.** Three intakes to one store: the Drive change feed (PDF mimetype
branch — file id, checksum, then a direct download of the bytes), a site
upload endpoint, and later Confluence/Jira attachments via proxy. Bytes land
content-addressed in S3 with capture-time metadata (origin, owner, sharing
snapshot). Parsing (page images → vision-model transcription, tables
included) happens at graph time from stored bytes. Becomes: bytes now; one
staged doc per PDF with per-page sections after parse.

## 8. Sourcing-plane build order (validated against code dependencies)

Raw-ready safety is code-verified: with `GRAPH_INGEST_ENABLED` unset the
mirror hook is a true no-op (early return before any DB read), Route B
processors early-return with zero `kb_sources` rows, and **no kb writer
exists** — so the zero-rows invariant holds by construction and every
graph-side migration stays vacuous for as long as onboarding precedes kb
provisioning. Corollary: onboard tenants freely during S1–S3; land the
stable-ID cutovers **before the first `kb_sources` row is ever written**, not
before onboarding.

**S0 — spine (ordered):**
0. Start the **Nango data-residency review day one** (external latency; gates
   all S2 live traffic).
1. Deploy topology (§2a) + **tenant/api-key minting** (no writer exists) +
   vault-lane site API (§6): google DWD connect (setup GET + connect POST →
   schedules incl. the never-scheduled `gdocs.comment-sweep` + backfills),
   granola connect **that actually starts polling and enqueues the initial
   backfill** (`startGranolaPolling` has zero callers today; without the
   backfill the first poll baselines the watermark to NOW and history is
   silently skipped; reconnect must stop resetting the watermark), notion
   connect initiation, disconnect + status for all — every lane writing
   `connections` rows (the site polls that endpoint to detect OAuth
   completion, so the row write is load-bearing UX). Nango connect-sessions
   move to S2 (behind the residency review), including the `pending`
   status-constraint migration and the auth-webhook reconciliation branch.
2. Capture correctness: per-provider redaction registry (current scrubber is
   Google-literal — a no-op elsewhere); immutable-ID conventions everywhere;
   staged-envelope column + stable externalId; index files excluded from
   pickup; version-append raw convention.
3. Reliability: credential-failure taxonomy → `disableTaskSchedules` + status
   transitions + operator event; vault fail-closed decrypt + key-version;
   cursor-invalidation recovery; Nango polling floor (webhook = accelerant);
   `source_sync_runs` writer/reader; skip-counter semantics split —
   processor-missing/model-mismatch **fails the task** (config bug), per-record
   malformed **logs and advances** (poison isolation).
4. Docs: this file; `sync-platform.md` amendment; alias registry;
   retention/erasure + injection posture.

**S1 — pilot sources raw-ready (parallel after S0.1):**
- **Gmail/Calendar** — pollers already write `activity_events`; they just need
  the S0.1 onboarding to schedule them.
- **Google Docs** — content capture IS raw-blocking (live poll writes only
  events; document content lands solely via the never-scheduled backfill):
  live tab materialization + comment-sweep + initial `mirror.backfill`.
- **Granola** — the three raw-corrupting bugs first (index-file, >200-note
  watermark deadlock, reconnect scope-wipe/watermark reset).
- **Notion** — the dirty→render task (staging is empty without it), connect
  endpoint, S3-URL scrub on persisted raw.
- **PDFs (bytes-only)** — `binary_documents` + S3, Drive intake branch
  (equality version-skip even for bytes, else re-download every poll),
  upload route with an explicit body limit + streaming, **capture-time meta
  snapshot stored with the bytes** (Drive permissions/author — deferring this
  silently forfeits historical ACLs), deletion tombstones. The whole VLM parse
  stage defers to graph time — that's exactly what content-addressing buys.

→ *Milestone: the site onboards a tenant; correct, redacted, well-identified
raw + staging accumulates.*

**Stage demos (acceptance is seeing these work, not checking boxes):**
- **S0:** create a customer + API key; the site shows their (empty) connection
  status; a revoked credential visibly pauses its schedules instead of
  retrying forever.
- **S1:** an admin connects Google on the site; within minutes they browse
  their own real emails/meetings/docs in the file viewer and click through
  from any rendered doc to its untouched original. Same per member for
  Granola; same for Notion pages and an uploaded PDF's stored bytes.
- **S2:** connect Jira/Confluence/Bitbucket/GitHub via the site; issues,
  pages, and PRs appear with originals attached; deleting one upstream shows
  a tombstone, not a lingering copy.
- **S3:** connect Slack; yesterday's channel conversation is browsable with
  the right names on the right messages; an edited message shows edited.
- **S4 (the whole point):** the graph is switched on over data accumulated
  weeks earlier; it answers a question citing a meeting from that period, and
  the citation drills down to the exact transcript. No ingestion code changes
  were needed to do it.

**S2 — Nango lane (code after S0; live after residency + the two day-one
verifications: webhook signing key/scheme, provider-string/model names):**
provisioning (connect-sessions, connection-row-first with auth-webhook
reconcile, constraint-lift migration) → **P10 as one shared merge-blocking
slice**: unconditional raw capture (activity_events + outbox) in ALL four
processors **before the kb-match**, including `_nango_metadata.deleted`
tombstone rows (today jira/confluence/bitbucket-PR/github persist nothing —
a sync run pre-P10 fetches records and discards them) → cursor recovery →
enable syncs + backfills.

**S3 — Slack revival:** rate-regime VERIFY-LIVE **first** (it can invalidate
the poller design and backfill promises); then compile-out (thread_watermarks
migration, `ws` dep, env schema), cross-tenant cache fix, redaction, workspace
guard, Socket Mode per the locked decision (edit/delete loss under poller-only
is permanent — socket ships with the revival, polling floor stays).

**S4 — graph-ready completions per source** (staging docs at full fidelity,
selectors, aliases) — then plane-2 turn-on is: flip the gate with real deps,
write `kb_containers`/`kb_sources` rows (writer must validate **no
mirror-prefix overlap** with any staged provider root — the double-enqueue /
meta-clobber guard), run pickup over accumulated staging. The staleness trio
(event_at default, per-section timestamps, world-time judge rule) lands
**before the first graph backfill** — capture already stores the inputs, so
nothing is lost by the graph coming later. One residual raw-window cost,
accepted and mitigated: deletions during the raw-only period rely on
tombstone capture; a full-relist reconciliation sweep runs at graph-onboarding
time to catch any missed.

## 9. Standards gate (per source, before it's "done")

Connect/disconnect/status on the site • fail-closed scope • named cursor +
recovery + polling floor • immutable ids • raw capture with tombstones +
deep-link refs • redaction audit (documented per-field) • bounded observable
rendering into staging with full envelope + sourceRefs • credential-failure
teardown • `source_sync_runs` recording • limits.md rows • decision record
updated same-PR • live test against a real tenant.

## 10. Plane-2 handoff notes (explicitly NOT our work — do not modify Ishan's code)

This plan patches ingestion only. The following consume what staging provides
and belong to plane 2, whenever Ishan takes them up. Our obligation is that
staging already carries everything they need:

- **event_at wiring**: staging captures `sourceUpdatedAt` + per-section
  timestamps; defaulting claim `event_at` from them (and the world-time-beats-
  arrival-time adjudication rule) is extractor/judge work in `src/graph/`.
- **Alias consumption**: staging captures `meta.aliases`; extending the
  resolver's identifier allowlist and the docmeta emission path is graph work.
- **Deletion handler**: staging records tombstone events; the
  `graph.delete_document` task kind + `ingestDeletedDocument` wiring and
  KB-detach invalidation are graph work.
- **Pickup hook**: reading the staged envelope (stable externalId + meta)
  instead of inferring from mirror paths is the one hook change at the
  boundary — smallest possible diff, coordinated with Ishan since the hook
  file lives in `src/graph/wiring/`.
- **Alias funnel extension**: the deterministic-identifier set
  (`IDENTIFIER_ALIAS_KINDS` in `src/graph/resolve/funnel.ts`) is closed —
  staged aliases like `gcal_event` or slack user ids are stored but won't
  resolve as identity until the set is extended. Graph work; staging's job is
  only to deliver them.
- **Extractor-version re-extraction sweep**: needed before any prod extractor
  change; graph-internal mechanics (re-pend + supersede-by-version).
- **Route A dedupe-key alignment**: the mirror hook's legacy key
  (`ingest:<kb>:<sha(path)>`) predates the normative provider-segmented key;
  re-keying it happens in the same boundary-file change as envelope pickup.
- **Author metadata on mirror-loaded pickups**: when the staging pickup falls
  back to the mirror row (`payload.content === null`), `loadMirrorContent` in
  `src/graph/wiring/tasks.ts` selects only `content`/`content_sha`, so the
  document lands without author-metadata CLAIMS. The author data IS already
  captured — our materializers write `authorEmail`/`authorName`/
  `updatedByEmail` into `mirror_files.meta` (the §3 envelope). The follow-up
  is one-line-ish graph-plane work: have the pickup also read
  `mirror_files.meta` and pass those fields through so
  `emitDocumentMetadataClaims` receives them.
- Selector wiring (`kb_sources` rows), extraction, entities, claims, pages:
  untouched.

## 11. Deliberately not doing

No new infra (queue/event bus — Postgres task_queue + outbox stay), no new
staging tables (mirror + one column), no graph-schema changes beyond the two
additive channels, no NLP date-guessing, no revision-history replay v1, no
per-document ACL enforcement (capture-only), no Nango-for-Slack, no Snowflake,
no speculative git-provider abstraction, no per-connector deviation from this
document without amending it first.

**Code indexing: kept, sequenced after this plan (decided 2026-07-07).** The
code indexer is Ishan's design (architecture-plan docs 09/10 — compiled code
graph via shallow clone + tree-sitter, approved but unbuilt) and is retained
as the **S5 track**, built to those docs once the sourcing plane and graph
turn-on are done. It was never sourcing-plane work (it produces compiled
graph claims, not raw capture), so nothing in S0–S4 depends on it or blocks
it. Within this plan's scope, Bitbucket/GitHub contribute PRs, issues, commit
identity events, and the per-repository existence/description record; the
commit events double as the future indexer's wake signal, so S5 needs no
capture-side rework when it starts. Build order when picked up, per doc 09:
parser spike first (standalone), then clone service, then the code-file
extraction gate before any code document is enqueued.

## 12. Open verifications (close during S0–S2 live tests)

Nango: webhook signing key/scheme; sync-webhook provider/model strings vs
processor registration; auth-webhook payload shape; `track_deletes` per GitHub
model; record field shapes (repo UUID, PR base/head, jira email presence).
Slack: 2025 non-Marketplace rate limits; token-rotation default; Connect-channel
identity. Google: shared-drive Activity visibility; changes.list md5/permissions
fields; trash-purge history behavior. Granola: MCP tool schema (cursor/
updated_after/hasMore); api_key↔oauth payload-hash equivalence.
