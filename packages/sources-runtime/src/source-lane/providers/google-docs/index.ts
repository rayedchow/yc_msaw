import type { SourceProviderModule } from "../../core/types.js";
import { googleDocsCoverage } from "./coverage.js";
import { gdocsVersionsExport } from "./export-map.js";

/**
 * Google Docs/Drive (changes feed, Docs API snapshots, OT changelog).
 *
 * - raw activity_events (`gdocs`) and donor mirror_files under
 *   sources/google-docs/ export with the core default mappings;
 * - provider files (native Docs/Sheets/Slides JSON, image and Drive bytes,
 *   raw changelog pages, session diff events, suggestions, tabs, snapshot
 *   diffs, status files) are appended to `gdocs_source_file_versions` by the
 *   donor Docs jobs and exported one version per journal row;
 * - coverage is computed from per-file checkpoints and the auth mode.
 */
export const googleDocsProvider: SourceProviderModule = {
  id: "google-docs",
  eventSources: ["gdocs"],
  mirrorRoots: ["sources/google-docs/"],
  extraTables: [gdocsVersionsExport],
  coverage: (ctx) => googleDocsCoverage(ctx),
};
