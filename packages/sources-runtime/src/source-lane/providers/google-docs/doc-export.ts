/**
 * Capture-time export of one Google Doc revision into source files.
 *
 * Called from the donor content-snapshot path with the documents.get JSON it
 * just fetched (already redacted: no contentUri, no signed URLs) and the image
 * bytes `storeDocImages` fetched inside the contentUri window. No re-fetch, no
 * rendering, no summaries: the native JSON is written as-is, tabs are the
 * native tab objects, images are exact bytes.
 *
 * Renames: the directory is title-derived like the donor mirror; when it
 * changes, every live exported file is re-homed (same blob) and the old path
 * gets a `moved` tombstone. Objects that disappeared from the doc (tabs,
 * images) get `removed_from_source` tombstones; history is kept.
 */
import { sql } from "drizzle-orm";
import type { FetchedDocImage } from "../../../integrations/google/gdocs/images.js";
import { collectImageRefs } from "../../../integrations/google/gdocs/images.js";
import { docDirectory, docPaths, extensionForMime } from "./paths.js";
import {
  deleteSourceFile,
  jsonBytes,
  listLiveHeads,
  moveFileExports,
  putSourceFile,
  resolveDb,
  rowsOf,
  type StoreDeps,
} from "./store.js";
import { getCheckpoint, setContentState, setExportDirectory } from "./checkpoints.js";
import { buildSnapshotDiffEvent, type DocSnapshotState } from "./snapshot-diff.js";

export interface DocContentExportInput {
  tenantId: string;
  docId: string;
  title: string;
  /** documents.get JSON AFTER `redactProviderPayload("google-docs")`. */
  redactedRaw: unknown;
  revisionId: string;
  modifiedTime: string | null;
  suggestionsAccessible: boolean;
  /** Images fetched in this run; null = image capture was not attempted / failed wholesale. */
  images: FetchedDocImage[] | null;
  imageFetchSummary?: Record<string, number> | null;
  /** files.get metadata incl. permissions (already stripped of links); null = unavailable. */
  driveMetadata?: Record<string, unknown> | null;
  driveMetadataError?: string | null;
  identity?: { authorEmail?: string | null; authorName?: string | null; updatedByEmail?: string | null; updatedByName?: string | null };
  capturedAt?: Date;
  deps?: StoreDeps;
}

export interface DocContentExportResult {
  directory: string;
  moved: number;
  written: Record<string, string>;
  removed: number;
}

interface NativeTab {
  tabProperties?: { tabId?: string; title?: string; parentTabId?: string; index?: number };
  childTabs?: NativeTab[];
  [key: string]: unknown;
}

/** Flatten the native tab tree; each entry keeps the tab object minus its children. */
export function flattenNativeTabs(raw: unknown): Array<{ tabId: string; tab: Record<string, unknown>; childTabIds: string[] }> {
  const out: Array<{ tabId: string; tab: Record<string, unknown>; childTabIds: string[] }> = [];
  const walk = (tabs: NativeTab[] | undefined) => {
    for (const tab of tabs ?? []) {
      const tabId = tab.tabProperties?.tabId;
      if (!tabId) continue;
      const { childTabs, ...rest } = tab;
      out.push({
        tabId,
        tab: rest,
        childTabIds: (childTabs ?? []).map((c) => c.tabProperties?.tabId).filter((id): id is string => Boolean(id)),
      });
      walk(childTabs);
    }
  };
  walk((raw as { tabs?: NativeTab[] } | null)?.tabs);
  return out;
}

function orderOf(modifiedTime: string | null, fallback: Date): number {
  const t = modifiedTime ? Date.parse(modifiedTime) : NaN;
  return Number.isFinite(t) ? t : fallback.getTime();
}

