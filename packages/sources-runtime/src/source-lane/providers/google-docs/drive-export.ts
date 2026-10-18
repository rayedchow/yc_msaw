/**
 * Sheets / Slides / other Drive files as source files (bytes, native JSON).
 *
 *  - Google-native types (Sheets, Slides, Drawings, Apps Script, ...): the
 *    export format is chosen from the account's ACTUAL `about.exportFormats`
 *    (never a hard-coded assumption), downloaded with `files.export`. Google
 *    documents a 10 MB limit on files.export; above it (exportSizeLimitExceeded)
 *    the file's `exportLinks` URL is used once, in-process (never persisted).
 *    Sheets and Slides additionally get their native API JSON
 *    (spreadsheets.get includeGridData=true / presentations.get).
 *  - Binary files: `files.get?alt=media`, streamed into 8 MiB chunks, exact
 *    bytes, with an explicit size cap (GDOCS_DRIVE_FILE_MAX_BYTES).
 *  - PDFs stay in the donor `drive-pdf` binary_documents lane (binary agent);
 *    Google Docs stay in the Docs lane; folders are structure only.
 *  - Permissions: drive.json carries files.get permissions/capabilities (what
 *    the capturing identity can see), minus thumbnailLink/webContentLink/
 *    exportLinks. `capabilities.canDownload=false` => `blocked`.
 *
 * Every outcome is recorded in export-status.json and the file checkpoint;
 * over-limit and restricted files are `partial`/`blocked`, never `complete`.
 */
import { GoogleRateLimitError } from "../../../vault/google-rate-limit.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import { getCheckpoint, retryDelaySeconds, setContentState, setExportDirectory, type ContentState } from "./checkpoints.js";
import { googleErrorReason, googleFetch, type GoogleCallContext } from "./google-fetch.js";
import { driveFileDirectory, driveFilePaths, extensionForMime, type DriveFileClass } from "./paths.js";
import {
  deleteSourceFile,
  jsonBytes,
  listLiveHeads,
  moveFileExports,
  putSourceFile,
  safeSegment,
  storeStream,
  type StoredBlob,
  type StoreDeps,
} from "./store.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
export const PDF_MIME = "application/pdf";

/** Google's documented files.export ceiling (exported content). */
export const FILES_EXPORT_LIMIT_BYTES = 10 * 1024 * 1024;
export const DRIVE_FILE_MAX_BYTES = Math.max(1, Math.floor(Number(process.env.GDOCS_DRIVE_FILE_MAX_BYTES ?? 512 * 1024 * 1024)));
export const DRIVE_EXPORT_MAX_BYTES = Math.max(1, Math.floor(Number(process.env.GDOCS_DRIVE_EXPORT_MAX_BYTES ?? 256 * 1024 * 1024)));
export const DRIVE_NATIVE_JSON_MAX_BYTES = Math.max(1, Math.floor(Number(process.env.GDOCS_DRIVE_NATIVE_JSON_MAX_BYTES ?? 128 * 1024 * 1024)));

/** Preference order per native type; the first one the account actually offers wins. */
const EXPORT_PREFERENCES: Record<string, string[]> = {
  [GOOGLE_SHEET_MIME]: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/x-vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/pdf",
  ],
  [GOOGLE_SLIDES_MIME]: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.presentation",
    "application/pdf",
  ],
  "application/vnd.google-apps.drawing": ["image/svg+xml", "image/png", "application/pdf"],
  "application/vnd.google-apps.script": ["application/vnd.google-apps.script+json"],
};

export const DRIVE_FIELDS = [
  "id", "name", "mimeType", "description", "size", "md5Checksum", "sha1Checksum", "sha256Checksum",
  "headRevisionId", "version", "modifiedTime", "createdTime", "trashed", "explicitlyTrashed", "parents", "driveId",
  "owners(displayName,emailAddress,permissionId)", "lastModifyingUser(displayName,emailAddress,permissionId)",
  "shared", "capabilities(canDownload,canReadRevisions,canCopy)", "copyRequiresWriterPermission",
  "permissionIds", "permissions(id,type,role,emailAddress,domain,displayName,deleted,allowFileDiscovery,expirationTime,permissionDetails)",
  "shortcutDetails", "exportLinks",
].join(",");

