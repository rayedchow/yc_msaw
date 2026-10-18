/**
 * Current Google Docs content for a roster mailbox that may only VIEW a Doc (reader or commenter).
 *
 * The shared Doc unit (`sources/google-docs/<slug>-doc-<hash>/`) is captured once per tenant, under the tenant's
 * default credential (content) and the checkpoint mailbox (Drive metadata, OT history). It holds writer-only
 * material: revision history and the OT changelog ("Access historical revisions" is writer+ in Drive's role table),
 * the permission list ("detailed file permissions", writer+), and SUGGESTIONS_INLINE content (403 for anyone not
 * allowed to see suggestions). Owner-only reads therefore serve it only to owners of a mailbox with
 * `capabilities.canReadRevisions` (providers/google-auth/attribution.ts).
 *
 * A mailbox that sees the Doc WITHOUT that capability still has a legitimate read of the current document: Drive
 * grants "Read the content of the file" to every role. That view is captured here, separately, under THAT mailbox's
 * own credential (getGoogleApiCredential(tenant, mailbox): its OAuth grant, its DWD impersonation, or its Composio
 * proxy; the collection mode is never changed), so nothing in it can derive from another account's access:
 *
 *   sources/google-docs/_accounts/<mailbox>/<doc-dir>/
 *     native/document.json          documents.get as that account with DEFAULT_FOR_CURRENT_ACCESS (Google applies
 *                                   PREVIEW_WITHOUT_SUGGESTIONS to view-only access, SUGGESTIONS_INLINE otherwise),
 *                                   redacted like the shared copy
 *     native/tabs/<tabId>.json      each native tab
 *     tabs/<tabId>.md               the donor markdown projection (parseDocContent, same renderer)
 *     tabs/<tabId>.suggestions.json pending suggestions, only when Google returned them to that account
 *     images/<objectId>.<ext>|.json image bytes fetched through that account's own requester-tagged contentUri
 *     drive.json                    files.get as that account (its capabilities, the permissions Google shows it)
 *     history/snapshot-diffs/...    diff against THIS account's previous capture only (never the shared baseline)
 *     capture.json                  what was captured, which view Google applied, and what is not part of it
 *
 *     comments.json                 Drive comments.list as that account, only when Google returns comments to it
 *
 * Sheets, Slides, other Drive files and Drive PDFs the mailbox may only view get the same treatment
 * (account-files.ts): `_accounts/<mailbox>/_drive/<sheets|slides|files|pdf>/<file>/`.
 *
 * Never written here: OT changelog, revisions, sessions, suggestion cards, the shared comment ledger (read under other
 * credentials), or anything to the donor's shared tables (google_doc_tab_snapshots, google_doc_images, mirror), so
 * baselines and diffs never mix accounts.
 *
 * Fail closed: only an explicit `canReadRevisions === false` from that mailbox's own Drive view starts a capture;
 * a 403/404 under the account's credential retires its copy (no fallback to any shared copy); a file whose
 * copy/download is disabled for this account (`copyRequiresWriterPermission`, `canCopy`/`canDownload` false, or an
 * effective download restriction for readers) keeps only its metadata and comments, no content, and is reported
 * `blocked`; a mailbox that gains revisions is served the full unit instead and its copy is retired
 * (`superseded_by_full_unit`). Retired copies keep their history (captured under that
 * account's own authority); the consumer serves `_accounts/<mailbox>/` only to the verified owner of that mailbox.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { collectImageRefs, type FetchedDocImage } from "../../../integrations/google/gdocs/images.js";
import { parseDocContent, type DocContent } from "../../../integrations/google/gdocs/content.js";
import { GoogleRateLimitError, googleRateLimitErrorFromResponse, throwIfGoogleRateLimited } from "../../../vault/google-rate-limit.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import { encodeSegment } from "../../export/mapping.js";
import { retryDelaySeconds } from "./checkpoints.js";
import { flattenNativeTabs } from "./doc-export.js";
import { DRIVE_FIELDS, driveFileClass, GOOGLE_DOC_MIME, GOOGLE_FOLDER_MIME, GOOGLE_SHEET_MIME, GOOGLE_SHORTCUT_MIME, GOOGLE_SLIDES_MIME, PDF_MIME, sanitizeDriveMetadata } from "./drive-export.js";
import { accountFileDirectory, accountFilePaths, captureAccountFileContent, retireStaleAccountContent, type AccountFileClass } from "./account-files.js";
import { cooldownKeyFor, googleErrorReason, googleFetch, quotaUserFor, type FetchImpl } from "./google-fetch.js";
import { docDirectory, docPaths, extensionForMime } from "./paths.js";
import { buildSnapshotDiffEvent, type DocSnapshotState } from "./snapshot-diff.js";
import {
  deleteFileExports,
  deleteSourceFile,
  GOOGLE_DOCS_SOURCE_ROOT,
  jsonBytes,
  listLiveHeads,
  moveFileExports,
  putSourceFile,
  readBlobBytes,
  resolveDb,
  rowsOf,
  safeSegment,
  type StoreDeps,
} from "./store.js";

export const ACCOUNT_SNAPSHOT_TASK = "gdocs.account-snapshot";
export const ACCOUNTS_ROOT = `${GOOGLE_DOCS_SOURCE_ROOT}/_accounts`;
export const ACCOUNT_CAPTURE_SCHEMA = "procmem.gdocs.account-capture/v1";

const DOCS_API = "https://docs.googleapis.com/v1/documents";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MAX_IMAGE_BYTES = Math.max(1, Math.floor(Number(process.env.GDOCS_IMAGE_MAX_BYTES ?? 50 * 1024 * 1024)));
const MAX_IMAGES_PER_DOC = Math.max(1, Math.floor(Number(process.env.GDOCS_IMAGE_MAX_PER_DOC ?? 1000)));

export type AccountCaptureState = "pending" | "complete" | "partial" | "blocked" | "error" | "superseded" | "retired";

/** What an account view never contains, stated in every capture.json and coverage report. */
export const ACCOUNT_VIEW_EXCLUDES = [
  { artifact: "history/changelog, operations, sessions, revision chunks", reason: "writer_role_required: Drive grants 'Access historical revisions' to writer+ only" },
  { artifact: "older revisions of the shared doc and its snapshot diffs", reason: "writer_role_required: captured under another credential" },
  { artifact: "suggestion cards and the shared comment ledger", reason: "not_captured_for_account_view: read under another credential (this account's own comments.list is in comments.json)" },
  { artifact: "detailed permissions", reason: "writer_role_required: only what Google returns to this account is in drive.json" },
] as const;

export function accountRoot(mailbox: string): string {
  return `${ACCOUNTS_ROOT}/${encodeSegment(mailbox.trim().toLowerCase())}`;
}

/** `sources/google-docs/_accounts/<mailbox>/<same basename as the shared doc directory>`. */
export function accountDocDirectory(mailbox: string, docId: string, title: string | null | undefined): string {
  const shared = docDirectory(docId, title);
  return `${accountRoot(mailbox)}/${shared.slice(shared.lastIndexOf("/") + 1)}`;
}

