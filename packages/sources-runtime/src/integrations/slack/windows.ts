import { mirrorSlackChannelWindows } from "../../mirror/backfill.js";
import { enqueueTask } from "../../queue/queue.js";

export const SLACK_WINDOWS_DEDUPE_BUCKET_MS = 5 * 60 * 1000;

export async function enqueueSlackChannelWindows(
  tenantId: string,
  channelId: string,
  nowMs = Date.now(),
): Promise<string | null> {
  const bucket = Math.floor(nowMs / SLACK_WINDOWS_DEDUPE_BUCKET_MS);
  return enqueueTask({
    queue: "sync",
    tenantId,
    kind: "slack.windows",
    payload: { tenantId, channelId },
    groupKey: `${tenantId}:slack-windows:${channelId}`,
    dedupeKey: `${tenantId}:slack-windows:${channelId}:${bucket}`,
  });
}

export async function runSlackWindowsTask(
  payload: Record<string, unknown>,
  taskTenantId: string,
): Promise<Record<string, unknown>> {
  const tenantId = String(payload.tenantId ?? payload.userId ?? taskTenantId);
  const channelId = typeof payload.channelId === "string" ? payload.channelId.trim() : "";
  if (!tenantId || !channelId) throw new Error("slack.windows requires tenantId and channelId");

  const result = await mirrorSlackChannelWindows(tenantId, channelId);
  return {
    files: result.files.length,
    threadFiles: result.threads.writtenPaths.length,
    sessionFiles: result.sessions.writtenPaths.length,
    crumbsSkipped: result.threads.crumbsSkipped + result.sessions.crumbsSkipped,
  };
}
