# Granola

## Source-record identity: tenant-scoped note snapshots

**Decision.** Granola note captures use namespace `tenant`, object id
`meeting_note:<granolaId>`, `snapshot` for fetched note versions, and
`tombstone` for missing/deleted notes (`src/integrations/granola/poller.ts`).

**Why.** `granolaId` is the immutable note identity available in every capture;
the tenant boundary supplies its authority scope, and fetched versions are
state observations rather than user actions.

**Alternatives rejected.** Meeting title, folder membership, and calendar
aliases are mutable metadata, not source identity.

**Revisit when.** Revisit if Granola exposes an immutable account/workspace ID
that should replace the tenant authority scope.

Code: `src/integrations/granola/`.

## Single-account today; multi-account dedupe is graph-level (2026-07-12)

**Decision (status quo).** One granola API key per tenant (`integration_tokens`
unique on user_id+provider) — only that account's notes are ingested. Note
identity `meeting_note:<granolaId>` is per-note AND per-account: two accounts
recording the same meeting produce two notes with distinct ids, and if
multi-account is added BOTH are captured (distinct evidence/vantage points).
Dedup belongs to the graph layer, which already does it: granola meetings bind
to their Google Calendar event (meeting-match judge + typed event ids), so two
accounts' notes for one meeting converge on ONE Meeting entity with both
summaries as statements. Never dedupe at capture.

**Multi-account plumbing** (when wanted) follows the google roster pattern
(see gmail.md 2026-07-12), with the extra wrinkle that API keys are secrets —
token storage needs an account dimension, not just a cursor table.

## Change detection: updated_at watermark polling

**Decision.** Poll the note list ordered by `updated_at`, comparing against
per-note content hashes (`hashGranolaNote`) and conversation watermarks;
re-fetch and re-materialize only notes whose hash changed.

**Why.** Granola exposes no webhooks or delta cursor — its public API
(`https://public-api.granola.ai/v1`) is list/get only, so watermark polling is
the only option. The content hash keeps repeated `updated_at` bumps (Granola
touches notes liberally) from producing duplicate events.

**Decision.** Reconnects preserve the prior `lastUpdatedAt`, `folderId`, and
`includeTranscript` metadata unless the caller explicitly overrides scope.
First-time connects start polling and enqueue one deduped `granola.backfill`;
reconnects start polling but do not re-backfill.

**Why.** Resetting the watermark to reconnect time skips notes updated since
the last poll, and defaulting omitted scope fields silently widens or narrows
capture.

**Decision.** When a poll hits its note cap before exhausting the list and the
list response includes a cursor, persist `granolaResume` metadata containing
that cursor, the original `updated_after` watermark, and the max processed
`updated_at` seen so far. The next poll resumes from that cursor with the
original watermark; only after the window drains without failures do we clear
the resume and advance `lastUpdatedAt` to the merged max seen timestamp.

**Why.** Granola accepts `updated_after` but exposes no sort contract, so a
capped run cannot safely advance the watermark until all cursor pages for the
original window have been consumed.

**Decision.** A cap-hit poll also self-enqueues an immediate follow-up
`granola.poll` task (deduped on `<tenant>:granola:poll:resume`, same task
group) so a backlog larger than the per-run cap drains at queue speed instead
of one cap per 300s schedule tick. The 300s schedule stays authoritative; the
follow-up is just the hot path.

**Why.** With only the schedule, a 2,000-note backlog takes ~50 minutes to
drain; the dedupe key keeps at most one pending follow-up and group
serialization runs it strictly after the capped run.

**Decision.** Note-detail failures are quarantined per note — with a taxonomy
(2026-07-08). Transient errors (429/5xx/network) stay fail-soft: log the note
id, count the failure in the task output, clear any saved `granolaResume`, and
do not advance `lastUpdatedAt`. Auth failures (401/403) rethrow so the task
fails and the shared permanent-credential-failure teardown runs (connection →
error, schedules disabled). A 404 on a previously captured note is a deletion:
append a `meeting_note.deleted` tombstone row (`source_event_id
granola:<id>:deleted`, idempotent), remove the note's mirror directory
(`deleteGranolaMeetingSourceWiki`), and retire its conversation watermark
(`is_active = false`). A 404 on a never-captured note is a counted skip
(`skips.deleted_uncaptured`), never a tombstone. Deletions do not block the
watermark advance.

**Why.** One transiently-bad note should be retried on the next poll from the
still-current watermark (a saved cursor may be past the failed note); a dead
credential must not silently degrade into per-note failure noise; and a
deleted note must not look current in the mirror.

