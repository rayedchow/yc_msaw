import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { activityEvents, conversationWatermarks } from "../../db/schema.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import { activityEventTimes } from "../../lib/activity-event-time.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import type { DriveActivityAction } from "./gdocs-api.js";
import { resolveActorEmails, getFileMetadata } from "./gdocs-api.js";
import { markGoogleDocSummaryDirty } from "./document-summary-tracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileTypeFromMime(mimeType: string): "doc" | "sheet" | "slides" {
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "sheet";
  if (mimeType === "application/vnd.google-apps.presentation") return "slides";
  return "doc";
}

type ResolvedGoogleActor = {
  email: string | null;
  name: string;
  sourceKey: string;
  googleActorId: string | null;
};

type ProcessEditActivityOptions = {
  actorIdentityAccessToken?: string | null;
};

function isEmailAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function resolveGoogleActor(
  knownUser: { personName?: string; isCurrentUser?: boolean } | undefined,
  resolvedActors: Map<string, { email: string | null; name?: string | null }>,
  userEmail: string,
  fallbackKey: string,
): ResolvedGoogleActor {
  if (knownUser?.isCurrentUser && isEmailAddress(userEmail)) {
    return { email: userEmail, name: userEmail, sourceKey: userEmail, googleActorId: knownUser.personName ?? null };
  }

  if (knownUser?.personName) {
    const resolved = resolvedActors.get(knownUser.personName);
    if (resolved && isEmailAddress(resolved.email)) {
      return {
        email: resolved.email,
        name: resolved.name || resolved.email,
        sourceKey: resolved.email,
        googleActorId: knownUser.personName,
      };
    }
    // Partial identity: profile name visible but email hidden (out-of-domain
    // or restricted visibility). Keep the real name; email stays null.
    if (resolved?.name) {
      return {
        email: null,
        name: resolved.name,
        sourceKey: knownUser.personName,
        googleActorId: knownUser.personName,
      };
    }
    return {
      email: null,
      name: "Unresolved Google actor",
      sourceKey: knownUser.personName,
      googleActorId: knownUser.personName,
    };
  }

  return { email: null, name: "Unknown", sourceKey: fallbackKey, googleActorId: null };
}

function assignActorPayload(rawPayload: Record<string, unknown>, actor: ResolvedGoogleActor): void {
  rawPayload.actorName = actor.name;
  if (actor.email) {
    rawPayload.actorEmail = actor.email;
    rawPayload._actor_email = actor.email;
  }
  if (actor.googleActorId) {
    rawPayload.googleActorId = actor.googleActorId;
    rawPayload._google_actor_id = actor.googleActorId;
  }
}

/**
 * Extract the action type from an activity's primaryActionDetail.
 * Exactly one key among edit, create, rename, permissionChange will be present.
 */
type ActionType = "edit" | "create" | "rename" | "permissionChange" | "move" | "delete" | "restore" | "settingsChange";

function extractActionType(
  primaryActionDetail: Record<string, unknown>,
): ActionType | null {
  if ("edit" in primaryActionDetail) return "edit";
  if ("create" in primaryActionDetail) return "create";
  if ("rename" in primaryActionDetail) return "rename";
  if ("permissionChange" in primaryActionDetail) return "permissionChange";
  if ("move" in primaryActionDetail) return "move";
  if ("delete" in primaryActionDetail) return "delete";
  if ("restore" in primaryActionDetail) return "restore";
  if ("settingsChange" in primaryActionDetail) return "settingsChange";
  return null;
}

function eventTypeForAction(action: ActionType): string {
  switch (action) {
    case "edit": return "doc_edited";
    case "create": return "doc_created";
    case "rename": return "doc_renamed";
    case "permissionChange": return "doc_shared";
    case "move": return "doc_moved";
    case "delete": return "doc_trashed";
    case "restore": return "doc_restored";
    case "settingsChange": return "doc_settings_changed";
  }
}

function sourceIdPrefixForAction(action: ActionType): string {
  switch (action) {
    case "edit": return "edit";
    case "create": return "create";
    case "rename": return "rename";
    case "permissionChange": return "share";
    case "move": return "move";
    case "delete": return "delete";
    case "restore": return "restore";
    case "settingsChange": return "settings";
  }
}

/**
 * Extract the best timestamp from an activity.
 * Prefer point-in-time `timestamp`; fall back to `timeRange.endTime`.
 */