export async function exportDocContentFiles(input: DocContentExportInput): Promise<DocContentExportResult> {
  const capturedAt = input.capturedAt ?? new Date();
  const deps = input.deps;
  const directory = docDirectory(input.docId, input.title);
  const paths = docPaths(directory);
  const checkpoint = await getCheckpoint(input.tenantId, input.docId, deps);

  let moved = 0;
  if (checkpoint?.exportDirectory && checkpoint.exportDirectory !== directory) {
    moved = await moveFileExports({
      tenantId: input.tenantId,
      fileId: input.docId,
      fromDirectory: checkpoint.exportDirectory,
      toDirectory: directory,
      capturedAt,
    }, deps);
  }
  await setExportDirectory(input.tenantId, input.docId, directory, deps, { mimeType: "application/vnd.google-apps.document", name: input.title });

  const sourceOrder = orderOf(input.modifiedTime, capturedAt);
  const base = {
    tenantId: input.tenantId,
    fileId: input.docId,
    sourceVersion: input.revisionId,
    sourceOrder,
    sourceUpdatedAt: input.modifiedTime,
    capturedAt,
  };
  const provenance = {
    api: "docs.documents.get",
    params: { includeTabsContent: true, suggestionsViewMode: input.suggestionsAccessible ? "SUGGESTIONS_INLINE" : "PREVIEW_WITHOUT_SUGGESTIONS" },
    revisionId: input.revisionId,
    redaction: "redactProviderPayload(google-docs): contentUri and signed credential URLs replaced",
    ...(input.identity ? { identity: input.identity } : {}),
  };
  const written: Record<string, string> = {};

  written[paths.nativeDocument] = await putSourceFile({
    ...base,
    path: paths.nativeDocument,
    kind: "raw",
    contentType: "application/json",
    bytes: jsonBytes(input.redactedRaw),
    provenance,
  }, deps);

  const tabs = flattenNativeTabs(input.redactedRaw);
  const livePaths = new Set<string>([paths.nativeDocument]);
  for (const { tabId, tab, childTabIds } of tabs) {
    const path = paths.nativeTab(tabId);
    livePaths.add(path);
    written[path] = await putSourceFile({
      ...base,
      path,
      kind: "raw",
      contentType: "application/json",
      bytes: jsonBytes({ documentId: input.docId, revisionId: input.revisionId, childTabIds, tab }),
      provenance: { ...provenance, projection: "one native tab object from documents.get (childTabs referenced by id)" },
    }, deps);
  }

  // Images: exact bytes + metadata. Never a URI.
  const refIds = new Set(collectImageRefs(input.redactedRaw).map((r) => r.objectId));
  // collectImageRefs only sees objects that still carry a contentUri key; the
  // redacted JSON keeps the key with a placeholder value, so ids survive.
  for (const image of input.images ?? []) {
    const bytesPath = paths.imageBytes(image.objectId, extensionForMime(image.mimeType));
    const metaPath = paths.imageMeta(image.objectId);
    livePaths.add(bytesPath);
    livePaths.add(metaPath);
    written[bytesPath] = await putSourceFile({
      ...base,
      path: bytesPath,
      kind: "binary",
      contentType: image.mimeType ?? "application/octet-stream",
      bytes: image.bytes,
      provenance: { api: "documents.get imageProperties.contentUri (consumed in-window, never stored)", objectId: image.objectId, revisionId: input.revisionId },
    }, deps);
    written[metaPath] = await putSourceFile({
      ...base,
      path: metaPath,
      kind: "projection",
      contentType: "application/json",
      bytes: jsonBytes({
        objectId: image.objectId,
        kind: image.kind,
        altText: image.altText,
        mimeType: image.mimeType,
        sha256: image.sha256,
        sizeBytes: image.sizeBytes,
        docRevisionId: input.revisionId,
        bytesPath: bytesPath.slice(directory.length + 1),
      }),
    }, deps);
  }

  if (input.driveMetadata || input.driveMetadataError) {
    livePaths.add(paths.drive);
    written[paths.drive] = await putSourceFile({
      ...base,
      path: paths.drive,
      kind: "raw",
      contentType: "application/json",
      bytes: jsonBytes(input.driveMetadata
        ? { file: input.driveMetadata }
        : { file: null, error: input.driveMetadataError }),
      provenance: { api: "drive.files.get", note: "thumbnailLink/webContentLink/exportLinks/contentHints dropped (ephemeral or credentialed)" },
    }, deps);
  }

  // Tombstone tabs/images that are no longer in this revision. Image files are
  // only removed when the object is gone from the doc - a failed fetch keeps
  // the previous bytes live.
  let removed = 0;
  const imagesAttempted = input.images !== null;
  const fetchedIds = new Set((input.images ?? []).map((image) => image.objectId));
  for (const head of await listLiveHeads(input.tenantId, input.docId, deps)) {
    if (!head.path.startsWith(`${directory}/`)) continue;
    const isTab = head.path.startsWith(`${paths.nativeTabsDir}/`);
    const isImage = head.path.startsWith(`${paths.imagesDir}/`);
    if (!isTab && !isImage) continue;
    if (livePaths.has(head.path)) continue;
    if (isImage) {
      if (!imagesAttempted) continue;
      // Referenced but not re-fetched this run (fetch failed / over cap):
      // keep the previous bytes live. Re-fetched ids only keep this run's
      // paths, so a changed extension retires the old file.
      const keptForUnfetched = [...refIds].some((id) => {
        if (fetchedIds.has(id)) return false;
        const prefix = paths.imageBytes(id, "");
        return head.path === paths.imageMeta(id)
          || (head.path.startsWith(prefix) && /^\.[a-z0-9]+$/u.test(head.path.slice(prefix.length)));
      });
      if (keptForUnfetched) continue;
    }
    const outcome = await deleteSourceFile({
      ...base,
      path: head.path,
      reason: "removed_from_source",
    }, deps);
    if (outcome === "deleted") removed++;
  }

  await exportSnapshotDiff({ ...input, directory, capturedAt }, deps).catch((err) => {
    console.warn(`[gdocs-source] snapshot diff export failed for ${input.docId}:`, err instanceof Error ? err.message : err);
  });

  const imageFailures = (input.imageFetchSummary?.failed ?? 0) + (input.imageFetchSummary?.skippedTooLarge ?? 0);
  await setContentState(input.tenantId, input.docId, {
    state: "complete",
    reason: [
      imageFailures > 0 ? `images_not_captured:${imageFailures}` : null,
      input.images === null ? "images_not_attempted" : null,
      input.driveMetadata ? null : `drive_metadata_unavailable${input.driveMetadataError ? `:${input.driveMetadataError}` : ""}`,
    ].filter(Boolean).join(",") || null,
    version: input.revisionId,
  }, deps);

  return { directory, moved, written, removed };
}