export function accountDocPaths(dir: string) {
  const base = docPaths(dir);
  return {
    drive: base.drive,
    nativeDocument: base.nativeDocument,
    nativeTabsDir: base.nativeTabsDir,
    nativeTab: base.nativeTab,
    imagesDir: base.imagesDir,
    imageBytes: base.imageBytes,
    imageMeta: base.imageMeta,
    tabsDir: `${dir}/tabs`,
    tabText: (tabId: string) => `${dir}/tabs/${safeSegment(tabId, "tab")}.md`,
    tabSuggestions: (tabId: string) => `${dir}/tabs/${safeSegment(tabId, "tab")}.suggestions.json`,
    snapshotDiff: base.snapshotDiff,
    comments: `${dir}/comments.json`,
    capture: `${dir}/capture.json`,
  };
}

export type AccountViewClass = "doc" | AccountFileClass;

/** Which account view a Drive mime type gets: every type the shared lanes export (Docs, `_drive`, drive-pdf); none for folders/shortcuts. */
export function accountViewClass(mimeType: string | null | undefined): AccountViewClass | null {
  if (!mimeType || mimeType === GOOGLE_FOLDER_MIME || mimeType === GOOGLE_SHORTCUT_MIME) return null;
  if (mimeType === GOOGLE_DOC_MIME) return "doc";
  if (mimeType === PDF_MIME) return "pdf";
  return driveFileClass(mimeType);
}

/** The Docs editors whose comments the donor comment lane captures; first captures read their comments as the account. */
const COMMENTED_EDITOR_MIMES = new Set([GOOGLE_DOC_MIME, GOOGLE_SHEET_MIME, GOOGLE_SLIDES_MIME]);

/** files.get as the account: the shared field list plus what decides this account's own read (comment, download restrictions). */
export const ACCOUNT_DRIVE_FIELDS = `${DRIVE_FIELDS.replace("capabilities(canDownload,canReadRevisions,canCopy)", "capabilities(canDownload,canReadRevisions,canCopy,canComment)")},downloadRestrictions`;

/** Download/copy disabled for this account (it may only read or comment, so reader restrictions apply to it). */
export function downloadRestrictedReason(file: {
  copyRequiresWriterPermission?: boolean;
  capabilities?: { canDownload?: boolean; canCopy?: boolean };
  downloadRestrictions?: { effectiveDownloadRestrictionWithContext?: { restrictedForReaders?: boolean; restrictedForWriters?: boolean } };
}): string | null {
  const caps = file.capabilities ?? {};
  const effective = file.downloadRestrictions?.effectiveDownloadRestrictionWithContext;
  if (file.copyRequiresWriterPermission === true || caps.canCopy === false || caps.canDownload === false
    || effective?.restrictedForReaders === true || effective?.restrictedForWriters === true) return "copy_restricted_for_account";
  return null;
}

// ---------------------------------------------------------------------------
// State (gdocs_account_captures, migration 9104)
// ---------------------------------------------------------------------------

