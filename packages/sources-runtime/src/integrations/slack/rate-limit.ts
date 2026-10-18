import { createHash } from "node:crypto";

// Proactive rate limiter for Slack Web API calls. Slack's limits are per
// method, per workspace/team, per app - so buckets are keyed per
// (workspace token, method), never per method alone (a shared worker serves
// many tenants and must not let one workspace starve another's budget).
const rateBuckets = new Map<string, { calls: number; resetAt: number }>();

// Slack's 2025 non-Marketplace rate regime (changelog 2025-05-29): for
// commercially DISTRIBUTED apps that are not Slack Marketplace-listed —
// which Shepherd's Slack app is (installed on multiple workspaces,
// unpublished) — `conversations.history` and `conversations.replies` are
// capped at ~1 request/minute and 15 messages/request. Env-overridable so a
// future Marketplace listing (or internal-app reclassification) can restore
// the old ~50/min / 1,000-object tier without a code change.
// https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/
export const SLACK_HISTORY_RPM = positiveIntEnv("SLACK_HISTORY_RPM", 1);
export const SLACK_HISTORY_PAGE_LIMIT = positiveIntEnv("SLACK_HISTORY_PAGE_LIMIT", 15);

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const METHOD_TIERS: Record<string, { maxPerMin: number }> = {
  "conversations.list": { maxPerMin: 18 },
  // 2025 non-Marketplace distributed-app limit — see SLACK_HISTORY_RPM above.
  "conversations.history": { maxPerMin: SLACK_HISTORY_RPM },
  "conversations.replies": { maxPerMin: SLACK_HISTORY_RPM },
  "conversations.info": { maxPerMin: 45 },
  "users.list": { maxPerMin: 18 },
  "users.info": { maxPerMin: 90 },
  "search.messages": { maxPerMin: 18 },
  // files.slack.com downloads are not a Web API method; keep a conservative
  // per-workspace budget so attachment capture never crowds out message sync.
  "files.download": { maxPerMin: 30 },
};

/** Per-minute budget of a Web API method (same tiers as the in-process throttle). */
export function slackMethodRpm(method: string): number {
  return (METHOD_TIERS[method] ?? { maxPerMin: 40 }).maxPerMin;
}

export function slackRateBucketKey(token: string, method: string): string {
  const tokenFingerprint = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `${tokenFingerprint}:${method}`;
}

export async function slackThrottle(token: string, method: string): Promise<void> {
  const tier = METHOD_TIERS[method] ?? { maxPerMin: 40 };
  const key = slackRateBucketKey(token, method);

  // Loop until this caller claims a slot. A single wait-then-reset lets every
  // concurrent waiter wake at resetAt and fire together (observed live: 5
  // concurrent conversations.history against a 1 req/min budget → sustained
  // "ratelimited" storms); re-checking the bucket after each sleep serializes
  // the waiters onto the budget.
  for (;;) {
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      rateBuckets.set(key, { calls: 1, resetAt: now + 60_000 });
      return;
    }
    if (bucket.calls < tier.maxPerMin) {
      bucket.calls++;
      return;
    }
    await new Promise((r) => setTimeout(r, bucket.resetAt - now));
  }
}

export function resetSlackRateBucketsForTests(): void {
  rateBuckets.clear();
}
