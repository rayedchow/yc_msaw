import type { SourceProviderModule } from "../../core/types.js";
import { slackCoverage } from "./coverage.js";
import { SLACK_EXTRA_TABLES } from "./export-map.js";

/**
 * Slack source-lane module (owned by the slack agent).
 *
 * Capture (src/integrations/slack/): Socket Mode realtime (primary; edits/deletes/reactions as
 * append-only `_ledger` rows) plus slack.discover / slack.poll, which run the restart-safe
 * history engine (history-sync.ts) under the durable per-(app, workspace, method) quota with
 * Retry-After honoured across workers.
 *
 * Export: raw activity_events rows (base messages and every ledger observation) with the default
 * raw mapping under sources/slack/_raw/; the donor channel-day and thread/session projections at
 * their mirror paths (current state folded from the ledger by src/mirror/slack-fold.ts); and the
 * 9400 lane tables: per-conversation access/coverage labels and exact file bytes + metadata under
 * sources/slack/_workspaces/<team>/ (see ./paths.ts).
 */
export const slackProvider: SourceProviderModule = {
  id: "slack",
  eventSources: ["slack"],
  mirrorRoots: ["sources/slack/"],
  extraTables: SLACK_EXTRA_TABLES,
  coverage: slackCoverage,
};
