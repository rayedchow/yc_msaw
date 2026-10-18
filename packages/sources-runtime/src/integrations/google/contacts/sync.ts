import { eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { googleContactNames } from "../../../db/schema.js";
import { env } from "../../../env.js";
import {
  GOOGLE_PEOPLE_IDENTITY_DELEGATION_SCOPES,
  GOOGLE_WORKSPACE_DIRECTORY_DELEGATION_SCOPES,
  getGoogleAccessToken,
  isDelegationConfigured,
} from "../../../vault/google-auth.js";
import { getTokenMetadata } from "../../../vault/tokens.js";
import {
  googleErrorMessageFromPayload,
  googleRateLimitErrorFromResponse,
  throwIfGoogleRateLimited,
} from "../../../vault/google-rate-limit.js";

const PEOPLE_API = "https://people.googleapis.com/v1";
const DIRECTORY_API = "https://admin.googleapis.com/admin/directory/v1";
const MAX_DELEGATED_USERS = positiveIntegerEnv("GOOGLE_CONTACTS_SYNC_MAX_DELEGATED_USERS", 500);

export const GOOGLE_CONTACT_SOURCES = ["connections", "other_contacts"] as const;
export type GoogleContactSource = typeof GOOGLE_CONTACT_SOURCES[number];

export interface GoogleContactNameCandidate {
  email: string;
  displayName: string;
  source: GoogleContactSource;
  ownerEmail: string;
  resourceName: string;
}

export type GoogleContactsSyncResult = {
  delegatedUsers: number;
  connectionsSeen: number;
  otherContactsSeen: number;
  candidateNames: number;
  namesUpserted: number;
};

type PeoplePerson = {
  resourceName?: string;
  names?: Array<{ displayName?: string; metadata?: { primary?: boolean } }>;
  emailAddresses?: Array<{ value?: string }>;
};

type PeopleConnectionsResponse = {
  connections?: PeoplePerson[];
  nextPageToken?: string;
};

type PeopleOtherContactsResponse = {
  otherContacts?: PeoplePerson[];
  nextPageToken?: string;
};

type DirectoryUsersResponse = {
  users?: Array<{ primaryEmail?: string; suspended?: boolean; archived?: boolean }>;
  nextPageToken?: string;
};

class GoogleContactsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleContactsApiError";
  }
}

/**
 * Full-resync of email -> display name pairs from Google Contacts for every
 * Google-connected workspace user of the tenant. Deliberately NOT syncToken
 * incremental: the People API sync-token contract requires deletion handling
 * plus per-(owner, endpoint) token state, and a tenant's contact lists are
 * small enough that a full paged listing per cycle is cheap. See
 * docs/integrations/google-contacts.md.
 */
export async function runGoogleContactsSync(
  userId: string,
  opts: { delegatedEmails?: string[] | null } = {},
): Promise<GoogleContactsSyncResult> {
  const users = normalizeDelegatedEmails(opts.delegatedEmails);
  if (users.length === 0) users.push(...await listWorkspaceUsers(userId));

  const result: GoogleContactsSyncResult = {
    delegatedUsers: users.length,
    connectionsSeen: 0,
    otherContactsSeen: 0,
    candidateNames: 0,
    namesUpserted: 0,
  };

  const candidates: GoogleContactNameCandidate[] = [];
  for (const delegatedEmail of users) {
    const accessToken = await getGoogleAccessToken(userId, delegatedEmail, GOOGLE_PEOPLE_IDENTITY_DELEGATION_SCOPES);
    const connections = await listConnections(accessToken);
    result.connectionsSeen += connections.length;
    candidates.push(...contactNameCandidates(connections, "connections", delegatedEmail));
    const otherContacts = await listOtherContacts(accessToken);
    result.otherContactsSeen += otherContacts.length;
    candidates.push(...contactNameCandidates(otherContacts, "other_contacts", delegatedEmail));
  }

  const merged = mergeContactCandidates(candidates);
  result.candidateNames = merged.size;
  result.namesUpserted = await upsertContactNames(userId, merged);
  return result;
}

