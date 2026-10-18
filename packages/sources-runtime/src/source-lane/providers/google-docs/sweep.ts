/**
 * Hooks the donor Docs jobs call into, plus the bounded retry sweep.
 *
 * - `exportDocSnapshotToSources`: called by content-snapshot with the redacted
 *   documents.get JSON + image bytes it just captured.
 * - `runDocHistoryAfterSnapshot`: OT history export after a content snapshot.
 * - `runGdocsSourceSweep`: due retries (Retry-After / backoff honoured via
 *   checkpoint retry times) and not-yet-exported Sheets/Slides/Drive files.
 *   The 60s poll runs it bounded to non-Doc files; the hourly suggestion-sync
 *   runs it for everything (Docs content/history retries included).
 *
 * Nothing here throws into the donor job: failures are recorded on the
 * checkpoint (and therefore in coverage) and retried.
 */
import { GoogleRateLimitError } from "../../../vault/google-rate-limit.js";
import type { FetchedDocImage, StoreDocImagesResult } from "../../../integrations/google/gdocs/images.js";
import { exportDocContentFiles } from "./doc-export.js";
import { exportDocHistory } from "./history-export.js";
import { exportDriveFile, getDriveFile, sanitizeDriveMetadata, GOOGLE_DOC_MIME } from "./drive-export.js";
import { clearRematerializePending, getCheckpoint, listDueRetries, retryDelaySeconds, setContentState, type FileCheckpoint } from "./checkpoints.js";
import type { StoreDeps } from "./store.js";

export const GDOCS_POLL_SWEEP_MAX_FILES = Math.max(0, Math.floor(Number(process.env.GDOCS_SOURCE_POLL_SWEEP_MAX_FILES ?? 5)));
export const GDOCS_POLL_SWEEP_BUDGET_MS = Math.max(1_000, Math.floor(Number(process.env.GDOCS_SOURCE_POLL_SWEEP_BUDGET_MS ?? 20_000)));
export const GDOCS_FULL_SWEEP_MAX_FILES = Math.max(1, Math.floor(Number(process.env.GDOCS_SOURCE_SWEEP_MAX_FILES ?? 25)));

