import type { SourceProviderModule } from "../../core/types.js";
import { jiraCoverage } from "./coverage.js";
import { JIRA_EXTRA_TABLES, mapJiraEvent, mapJiraMirror } from "./export-map.js";
import { registerJiraInternalRoutes } from "./routes.js";
import { jiraTaskHandlers } from "./sweep.js";

/**
 * Jira source-lane module (owned by the jira agent).
 *
 * Two lanes, both through Nango (the runtime never holds Atlassian tokens):
 *  - donor lanes, unchanged (src/integrations/atlassian processors, Nango
 *    record sync and the nango.proxy_details sweep, src/mirror/materializer.ts):
 *    raw activity_events under sources/jira/_raw/ with their byte-identical
 *    donor keys and the donor projection sources/jira/<PROJECT>/<KEY>.md. This
 *    module removes stale donor files at export (moved / re-keyed issues keep
 *    their numeric id, so the old-key file is deleted; deleted issues).
 *  - deep REST lane (task jira.sweep, ./sweep.ts, drizzle/9250): per site,
 *    the selected projects' issues with every field, every changelog history
 *    entry (paged), every comment (edits as observations, 404-confirmed
 *    deletions), attachment bytes, with permission loss kept apart from
 *    deletion, under sources/jira/_sites/<cloudId>/<connectionId>/ (./paths.ts).
 *    Project selection is per tenant connection via the internal API (./routes.ts).
 */
export const jiraProvider: SourceProviderModule = {
  id: "jira",
  eventSources: ["jira"],
  mirrorRoots: ["sources/jira/"],
  mapEvent: mapJiraEvent,
  mapMirror: mapJiraMirror,
  extraTables: JIRA_EXTRA_TABLES,
  coverage: (ctx) => jiraCoverage(ctx),
  internalRoutes: (app, deps) =>
    registerJiraInternalRoutes(app, deps, async () => (await import("../../../db/client.js")).db),
  taskHandlers: () => jiraTaskHandlers(),
};