/**
 * Extract persistable (email, display name) pairs from People API rows.
 * Entries whose display name is empty or email-like carry no naming value
 * and are skipped. Emails are normalized lower/trim; one candidate per
 * email address on the person.
 */
export function contactNameCandidates(
  people: PeoplePerson[],
  source: GoogleContactSource,
  ownerEmail: string,
): GoogleContactNameCandidate[] {
  const candidates: GoogleContactNameCandidate[] = [];
  for (const person of people) {
    const resourceName = person.resourceName?.trim();
    if (!resourceName) continue;
    const displayName = primaryDisplayName(person);
    if (!displayName || EMAIL_LIKE.test(displayName)) continue;
    for (const address of person.emailAddresses ?? []) {
      const email = address.value?.trim().toLowerCase();
      if (!email || !EMAIL_LIKE.test(email)) continue;
      candidates.push({ email, displayName, source, ownerEmail, resourceName });
    }
  }
  return candidates;
}

/**
 * Collapse candidates to one winner per email. Precedence: 'connections'
 * (a human deliberately saved this contact) beats 'other_contacts'
 * (auto-collected); within the same source the later candidate of this
 * sync run wins (newer sync wins is enforced across runs by the upsert).
 */
export function mergeContactCandidates(
  candidates: GoogleContactNameCandidate[],
): Map<string, GoogleContactNameCandidate> {
  const merged = new Map<string, GoogleContactNameCandidate>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.email);
    if (existing && !replacesSource(candidate.source, existing.source)) continue;
    merged.set(candidate.email, candidate);
  }
  return merged;
}

/** True when `next` is allowed to overwrite a row/candidate whose source is `current`. */
export function replacesSource(next: GoogleContactSource, current: GoogleContactSource): boolean {
  return next === "connections" || current === "other_contacts";
}

// SOURCE-LANE PATCH (calendar-contacts): exported so the contacts lane derives the
// names table from its snapshots with exactly this precedence logic.
export async function upsertContactNames(
  tenantId: string,
  merged: Map<string, GoogleContactNameCandidate>,
): Promise<number> {
  if (merged.size === 0) return 0;
  // The contacts task is serialized per group key, so read-then-decide is
  // race-safe; the ON CONFLICT re-checks precedence anyway so a concurrent
  // manual run can never demote a 'connections' row to 'other_contacts'.
  const existingRows = await db
    .select({ email: googleContactNames.email, source: googleContactNames.source })
    .from(googleContactNames)
    .where(eq(googleContactNames.tenantId, tenantId));
  const existingSources = new Map(existingRows.map((row) => [row.email, row.source as GoogleContactSource]));

  const syncedAt = new Date();
  let upserted = 0;
  for (const candidate of merged.values()) {
    const current = existingSources.get(candidate.email);
    if (current && !replacesSource(candidate.source, current)) continue;
    await db
      .insert(googleContactNames)
      .values({
        tenantId,
        email: candidate.email,
        displayName: candidate.displayName,
        source: candidate.source,
        ownerEmail: candidate.ownerEmail,
        resourceName: candidate.resourceName,
        syncedAt,
      })
      .onConflictDoUpdate({
        target: [googleContactNames.tenantId, googleContactNames.email],
        set: {
          displayName: candidate.displayName,
          source: candidate.source,
          ownerEmail: candidate.ownerEmail,
          resourceName: candidate.resourceName,
          syncedAt,
        },
        setWhere: candidate.source === "connections"
          ? undefined
          : eq(googleContactNames.source, "other_contacts"),
      });
    upserted += 1;
  }
  return upserted;
}

