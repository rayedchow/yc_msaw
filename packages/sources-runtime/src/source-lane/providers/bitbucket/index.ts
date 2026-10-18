import type { SourceProviderModule } from "../../core/types.js";

/**
 * Bitbucket (Nango records + proxy issues/details).
 * Baseline source-lane module written by the core lead: raw activity_events rows for
 * these sources and mirror_files rows under sources/bitbucket/ export with the default
 * mappings (src/source-lane/export/mapping.ts). Owned by the bitbucket integration agent
 * from here on (CONTRACT.md §5).
 */
export const bitbucketProvider: SourceProviderModule = {
  id: "bitbucket",
  eventSources: ["bitbucket"],
  mirrorRoots: ["sources/bitbucket/"],
};
