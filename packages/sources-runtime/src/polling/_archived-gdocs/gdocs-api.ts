/**
 * gdocs-api.ts - Extracted Google API client for Docs/Drive/Activity/People.
 *
 * All raw API calls live here. Each function handles its own error responses
 * and 429 retry via gFetch.
 */
import { createHash } from "node:crypto";
import { googleErrorReasonFromPayload, googleRateLimitErrorFromResponse, throwIfGoogleRateLimited } from "../../vault/google-rate-limit.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DOCS_API = "https://docs.googleapis.com/v1/documents";
const ACTIVITY_API =
  "https://driveactivity.googleapis.com/v2/activity:query";
const PEOPLE_API = "https://people.googleapis.com/v1";

export const INTER_API_DELAY_MS = 300;
export const INTER_DOC_DELAY_MS = 500;

const MAX_CHANGE_PAGES = 50;
const PEOPLE_BATCH_SIZE = 50;
const ACTOR_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";

export const WORKSPACE_MIMES = new Set([
  GOOGLE_DOC_MIME,
  GOOGLE_SHEET_MIME,
  GOOGLE_SLIDES_MIME,
]);

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface DriveChange {
  fileId: string;
  file?: {
    name: string;
    mimeType: string;
    modifiedTime: string;
    md5Checksum?: string;
    headRevisionId?: string;
    lastModifyingUser?: { displayName?: string; emailAddress?: string };
    /** Absent for shared-drive files (they have no owner). */
    owners?: Array<{ displayName?: string; emailAddress?: string }>;
    parents?: string[];
    trashed: boolean;
  };
  removed?: boolean;
}

export interface KnownUser {
  personName: string;
  isCurrentUser: boolean;
}

export interface DriveActivityAction {
  primaryActionDetail: {
    create?: Record<string, unknown>;
    edit?: Record<string, unknown>;
    rename?: { oldTitle: string; newTitle: string };
    move?: {
      addedParents: Array<{ driveItem?: { name: string; title: string } }>;
      removedParents: Array<{ driveItem?: { name: string; title: string } }>;
    };
    delete?: { type: string };
    restore?: { type: string };
    permissionChange?: {
      addedPermissions?: Array<{
        role: string;
        user?: { knownUser: KnownUser };
      }>;
      removedPermissions?: Array<{
        role: string;
        user?: { knownUser: KnownUser };
      }>;
    };
    comment?: {
      post?: {
        subtype:
          | "ADDED"
          | "DELETED"
          | "REPLY_ADDED"
          | "REPLY_DELETED"
          | "RESOLVED"
          | "REOPENED";
      };
      assignment?: {
        subtype:
          | "ADDED"
          | "DELETED"
          | "REPLY_ADDED"
          | "REPLY_DELETED"
          | "RESOLVED"
          | "REASSIGNED";
      };
      suggestion?: {
        subtype:
          | "ADDED"
          | "DELETED"
          | "REPLY_ADDED"
          | "REPLY_DELETED"
          | "ACCEPTED"
          | "REJECTED"
          | "ACCEPT_DELETED"
          | "REJECT_DELETED";
      };
      mentionedUsers?: KnownUser[];
    };
  };
  actors: Array<{
    user?: {
      knownUser?: KnownUser;
    };
  }>;
  targets: Array<{
    driveItem?: {
      name: string;
      title: string;
      mimeType: string;
    };
    fileComment?: {
      legacyCommentId: string;
      legacyDiscussionId: string;
      linkToDiscussion: string;
      parent?: {
        legacyCommentId: string;
      };
    };
  }>;
  timestamp?: string;
  timeRange?: {
    startTime: string;
    endTime: string;
  };
}

export interface DriveComment {
  id: string;
  content: string;
  author: {
    displayName: string;
    emailAddress: string;
    photoLink?: string;
  };
  createdTime: string;
  modifiedTime: string;
  resolved: boolean;
  deleted?: boolean;
  quotedFileContent?: {
    mimeType: string;
    value: string;
  };
  anchor?: string;
  replies?: Array<{
    id: string;
    content: string;
    author: {
      displayName: string;
      emailAddress: string;
    };
    createdTime: string;
    modifiedTime: string;
    deleted?: boolean;
  }>;
}

interface DocTab {
  tabProperties: {
    tabId: string;
    title: string;
    parentTabId?: string;
    index: number;
  };
  childTabs?: DocTab[];
  documentTab?: { body: { content: StructuralElement[] } };
}