export interface AccountCaptureRow {
  fileId: string;
  mailbox: string;
  state: AccountCaptureState;
  reason: string | null;
  driveVersion: string | null;
  capturedVersion: string | null;
  revisionId: string | null;
  exportDirectory: string | null;
  viewMode: string | null;
  retryAt: string | null;
  attempts: number;
  mimeType: string | null;
  commentsState: string | null;
  commentsDue: boolean;
  commentsCapturedAt: string | null;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toRow(r: Record<string, unknown>): AccountCaptureRow {
  return {
    fileId: String(r.file_id),
    mailbox: String(r.mailbox),
    state: r.state as AccountCaptureState,
    reason: (r.reason as string | null) ?? null,
    driveVersion: (r.drive_version as string | null) ?? null,
    capturedVersion: (r.captured_version as string | null) ?? null,
    revisionId: (r.revision_id as string | null) ?? null,
    exportDirectory: (r.export_directory as string | null) ?? null,
    viewMode: (r.view_mode as string | null) ?? null,
    retryAt: iso(r.retry_at),
    attempts: Number(r.attempts ?? 0),
    mimeType: (r.mime_type as string | null) ?? null,
    commentsState: (r.comments_state as string | null) ?? null,
    commentsDue: r.comments_due === true,
    commentsCapturedAt: iso(r.comments_captured_at),
  };
}

export async function getAccountCapture(tenantId: string, fileId: string, mailbox: string, deps?: StoreDeps): Promise<AccountCaptureRow | null> {
  const db = await resolveDb(deps);
  const [row] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_account_captures WHERE tenant_id = ${tenantId} AND file_id = ${fileId} AND mailbox = ${mailbox.toLowerCase()}
  `));
  return row ? toRow(row) : null;
}

async function setAccountState(
  tenantId: string,
  fileId: string,
  mailbox: string,
  update: {
    state: AccountCaptureState; reason?: string | null; capturedVersion?: string | null; revisionId?: string | null; exportDirectory?: string | null;
    viewMode?: string | null; retryAt?: Date | null; mimeType?: string | null;
    /** The comments of this account were (re)read in this attempt: clears comments_due. */
    comments?: { state: string; reason: string | null };
  },
  deps?: StoreDeps,
): Promise<void> {
  const db = await resolveDb(deps);
  const done = update.state === "complete" || update.state === "partial";
  const c = update.comments ?? null;
  // A comments read that failed transiently (error) stays due; any settled answer (complete/partial/not_visible) clears it.
  const commentsSettled = c !== null && c.state !== "error";
  await db.execute(sql`
    INSERT INTO gdocs_account_captures (tenant_id, file_id, mailbox, state, reason, captured_version, revision_id, export_directory,
      view_mode, retry_at, attempts, captured_at, mime_type, comments_state, comments_reason, comments_due, comments_captured_at, updated_at)
    VALUES (${tenantId}, ${fileId}, ${mailbox.toLowerCase()}, ${update.state}, ${update.reason ?? null}, ${update.capturedVersion ?? null},
      ${update.revisionId ?? null}, ${update.exportDirectory ?? null}, ${update.viewMode ?? null},
      ${update.retryAt ? update.retryAt.toISOString() : null}::timestamptz, ${done ? 0 : 1}, ${done ? new Date().toISOString() : null}::timestamptz,
      ${update.mimeType ?? null}, ${c?.state ?? null}, ${c?.reason ?? null}, ${c !== null && !commentsSettled},
      ${commentsSettled ? new Date().toISOString() : null}::timestamptz, now())
    ON CONFLICT (tenant_id, file_id, mailbox) DO UPDATE SET
      mime_type = COALESCE(EXCLUDED.mime_type, gdocs_account_captures.mime_type),
      comments_state = COALESCE(EXCLUDED.comments_state, gdocs_account_captures.comments_state),
      comments_reason = CASE WHEN ${c !== null}::boolean THEN EXCLUDED.comments_reason ELSE gdocs_account_captures.comments_reason END,
      comments_due = CASE WHEN ${commentsSettled}::boolean THEN false ELSE gdocs_account_captures.comments_due END,
      comments_captured_at = COALESCE(EXCLUDED.comments_captured_at, gdocs_account_captures.comments_captured_at),
      state = EXCLUDED.state,
      reason = EXCLUDED.reason,
      captured_version = COALESCE(EXCLUDED.captured_version, gdocs_account_captures.captured_version),
      revision_id = COALESCE(EXCLUDED.revision_id, gdocs_account_captures.revision_id),
      export_directory = COALESCE(EXCLUDED.export_directory, gdocs_account_captures.export_directory),
      view_mode = COALESCE(EXCLUDED.view_mode, gdocs_account_captures.view_mode),
      retry_at = EXCLUDED.retry_at,
      attempts = CASE WHEN ${done}::boolean THEN 0 ELSE gdocs_account_captures.attempts + 1 END,
      captured_at = COALESCE(EXCLUDED.captured_at, gdocs_account_captures.captured_at),
      updated_at = now()
  `);
}

/** Tombstone every live file of this account's copy of one Drive file (history stays, served to that owner only). */
export async function retireAccountCopy(
  tenantId: string,
  fileId: string,
  mailbox: string,
  state: "retired" | "superseded" | "blocked",
  reason: string,
  deps?: StoreDeps,
): Promise<number> {
  const removed = await deleteFileExports({ tenantId, fileId, reason, underDirectory: accountRoot(mailbox) }, deps);
  await setAccountState(tenantId, fileId, mailbox, { state, reason }, deps);
  return removed;
}

/** A mailbox lost the file (its own `removed` change): retire its copy, if it has one. Fail-soft. */
export async function retireAccountCopyIfAny(tenantId: string, fileId: string, mailbox: string, reason: string, deps?: StoreDeps): Promise<void> {
  try {
    const db = await resolveDb(deps);
    const rows = rowsOf<{ file_id: string }>(await db.execute(sql`
      UPDATE gdocs_account_captures SET state = 'retired', reason = ${reason}, retry_at = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND file_id = ${fileId} AND mailbox = ${mailbox.toLowerCase()} AND state <> 'retired'
      RETURNING file_id
    `));
    if (rows.length) await deleteFileExports({ tenantId, fileId, reason, underDirectory: accountRoot(mailbox) }, deps);
  } catch (err) {
    console.warn(`[gdocs-source] account copy retirement failed for ${fileId}:`, err instanceof Error ? err.message : err);
  }
}

/** Every account copy of a file (trash / tenant-wide removal: the shared retirement already tombstoned the files). */
export async function markAccountCapturesRetired(tenantId: string, fileId: string, reason: string, deps?: StoreDeps): Promise<void> {
  try {
    const db = await resolveDb(deps);
    await db.execute(sql`
      UPDATE gdocs_account_captures SET state = 'retired', reason = ${reason}, retry_at = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND file_id = ${fileId} AND state NOT IN ('retired', 'superseded')
    `);
  } catch (err) {
    console.warn(`[gdocs-source] account capture retirement failed for ${fileId}:`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Feed / inventory hook
// ---------------------------------------------------------------------------

export interface AccountViewChange {
  fileId: string;
  file?: { mimeType?: string; modifiedTime?: string; capabilities?: { canReadRevisions?: boolean } };
}

/**
 * Called for every live change a mailbox's own changes feed or inventory reports (lifecycle.recordLiveChange for
 * Docs/Sheets/Slides/Drive files, the drive-pdf intake for PDFs). `canReadRevisions === false`: record the version this
 * mailbox saw and, when it is new, enqueue a capture of that mailbox's current view. `true`: the full unit serves it,
 * so retire a copy it may have had. Absent: nothing (never captured on an unknown capability). Fail-soft (donor-test
 * mocks have no table).
 */
export async function noteAccountView(tenantId: string, change: AccountViewChange, mailbox: string | null, deps?: StoreDeps): Promise<void> {
  if (!mailbox || !change.file || !accountViewClass(change.file.mimeType)) return;
  const can = change.file.capabilities?.canReadRevisions;
  if (typeof can !== "boolean") return;
  const box = mailbox.toLowerCase();
  try {
    const db = await resolveDb(deps);
    if (can) {
      const rows = rowsOf<{ file_id: string }>(await db.execute(sql`
        UPDATE gdocs_account_captures SET state = 'superseded', reason = 'superseded_by_full_unit', retry_at = NULL, updated_at = now()
        WHERE tenant_id = ${tenantId} AND file_id = ${change.fileId} AND mailbox = ${box} AND state <> 'superseded'
        RETURNING file_id
      `));
      if (rows.length) await deleteFileExports({ tenantId, fileId: change.fileId, reason: "superseded_by_full_unit", underDirectory: accountRoot(box) }, deps);
      return;
    }
    const version = change.file.modifiedTime ?? null;
    const [row] = rowsOf<{ state: string; retry_at: unknown }>(await db.execute(sql`
      INSERT INTO gdocs_account_captures (tenant_id, file_id, mailbox, state, drive_version, mime_type, updated_at)
      VALUES (${tenantId}, ${change.fileId}, ${box}, 'pending', ${version}, ${change.file.mimeType ?? null}, now())
      ON CONFLICT (tenant_id, file_id, mailbox) DO UPDATE SET
        mime_type = COALESCE(EXCLUDED.mime_type, gdocs_account_captures.mime_type),
        state = CASE
          WHEN gdocs_account_captures.state IN ('retired', 'superseded')
            OR (EXCLUDED.drive_version IS DISTINCT FROM gdocs_account_captures.captured_version
                AND EXCLUDED.drive_version IS DISTINCT FROM gdocs_account_captures.drive_version)
          THEN 'pending' ELSE gdocs_account_captures.state END,
        retry_at = CASE
          WHEN gdocs_account_captures.state IN ('retired', 'superseded')
            OR (EXCLUDED.drive_version IS DISTINCT FROM gdocs_account_captures.captured_version
                AND EXCLUDED.drive_version IS DISTINCT FROM gdocs_account_captures.drive_version)
          THEN NULL ELSE gdocs_account_captures.retry_at END,
        drive_version = COALESCE(EXCLUDED.drive_version, gdocs_account_captures.drive_version),
        updated_at = now()
      RETURNING state, retry_at
    `));
    // A retry window still open (Retry-After / backoff) is left to the sweep.
    if (row?.state === "pending" && row.retry_at == null) await enqueueAccountSnapshot(tenantId, change.fileId, box, version);
  } catch (err) {
    console.warn(`[gdocs-source] account view bookkeeping failed for ${change.fileId}:`, err instanceof Error ? err.message : err);
  }
}

const MAX_COMMENT_TASKS_PER_SWEEP = Math.max(1, Math.floor(Number(process.env.GDOCS_ACCOUNT_COMMENT_TASKS_PER_SWEEP ?? 25)));

/**
 * The mailbox's own Drive Activity comment sweep (donor sweepCommentActivity, run with that mailbox's credential) saw
 * comment activity on these files: an account view it has gets its comments re-read as that account. Files it reads
 * in full (superseded), lost (retired) or never viewed are untouched. Fail-soft.
 */
export async function noteAccountCommentActivity(tenantId: string, mailbox: string | null, fileIds: readonly string[], deps?: StoreDeps): Promise<number> {
  const ids = [...new Set(fileIds.filter(Boolean))];
  if (!mailbox || ids.length === 0) return 0;
  const box = mailbox.toLowerCase();
  try {
    const db = await resolveDb(deps);
    const rows = rowsOf<{ file_id: string; retry_at: unknown; was_due: boolean }>(await db.execute(sql`
      UPDATE gdocs_account_captures a SET comments_due = true, updated_at = now()
      FROM (SELECT file_id, comments_due AS was_due FROM gdocs_account_captures
            WHERE tenant_id = ${tenantId} AND mailbox = ${box} AND file_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
              AND state NOT IN ('retired', 'superseded')) prev
      WHERE a.tenant_id = ${tenantId} AND a.mailbox = ${box} AND a.file_id = prev.file_id
      RETURNING a.file_id, a.retry_at, prev.was_due
    `));
    let enqueued = 0;
    for (const r of rows) {
      // Already due (a task is queued or the sweep has it) or inside a Retry-After/backoff window: the sweep runs it.
      // Like the donor's targeted-sync cap, a flood of comment activity enqueues a bounded number of tasks per sweep;
      // the rest stay due for the hourly source sweep (listDueAccountCaptures), so nothing is lost.
      if (!r.was_due && r.retry_at == null && enqueued < MAX_COMMENT_TASKS_PER_SWEEP) {
        enqueued++;
        await enqueueAccountSnapshot(tenantId, r.file_id, box, null);
      }
    }
    return rows.length;
  } catch (err) {
    console.warn(`[gdocs-source] account comment bookkeeping failed for ${mailbox}:`, err instanceof Error ? err.message : err);
    return 0;
  }
}

async function enqueueAccountSnapshot(tenantId: string, docId: string, mailbox: string, modifiedTime: string | null): Promise<void> {
  try {
    const { enqueueTask } = await import("../../../queue/queue.js");
    await enqueueTask({
      queue: "sync",
      tenantId,
      kind: ACCOUNT_SNAPSHOT_TASK,
      groupKey: `${tenantId}:gdocs`,
      payload: { userId: tenantId, docId, mailbox, modifiedTime },
      dedupeKey: `gdocs-account-snapshot:${tenantId}:${docId}:${mailbox}`,
      priority: -5,
    });
  } catch (err) {
    // The row stays `pending`; the hourly source sweep picks it up.
    console.warn(`[gdocs-source] failed to enqueue account snapshot for ${docId}:`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** One Google call as the account itself. Counts requests so callers (tests, perf) can see the cost. */
export interface AccountCaller {
  mode: "domain_wide_delegation" | "oauth_direct" | "composio_proxy";
  fetch(url: string): Promise<Response>;
}

export interface AccountSnapshotInput {
  tenantId: string;
  docId: string;
  mailbox: string;
  now?: Date;
  deps?: StoreDeps;
  /** Transport for bearer credentials and for image contentUris (tests inject fake Google HTTP). */
  fetchImpl?: FetchImpl;
}

export interface AccountSnapshotResult {
  state: AccountCaptureState | "skipped";
  reason: string | null;
  directory: string | null;
  /** Google API calls made as the account (files.get, documents.get); image byte fetches are counted separately. */
  apiCalls: number;
  imageFetches: number;
}

/** Resolve the account's own credential. Explicit mailbox only: never the tenant default, never another mailbox. */
async function accountCaller(tenantId: string, mailbox: string, fetchImpl?: FetchImpl): Promise<AccountCaller> {
  const { getGoogleApiCredential, fetchGoogleApi, GOOGLE_DOCS_DELEGATION_SCOPES } = await import("../../../vault/google-auth.js");
  const credential = await getGoogleApiCredential(tenantId, mailbox, GOOGLE_DOCS_DELEGATION_SCOPES);
  if (credential.account.trim().toLowerCase() !== mailbox) {
    throw new Error(`credential resolved to ${credential.account}, not ${mailbox}`);
  }
  if (credential.kind === "access_token") {
    return { mode: credential.mode, fetch: (url) => googleFetch({ tenantId, mailbox, accessToken: credential.accessToken, fetchImpl }, url) };
  }
  // Composio never hands out a bearer; the existing generic proxy seam carries the call as that connected account.
  const key = cooldownKeyFor({ tenantId, mailbox });
  return {
    mode: "composio_proxy",
    fetch: async (url) => {
      throwIfGoogleRateLimited("google-workspace");
      throwIfGoogleRateLimited(key);
      const res = await fetchGoogleApi(credential, url, { headers: { "X-Goog-Quota-User": quotaUserFor(tenantId, mailbox) } });
      if (!res.ok) {
        const data = await res.clone().json().catch(() => null);
        const limited = googleRateLimitErrorFromResponse(key, res, data, 30);
        if (limited) throw limited;
      }
      return res;
    },
  };
}

function credentialFailure(err: unknown): { state: "blocked" | "error"; reason: string } {
  const code = (err as { code?: unknown } | null)?.code;
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof code === "string" && ["insufficient_scope", "reauth_required", "dwd_not_approved", "not_configured"].includes(code)) return { state: "blocked", reason: `credential_${code}` };
  if (name === "GoogleDwdNotApprovedError") return { state: "blocked", reason: "credential_dwd_not_approved" };
  return { state: "error", reason: `credential_failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
}

async function visibilityOf(tenantId: string, fileId: string, mailbox: string, deps?: StoreDeps): Promise<{ visible: boolean; canReadRevisions: boolean | null } | null> {
  const db = await resolveDb(deps);
  const [row] = rowsOf<{ visible: boolean; can_read_revisions: boolean | null }>(await db.execute(sql`
    SELECT visible, can_read_revisions FROM gdocs_file_visibility WHERE tenant_id = ${tenantId} AND file_id = ${fileId} AND mailbox = ${mailbox}
  `));
  return row ? { visible: row.visible === true, canReadRevisions: row.can_read_revisions ?? null } : null;
}

async function recordObservedCapability(tenantId: string, fileId: string, mailbox: string, canReadRevisions: boolean, deps?: StoreDeps): Promise<void> {
  const db = await resolveDb(deps);
  await db.execute(sql`
    UPDATE gdocs_file_visibility SET can_read_revisions = ${canReadRevisions}
    WHERE tenant_id = ${tenantId} AND file_id = ${fileId} AND mailbox = ${mailbox}
  `);
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Image bytes through this account's own requester-tagged contentUris, inside their window. URIs are never kept. */
async function fetchAccountImages(raw: unknown, fetchImpl: FetchImpl): Promise<{ images: FetchedDocImage[]; failed: number; tooLarge: number; overCap: number; fetches: number }> {
  const out = { images: [] as FetchedDocImage[], failed: 0, tooLarge: 0, overCap: 0, fetches: 0 };
  for (const ref of collectImageRefs(raw)) {
    if (out.fetches >= MAX_IMAGES_PER_DOC) {
      out.overCap++;
      continue;
    }
    out.fetches++;
    try {
      const res = await fetchImpl(ref.contentUri);
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        out.failed++;
        continue;
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        await res.body?.cancel().catch(() => {});
        out.tooLarge++;
        continue;
      }
      const bytes = await readBodyCapped(res, MAX_IMAGE_BYTES);
      if (!bytes) {
        out.tooLarge++;
        continue;
      }
      out.images.push({
        objectId: ref.objectId, kind: ref.kind, altText: ref.altText, mimeType: res.headers.get("content-type"),
        sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength, bytes,
      });
    } catch {
      out.failed++;
    }
  }
  return out;
}

function revisionIdOf(doc: DocContent): string {
  const raw = doc.raw as { revisionId?: unknown } | null;
  if (raw && typeof raw.revisionId === "string" && raw.revisionId) return raw.revisionId;
  return `content:${createHash("sha256").update(doc.tabs.map((t) => `${t.tabId}\u0000${t.contentHash}`).join("\u0001")).digest("hex").slice(0, 16)}`;
}

function stateOf(doc: DocContent, revisionId: string, capturedAt: string, sourceUpdatedAt: string | null): DocSnapshotState {
  return {
    revisionId,
    capturedAt,
    sourceUpdatedAt,
    title: doc.title,
    tabs: doc.tabs.map((t) => ({ tabId: t.tabId, tabName: t.tabName, parentTabId: t.parentTabId, content: t.content, contentSha: t.contentHash })),
  };
}

/** This account's previous capture, from its own stored native/document.json (never the shared tab-snapshot rows). */
async function previousAccountState(tenantId: string, path: string, deps?: StoreDeps): Promise<DocSnapshotState | null> {
  const db = await resolveDb(deps);
  const [row] = rowsOf<{ chunks: string[] | string; captured_at: unknown; source_updated_at: unknown }>(await db.execute(sql`
    SELECT v.chunks, v.captured_at, v.source_updated_at FROM gdocs_source_file_heads h
    JOIN gdocs_source_file_versions v ON v.tenant_id = h.tenant_id AND v.path = h.path AND v.seq = h.seq
    WHERE h.tenant_id = ${tenantId} AND h.path = ${path} AND h.op = 'put'
  `));
  if (!row) return null;
  const chunks = typeof row.chunks === "string" ? JSON.parse(row.chunks) as string[] : row.chunks;
  const raw = JSON.parse((await readBlobBytes(tenantId, chunks, deps)).toString("utf8")) as unknown;
  const doc = parseDocContent(raw);
  return stateOf(doc, revisionIdOf(doc), iso(row.captured_at) ?? new Date(0).toISOString(), iso(row.source_updated_at));
}

async function failed(
  input: AccountSnapshotInput,
  mailbox: string,
  attempts: number,
  outcome: { state: "pending" | "error"; reason: string; retryAfterSeconds?: number | null },
  calls: { apiCalls: number; imageFetches: number },
): Promise<AccountSnapshotResult> {
  const retryAt = new Date((input.now ?? new Date()).getTime() + retryDelaySeconds(attempts, outcome.retryAfterSeconds ?? null) * 1000);
  await setAccountState(input.tenantId, input.docId, mailbox, { state: outcome.state, reason: outcome.reason, retryAt }, input.deps);
  return { state: outcome.state, reason: outcome.reason, directory: null, ...calls };
}

/** Comments Google returns to this account (Drive comments.list, the donor's comment field set). */
const COMMENT_FIELDS = "nextPageToken,comments(id,content,author,createdTime,modifiedTime,resolved,deleted,quotedFileContent,anchor,replies(id,content,author,createdTime,modifiedTime,deleted))";
const MAX_COMMENT_PAGES = Math.max(1, Math.floor(Number(process.env.GDOCS_ACCOUNT_COMMENT_MAX_PAGES ?? 50)));

interface AccountComments {
  state: "complete" | "partial" | "not_visible" | "error";
  reason: string | null;
  comments: unknown[] | null;
}

async function readAccountComments(fileId: string, call: (url: string) => Promise<Response>): Promise<AccountComments> {
  const comments: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/comments`);
    url.searchParams.set("fields", COMMENT_FIELDS);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("includeDeleted", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await call(url.toString());
    if (res.status === 403 || res.status === 404) {
      // Google does not show this account the file's comments: nothing of them is exported for it.
      const why = await googleErrorReason(res);
      return { state: "not_visible", reason: `comments.list_http_${res.status}${why ? `:${why}` : ""}`, comments: null };
    }
    if (!res.ok) {
      const why = await googleErrorReason(res);
      return { state: "error", reason: `comments.list_http_${res.status}${why ? `:${why}` : ""}`, comments: null };
    }
    const data = (await res.json()) as { comments?: unknown[]; nextPageToken?: string };
    comments.push(...(data.comments ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) return { state: "complete", reason: null, comments };
  }
  return { state: "partial", reason: `comments_over_page_cap:${MAX_COMMENT_PAGES}`, comments };
}

/** Write (or retire) comments.json of an account copy from one comments read; returns the bookkeeping to store. */
async function writeAccountComments(
  read: AccountComments,
  path: string,
  meta: { tenantId: string; fileId: string; account: string; sourceVersion: string; sourceUpdatedAt: string | null; capturedAt: Date; provenance: Record<string, unknown> },
  live: Set<string>,
  deps?: StoreDeps,
): Promise<{ state: string; reason: string | null }> {
  // comments change without a Drive version: order by capture time so a later read always supersedes an earlier one.
  const order = meta.capturedAt.getTime();
  if (read.comments) {
    live.add(path);
    await putSourceFile({
      tenantId: meta.tenantId, fileId: meta.fileId, path, kind: "raw", contentType: "application/json",
      sourceVersion: meta.sourceVersion, sourceOrder: order, sourceUpdatedAt: meta.sourceUpdatedAt, capturedAt: meta.capturedAt,
      bytes: jsonBytes(redactProviderPayload("google-docs", { fileId: meta.fileId, account: meta.account, complete: read.state === "complete", comments: read.comments })),
      provenance: { ...meta.provenance, api: "drive.comments.list includeDeleted=true", fields: COMMENT_FIELDS },
    }, deps);
  } else if (read.state === "not_visible") {
    await deleteSourceFile({ tenantId: meta.tenantId, fileId: meta.fileId, path, reason: "comments_not_visible_to_account", sourceOrder: order, capturedAt: meta.capturedAt }, deps);
  } else {
    // Transient failure: the previous comments.json (if any) stays the account's latest read.
    live.add(path);
  }
  return { state: read.state, reason: read.reason };
}

/**
 * Capture one mailbox's own current view of one Drive file it may only view: Docs (documents.get, as before),
 * Sheets/Slides/Drive files/PDFs (account-files.ts), plus the comments Google returns to it. Every call runs as that
 * mailbox; nothing here reads or writes another account's data.
 */
export async function captureAccountView(input: AccountSnapshotInput): Promise<AccountSnapshotResult> {
  const mailbox = input.mailbox.trim().toLowerCase();
  const { tenantId, docId, deps } = input;
  const calls = { apiCalls: 0, imageFetches: 0 };
  const skipped = (reason: string): AccountSnapshotResult => ({ state: "skipped", reason, directory: null, ...calls });
  const row = await getAccountCapture(tenantId, docId, mailbox, deps);

  // Authority comes from this mailbox's own Drive capability (changes feed / inventory), never from visibility alone.
  const vis = await visibilityOf(tenantId, docId, mailbox, deps);
  if (!vis?.visible) {
    if (row) await retireAccountCopy(tenantId, docId, mailbox, "retired", "access_lost", deps);
    return skipped("not_visible_to_account");
  }
  if (vis.canReadRevisions === true) {
    if (row && row.state !== "superseded") await retireAccountCopy(tenantId, docId, mailbox, "superseded", "superseded_by_full_unit", deps);
    return skipped("account_reads_full_unit");
  }
  if (vis.canReadRevisions !== false) return skipped("capability_not_observed");

  const { listGoogleMailboxes } = await import("../../../integrations/google/mailboxes.js");
  const roster = (await listGoogleMailboxes(tenantId, await resolveDb(deps) as never)).map((m) => m.toLowerCase());
  if (!roster.includes(mailbox)) {
    await setAccountState(tenantId, docId, mailbox, { state: "blocked", reason: "mailbox_not_in_roster" }, deps);
    return { state: "blocked", reason: "mailbox_not_in_roster", directory: null, ...calls };
  }

  let caller: AccountCaller;
  try {
    caller = await accountCaller(tenantId, mailbox, input.fetchImpl);
  } catch (err) {
    const f = credentialFailure(err);
    if (f.state === "blocked") {
      await setAccountState(tenantId, docId, mailbox, { state: "blocked", reason: f.reason }, deps);
      return { state: "blocked", reason: f.reason, directory: null, ...calls };
    }
    return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: f.reason }, calls);
  }
  const call = async (url: string) => {
    calls.apiCalls++;
    return caller.fetch(url);
  };
  const lostAccess = async (reason: string): Promise<AccountSnapshotResult> => {
    // Fail closed: what Google refuses this account is not exported for it, and no other copy stands in.
    await retireAccountCopy(tenantId, docId, mailbox, "blocked", reason, deps);
    return { state: "blocked", reason, directory: null, ...calls };
  };

  try {
    const metaUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(docId)}`);
    metaUrl.searchParams.set("fields", ACCOUNT_DRIVE_FIELDS);
    metaUrl.searchParams.set("supportsAllDrives", "true");
    const metaRes = await call(metaUrl.toString());
    if (metaRes.status === 403 || metaRes.status === 404) return lostAccess(`access_lost:files.get_http_${metaRes.status}`);
    if (!metaRes.ok) {
      const why = await googleErrorReason(metaRes);
      return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: `files.get_http_${metaRes.status}${why ? `:${why}` : ""}` }, calls);
    }
    const file = (await metaRes.json()) as Record<string, unknown> & {
      name?: string; mimeType?: string; modifiedTime?: string; trashed?: boolean; copyRequiresWriterPermission?: boolean;
      capabilities?: { canReadRevisions?: boolean; canDownload?: boolean; canCopy?: boolean; canComment?: boolean };
      downloadRestrictions?: { effectiveDownloadRestrictionWithContext?: { restrictedForReaders?: boolean; restrictedForWriters?: boolean } };
    };
    if (file.trashed) return skipped("trashed");
    const mimeType = typeof file.mimeType === "string" && file.mimeType ? file.mimeType : row?.mimeType ?? null;
    const viewClass = accountViewClass(mimeType);
    if (!viewClass) {
      if (row && row.state !== "retired") await retireAccountCopy(tenantId, docId, mailbox, "retired", `not_an_account_view_type:${mimeType}`, deps);
      return skipped("not_an_account_view_type");
    }
    const caps = file.capabilities ?? {};
    if (caps.canReadRevisions === true) {
      // Google now lets this account read revisions: the full unit is its read; retire the account copy.
      await recordObservedCapability(tenantId, docId, mailbox, true, deps);
      await retireAccountCopy(tenantId, docId, mailbox, "superseded", "superseded_by_full_unit", deps);
      return { state: "superseded", reason: "superseded_by_full_unit", directory: null, ...calls };
    }
    if (caps.canReadRevisions !== false) return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: "files.get_capability_missing" }, calls);

    const modifiedTime = typeof file.modifiedTime === "string" ? file.modifiedTime : null;
    const title = typeof file.name === "string" ? file.name : null;
    const root = accountRoot(mailbox);
    const directory = viewClass === "doc" ? accountDocDirectory(mailbox, docId, title) : accountFileDirectory(root, viewClass, docId, title);
    const restricted = downloadRestrictedReason(file);
    // First capture of an editor file reads its comments; afterwards the account's own comment activity re-reads them.
    const commentsDue = row?.commentsDue === true || row?.commentsState === "error"
      || (row?.commentsState == null && mimeType !== null && COMMENTED_EDITOR_MIMES.has(mimeType));
    const versionDone = row?.state === "complete" && modifiedTime !== null && row.capturedVersion === modifiedTime && row.exportDirectory === directory;
    const capturedAt = input.now ?? new Date();
    const order = modifiedTime && Number.isFinite(Date.parse(modifiedTime)) ? Date.parse(modifiedTime) : capturedAt.getTime();
    const provenanceBase = { account: mailbox, credentialMode: caller.mode, capture: "account_view: fetched under this account's own credential" };
    const commentsPath = `${directory}/comments.json`;
    const commentMeta = { tenantId, fileId: docId, account: mailbox, sourceVersion: modifiedTime ?? `captured:${capturedAt.toISOString()}`, sourceUpdatedAt: modifiedTime, capturedAt, provenance: provenanceBase };

    if (versionDone && !commentsDue) {
      // Already captured for this Drive version: 1 call (files.get).
      await setAccountState(tenantId, docId, mailbox, { state: "complete", reason: row.reason, capturedVersion: modifiedTime, mimeType }, deps);
      return { state: "complete", reason: "already_captured_for_version", directory, ...calls };
    }
    if (versionDone && commentsDue) {
      // Content unchanged, the account saw comment activity: files.get + comments.list only.
      const comments = await writeAccountComments(await readAccountComments(docId, call), commentsPath, commentMeta, new Set(), deps);
      await setAccountState(tenantId, docId, mailbox, { state: "complete", reason: row.reason, capturedVersion: modifiedTime, mimeType, comments }, deps);
      return { state: "complete", reason: comments.state === "error" ? `comments:${comments.reason}` : "comments_refreshed", directory, ...calls };
    }

    if (row?.exportDirectory && row.exportDirectory !== directory) {
      await moveFileExports({ tenantId, fileId: docId, fromDirectory: row.exportDirectory, toDirectory: directory, capturedAt }, deps);
    }
    const live = new Set<string>();
    const base = { tenantId, fileId: docId, sourceVersion: modifiedTime ?? `captured:${capturedAt.toISOString()}`, sourceOrder: order, sourceUpdatedAt: modifiedTime, capturedAt };
    const drivePath = `${directory}/drive.json`;

    let content: { state: AccountCaptureState; reasons: string[]; capture: Record<string, unknown>; revisionId: string | null; viewMode: string | null };
    if (restricted) {
      // The owner disabled copy/download for readers and commenters: the account may look, not keep a copy of the content.
      // Content of earlier, unrestricted captures (text, bytes, native JSON, diffs) is tombstoned; its versions stay this
      // account's own history.
      for (const head of await listLiveHeads(tenantId, docId, deps)) {
        if (!head.path.startsWith(`${directory}/`) || head.path === drivePath || head.path === commentsPath || head.path === `${directory}/capture.json`) continue;
        await deleteSourceFile({ ...base, path: head.path, reason: restricted }, deps);
      }
      content = { state: "blocked", reasons: [restricted], capture: { content: "not_exported: download/copy disabled for this account" }, revisionId: null, viewMode: null };
    } else if (viewClass === "doc") {
      content = await captureDocContent({ tenantId, docId, mailbox, directory, call, caller, input, base, live, modifiedTime, calls });
    } else {
      const r = await captureAccountFileContent({ tenantId, fileId: docId, mailbox, fileClass: viewClass, file, directory, call, provenance: provenanceBase, base, live, deps });
      if (r.state === "complete") await retireStaleAccountContent(tenantId, docId, directory, live, { sourceOrder: order, capturedAt, reason: "removed_from_source" }, deps);
      content = {
        state: r.state === "unsupported" ? "blocked" : r.state,
        reasons: r.reasons,
        capture: { exportMimeType: r.exportMimeType, method: r.method, unsupported: r.state === "unsupported" },
        revisionId: null,
        viewMode: null,
      };
    }

    // Metadata as this account, written once its content outcome is settled (a transient failure exports nothing new).
    live.add(drivePath);
    await putSourceFile({ ...base, path: drivePath, kind: "raw", contentType: "application/json", bytes: jsonBytes({ file: sanitizeDriveMetadata(file) }), provenance: {
      ...provenanceBase, api: "drive.files.get", note: "as this account: its capabilities and only the permissions Google returns to it; links dropped",
    } }, deps);

    let comments: { state: string; reason: string | null } | undefined;
    if (commentsDue) comments = await writeAccountComments(await readAccountComments(docId, call), commentsPath, commentMeta, live, deps);
    const reason = [...content.reasons, comments?.state === "error" ? `comments:${comments.reason}` : null].filter(Boolean).join(",") || null;

    const capturePath = `${directory}/capture.json`;
    await putSourceFile({ ...base, path: capturePath, kind: "projection", contentType: "application/json", bytes: jsonBytes({
      schema: ACCOUNT_CAPTURE_SCHEMA,
      fileId: docId,
      ...(viewClass === "doc" ? { docId } : {}),
      mimeType,
      account: mailbox,
      credentialMode: caller.mode,
      state: content.state,
      reason,
      modifiedTime,
      ...content.capture,
      capabilities: { canReadRevisions: false, canCopy: caps.canCopy ?? null, canDownload: caps.canDownload ?? null, canComment: caps.canComment ?? null },
      comments: { state: comments?.state ?? row?.commentsState ?? "not_read", note: "comments.list as this account; re-read when its own Drive Activity shows comment activity" },
      excludes: ACCOUNT_VIEW_EXCLUDES,
    }), provenance: provenanceBase }, deps);

    await setAccountState(tenantId, docId, mailbox, {
      state: content.state, reason, capturedVersion: content.state === "complete" || content.state === "partial" || content.state === "blocked" ? modifiedTime : null,
      revisionId: content.revisionId, exportDirectory: directory, viewMode: content.viewMode, mimeType, comments,
      retryAt: content.state === "partial" || content.state === "error"
        ? new Date(capturedAt.getTime() + retryDelaySeconds(row?.attempts ?? 0) * 1000)
        : null,
    }, deps);
    return { state: content.state, reason, directory, ...calls };
  } catch (err) {
    if (err instanceof AccountAccessLost) return lostAccess(err.message);
    if (err instanceof AccountCaptureFailed) return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: err.message }, calls);
    if (err instanceof GoogleRateLimitError) {
      return failed(input, mailbox, row?.attempts ?? 0, { state: "pending", reason: "rate_limited", retryAfterSeconds: err.retryAfterSeconds }, calls);
    }
    return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: `capture_failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }, calls);
  }
}

/** The view-only Docs capture before native types were added; kept for callers and tests. */
export const captureAccountDocView = captureAccountView;

/** documents.get as the account (DEFAULT_FOR_CURRENT_ACCESS), its images, tabs, markdown, and its own snapshot diff. */
async function captureDocContent(a: {
  tenantId: string; docId: string; mailbox: string; directory: string;
  call: (url: string) => Promise<Response>; caller: AccountCaller; input: AccountSnapshotInput;
  base: { tenantId: string; fileId: string; sourceVersion: string; sourceOrder: number; sourceUpdatedAt: string | null; capturedAt: Date };
  live: Set<string>; modifiedTime: string | null; calls: { apiCalls: number; imageFetches: number };
}): Promise<{ state: AccountCaptureState; reasons: string[]; capture: Record<string, unknown>; revisionId: string | null; viewMode: string | null }> {
  const { tenantId, docId, mailbox, directory, call, caller, input, live, modifiedTime } = a;
  const deps = input.deps;
  throwIfGoogleRateLimited("google-docs-api");
  // Documented: DEFAULT_FOR_CURRENT_ACCESS applies PREVIEW_WITHOUT_SUGGESTIONS when the user only has view access
  // and SUGGESTIONS_INLINE otherwise, so Google (not a guess about commenter rights) decides what this account sees,
  // in one call. The response's output-only `suggestionsViewMode` says which view was applied.
  const docRes = await call(`${DOCS_API}/${encodeURIComponent(docId)}?includeTabsContent=true&suggestionsViewMode=DEFAULT_FOR_CURRENT_ACCESS`);
  if (docRes.status === 403 || docRes.status === 404) throw new AccountAccessLost(`access_lost:documents.get_http_${docRes.status}`);
  if (!docRes.ok) {
    const why = await googleErrorReason(docRes);
    throw new AccountCaptureFailed(`documents.get_http_${docRes.status}${why ? `:${why}` : ""}`);
  }
  const raw = (await docRes.json()) as unknown;
  const applied = (raw as { suggestionsViewMode?: unknown } | null)?.suggestionsViewMode;
  const viewMode = typeof applied === "string" && applied ? applied : "DEFAULT_FOR_CURRENT_ACCESS";
  const suggestionsAccessible = viewMode === "SUGGESTIONS_INLINE";

  // Bytes inside the contentUri window, as this account; then redact before anything is persisted.
  const imageRun = await fetchAccountImages(raw, input.fetchImpl ?? fetch);
  a.calls.imageFetches = imageRun.fetches;
  const redacted = redactProviderPayload("google-docs", raw);
  const doc = parseDocContent(redacted, suggestionsAccessible);
  const revisionId = revisionIdOf(doc);
  const capturedAt = a.base.capturedAt;
  const paths = accountDocPaths(directory);
  const previous = await previousAccountState(tenantId, paths.nativeDocument, deps);
  const base = { ...a.base, sourceVersion: revisionId };
  const provenance = {
    api: "docs.documents.get",
    params: { includeTabsContent: true, suggestionsViewMode: viewMode },
    account: mailbox,
    credentialMode: caller.mode,
    capture: "account_view: fetched under this account's own credential",
    revisionId,
    redaction: "redactProviderPayload(google-docs): contentUri and signed credential URLs replaced",
  };
  const put = async (path: string, kind: "raw" | "projection" | "binary", contentType: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) => {
    live.add(path);
    await putSourceFile({ ...base, path, kind, contentType, bytes, provenance: { ...provenance, ...extra } }, deps);
  };

  await put(paths.nativeDocument, "raw", "application/json", jsonBytes(redacted));
  for (const { tabId, tab, childTabIds } of flattenNativeTabs(redacted)) {
    await put(paths.nativeTab(tabId), "raw", "application/json", jsonBytes({ documentId: docId, revisionId, childTabIds, tab }), { projection: "one native tab object from documents.get (childTabs referenced by id)" });
  }
  for (const tab of doc.tabs) {
    await put(paths.tabText(tab.tabId), "projection", "text/markdown; charset=utf-8", Buffer.from(`${tab.content}\n`, "utf8"), { derivedFrom: "native/document.json", renderer: "parseDocContent", tabName: tab.tabName });
    if (suggestionsAccessible && tab.suggestions.length > 0) {
      await put(paths.tabSuggestions(tab.tabId), "projection", "application/json", jsonBytes({ tabId: tab.tabId, suggestions: tab.suggestions }), { derivedFrom: "native/document.json (SUGGESTIONS_INLINE returned to this account)" });
    }
  }
  for (const image of imageRun.images) {
    const bytesPath = paths.imageBytes(image.objectId, extensionForMime(image.mimeType));
    await put(bytesPath, "binary", image.mimeType ?? "application/octet-stream", image.bytes, { api: "documents.get imageProperties.contentUri as this account (consumed in-window, never stored)", objectId: image.objectId });
    await put(paths.imageMeta(image.objectId), "projection", "application/json", jsonBytes({
      objectId: image.objectId, kind: image.kind, altText: image.altText, mimeType: image.mimeType, sha256: image.sha256,
      sizeBytes: image.sizeBytes, docRevisionId: revisionId, bytesPath: bytesPath.slice(directory.length + 1),
    }));
  }

  // Retire tabs/suggestions/images of this account's copy that this revision no longer has.
  const imagesComplete = imageRun.failed + imageRun.tooLarge + imageRun.overCap === 0;
  for (const head of await listLiveHeads(tenantId, docId, deps)) {
    if (!head.path.startsWith(`${directory}/`) || live.has(head.path)) continue;
    const isTab = head.path.startsWith(`${paths.tabsDir}/`) || head.path.startsWith(`${paths.nativeTabsDir}/`);
    const isImage = head.path.startsWith(`${paths.imagesDir}/`);
    if (isTab || (isImage && imagesComplete)) {
      await deleteSourceFile({ ...base, path: head.path, reason: "removed_from_source" }, deps);
    }
  }

  const current = stateOf(doc, revisionId, capturedAt.toISOString(), modifiedTime);
  if (!previous || previous.revisionId !== revisionId) {
    const event = buildSnapshotDiffEvent(docId, previous, current);
    const key = `${current.capturedAt.replace(/[:.]/g, "-")}-${revisionId}`;
    await put(paths.snapshotDiff(key), "projection", "application/json", jsonBytes({ ...event, sourceEventId: `${event.sourceEventId}:account`, account: mailbox }), {
      derivedFrom: "this account's own consecutive native/document.json captures",
    });
  }

  const reasons = [
    imageRun.failed ? `images_not_captured:${imageRun.failed}` : null,
    imageRun.tooLarge ? `images_too_large:${imageRun.tooLarge}` : null,
    imageRun.overCap ? `images_over_per_run_cap:${imageRun.overCap}` : null,
    suggestionsAccessible ? null : "suggestions_not_visible_to_account",
  ].filter((x): x is string => Boolean(x));
  return {
    state: imageRun.overCap > 0 ? "partial" : "complete",
    reasons,
    revisionId,
    viewMode,
    capture: {
      revisionId,
      suggestionsViewMode: viewMode,
      images: { fetched: imageRun.images.length, failed: imageRun.failed, tooLarge: imageRun.tooLarge, overCap: imageRun.overCap },
    },
  };
}

class AccountAccessLost extends Error {}
class AccountCaptureFailed extends Error {}

/**
 * Files a roster mailbox was seen viewing (visibility row with `can_read_revisions = false`) but that have no account
 * capture yet: files recorded before this lane existed (Docs before 9104, other types before 9105), or a lost enqueue.
 * Docs/Sheets/Slides/Drive files come from active checkpoints, Drive PDFs from live drive-pdf binary documents.
 * Bounded; the hourly sweep calls it.
 */
export async function seedAccountCaptures(tenantId: string, limit: number, deps?: StoreDeps): Promise<number> {
  const db = await resolveDb(deps);
  return rowsOf<{ file_id: string }>(await db.execute(sql`
    INSERT INTO gdocs_account_captures (tenant_id, file_id, mailbox, state, mime_type, updated_at)
    SELECT s.tenant_id, s.file_id, s.mailbox, 'pending', s.mime_type, now() FROM (
      SELECT v.tenant_id, v.file_id, v.mailbox, c.mime_type
      FROM gdocs_file_visibility v
      JOIN gdocs_file_checkpoints c ON c.tenant_id = v.tenant_id AND c.file_id = v.file_id
      WHERE v.tenant_id = ${tenantId} AND v.visible AND v.can_read_revisions = false
        AND c.lifecycle_state = 'active' AND c.mime_type IS NOT NULL
        AND c.mime_type NOT IN (${GOOGLE_FOLDER_MIME}, ${GOOGLE_SHORTCUT_MIME}, ${PDF_MIME})
      UNION ALL
      SELECT v.tenant_id, v.file_id, v.mailbox, ${PDF_MIME}
      FROM gdocs_file_visibility v
      JOIN binary_documents d ON d.tenant_id = v.tenant_id AND d.provider = 'drive-pdf' AND d.external_id = v.file_id AND d.tombstoned_at IS NULL
      WHERE v.tenant_id = ${tenantId} AND v.visible AND v.can_read_revisions = false
    ) s
    WHERE NOT EXISTS (SELECT 1 FROM gdocs_account_captures a WHERE a.tenant_id = s.tenant_id AND a.file_id = s.file_id AND a.mailbox = s.mailbox)
    LIMIT ${Math.max(1, limit)}
    ON CONFLICT DO NOTHING
    RETURNING file_id
  `)).length;
}

/** Account captures due for a (re)try: new versions, Retry-After / backoff elapsed, or comment activity to re-read. */
export async function listDueAccountCaptures(tenantId: string, now: Date, limit: number, deps?: StoreDeps): Promise<AccountCaptureRow[]> {
  const db = await resolveDb(deps);
  return rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_account_captures
    WHERE tenant_id = ${tenantId}
      AND (state IN ('pending', 'partial', 'error') OR (comments_due AND state NOT IN ('retired', 'superseded')))
      AND (retry_at IS NULL OR retry_at <= ${now.toISOString()}::timestamptz)
    ORDER BY updated_at
    LIMIT ${limit}
  `)).map(toRow);
}
