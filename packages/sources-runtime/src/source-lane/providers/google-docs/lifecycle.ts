/**
 * Drive file lifecycle for the Docs/Drive source lane: re-trash, restore, and
 * removal fixes over the donor's one-tombstone-per-(file, kind) keying.
 *
 * Donor key `gdocs:tombstone:<fileId>:<kind>` is kept for a file's FIRST dead
 * episode (so existing rows dedupe exactly as before); every later
 * active -> trashed|removed episode gets `...:<kind>:g<generation>`, and each
 * dead -> active transition writes a `doc_restored` event keyed
 * `gdocs:restored:<fileId>:g<generation>`. Repeat deliveries of the same
 * state keep the same key, so they still dedupe on the unique index.
 *
 * On a dead transition the file's exported source files (and, for Docs, the
 * donor mirror directory) are tombstoned so no stale copy stays live; history
 * stays in the SourceStore. A restore marks the checkpoint for re-export and
 * re-materialization (content-snapshot honours `rematerialize_pending`).
 *
 * Visibility is per mailbox (`gdocs_file_visibility`, migration 9102): a `removed` change from one mailbox
 * (access lost there) retires the file only when no other mailbox of the tenant still sees it; otherwise the
 * checkpoint is re-pointed to a mailbox that does and nothing is tombstoned.
 */
import { sql } from "drizzle-orm";
import { deleteFileExports, resolveDb, rowsOf, type StoreDeps } from "./store.js";
import { getCheckpoint, recordDriveFileSeen, transitionLifecycle, type LifecycleTransition } from "./checkpoints.js";
import { GOOGLE_DOC_MIME, GOOGLE_FOLDER_MIME, PDF_MIME } from "./drive-export.js";

export interface DriveChangeLike {
  fileId: string;
  removed?: boolean;
  file?: {
    name?: string;
    mimeType?: string;
    modifiedTime?: string;
    md5Checksum?: string;
    headRevisionId?: string;
    parents?: string[];
    trashed?: boolean;
    capabilities?: { canReadRevisions?: boolean };
  };
}

export type DeadKind = "removed" | "trashed";

export function legacyTombstoneKey(fileId: string, kind: DeadKind): string {
  return `gdocs:tombstone:${fileId}:${kind}`;
}

export function tombstoneKey(fileId: string, kind: DeadKind, transition: LifecycleTransition | null): string {
  const legacy = legacyTombstoneKey(fileId, kind);
  return !transition || transition.generation <= 1 ? legacy : `${legacy}:g${transition.generation}`;
}

export function restoreKey(fileId: string, generation: number): string {
  return `gdocs:restored:${fileId}:g${generation}`;
}

/** Whether a live change belongs to this lane (Docs, Sheets, Slides, other non-PDF, non-folder files). */
export function isSourceLaneFile(mimeType: string | undefined | null): boolean {
  return Boolean(mimeType) && mimeType !== PDF_MIME && mimeType !== GOOGLE_FOLDER_MIME;
}

/**
 * Record whether `mailbox` currently sees the file and, when the feed said, whether that mailbox may read its
 * revisions (`capabilities.canReadRevisions`; owner-only attribution of history). Fail-soft (donor-test mocks have no table).
 */
export async function setFileVisibility(
  tenantId: string,
  fileId: string,
  mailbox: string | null,
  visible: boolean,
  deps?: StoreDeps,
  capabilities?: { canReadRevisions?: boolean } | null,
): Promise<void> {
  if (!mailbox) return;
  const canReadRevisions = typeof capabilities?.canReadRevisions === "boolean" ? capabilities.canReadRevisions : null;
  try {
    const db = await resolveDb(deps);
    await db.execute(sql`
      INSERT INTO gdocs_file_visibility (tenant_id, file_id, mailbox, visible, can_read_revisions, changed_at)
      VALUES (${tenantId}, ${fileId}, ${mailbox.toLowerCase()}, ${visible}, ${canReadRevisions}, now())
      ON CONFLICT (tenant_id, file_id, mailbox) DO UPDATE SET visible = EXCLUDED.visible,
        can_read_revisions = COALESCE(EXCLUDED.can_read_revisions, gdocs_file_visibility.can_read_revisions),
        changed_at = CASE WHEN gdocs_file_visibility.visible <> EXCLUDED.visible THEN now() ELSE gdocs_file_visibility.changed_at END
    `);
  } catch (err) {
    console.warn(`[gdocs-source] visibility update failed for ${fileId}:`, err instanceof Error ? err.message : err);
  }
}

