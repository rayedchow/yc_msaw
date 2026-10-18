import type { SourceProviderModule } from "../../core/types.js";
import { confluenceCoverage } from "./coverage.js";
import { CONFLUENCE_EXTRA_TABLES, mapConfluenceEvent, mapConfluenceMirror } from "./export-map.js";
import { confluenceTaskHandlers } from "./sweep.js";

/**
 * Confluence source-lane module (owned by the confluence agent).
 *
 * Two lanes, both through Nango (the runtime never holds Atlassian tokens):
 *  - donor Nango /records lane, unchanged (src/integrations/atlassian processors
 *    + src/mirror/materializer.ts): raw activity_events (latest state per poll,
 *    journaled) under sources/confluence/_raw/ and the donor projections
 *    sources/confluence/<spaceId>/<pageId>{,-comments}.md. This module adds the
 *    page version ordinal to those projections and removes stale ones at export
 *    (tombstones without spaceId, moved pages, deleted blog posts' comment docs).
 *  - deep REST lane (task confluence.sweep, ./sweep.ts, drizzle/9200): every
 *    space/page/blog post/comment/attachment per site with cursor pagination,
 *    version bodies from the version API, ADF, attachment bytes, permissions and
 *    restrictions, 404-confirmed tombstones incl. whole-space deletion, under
 *    sources/confluence/_sites/<cloudId>/<connectionId>/ (./paths.ts).
 */
export const confluenceProvider: SourceProviderModule = {
  id: "confluence",
  eventSources: ["confluence"],
  mirrorRoots: ["sources/confluence/"],
  mapEvent: mapConfluenceEvent,
  mapMirror: mapConfluenceMirror,
  extraTables: CONFLUENCE_EXTRA_TABLES,
  coverage: (ctx) => confluenceCoverage(ctx),
  taskHandlers: () => confluenceTaskHandlers(),
};
