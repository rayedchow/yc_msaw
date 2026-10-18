import { sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  contactNameCandidates,
  mergeContactCandidates,
  upsertContactNames,
  type GoogleContactNameCandidate,
  type GoogleContactSource,
  type GoogleContactsSyncResult,
} from "../../../integrations/google/contacts/sync.js";
import { GoogleRateLimitError } from "../../../vault/google-rate-limit.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import {
  LaneGoogleApiError,
  backoffSeconds,
  claimLease,
  classifyLaneFailure,
  clearListed,
  errorText,
  laneClient,
  loadMailboxStatus,
  markListed,
  newLeaseOwner,
  positiveIntegerEnv,
  queryRows,
  recordMailboxFailure,
  recordMailboxSuccess,
  recordRosterStatus,
  releaseLease,
  resolveGoogleRoster,
  sha256Hex,
  stableJson,
  type LaneFailure,
  type LaneGoogleClient,
} from "../calendar/google-lane.js";

/**
 * Google Contacts source lane: per (tenant, mailbox, endpoint) People API capture of
 * saved contacts (people.connections.list) and auto-collected other contacts
 * (otherContacts.list), with sync tokens instead of the donor's every-6h full listing.
 *
 *  * Initial and reset full listings are resumable (page token checkpointed after each
 *    stored page, bounded per run); the sync token is committed only after the last page.
 *  * Expired sync tokens (410 / EXPIRED_SYNC_TOKEN) re-list fully against the kept
 *    snapshots; contacts a completed full listing no longer returns become `removed`.
 *  * metadata.deleted persons become `deleted`; a person whose
 *    metadata.previousResourceNames lists an old resource marks that one `merged`
 *    (merged_into = surviving resourceName). Identity is the resourceName per mailbox.
 *  * Snapshots keep the post-redaction People API payload for the configured field mask
 *    (photos are not requested); every change lands in the append-only revision ledger.
 *  * The donor google_contact_names table is still derived (donor candidate/merge/upsert
 *    functions) from the active snapshots of all mailboxes.
 *
 * Privacy note: the donor stored names only. Capturing contact cards is a deliberate
 * reopening of docs/integrations/google-contacts.md "Privacy: names only" for the
 * tenant-owned source filesystem; GOOGLE_CONTACTS_PERSON_FIELDS narrows the mask.
 */

const PEOPLE_API = "https://people.googleapis.com/v1";
export const CONTACTS_CONNECTIONS_SCOPES = ["https://www.googleapis.com/auth/contacts.readonly"] as const;
export const CONTACTS_OTHER_SCOPES = ["https://www.googleapis.com/auth/contacts.other.readonly"] as const;
export const DEFAULT_CONNECTION_PERSON_FIELDS = "names,nicknames,emailAddresses,phoneNumbers,organizations,memberships,metadata";
/** otherContacts.list accepts only emailAddresses, metadata, names, phoneNumbers, photos. */
export const DEFAULT_OTHER_CONTACT_READ_MASK = "names,emailAddresses,phoneNumbers,metadata";
export const CONTACTS_FULL_SYNC_PAGE_BUDGET = positiveIntegerEnv("GOOGLE_CONTACTS_FULL_SYNC_PAGES_PER_RUN", 20);
const INCREMENTAL_PAGE_LIMIT = 500;

export type ContactEndpoint = GoogleContactSource;
export const CONTACT_ENDPOINTS: readonly ContactEndpoint[] = ["connections", "other_contacts"];

export interface PeoplePerson {
  resourceName?: string;
  etag?: string;
  metadata?: {
    deleted?: boolean;
    previousResourceNames?: string[];
    linkedPeopleResourceNames?: string[];
    sources?: Array<{ type?: string; id?: string; etag?: string; updateTime?: string }>;
    [key: string]: unknown;
  };
  names?: Array<{ displayName?: string; metadata?: { primary?: boolean } }>;
  emailAddresses?: Array<{ value?: string; type?: string }>;
  [key: string]: unknown;
}

export type ContactsLaneResult = GoogleContactsSyncResult & {
  mailboxesBlocked: number;
  mailboxesRateLimited: number;
  mailboxesFailed: number;
  mailboxesSkipped: number;
  endpointsComplete: number;
  endpointsPartial: number;
  endpointsBlocked: number;
  contactsChanged: number;
  contactsDeleted: number;
  contactsMerged: number;
  contactsRemoved: number;
  resets: number;
  capHit: boolean;
};