/** Another mailbox of the tenant that still sees the file, if any. */
export async function otherVisibleMailbox(tenantId: string, fileId: string, mailbox: string, deps?: StoreDeps): Promise<string | null> {
  try {
    const db = await resolveDb(deps);
    const [row] = rowsOf<{ mailbox: string }>(await db.execute(sql`
      SELECT mailbox FROM gdocs_file_visibility
      WHERE tenant_id = ${tenantId} AND file_id = ${fileId} AND visible AND mailbox <> ${mailbox.toLowerCase()}
      ORDER BY changed_at DESC, mailbox ASC LIMIT 1
    `));
    return row?.mailbox ?? null;
  } catch {
    return null;
  }
}

export async function recordDeadChange(
  tenantId: string,
  change: DriveChangeLike,
  kind: DeadKind,
  mailbox: string | null,
  deps?: StoreDeps,
): Promise<{ transition: LifecycleTransition | null; sourceEventId: string; stillVisibleVia?: string }> {
  if (kind === "removed" && mailbox) {
    await setFileVisibility(tenantId, change.fileId, mailbox, false, deps);
    const other = await otherVisibleMailbox(tenantId, change.fileId, mailbox, deps);
    if (other) {
      // Access lost in this mailbox only: keep the file live and read it through a mailbox that still sees it.
      try {
        const db = await resolveDb(deps);
        await db.execute(sql`
          UPDATE gdocs_file_checkpoints SET mailbox = ${other}, updated_at = now()
          WHERE tenant_id = ${tenantId} AND file_id = ${change.fileId} AND lower(COALESCE(mailbox, '')) = ${mailbox.toLowerCase()}
        `);
      } catch (err) {
        console.warn(`[gdocs-source] checkpoint re-point failed for ${change.fileId}:`, err instanceof Error ? err.message : err);
      }
      return { transition: null, sourceEventId: legacyTombstoneKey(change.fileId, kind), stillVisibleVia: other };
    }
  }
  let transition: LifecycleTransition | null = null;
  try {
    transition = await transitionLifecycle(tenantId, change.fileId, kind, {
      mailbox,
      name: change.file?.name ?? null,
      mimeType: change.file?.mimeType ?? null,
      kind,
    }, deps);
  } catch (err) {
    console.warn(`[gdocs-source] lifecycle transition failed for ${change.fileId}:`, err instanceof Error ? err.message : err);
  }
  return { transition, sourceEventId: tombstoneKey(change.fileId, kind, transition) };
}

/** Tombstone exported files + the donor mirror directory for a dead file. */
export async function retireFileExports(
  tenantId: string,
  fileId: string,
  kind: DeadKind,
  deps?: StoreDeps,
): Promise<{ exports: number; mirrorDirectory: string | null }> {
  const checkpoint = await getCheckpoint(tenantId, fileId, deps);
  const exports = await deleteFileExports({ tenantId, fileId, reason: `drive_${kind}` }, deps);
  let mirrorDirectory: string | null = null;
  if (checkpoint?.exportDirectory && checkpoint.mimeType === GOOGLE_DOC_MIME) {
    const { deleteSourceWikiPrefix } = await import("../../../mirror/materializer.js");
    await deleteSourceWikiPrefix(tenantId, checkpoint.exportDirectory);
    mirrorDirectory = checkpoint.exportDirectory;
  }
  return { exports, mirrorDirectory };
}

/**
 * Record a live change: checkpoint (version, mailbox, mime) + lifecycle back
 * to active. Returns the transition so the caller can emit a restore event.
 */
export async function recordLiveChange(
  tenantId: string,
  change: DriveChangeLike,
  mailbox: string | null,
  deps?: StoreDeps,
): Promise<LifecycleTransition | null> {
  const file = change.file;
  if (!file || !isSourceLaneFile(file.mimeType)) return null;
  await recordDriveFileSeen(tenantId, {
    fileId: change.fileId,
    mailbox,
    mimeType: file.mimeType!,
    name: file.name ?? null,
    parents: file.parents ?? null,
    version: file.headRevisionId ?? file.md5Checksum ?? file.modifiedTime ?? null,
    modifiedTime: file.modifiedTime ?? null,
  }, deps);
  await setFileVisibility(tenantId, change.fileId, mailbox, true, deps, file.capabilities);
  return transitionLifecycle(tenantId, change.fileId, "active", { mailbox, name: file.name ?? null, mimeType: file.mimeType ?? null }, deps);
}

export function isRestore(transition: LifecycleTransition | null): transition is LifecycleTransition {
  return Boolean(transition && transition.changed && transition.state === "active"
    && (transition.previousState === "trashed" || transition.previousState === "removed"));
}
