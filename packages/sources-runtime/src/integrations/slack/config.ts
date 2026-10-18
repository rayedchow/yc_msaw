// Socket Mode is the PRIMARY Slack capture path: as a distributed
// non-Marketplace app, conversations.history/replies are limited to
// ~1 request/min (see rate-limit.ts), so the poller can only be a slow
// gap-fill/reconcile lane and realtime must carry freshness. Realtime is
// therefore ON by default — set SLACK_SOCKET_MODE_ENABLED=false to opt out.
// (startSlackSockets still no-ops with a log when SLACK_APP_TOKEN is unset.)
export function slackSocketModeEnabled(): boolean {
  const value = process.env.SLACK_SOCKET_MODE_ENABLED?.trim().toLowerCase();
  return value !== "false" && value !== "0";
}

export function slackPollingDisabledBySocketModeResult() {
  return {
    disabled: false,
    reason: "Socket Mode is the primary capture path; polling remains the gap-fill reconciliation floor.",
  };
}

export function slackQueueJobDisabledBySocketMode(jobName: string | undefined): boolean {
  void jobName;
  return false;
}
