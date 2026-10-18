import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { deriveActivityEventSourceContract } from "../../db/activity-event-source.js";
import { activityEvents, conversationWatermarks, googleDocSuggestions, googleDocSyncState } from "../../db/schema.js";
import { enqueueGraphIngestForGoogleDocScopeEntry } from "../../graph/wiring/ingest-hook.js";
import { activityEventTimes } from "../../lib/activity-event-time.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import {
  getGoogleAccessToken,
  GOOGLE_DOCS_DELEGATION_SCOPES,
  GOOGLE_PEOPLE_IDENTITY_DELEGATION_SCOPES,
} from "../../vault/google-auth.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { getTokenMetadata, mergeTokenMetadata } from "../../vault/tokens.js";
import { getGoogleMailboxState, listGoogleMailboxes, updateGoogleMailboxState } from "../../integrations/google/mailboxes.js";
import {
  pollDriveChanges,
  downloadDriveFile,
  getStartPageToken,
  queryActivity,
  getFileComments,
  getDocContent,
  getDriveFileParents,
  listSharedDrives,
  listWorkspaceFiles,
  resolveActorEmails,
  WORKSPACE_MIMES,
  INTER_DOC_DELAY_MS,
  type DriveChange,
  type DriveActivityAction,
} from "./gdocs-api.js";
import { googleDocSourceDirectory } from "../../mirror/materializer.js";
import { processEditActivity } from "./gdocs-edits.js";
import { processCommentActivity } from "./gdocs-comments.js";
import { markGoogleDocSummaryDirty } from "./document-summary-tracker.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../../lib/concurrency.js";
import { intakeBinaryDocument, tombstoneBinaryDocument } from "../../integrations/binary/intake.js";

// Quota math: Drive's default per-user quota is 12,000 queries/100s (~120/s).
// Each doc costs a handful of Activity + comments calls; 8 concurrent docs
// with the inter-doc stagger stays around 10-25 requests/sec - an order of
// magnitude under the ceiling. Calendar concurrency is deliberately NOT
// raised: its 600 queries/min/user quota is the tightest of the Google APIs.
const GDOCS_BACKFILL_DOC_CONCURRENCY = parseConcurrencyEnv("GDOCS_BACKFILL_DOC_CONCURRENCY", 8, { max: 10 });
const PDF_MIME = "application/pdf";

type DriveLineageCache = Map<string, string[] | null>;

interface LineageFailureCounter {
  count: number;
}

