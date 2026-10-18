import type { SourceProviderModule } from "../../core/types.js";

/**
 * Notion (OAuth poller + webhooks + native store).
 * Baseline source-lane module written by the core lead: raw activity_events rows for
 * these sources and mirror_files rows under sources/notion/ export with the default
 * mappings (src/source-lane/export/mapping.ts). Owned by the notion integration agent
 * from here on (CONTRACT.md §5).
 */
export const notionProvider: SourceProviderModule = {
  id: "notion",
  eventSources: ["notion", "notion_comments_api", "notion_enhanced_markdown"],
  mirrorRoots: ["sources/notion/"],
};