/**
 * Diff this revision against the previous captured revision using the donor's
 * append-only google_doc_tab_snapshots rows (full content, no caps).
 */
async function exportSnapshotDiff(
  input: DocContentExportInput & { directory: string; capturedAt: Date },
  deps?: StoreDeps,
): Promise<void> {
  const db = await resolveDb(deps);
  type Row = { revision_id: string; tab_id: string; title: string; content: unknown; content_sha: string; source_updated_at: unknown; captured_at: unknown };
  const rows = rowsOf<Row>(await db.execute(sql`
    SELECT revision_id, tab_id, title, content, content_sha, source_updated_at, captured_at
    FROM google_doc_tab_snapshots
    WHERE user_id = ${input.tenantId} AND doc_id = ${input.docId}
    ORDER BY captured_at DESC, tab_id
    LIMIT 2000
  `));
  const byRevision = new Map<string, Row[]>();
  const order: string[] = [];
  for (const row of rows) {
    if (!byRevision.has(row.revision_id)) {
      byRevision.set(row.revision_id, []);
      order.push(row.revision_id);
    }
    byRevision.get(row.revision_id)!.push(row);
  }
  const toState = (revisionId: string): DocSnapshotState | null => {
    const tabRows = byRevision.get(revisionId);
    if (!tabRows || tabRows.length === 0) return null;
    const first = tabRows[0];
    const contentOf = (r: Row) => {
      const c = (typeof r.content === "string" ? JSON.parse(r.content) : r.content) as Record<string, unknown> | null;
      return c ?? {};
    };
    const firstContent = contentOf(first);
    return {
      revisionId,
      capturedAt: new Date(String(first.captured_at)).toISOString(),
      sourceUpdatedAt: first.source_updated_at ? new Date(String(first.source_updated_at)).toISOString() : null,
      title: input.title,
      updatedByEmail: (firstContent.updatedByEmail as string | undefined) ?? null,
      updatedByName: (firstContent.updatedByName as string | undefined) ?? null,
      tabs: tabRows.map((r) => {
        const c = contentOf(r);
        return {
          tabId: r.tab_id,
          tabName: r.title,
          parentTabId: (c.parentTabId as string | undefined) ?? null,
          content: typeof c.content === "string" ? c.content : "",
          contentSha: r.content_sha,
        };
      }),
    };
  };
  const current = toState(input.revisionId);
  if (!current) return;
  const currentIdx = order.indexOf(input.revisionId);
  const previous = currentIdx >= 0 && currentIdx + 1 < order.length ? toState(order[currentIdx + 1]) : null;
  const event = buildSnapshotDiffEvent(input.docId, previous, current);
  const key = `${current.capturedAt.replace(/[:.]/g, "-")}-${input.revisionId}`;
  await putSourceFile({
    tenantId: input.tenantId,
    fileId: input.docId,
    path: docPaths(input.directory).snapshotDiff(key),
    kind: "projection",
    contentType: "application/json",
    bytes: jsonBytes(event),
    sourceVersion: input.revisionId,
    sourceUpdatedAt: input.modifiedTime,
    capturedAt: input.capturedAt,
    provenance: { derivedFrom: "google_doc_tab_snapshots", sourceEventId: event.sourceEventId },
  }, deps);
}
