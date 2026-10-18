/**
 * Gmail source-lane configuration (environment, read at call time). Shared by the capture
 * engine (source-sync.ts) and the exporter's coverage report.
 */

export interface GmailSourceConfig {
  includeSpamTrash: boolean;
  captureRfc822: boolean;
  rfc822MaxBytes: number;
  attachmentMaxBytes: number;
  fetchConcurrency: number;
  pollMaxMessages: number;
  backfillMaxMessages: number;
  runMaxMs: number;
  historyMaxPages: number;
  listStallSeconds: number;
  blockedRetrySeconds: number;
}

function envInt(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(env[name]));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
}

function envBool(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

export function gmailSourceConfig(env: Record<string, string | undefined> = process.env): GmailSourceConfig {
  const MiB = 1024 * 1024;
  return {
    includeSpamTrash: envBool(env, "GMAIL_SOURCE_INCLUDE_SPAM_TRASH", true),
    captureRfc822: envBool(env, "GMAIL_SOURCE_CAPTURE_RFC822", true),
    rfc822MaxBytes: envInt(env, "GMAIL_SOURCE_RFC822_MAX_BYTES", 50 * MiB, 1, 1024 * MiB),
    attachmentMaxBytes: envInt(env, "GMAIL_SOURCE_ATTACHMENT_MAX_BYTES", envInt(env, "GMAIL_ATTACHMENT_MAX_BYTES", 50 * MiB, 1, 1024 * MiB), 1, 1024 * MiB),
    // Gmail allows 250 quota units/user/second; a new message costs messages.get full (5) + raw (5)
    // + 5 per detached attachment, so 4 concurrent fetches stay well under the per-user ceiling.
    fetchConcurrency: envInt(env, "GMAIL_SOURCE_FETCH_CONCURRENCY", 4, 1, 10),
    pollMaxMessages: envInt(env, "GMAIL_SOURCE_POLL_MAX_MESSAGES", 100, 1, 5_000),
    backfillMaxMessages: envInt(env, "GMAIL_SOURCE_BACKFILL_MAX_MESSAGES", 300, 1, 20_000),
    runMaxMs: envInt(env, "GMAIL_SOURCE_RUN_MAX_MS", 45_000, 1_000, 15 * 60_000),
    historyMaxPages: envInt(env, "GMAIL_SOURCE_HISTORY_MAX_PAGES", 10, 1, 1_000),
    listStallSeconds: envInt(env, "GMAIL_SOURCE_LIST_STALL_SECONDS", 180, 1, 86_400),
    blockedRetrySeconds: envInt(env, "GMAIL_SOURCE_BLOCKED_RETRY_SECONDS", 600, 1, 86_400),
  };
}
