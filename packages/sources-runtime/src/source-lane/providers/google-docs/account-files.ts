/**
 * Current content of a Sheet, Slides deck, other Drive file or Drive PDF for a roster mailbox that may only VIEW it
 * (reader or commenter), and the comments Google returns to that account. The companion of account-capture.ts (Docs):
 * the shared units (`google-docs/_drive/<class>/<file>/`, `binary/drive-pdf/<id>/`) are captured under another
 * credential (the checkpoint mailbox, the feed's mailbox), carry that identity's permission view and every byte state
 * it saw, and are served only to owners of a mailbox that may read revisions. A view-only mailbox gets its own capture,
 * made with ITS credential only, so every byte in it is what Google serves that account:
 *
 *   sources/google-docs/_accounts/<mailbox>/_drive/<sheets|slides|files|pdf>/<slug>-<hash>/
 *     drive.json        files.get as that account (its capabilities, only the permissions Google shows it; no links)
 *     content/<name>    files.export in the first format of the shared lane's preference list that the account's own
 *                       about.exportFormats offers (Google-native types), or files.get alt=media (binary files, PDFs)
 *     native.json       Sheets spreadsheets.get includeGridData=true / Slides presentations.get as that account
 *                       (requester-tagged contentUrl redacted, as in the shared lane)
 *     comments.json     Drive comments.list as that account, when Google returns comments to it (account-capture.ts)
 *     capture.json      what was captured, the credential mode, and what is not part of it
 *
 * Earlier states of these paths are this account's own consecutive captures (served to that mailbox's owner only).
 * A file whose download/copy is disabled for this account (capabilities.canDownload/canCopy false,
 * copyRequiresWriterPermission, or an effective download restriction for readers) keeps metadata and comments only:
 * no bytes, no native JSON (both are full copies of the content), state `blocked`.
 */
import { redactNativeJson, chooseExportFormat, loadExportFormatsWith, readTextCapped, DRIVE_EXPORT_MAX_BYTES, DRIVE_FILE_MAX_BYTES, DRIVE_NATIVE_JSON_MAX_BYTES, GOOGLE_SHEET_MIME, GOOGLE_SLIDES_MIME, type DriveExportLimits } from "./drive-export.js";
import { googleErrorReason } from "./google-fetch.js";
import { driveFileDirectory, driveFilePaths, extensionForMime, type DriveFileClass } from "./paths.js";
import { deleteSourceFile, jsonBytes, listLiveHeads, putSourceFile, safeSegment, storeStream, type StoreDeps, type StoredBlob } from "./store.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

export type AccountFileClass = DriveFileClass | "pdf";

/** `<account root>/_drive/<class>/<same basename as the shared unit>` (PDFs: class `pdf`). */
export function accountFileDirectory(root: string, fileClass: AccountFileClass, fileId: string, name: string | null | undefined): string {
  const shared = driveFileDirectory("files", fileId, name);
  return `${root}/_drive/${fileClass}/${shared.slice(shared.lastIndexOf("/") + 1)}`;
}

export function accountFilePaths(dir: string) {
  const base = driveFilePaths(dir);
  return { drive: base.drive, content: base.content, contentDir: base.contentDir, native: base.native, comments: `${dir}/comments.json`, capture: `${dir}/capture.json` };
}

type Download = { ok: true; blob: StoredBlob; contentType: string } | { ok: false; state: "blocked" | "error" | "partial"; reason: string; googleReason?: string | null };