interface StructuralElement {
  paragraph?: {
    elements: Array<{ textRun?: { content: string } }>;
  };
  table?: {
    tableRows: Array<{
      tableCells: Array<{ content: StructuralElement[] }>;
    }>;
  };
  sectionBreak?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function sanitizeText(s: string): string {
  return s.replace(/\x00/g, "").replace(/\\u0000/g, "");
}

function extractText(elements: StructuralElement[]): string {
  let text = "";
  for (const el of elements) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements) {
        if (pe.textRun?.content) text += sanitizeText(pe.textRun.content);
      }
    }
    if (el.table) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells) {
          text += extractText(cell.content);
        }
      }
    }
  }
  return text;
}

function extractTabsText(
  tabs: DocTab[],
): Array<{ tabId: string; title: string; text: string }> {
  const results: Array<{ tabId: string; title: string; text: string }> = [];
  for (const tab of tabs) {
    if (tab.documentTab?.body?.content) {
      results.push({
        tabId: tab.tabProperties.tabId,
        title: tab.tabProperties.title,
        text: extractText(tab.documentTab.body.content),
      });
    }
    if (tab.childTabs) {
      results.push(...extractTabsText(tab.childTabs));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Actor identity cache: in-memory L1 (10-min TTL) over the persistent
// google_actor_identities table. Negative and partial results are cached
// too - People API visibility is per-requester, so some actors never gain
// an email and must not be re-fetched every cycle.
// ---------------------------------------------------------------------------

export interface ResolvedActorIdentity {
  email: string | null;
  name: string | null;
}

interface CachedActor extends ResolvedActorIdentity {
  expiresAt: number;
}

const actorCache = new Map<string, CachedActor>();

function sweepExpiredActors(): void {
  const now = Date.now();
  for (const [key, entry] of actorCache) {
    if (entry.expiresAt <= now) {
      actorCache.delete(key);
    }
  }
}

/** Backoff for partial/unresolved identities: 1h, 4h, 16h, 64h, capped at 7d. */
function actorRetryDelayMs(attemptCount: number): number {
  const hours = Math.min(Math.pow(4, Math.max(0, attemptCount - 1)), 168);
  return hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// gFetch - authenticated fetch with single 429 retry
// ---------------------------------------------------------------------------

// SOURCE-LANE PATCH (coordinator): per-user quota errors (`userRateLimitExceeded`) cool down only the credential
// that hit them (`google-workspace:cred:<sha256(token) prefix>`), so one mailbox's 429 no longer stalls every
// tenant's poll in the process. Project-wide limits (429 / rateLimitExceeded / quotaExceeded) keep the donor's
// process-wide `google-workspace` cooldown. The token itself is never used as a key or logged.
export function credentialCooldownKey(accessToken: string): string {
  return `google-workspace:cred:${createHash("sha256").update(accessToken).digest("hex").slice(0, 16)}`;
}

export async function gFetch(
  url: string,
  accessToken: string,
  options?: RequestInit,
): Promise<Response> {
  throwIfGoogleRateLimited("google-workspace");
  throwIfGoogleRateLimited(credentialCooldownKey(accessToken));
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...options?.headers,
  };
  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.clone().json();
    } catch {
      data = null;
    }
    const perUser = res.status === 403 && googleErrorReasonFromPayload(data) === "userRateLimitExceeded";
    const rateLimit = googleRateLimitErrorFromResponse(perUser ? credentialCooldownKey(accessToken) : "google-workspace", res, data, 30);
    if (rateLimit) {
      console.log(`Google API rate limited, pausing ${rateLimit.retryAfterSeconds}s`);
      throw rateLimit;
    }
  }

  return res;
}

// ---------------------------------------------------------------------------
// Drive: changes.list with pagination
// ---------------------------------------------------------------------------

export async function pollDriveChanges(
  accessToken: string,
  pageToken: string,
): Promise<{ changes: DriveChange[]; newPageToken: string }> {
  const allChanges: DriveChange[] = [];
  let currentToken = pageToken;
  let pageCount = 0;

  while (pageCount < MAX_CHANGE_PAGES) {
    const url = new URL(`${DRIVE_API}/changes`);
    url.searchParams.set("pageToken", currentToken);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set(
      "fields",
      "nextPageToken,newStartPageToken,changes(fileId,removed,file(name,mimeType,modifiedTime,md5Checksum,headRevisionId,lastModifyingUser(displayName,emailAddress),owners(displayName,emailAddress),trashed,parents))",
    );
    url.searchParams.set("includeRemoved", "true");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    const res = await gFetch(url.toString(), accessToken);
    if (!res.ok) throw new Error(`Drive changes.list failed (${res.status})`);

    const data = (await res.json()) as {
      changes: DriveChange[];
      nextPageToken?: string;
      newStartPageToken?: string;
    };

    allChanges.push(...(data.changes ?? []));
    pageCount++;

    if (data.nextPageToken) {
      currentToken = data.nextPageToken;
    } else {
      return {
        changes: allChanges,
        newPageToken: data.newStartPageToken ?? currentToken,
      };
    }
  }

  console.warn(
    `Drive changes hit ${MAX_CHANGE_PAGES} page limit, will continue next cycle`,
  );
  return { changes: allChanges, newPageToken: currentToken };
}

// ---------------------------------------------------------------------------
// Drive: files.get?alt=media (binary download)
// ---------------------------------------------------------------------------

export async function downloadDriveFile(
  accessToken: string,
  fileId: string,
): Promise<Buffer> {
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await gFetch(url.toString(), accessToken);
  if (!res.ok) throw new Error(`Drive files.get media failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Drive: changes/startPageToken
// ---------------------------------------------------------------------------

export async function getStartPageToken(
  accessToken: string,
): Promise<string> {
  const url = new URL(`${DRIVE_API}/changes/startPageToken`);
  url.searchParams.set("supportsAllDrives", "true");
  const res = await gFetch(url.toString(), accessToken);
  if (!res.ok)
    throw new Error(`Drive startPageToken failed (${res.status})`);
  const data = (await res.json()) as { startPageToken: string };
  return data.startPageToken;
}

// ---------------------------------------------------------------------------
// Drive: drives.list (shared-drive enumeration for scoped discovery)
// ---------------------------------------------------------------------------

export interface SharedDrive {
  id: string;
  name: string;
}

export async function listSharedDrives(accessToken: string): Promise<SharedDrive[]> {
  const drives: SharedDrive[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${DRIVE_API}/drives`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields", "nextPageToken,drives(id,name)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await gFetch(url.toString(), accessToken);
    if (!res.ok) throw new Error(`Drive drives.list failed (${res.status})`);

    const data = (await res.json()) as { drives?: SharedDrive[]; nextPageToken?: string };
    drives.push(...(data.drives ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return drives;
}

// ---------------------------------------------------------------------------
// Drive: files.list (scoped discovery - folder, query, or per-drive)
// ---------------------------------------------------------------------------

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  /** Absent for shared-drive files (they have no owner). */
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  parents?: string[];
  trashed: boolean;
}

/**
 * One page of files.list. `driveId` narrows to a single shared drive with
 * `corpora=drive` (Google's recommended per-drive form - `corpora=allDrives`
 * is documented as potentially incomplete and is only kept for the broad
 * backfill); without it the listing spans My Drive + all shared drives.
 */
export async function listWorkspaceFiles(
  accessToken: string,
  opts: { q: string; driveId?: string; pageToken?: string },
): Promise<{ files: DriveFileSummary[]; nextPageToken?: string }> {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("q", opts.q);
  url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,lastModifyingUser,owners(displayName,emailAddress),trashed,parents)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (opts.driveId) {
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", opts.driveId);
  } else {
    url.searchParams.set("corpora", "allDrives");
  }
  if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);

  const res = await gFetch(url.toString(), accessToken);
  if (!res.ok) throw new Error(`Drive files.list failed (${res.status})`);

  const data = (await res.json()) as { files?: DriveFileSummary[]; nextPageToken?: string };
  return { files: data.files ?? [], nextPageToken: data.nextPageToken };
}

export async function getDriveFileParents(accessToken: string, fileId: string): Promise<string[] | null> {
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set("fields", "id,parents");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await gFetch(url.toString(), accessToken);
  if (!res.ok) return null;

  const data = (await res.json()) as { parents?: string[] };
  return Array.isArray(data.parents) ? data.parents : [];
}

// ---------------------------------------------------------------------------
// Activity API: query (global or per-item, with pagination)
// ---------------------------------------------------------------------------

export async function queryActivity(
  accessToken: string,
  options: {
    filter?: string;
    ancestorName?: string;
    itemName?: string;
    since?: string;
    pageSize?: number;
  },
): Promise<DriveActivityAction[]> {
  const allActivities: DriveActivityAction[] = [];
  let pageToken: string | undefined;

  do {
    const body: Record<string, unknown> = {
      pageSize: options.pageSize ?? 50,
    };

    // Build the single concatenated filter string
    // "time >= ..." and action filter are space-separated (implicit AND)
    let filter = "";
    if (options.since) {
      filter = `time >= "${options.since}"`;
    }
    if (options.filter) {
      filter = filter
        ? `${filter} ${options.filter}`
        : options.filter;
    }
    if (filter) {
      body.filter = filter;
    }

    if (options.ancestorName) {
      body.ancestorName = options.ancestorName;
    }
    if (options.itemName) {
      body.itemName = options.itemName;
    }
    if (pageToken) {
      body.pageToken = pageToken;
    }

    const res = await gFetch(ACTIVITY_API, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) return allActivities;

    const data = (await res.json()) as {
      activities?: DriveActivityAction[];
      nextPageToken?: string;
    };
    allActivities.push(...(data.activities ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allActivities;
}

// ---------------------------------------------------------------------------
// Drive: comments.get (single comment by ID, includeDeleted=true)
// ---------------------------------------------------------------------------

export async function getComment(
  accessToken: string,
  fileId: string,
  commentId: string,
): Promise<DriveComment | null> {
  const url = new URL(
    `${DRIVE_API}/files/${fileId}/comments/${commentId}`,
  );
  url.searchParams.set("includeDeleted", "true");
  url.searchParams.set(
    "fields",
    "id,content,author,createdTime,modifiedTime,resolved,deleted,quotedFileContent,anchor,replies(id,content,author,createdTime,modifiedTime,deleted)",
  );

  const res = await gFetch(url.toString(), accessToken);
  if (!res.ok) return null;
  return (await res.json()) as DriveComment;
}

// ---------------------------------------------------------------------------
// Drive: comments.list (paginated, for backfill)
// ---------------------------------------------------------------------------

export async function getFileComments(
  accessToken: string,
  fileId: string,
  since?: string,
): Promise<DriveComment[]> {
  const allComments: DriveComment[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${DRIVE_API}/files/${fileId}/comments`);
    url.searchParams.set(
      "fields",
      "nextPageToken,comments(id,content,author,createdTime,modifiedTime,resolved,deleted,quotedFileContent,anchor,replies(id,content,author,createdTime,modifiedTime,deleted))",
    );
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("includeDeleted", "true");
    if (since) url.searchParams.set("startModifiedTime", since);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await gFetch(url.toString(), accessToken);
    if (!res.ok) return allComments;

    const data = (await res.json()) as {
      comments?: DriveComment[];
      nextPageToken?: string;
    };
    allComments.push(...(data.comments ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allComments;
}

// ---------------------------------------------------------------------------
// Drive: files.get (file metadata)
// ---------------------------------------------------------------------------

export async function getFileMetadata(
  accessToken: string,
  fileId: string,
): Promise<{
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  lastModifyingUser?: { displayName: string; emailAddress: string };
} | null> {
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set(
    "fields",
    "id,name,mimeType,modifiedTime,lastModifyingUser(displayName,emailAddress)",
  );
  url.searchParams.set("supportsAllDrives", "true");

  const res = await gFetch(url.toString(), accessToken);
  if (!res.ok) return null;

  return (await res.json()) as {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    lastModifyingUser?: { displayName: string; emailAddress: string };
  };
}

// ---------------------------------------------------------------------------
// Docs API: documents.get with tabs
// ---------------------------------------------------------------------------

export async function getDocContent(
  accessToken: string,
  docId: string,
): Promise<{
  title: string;
  tabs: Array<{ tabId: string; title: string; text: string }>;
  fullText: string;
}> {
  const url = new URL(`${DOCS_API}/${docId}`);
  url.searchParams.set("includeTabsContent", "true");

  const res = await gFetch(url.toString(), accessToken);
  if (!res.ok) throw new Error(`Docs get failed (${res.status})`);

  const doc = (await res.json()) as {
    title: string;
    tabs?: DocTab[];
  };
  const tabs = doc.tabs ? extractTabsText(doc.tabs) : [];
  const fullText = tabs.map((t) => t.text).join("\n\n");

  return { title: doc.title, tabs, fullText };
}

// ---------------------------------------------------------------------------
// People API: batch lookup with in-memory 10-min TTL cache
//
// Uses repeated query parameters for resourceNames:
//   ?resourceNames=people/123&resourceNames=people/456
// NOT comma-separated.
// ---------------------------------------------------------------------------

export async function resolveActorEmails(
  userId: string,
  accessToken: string,
  personNames: string[],
): Promise<Map<string, ResolvedActorIdentity>> {
  sweepExpiredActors();

  const result = new Map<string, ResolvedActorIdentity>();
  const uncached: string[] = [];

  // L1: in-memory cache (includes negative/partial entries)
  for (const pn of new Set(personNames)) {
    const cached = actorCache.get(`${userId}:${pn}`);
    if (cached && cached.expiresAt > Date.now()) {
      result.set(pn, { email: cached.email, name: cached.name });
    } else {
      uncached.push(pn);
    }
  }

  if (uncached.length === 0) return result;

  // L2: persistent identity table. Resolved rows are used as-is; partial /
  // unresolved rows are used too unless their retry backoff has elapsed.
  const { db } = await import("../../db/client.js");
  const { googleActorIdentities } = await import("../../db/schema.js");
  const { and, eq, inArray } = await import("drizzle-orm");

  const now = new Date();
  const toFetch: string[] = [];
  const attemptsByPerson = new Map<string, number>();
  try {
    const rows = await db
      .select()
      .from(googleActorIdentities)
      .where(and(eq(googleActorIdentities.userId, userId), inArray(googleActorIdentities.personId, uncached)));
    const rowsByPerson = new Map(rows.map((r) => [r.personId, r]));
    for (const pn of uncached) {
      const row = rowsByPerson.get(pn);
      if (!row) {
        toFetch.push(pn);
        continue;
      }
      attemptsByPerson.set(pn, row.attemptCount);
      const retryDue = row.status !== "resolved" && (!row.nextRetryAt || row.nextRetryAt <= now);
      if (retryDue) {
        toFetch.push(pn);
        continue;
      }
      const identity: ResolvedActorIdentity = { email: row.email, name: row.displayName };
      actorCache.set(`${userId}:${pn}`, { ...identity, expiresAt: Date.now() + ACTOR_CACHE_TTL_MS });
      result.set(pn, identity);
    }
  } catch (err) {
    // Identity table unavailable - fall back to fetching everything uncached.
    console.error("[gdocs] actor identity table read failed:", err instanceof Error ? err.message : err);
    toFetch.push(...uncached.filter((pn) => !toFetch.includes(pn)));
  }

  for (let i = 0; i < toFetch.length; i += PEOPLE_BATCH_SIZE) {
    const batch = toFetch.slice(i, i + PEOPLE_BATCH_SIZE);

    const url = new URL(`${PEOPLE_API}/people:batchGet`);
    for (const rn of batch) {
      url.searchParams.append("resourceNames", rn);
    }
    url.searchParams.set("personFields", "emailAddresses,names");

    const res = await gFetch(url.toString(), accessToken);
    if (!res.ok) {
      // Transient failure: skip without recording negative rows, so the next
      // cycle retries immediately.
      console.error(
        `People API batchGet failed (${res.status}), skipping batch`,
      );
      continue;
    }

    const data = (await res.json()) as {
      responses?: Array<{
        requestedResourceName?: string;
        person?: {
          resourceName?: string;
          emailAddresses?: Array<{ value: string }>;
          names?: Array<{ displayName: string }>;
        };
        httpStatusCode?: number;
      }>;
    };

    const responsesByName = new Map(
      (data.responses ?? [])
        .filter((entry) => entry.requestedResourceName)
        .map((entry) => [entry.requestedResourceName as string, entry]),
    );

    for (const pn of batch) {
      const entry = responsesByName.get(pn);
      const email = entry?.person?.emailAddresses?.[0]?.value || null;
      const name = entry?.person?.names?.[0]?.displayName || email;
      const status = email ? "resolved" : name ? "partial" : "unresolved";
      const identity: ResolvedActorIdentity = { email, name };

      actorCache.set(`${userId}:${pn}`, { ...identity, expiresAt: Date.now() + ACTOR_CACHE_TTL_MS });
      result.set(pn, identity);

      const attemptCount = (attemptsByPerson.get(pn) ?? 0) + 1;
      const nextRetryAt = status === "resolved" ? null : new Date(Date.now() + actorRetryDelayMs(attemptCount));
      try {
        await db
          .insert(googleActorIdentities)
          .values({
            userId,
            personId: pn,
            email,
            displayName: name,
            status,
            attemptCount,
            nextRetryAt,
            resolvedAt: email ? now : null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [googleActorIdentities.userId, googleActorIdentities.personId],
            set: {
              email,
              displayName: name,
              status,
              attemptCount,
              nextRetryAt,
              resolvedAt: email ? now : null,
              updatedAt: now,
            },
          });
      } catch (err) {
        console.error("[gdocs] actor identity table write failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  return result;
}
