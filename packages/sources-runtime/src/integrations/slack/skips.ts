// No-silent-skips accumulator. Anything the Slack capture paths cannot store
// as a raw activity_events row increments a counter here instead of a bare
// return; the next slack.poll / slack.backfill sync run drains the counters
// into its source_sync_runs result JSON as a `skips` object keyed by reason.
//
// Realtime (socket) events that cannot be attributed to any connected tenant
// are counted under SLACK_UNATTRIBUTED_SKIP_BUCKET; those worker-global counts
// are drained into whichever tenant's poll run happens next (counts only,
// never content).

const pendingSkips = new Map<string, Map<string, number>>();

export const SLACK_UNATTRIBUTED_SKIP_BUCKET = "_slack_unattributed_";

export function recordSlackSkip(userId: string, reason: string, count = 1): void {
  if (count <= 0) return;
  const bucket = pendingSkips.get(userId) ?? new Map<string, number>();
  bucket.set(reason, (bucket.get(reason) ?? 0) + count);
  pendingSkips.set(userId, bucket);
}

export function drainSlackSkips(userId: string): Record<string, number> {
  const bucket = pendingSkips.get(userId);
  if (!bucket) return {};
  pendingSkips.delete(userId);
  return Object.fromEntries(bucket);
}

export function mergeSkipCounts(...counts: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const record of counts) {
    for (const [reason, count] of Object.entries(record)) {
      merged[reason] = (merged[reason] ?? 0) + count;
    }
  }
  return merged;
}