function createLineageTracker(): { cache: DriveLineageCache; failures: LineageFailureCounter } {
  return { cache: new Map(), failures: { count: 0 } };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGdocsAccessToken(userId: string, mailbox?: string): Promise<string> {
  return getGoogleAccessToken(userId, mailbox, GOOGLE_DOCS_DELEGATION_SCOPES);
}

async function getOptionalGdocsActorIdentityAccessToken(userId: string, mailbox?: string): Promise<string | null> {
  try {
    return await getGoogleAccessToken(userId, mailbox, GOOGLE_PEOPLE_IDENTITY_DELEGATION_SCOPES);
  } catch (err) {
    console.warn(
      `[gdocs] actor identity token unavailable for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// --- Cycle A: File changes + edit activity (30s) ---

export async function pollGoogleDocs(userId: string): Promise<number> {
  // One tenant, many delegated mailboxes: each mailbox has its own Drive
  // visibility and its own changes cursor. Drive file IDs are tenant-global,
  // so overlapping visibility converges in google_doc_sync_state naturally.
  const mailboxes = await listGoogleMailboxes(userId);
  let total = 0;
  for (const mailbox of mailboxes) {
    total += await pollGoogleDocsMailbox(userId, mailbox);
  }
  return total;
}

async function pollGoogleDocsMailbox(userId: string, userEmail: string): Promise<number> {
  const tokenMetadata = await getTokenMetadata(userId, "google");
  if (!tokenMetadata) return 0;

  const state = await getGoogleMailboxState(userId, userEmail);
  const drivePageToken = state.drivePageToken ?? undefined;

  const accessToken = await getGdocsAccessToken(userId, userEmail);
  const actorIdentityAccessToken = await getOptionalGdocsActorIdentityAccessToken(userId, userEmail);
  const lineage = createLineageTracker();

  if (!drivePageToken) {
    const token = await getStartPageToken(accessToken);
    await updateGoogleMailboxState(userId, userEmail, { drivePageToken: token });
    return 0;
  }

  const lastBackfillAt = state.lastDocsBackfillAt ?? 0;
  if (lastBackfillAt && Date.now() - lastBackfillAt < 120_000) return 0;

  const { changes, newPageToken } = await pollDriveChanges(accessToken, drivePageToken);

  const docChanges = changes.filter(
    (c) => c.file && WORKSPACE_MIMES.has(c.file.mimeType) && !c.removed && !c.file.trashed,
  );
  await processDrivePdfChanges(userId, changes, accessToken);

  // Deletion propagation: `removed: true` (file deleted or access lost - no
  // file payload) and `trashed: true` changes must deactivate the watermark,
  // or the doc stays in every sweep (comments, suggestions) forever. Untrash
  // recovers naturally: the next change re-upserts isActive=true via
  // trackDocConversation.
  const deadChanges = changes.filter((c) => c.removed || c.file?.trashed);
  const deactivated = await deactivateDocConversations(userId, deadChanges.map((c) => c.fileId));
  if (deactivated > 0) {
    console.log(`Google Docs poll: deactivated ${deactivated} removed/trashed doc(s) for user ${userId}`);
  }

  // Capture-time tombstones: deletion is a capture-time-irreversible fact, so
  // each removed/trashed change also writes an explicit activity_events row
  // (same `_deleted` marker convention as the gmail poller).
  const tombstoned = await writeDocTombstones(userId, deadChanges, userEmail);
  if (tombstoned > 0) {
    console.log(`Google Docs poll: wrote ${tombstoned} deletion tombstone(s) for user ${userId}`);
  }

  // Source lane: per-file checkpoints for every live Docs/Sheets/Slides/Drive
  // file (PDFs stay in the drive-pdf lane, folders are structure), and an
  // explicit restore event when a trashed/removed file comes back.
  const restored = await recordSourceLaneLiveChanges(userId, userEmail, changes);
  if (restored > 0) {
    console.log(`Google Docs poll: wrote ${restored} restore event(s) for user ${userId}`);
  }

  let eventCount = 0;

  if (docChanges.length > 0) {
    // Fast-path freshness: the changes feed is what this 30s poll actually
    // observes, while the Activity API (the authoritative doc_edited emitter
    // below) can lag an edit by many minutes. Emit an immediate doc_edited
    // row per changed workspace file so the edit surfaces as an event as
    // promptly as the content snapshot does; the later Activity-API event for
    // the same edit is suppressed in processEditActivity.
    eventCount += await emitDocEditedEventsForChangedDocs(userId, docChanges);

    const changedFiles = new Map<string, { name: string; mimeType: string }>();
    for (const c of docChanges) {
      if (c.file) {
        changedFiles.set(c.fileId, { name: c.file.name, mimeType: c.file.mimeType });
      }
    }

    const lastEditPollAt = state.lastEditPollAt ?? new Date(Date.now() - 60_000).toISOString();
    const since = lastEditPollAt;
    const activities = await queryActivity(accessToken, {
      ancestorName: "items/root",
      since,
      pageSize: 100,
    });

    eventCount += await processEditActivity(userId, activities, accessToken, userEmail, changedFiles, {
      actorIdentityAccessToken,
    });

    for (const change of docChanges) {
      await trackDocConversation(userId, change, {
        accessToken,
        lineageCache: lineage.cache,
        lineageFailures: lineage.failures,
      });
    }

    // Maximal capture: persist the content of every changed Google Doc. The
    // Docs API fetch is deferred to a `gdocs.content-snapshot` task (deduped
    // per doc, serialized on the shared tenant:gdocs slot) - the poll itself
    // stays cheap.
    await enqueueContentSnapshotsForChangedDocs(userId, docChanges);
  }

  await updateGoogleMailboxState(userId, userEmail, { drivePageToken: newPageToken, lastEditPollAt: new Date().toISOString() });
  if (lineage.failures.count > 0) {
    console.warn(`[gdocs] poll: ${lineage.failures.count} Drive lineage lookup(s) failed for user ${userId}`);
  }

  return eventCount;
}

export interface DrivePdfChangeResult {
  stored: number;
  skipped: number;
  failedFetch: number;
  failedUnsupported: number;
  tombstoned: number;
}

export async function processDrivePdfChanges(
  userId: string,
  changes: DriveChange[],
  accessToken: string,
): Promise<DrivePdfChangeResult> {
  const result: DrivePdfChangeResult = {
    stored: 0,
    skipped: 0,
    failedFetch: 0,
    failedUnsupported: 0,
    tombstoned: 0,
  };

  for (const change of changes) {
    if (change.removed) {
      result.tombstoned += await tombstoneBinaryDocument({
        tenantId: userId,
        provider: "drive-pdf",
        externalId: change.fileId,
      });
      continue;
    }

    const file = change.file;
    if (!file) continue;
    if (file.mimeType !== PDF_MIME) continue;

    if (file.trashed) {
      result.tombstoned += await tombstoneBinaryDocument({
        tenantId: userId,
        provider: "drive-pdf",
        externalId: change.fileId,
      });
      continue;
    }

    const intake = await intakeBinaryDocument({
      tenantId: userId,
      provider: "drive-pdf",
      externalId: change.fileId,
      fetchBytes: () => downloadDriveFile(accessToken, change.fileId),
      mimeType: file.mimeType,
      versionRef: file.md5Checksum ?? file.headRevisionId ?? null,
      sourceUpdatedAt: file.modifiedTime,
      authorEmail: file.lastModifyingUser?.emailAddress ?? null,
      sourceAcl: { provider: "drive-pdf", fileId: change.fileId },
    });
    if (intake.status === "stored") result.stored++;
    if (intake.status === "skipped") result.skipped++;
    if (intake.status === "failed_fetch") result.failedFetch++;
    if (intake.status === "failed_unsupported") result.failedUnsupported++;
  }

  if (result.failedFetch > 0 || result.failedUnsupported > 0 || result.tombstoned > 0) {
    console.log(
      `[gdocs] Drive PDF intake for ${userId}: stored=${result.stored}, skipped=${result.skipped}, failed_fetch=${result.failedFetch}, failed_unsupported=${result.failedUnsupported}, tombstoned=${result.tombstoned}`,
    );
  }

  return result;
}

// --- Cycle B: Comment activity (60s, separate queue) ---

export async function sweepCommentActivity(userId: string): Promise<number> {
  const mailboxes = await listGoogleMailboxes(userId);
  let total = 0;
  for (const mailbox of mailboxes) {
    total += await sweepCommentActivityMailbox(userId, mailbox);
  }
  return total;
}

async function sweepCommentActivityMailbox(userId: string, userEmail: string): Promise<number> {
  const tokenMetadata = await getTokenMetadata(userId, "google");
  if (!tokenMetadata) return 0;

  const state = await getGoogleMailboxState(userId, userEmail);
  const lastCommentPollAt = state.lastCommentPollAt ?? new Date(Date.now() - 60_000).toISOString();
  const accessToken = await getGdocsAccessToken(userId, userEmail);
  const actorIdentityAccessToken = await getOptionalGdocsActorIdentityAccessToken(userId, userEmail);

  const activities = await queryActivity(accessToken, {
    ancestorName: "items/root",
    filter: "detail.action_detail_case:COMMENT",
    since: lastCommentPollAt,
    pageSize: 100,
  });

  const eventCount = await processCommentActivity(userId, activities, accessToken, {
    actorIdentityAccessToken,
    userEmail,
  });

  await updateGoogleMailboxState(userId, userEmail, { lastCommentPollAt: new Date().toISOString() });

  // Reactive accelerator: for docs that just saw suggestion activity, enqueue a
  // targeted suggestion-sync so authorship/timestamps land in ~60s instead of
  // waiting for the hourly full sweep. Deduped per doc; shares the tenant:gdocs
  // slot. Docs without suggestion activity never trigger a changelog fetch.
  await enqueueSuggestionSyncForSuggestionDocs(userId, activities);

  return eventCount;
}

/**
 * Extract distinct fileIds that had a suggestion-category Activity event and
 * enqueue one targeted `gdocs.suggestion-sync` per doc (deduped while queued/
 * running via dedupeKey). Best-effort: enqueue failures never break the sweep.
 */
// Rate-limit guard: cap how many distinct docs one 60s sweep can enqueue
// targeted syncs for. Each targeted sync costs ~3 API calls (1 Docs +
// tiles + load) against the shared project quota and the undocumented
// /revisions/load endpoint; without a cap, a suggestion flood across many docs
// would enqueue unboundedly. Overflow is not lost - the hourly full sweep
// (`gdocs.suggestion-sync` with no docIds) covers it within the hour.
const MAX_TARGETED_SYNC_DOCS_PER_SWEEP = Math.max(
  1,
  Math.floor(Number(process.env.GDOCS_TARGETED_SYNC_MAX_DOCS ?? 25)),
);

async function enqueueSuggestionSyncForSuggestionDocs(userId: string, activities: DriveActivityAction[]): Promise<void> {
  const docIds = new Set<string>();
  for (const activity of activities) {
    const comment = (activity.primaryActionDetail as Record<string, unknown> | undefined)?.comment as
      | { suggestion?: unknown }
      | undefined;
    if (!comment?.suggestion) continue;
    const driveItem = activity.targets?.find((t) => t.driveItem)?.driveItem;
    const fileId = driveItem?.name?.replace("items/", "");
    if (fileId) docIds.add(fileId);
  }
  if (docIds.size === 0) return;

  // Cap the burst; log what was deferred so it's never a silent truncation.
  const all = [...docIds];
  const toEnqueue = all.slice(0, MAX_TARGETED_SYNC_DOCS_PER_SWEEP);
  if (all.length > toEnqueue.length) {
    console.log(
      `[gdocs] suggestion flood: ${all.length} docs with suggestion activity for ${userId}; enqueuing ${toEnqueue.length} targeted syncs, ${all.length - toEnqueue.length} deferred to the hourly sweep.`,
    );
  }

  try {
    const { enqueueTask } = await import("../../queue/queue.js");
    for (const docId of toEnqueue) {
      await enqueueTask({
        queue: "sync",
        tenantId: userId,
        kind: "gdocs.suggestion-sync",
        groupKey: `${userId}:gdocs`,
        payload: { userId, docIds: [docId] },
        dedupeKey: `gdocs-suggestion-sync:${userId}:${docId}`,
        // Yield the shared gdocs slot to the poll (priority 0, the freshness
        // backbone) and to the scheduled full sync; stay ahead of backfill.
        priority: -5,
      });
    }
  } catch (err) {
    console.warn(`[gdocs] failed to enqueue targeted suggestion sync for ${userId}:`, err instanceof Error ? err.message : err);
  }
}

/** One Google Doc to snapshot, plus the identity metadata Drive exposed with it. */
export interface GdocsSnapshotDocRef {
  docId: string;
  modifiedTime: string | null;
  /** First Drive owner (absent for shared-drive files - they have no owner). */
  authorEmail?: string | null;
  authorName?: string | null;
  /** Drive lastModifyingUser at the time the doc was seen. */
  updatedByEmail?: string | null;
  updatedByName?: string | null;
}

/** Extract the snapshot ref (with author/updater identity) from a Drive file payload. */
function snapshotDocRef(
  docId: string,
  file: {
    modifiedTime?: string;
    lastModifyingUser?: { displayName?: string; emailAddress?: string };
    owners?: Array<{ displayName?: string; emailAddress?: string }>;
  },
): GdocsSnapshotDocRef {
  const owner = file.owners?.[0];
  return {
    docId,
    modifiedTime: file.modifiedTime ?? null,
    authorEmail: owner?.emailAddress ?? null,
    authorName: owner?.displayName ?? null,
    updatedByEmail: file.lastModifyingUser?.emailAddress ?? null,
    updatedByName: file.lastModifyingUser?.displayName ?? null,
  };
}

/**
 * Enqueue one `gdocs.content-snapshot` task per Google Doc (Docs API only -
 * Sheets/Slides have no structured-read equivalent, see the content decision
 * record). Deduped per doc while queued/running via dedupeKey, and priority
 * -5 so snapshots yield the shared tenant:gdocs slot to the poll. Each task
 * carries the doc's modifiedTime so an already-captured revision skips the
 * Docs fetch entirely (this is what makes re-runs - reconnects, repeated
 * discovery crawls - idempotent and cheap), plus the owner/lastModifyingUser
 * identity Drive exposed so the mirror envelope can carry authorship.
 * Best-effort: enqueue failures never break the caller (the next change or
 * discovery run re-triggers). Returns the number of tasks offered.
 */
export async function enqueueContentSnapshotsForDocs(userId: string, docs: GdocsSnapshotDocRef[]): Promise<number> {
  const byDoc = new Map<string, GdocsSnapshotDocRef>();
  for (const doc of docs) byDoc.set(doc.docId, doc);
  if (byDoc.size === 0) return 0;

  let enqueued = 0;
  try {
    const { enqueueTask } = await import("../../queue/queue.js");
    for (const doc of byDoc.values()) {
      await enqueueTask({
        queue: "sync",
        tenantId: userId,
        kind: "gdocs.content-snapshot",
        groupKey: `${userId}:gdocs`,
        payload: {
          userId,
          docId: doc.docId,
          modifiedTime: doc.modifiedTime,
          authorEmail: doc.authorEmail ?? null,
          authorName: doc.authorName ?? null,
          updatedByEmail: doc.updatedByEmail ?? null,
          updatedByName: doc.updatedByName ?? null,
        },
        dedupeKey: `gdocs-content-snapshot:${userId}:${doc.docId}`,
        priority: -5,
      });
      enqueued++;
    }
  } catch (err) {
    console.warn(`[gdocs] failed to enqueue content snapshot for ${userId}:`, err instanceof Error ? err.message : err);
  }
  return enqueued;
}

async function enqueueContentSnapshotsForChangedDocs(userId: string, changes: DriveChange[]): Promise<void> {
  const refs: GdocsSnapshotDocRef[] = [];
  for (const change of changes) {
    if (change.file?.mimeType !== GOOGLE_DOC_MIME) continue;
    refs.push(snapshotDocRef(change.fileId, change.file));
  }
  await enqueueContentSnapshotsForDocs(userId, refs);
}

/**
 * Explicit deletion tombstones for removed/trashed Drive changes. One
 * activity_events row per (file, kind) with a stable, immutable
 * sourceEventId (`gdocs:tombstone:<fileId>:<kind>`) so repeat deliveries
 * dedupe via the (user_id, source_event_id) unique index, and the gmail-style
 * `_deleted: true` / `_deleted_at` payload markers. `removed` covers both
 * hard deletion and access loss (Drive sends no file payload either way);
 * `trashed` is recoverable - an untrash simply resumes normal change events.
 *
 * Source-lane patch (re-trash / restore gap): the first dead episode of a file
 * keeps exactly this key; later episodes (trash -> restore -> trash) get
 * `...:<kind>:g<generation>` from the file's lifecycle checkpoint, and the
 * file's exported source files + mirror directory are tombstoned on the
 * transition so no stale copy stays live. Without a readable checkpoint the
 * legacy key is used unchanged.
 */
export async function writeDocTombstones(userId: string, changes: DriveChange[], mailbox: string | null = null): Promise<number> {
  let written = 0;
  const seen = new Set<string>();
  for (const change of changes) {
    const kind = change.removed ? "removed" : change.file?.trashed ? "trashed" : null;
    if (!kind) continue;
    const dedupe = `${change.fileId}:${kind}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const { recordDeadChange, retireFileExports } = await import("../../source-lane/providers/google-docs/lifecycle.js");
    const lifecycle = await recordDeadChange(userId, change, kind, mailbox);
    // Source-lane patch (coordinator): access lost in one mailbox while another still sees the file is not a
    // tenant-level removal - no tombstone, no export retirement.
    if (lifecycle.stillVisibleVia) continue;

    const deletedAt = new Date().toISOString();
    const times = activityEventTimes(new Date(deletedAt), change.file?.modifiedTime ?? deletedAt);
    const rawPayload = redactProviderPayload("google-docs", {
      fileId: change.fileId,
      _file_id: change.fileId,
      ...(change.file?.name ? { fileName: change.file.name, _file_name: change.file.name } : {}),
      ...(change.file?.mimeType ? { mimeType: change.file.mimeType } : {}),
      _deleted: true,
      _deleted_at: deletedAt,
      _removal_kind: kind,
    }) as Record<string, unknown>;

    const [inserted] = await db
      .insert(activityEvents)
      .values({
        userId,
        source: "gdocs",
        eventType: kind === "removed" ? "doc_removed" : "doc_trashed",
        timestamp: times.timestamp,
        sourceUpdatedAt: times.sourceUpdatedAt,
        wikiEligibilityAt: times.wikiEligibilityAt,
        rawPayload,
        sourceEventId: lifecycle.sourceEventId,
        processingStatus: "received",
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id });

    if (inserted) {
      await enqueueCollectedEventForProcessing(inserted.id, userId);
      written++;
    }
    if (lifecycle.transition ? lifecycle.transition.changed : Boolean(inserted)) {
      try {
        await retireFileExports(userId, change.fileId, kind);
      } catch (err) {
        console.warn(`[gdocs] failed to retire source exports for ${change.fileId}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return written;
}

/**
 * Source lane: record every live source-lane file on its checkpoint (Drive
 * version, mailbox, mime) and emit `doc_restored` when a file returns from
 * trash/removal. Keyed `gdocs:restored:<fileId>:g<generation>` so redelivery
 * dedupes. Fail-soft per file. Returns the number of restore events written.
 */
export async function recordSourceLaneLiveChanges(userId: string, mailbox: string | null, changes: DriveChange[]): Promise<number> {
  const { isRestore, isSourceLaneFile, recordLiveChange, restoreKey } = await import("../../source-lane/providers/google-docs/lifecycle.js");
  let written = 0;
  for (const change of changes) {
    if (change.removed || !change.file || change.file.trashed || !isSourceLaneFile(change.file.mimeType)) continue;
    let transition;
    try {
      transition = await recordLiveChange(userId, change, mailbox);
    } catch (err) {
      console.warn(`[gdocs] source checkpoint failed for ${change.fileId}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!isRestore(transition)) continue;

    const restoredAt = new Date().toISOString();
    const times = activityEventTimes(new Date(restoredAt), change.file.modifiedTime ?? restoredAt);
    const rawPayload = redactProviderPayload("google-docs", {
      fileId: change.fileId,
      _file_id: change.fileId,
      fileName: change.file.name,
      _file_name: change.file.name,
      mimeType: change.file.mimeType,
      _restored: true,
      _restored_at: restoredAt,
      _restored_from: transition.previousState,
      _lifecycle_generation: transition.generation,
    }) as Record<string, unknown>;
    const [inserted] = await db
      .insert(activityEvents)
      .values({
        userId,
        source: "gdocs",
        eventType: "doc_restored",
        timestamp: times.timestamp,
        sourceUpdatedAt: times.sourceUpdatedAt,
        wikiEligibilityAt: times.wikiEligibilityAt,
        rawPayload,
        sourceEventId: restoreKey(change.fileId, transition.generation),
        processingStatus: "received",
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id });
    if (inserted) {
      await enqueueCollectedEventForProcessing(inserted.id, userId);
      written++;
    }
  }
  return written;
}

/**
 * Fast-path `doc_edited` events straight from the Drive changes feed. This is
 * the same detection that triggers the content snapshot, so the event lands
 * with the same promptness as the mirror update instead of waiting for the
 * Drive Activity API (which consolidates and can lag an edit by ~15 minutes).
 *
 * Keying: one row per detected file version -
 * `gdocs:edit_detected:<fileId>:<headRevisionId ?? modifiedTime>` - so repeat
 * deliveries of the same revision dedupe via the (user_id, source_event_id)
 * unique index. A key literally shared with the Activity-API edit event is
 * impossible (the Activity API exposes neither revisionId nor modifiedTime;
 * the changes feed exposes neither the activity time range nor person IDs),
 * so double-counting is prevented the other way around: processEditActivity
 * skips an Activity edit already covered by one of these rows (see
 * changesFeedAlreadyCoveredEdit in gdocs-edits.ts).
 */
export const GDOCS_CHANGE_EDIT_SOURCE_PREFIX = "gdocs:edit_detected:";

export async function emitDocEditedEventsForChangedDocs(userId: string, changes: DriveChange[]): Promise<number> {
  let written = 0;
  const seen = new Set<string>();
  for (const change of changes) {
    const file = change.file;
    if (!file) continue;
    const versionRef = file.headRevisionId ?? file.modifiedTime;
    if (!versionRef) continue;
    const sourceEventId = `${GDOCS_CHANGE_EDIT_SOURCE_PREFIX}${change.fileId}:${versionRef}`;
    if (seen.has(sourceEventId)) continue;
    seen.add(sourceEventId);

    const editedAt = file.modifiedTime ?? new Date().toISOString();
    const times = activityEventTimes(new Date(editedAt), editedAt);
    const fileType =
      file.mimeType === GOOGLE_SHEET_MIME ? "sheet" : file.mimeType === GOOGLE_SLIDES_MIME ? "slides" : "doc";
    const actorEmail = file.lastModifyingUser?.emailAddress ?? null;
    const rawPayload = redactProviderPayload("google-docs", {
      fileId: change.fileId,
      fileName: file.name,
      fileType,
      timestamp: editedAt,
      actorName: file.lastModifyingUser?.displayName ?? actorEmail ?? "Unknown",
      ...(actorEmail ? { actorEmail, _actor_email: actorEmail } : {}),
      _file_id: change.fileId,
      _file_name: file.name,
      _detected_via: "changes-feed",
    }) as Record<string, unknown>;

    const [inserted] = await db
      .insert(activityEvents)
      .values({
        userId,
        source: "gdocs",
        eventType: "doc_edited",
        timestamp: times.timestamp,
        sourceUpdatedAt: times.sourceUpdatedAt,
        wikiEligibilityAt: times.wikiEligibilityAt,
        rawPayload,
        sourceEventId,
        processingStatus: "received",
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id });

    if (inserted) {
      await enqueueCollectedEventForProcessing(inserted.id, userId);
      written++;
    }
  }
  return written;
}

// --- Cycle C: Actor repair sweep (scheduled) ---

/**
 * Backfill actor identity onto events that were written while their actor was
 * unresolved (People API failure, or an identity that resolved later). Events
 * carry the raw person ID in `_google_actor_id`; resolution goes through the
 * persistent identity table, so already-known actors cost no API calls and
 * permanently invisible ones are rate-limited by their retry backoff.
 */
export async function repairUnresolvedActors(userId: string, limit = 500): Promise<number> {
  const { sql } = await import("drizzle-orm");

  const actorIdentityAccessToken = await getOptionalGdocsActorIdentityAccessToken(userId);
  if (!actorIdentityAccessToken) return 0;

  const result = await db.execute(sql`
    SELECT original.id, original.raw_payload->>'_google_actor_id' AS actor_id,
           original.raw_payload->>'actorName' AS actor_name
    FROM activity_events original
    WHERE original.user_id = ${userId}
      AND original.source = 'gdocs'
      AND original.raw_payload ? '_google_actor_id'
      AND NOT (original.raw_payload ? '_actor_email')
      AND NOT EXISTS (
        SELECT 1 FROM activity_events repair
        WHERE repair.user_id = original.user_id
          AND repair.source_event_id = 'gdocs:actor_resolved:' || original.id::text
      )
    ORDER BY original.timestamp DESC
    LIMIT ${limit}
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{
    id: string;
    actor_id: string | null;
    actor_name: string | null;
  }>;
  if (rows.length === 0) return 0;

  const personIds = [...new Set(rows.map((r) => r.actor_id).filter((id): id is string => Boolean(id)))];
  const resolved = await resolveActorEmails(userId, actorIdentityAccessToken, personIds);

  let repaired = 0;
  for (const row of rows) {
    if (!row.actor_id) continue;
    const identity = resolved.get(row.actor_id);
    if (!identity) continue;

    let patch: Record<string, unknown> | null = null;
    if (identity.email) {
      patch = { actorName: identity.name ?? identity.email, actorEmail: identity.email, _actor_email: identity.email };
    } else if (identity.name && row.actor_name === "Unresolved Google actor") {
      // Partial upgrade: real display name, email still hidden.
      patch = { actorName: identity.name };
    }
    if (!patch) continue;

    const rawPayload = redactProviderPayload("google-docs", {
      originalEventId: row.id,
      googleActorId: row.actor_id,
      ...patch,
    }) as Record<string, unknown>;
    const [inserted] = await db
      .insert(activityEvents)
      .values({
        userId,
        source: "gdocs",
        eventType: "actor_identity_resolved",
        timestamp: new Date(),
        sourceUpdatedAt: new Date(),
        wikiEligibilityAt: new Date(),
        rawPayload,
        sourceEventId: `gdocs:actor_resolved:${row.id}`,
        recordKind: "activity",
        processingStatus: "received",
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id });
    if (inserted) {
      await enqueueCollectedEventForProcessing(inserted.id, userId);
      repaired++;
    }
  }

  return repaired;
}

// --- Cycle D: Comment-edit refresh sweep (scheduled) ---

/**
 * Catch comment/reply EDITS, which the Activity API cannot signal - its `Post`
 * subtypes have no EDITED (a reworded comment emits no event). We re-list
 * comments for recently-active docs and append a versioned
 * `doc_comment_edited` observation with the current content plus a full
 * current-thread snapshot (`_currentThread`).
 *
 * Keying: `doc_comment_added` events have a deterministic
 * `gdocs:comment_added:<fileId>:<commentId>` sourceEventId, so the parent
 * comment row is reliably locatable. Reply events are NOT deterministically
 * keyable (their id embeds epoch+actor), so freshest reply text is captured
 * on the new parent-thread observation rather than by patching old replies.
 */
export async function refreshCommentEdits(userId: string, lookbackHours = 72): Promise<number> {
  const { sql } = await import("drizzle-orm");
  const accessToken = await getGdocsAccessToken(userId);

  const activeSinceIso = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const docRows = (await db.execute(sql`
    SELECT conversation_id AS file_id
    FROM conversation_watermarks
    WHERE user_id = ${userId} AND provider = 'gdocs' AND is_active = true
      AND last_seen_ts IS NOT NULL AND last_seen_ts >= ${activeSinceIso}
    ORDER BY last_seen_ts DESC
    LIMIT 200
  `)) as unknown;
  const rows = (Array.isArray(docRows) ? docRows : (docRows as { rows?: unknown[] }).rows ?? []) as Array<{ file_id: string }>;
  if (rows.length === 0) return 0;

  let updated = 0;
  for (const { file_id: fileId } of rows) {
    let comments;
    try {
      comments = await getFileComments(accessToken, fileId, activeSinceIso);
    } catch (err) {
      console.warn(`[gdocs] comment refresh: list failed for ${fileId}:`, err instanceof Error ? err.message : err);
      continue;
    }

    for (const comment of comments) {
      // Only comments actually edited after creation are candidates.
      if (!comment.modifiedTime || comment.modifiedTime === comment.createdTime) continue;

      const originalSourceEventId = `gdocs:comment_added:${fileId}:${comment.id}`;
      const found = (await db.execute(sql`
        SELECT id, raw_payload FROM activity_events
        WHERE user_id = ${userId} AND source = 'gdocs' AND source_event_id = ${originalSourceEventId}
        LIMIT 1
      `)) as unknown;
      const eventRows = (Array.isArray(found) ? found : (found as { rows?: unknown[] }).rows ?? []) as Array<{
        id: string;
        raw_payload: Record<string, unknown>;
      }>;
      const event = eventRows[0];
      if (!event) continue;

      const currentThread = {
        content: comment.content,
        resolved: comment.resolved,
        deleted: comment.deleted ?? false,
        modifiedTime: comment.modifiedTime,
        replies: (comment.replies ?? []).map((r) => ({
          content: r.content,
          authorName: r.author?.displayName ?? null,
          modifiedTime: r.modifiedTime,
          deleted: r.deleted ?? false,
        })),
      };

      const storedContent = event.raw_payload.content ?? null;
      const contentDrifted = storedContent !== comment.content;
      const patch: Record<string, unknown> = {
        content: comment.content,
        _currentThread: currentThread,
        _content_refreshed_at: new Date().toISOString(),
        ...(contentDrifted ? { _edited: true } : {}),
      };

      const rawPayload = redactProviderPayload("google-docs", {
        fileId,
        commentId: comment.id,
        originalEventId: event.id,
        ...patch,
      }) as Record<string, unknown>;
      const modifiedAt = new Date(comment.modifiedTime);
      const observedAt = Number.isNaN(modifiedAt.getTime()) ? new Date() : modifiedAt;
      const sourceEventId = `gdocs:comment_edited:${fileId}:${comment.id}:${comment.modifiedTime}`;
      const [inserted] = await db
        .insert(activityEvents)
        .values({
          userId,
          source: "gdocs",
          ...deriveActivityEventSourceContract({
            source: "gdocs",
            eventType: "doc_comment_edited",
            rawPayload,
            defaultRecordKind: "activity",
          }),
          eventType: "doc_comment_edited",
          timestamp: observedAt,
          sourceUpdatedAt: observedAt,
          wikiEligibilityAt: observedAt,
          rawPayload,
          sourceEventId,
          processingStatus: "received",
        })
        .onConflictDoNothing()
        .returning({ id: activityEvents.id });
      if (inserted) {
        await enqueueCollectedEventForProcessing(inserted.id, userId);
        if (contentDrifted) updated++;
      }
    }
  }

  return updated;
}

// --- Conversation tracking ---

export async function trackDocConversation(
  userId: string,
  change: DriveChange,
  options: {
    accessToken?: string;
    lineageCache?: DriveLineageCache;
    lineageFailures?: LineageFailureCounter;
  } = {},
): Promise<void> {
  if (change.file) {
    await markGoogleDocSummaryDirty({
      userId,
      fileId: change.fileId,
      fileName: change.file.name,
      mimeType: change.file.mimeType,
      changedAt: change.file.modifiedTime ?? new Date().toISOString(),
    });
  }

  await db
    .insert(conversationWatermarks)
    .values({
      userId,
      provider: "gdocs",
      conversationId: change.fileId,
      conversationType: "document",
      conversationName: change.file?.name ?? change.fileId,
      lastSeenTs: change.file?.modifiedTime ?? new Date().toISOString(),
      lastPolledAt: new Date(),
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [conversationWatermarks.userId, conversationWatermarks.provider, conversationWatermarks.conversationId],
      set: {
        lastSeenTs: change.file?.modifiedTime ?? new Date().toISOString(),
        lastPolledAt: new Date(),
        conversationName: change.file?.name ?? undefined,
        isActive: true,
      },
    });

  if (change.file && options.accessToken) {
    const mirrorPathPrefix = googleDocSourceDirectory(change.fileId, change.file.name);
    try {
      const lineage = await collectDriveFolderLineage(
        options.accessToken,
        change.fileId,
        change.file.parents,
        options.lineageCache ?? new Map(),
      );
      if (lineage.failures > 0) {
        if (options.lineageFailures) options.lineageFailures.count += lineage.failures;
        else console.warn(`[gdocs] lineage: ${lineage.failures} lookup(s) failed for ${change.fileId}`);
      }
      await upsertGoogleDocDriveLineage(userId, change.fileId, {
        folderIds: lineage.folderIds,
        mirrorPathPrefix,
        failureCount: lineage.failures,
      });
    } catch (err) {
      if (options.lineageFailures) options.lineageFailures.count++;
      console.warn(`[gdocs] lineage: failed for ${change.fileId}:`, err instanceof Error ? err.message : err);
      await upsertGoogleDocDriveLineage(userId, change.fileId, {
        folderIds: [],
        mirrorPathPrefix,
        failureCount: 1,
      });
    }
  }
}

async function collectDriveFolderLineage(
  accessToken: string,
  docId: string,
  directParentIds: string[] | undefined,
  cache: DriveLineageCache,
): Promise<{ folderIds: string[]; failures: number }> {
  let failures = 0;
  let parents: string[] | null | undefined = directParentIds;
  if (!parents) {
    parents = await getCachedDriveParents(accessToken, docId, cache);
    if (!parents) {
      failures++;
      parents = [];
    }
  }

  const folderIds = new Set<string>();
  const queue = [...parents];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const folderId = queue.shift()!;
    if (visited.has(folderId)) continue;
    visited.add(folderId);
    folderIds.add(folderId);

    const ancestorParents = await getCachedDriveParents(accessToken, folderId, cache);
    if (!ancestorParents) {
      failures++;
      continue;
    }
    for (const parentId of ancestorParents) {
      if (!visited.has(parentId)) queue.push(parentId);
    }
  }

  return { folderIds: [...folderIds].sort(), failures };
}

async function getCachedDriveParents(
  accessToken: string,
  fileId: string,
  cache: DriveLineageCache,
): Promise<string[] | null> {
  if (cache.has(fileId)) return cache.get(fileId) ?? null;
  let parents: string[] | null;
  try {
    parents = await getDriveFileParents(accessToken, fileId);
  } catch {
    parents = null;
  }
  cache.set(fileId, parents);
  return parents;
}

async function upsertGoogleDocDriveLineage(
  userId: string,
  docId: string,
  input: { folderIds: string[]; mirrorPathPrefix: string; failureCount: number },
): Promise<void> {
  const previousRows = rowsFromExecute<{ folder_ids: string[] | null }>(await db.execute(sql`
    SELECT folder_ids
    FROM google_doc_sync_state
    WHERE user_id = ${userId} AND doc_id = ${docId}
    LIMIT 1
  `));
  const previousFolderIds = normalizeFolderIds(previousRows[0]?.folder_ids ?? []);
  const folderIds = normalizeFolderIds(input.folderIds);
  const lineageChanged = !sameStringSet(previousFolderIds, folderIds);
  const now = new Date();

  await db.insert(googleDocSyncState).values({
    userId,
    docId,
    folderIds,
    mirrorPathPrefix: input.mirrorPathPrefix,
    driveLineageSyncedAt: now,
    driveLineageFailureCount: input.failureCount,
    syncedAt: now,
  }).onConflictDoUpdate({
    target: [googleDocSyncState.userId, googleDocSyncState.docId],
    set: {
      folderIds,
      mirrorPathPrefix: input.mirrorPathPrefix,
      driveLineageSyncedAt: now,
      driveLineageFailureCount: input.failureCount,
      syncedAt: now,
    },
  });

  if (lineageChanged) {
    await enqueueGraphIngestForGoogleDocScopeEntry(db, {
      tenantId: userId,
      docId,
      mirrorPathPrefix: input.mirrorPathPrefix,
      folderIds,
      previousFolderIds,
    });
  }
}

function normalizeFolderIds(values: readonly string[]): string[] {
  return [...new Set(values
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Mark watermarks inactive for docs that were removed or trashed. Scoped to
 * currently-active rows so repeat `removed` changes are no-ops; fileIds for
 * files we never tracked simply match nothing. Returns the number of docs
 * actually deactivated.
 *
 * Open suggestion rows for a deactivated doc are closed to `unknown` in the
 * same pass: the doc has left every sweep, so nothing else would ever stop
 * them reading as pending. Historical rows (already-terminal statuses, tab
 * events) are kept deliberately - see docs/integrations/google-docs.md.
 */
export async function deactivateDocConversations(userId: string, fileIds: string[]): Promise<number> {
  let deactivated = 0;
  for (const fileId of new Set(fileIds)) {
    const rows = await db
      .update(conversationWatermarks)
      .set({ isActive: false, lastPolledAt: new Date() })
      .where(
        and(
          eq(conversationWatermarks.userId, userId),
          eq(conversationWatermarks.provider, "gdocs"),
          eq(conversationWatermarks.conversationId, fileId),
          eq(conversationWatermarks.isActive, true),
        ),
      )
      .returning({ id: conversationWatermarks.id });
    deactivated += rows.length;
    if (rows.length > 0) {
      await db
        .update(googleDocSuggestions)
        .set({ status: "unknown", syncedAt: new Date() })
        .where(
          and(
            eq(googleDocSuggestions.userId, userId),
            eq(googleDocSuggestions.docId, fileId),
            inArray(googleDocSuggestions.status, ["pending", "modified"]),
          ),
        );
    }
  }
  return deactivated;
}

// --- Snapshot for EOD Compilation ---

export async function snapshotDoc(
  userId: string,
  fileId: string,
): Promise<{ title: string; tabs: Array<{ tabId: string; title: string; text: string }>; fullText: string } | null> {
  try {
    const accessToken = await getGdocsAccessToken(userId);
    return await getDocContent(accessToken, fileId);
  } catch {
    return null;
  }
}

// --- Backfill ---

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";

export interface GoogleDocsBackfillResult {
  filesSeen: number;
  stored: number;
  failedDocs: number;
  lineageFailures: number;
  exhausted: boolean;
  capHit: boolean;
}

export async function backfillGoogleDocsDetailed(userId: string, days: number | null = null): Promise<GoogleDocsBackfillResult> {
  const mailboxes = await listGoogleMailboxes(userId);
  let combined: GoogleDocsBackfillResult | null = null;
  for (const mailbox of mailboxes) {
    const result = await backfillGoogleDocsMailbox(userId, mailbox, days);
    if (!combined) combined = result;
    else {
      combined.filesSeen += result.filesSeen;
      combined.stored += result.stored;
      combined.failedDocs += result.failedDocs;
      combined.lineageFailures += result.lineageFailures;
      combined.exhausted = combined.exhausted && result.exhausted;
      combined.capHit = combined.capHit || result.capHit;
    }
  }
  return combined ?? { filesSeen: 0, stored: 0, failedDocs: 0, lineageFailures: 0, exhausted: true, capHit: false };
}

async function backfillGoogleDocsMailbox(userId: string, userEmail: string, days: number | null = null): Promise<GoogleDocsBackfillResult> {
  const accessToken = await getGdocsAccessToken(userId, userEmail);
  const actorIdentityAccessToken = await getOptionalGdocsActorIdentityAccessToken(userId, userEmail);
  const DRIVE_API = "https://www.googleapis.com/drive/v3";

  const since = days == null
    ? undefined
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let storedCount = 0;
  let filesSeen = 0;
  let failedDocs = 0;
  let pageToken: string | undefined;
  const lineage = createLineageTracker();

  do {
    const url = new URL(`${DRIVE_API}/files`);
    const mimeQuery = `(mimeType='${GOOGLE_DOC_MIME}' or mimeType='${GOOGLE_SHEET_MIME}' or mimeType='${GOOGLE_SLIDES_MIME}')`;
    url.searchParams.set("q", since ? `${mimeQuery} and modifiedTime > '${since}'` : mimeQuery);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,lastModifyingUser,owners(displayName,emailAddress),trashed,parents)");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("corpora", "allDrives");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const { gFetch } = await import("./gdocs-api.js");
    const res = await gFetch(url.toString(), accessToken);
    if (!res.ok) throw new Error(`Drive files.list failed (${res.status})`);

    const data = await res.json() as {
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        modifiedTime: string;
        lastModifyingUser?: { displayName: string; emailAddress: string };
        owners?: Array<{ displayName?: string; emailAddress?: string }>;
        trashed: boolean;
        parents?: string[];
      }>;
      nextPageToken?: string;
    };

    const files = (data.files ?? []).filter((file) => !file.trashed);
    filesSeen += files.length;
    const counts = await mapWithConcurrency(files, GDOCS_BACKFILL_DOC_CONCURRENCY, async (file, index) => {
      await sleep(INTER_DOC_DELAY_MS * (index % GDOCS_BACKFILL_DOC_CONCURRENCY));
      try {
        const activities = await queryActivity(accessToken, {
          itemName: `items/${file.id}`,
          since,
          pageSize: 50,
        });

        const changedFiles = new Map<string, { name: string; mimeType: string }>();
        changedFiles.set(file.id, { name: file.name, mimeType: file.mimeType });

        const editCount = await processEditActivity(userId, activities, accessToken, userEmail, changedFiles, {
          actorIdentityAccessToken,
        });

        const comments = await getFileComments(accessToken, file.id);
        // Comments from backfill are stored via the Activity API actions if present

        const commentActivities = activities.filter(
          (a) => "comment" in (a.primaryActionDetail ?? {}),
        );
        if (commentActivities.length > 0) {
          await processCommentActivity(userId, commentActivities, accessToken, {
            actorIdentityAccessToken,
            userEmail,
          });
        }

        await trackDocConversation(userId, {
          fileId: file.id,
          file: {
            name: file.name,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
            lastModifyingUser: file.lastModifyingUser,
            owners: file.owners,
            trashed: false,
            parents: file.parents,
          },
        }, {
          accessToken,
          lineageCache: lineage.cache,
          lineageFailures: lineage.failures,
        });

        await sleep(INTER_DOC_DELAY_MS);
        return editCount;
      } catch (err) {
        failedDocs++;
        console.error(`Backfill doc ${file.id}:`, err instanceof Error ? err.message : err);
        return 0;
      }
    });
    storedCount += counts.reduce((sum, count) => sum + count, 0);

    pageToken = data.nextPageToken;
  } while (pageToken);

  const freshState = await getGoogleMailboxState(userId, userEmail);
  const fields: { lastDocsBackfillAt: number; drivePageToken?: string } = { lastDocsBackfillAt: Date.now() };
  if (!freshState.drivePageToken) {
    fields.drivePageToken = await getStartPageToken(accessToken);
  }
  await updateGoogleMailboxState(userId, userEmail, fields);

  return {
    filesSeen,
    stored: storedCount,
    failedDocs,
    lineageFailures: lineage.failures.count,
    exhausted: !pageToken && failedDocs === 0,
    capHit: Boolean(pageToken),
  };
}

export async function backfillGoogleDocs(userId: string, days: number | null = null): Promise<number> {
  const result = await backfillGoogleDocsDetailed(userId, days);
  return result.stored;
}

// --- Scoped discovery (folder / Drive query / shared drives) ---

// Folder recursion bound. This is a fan-out cap on how many folders one
// discovery run will walk, not a content limit - nothing inside a visited
// folder is dropped. Runs that hit it report foldersTruncated so the caller
// can re-scope rather than silently believing the crawl was complete.
const GDOCS_DISCOVERY_MAX_FOLDERS = Number(process.env.GDOCS_DISCOVERY_MAX_FOLDERS ?? 200);
const INTER_PAGE_DELAY_MS = 200;

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DISCOVERY_MIME_QUERY = `(mimeType='${GOOGLE_DOC_MIME}' or mimeType='${GOOGLE_SHEET_MIME}' or mimeType='${GOOGLE_SLIDES_MIME}')`;

export interface GoogleDocsDiscoveryOptions {
  /** Walk these folders recursively (My Drive or shared-drive folders). */
  folderIds?: string[];
  /** Arbitrary Drive `q` fragment, ANDed with the workspace-mime + not-trashed filter. */
  query?: string;
  /** Crawl these shared drives; `"all"` enumerates every shared drive the user can see. */
  driveIds?: string[] | "all";
  /** Only track files modified in the last N days (omit for no time bound). */
  days?: number | null;
}

export interface GoogleDocsDiscoveryResult {
  mode: "folders" | "query" | "shared-drives";
  drivesScanned: number;
  foldersScanned: number;
  filesSeen: number;
  tracked: number;
  /** Content-snapshot tasks enqueued for discovered Google Docs (Docs only; Sheets/Slides have no content path). */
  snapshotsEnqueued: number;
  lineageFailures: number;
  /** True when the folder walk hit GDOCS_DISCOVERY_MAX_FOLDERS - coverage is partial. */
  foldersTruncated: boolean;
}

/**
 * Seed `conversation_watermarks` from a scoped Drive crawl. Discovery is
 * deliberately shallow: it only tracks the docs (no per-doc Activity/comment
 * fetches) - the regular poll/sweep/suggestion-sync cycles pick the docs up
 * from the watermark table on their own cadence. This is what makes it cheap
 * enough to point at a whole shared drive.
 *
 * Exactly one mode per call: folderIds, query, or driveIds.
 */
export async function discoverGoogleDocs(
  userId: string,
  opts: GoogleDocsDiscoveryOptions,
): Promise<GoogleDocsDiscoveryResult> {
  const modes = [opts.folderIds?.length ? "folders" : null, opts.query ? "query" : null, opts.driveIds ? "shared-drives" : null]
    .filter(Boolean) as Array<GoogleDocsDiscoveryResult["mode"]>;
  if (modes.length !== 1) {
    throw new Error("discoverGoogleDocs: set exactly one of folderIds, query, or driveIds");
  }
  const mode = modes[0];

  const accessToken = await getGdocsAccessToken(userId);
  const since = opts.days == null ? undefined : new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();
  const sinceClause = since ? ` and modifiedTime > '${since}'` : "";

  const result: GoogleDocsDiscoveryResult = {
    mode, drivesScanned: 0, foldersScanned: 0, filesSeen: 0, tracked: 0, snapshotsEnqueued: 0, lineageFailures: 0, foldersTruncated: false,
  };
  const lineage = createLineageTracker();

  // One files.list scope, fully paginated; every non-trashed hit is tracked,
  // and every Google Doc additionally gets a content-snapshot task so its
  // CONTENT is captured - discovery alone only seeds watermarks, and a doc
  // that never changes after discovery would otherwise never be fetched
  // (the change feed only covers docs that change). Snapshot tasks are
  // deduped per doc and skip the Docs fetch for already-captured revisions,
  // so repeat crawls / reconnects are idempotent.
  const crawl = async (q: string, driveId?: string): Promise<void> => {
    let pageToken: string | undefined;
    do {
      const page = await listWorkspaceFiles(accessToken, { q, driveId, pageToken });
      const snapshotRefs: GdocsSnapshotDocRef[] = [];
      for (const file of page.files) {
        if (file.trashed) continue;
        result.filesSeen++;
        await trackDocConversation(userId, {
          fileId: file.id,
          file: {
            name: file.name,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
            lastModifyingUser: file.lastModifyingUser,
            owners: file.owners,
            trashed: false,
            parents: file.parents,
          },
        }, {
          accessToken,
          lineageCache: lineage.cache,
          lineageFailures: lineage.failures,
        });
        result.tracked++;
        if (file.mimeType === GOOGLE_DOC_MIME) {
          snapshotRefs.push(snapshotDocRef(file.id, file));
        }
      }
      result.snapshotsEnqueued += await enqueueContentSnapshotsForDocs(userId, snapshotRefs);
      pageToken = page.nextPageToken;
      if (pageToken) await sleep(INTER_PAGE_DELAY_MS);
    } while (pageToken);
  };

  if (mode === "folders") {
    // BFS: each folder contributes its docs and its subfolders. Drive's `q`
    // can't express recursion ('X in parents' is direct children only), so
    // the walk is explicit, deduped, and bounded.
    const queue = [...new Set(opts.folderIds!)];
    const visited = new Set<string>();
    while (queue.length > 0) {
      if (result.foldersScanned >= GDOCS_DISCOVERY_MAX_FOLDERS) {
        result.foldersTruncated = true;
        console.warn(
          `[gdocs] discovery: folder walk truncated at ${GDOCS_DISCOVERY_MAX_FOLDERS} folders (${queue.length} unvisited) for user ${userId}`,
        );
        break;
      }
      const folderId = queue.shift()!;
      if (visited.has(folderId)) continue;
      visited.add(folderId);
      result.foldersScanned++;

      await crawl(`'${folderId}' in parents and ${DISCOVERY_MIME_QUERY} and trashed=false${sinceClause}`);

      let pageToken: string | undefined;
      do {
        const page = await listWorkspaceFiles(accessToken, {
          q: `'${folderId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
          pageToken,
        });
        for (const sub of page.files) if (!visited.has(sub.id)) queue.push(sub.id);
        pageToken = page.nextPageToken;
        if (pageToken) await sleep(INTER_PAGE_DELAY_MS);
      } while (pageToken);
    }
  } else if (mode === "query") {
    await crawl(`(${opts.query}) and ${DISCOVERY_MIME_QUERY} and trashed=false${sinceClause}`);
  } else {
    const driveIds = opts.driveIds === "all"
      ? (await listSharedDrives(accessToken)).map((d) => d.id)
      : [...new Set(opts.driveIds!)];
    for (const driveId of driveIds) {
      result.drivesScanned++;
      await crawl(`${DISCOVERY_MIME_QUERY} and trashed=false${sinceClause}`, driveId);
      await sleep(INTER_PAGE_DELAY_MS);
    }
  }

  result.lineageFailures = lineage.failures.count;
  return result;
}
