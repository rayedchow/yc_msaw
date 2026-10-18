import type { SourceProviderModule } from "../../core/types.js";
import { notionCoverage } from "./coverage.js";
import { NOTION_EXTRA_TABLES } from "./export-map.js";
import { notionSourceTaskHandlers } from "./sweep.js";

/**
 * Notion source-lane module (owned by the notion agent).
 *
 * Two lanes on the tenant's Notion connection (donor integration_tokens; OAuth or
 * internal-integration token; Notion-Version 2026-03-11):
 *  - donor lane, unchanged (src/integrations/notion: notion.poll / notion.render /
 *    notion.reconcile + webhook): raw activity_events (lifecycle signals: trash, unshare,
 *    content_updated, webhook events) under sources/notion/_raw/ and the donor projections
 *    sources/notion/<Title>-page-<id>/content.md, exported with the default mappings.
 *  - deep lane (task notion.source_sweep, ./sweep.ts, drizzle/9450-9451): every page,
 *    database, data source (rows queried to exhaustion), block (every level fully
 *    paginated), comment (open, resolved and deleted) and Notion-hosted file (exact bytes)
 *    the connection can read, with durable cursors, Retry-After cooldowns per Notion budget
 *    and confirm-before-tombstone, exported under
 *    sources/notion/_workspaces/<workspaceId>/<connectionId>/ (./paths.ts, ./export-map.ts).
 */
export const notionProvider: SourceProviderModule = {
  id: "notion",
  eventSources: ["notion", "notion_comments_api", "notion_enhanced_markdown"],
  mirrorRoots: ["sources/notion/"],
  extraTables: NOTION_EXTRA_TABLES,
  coverage: (ctx) => notionCoverage(ctx),
  taskHandlers: () => notionSourceTaskHandlers(),
};
