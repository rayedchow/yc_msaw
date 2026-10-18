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
 * Never written here: OT changelog, revisions, sessions, comments, suggestion cards, or anything to the donor's
 * shared tables (google_doc_tab_snapshots, google_doc_images, mirror), so baselines and diffs never mix accounts.
 *
 * Fail closed: only an explicit `canReadRevisions === false` from that mailbox's own Drive view starts a capture;
 * a 403/404 under the account's credential retires its copy (no fallback to any shared copy); a doc whose
 * copy/download is disabled for readers and commenters (`copyRequiresWriterPermission`, `canCopy`/`canDownload`
 * false) is not exported and is reported `blocked`; a mailbox that gains revisions is served the full unit instead
 * and its copy is retired (`superseded_by_full_unit`). Retired copies keep their history (captured under that
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
import { DRIVE_FIELDS, GOOGLE_DOC_MIME, sanitizeDriveMetadata } from "./drive-export.js";
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
  { artifact: "comments and suggestion cards", reason: "not_captured_for_account_view: the shared comment ledger was read under another credential" },
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
    capture: `${dir}/capture.json`,
  };
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
  update: { state: AccountCaptureState; reason?: string | null; capturedVersion?: string | null; revisionId?: string | null; exportDirectory?: string | null; viewMode?: string | null; retryAt?: Date | null },
  deps?: StoreDeps,
): Promise<void> {
  const db = await resolveDb(deps);
  const done = update.state === "complete" || update.state === "partial";
  await db.execute(sql`
    INSERT INTO gdocs_account_captures (tenant_id, file_id, mailbox, state, reason, captured_version, revision_id, export_directory,
      view_mode, retry_at, attempts, captured_at, updated_at)
    VALUES (${tenantId}, ${fileId}, ${mailbox.toLowerCase()}, ${update.state}, ${update.reason ?? null}, ${update.capturedVersion ?? null},
      ${update.revisionId ?? null}, ${update.exportDirectory ?? null}, ${update.viewMode ?? null},
      ${update.retryAt ? update.retryAt.toISOString() : null}::timestamptz, ${done ? 0 : 1}, ${done ? new Date().toISOString() : null}::timestamptz, now())
    ON CONFLICT (tenant_id, file_id, mailbox) DO UPDATE SET
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
 * Called for every live change a mailbox's own changes feed or inventory reports (lifecycle.recordLiveChange).
 * `canReadRevisions === false` on a Doc: record the version this mailbox saw and, when it is new, enqueue a capture
 * of that mailbox's current view. `true`: the full unit serves it, so retire a copy it may have had. Absent: nothing
 * (never captured on an unknown capability). Fail-soft (donor-test mocks have no table).
 */
export async function noteAccountView(tenantId: string, change: AccountViewChange, mailbox: string | null, deps?: StoreDeps): Promise<void> {
  if (!mailbox || change.file?.mimeType !== GOOGLE_DOC_MIME) return;
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
      INSERT INTO gdocs_account_captures (tenant_id, file_id, mailbox, state, drive_version, updated_at)
      VALUES (${tenantId}, ${change.fileId}, ${box}, 'pending', ${version}, now())
      ON CONFLICT (tenant_id, file_id, mailbox) DO UPDATE SET
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

export async function captureAccountDocView(input: AccountSnapshotInput): Promise<AccountSnapshotResult> {
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
    metaUrl.searchParams.set("fields", DRIVE_FIELDS);
    metaUrl.searchParams.set("supportsAllDrives", "true");
    const metaRes = await call(metaUrl.toString());
    if (metaRes.status === 403 || metaRes.status === 404) return lostAccess(`access_lost:files.get_http_${metaRes.status}`);
    if (!metaRes.ok) {
      const why = await googleErrorReason(metaRes);
      return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: `files.get_http_${metaRes.status}${why ? `:${why}` : ""}` }, calls);
    }
    const file = (await metaRes.json()) as Record<string, unknown> & {
      name?: string; mimeType?: string; modifiedTime?: string; trashed?: boolean; copyRequiresWriterPermission?: boolean;
      capabilities?: { canReadRevisions?: boolean; canDownload?: boolean; canCopy?: boolean };
    };
    if (file.trashed) return skipped("trashed");
    if (file.mimeType && file.mimeType !== GOOGLE_DOC_MIME) return skipped("not_a_google_doc");
    const caps = file.capabilities ?? {};
    if (caps.canReadRevisions === true) {
      // Google now lets this account read revisions: the full unit is its read; retire the account copy.
      await recordObservedCapability(tenantId, docId, mailbox, true, deps);
      await retireAccountCopy(tenantId, docId, mailbox, "superseded", "superseded_by_full_unit", deps);
      return { state: "superseded", reason: "superseded_by_full_unit", directory: null, ...calls };
    }
    if (caps.canReadRevisions !== false) return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: "files.get_capability_missing" }, calls);
    if (file.copyRequiresWriterPermission === true || caps.canCopy === false || caps.canDownload === false) {
      // The owner disabled copy/download for readers and commenters: the account may look, not keep a copy.
      return lostAccess("copy_restricted_for_account");
    }

    const modifiedTime = typeof file.modifiedTime === "string" ? file.modifiedTime : null;
    const title = typeof file.name === "string" ? file.name : null;
    const directory = accountDocDirectory(mailbox, docId, title);
    if (row?.state === "complete" && modifiedTime && row.capturedVersion === modifiedTime && row.exportDirectory === directory) {
      // Already captured for this Drive version: 1 call (files.get), no documents.get.
      await setAccountState(tenantId, docId, mailbox, { state: "complete", reason: row.reason, capturedVersion: modifiedTime }, deps);
      return { state: "complete", reason: "already_captured_for_version", directory, ...calls };
    }

    throwIfGoogleRateLimited("google-docs-api");
    // Documented: DEFAULT_FOR_CURRENT_ACCESS applies PREVIEW_WITHOUT_SUGGESTIONS when the user only has view access
    // and SUGGESTIONS_INLINE otherwise, so Google (not a guess about commenter rights) decides what this account sees,
    // in one call. The response's output-only `suggestionsViewMode` says which view was applied.
    const docRes = await call(`${DOCS_API}/${encodeURIComponent(docId)}?includeTabsContent=true&suggestionsViewMode=DEFAULT_FOR_CURRENT_ACCESS`);
    if (docRes.status === 403 || docRes.status === 404) return lostAccess(`access_lost:documents.get_http_${docRes.status}`);
    if (!docRes.ok) {
      const why = await googleErrorReason(docRes);
      return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: `documents.get_http_${docRes.status}${why ? `:${why}` : ""}` }, calls);
    }
    const raw = (await docRes.json()) as unknown;
    const applied = (raw as { suggestionsViewMode?: unknown } | null)?.suggestionsViewMode;
    const viewMode = typeof applied === "string" && applied ? applied : "DEFAULT_FOR_CURRENT_ACCESS";
    const suggestionsAccessible = viewMode === "SUGGESTIONS_INLINE";

    // Bytes inside the contentUri window, as this account; then redact before anything is persisted.
    const imageRun = await fetchAccountImages(raw, input.fetchImpl ?? fetch);
    calls.imageFetches = imageRun.fetches;
    const redacted = redactProviderPayload("google-docs", raw);
    const doc = parseDocContent(redacted, suggestionsAccessible);
    const revisionId = revisionIdOf(doc);
    const capturedAt = input.now ?? new Date();
    const paths = accountDocPaths(directory);

    if (row?.exportDirectory && row.exportDirectory !== directory) {
      await moveFileExports({ tenantId, fileId: docId, fromDirectory: row.exportDirectory, toDirectory: directory, capturedAt }, deps);
    }
    const previous = await previousAccountState(tenantId, paths.nativeDocument, deps);

    const order = modifiedTime && Number.isFinite(Date.parse(modifiedTime)) ? Date.parse(modifiedTime) : capturedAt.getTime();
    const base = { tenantId, fileId: docId, sourceVersion: revisionId, sourceOrder: order, sourceUpdatedAt: modifiedTime, capturedAt };
    const provenance = {
      api: "docs.documents.get",
      params: { includeTabsContent: true, suggestionsViewMode: viewMode },
      account: mailbox,
      credentialMode: caller.mode,
      capture: "account_view: fetched under this account's own credential",
      revisionId,
      redaction: "redactProviderPayload(google-docs): contentUri and signed credential URLs replaced",
    };
    const live = new Set<string>();
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
    await put(paths.drive, "raw", "application/json", jsonBytes({ file: sanitizeDriveMetadata(file) }), {
      api: "drive.files.get", note: "as this account: its capabilities and only the permissions Google returns to it; links dropped",
    });

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
    ].filter(Boolean).join(",") || null;
    const state: AccountCaptureState = imageRun.overCap > 0 ? "partial" : "complete";
    await put(paths.capture, "projection", "application/json", jsonBytes({
      schema: ACCOUNT_CAPTURE_SCHEMA,
      docId,
      account: mailbox,
      credentialMode: caller.mode,
      state,
      reason: reasons,
      revisionId,
      modifiedTime,
      suggestionsViewMode: viewMode,
      capabilities: { canReadRevisions: false, canCopy: caps.canCopy ?? null, canDownload: caps.canDownload ?? null },
      images: { fetched: imageRun.images.length, failed: imageRun.failed, tooLarge: imageRun.tooLarge, overCap: imageRun.overCap },
      excludes: ACCOUNT_VIEW_EXCLUDES,
    }));
    await setAccountState(tenantId, docId, mailbox, {
      state, reason: reasons, capturedVersion: modifiedTime, revisionId, exportDirectory: directory, viewMode,
      retryAt: state === "partial" ? new Date(capturedAt.getTime() + 60_000) : null,
    }, deps);
    return { state, reason: reasons, directory, ...calls };
  } catch (err) {
    if (err instanceof GoogleRateLimitError) {
      return failed(input, mailbox, row?.attempts ?? 0, { state: "pending", reason: "rate_limited", retryAfterSeconds: err.retryAfterSeconds }, calls);
    }
    return failed(input, mailbox, row?.attempts ?? 0, { state: "error", reason: `capture_failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }, calls);
  }
}