## Deletion reconciliation sweep (2026-07-08)

**Decision.** `updated_after` polling never re-lists a deleted note, so clean
polls run a periodic sweep (every 6h, `granolaDeletionSweepAt` metadata; the
first clean poll only baselines the clock): list every note the credential can
see (same folder scope as polling, capped at 200 pages), then direct-fetch
each tracked-active note missing from that listing. Only a confirmed
not-found produces a tombstone; a note that fetches fine (e.g. moved out of
the folder scope) stays tracked untouched. Sweep results land in the poll
result (`deletionSweep`); transient sweep failures never fail an otherwise
clean poll and back off a full interval.

**Why.** The confirmation fetch makes a truncated or scope-narrowed listing
safe — it can cost extra fetches but never a false tombstone.

## Backfill covers all history; bounded retry on per-note failures

Initial connect enqueues one deduped `granola.backfill` with no `days` bound:
`created_after` is unset and `maxNotes` is uncapped, so cursor pagination
drains the entire note history. Per-note fetch failures during that backfill
would otherwise be lost for good (the poll watermark is set at connect time,
so notes whose `updated_at` predates it are never re-listed) — the backfill
task therefore re-enqueues itself up to twice (`attempt` payload counter,
deduped per attempt) while `failed > 0`; already-stored notes dedupe on their
versioned `source_event_id`.

## Index/list artifacts: none reach capture (investigated 2026-07-07)

Audited whether Granola "notes list"/folder-index style documents can be
captured as meeting notes. Finding: the poller's only list surfaces are
`GET /v1/notes` on the public API and the MCP list-notes tool, and both return
only note objects (`object: "note"`); folders appear solely as
`folder_membership` entries *inside* note payloads and are never listable
items, and the MCP normalizer (`normalizeNoteResponse`) coerces every detail
result to `object: "note"`. No index/list-of-documents artifact type exists in
the API surface we consume, so no exclusion filter is needed — there is
nothing to count-skip. **Revisit when** the list endpoints start returning
non-`"note"` object types or Granola ships generated folder-summary
documents; then add a counted (never silent) skip on `object !== "note"`.

## Transport: public API with MCP client

Listing and note fetches go through a Granola **MCP client**
(`mcp-client.ts` — `listGranolaNotesWithMcpClient`,
`fetchGranolaNoteWithMcpClient`) against the public API base. OAuth tokens
refresh proactively (`granolaOAuthTokenExpiresSoon` →
`refreshGranolaOAuthToken`) rather than reactively on 401, because a failed
poll cycle costs a full interval of freshness.

Tool-level `isError` results throw (2026-07-08) — previously a deleted note's
"not found" tool error normalized into a shell note with epoch timestamps;
now it surfaces as an error the deletion taxonomy classifies. The MCP note
normalizer also preserves any top-level fields it does not map onto the typed
note shape, so the OAuth/MCP transport is not lossier than the public-API
transport (which captures the whole raw note); redaction still runs on the
full payload.

## Envelope actor identity

Granola exposes exactly one actor: the note `owner` (personal meeting notes
have no separate last-editor). The mirror envelope populates `authorEmail`,
`authorName`, and `updatedByEmail` from the owner, and emits `email` aliases
for owner, attendees/people, calendar invitees/organiser, and transcript
speakers, plus a `gcal_event` alias from the nested
`calendarEvent.calendar_event_id` (the earlier top-level read never matched
the captured payload shape, so the alias was silently absent).

Graph meeting promotion uses that same `gcal_event` kind when it joins a
Granola note to the newest non-cancelled Google Calendar snapshot for the
event id. Calendar invitees marked `declined` or `needsAction` are excluded
from confidence-1 `attended` claims; transcript/top-level participants remain
attendance evidence. When the joined Calendar start carries an IANA timezone,
the generated Meeting name uses that local date rather than the UTC date.

## Fallback meeting convergence: LLM judge merges (v2)

