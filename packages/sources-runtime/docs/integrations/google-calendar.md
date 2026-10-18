# Google Calendar

## Source-record identity: calendar-scoped event history

**Decision.** New generalized Calendar records carry namespace
`calendar:<calendarId>`, typed object id `event:<eventId>`, and explicit
`snapshot`, `activity`, or `tombstone` kind through the common event writer
(`src/integrations/google/calendar/poller.ts`).

**Why.** Calendar event IDs are scoped to a calendar authority; titles and
paths can change. Cancellation is a tombstone observation, while semantic
changes append as activities.

**Alternatives rejected.** Treating the staged path or event title as identity
breaks on rename and move; assigning identity when `calendarId` is absent would
be a guess.

**Revisit when.** Revisit if Google guarantees globally unique event IDs across
all calendars and copies.

Code: `src/integrations/google/calendar/`.

Access axes (see [google-access-matrix.md](google-access-matrix.md)): the
org-rollout path (Admin Directory enumeration) is DWD-only — no OAuth or
service-account equivalent exists. Event sync itself works under user OAuth
too (`calendar.readonly` is sensitive, not restricted — no CASA). Consumer
accounts are unreachable while aqueduct is DWD-only.

## Change detection: syncToken incremental + push watch channels

**Decision.** Per calendar we run `events.list` incremental sync with a
persisted `syncToken` (`google_calendar_sync_states`), falling back to a full
re-sync when Google returns **410 GONE** (expired token). On top of that we
maintain **push watch channels** (`events.watch` and a calendar-list watch,
tracked in `google_calendar_watch_channels`) so webhook pings trigger immediate
syncs; channels are created with the maximum 7-day TTL
(`WATCH_TTL_SECONDS`, capped at 604,800s) and renewed inside a 24-hour window
before expiry.

**Why.** Calendar is the one Google API where push is actually practical: its
channels live 7 days (vs ~1h–24h for Drive), so the renewal fleet is cheap.
The syncToken loop stays as the lossless backbone — the webhook carries no
payload, it just tells us to sync now — which is the same
poll-backbone-plus-push-accelerator shape we'd want everywhere.

**Alternatives rejected.**
- Pure polling (no channels): works, but meeting changes are the most
  latency-sensitive signal we carry.
- Fivetran-style windowed re-imports (6-month rollback + 12-month forward
  re-scan): unnecessary when syncToken + 410 fallback handles late edits and
  token expiry correctly.

**Revisit when.** Google extends the Workspace Events API to Calendar, or
channel reliability degrades in practice (the 410/full-sync path is also the
safety net for missed webhooks).

## Multi-user: domain-wide delegation

Auth supports **domain-wide delegation**: with delegation configured, setup
enumerates Workspace users via the Admin Directory API (bounded by
`GOOGLE_CALENDAR_SETUP_MAX_DELEGATED_USERS`, default 500, and
`GOOGLE_CALENDAR_SETUP_MAX_CALENDARS_PER_USER`, default 200) and syncs each
user's calendars under delegated credentials. Webhook channel tokens are
hashed (`googleCalendarChannelTokenHash`) so a leaked channel token can't be
replayed against the webhook endpoint.

## Persistence and dedupe

Events are snapshotted in `google_calendar_event_snapshots` with a normalized
**content hash**; a change only becomes a semantic `activity_events` row when
the hash actually differs, so attendee-list noise and no-op updates don't spam
the event stream. Full syncs are page-bounded
(`GOOGLE_CALENDAR_SETUP_MAX_FULL_SYNC_EVENT_PAGES_PER_CALENDAR`, default 20)
to keep first-connect cost predictable. Calendar concurrency is deliberately
low (5): Calendar's 600 queries/min/user quota is the tightest of the Google
APIs (see the quota note in `src/polling/_archived-gdocs/gdocs.ts:24`).

Since 2026-07-07 the same content hash also gates **live mirror
materialization**: on a new or changed snapshot, `storeCalendarEvent` renders
the event's source-wiki doc through `materializeCalendarEventSourceWiki` —
the exact renderer the batch backfill uses, so cancelled events delete the
mirror file in both paths and the staged envelope (`mirror_files.meta`) rides
along. Unchanged upserts never touch the mirror, and a mirror failure warns
without failing or retrying the capture path.

The legacy meeting-page projection in `src/graph/meetings/index.ts` selects the
newest non-cancelled snapshot among delegated-calendar copies. Display dates
use the event start's IANA `timeZone` when Google supplies one, so evening
local meetings do not roll into the next UTC date.

## Graph semantics: scoped events and invitations

**Decision.** A Calendar source object is identified as
`gcal/calendar:<calendarId>/event:<eventId>`; the same event id under two
calendars is not itself convergence evidence. Calendar and Granola retain
their separate native source-object mappings and can resolve to one Meeting
only when an unambiguous cross-provider `gcal_event` alias matches
(`src/graph/bridge/source-objects.ts`, `src/graph/extract/v2/writer.ts`).

**Decision.** Calendar capture persists the privacy-preserving
`hasHumanAttendee` signal in the staged envelope only when every captured
attendee can be classified deterministically. `true` promotes the source to a
Meeting; `false` promotes it to an Event. An absent or ambiguous signal does
not promote it, rather than guessing from a chunk which may omit the attendee
section (`src/mirror/materializer.ts`, `src/mirror/envelope.ts`,
`src/graph/bridge/source-objects.ts`).

**Why.** A Calendar entry is a Meeting only with human participation. Keeping a
small persisted signal lets deterministic extraction classify every chunk of
the same event consistently without retaining an attendee list in source ACL
metadata.

**Alternatives rejected.** Treating every calendar entry as a Meeting invents
participation; treating a missing or partial attendee list as proof that it is
an Event does the same in reverse.

**Revisit when.** Revisit if Calendar capture gains authoritative attendance
evidence rather than invitation metadata.

The readable Calendar projection preserves attendee `responseStatus` and
`resource` fields (`src/mirror/materializer.ts`). Structured graph extraction
emits `INVITED_TO` with normalized `rsvpStatus` (`ACCEPTED`, `DECLINED`,
`TENTATIVE`, or `NEEDS_ACTION`) for human invitees and never infers `ATTENDED`
from an RSVP. Resource attendees, Google group/resource calendar addresses,
and known Calendar service principals are not promoted to Person
(`src/graph/extract/v2/structured.ts`).

**Why.** Calendar event ids are scoped by calendar, RSVP records invitation
state rather than observed presence, and provider infrastructure addresses are
not people. A Granola link is useful deterministic evidence only when it names
one already-resolved Calendar Meeting; ambiguity must remain unresolved.

**Alternatives rejected.** A tenant-global bare event id can collide across
calendars. Treating accepted/tentative responses as attendance asserts evidence
Google Calendar does not provide. Persisting a shared synthetic Calendar ref
for Granola loses the two native source identities and their provenance.

**Revisit when.** Add `ATTENDED` only when a connector captures direct
attendance evidence, such as an authoritative participant-presence record.
