import type { SourceProviderModule } from "../../core/types.js";
import { GithubClient } from "./api.js";
import { githubContentTaskHandlers } from "./content.js";
import { githubCoverage } from "./coverage.js";
import { GITHUB_EXTRA_TABLES } from "./export-map.js";
import { registerGithubInternalRoutes } from "./routes.js";
import type { GithubDb } from "./store.js";

/**
 * GitHub source-lane module (owned by the github agent).
 *
 * Two lanes, both through Nango (the runtime never holds GitHub tokens):
 *  - donor Nango lanes, unchanged (src/integrations/github processors + nango proxy
 *    issues/details + github_repo_sync selection): raw activity_events under
 *    sources/github/_raw/ and the donor projections sources/github/<owner>/<repo>/
 *    {repo.md, issue-N.md, pr-N.md} with the default mappings.
 *  - repository content lane (task github.content_sweep, ./content.ts, drizzle/9300):
 *    for every SELECTED repository, the exact bytes of every file at the HEAD of its
 *    default branch (+ configured branches) via the Git Database API, with per-scan
 *    generations, snapshots, deletes and renames, under
 *    sources/github/<owner>/<repo>/code/ (./paths.ts).
 */
export const githubProvider: SourceProviderModule = {
  id: "github",
  eventSources: ["github"],
  mirrorRoots: ["sources/github/"],
  extraTables: GITHUB_EXTRA_TABLES,
  coverage: (ctx) => githubCoverage(ctx),
  taskHandlers: () => githubContentTaskHandlers(),
  internalRoutes: (app, deps) =>
    registerGithubInternalRoutes(app, deps, {
      db: async () => (await import("../../../db/client.js")).db as unknown as GithubDb,
      client: () => new GithubClient(),
    }),
};