**Decision.** Granola notes with no usable `gcal_event` alias (ad-hoc
recordings — `calendarEvent: null` — or an event id outside calendar sync
scope) converge onto their Calendar Meeting through a post-hoc same-as pass
(`src/graph/resolve/v2/meetings.ts`, run after each v2 extraction drain).
Candidate generation is deterministic and dumb: same-tenant calendar Meetings
whose snapshot start falls within ±12h of the recording's start
(`calendarEvent.scheduled_start_time`, else the note's `created_at`). An LLM
judge is the matching function — it sees titles, start times, and
attendee-email aliases for the recording plus up to 8 nearest candidates and
either picks the one same real-world occurrence or abstains. A pick merges
the two canonical entities through `graph_v2_merge_canonical_entities`
(calendar entity wins), first-class like the exact-ID path. Every considered
pair is recorded in `v2_same_as_decisions`, so a pair is judged at most once
ever; abstentions retry only when NEW candidates appear.

**Why.** Measured on dev 2026-07-11: 25/45 granola meetings (56%) had no
calendar linkage under exact-ID convergence alone. Similarity-scoring
formulas/thresholds were explicitly rejected in favor of an LLM judge whose
confident verdict performs the merge itself.

**Alternatives rejected.** Inline fuzzy matching at extraction time (order
dependent — misses whichever side ingests second); low-trust inference edges
(a suggestion, not a merge — chat/wiki would still see two Meetings).

**Revisit when.** Granola reliably attaches calendar ids to ad-hoc
recordings, or calendar sync scope covers externally-organized events.

## Content shaping

### Audio channels are transport metadata, not people

**Decision.** Transcript turns with only `speaker.source = "microphone"` render
under the note owner's captured name or email; `system` and any other unnamed,
unidentified channel render as `speaker_unknown` (`src/mirror/materializer.ts`).
Raw audio-channel strings are never emitted as speaker labels.

**Why.** Granola's microphone/system values identify capture channels, while the
note owner is its sole actor identity. Rendering a channel as a speaker creates
false people such as `Person:Microphone` during graph replay.

**Alternatives rejected.** Preserving the raw source string in display text was
rejected because downstream extraction correctly treats the text before `:` as
a speaker. Dropping the turn was rejected because the transcript content is
still source evidence.

**Revisit when.** Granola exposes a distinct, stable speaker identity for these
turns rather than only channel metadata.

Each meeting materializes as ONE transcript document (`transcript.md`) — there
is no windowing layer, and none is needed: the graph chunker splits it into
~6k-char chunks, and conversation extraction context is the accumulated
previous chunks of the same document, tail-capped at 80,000 chars
(`CONVERSATION_CONTEXT_CHAR_LIMIT` in the extract runner) — whole-meeting
context by accumulation, not by window sizing. (Corrected 2026-07-07: earlier
wording described window-target constants that were never wired; they have
been removed.)
Granola transcripts are immutable per fetched note hash, so larger transcript
windows are effectively free for freshness: a changed transcript is re-chunked
with its document, and extraction context never crosses document boundaries.
Transcript items carry speaker/diarization labels which are preserved into the
mirror. Rate limiting is a fixed 220ms delay between calls with note concurrency
5 (`GRANOLA_NOTE_CONCURRENCY`) — Granola publishes no quota numbers, so the
pacing is empirical.

## Graph chunking: transcript-aware bridge path

**Decision.** The staged envelope marks `transcript.md` with the
`kind: "transcript"` facet (`src/mirror/materializer.ts:483`), and bridge
ingestion uses that facet to select transcript-aware chunking
(`src/graph/bridge/ingest.ts:73`). Turn clocks may be absolute ISO timestamps or
`MM:SS` offsets; offsets are resolved against the envelope's `meetingStartTime`,
sourced from `calendarEvent.scheduled_start_time` with the captured meeting
timestamp and then `sourceUpdatedAt` as fallbacks
(`src/mirror/materializer.ts:2827`).

Each turn paragraph keeps the speaker or diarization label but strips the
per-turn ISO timestamp before extraction, rendering as `speaker: text`.
Chunks are prefixed with one coarse time marker such as
`[2026-07-01T23:10Z – 2026-07-01T23:14Z]`, derived from the first and last
turn in that chunk. Boundaries split between turns only: large time gaps close
the current chunk once it has reached the minimum size, and the emitted
timestamp-stripped text is kept under the normal chunk target except for a
single oversized turn, which remains intact for provenance.

**Why.** Envelope-kind dispatch is deterministic for both short and long
transcripts and cannot mistake a structured summary for a transcript. Granola
normally emits absolute clocks, but meeting-relative offsets must be anchored
to the scheduled meeting start rather than the note's later edit time so graph
claim `event_at` values remain correct.

**Alternatives rejected.** Content sniffing that required at least five
turn-shaped paragraphs was length-dependent and became ambiguous once both ISO
and offset clocks were accepted. Anchoring offsets to `sourceUpdatedAt` was
also rejected because Granola notes can be edited days after the meeting.

**Revisit when.** Granola changes the transcript item or clock schema. The
connector-wide polling and pacing decisions should also be revisited when
Granola ships webhooks or a delta/changes endpoint, or publishes rate limits.