export interface DocSnapshotHookInput {
  userId: string;
  docId: string;
  title: string;
  redactedRaw: unknown;
  revisionId: string;
  modifiedTime: string | null;
  suggestionsAccessible: boolean;
  images: FetchedDocImage[] | null;
  imageSummary: StoreDocImagesResult | null;
  identity: { authorEmail?: string | null; authorName?: string | null; updatedByEmail?: string | null; updatedByName?: string | null };
  deps?: StoreDeps;
  accessToken?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export async function exportDocSnapshotToSources(input: DocSnapshotHookInput): Promise<void> {
  const checkpoint = await getCheckpoint(input.userId, input.docId, input.deps).catch(() => null);
  const mailbox = checkpoint?.mailbox ?? null;
  let driveMetadata: Record<string, unknown> | null = null;
  let driveMetadataError: string | null = null;
  try {
    let accessToken = input.accessToken;
    if (!accessToken) {
      const { getGoogleAccessToken, GOOGLE_DOCS_DELEGATION_SCOPES } = await import("../../../vault/google-auth.js");
      accessToken = await getGoogleAccessToken(input.userId, mailbox ?? undefined, GOOGLE_DOCS_DELEGATION_SCOPES);
    }
    const meta = await getDriveFile({ tenantId: input.userId, mailbox, accessToken, fetchImpl: input.fetchImpl }, input.docId);
    if (meta.file) driveMetadata = sanitizeDriveMetadata(meta.file);
    else driveMetadataError = `files.get_http_${meta.status}${meta.reason ? `:${meta.reason}` : ""}`;
  } catch (err) {
    driveMetadataError = err instanceof GoogleRateLimitError ? "rate_limited" : (err instanceof Error ? err.message : String(err));
  }
  await exportDocContentFiles({
    tenantId: input.userId,
    docId: input.docId,
    title: input.title,
    redactedRaw: input.redactedRaw,
    revisionId: input.revisionId,
    modifiedTime: input.modifiedTime,
    suggestionsAccessible: input.suggestionsAccessible,
    images: input.images,
    imageFetchSummary: input.imageSummary as unknown as Record<string, number> | null,
    driveMetadata,
    driveMetadataError,
    identity: input.identity,
    deps: input.deps,
  });
}

/** Mark a Docs content export as failed so the sweep retries it. */
export async function recordDocExportFailure(userId: string, docId: string, err: unknown, deps?: StoreDeps): Promise<void> {
  const checkpoint = await getCheckpoint(userId, docId, deps).catch(() => null);
  const rateLimited = err instanceof GoogleRateLimitError;
  const retryAt = new Date(Date.now() + retryDelaySeconds(checkpoint?.contentAttempts ?? 0, rateLimited ? err.retryAfterSeconds : null) * 1000);
  await setContentState(userId, docId, {
    state: rateLimited ? "pending" : "error",
    reason: rateLimited ? "rate_limited" : `export_failed:${err instanceof Error ? err.message : String(err)}`,
    retryAt,
  }, deps).catch(() => {});
}

export async function runDocHistoryAfterSnapshot(
  userId: string,
  docId: string,
  title: string,
  options: { modifiedTime?: string | null; deps?: StoreDeps } = {},
): Promise<{ state: string; reason: string | null } | null> {
  try {
    const checkpoint = await getCheckpoint(userId, docId, options.deps);
    if (checkpoint && checkpoint.lifecycleState !== "active") return null;
    // Already captured for this Drive version (repeat poll / redelivery).
    const modifiedMs = options.modifiedTime ? Date.parse(options.modifiedTime) : NaN;
    if (
      checkpoint?.historyState === "complete"
      && checkpoint.historyAttemptedAt
      && Number.isFinite(modifiedMs)
      && Date.parse(checkpoint.historyAttemptedAt) >= modifiedMs
    ) {
      return { state: "complete", reason: "already_captured_for_version" };
    }
    // Retry window still open (Retry-After / backoff): leave it to the sweep.
    if (checkpoint?.historyRetryAt && Date.parse(checkpoint.historyRetryAt) > Date.now()
      && (checkpoint.historyState === "partial" || checkpoint.historyState === "error" || checkpoint.historyState === "blocked")) {
      return { state: checkpoint.historyState, reason: "retry_window_open" };
    }
    const result = await exportDocHistory({ tenantId: userId, docId, title, mailbox: checkpoint?.mailbox ?? null, deps: options.deps });
    return { state: result.state, reason: result.reason };
  } catch (err) {
    console.warn(`[gdocs-source] history export failed for ${docId}:`, err instanceof Error ? err.message : err);
    return { state: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface SweepOptions {
  now?: Date;
  maxFiles: number;
  budgetMs: number;
  /** Docs content/history retries (hourly sweep) vs non-Doc files only (poll). */
  includeDocs: boolean;
  deps?: StoreDeps;
}

export interface SweepResult {
  processed: number;
  stoppedFor: "rate_limited" | "budget" | null;
  results: Array<{ fileId: string; lane: string; state: string; reason: string | null }>;
}

export async function runGdocsSourceSweep(tenantId: string, options: SweepOptions): Promise<SweepResult> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const out: SweepResult = { processed: 0, stoppedFor: null, results: [] };
  if (options.maxFiles <= 0) return out;
  const due = await listDueRetries(tenantId, now, options.maxFiles * 4, options.deps, { includeDocs: options.includeDocs });
  for (const cp of due) {
    if (out.processed >= options.maxFiles) break;
    if (Date.now() - started > options.budgetMs) {
      out.stoppedFor = "budget";
      break;
    }
    const isDoc = cp.mimeType === GOOGLE_DOC_MIME;
    if (isDoc && !options.includeDocs) continue;
    try {
      if (isDoc) {
        await sweepDoc(tenantId, cp, now, options, out);
      } else {
        const r = await exportDriveFile({ tenantId, fileId: cp.fileId, mailbox: cp.mailbox, now, deps: options.deps });
        out.results.push({ fileId: cp.fileId, lane: "drive", state: r.state, reason: r.reason });
        if (r.reason === "rate_limited") {
          out.processed++;
          out.stoppedFor = "rate_limited";
          break;
        }
      }
      out.processed++;
    } catch (err) {
      if (err instanceof GoogleRateLimitError) {
        out.stoppedFor = "rate_limited";
        break;
      }
      out.results.push({ fileId: cp.fileId, lane: isDoc ? "doc" : "drive", state: "error", reason: err instanceof Error ? err.message : String(err) });
      out.processed++;
    }
  }
  return out;
}

async function sweepDoc(tenantId: string, cp: FileCheckpoint, now: Date, options: SweepOptions, out: SweepResult): Promise<void> {
  const contentDue = ["pending", "partial", "error"].includes(cp.contentState)
    && (!cp.contentRetryAt || Date.parse(cp.contentRetryAt) <= now.getTime());
  if (contentDue) {
    const { snapshotDocContent } = await import("../../../integrations/google/gdocs/content-snapshot.js");
    // modifiedTime null => no dedupe-before-fetch: the export hook runs even
    // when the revision rows already exist.
    const r = await snapshotDocContent(tenantId, cp.fileId, { modifiedTime: null, forceMaterialize: cp.rematerializePending });
    if (cp.rematerializePending) await clearRematerializePending(tenantId, cp.fileId, options.deps).catch(() => {});
    out.results.push({ fileId: cp.fileId, lane: "doc-content", state: r.status, reason: null });
  }
  const historyDue = ["pending", "partial", "error"].includes(cp.historyState)
    && cp.historyRetryAt != null && Date.parse(cp.historyRetryAt) <= now.getTime();
  if (historyDue || (contentDue && cp.historyState === "pending")) {
    const fresh = await getCheckpoint(tenantId, cp.fileId, options.deps);
    const title = fresh?.name ?? cp.name ?? "Untitled Google Doc";
    const r = await exportDocHistory({ tenantId, docId: cp.fileId, title, mailbox: cp.mailbox, now, deps: options.deps });
    out.results.push({ fileId: cp.fileId, lane: "doc-history", state: r.state, reason: r.reason });
    if (r.reason === "rate_limited") throw new GoogleRateLimitError("google-workspace", 429, 60, "history");
  }
}