/** Fields that are ephemeral/credentialed links and must never be persisted. */
const DRIVE_METADATA_DENYLIST = new Set(["thumbnailLink", "webContentLink", "exportLinks", "contentHints", "iconLink"]);

export function sanitizeDriveMetadata(file: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) {
    if (!DRIVE_METADATA_DENYLIST.has(key)) out[key] = value;
  }
  return redactProviderPayload("google-docs", out) as Record<string, unknown>;
}

/** Slides image `contentUrl` is requester-tagged (like Docs contentUri); never persist it. */
export function redactNativeJson(value: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
      out[key] = key === "contentUrl" && typeof child === "string"
        ? "[redacted: ephemeral requester-scoped URL]"
        : walk(child);
    }
    return out;
  };
  return redactProviderPayload("google-docs", walk(value));
}

export function driveFileClass(mimeType: string): DriveFileClass | null {
  if (mimeType === GOOGLE_DOC_MIME || mimeType === PDF_MIME || mimeType === GOOGLE_FOLDER_MIME) return null;
  if (mimeType === GOOGLE_SHEET_MIME) return "sheets";
  if (mimeType === GOOGLE_SLIDES_MIME) return "slides";
  return "files";
}

export function chooseExportFormat(mimeType: string, exportFormats: Record<string, string[]>): string | null {
  const available = exportFormats[mimeType] ?? [];
  if (available.length === 0) return null;
  for (const preferred of EXPORT_PREFERENCES[mimeType] ?? []) {
    if (available.includes(preferred)) return preferred;
  }
  return available[0];
}

const exportFormatsCache = new Map<string, { at: number; formats: Record<string, string[]> }>();
const EXPORT_FORMATS_TTL_MS = 60 * 60 * 1000;

export async function loadExportFormats(ctx: GoogleCallContext): Promise<Record<string, string[]>> {
  const key = `${ctx.tenantId}\n${ctx.mailbox ?? ""}`;
  const cached = exportFormatsCache.get(key);
  if (cached && Date.now() - cached.at < EXPORT_FORMATS_TTL_MS) return cached.formats;
  const res = await googleFetch(ctx, `${DRIVE_API}/about?fields=exportFormats`);
  if (!res.ok) throw new Error(`Drive about.get exportFormats failed (${res.status})`);
  const data = (await res.json()) as { exportFormats?: Record<string, string[]> };
  const formats = data.exportFormats ?? {};
  exportFormatsCache.set(key, { at: Date.now(), formats });
  return formats;
}

export function resetExportFormatsCacheForTests(): void {
  exportFormatsCache.clear();
}

export async function getDriveFile(ctx: GoogleCallContext, fileId: string): Promise<{ status: number; file: Record<string, unknown> | null; reason: string | null }> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", DRIVE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  const res = await googleFetch(ctx, url.toString());
  if (!res.ok) return { status: res.status, file: null, reason: await googleErrorReason(res) };
  return { status: res.status, file: (await res.json()) as Record<string, unknown>, reason: null };
}

export interface DriveExportInput {
  tenantId: string;
  fileId: string;
  mailbox: string | null;
  accessToken?: string;
  fetchImpl?: GoogleCallContext["fetchImpl"];
  now?: Date;
  deps?: StoreDeps;
  /** Override the explicit byte limits (defaults from GDOCS_DRIVE_* env). */
  limits?: Partial<DriveExportLimits>;
}

export interface DriveExportLimits {
  mediaMaxBytes: number;
  exportMaxBytes: number;
  nativeJsonMaxBytes: number;
}

export interface DriveExportResult {
  state: ContentState | "skipped";
  reason: string | null;
  directory: string | null;
  files: Record<string, string>;
  retryAt: string | null;
}

type Download =
  | { ok: true; blob: StoredBlob; contentType: string }
  | { ok: false; state: ContentState; reason: string };

