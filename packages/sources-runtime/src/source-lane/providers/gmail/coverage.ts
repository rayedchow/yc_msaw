import { listGoogleMailboxes } from "../../../integrations/google/mailboxes.js";
import { readQuotaState, type QuotaState } from "../../../integrations/gmail/source-quota.js";
import { listSyncStates, mailboxCounts, type MailboxCounts, type MailboxSyncState } from "../../../integrations/gmail/source-store.js";
import type { CoverageReport, CoverageState, ExportContext } from "../../core/types.js";

/**
 * Truthful Gmail coverage, computed from the durable sync state (never from static claims).
 * A mailbox is `complete` only when its current full-capture generation finished (listing +
 * absent sweep + no queued fetches), history was checked recently, nothing is owed (attachment /
 * RFC822 bytes), and no error or cooldown is active. Anything else is `partial` with the reason.
 */

export const HISTORY_LAG_SECONDS = 15 * 60;

export interface CoverageDecision {
  state: CoverageState;
  reason: string;
}

export function decideMailboxCoverage(
  state: MailboxSyncState | null,
  counts: MailboxCounts,
  quota: QuotaState,
  opts: { now?: Date; lagSeconds?: number } = {},
): CoverageDecision {
  const now = opts.now ?? new Date();
  const lag = opts.lagSeconds ?? HISTORY_LAG_SECONDS;
  if (state?.blockedCode) return { state: "blocked", reason: `${state.blockedCode}: ${state.blockedReason ?? "access blocked"}` };
  if (!state || state.generation === 0) return { state: "pending", reason: "full mailbox capture has not started" };
  const problems: string[] = [];
  if (state.fullCompleteGeneration !== state.generation) {
    const why = state.generationReason === "history_expired" ? "re-sync after the Gmail history cursor expired" : state.generationReason === "reset" ? "re-sync" : "initial full capture";
    problems.push(
      `${why} in progress (generation ${state.generation}; ${state.listPagesDone} list pages, ${state.listMessagesSeen} message ids listed` +
        `${state.listExhaustedAt ? ", listing finished, completing" : ""}); only messages captured so far are present`,
    );
  }
  if (counts.pendingFetches > 0) problems.push(`${counts.pendingFetches} message fetches failed and are queued for retry`);
  if (!state.historyCheckedAt) problems.push("history.list has not succeeded yet");
  else if (now.getTime() - state.historyCheckedAt.getTime() > lag * 1000) problems.push(`history last checked ${state.historyCheckedAt.toISOString()} (lagging)`);
  if (state.errorStreak > 0 && state.lastError) problems.push(`last run failed: ${state.lastError}`);
  if (quota.cooldownUntil && quota.cooldownUntil.getTime() > now.getTime()) problems.push(`Gmail rate limited for this mailbox until ${quota.cooldownUntil.toISOString()}`);
  const owedAttachments = counts.attachmentsPending + counts.attachmentsFailed;
  if (owedAttachments > 0) problems.push(`${owedAttachments} attachment byte captures pending/failed`);
  if (counts.attachmentsOversize > 0) problems.push(`${counts.attachmentsOversize} attachments over the size cap (metadata only)`);
  if (counts.attachmentsUnavailable > 0) problems.push(`${counts.attachmentsUnavailable} attachments unavailable upstream`);
  if (counts.rfc822Pending + counts.rfc822Failed > 0) problems.push(`${counts.rfc822Pending + counts.rfc822Failed} RFC822 captures pending/failed`);
  if (counts.rfc822Oversize > 0) problems.push(`${counts.rfc822Oversize} RFC822 messages over the size cap`);
  if (state.listIncludeSpamTrash === false) problems.push("this generation listed without SPAM and TRASH (GMAIL_SOURCE_INCLUDE_SPAM_TRASH=0)");
  const notes: string[] = [];
  if (counts.rfc822Withheld > 0) notes.push(`${counts.rfc822Withheld} RFC822 files withheld because redaction changed the JSON payload`);
  if (counts.rfc822Disabled > 0) notes.push(`${counts.rfc822Disabled} RFC822 files not captured (disabled by configuration)`);
  if (problems.length) return { state: "partial", reason: [...problems, ...notes].join("; ") };
  return {
    state: "complete",
    reason: [
      `every message present at generation ${state.generation} start (historyId ${state.generationStartHistoryId}) captured; changes since tracked through history.list`,
      ...notes,
    ].join("; "),
  };
}

export async function gmailCoverage(ctx: ExportContext): Promise<CoverageReport[]> {
  const roster = await listGoogleMailboxes(ctx.tenantId, ctx.executor);
  const states = new Map((await listSyncStates(ctx.executor, ctx.tenantId)).map((s) => [s.mailbox, s]));
  const reports: CoverageReport[] = [];
  if (roster.length === 0) {
    reports.push({ provider: "gmail", scope: "mailboxes", state: "pending", reason: "no active Google mailbox connection for this tenant" });
  }
  for (const mailbox of roster) {
    const state = states.get(mailbox) ?? null;
    const counts = await mailboxCounts(ctx.executor, ctx.tenantId, mailbox);
    const quota = state?.quotaKey ? await readQuotaState(ctx.executor, state.quotaKey) : { cooldownUntil: null, rateLimitStreak: 0 };
    const decision = decideMailboxCoverage(state, counts, quota);
    reports.push({
      provider: "gmail",
      scope: `mailbox:${mailbox}`,
      state: decision.state,
      reason: decision.reason,
      ...(state?.historyId ? { cursor: `historyId:${state.historyId}` } : {}),
      ...(state?.historyCheckedAt ? { lastSuccessAt: state.historyCheckedAt.toISOString() } : {}),
      ...(state?.lastErrorAt && state.errorStreak > 0 ? { lastErrorAt: state.lastErrorAt.toISOString(), lastError: state.lastError ?? undefined } : {}),
      counts: { ...counts, generation: state?.generation ?? 0, historyResets: state?.historyResets ?? 0 },
    });
  }
  // Mailboxes that left the roster keep their captured files but are no longer updated.
  for (const [mailbox, state] of states) {
    if (roster.includes(mailbox)) continue;
    reports.push({
      provider: "gmail",
      scope: `mailbox:${mailbox}`,
      state: "blocked",
      reason: "mailbox is no longer an active Google connection of this tenant; previously captured files are not being updated",
      ...(state.historyId ? { cursor: `historyId:${state.historyId}` } : {}),
    });
  }
  return reports;
}