async function listConnections(accessToken: string): Promise<PeoplePerson[]> {
  const people: PeoplePerson[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${PEOPLE_API}/people/me/connections`);
    url.searchParams.set("personFields", "names,emailAddresses");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson<PeopleConnectionsResponse>(accessToken, url);
    people.push(...data.connections ?? []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return people;
}

async function listOtherContacts(accessToken: string): Promise<PeoplePerson[]> {
  const people: PeoplePerson[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${PEOPLE_API}/otherContacts`);
    url.searchParams.set("readMask", "names,emailAddresses");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson<PeopleOtherContactsResponse>(accessToken, url);
    people.push(...data.otherContacts ?? []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return people;
}

function primaryDisplayName(person: PeoplePerson): string | null {
  const names = person.names ?? [];
  const primary = names.find((name) => name.metadata?.primary === true) ?? names[0];
  const displayName = primary?.displayName?.trim();
  return displayName ? normalizeCommaName(displayName) : null;
}

/**
 * Google stores some contacts in "Last, First" file-as order. That comma
 * fails the strict name-shape rule the resolver's rename path enforces, so
 * such names would never apply. Exactly one comma with letter-shaped sides
 * is the documented file-as format — swap deterministically; anything else
 * passes through untouched.
 */
export function normalizeCommaName(displayName: string): string {
  const match = /^([\p{L}][\p{L}\p{M}'. -]*)\s*,\s+([\p{L}][\p{L}\p{M}'. -]*[\p{L}.])$/u.exec(displayName);
  if (!match) return displayName;
  return `${match[2]!.trim()} ${match[1]!.trim()}`;
}

// Same pattern as the calendar poller's workspace enumeration (Directory API,
// DWD admin impersonation); no TTL cache here because the contacts sync runs
// on an hours-scale cadence, not per minute.
async function listWorkspaceUsers(userId: string): Promise<string[]> {
  const adminEmail = await requireDelegationAdminEmail(userId);
  const accessToken = await getGoogleAccessToken(userId, adminEmail, GOOGLE_WORKSPACE_DIRECTORY_DELEGATION_SCOPES);
  const users = new Set<string>();
  let pageToken: string | undefined;

  do {
    const url = new URL(`${DIRECTORY_API}/users`);
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", "500");
    url.searchParams.set("projection", "basic");
    url.searchParams.set("orderBy", "email");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await googleJson<DirectoryUsersResponse>(accessToken, url);
    for (const user of data.users ?? []) {
      const email = user.primaryEmail?.trim().toLowerCase();
      if (!email || user.suspended || user.archived) continue;
      users.add(email);
      if (users.size > MAX_DELEGATED_USERS) {
        throw new Error(
          `Google Contacts sync exceeded the delegated-user limit: ${users.size} > ${MAX_DELEGATED_USERS}. `
            + "Increase GOOGLE_CONTACTS_SYNC_MAX_DELEGATED_USERS deliberately or pass explicit delegatedEmails.",
        );
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  const sorted = [...users].sort();
  if (sorted.length === 0) {
    throw new Error("Google Workspace Directory returned zero active users for Contacts sync.");
  }
  return sorted;
}

async function requireDelegationAdminEmail(userId: string): Promise<string> {
  if (!isDelegationConfigured()) {
    throw new Error("Google Contacts sync requires Google Workspace domain-wide delegation credentials.");
  }
  const metadata = await getTokenMetadata(userId, "google");
  const usesDelegation = metadata?.delegation === true || metadata?.authMode === "domain_wide_delegation";
  if (!usesDelegation) {
    throw new Error("Google Contacts sync requires this user to be connected via Google Workspace domain-wide delegation.");
  }
  const email = typeof metadata?.email === "string" && metadata.email.trim()
    ? metadata.email.trim().toLowerCase()
    : env.GOOGLE_WORKSPACE_USER_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw new Error("Google Contacts sync needs a delegated admin email in Google token metadata or GOOGLE_WORKSPACE_USER_EMAIL.");
  }
  return email;
}

async function googleJson<T>(accessToken: string, url: URL): Promise<T> {
  throwIfGoogleRateLimited("google-contacts");
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json");
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const rateLimit = googleRateLimitErrorFromResponse("google-contacts", res, data);
    if (rateLimit) throw rateLimit;
    const message = googleErrorMessageFromPayload(data) ?? `${res.status} ${res.statusText}`;
    throw new GoogleContactsApiError(`Google People API request failed: ${message}`, res.status);
  }
  return (data ?? {}) as T;
}

function normalizeDelegatedEmails(value: string[] | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort();
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.trunc(value);
}

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
