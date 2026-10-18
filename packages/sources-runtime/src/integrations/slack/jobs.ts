import {
  discoverConversations,
  discoverConversationsDetailed,
  pollConversationsDetailed,
  pollThreads,
} from "./poller.js";
import type { PollOptions, SlackConversationDiscoveryResult, SlackPollConversationsResult } from "./poller.js";
import { drainSlackSkips, mergeSkipCounts, SLACK_UNATTRIBUTED_SKIP_BUCKET } from "./skips.js";

// No-silent-skips: everything the capture paths (poller, realtime sockets,
// file lane) counted since the last run lands in this run's sync-run result
// JSON as `skips`, keyed by reason. Unattributed realtime drops are worker-
// global counts and drain into whichever tenant's run happens next.
function drainSkipsForRun(tenantId: string): Record<string, number> {
  return mergeSkipCounts(drainSlackSkips(tenantId), drainSlackSkips(SLACK_UNATTRIBUTED_SKIP_BUCKET));
}

export async function runSlackDiscover(userId: string): Promise<SlackConversationDiscoveryResult> {
  const result = await discoverConversationsDetailed(userId);
  const catchUpConversationCount = result.catchUpConversationIds.length;
  console.log(`Slack discover: found ${result.discovered} conversations, identified catch-up for ${catchUpConversationCount} conversations for user ${userId}`);
  return result;
}

export async function runSlackPoll(userId: string, options?: PollOptions): Promise<{
  messagesStored: number;
  threadRepliesStored: number;
  processed: number;
  failed: number;
  exhausted: boolean;
  capHit: boolean;
  skips: Record<string, number>;
}> {
  const messageResult = await pollConversationsDetailed(userId, options);
  const msgCount = messageResult.stored;
  const threadCount = await pollThreads(userId);
  if (msgCount > 0 || threadCount > 0) {
    console.log(`Slack poll: ${msgCount} new messages, ${threadCount} new thread replies for user ${userId}`);
  }
  return {
    messagesStored: msgCount,
    threadRepliesStored: threadCount,
    processed: msgCount + threadCount,
    failed: 0,
    exhausted: messageResult.exhausted,
    capHit: messageResult.capHit,
    skips: drainSkipsForRun(userId),
  };
}

export interface SlackBackfillResult extends SlackPollConversationsResult {
  discoveredConversations: number;
  threadRepliesStored: number;
  skips: Record<string, number>;
}

export async function runSlackBackfill(userId: string, options?: PollOptions): Promise<SlackBackfillResult> {
  const conversationCount = await discoverConversations(userId);
  const fetchAllThreadReplies = options?.fetchAllThreadReplies ?? true;
  const messageResult = await pollConversationsDetailed(userId, {
    ...options,
    fetchAllThreadReplies,
  });
  const threadCount = await pollThreads(userId, options?.conversationIds ? { channelIds: options.conversationIds } : undefined);
  console.log(`Slack backfill: discovered ${conversationCount} conversations, ${messageResult.stored} messages, ${threadCount} thread replies for user ${userId}`);
  return {
    ...messageResult,
    discoveredConversations: conversationCount,
    threadRepliesStored: threadCount,
    skips: drainSkipsForRun(userId),
  };
}
