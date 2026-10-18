import { db } from "../../db/client.js";
import { activityEvents, conversationWatermarks } from "../../db/schema.js";
import { enqueueCollectedEventForProcessing } from "../../queue/dispatch.js";
import { activityEventTimes } from "../../lib/activity-event-time.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import {
  getComment,
  resolveActorEmails,
  type DriveActivityAction,
  type DriveComment,
} from "./gdocs-api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CommentEventType =
  | "doc_comment_added"
  | "doc_reply_added"
  | "doc_comment_deleted"
  | "doc_reply_deleted"
  | "doc_comment_resolved"
  | "doc_comment_reopened"
  | "doc_assignment_added"
  | "doc_assignment_reassigned"
  | "doc_suggestion_added"
  | "doc_suggestion_accepted"
  | "doc_suggestion_rejected"
  | "doc_suggestion_reply_added"
  | "doc_suggestion_reply_deleted"
  | "doc_suggestion_deleted";

interface ClassifiedActivity {
  activity: DriveActivityAction;
  eventType: CommentEventType;
  category: "post" | "assignment" | "suggestion";
  subtype: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  commentId: string | null;
  timestamp: string;
  actorPersonName: string | null;
  isCurrentUser: boolean;
}

type ResolvedGoogleActor = {
  email: string | null;
  name: string;
  sourceKey: string;
  googleActorId: string | null;
};