export function contactFieldMask(endpoint: ContactEndpoint, env: NodeJS.ProcessEnv = process.env): string {
  const raw = endpoint === "connections" ? env.GOOGLE_CONTACTS_PERSON_FIELDS : env.GOOGLE_OTHER_CONTACTS_READ_MASK;
  const fields = (raw ?? "").split(",").map((f) => f.trim()).filter((f) => /^[a-zA-Z]+$/.test(f));
  const mask = fields.length ? [...new Set(fields)].sort().join(",") : (endpoint === "connections" ? DEFAULT_CONNECTION_PERSON_FIELDS : DEFAULT_OTHER_CONTACT_READ_MASK);
  return mask.includes("metadata") ? mask : `${mask},metadata`;
}

export function peopleListUrl(endpoint: ContactEndpoint, input: { fieldMask: string; syncToken?: string | null; pageToken?: string | null }): URL {
  const url = endpoint === "connections" ? new URL(`${PEOPLE_API}/people/me/connections`) : new URL(`${PEOPLE_API}/otherContacts`);
  url.searchParams.set(endpoint === "connections" ? "personFields" : "readMask", input.fieldMask);
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("requestSyncToken", "true");
  if (input.syncToken) url.searchParams.set("syncToken", input.syncToken);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return url;
}

/** People API sync-token expiry: 410, or 400 FAILED_PRECONDITION with reason EXPIRED_SYNC_TOKEN. */
export function isExpiredSyncToken(err: unknown): boolean {
  if (!(err instanceof LaneGoogleApiError)) return false;
  if (err.status === 410) return true;
  return err.status === 400 && (err.reason === "EXPIRED_SYNC_TOKEN" || /sync token.*(expired|invalid)|EXPIRED_SYNC_TOKEN/i.test(err.message));
}

export function primaryDisplayName(person: PeoplePerson): string | null {
  const names = person.names ?? [];
  const primary = names.find((n) => n.metadata?.primary === true) ?? names[0];
  return primary?.displayName?.trim() || null;
}

export function personEmails(person: PeoplePerson): string[] {
  return [...new Set((person.emailAddresses ?? []).map((e) => e.value?.trim().toLowerCase()).filter((e): e is string => Boolean(e)))];
}

