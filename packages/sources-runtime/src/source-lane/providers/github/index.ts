import type { SourceProviderModule } from "../../core/types.js";

/**
 * GitHub (Nango records + proxy issues/details + repo sync).
 * Baseline source-lane module written by the core lead: raw activity_events rows for
 * these sources and mirror_files rows under sources/github/ export with the default
 * mappings (src/source-lane/export/mapping.ts). Owned by the github integration agent
 * from here on (CONTRACT.md §5).
 */
export const githubProvider: SourceProviderModule = {
  id: "github",
  eventSources: ["github"],
  mirrorRoots: ["sources/github/"],
};