function resolvePermissionTarget(
  perm: { role?: string; user?: { knownUser?: { personName: string; isCurrentUser: boolean } }; group?: { email?: string }; domain?: { name?: string }; anyone?: unknown },
  userEmail: string,
  resolvedActors: Map<string, { email: string | null }>,
): { email: string | null; key: string; googleActorId: string | null; targetType: "user" | "group" | "domain" | "anyone" } {
  if (perm.anyone !== undefined) {
    return { email: null, key: "anyone_with_link", googleActorId: null, targetType: "anyone" };
  }
  if (perm.domain) {
    const domain = perm.domain.name ?? "domain";
    return { email: null, key: domain, googleActorId: null, targetType: "domain" };
  }
  if (perm.group) {
    const email = isEmailAddress(perm.group.email) ? perm.group.email : null;
    return { email, key: email ?? "group", googleActorId: null, targetType: "group" };
  }
  const knownUser = perm.user?.knownUser;
  if (knownUser?.isCurrentUser && isEmailAddress(userEmail)) {
    return { email: userEmail, key: userEmail, googleActorId: knownUser.personName ?? null, targetType: "user" };
  }
  if (knownUser?.personName) {
    const resolved = resolvedActors.get(knownUser.personName);
    const email = isEmailAddress(resolved?.email) ? resolved.email : null;
    return { email, key: email ?? knownUser.personName, googleActorId: knownUser.personName, targetType: "user" };
  }
  return { email: null, key: "unknown", googleActorId: null, targetType: "user" };
}