export function personUpdatedAt(person: PeoplePerson): string | null {
  const times = (person.metadata?.sources ?? []).map((s) => (s.updateTime ? Date.parse(s.updateTime) : Number.NaN)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function emptyResult(): ContactsLaneResult {
  return {
    delegatedUsers: 0, connectionsSeen: 0, otherContactsSeen: 0, candidateNames: 0, namesUpserted: 0,
    mailboxesBlocked: 0, mailboxesRateLimited: 0, mailboxesFailed: 0, mailboxesSkipped: 0,
    endpointsComplete: 0, endpointsPartial: 0, endpointsBlocked: 0,
    contactsChanged: 0, contactsDeleted: 0, contactsMerged: 0, contactsRemoved: 0, resets: 0, capHit: false,
  };
}

export async function runContactsLane(
  tenantId: string,
  opts: { delegatedEmails?: string[] | null; forceFull?: boolean | null } = {},
): Promise<ContactsLaneResult> {
  const result = emptyResult();
  const forceFull = opts.forceFull === true;
  const roster = await resolveGoogleRoster(tenantId, { explicit: opts.delegatedEmails, forceRefresh: forceFull });
  if (!opts.delegatedEmails?.length) await recordRosterStatus(tenantId, "contacts", roster);
  result.delegatedUsers = roster.mailboxes.length;
  for (const mailbox of roster.mailboxes) await syncMailbox(tenantId, mailbox, result, forceFull);
  if (result.contactsChanged + result.contactsDeleted + result.contactsMerged + result.contactsRemoved > 0) {
    const names = await refreshContactNames(tenantId);
    result.candidateNames = names.candidateNames;
    result.namesUpserted = names.namesUpserted;
  }
  return result;
}

type EndpointOutcome = "complete" | "partial" | "blocked" | "failed" | "skipped";

async function syncMailbox(tenantId: string, mailbox: string, result: ContactsLaneResult, forceFull: boolean): Promise<void> {
  const status = await loadMailboxStatus(tenantId, "contacts", mailbox);
  if (!forceFull && status?.next_attempt_at && new Date(status.next_attempt_at).getTime() > Date.now()) {
    result.mailboxesSkipped++;
    return;
  }
  const outcomes: Partial<Record<ContactEndpoint, { outcome: EndpointOutcome; failure?: LaneFailure }>> = {};
  let authMode: string | null = null;
  let rateLimited: GoogleRateLimitError | null = null;
  for (const endpoint of CONTACT_ENDPOINTS) {
    if (rateLimited) break;
    let client: LaneGoogleClient;
    try {
      // Each endpoint has its own scope: an OAuth grant may hold one without the other.
      client = await laneClient(tenantId, mailbox, endpoint === "connections" ? CONTACTS_CONNECTIONS_SCOPES : CONTACTS_OTHER_SCOPES, "google-contacts");
      authMode = client.mode;
    } catch (err) {
      const failure = classifyLaneFailure(err);
      outcomes[endpoint] = { outcome: failure.kind === "auth_blocked" ? "blocked" : "failed", failure };
      await recordEndpointFailure(tenantId, mailbox, endpoint, err, failure);
      if (err instanceof GoogleRateLimitError) rateLimited = err;
      continue;
    }
    try {
      outcomes[endpoint] = { outcome: await syncEndpoint(tenantId, client, endpoint, result, forceFull) };
    } catch (err) {
      const failure = classifyLaneFailure(err);
      outcomes[endpoint] = { outcome: failure.kind === "auth_blocked" ? "blocked" : "failed", failure };
      await recordEndpointFailure(tenantId, mailbox, endpoint, err, failure);
      if (err instanceof GoogleRateLimitError) rateLimited = err;
    }
  }

  const values = Object.values(outcomes);
  for (const v of values) {
    if (v.outcome === "complete") result.endpointsComplete++;
    else if (v.outcome === "blocked") result.endpointsBlocked++;
    else result.endpointsPartial++;
  }
  if (rateLimited) {
    result.mailboxesRateLimited++;
    await recordMailboxFailure(tenantId, "contacts", mailbox, classifyLaneFailure(rateLimited), { authMode });
    return;
  }
  if (values.length > 0 && values.every((v) => v.outcome === "blocked")) {
    result.mailboxesBlocked++;
    await recordMailboxFailure(tenantId, "contacts", mailbox, values[0]!.failure!, { authMode });
    return;
  }
  if (values.length > 0 && values.every((v) => v.outcome === "failed" || v.outcome === "blocked")) {
    result.mailboxesFailed++;
    await recordMailboxFailure(tenantId, "contacts", mailbox, values.find((v) => v.outcome === "failed")!.failure!, { authMode });
    return;
  }
  const notComplete = CONTACT_ENDPOINTS.filter((e) => outcomes[e]?.outcome !== "complete");
  await recordMailboxSuccess(tenantId, "contacts", mailbox, {
    state: notComplete.length ? "partial" : "ok",
    reason: notComplete.length ? notComplete.map((e) => `${e}: ${outcomes[e]?.failure?.code ?? outcomes[e]?.outcome ?? "not run"}`).join("; ") : null,
    authMode,
  });
}

interface ContactCursorRow {
  id: string;
  field_mask: string;
  sync_token: string | null;
  full_sync_started_at: string | null;
  full_sync_page_token: string | null;
  first_full_sync_completed_at: string | null;
  consecutive_failures: number;
  next_attempt_at: string | null;
}

async function ensureCursor(tenantId: string, mailbox: string, endpoint: ContactEndpoint, fieldMask: string): Promise<ContactCursorRow> {
  await db.execute(sql`
    INSERT INTO google_contact_lane_cursors (tenant_id, mailbox, endpoint, field_mask)
    VALUES (${tenantId}, ${mailbox}, ${endpoint}, ${fieldMask})
    ON CONFLICT (tenant_id, mailbox, endpoint) DO NOTHING
  `);
  return (await loadCursor(tenantId, mailbox, endpoint))!;
}

async function loadCursor(tenantId: string, mailbox: string, endpoint: ContactEndpoint): Promise<ContactCursorRow | null> {
  const [row] = await queryRows<ContactCursorRow>(sql`
    SELECT id::text, field_mask, sync_token, full_sync_started_at, full_sync_page_token, first_full_sync_completed_at, consecutive_failures, next_attempt_at
    FROM google_contact_lane_cursors WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND endpoint = ${endpoint}
  `);
  return row ?? null;
}

async function recordEndpointFailure(tenantId: string, mailbox: string, endpoint: ContactEndpoint, err: unknown, failure: LaneFailure): Promise<void> {
  const cursor = await ensureCursor(tenantId, mailbox, endpoint, contactFieldMask(endpoint));
  const failures = cursor.consecutive_failures + 1;
  const next = new Date(Date.now() + backoffSeconds(failure, failures) * 1000);
  await db.execute(sql`
    UPDATE google_contact_lane_cursors SET last_error = ${errorText(err)}, last_error_code = ${failure.code}, last_error_at = now(),
      last_attempt_at = now(), consecutive_failures = ${failures}, next_attempt_at = ${next.toISOString()}, updated_at = now()
    WHERE id = ${cursor.id}::uuid
  `);
}

async function beginFullSync(cursorId: string, reason: string, fieldMask: string): Promise<void> {
  await clearListed(cursorId);
  await db.execute(sql`
    UPDATE google_contact_lane_cursors SET sync_token = NULL, field_mask = ${fieldMask}, full_sync_started_at = now(),
      full_sync_page_token = NULL, full_sync_pages = 0, full_sync_reason = ${reason}, updated_at = now()
    WHERE id = ${cursorId}::uuid
  `);
}

type PeoplePage = { connections?: PeoplePerson[]; otherContacts?: PeoplePerson[]; nextPageToken?: string; nextSyncToken?: string };

async function syncEndpoint(tenantId: string, client: LaneGoogleClient, endpoint: ContactEndpoint, result: ContactsLaneResult, forceFull: boolean): Promise<EndpointOutcome> {
  const mailbox = client.account;
  const fieldMask = contactFieldMask(endpoint);
  let cursor = await ensureCursor(tenantId, mailbox, endpoint, fieldMask);
  if (!forceFull && cursor.next_attempt_at && new Date(cursor.next_attempt_at).getTime() > Date.now()) return "skipped";
  const owner = newLeaseOwner();
  if (!(await claimLease("google_contact_lane_cursors", cursor.id, owner))) return "skipped";
  try {
    cursor = (await loadCursor(tenantId, mailbox, endpoint))!;
    // Every other parameter must match the call that produced a sync/page token.
    if (cursor.field_mask !== fieldMask) await beginFullSync(cursor.id, "field_mask_changed", fieldMask);
    else if (forceFull && !cursor.full_sync_started_at) await beginFullSync(cursor.id, "forced", fieldMask);
    cursor = (await loadCursor(tenantId, mailbox, endpoint))!;

    if (cursor.sync_token && !cursor.full_sync_started_at) {
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      let pages = 0;
      try {
        for (;;) {
          const page = await client.json<PeoplePage>(peopleListUrl(endpoint, { fieldMask, syncToken: cursor.sync_token, pageToken }));
          await storePeoplePage(tenantId, mailbox, endpoint, page, result);
          nextSyncToken = page.nextSyncToken ?? nextSyncToken;
          if (!page.nextPageToken) break;
          if (++pages >= INCREMENTAL_PAGE_LIMIT) throw new Error(`incremental People sync exceeded ${INCREMENTAL_PAGE_LIMIT} pages`);
          pageToken = page.nextPageToken;
        }
      } catch (err) {
        if (!isExpiredSyncToken(err)) throw err;
        result.resets++;
        await beginFullSync(cursor.id, "sync_token_expired", fieldMask);
        return runFullSync(tenantId, client, endpoint, (await loadCursor(tenantId, mailbox, endpoint))!, fieldMask, result);
      }
      await db.execute(sql`
        UPDATE google_contact_lane_cursors SET sync_token = ${nextSyncToken ?? cursor.sync_token}, last_incremental_at = now(),
          last_success_at = now(), last_attempt_at = now(), last_error = NULL, last_error_code = NULL,
          consecutive_failures = 0, next_attempt_at = NULL, updated_at = now()
        WHERE id = ${cursor.id}::uuid
      `);
      return "complete";
    }
    if (!cursor.full_sync_started_at) {
      await beginFullSync(cursor.id, cursor.first_full_sync_completed_at ? "resync" : "initial", fieldMask);
      cursor = (await loadCursor(tenantId, mailbox, endpoint))!;
    }
    return await runFullSync(tenantId, client, endpoint, cursor, fieldMask, result);
  } finally {
    await releaseLease("google_contact_lane_cursors", cursor.id, owner);
  }
}

async function runFullSync(
  tenantId: string,
  client: LaneGoogleClient,
  endpoint: ContactEndpoint,
  cursor: ContactCursorRow,
  fieldMask: string,
  result: ContactsLaneResult,
): Promise<EndpointOutcome> {
  const mailbox = client.account;
  let pageToken = cursor.full_sync_page_token ?? undefined;
  let restarted = false;
  for (let pagesThisRun = 0; ; ) {
    if (pagesThisRun >= CONTACTS_FULL_SYNC_PAGE_BUDGET) {
      result.capHit = true;
      await db.execute(sql`UPDATE google_contact_lane_cursors SET last_attempt_at = now(), last_success_at = now(), updated_at = now() WHERE id = ${cursor.id}::uuid`);
      return "partial";
    }
    let page: PeoplePage;
    try {
      page = await client.json<PeoplePage>(peopleListUrl(endpoint, { fieldMask, pageToken }));
    } catch (err) {
      if (pageToken && !restarted && err instanceof LaneGoogleApiError && (err.status === 400 || err.status === 410)) {
        restarted = true;
        result.resets++;
        pageToken = undefined;
        await clearListed(cursor.id);
        await db.execute(sql`
          UPDATE google_contact_lane_cursors SET full_sync_started_at = now(), full_sync_page_token = NULL,
            full_sync_pages = 0, full_sync_reason = 'page_token_invalid', updated_at = now()
          WHERE id = ${cursor.id}::uuid
        `);
        continue;
      }
      throw err;
    }
    await storePeoplePage(tenantId, mailbox, endpoint, page, result);
    await markListed(cursor.id, ((endpoint === "connections" ? page.connections : page.otherContacts) ?? [])
      .filter((p) => p.metadata?.deleted !== true)
      .map((p) => p.resourceName?.trim())
      .filter((rn): rn is string => Boolean(rn)));
    pagesThisRun++;
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      await db.execute(sql`
        UPDATE google_contact_lane_cursors SET full_sync_page_token = ${pageToken}, full_sync_pages = full_sync_pages + 1,
          last_attempt_at = now(), updated_at = now()
        WHERE id = ${cursor.id}::uuid
      `);
      continue;
    }
    result.contactsRemoved += await sweepUnlisted(tenantId, mailbox, endpoint, cursor.id);
    await clearListed(cursor.id);
    await db.execute(sql`
      UPDATE google_contact_lane_cursors SET sync_token = ${page.nextSyncToken ?? null}, full_sync_started_at = NULL, full_sync_page_token = NULL,
        full_sync_pages = 0, full_sync_reason = NULL, full_sync_completed_at = now(),
        first_full_sync_completed_at = COALESCE(first_full_sync_completed_at, now()),
        last_success_at = now(), last_attempt_at = now(), last_error = NULL, last_error_code = NULL,
        consecutive_failures = 0, next_attempt_at = NULL, updated_at = now()
      WHERE id = ${cursor.id}::uuid
    `);
    return "complete";
  }
}

/** Store one page: upsert live persons, tombstone deleted ones, mark merged-away resources. */
export async function storePeoplePage(
  tenantId: string,
  mailbox: string,
  endpoint: ContactEndpoint,
  page: PeoplePage,
  result: Pick<ContactsLaneResult, "connectionsSeen" | "otherContactsSeen" | "contactsChanged" | "contactsDeleted" | "contactsMerged">,
): Promise<void> {
  const people = (endpoint === "connections" ? page.connections : page.otherContacts) ?? [];
  if (endpoint === "connections") result.connectionsSeen += people.length;
  else result.otherContactsSeen += people.length;
  for (const person of people) {
    const resourceName = person.resourceName?.trim();
    if (!resourceName) continue;
    if (person.metadata?.deleted === true) {
      const rows = await queryRows<{ id: string }>(sql`
        UPDATE google_contact_snapshots SET state = 'deleted', state_changed_at = now(), last_seen_at = now(), updated_at = now()
        WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND endpoint = ${endpoint} AND resource_name = ${resourceName}
          AND state NOT IN ('deleted', 'merged')
        RETURNING id
      `);
      result.contactsDeleted += rows.length;
      continue;
    }
    const redacted = redactProviderPayload("google-contacts", person) as PeoplePerson;
    const contentHash = sha256Hex(stableJson(redacted));
    const rows = await queryRows<{ changed: boolean }>(sql`
      INSERT INTO google_contact_snapshots
        (tenant_id, mailbox, endpoint, resource_name, etag, state, display_name, emails, content_hash, raw_payload, source_updated_at, state_changed_at)
      VALUES (${tenantId}, ${mailbox}, ${endpoint}, ${resourceName}, ${person.etag ?? null}, 'active', ${primaryDisplayName(redacted)},
              ${JSON.stringify(personEmails(redacted))}::jsonb, ${contentHash}, ${JSON.stringify(redacted)}::jsonb, ${personUpdatedAt(redacted)}, now())
      ON CONFLICT (tenant_id, mailbox, endpoint, resource_name) DO UPDATE SET
        etag = EXCLUDED.etag, display_name = EXCLUDED.display_name, emails = EXCLUDED.emails,
        content_hash = EXCLUDED.content_hash, raw_payload = EXCLUDED.raw_payload, source_updated_at = EXCLUDED.source_updated_at,
        state = 'active', merged_into = NULL,
        state_changed_at = CASE WHEN google_contact_snapshots.state <> 'active' THEN now() ELSE google_contact_snapshots.state_changed_at END,
        last_seen_at = now(),
        updated_at = CASE WHEN google_contact_snapshots.content_hash <> EXCLUDED.content_hash OR google_contact_snapshots.state <> 'active'
                          THEN now() ELSE google_contact_snapshots.updated_at END
      RETURNING (xmax = 0 OR updated_at >= now()) AS changed
    `);
    if (rows[0]?.changed) result.contactsChanged++;
    for (const previous of person.metadata?.previousResourceNames ?? []) {
      if (typeof previous !== "string" || !previous || previous === resourceName) continue;
      const merged = await queryRows<{ id: string }>(sql`
        UPDATE google_contact_snapshots SET state = 'merged', merged_into = ${resourceName}, state_changed_at = now(), updated_at = now()
        WHERE tenant_id = ${tenantId} AND mailbox = ${mailbox} AND endpoint = ${endpoint} AND resource_name = ${previous}
          AND (state <> 'merged' OR merged_into IS DISTINCT FROM ${resourceName})
        RETURNING id
      `);
      result.contactsMerged += merged.length;
    }
  }
}

/** Active contacts the completed full listing of `cursorId` did not return are no longer at Google. */
async function sweepUnlisted(tenantId: string, mailbox: string, endpoint: ContactEndpoint, cursorId: string): Promise<number> {
  const rows = await queryRows<{ id: string }>(sql`
    UPDATE google_contact_snapshots s SET state = 'removed', state_changed_at = now(), updated_at = now()
    WHERE s.tenant_id = ${tenantId} AND s.mailbox = ${mailbox} AND s.endpoint = ${endpoint} AND s.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM google_lane_full_listing_seen l WHERE l.cursor_id = ${cursorId}::uuid AND l.item_key = s.resource_name)
    RETURNING s.id
  `);
  return rows.length;
}

/** Donor names table from the active snapshots of every mailbox (donor precedence: connections > other_contacts). */
export async function refreshContactNames(tenantId: string): Promise<{ candidateNames: number; namesUpserted: number }> {
  const rows = await queryRows<{ mailbox: string; endpoint: ContactEndpoint; raw: PeoplePerson }>(sql`
    SELECT mailbox, endpoint, raw_payload AS raw FROM google_contact_snapshots
    WHERE tenant_id = ${tenantId} AND state = 'active'
    ORDER BY endpoint DESC, mailbox, resource_name
  `);
  const candidates: GoogleContactNameCandidate[] = [];
  for (const row of rows) candidates.push(...contactNameCandidates([row.raw], row.endpoint, row.mailbox));
  const merged = mergeContactCandidates(candidates);
  return { candidateNames: merged.size, namesUpserted: await upsertContactNames(tenantId, merged) };
}
