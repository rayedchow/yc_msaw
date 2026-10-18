/**
 * Source paths for the Google Docs/Drive provider.
 *
 * Docs live in the donor mirror's own entity directory
 * (`googleDocSourceDirectory`: `sources/google-docs/<title-slug>-doc-<hash>`),
 * next to the donor's `tabs/*.md` + `raw.md`, so one doc is one directory:
 *
 *   drive.json                         Drive metadata + permissions (no links/URIs)
 *   native/document.json               documents.get JSON (post-redaction: no contentUri)
 *   native/tabs/<tabId>.json           each tab's native JSON
 *   images/<objectId>.<ext>|.json      embedded image bytes + metadata
 *   history/changelog/status.json      changelog completeness (complete|partial|blocked|error)
 *   history/changelog/pages/<a>-<b>.json  raw /revisions/load pages
 *   history/changelog/tiles.json       raw /revisions/tiles (revision grouping, users)
 *   history/operations.jsonl           parsed ops, true-order replay effects
 *   history/revision-chunks.json       donor replayWithDiffs per Google revision tile
 *   history/sessions/<key>.json        5-minute per-user session diff events
 *   history/states/<sha256>.txt        replayed tab text referenced by sessions
 *   history/suggestions.json           changelog suggestion lifecycle (tracker)
 *   history/suggestion-cards.json      donor google_doc_suggestions rows
 *   history/tabs.json                  tab tree + attributed tab events
 *   history/snapshot-diffs/<rev>.json  documents.get revision-to-revision diffs
 *
 * Other Drive files: `sources/google-docs/_drive/<sheets|slides|files>/<slug>-<hash>/`
 * (core reserves `_raw/` for the raw event ledger; `_drive` cannot collide with a
 * doc directory, which always ends in `-doc-<hash>`).
 */
import { createHash } from "node:crypto";
import { googleDocSourceDirectory } from "../../../mirror/materializer.js";
import { GOOGLE_DOCS_SOURCE_ROOT, safeSegment } from "./store.js";

export function docDirectory(docId: string, title: string | null | undefined): string {
  return googleDocSourceDirectory(docId, title);
}

function pad(n: number): string {
  return String(n).padStart(7, "0");
}

export function docPaths(dir: string) {
  return {
    drive: `${dir}/drive.json`,
    nativeDocument: `${dir}/native/document.json`,
    nativeTabsDir: `${dir}/native/tabs`,
    nativeTab: (tabId: string) => `${dir}/native/tabs/${safeSegment(tabId, "tab")}.json`,
    imagesDir: `${dir}/images`,
    imageBytes: (objectId: string, ext: string) => `${dir}/images/${safeSegment(objectId, "image")}${ext}`,
    imageMeta: (objectId: string) => `${dir}/images/${safeSegment(objectId, "image")}.json`,
    historyDir: `${dir}/history`,
    changelogStatus: `${dir}/history/changelog/status.json`,
    changelogPagesDir: `${dir}/history/changelog/pages`,
    changelogPage: (start: number, end: number) => `${dir}/history/changelog/pages/${pad(start)}-${pad(end)}.json`,
    changelogTiles: `${dir}/history/changelog/tiles.json`,
    operations: `${dir}/history/operations.jsonl`,
    revisionChunks: `${dir}/history/revision-chunks.json`,
    sessionsDir: `${dir}/history/sessions`,
    session: (key: string) => `${dir}/history/sessions/${safeSegment(key, "session")}.json`,
    state: (sha: string) => `${dir}/history/states/${sha}.txt`,
    suggestions: `${dir}/history/suggestions.json`,
    suggestionCards: `${dir}/history/suggestion-cards.json`,
    tabs: `${dir}/history/tabs.json`,
    snapshotDiff: (revisionKey: string) => `${dir}/history/snapshot-diffs/${safeSegment(revisionKey, "revision")}.json`,
  };
}

export type DriveFileClass = "sheets" | "slides" | "files";

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-$/u, "");
}

export function driveFileDirectory(fileClass: DriveFileClass, fileId: string, name: string | null | undefined): string {
  const hash = createHash("sha256").update(fileId).digest("hex").slice(0, 12);
  const s = slug(name ?? "") || "untitled";
  return `${GOOGLE_DOCS_SOURCE_ROOT}/_drive/${fileClass}/${s}-${hash}`;
}

export function driveFilePaths(dir: string) {
  return {
    drive: `${dir}/drive.json`,
    content: (fileName: string) => `${dir}/content/${safeSegment(fileName, "content")}`,
    contentDir: `${dir}/content`,
    native: `${dir}/native.json`,
    status: `${dir}/export-status.json`,
  };
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/x-vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "text/plain": ".txt",
  "application/zip": ".zip",
  "application/vnd.google-apps.script+json": ".json",
  "application/json": ".json",
};

export function extensionForMime(mime: string | null | undefined): string {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return EXT_BY_MIME[base] ?? ".bin";
}