/**
 * Docs a roster mailbox was seen viewing (visibility row with `can_read_revisions = false`) but that have no account
 * capture yet: files recorded before this lane existed, or a lost enqueue. Bounded; the hourly sweep calls it.
 */
export async function seedAccountCaptures(tenantId: string, limit: number, deps?: StoreDeps): Promise<number> {
  const db = await resolveDb(deps);
  return rowsOf<{ file_id: string }>(await db.execute(sql`
    INSERT INTO gdocs_account_captures (tenant_id, file_id, mailbox, state, updated_at)
    SELECT v.tenant_id, v.file_id, v.mailbox, 'pending', now()
    FROM gdocs_file_visibility v
    JOIN gdocs_file_checkpoints c ON c.tenant_id = v.tenant_id AND c.file_id = v.file_id
    WHERE v.tenant_id = ${tenantId} AND v.visible AND v.can_read_revisions = false
      AND c.mime_type = ${GOOGLE_DOC_MIME} AND c.lifecycle_state = 'active'
      AND NOT EXISTS (SELECT 1 FROM gdocs_account_captures a WHERE a.tenant_id = v.tenant_id AND a.file_id = v.file_id AND a.mailbox = v.mailbox)
    LIMIT ${Math.max(1, limit)}
    ON CONFLICT DO NOTHING
    RETURNING file_id
  `)).length;
}

/** Account captures due for a (re)try: new versions, Retry-After / backoff elapsed. */
export async function listDueAccountCaptures(tenantId: string, now: Date, limit: number, deps?: StoreDeps): Promise<AccountCaptureRow[]> {
  const db = await resolveDb(deps);
  return rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_account_captures
    WHERE tenant_id = ${tenantId} AND state IN ('pending', 'partial', 'error')
      AND (retry_at IS NULL OR retry_at <= ${now.toISOString()}::timestamptz)
    ORDER BY updated_at
    LIMIT ${limit}
  `)).map(toRow);
}