function extractTimestamp(activity: DriveActivityAction): string {
  if (activity.timestamp) return activity.timestamp;
  if (activity.timeRange?.endTime) return activity.timeRange.endTime;
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Changes-feed dedupe for edit activities
// ---------------------------------------------------------------------------

// The poll's changes feed emits a fast `doc_edited` row
// (`gdocs:edit_detected:<fileId>:<version>`, see emitDocEditedEventsForChangedDocs)
// as soon as it sees a changed file - typically minutes before the Activity
// API reports the same edit. To keep one row per edit, an Activity edit whose
// time window already contains a changes-feed row for the same file (with
// slack for consolidation drift) is skipped. A literally shared
// source_event_id is impossible: the Activity API exposes neither revisionId
// nor modifiedTime, and the changes feed exposes neither the activity time
// range nor actor person IDs. Actor guard: when both sides know an email and
// they differ, the rows are different actors' edits and both are kept.
// Activities older than the lookback (backfill re-scans) skip the lookup -
// changes-feed rows only exist for edits the live poll saw.
const CHANGES_FEED_EDIT_DEDUPE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const CHANGES_FEED_EDIT_DEDUPE_SLACK_MS = 3 * 60 * 1000;

async function changesFeedAlreadyCoveredEdit(
  userId: string,
  fileId: string,
  activity: DriveActivityAction,
  actorEmail: string | null,
): Promise<boolean> {
  const endMs = new Date(extractTimestamp(activity)).getTime();
  if (!Number.isFinite(endMs) || Date.now() - endMs > CHANGES_FEED_EDIT_DEDUPE_MAX_AGE_MS) return false;
  const startRaw = activity.timeRange ? new Date(activity.timeRange.startTime).getTime() : endMs;
  const startMs = Number.isFinite(startRaw) ? startRaw : endMs;
  const windowStart = new Date(startMs - CHANGES_FEED_EDIT_DEDUPE_SLACK_MS).toISOString();
  const windowEnd = new Date(endMs + CHANGES_FEED_EDIT_DEDUPE_SLACK_MS).toISOString();

  const result = (await db.execute(sql`
    SELECT raw_payload->>'actorEmail' AS actor_email
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'gdocs'
      AND event_type = 'doc_edited'
      AND source_event_id LIKE ${`gdocs:edit_detected:${fileId}:%`}
      AND source_updated_at >= ${windowStart}::timestamptz
      AND source_updated_at <= ${windowEnd}::timestamptz
    LIMIT 5
  `)) as unknown;
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{
    actor_email: string | null;
  }>;
  return rows.some((row) => !actorEmail || !row.actor_email || row.actor_email === actorEmail);
}

// ---------------------------------------------------------------------------
// Track doc conversation watermark
// ---------------------------------------------------------------------------

async function trackDocConversation(
  userId: string,
  fileId: string,
  fileName: string,
  mimeType: string,
  modifiedTime: string,
): Promise<void> {
  await markGoogleDocSummaryDirty({
    userId,
    fileId,
    fileName,
    mimeType,
    changedAt: modifiedTime,
  });

  await db
    .insert(conversationWatermarks)
    .values({
      userId,
      provider: "gdocs",
      conversationId: fileId,
      conversationType: "document",
      conversationName: fileName,
      lastSeenTs: modifiedTime,
      lastPolledAt: new Date(),
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [
        conversationWatermarks.userId,
        conversationWatermarks.provider,
        conversationWatermarks.conversationId,
      ],
      set: {
        lastSeenTs: modifiedTime,
        lastPolledAt: new Date(),
        conversationName: fileName,
        isActive: true,
      },
    });
}

// ---------------------------------------------------------------------------
// Main entry point - called by Cycle A orchestrator
// ---------------------------------------------------------------------------

/**
 * Process Activity API edit/create/rename/share results into discrete events.
 *
 * Returns the count of events successfully stored.
 */
export async function processEditActivity(
  userId: string,
  activities: DriveActivityAction[],
  accessToken: string,
  userEmail: string,
  changedFiles?: Map<string, { name: string; mimeType: string }>,
  options: ProcessEditActivityOptions = {},
): Promise<number> {
  if (activities.length === 0) return 0;

  // ------------------------------------------------------------------
  // 1. Collect all unique actor personNames for batch resolution
  // ------------------------------------------------------------------
  const personNames: string[] = [];
  for (const activity of activities) {
    const knownUser = activity.actors[0]?.user?.knownUser;
    if (knownUser && !knownUser.isCurrentUser && knownUser.personName) {
      personNames.push(knownUser.personName);
    }
  }

  const resolvedActors = options.actorIdentityAccessToken
    ? await resolveActorEmails(userId, options.actorIdentityAccessToken, [...new Set(personNames)])
    : new Map<string, { email: string | null; name: string | null }>();

  // ------------------------------------------------------------------
  // 2. Process each activity into one or more events
  // ------------------------------------------------------------------
  let eventCount = 0;

  for (const activity of activities) {
    try {
      // Extract target file info via .find() - NOT index access
      const driveItem = activity.targets.find((t) => t.driveItem)?.driveItem;
      const fileId = driveItem?.name?.replace("items/", "");
      if (!fileId) continue;

      // Determine action type
      const actionType = extractActionType(activity.primaryActionDetail);
      if (!actionType) continue;

      // Extract timestamp
      const ts = extractTimestamp(activity);
      const epochMs = new Date(ts).getTime();

      // Resolve actor identity. Keep unresolved Google People IDs out of email fields.
      const knownUser = activity.actors[0]?.user?.knownUser;
      const actor = resolveGoogleActor(knownUser, resolvedActors, userEmail, `unknown:${epochMs}`);

      // Get file metadata - prefer changedFiles map, then driveItem, then API
      let fileName: string;
      let mimeType: string;

      const cached = changedFiles?.get(fileId);
      if (cached) {
        fileName = cached.name;
        mimeType = cached.mimeType;
      } else if (driveItem?.title && driveItem?.mimeType) {
        fileName = driveItem.title;
        mimeType = driveItem.mimeType;
      } else {
        // Fallback: fetch file metadata via API
        const meta = await getFileMetadata(accessToken, fileId);
        if (!meta) continue;
        fileName = meta.name;
        mimeType = meta.mimeType;
      }

      const fileType = fileTypeFromMime(mimeType);
      const eventType = eventTypeForAction(actionType);
      const sourcePrefix = sourceIdPrefixForAction(actionType);

      // ------------------------------------------------------------------
      // Handle permissionChange specially - one event per shared user
      // ------------------------------------------------------------------
      if (actionType === "permissionChange") {
        const permChange = activity.primaryActionDetail.permissionChange as {
          addedPermissions?: Array<{
            role?: string;
            user?: { knownUser?: { personName: string; isCurrentUser: boolean } };
          }>;
          removedPermissions?: Array<{
            role?: string;
            user?: { knownUser?: { personName: string; isCurrentUser: boolean } };
          }>;
        } | undefined;

        // Process both added and removed permissions
        const allPermEvents: Array<{
          permEventType: string;
          targetEmail: string | null;
          targetKey: string;
          targetGoogleActorId: string | null;
          targetType: "user" | "group" | "domain" | "anyone";
          role: string;
        }> = [];

        for (const perm of permChange?.addedPermissions ?? []) {
          const { email, key, googleActorId, targetType } = resolvePermissionTarget(perm, userEmail, resolvedActors);
          allPermEvents.push({
            permEventType: "doc_shared",
            targetEmail: email,
            targetKey: key,
            targetGoogleActorId: googleActorId,
            targetType,
            role: perm.role ?? "unknown",
          });
        }

        for (const perm of permChange?.removedPermissions ?? []) {
          const { email, key, googleActorId, targetType } = resolvePermissionTarget(perm, userEmail, resolvedActors);
          allPermEvents.push({
            permEventType: "doc_unshared",
            targetEmail: email,
            targetKey: key,
            targetGoogleActorId: googleActorId,
            targetType,
            role: perm.role ?? "unknown",
          });
        }

        for (const permEvent of allPermEvents) {
          const sourceEventId = `gdocs:${sourcePrefix}:${fileId}:${epochMs}:${actor.sourceKey}:${permEvent.targetKey}:${permEvent.permEventType}`;
          const times = activityEventTimes(new Date(ts), ts);

          const rawPayload: Record<string, unknown> = {
            fileId,
            fileName,
            fileType,
            sharedWithEmail: permEvent.targetEmail,
            sharedWithRole: permEvent.role,
            permissionTargetType: permEvent.targetType,
            timestamp: ts,
            _file_id: fileId,
            _file_name: fileName,
          };
          assignActorPayload(rawPayload, actor);
          if (permEvent.targetGoogleActorId) {
            rawPayload.sharedWithGoogleActorId = permEvent.targetGoogleActorId;
          }
          const redactedRawPayload = redactProviderPayload("google-docs", rawPayload) as Record<string, unknown>;

          const [inserted] = await db
            .insert(activityEvents)
            .values({
              userId,
              source: "gdocs",
              eventType: permEvent.permEventType,
              timestamp: times.timestamp,
              sourceUpdatedAt: times.sourceUpdatedAt,
              wikiEligibilityAt: times.wikiEligibilityAt,
              rawPayload: redactedRawPayload,
              sourceEventId,
              processingStatus: "received",
            })
            .onConflictDoNothing()
            .returning({ id: activityEvents.id });

          if (inserted) {
            await enqueueCollectedEventForProcessing(inserted.id, userId);
            await trackDocConversation(userId, fileId, fileName, mimeType, ts);
            eventCount++;
          }
        }

        continue;
      }

      // ------------------------------------------------------------------
      // Non-permissionChange actions: edit, create, rename
      // ------------------------------------------------------------------
      // Skip edits the changes-feed fast path already surfaced (the poll
      // emitted a doc_edited row minutes ago); see the dedupe note above.
      if (actionType === "edit" && (await changesFeedAlreadyCoveredEdit(userId, fileId, activity, actor.email))) {
        continue;
      }

      const timeKey = activity.timeRange
        ? `${new Date(activity.timeRange.startTime).getTime()}:${epochMs}`
        : String(epochMs);
      const sourceEventId = `gdocs:${sourcePrefix}:${fileId}:${timeKey}:${actor.sourceKey}`;
      const times = activityEventTimes(new Date(ts), ts);

      // Build rawPayload per Section 9 schemas
      const rawPayload: Record<string, unknown> = {
        fileId,
        fileName,
        fileType,
        timestamp: ts,
        _file_id: fileId,
        _file_name: fileName,
      };
      assignActorPayload(rawPayload, actor);

      if (activity.timeRange) {
        rawPayload._timeRangeStart = activity.timeRange.startTime;
        rawPayload._timeRangeEnd = activity.timeRange.endTime;
      }

      // For rename, include old title
      if (actionType === "rename") {
        const renameDetail = activity.primaryActionDetail.rename as {
          oldTitle?: string;
          newTitle?: string;
        } | undefined;
        if (renameDetail?.oldTitle) {
          rawPayload.oldName = renameDetail.oldTitle;
        }
        // Use the new title as the fileName if available
        if (renameDetail?.newTitle) {
          rawPayload.fileName = renameDetail.newTitle;
          rawPayload._file_name = renameDetail.newTitle;
        }
      }
      const redactedRawPayload = redactProviderPayload("google-docs", rawPayload) as Record<string, unknown>;

      const [inserted] = await db
        .insert(activityEvents)
        .values({
          userId,
          source: "gdocs",
          eventType,
          timestamp: times.timestamp,
          sourceUpdatedAt: times.sourceUpdatedAt,
          wikiEligibilityAt: times.wikiEligibilityAt,
          rawPayload: redactedRawPayload,
          sourceEventId,
          processingStatus: "received",
        })
        .onConflictDoNothing()
        .returning({ id: activityEvents.id });

      if (inserted) {
        await enqueueCollectedEventForProcessing(inserted.id, userId);
        await trackDocConversation(userId, fileId, fileName, mimeType, ts);
        eventCount++;
      }
    } catch (err) {
      console.error(
        "processEditActivity: failed to process activity:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return eventCount;
}