async function downloadAs(
  call: (url: string) => Promise<Response>,
  tenantId: string,
  url: string,
  maxBytes: number,
  deps: StoreDeps | undefined,
): Promise<Download> {
  const res = await call(url);
  if (!res.ok) {
    const googleReason = await googleErrorReason(res);
    await res.body?.cancel().catch(() => {});
    // What Google refuses this account (403/404) is not exported for it; a 5xx is retried.
    const refused = res.status === 401 || res.status === 403 || res.status === 404;
    return { ok: false, state: refused ? "blocked" : "error", reason: `http_${res.status}${googleReason ? `:${googleReason}` : ""}`, googleReason };
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, state: "partial", reason: `over_limit:${declared}>${maxBytes}` };
  }
  const stored = await storeStream(tenantId, res.body, maxBytes, deps);
  if (stored.status === "over_limit") return { ok: false, state: "partial", reason: `over_limit:>${stored.limit}` };
  return { ok: true, blob: stored, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

export interface AccountFileBodyInput {
  tenantId: string;
  fileId: string;
  mailbox: string;
  fileClass: AccountFileClass;
  /** files.get as the account (already authorized by the caller). */
  file: Record<string, unknown> & { name?: string; mimeType?: string; modifiedTime?: string; md5Checksum?: string; sha256Checksum?: string };
  directory: string;
  call: (url: string) => Promise<Response>;
  /** Shared provenance of every file written (account, credential mode, ...). */
  provenance: Record<string, unknown>;
  base: { tenantId: string; fileId: string; sourceVersion: string; sourceOrder: number; sourceUpdatedAt: string | null; capturedAt: Date };
  live: Set<string>;
  deps?: StoreDeps;
  limits?: Partial<DriveExportLimits>;
}

export interface AccountFileBodyResult {
  state: "complete" | "partial" | "blocked" | "error" | "unsupported";
  reasons: string[];
  exportMimeType: string | null;
  method: string | null;
}

/** Content (export / media bytes) and native JSON of one non-Doc file, as the account. Never throws on Google refusals. */
export async function captureAccountFileContent(input: AccountFileBodyInput): Promise<AccountFileBodyResult> {
  const limits: DriveExportLimits = {
    mediaMaxBytes: input.limits?.mediaMaxBytes ?? DRIVE_FILE_MAX_BYTES,
    exportMaxBytes: input.limits?.exportMaxBytes ?? DRIVE_EXPORT_MAX_BYTES,
    nativeJsonMaxBytes: input.limits?.nativeJsonMaxBytes ?? DRIVE_NATIVE_JSON_MAX_BYTES,
  };
  const { file, fileId, tenantId, deps } = input;
  const mimeType = String(file.mimeType ?? "");
  const paths = accountFilePaths(input.directory);
  const reasons: string[] = [];
  let state: AccountFileBodyResult["state"] = "complete";
  let format: string | null = null;
  let method: string | null = null;
  const put = async (path: string, kind: "raw" | "binary", contentType: string, data: { blob?: StoredBlob; bytes?: Uint8Array }, extra: Record<string, unknown>) => {
    input.live.add(path);
    await putSourceFile({ ...input.base, path, kind, contentType, ...data, provenance: { ...input.provenance, ...extra } }, deps);
  };

  if (mimeType.startsWith("application/vnd.google-apps.")) {
    const formats = await loadExportFormatsWith(tenantId, input.mailbox, input.call);
    format = chooseExportFormat(mimeType, formats);
    if (!format) {
      state = "unsupported";
      reasons.push(`no_export_format_offered:${mimeType}`);
    } else {
      const exportUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/export`);
      exportUrl.searchParams.set("mimeType", format);
      method = "files.export";
      let got = await downloadAs(input.call, tenantId, exportUrl.toString(), limits.exportMaxBytes, deps);
      if (!got.ok && got.googleReason === "exportSizeLimitExceeded") {
        // The account's own exportLinks (requester-scoped, used in-process, never stored), as the shared lane does.
        const link = ((file.exportLinks ?? {}) as Record<string, string>)[format];
        method = "exportLinks (files.export over its 10 MB limit; URL used in-process, not stored)";
        got = link ? await downloadAs(input.call, tenantId, link, limits.exportMaxBytes, deps) : { ok: false, state: "partial", reason: "export_size_limit_exceeded_no_export_link" };
      }
      if (got.ok) {
        await put(paths.content(`${safeSegment(String(file.name ?? "export"), "export")}${extensionForMime(format)}`), "binary", format, { blob: got.blob }, { api: method, exportMimeType: format, sourceMimeType: mimeType });
      } else {
        state = got.state;
        reasons.push(`export:${got.reason}`);
      }
    }
    const nativeUrl = mimeType === GOOGLE_SHEET_MIME
      ? `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}?includeGridData=true`
      : mimeType === GOOGLE_SLIDES_MIME
        ? `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(fileId)}`
        : null;
    if (nativeUrl) {
      const res = await input.call(nativeUrl);
      if (res.ok) {
        const declared = Number(res.headers.get("content-length"));
        const text = Number.isFinite(declared) && declared > limits.nativeJsonMaxBytes ? null : await readTextCapped(res, limits.nativeJsonMaxBytes);
        if (text === null) {
          if (state === "complete") state = "partial";
          reasons.push(`native_json_over_limit:${limits.nativeJsonMaxBytes}`);
        } else {
          await put(paths.native, "raw", "application/json", { bytes: jsonBytes(redactNativeJson(JSON.parse(text))) }, {
            api: mimeType === GOOGLE_SHEET_MIME ? "sheets.spreadsheets.get includeGridData=true" : "slides.presentations.get",
            redaction: "contentUri/contentUrl/signed URLs replaced",
          });
        }
      } else {
        const why = await googleErrorReason(res);
        await res.body?.cancel().catch(() => {});
        const refused = res.status === 403 || res.status === 404;
        if (state === "complete") state = refused ? "blocked" : "partial";
        reasons.push(`native_json_http_${res.status}${why ? `:${why}` : ""}`);
      }
    }
  } else {
    const mediaUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
    mediaUrl.searchParams.set("alt", "media");
    mediaUrl.searchParams.set("supportsAllDrives", "true");
    method = "files.get alt=media";
    const got = await downloadAs(input.call, tenantId, mediaUrl.toString(), limits.mediaMaxBytes, deps);
    if (got.ok) {
      const name = input.fileClass === "pdf" && !/\.pdf$/i.test(String(file.name ?? "")) ? `${safeSegment(String(file.name ?? fileId), "file")}.pdf` : safeSegment(String(file.name ?? fileId), "file");
      await put(paths.content(name), "binary", mimeType || got.contentType, { blob: got.blob }, {
        api: method, driveMd5: typeof file.md5Checksum === "string" ? file.md5Checksum : null, driveSha256: file.sha256Checksum ?? null,
      });
      if (typeof file.sha256Checksum === "string" && file.sha256Checksum !== got.blob.sha256) {
        state = "error";
        reasons.push("sha256_mismatch_with_drive_metadata");
      }
    } else {
      state = got.state;
      reasons.push(`media:${got.reason}`);
    }
  }
  return { state, reasons, exportMimeType: format, method };
}

/** Tombstone this account copy's content/native files the current capture did not write (rename, format change, restriction). */
export async function retireStaleAccountContent(
  tenantId: string,
  fileId: string,
  directory: string,
  live: ReadonlySet<string>,
  meta: { sourceOrder: number; capturedAt: Date; reason: string },
  deps?: StoreDeps,
): Promise<void> {
  const paths = accountFilePaths(directory);
  for (const head of await listLiveHeads(tenantId, fileId, deps)) {
    if (live.has(head.path)) continue;
    if (head.path.startsWith(`${paths.contentDir}/`) || head.path === paths.native) {
      await deleteSourceFile({ tenantId, fileId, path: head.path, reason: meta.reason, sourceOrder: meta.sourceOrder, capturedAt: meta.capturedAt }, deps);
    }
  }
}
