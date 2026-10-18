import type { SourceProviderModule } from "../../core/types.js";

/**
 * Granola (MCP/API poller).
 * Baseline source-lane module written by the core lead: raw activity_events rows for
 * these sources and mirror_files rows under sources/granola/ export with the default
 * mappings (src/source-lane/export/mapping.ts). Owned by the granola integration agent
 * from here on (CONTRACT.md §5).
 */
export const granolaProvider: SourceProviderModule = {
  id: "granola",
  eventSources: ["granola"],
  mirrorRoots: ["sources/granola/"],
};
