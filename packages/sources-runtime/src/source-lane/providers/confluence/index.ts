import type { SourceProviderModule } from "../../core/types.js";

/**
 * Confluence (Nango records).
 * Baseline source-lane module written by the core lead: raw activity_events rows for
 * these sources and mirror_files rows under sources/confluence/ export with the default
 * mappings (src/source-lane/export/mapping.ts). Owned by the confluence integration agent
 * from here on (CONTRACT.md §5).
 */
export const confluenceProvider: SourceProviderModule = {
  id: "confluence",
  eventSources: ["confluence"],
  mirrorRoots: ["sources/confluence/"],
};
