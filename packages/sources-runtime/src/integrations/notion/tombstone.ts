import { db } from "../../db/client.js";
import { deriveActivityEventSourceContract } from "../../db/activity-event-source.js";
import { activityEvents } from "../../db/schema.js";
import { enqueueEventProcessing } from "../../queue/dispatch.js";
import { redactProviderPayload } from "../../vault/redaction.js";

/**
 * Append-only signal-event writer for Notion lifecycle events detected outside
 * the webhook path (poll-detected trash, reconcile-detected unshares,
 * poll-detected content updates). Mirrors
 * the webhook signal-event shape (`emitNotionWebhookSignalEvent`) but with a
 * versioned dedupe key so repeated observations of the same state collapse:
 * `notion:<kind>:<externalId>:<versionRef>`.
 */
export async function emitNotionTombstoneEvent(userId: string, input: {
  /** Lifecycle event type in Notion's dotted style, e.g. "page.deleted" | "page.unshared". */
  eventType: string;
  externalId: string;
  /** Stable version reference (last_edited_time ISO when known). */
  versionRef: string;
  timestamp?: Date | null;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  const eventType = input.eventType.replace(/\W+/g, "_");
  const timestamp = input.timestamp && !Number.isNaN(input.timestamp.getTime()) ? input.timestamp : new Date();
  const sourceEventId = `notion:${eventType}:${input.externalId}:${input.versionRef}`;
  const rawPayload = redactProviderPayload("notion", input.payload) as Record<string, unknown>;

  const [inserted] = await db
    .insert(activityEvents)
    .values({
      userId,
      source: "notion",
      ...deriveActivityEventSourceContract({ source: "notion", eventType, rawPayload }),
      eventType,
      timestamp,
      sourceUpdatedAt: timestamp,
      wikiEligibilityAt: timestamp,
      rawPayload,
      sourceEventId,
      processingStatus: "received",
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });

  if (inserted?.id) {
    await enqueueEventProcessing(inserted.id, userId);
    return true;
  }
  return false;
}
