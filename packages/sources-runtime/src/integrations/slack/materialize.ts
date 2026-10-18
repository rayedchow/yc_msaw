import { materializeSlackChannelDaySourceWiki } from "../../mirror/materializer.js";

export function slackDayKeyFromTs(ts: string): string {
  const date = new Date(Number.parseFloat(ts) * 1000);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export async function materializeSlackChannelDay(
  userId: string,
  channelId: string,
  ts: string,
): Promise<void> {
  await materializeSlackChannelDaySourceWiki(userId, {
    channelId,
    dayKey: slackDayKeyFromTs(ts),
  });
}
