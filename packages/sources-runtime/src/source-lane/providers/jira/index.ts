import type { SourceProviderModule } from "../../core/types.js";

/**
 * Jira (Nango records + proxy details).
 * Baseline source-lane module written by the core lead: raw activity_events rows for
 * these sources and mirror_files rows under sources/jira/ export with the default
 * mappings (src/source-lane/export/mapping.ts). Owned by the jira integration agent
 * from here on (CONTRACT.md §5).
 */
export const jiraProvider: SourceProviderModule = {
  id: "jira",
  eventSources: ["jira"],
  mirrorRoots: ["sources/jira/"],
};
