import type { SourceProviderModule } from "../../core/types.js";
import { gmailCoverage } from "./coverage.js";
import { GMAIL_EXTRA_TABLES } from "./export-map.js";

/**
 * Gmail source-lane module (owned by the gmail agent).
 *
 * Capture: src/integrations/gmail/source-sync.ts (gmail.poll / gmail.backfill via jobs.ts):
 * resumable full-mailbox capture + History API deltas per (tenant, mailbox), quota keyed by the
 * upstream mailbox. Export: the 9160 tables (messages, attachments, threads, history pages) under
 * sources/gmail/<mailbox>/ (see ./paths.ts) with exact raw JSON, RFC822 and attachment bytes plus
 * readable projections. Legacy donor rows (activity_events source "gmail", donor mirror files under
 * sources/gmail/{inbox,sent,archive}/) still export with the default mappings.
 */
export const gmailProvider: SourceProviderModule = {
  id: "gmail",
  eventSources: ["gmail"],
  mirrorRoots: ["sources/gmail/"],
  extraTables: GMAIL_EXTRA_TABLES,
  coverage: gmailCoverage,
};
