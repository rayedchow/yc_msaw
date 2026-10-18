import type { SourceProviderModule } from "../../core/types.js";

/**
 * Slack (socket mode + poller).
 * Baseline source-lane module written by the core lead: raw activity_events rows for
 * these sources and mirror_files rows under sources/slack/ export with the default
 * mappings (src/source-lane/export/mapping.ts). Owned by the slack integration agent
 * from here on (CONTRACT.md §5).
 */
export const slackProvider: SourceProviderModule = {
  id: "slack",
  eventSources: ["slack"],
  mirrorRoots: ["sources/slack/"],
};