async function download(
  ctx: GoogleCallContext,
  url: string,
  maxBytes: number,
  deps: StoreDeps | undefined,
): Promise<Download & { status?: number; googleReason?: string | null }> {
  const res = await googleFetch(ctx, url);
  if (!res.ok) {
    const googleReason = await googleErrorReason(res);
    await res.body?.cancel().catch(() => {});
    const blocked = res.status === 401 || res.status === 403 || res.status === 404;
    return { ok: false, state: blocked ? "blocked" : "error", reason: `http_${res.status}${googleReason ? `:${googleReason}` : ""}`, status: res.status, googleReason };
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, state: "partial", reason: `over_limit:${declared}>${maxBytes}` };
  }
  const stored = await storeStream(ctx.tenantId, res.body, maxBytes, deps);
  if (stored.status === "over_limit") return { ok: false, state: "partial", reason: `over_limit:>${stored.limit}` };
  return { ok: true, blob: stored, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

function orderOf(modifiedTime: unknown, now: Date): number {
  const t = typeof modifiedTime === "string" ? Date.parse(modifiedTime) : NaN;
  return Number.isFinite(t) ? t : now.getTime();
}

export async function exportDriveFile(input: DriveExportInput): Promise<DriveExportResult> {
  const now = input.now ?? new Date();
  const deps = input.deps;
  const limits: DriveExportLimits = {
    mediaMaxBytes: input.limits?.mediaMaxBytes ?? DRIVE_FILE_MAX_BYTES,
    exportMaxBytes: input.limits?.exportMaxBytes ?? DRIVE_EXPORT_MAX_BYTES,
    nativeJsonMaxBytes: input.limits?.nativeJsonMaxBytes ?? DRIVE_NATIVE_JSON_MAX_BYTES,
  };
  const checkpoint = await getCheckpoint(input.tenantId, input.fileId, deps);
  let accessToken = input.accessToken;
  if (!accessToken) {
    const { getGoogleAccessToken, GOOGLE_DOCS_DELEGATION_SCOPES } = await import("../../../vault/google-auth.js");
    accessToken = await getGoogleAccessToken(input.tenantId, input.mailbox ?? undefined, GOOGLE_DOCS_DELEGATION_SCOPES);
  }
  const ctx: GoogleCallContext = { tenantId: input.tenantId, mailbox: input.mailbox, accessToken, fetchImpl: input.fetchImpl };

  const fail = async (state: ContentState, reason: string, retryAfterSeconds?: number | null): Promise<DriveExportResult> => {
    const retryAt = state === "error" || state === "partial" || state === "pending"
      ? new Date(now.getTime() + retryDelaySeconds(checkpoint?.contentAttempts ?? 0, retryAfterSeconds) * 1000)
      : null;
    await setContentState(input.tenantId, input.fileId, { state, reason, retryAt }, deps);
    return { state, reason, directory: checkpoint?.exportDirectory ?? null, files: {}, retryAt: retryAt?.toISOString() ?? null };
  };

  try {
    const meta = await getDriveFile(ctx, input.fileId);
    if (!meta.file) {
      return fail(meta.status === 404 || meta.status === 403 ? "blocked" : "error", `files.get_http_${meta.status}${meta.reason ? `:${meta.reason}` : ""}`);
    }
    const file = meta.file;
    const mimeType = String(file.mimeType ?? "");
    const fileClass = driveFileClass(mimeType);
    if (!fileClass) {
      // Docs / PDFs / folders belong to other lanes: settle the checkpoint so
      // the sweep does not re-poll it every cycle.
      await setContentState(input.tenantId, input.fileId, { state: "unsupported", reason: `handled_by_other_lane:${mimeType}` }, deps);
      return { state: "skipped", reason: `handled_by_other_lane:${mimeType}`, directory: null, files: {}, retryAt: null };
    }
    if (file.trashed === true) return { state: "skipped", reason: "trashed", directory: null, files: {}, retryAt: null };

    const version = String(file.headRevisionId ?? file.md5Checksum ?? file.version ?? file.modifiedTime ?? "");
    const directory = driveFileDirectory(fileClass, input.fileId, file.name as string | undefined);
    if (checkpoint?.contentState === "complete" && checkpoint.contentVersion === version && checkpoint.exportDirectory === directory) {
      return { state: "skipped", reason: "unchanged_version", directory, files: {}, retryAt: null };
    }
    if (checkpoint?.exportDirectory && checkpoint.exportDirectory !== directory) {
      await moveFileExports({ tenantId: input.tenantId, fileId: input.fileId, fromDirectory: checkpoint.exportDirectory, toDirectory: directory, capturedAt: now }, deps);
    }
    await setExportDirectory(input.tenantId, input.fileId, directory, deps, { mimeType, name: typeof file.name === "string" ? file.name : null });

    const paths = driveFilePaths(directory);
    const base = {
      tenantId: input.tenantId,
      fileId: input.fileId,
      sourceVersion: version,
      sourceOrder: orderOf(file.modifiedTime, now),
      sourceUpdatedAt: typeof file.modifiedTime === "string" ? file.modifiedTime : null,
      capturedAt: now,
    };
    const files: Record<string, string> = {};
    files[paths.drive] = await putSourceFile({
      ...base,
      path: paths.drive,
      kind: "raw",
      contentType: "application/json",
      bytes: jsonBytes({ file: sanitizeDriveMetadata(file) }),
      provenance: { api: "drive.files.get" },
    }, deps);

    const capabilities = (file.capabilities ?? {}) as { canDownload?: boolean };
    const liveContent = new Set<string>();
    let state: ContentState = "complete";
    const reasons: string[] = [];
    let format: string | null = null;
    let exportMethod: string | null = null;

    if (mimeType === GOOGLE_SHORTCUT_MIME) {
      state = "unsupported";
      reasons.push("shortcut_metadata_only");
    } else if (capabilities.canDownload === false) {
      state = "blocked";
      reasons.push("download_restricted_by_source_permissions");
    } else if (mimeType.startsWith("application/vnd.google-apps.")) {
      const formats = await loadExportFormats(ctx);
      format = chooseExportFormat(mimeType, formats);
      if (!format) {
        state = "unsupported";
        reasons.push(`no_export_format_offered:${mimeType}`);
      } else {
        const exportUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(input.fileId)}/export`);
        exportUrl.searchParams.set("mimeType", format);
        let got = await download(ctx, exportUrl.toString(), limits.exportMaxBytes, deps);
        exportMethod = "files.export";
        if (!got.ok && got.googleReason === "exportSizeLimitExceeded") {
          const links = (file.exportLinks ?? {}) as Record<string, string>;
          const link = links[format];
          if (link) {
            exportMethod = "exportLinks (files.export over its 10 MB limit; URL used in-process, not stored)";
            got = await download(ctx, link, limits.exportMaxBytes, deps);
          } else {
            got = { ok: false, state: "partial", reason: "export_size_limit_exceeded_no_export_link" };
          }
        }
        if (got.ok) {
          const name = `${safeSegment(String(file.name ?? "export"), "export")}${extensionForMime(format)}`;
          const path = paths.content(name);
          liveContent.add(path);
          files[path] = await putSourceFile({
            ...base,
            path,
            kind: "binary",
            contentType: format,
            blob: got.blob,
            provenance: { api: exportMethod, exportMimeType: format, sourceMimeType: mimeType },
          }, deps);
        } else {
          state = got.state;
          reasons.push(`export:${got.reason}`);
        }
      }

      const nativeUrl = mimeType === GOOGLE_SHEET_MIME
        ? `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.fileId)}?includeGridData=true`
        : mimeType === GOOGLE_SLIDES_MIME
          ? `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(input.fileId)}`
          : null;
      if (nativeUrl) {
        const res = await googleFetch(ctx, nativeUrl);
        if (res.ok) {
          const declared = Number(res.headers.get("content-length"));
          const text = Number.isFinite(declared) && declared > limits.nativeJsonMaxBytes ? null : await readTextCapped(res, limits.nativeJsonMaxBytes);
          if (text === null) {
            if (state === "complete") state = "partial";
            reasons.push(`native_json_over_limit:${limits.nativeJsonMaxBytes}`);
          } else {
            files[paths.native] = await putSourceFile({
              ...base,
              path: paths.native,
              kind: "raw",
              contentType: "application/json",
              bytes: jsonBytes(redactNativeJson(JSON.parse(text))),
              provenance: { api: mimeType === GOOGLE_SHEET_MIME ? "sheets.spreadsheets.get includeGridData=true" : "slides.presentations.get", redaction: "contentUri/contentUrl/signed URLs replaced" },
            }, deps);
            liveContent.add(paths.native);
          }
        } else {
          const reason = await googleErrorReason(res);
          await res.body?.cancel().catch(() => {});
          if (state === "complete") state = "partial";
          reasons.push(`native_json_http_${res.status}${reason ? `:${reason}` : ""}`);
        }
      }
    } else {
      const mediaUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(input.fileId)}`);
      mediaUrl.searchParams.set("alt", "media");
      mediaUrl.searchParams.set("supportsAllDrives", "true");
      const got = await download(ctx, mediaUrl.toString(), limits.mediaMaxBytes, deps);
      exportMethod = "files.get alt=media";
      if (got.ok) {
        const name = safeSegment(String(file.name ?? input.fileId), "file");
        const path = paths.content(name);
        liveContent.add(path);
        const md5 = typeof file.md5Checksum === "string" ? file.md5Checksum : null;
        files[path] = await putSourceFile({
          ...base,
          path,
          kind: "binary",
          contentType: mimeType || got.contentType,
          blob: got.blob,
          provenance: { api: exportMethod, driveMd5: md5, driveSha256: file.sha256Checksum ?? null },
        }, deps);
        if (typeof file.sha256Checksum === "string" && file.sha256Checksum !== got.blob.sha256) {
          state = "error";
          reasons.push("sha256_mismatch_with_drive_metadata");
        }
      } else {
        state = got.state;
        reasons.push(`media:${got.reason}`);
      }
    }

    // Retire content files that this version no longer has (renamed export,
    // changed name). Failed downloads keep the previous bytes live.
    if (state === "complete") {
      for (const head of await listLiveHeads(input.tenantId, input.fileId, deps)) {
        const inContent = head.path.startsWith(`${paths.contentDir}/`) || head.path === paths.native;
        if (inContent && head.path.startsWith(`${directory}/`) && !liveContent.has(head.path)) {
          await deleteSourceFile({ ...base, path: head.path, reason: "removed_from_source" }, deps);
        }
      }
    }

    files[paths.status] = await putSourceFile({
      ...base,
      path: paths.status,
      kind: "projection",
      contentType: "application/json",
      bytes: jsonBytes({
        schema: "procmem.gdocs.drive-export-status/v1",
        fileId: input.fileId,
        mimeType,
        driveVersion: version,
        state,
        reasons,
        exportMimeType: format,
        method: exportMethod,
        limits: {
          filesExportDocumentedMaxBytes: FILES_EXPORT_LIMIT_BYTES,
          exportMaxBytes: limits.exportMaxBytes,
          mediaMaxBytes: limits.mediaMaxBytes,
          nativeJsonMaxBytes: limits.nativeJsonMaxBytes,
        },
        permissionsSource: "drive.files.get permissions as visible to the capturing identity",
      }),
    }, deps);

    const retryAt = state === "partial" || state === "error"
      ? new Date(now.getTime() + retryDelaySeconds(checkpoint?.contentAttempts ?? 0) * 1000)
      : null;
    await setContentState(input.tenantId, input.fileId, {
      state,
      reason: reasons.join(",") || null,
      version,
      retryAt,
    }, deps);
    return { state, reason: reasons.join(",") || null, directory, files, retryAt: retryAt?.toISOString() ?? null };
  } catch (err) {
    if (err instanceof GoogleRateLimitError) return fail("pending", "rate_limited", err.retryAfterSeconds);
    return fail("error", `exception:${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readTextCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) {
    const text = await res.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
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
  return Buffer.concat(chunks).toString("utf8");
}
