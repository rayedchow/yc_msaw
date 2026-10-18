import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { googleCalendarWatchChannels } from "../../../db/schema.js";
import { enqueueCustomerBackendJob } from "../../../queue/dispatch.js";
import {
  GOOGLE_CALENDAR_QUEUE,
  googleCalendarChannelTokenHash,
} from "./common.js";

export const googleCalendarWebhook = new Hono();

googleCalendarWebhook.post("/", async (c) => {
  const result = await handleGoogleCalendarWebhook({
    channelId: c.req.header("x-goog-channel-id"),
    channelToken: c.req.header("x-goog-channel-token"),
    resourceId: c.req.header("x-goog-resource-id"),
    resourceState: c.req.header("x-goog-resource-state"),
    resourceUri: c.req.header("x-goog-resource-uri"),
    messageNumber: c.req.header("x-goog-message-number"),
  });

  if (result.status === 204) return c.body(null, 204);
  return c.json(result.body, result.status);
});

export async function handleGoogleCalendarWebhook(input: {
  channelId?: string | null;
  channelToken?: string | null;
  resourceId?: string | null;
  resourceState?: string | null;
  resourceUri?: string | null;
  messageNumber?: string | null;
}): Promise<
  | { status: 204; body?: undefined }
  | { status: 400 | 401 | 404 | 409; body: Record<string, unknown> }
> {
  const channelId = cleanHeader(input.channelId);
  if (!channelId) return { status: 400, body: { error: "Missing X-Goog-Channel-ID" } };

  const [channel] = await db
    .select()
    .from(googleCalendarWatchChannels)
    .where(and(
      eq(googleCalendarWatchChannels.channelId, channelId),
      eq(googleCalendarWatchChannels.status, "active"),
    ))
    .limit(1);

  if (!channel) return { status: 404, body: { error: "Unknown Google Calendar channel" } };

  const resourceId = cleanHeader(input.resourceId);
  if (resourceId && resourceId !== channel.resourceId) {
    return { status: 409, body: { error: "Google Calendar resource mismatch" } };
  }

  const channelToken = cleanHeader(input.channelToken);
  if (!channelToken || googleCalendarChannelTokenHash(channelToken) !== channel.tokenHash) {
    return { status: 401, body: { error: "Invalid Google Calendar channel token" } };
  }

  const resourceState = cleanHeader(input.resourceState);
  const messageNumber = cleanHeader(input.messageNumber);

  await db
    .update(googleCalendarWatchChannels)
    .set({
      lastMessageNumber: messageNumber,
      lastNotificationAt: new Date(),
      resourceUri: cleanHeader(input.resourceUri) ?? channel.resourceUri,
      updatedAt: new Date(),
    })
    .where(eq(googleCalendarWatchChannels.channelId, channel.channelId));

  await enqueueCustomerBackendJob(GOOGLE_CALENDAR_QUEUE, "calendar.poll", {
    userId: channel.userId,
    channelId: channel.channelId,
    resourceState,
    messageNumber,
  });

  return { status: 204 };
}

function cleanHeader(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}
