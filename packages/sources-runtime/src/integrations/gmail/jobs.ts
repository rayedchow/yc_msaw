import type { GmailAttachmentStats, GmailBackfillOptions } from "./poller.js";
import { runGmailSourceBackfill, runGmailSourcePoll, type GmailSourceMailboxResult, type GmailSourceRunResult } from "./source-sync.js";

// SOURCE-LANE PATCH (gmail agent): gmail.poll / gmail.backfill run the resumable full-mailbox
// engine (source-sync.ts) instead of the donor's bounded 30-day/500-message bootstrap and
// 7-day/200-message history-404 fallback. Signatures are unchanged for integrations/google/index.ts.

export async function runGmailPoll(userId: string): Promise<{ stored: number; attachments: GmailAttachmentStats; mailboxes: GmailSourceMailboxResult[] }> {
  const result = await runGmailSourcePoll(userId);
  if (result.stored > 0) {
    console.log(`Gmail poll: ${result.stored} new messages for user ${userId}`);
  }
  return { stored: result.stored, attachments: result.attachments, mailboxes: result.mailboxes };
}

/**
 * `days` / `maxMessages` from legacy payloads no longer bound capture: a bounded window can never
 * be reported as the mailbox, so every run continues the full capture (bounded work per run,
 * continued by the next queued task). Only `mailbox` (checked against the tenant roster) is honoured.
 */
export async function runGmailBackfill(userId: string, options?: GmailBackfillOptions): Promise<GmailSourceRunResult> {
  const result = await runGmailSourceBackfill(userId, options?.mailbox ? { mailbox: options.mailbox } : {});
  console.log(`Gmail backfill: ${result.stored} messages stored for user ${userId}`);
  return result;
}
