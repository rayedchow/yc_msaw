# Google Contacts (name enrichment)

Code: `src/integrations/google/contacts/` (sync) and
`src/graph/extract/v2/contact-names.ts` (graph seam).

Purpose: emails observed in the graph (meeting attendees, email senders)
frequently arrive with no human name, so Person entities get canonically
named by their address. The People API maps email → display name from
provider-structured metadata, and the v2 resolver's existing metadata-only
rename rule (`betterCanonicalName`, PR #102) upgrades those email-named
entities. No LLM, no guessing, anywhere in this path.

## Sources: `people.connections.list` + `otherContacts.list`

**Decision.** Per Google-connected workspace user of the tenant we read BOTH
People API surfaces: `people/me/connections` (contacts the user deliberately
saved) and `otherContacts` (Google's auto-collected directory of everyone the
user has emailed). Rows land in `google_contact_names` keyed
`(tenant_id, email)` with the source recorded.

**Why.** `otherContacts` is where most correspondent names actually live — a
typical user saves few contacts but emails many people, and Gmail's
auto-collection assigns display names from signatures/profiles. Connections
alone would cover a fraction of observed emails.

**Alternatives rejected.**
- Directory API `people.listDirectoryPeople`: covers only in-domain users,
  who already have names from workspace metadata; the gap is external people.
- Parsing names out of email headers at ingest: header display-names are
  sender-controlled free text of varying quality; People API rows are the
  curated version of the same signal with one consistent trust class.

**Revisit when.** We need per-contact organization/title enrichment — then
`personFields` grows and the privacy decision below must be reopened
explicitly.

## Scopes and auth: DWD only, existing grant

**Decision.** Auth is the standard DWD impersonation path
(`getGoogleAccessToken` per delegated user) with the already-granted
`GOOGLE_PEOPLE_IDENTITY_DELEGATION_SCOPES`
(`contacts.readonly`, `contacts.other.readonly`, `directory.readonly` — see
`src/vault/google-auth.ts`). Workspace users are enumerated via the Admin
Directory API exactly like the calendar poller.

**Why.** The scopes were already in the domain-wide delegation grant; no
admin re-consent is needed. Contact visibility is per-requester, which is why
sync fans out over every workspace user and records `owner_email`.

## Precedence: connections > other_contacts, newer sync wins

**Decision.** One row per `(tenant_id, email)`. A `connections` name always
overwrites; an `other_contacts` name only overwrites another
`other_contacts` row (never a `connections` row). Within one source, the
newest sync wins. Entries whose display name is empty or email-like are
skipped at sync time (no naming value) and re-guarded at read time.

**Why.** A deliberately saved contact name is a human assertion; an
auto-collected one is a heuristic Google made. When two workspace users have
different saved names for the same address, last-sync-wins is accepted —
both are trusted-class names and arbitration would be guessing.

## Change detection: full resync, no syncToken

**Decision.** Every run is a full paged listing of both endpoints; no
`requestSyncToken`/`syncToken` incremental sync. Rows are upserted, never
deleted — a contact being removed does not un-know a name.

**Why.** Incremental sync would require per-(owner, endpoint) token state
(a new table), 410-expiry fallback, and deletion semantics — for lists that
are typically thousands of rows read at 1,000/page. The full listing is a
handful of requests per user per cycle, far below People API quotas.

**Revisit when.** A tenant's contact volume or user count makes the full
listing a measurable quota cost; then add a sync-state table mirroring
`google_calendar_sync_states`.

## Privacy: names only

**Decision.** Only `(email, display_name)` pairs persist, plus provenance
(`source`, `owner_email`, `resource_name`, `synced_at`). Phone numbers,
photos, addresses, birthdays, and raw People API payloads are never written
anywhere — not to the DB, the mirror, or logs.

**Why.** The product need is naming graph entities we already observe by
email. Everything else in a contact card is new personal data with no
consumer, and `resource_name`/`owner_email` suffice to audit or re-fetch.

## Graph integration: alias injection at the extraction writer

**Decision.** `writeV2Extraction` (`src/graph/extract/v2/writer.ts`) attaches
a `display_name:<name>` alias to validated Person mentions that carry an
`email` identity key, from one batched `google_contact_names` query per chunk
(`attachGoogleContactNameAliases`). The resolver is untouched: its existing
`betterCanonicalName` rule sees the alias on link and renames email-named
entities.

**Why.** The writer is the single choke point both the LLM extractor and the
deterministic structured parser flow through, and mention aliases already are
the channel provider-metadata names travel in (e.g. the author-name alias on
owner-pronoun rewrites). Injecting anywhere later would duplicate the rename
rule; injecting per-mention would query per mention.

**Alternatives rejected.**
- A batch "rename existing entities" job: mutates entities outside the
  resolver's single rename path and races with linking.
- Resolver-side lookup: adds a per-mention DB dependency inside the linker
  hot path and touches concurrently-edited code for no coverage gain.

## Cadence

`google.contacts_sync` task, scheduled per tenant every 21,600s (6h, same
slow-identity class as `gdocs.actor-repair`), group key
`<tenant>:google-contacts` so it never blocks calendar/gmail lanes. One-shot:
`npx tsx scripts/google-contacts-sync.ts --tenant <tenant_id>`.