type ProcessCommentActivityOptions = {
  actorIdentityAccessToken?: string | null;
  userEmail?: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileTypeFromMime(mimeType: string): "doc" | "sheet" | "slides" {
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "sheet";
  if (mimeType === "application/vnd.google-apps.presentation") return "slides";
  return "doc";
}

function isEmailAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function resolveGoogleActor(
  item: ClassifiedActivity,
  resolvedActors: Map<string, { email: string | null; name?: string | null }>,
  userEmail: string | null | undefined,
): ResolvedGoogleActor {
  if (item.isCurrentUser && isEmailAddress(userEmail)) {
    return { email: userEmail, name: userEmail, sourceKey: userEmail, googleActorId: item.actorPersonName };
  }

  if (item.actorPersonName) {
    const resolved = resolvedActors.get(item.actorPersonName);
    if (resolved && isEmailAddress(resolved.email)) {
      return {
        email: resolved.email,
        name: resolved.name || resolved.email,
        sourceKey: resolved.email,
        googleActorId: item.actorPersonName,
      };
    }
    // Partial identity: profile name visible but email hidden (out-of-domain
    // or restricted visibility). Keep the real name; email stays null.
    if (resolved?.name) {
      return {
        email: null,
        name: resolved.name,
        sourceKey: item.actorPersonName,
        googleActorId: item.actorPersonName,
      };
    }
    return {
      email: null,
      name: "Unresolved Google actor",
      sourceKey: item.actorPersonName,
      googleActorId: item.actorPersonName,
    };
  }

  return { email: null, name: "Unknown", sourceKey: `unknown:${new Date(item.timestamp).getTime()}`, googleActorId: null };
}

function addActorMetadata(payload: Record<string, unknown>, actor: ResolvedGoogleActor): void {
  payload.actorName = actor.name;
  if (actor.email) {
    payload.actorEmail = actor.email;
    payload._actor_email = actor.email;
  }
  if (actor.googleActorId) {
    payload.googleActorId = actor.googleActorId;
    payload._google_actor_id = actor.googleActorId;
  }
}

function maybeEmail(value: string | null | undefined): string | null {
  return isEmailAddress(value) ? value : null;
}

/**
 * Classify a single Activity API action into a discrete comment event type.
 * Returns null if the activity is not a recognised comment action.
 */
function classifyCommentActivity(
  activity: DriveActivityAction,
): ClassifiedActivity | null {
  const comment = activity.primaryActionDetail?.comment as
    | {
        post?: { subtype: string };
        assignment?: { subtype: string };
        suggestion?: { subtype: string };
        mentionedUsers?: Array<{ personName: string }>;
      }
    | undefined;

  if (!comment) return null;

  // Extract targets using .find() -- targets is an array, and driveItem /
  // fileComment may be on different entries.
  const fileComment = activity.targets?.find(
    (t: Record<string, unknown>) => t.fileComment,
  )?.fileComment as
    | {
        legacyCommentId: string;
        legacyDiscussionId?: string;
        linkToDiscussion?: string;
        parent?: { legacyCommentId: string };
      }
    | undefined;

  const driveItem = activity.targets?.find(
    (t: Record<string, unknown>) => t.driveItem,
  )?.driveItem as
    | { name: string; title: string; mimeType: string }
    | undefined;

  if (!driveItem) return null;

  const fileId = driveItem.name?.replace("items/", "") ?? "";
  if (!fileId) return null;

  const fileName = driveItem.title ?? "";
  const mimeType = driveItem.mimeType ?? "";
  const commentId = fileComment?.legacyCommentId ?? null;

  // Extract timestamp -- prefer point-in-time, fall back to range endTime
  const timestamp =
    activity.timestamp ??
    activity.timeRange?.endTime ??
    new Date().toISOString();

  // Extract actor
  const knownUser = activity.actors?.[0]?.user?.knownUser;
  const actorPersonName = knownUser?.personName ?? null;
  const isCurrentUser = knownUser?.isCurrentUser ?? false;

  // Determine event type from the nested comment structure
  let eventType: CommentEventType | null = null;
  let category: "post" | "assignment" | "suggestion" | null = null;
  let subtype = "";

  if (comment.post) {
    category = "post";
    subtype = comment.post.subtype;
    switch (subtype) {
      case "ADDED":
        eventType = "doc_comment_added";
        break;
      case "REPLY_ADDED":
        eventType = "doc_reply_added";
        break;
      case "DELETED":
        eventType = "doc_comment_deleted";
        break;
      case "REPLY_DELETED":
        eventType = "doc_reply_deleted";
        break;
      case "RESOLVED":
        eventType = "doc_comment_resolved";
        break;
      case "REOPENED":
        eventType = "doc_comment_reopened";
        break;
    }
  } else if (comment.assignment) {
    category = "assignment";
    subtype = comment.assignment.subtype;
    switch (subtype) {
      case "ADDED":
        eventType = "doc_assignment_added";
        break;
      case "REASSIGNED":
        eventType = "doc_assignment_reassigned";
        break;
    }
  } else if (comment.suggestion) {
    category = "suggestion";
    subtype = comment.suggestion.subtype;
    switch (subtype) {
      case "ADDED":
        eventType = "doc_suggestion_added";
        break;
      case "ACCEPTED":
        eventType = "doc_suggestion_accepted";
        break;
      case "REJECTED":
        eventType = "doc_suggestion_rejected";
        break;
      case "REPLY_ADDED":
        eventType = "doc_suggestion_reply_added";
        break;
      case "REPLY_DELETED":
        eventType = "doc_suggestion_reply_deleted";
        break;
      case "DELETED":
      // A suggestion that was already accepted/rejected and then deleted -
      // still a deletion; the original subtype is preserved in the payload.
      case "ACCEPT_DELETED":
      case "REJECT_DELETED":
        eventType = "doc_suggestion_deleted";
        break;
    }
  }

  if (!eventType || !category) return null;

  return {
    activity,
    eventType,
    category,
    subtype,
    fileId,
    fileName,
    mimeType,
    commentId,
    timestamp,
    actorPersonName,
    isCurrentUser,
  };
}

/**
 * Build the sourceEventId for a classified comment activity.
 * Formats are defined in the refactoring plan Section 3.
 */
function buildSourceEventId(
  classified: ClassifiedActivity,
  actorKey: string,
): string {
  const { eventType, fileId, commentId, timestamp } = classified;
  const epochMs = new Date(timestamp).getTime();

  switch (eventType) {
    // commentId-only (one-time events)
    case "doc_comment_added":
      return `gdocs:comment_added:${fileId}:${commentId}`;
    case "doc_comment_deleted":
      return `gdocs:comment_deleted:${fileId}:${commentId}`;

    // commentId + epochMs (repeatable events)
    case "doc_comment_resolved":
      return `gdocs:comment_resolved:${fileId}:${commentId}:${epochMs}`;
    case "doc_comment_reopened":
      return `gdocs:comment_reopened:${fileId}:${commentId}:${epochMs}`;

    // commentId + epochMs + actorEmail (reply events -- no replyId in Activity API)
    case "doc_reply_added":
      return `gdocs:reply:${fileId}:${commentId}:${epochMs}:${actorKey}`;
    case "doc_reply_deleted":
      return `gdocs:reply_deleted:${fileId}:${commentId}:${epochMs}:${actorKey}`;

    // Assignment events
    case "doc_assignment_added":
      return `gdocs:assignment:${fileId}:${epochMs}:${actorKey}`;
    case "doc_assignment_reassigned":
      return `gdocs:reassignment:${fileId}:${epochMs}:${actorKey}`;

    // Suggestion events (no commentId in Activity API for suggestions)
    case "doc_suggestion_added":
      return `gdocs:suggestion_added:${fileId}:${epochMs}:${actorKey}`;
    case "doc_suggestion_accepted":
      return `gdocs:suggestion_accepted:${fileId}:${epochMs}:${actorKey}`;
    case "doc_suggestion_rejected":
      return `gdocs:suggestion_rejected:${fileId}:${epochMs}:${actorKey}`;
    case "doc_suggestion_reply_added":
      return `gdocs:suggestion_reply:${fileId}:${commentId}:${epochMs}:${actorKey}`;
    case "doc_suggestion_reply_deleted":
      return `gdocs:suggestion_reply_deleted:${fileId}:${commentId}:${epochMs}:${actorKey}`;
    case "doc_suggestion_deleted":
      return `gdocs:suggestion_deleted:${fileId}:${epochMs}:${actorKey}`;

    default:
      return `gdocs:comment_unknown:${fileId}:${epochMs}:${actorKey}`;
  }
}

/**
 * Build rawPayload for a comment event, enriched with data from comments.get.
 * Schemas are defined in the refactoring plan Section 9.
 */
function buildRawPayload(
  classified: ClassifiedActivity,
  actor: ResolvedGoogleActor,
  enriched: DriveComment | null,
): Record<string, unknown> {
  const fileType = fileTypeFromMime(classified.mimeType);
  const actorEmail = actor.email;
  const actorName = actor.name;

  const base = {
    fileId: classified.fileId,
    fileName: classified.fileName,
    fileType,
    _file_id: classified.fileId,
  };

  switch (classified.eventType) {
    case "doc_comment_added":
      return {
        ...base,
        commentId: classified.commentId,
        content: enriched?.content ?? null,
        authorEmail: maybeEmail(enriched?.author?.emailAddress) ?? actorEmail,
        authorName: enriched?.author?.displayName ?? actorName,
        quotedText: enriched?.quotedFileContent?.value ?? null,
        resolved: enriched?.resolved ?? false,
        assigneeEmail: null,
        createdTime: enriched?.createdTime ?? classified.timestamp,
        _author_email: maybeEmail(enriched?.author?.emailAddress) ?? actorEmail,
        ...(actor.googleActorId ? { googleActorId: actor.googleActorId, _google_actor_id: actor.googleActorId } : {}),
      };

    case "doc_reply_added": {
      // Find the latest reply from the enrichment data
      const replies = enriched?.replies ?? [];
      const latestReply = replies.length > 0 ? replies[replies.length - 1] : null;
      return {
        ...base,
        commentId: classified.commentId,
        replyId: latestReply?.id ?? null,
        content: latestReply?.content ?? null,
        authorEmail: maybeEmail(latestReply?.author?.emailAddress) ?? actorEmail,
        authorName: latestReply?.author?.displayName ?? actorName,
        parentCommentContent: enriched?.content ?? null,
        createdTime: latestReply?.createdTime ?? classified.timestamp,
        _file_id: classified.fileId,
        _author_email: maybeEmail(latestReply?.author?.emailAddress) ?? actorEmail,
        ...(actor.googleActorId ? { googleActorId: actor.googleActorId, _google_actor_id: actor.googleActorId } : {}),
      };
    }

    case "doc_comment_resolved": {
      const payload: Record<string, unknown> = {
        ...base,
        commentId: classified.commentId,
        resolvedByEmail: actorEmail,
        resolvedByName: actorName,
        originalContent: enriched?.content ?? null,
        resolvedAt: classified.timestamp,
      };
      addActorMetadata(payload, actor);
      return payload;
    }

    case "doc_comment_reopened": {
      const payload: Record<string, unknown> = {
        ...base,
        commentId: classified.commentId,
        reopenedByEmail: actorEmail,
        reopenedByName: actorName,
        originalContent: enriched?.content ?? null,
        reopenedAt: classified.timestamp,
      };
      addActorMetadata(payload, actor);
      return payload;
    }

    case "doc_comment_deleted":
    case "doc_reply_deleted": {
      const payload: Record<string, unknown> = {
        ...base,
        commentId: classified.commentId,
        replyId: classified.eventType === "doc_reply_deleted" ? null : undefined,
        deletedByEmail: actorEmail,
        deletedByName: actorName,
        deletedAt: classified.timestamp,
      };
      addActorMetadata(payload, actor);
      return payload;
    }

    case "doc_assignment_added":
    case "doc_assignment_reassigned": {
      const payload: Record<string, unknown> = {
        ...base,
        commentId: classified.commentId,
        // The actor is who assigned; we use the enriched comment to find the assignee
        // For now, the actor is the assigner; the assignee may be in mentionedUsers
        assigneeEmail: actorEmail,
        assigneeName: actorName,
        assignedByEmail: actorEmail,
        assignedByName: actorName,
        timestamp: classified.timestamp,
      };
      addActorMetadata(payload, actor);
      return payload;
    }

    case "doc_suggestion_added":
    case "doc_suggestion_accepted":
    case "doc_suggestion_rejected":
    case "doc_suggestion_reply_deleted":
    case "doc_suggestion_deleted": {
      const payload: Record<string, unknown> = {
        ...base,
        actorEmail,
        actorName,
        timestamp: classified.timestamp,
        // Distinguishes DELETED vs ACCEPT_DELETED vs REJECT_DELETED under
        // the shared doc_suggestion_deleted event type.
        activitySubtype: classified.subtype,
        suggestionContent: null, // Phase 1: content not available from Activity API
      };
      addActorMetadata(payload, actor);
      return payload;
    }

    case "doc_suggestion_reply_added": {
      const sugReplies = enriched?.replies ?? [];
      const latestSugReply =
        sugReplies.length > 0 ? sugReplies[sugReplies.length - 1] : null;
      return {
        ...base,
        commentId: classified.commentId,
        replyContent: latestSugReply?.content ?? null,
        authorEmail: maybeEmail(latestSugReply?.author?.emailAddress) ?? actorEmail,
        authorName: latestSugReply?.author?.displayName ?? actorName,
        timestamp: classified.timestamp,
        _author_email: maybeEmail(latestSugReply?.author?.emailAddress) ?? actorEmail,
        ...(actor.googleActorId ? { googleActorId: actor.googleActorId, _google_actor_id: actor.googleActorId } : {}),
      };
    }

    default: {
      const payload: Record<string, unknown> = {
        ...base,
        actorEmail,
        actorName,
        timestamp: classified.timestamp,
      };
      addActorMetadata(payload, actor);
      return payload;
    }
  }
}

// ---------------------------------------------------------------------------
// trackDocConversation -- updates conversation watermarks for the document
// ---------------------------------------------------------------------------

async function trackDocConversation(
  userId: string,
  fileId: string,
  fileName: string,
  timestamp: string,
): Promise<void> {
  await db
    .insert(conversationWatermarks)
    .values({
      userId,
      provider: "gdocs",
      conversationId: fileId,
      conversationType: "document",
      conversationName: fileName,
      lastSeenTs: timestamp,
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
        lastSeenTs: timestamp,
        lastPolledAt: new Date(),
        conversationName: fileName || undefined,
        isActive: true,
      },
    });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process Activity API comment results into discrete events.
 *
 * Called by the Cycle B orchestrator (sweepCommentActivity in gdocs.ts).
 * Returns the count of events successfully stored.
 */
export async function processCommentActivity(
  userId: string,
  activities: DriveActivityAction[],
  accessToken: string,
  options: ProcessCommentActivityOptions = {},
): Promise<number> {
  // Step 1: Classify all activities and collect actor personNames for batch resolution
  const classified: ClassifiedActivity[] = [];
  const personNames = new Set<string>();

  for (const activity of activities) {
    const result = classifyCommentActivity(activity);
    if (!result) continue;
    classified.push(result);
    if (result.actorPersonName) {
      personNames.add(result.actorPersonName);
    }
  }

  if (classified.length === 0) return 0;

  // Step 2: Batch-resolve all actor personNames to emails
  const actorMap = options.actorIdentityAccessToken
    ? await resolveActorEmails(userId, options.actorIdentityAccessToken, Array.from(personNames))
    : new Map<string, { email: string | null; name: string | null }>();

  // Step 3: Process each classified activity
  let storedCount = 0;

  for (const item of classified) {
    try {
      const actor = resolveGoogleActor(item, actorMap, options.userEmail);

      // Enrich via comments.get (if we have a commentId)
      let enriched: DriveComment | null = null;
      if (item.commentId && item.fileId) {
        try {
          enriched = await getComment(accessToken, item.fileId, item.commentId);
        } catch (err) {
          // Enrichment failure is non-fatal -- store event with available data
          console.warn(
            `Comment enrichment failed for ${item.fileId}/${item.commentId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Build sourceEventId and rawPayload
      const sourceEventId = buildSourceEventId(item, actor.sourceKey);
      const rawPayload = redactProviderPayload("google-docs", buildRawPayload(item, actor, enriched)) as Record<string, unknown>;
      const times = activityEventTimes(new Date(item.timestamp), item.timestamp);

      // Insert into activityEvents
      const [inserted] = await db
        .insert(activityEvents)
        .values({
          userId,
          source: "gdocs",
          eventType: item.eventType,
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
        // Queue for entity resolution
        await enqueueCollectedEventForProcessing(inserted.id, userId);

        // Update conversation watermarks
        await trackDocConversation(
          userId,
          item.fileId,
          item.fileName,
          item.timestamp,
        );

        storedCount++;
      }
    } catch (err) {
      console.error(
        `Failed to process comment activity (${item.eventType} on ${item.fileId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return storedCount;
}
