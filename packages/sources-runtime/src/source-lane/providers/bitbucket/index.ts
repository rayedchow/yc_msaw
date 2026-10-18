import type { SourceFileChange, SourceProviderModule } from "../../core/types.js";
import { BitbucketClient } from "./api.js";
import { bitbucketContentTaskHandlers } from "./content.js";
import { bitbucketCoverage } from "./coverage.js";
import { BITBUCKET_EXTRA_TABLES } from "./export-map.js";
import { repoSourceDirectory } from "./paths.js";
import { registerBitbucketInternalRoutes } from "./routes.js";
import type { BitbucketDb } from "./store.js";

/**
 * Bitbucket source-lane module (owned by the bitbucket agent).
 *
 * Two lanes, both through Nango (the runtime never holds Bitbucket tokens):
 *  - donor Nango lanes, unchanged (src/integrations/bitbucket processors + nango proxy issues
 *    / PR details / comments / activity): raw activity_events under sources/bitbucket/_raw/ and
 *    the donor projections sources/bitbucket/<ws>/<repo>/{repo.md, issue-N.md, pr-N.md} with the
 *    default mappings, except the provisional `unknown-repo/pr-N.md` projections (below);
 *  - repository content lane (task bitbucket.content_sweep, ./content.ts, drizzle/9350): for
 *    every SELECTED repository, the exact bytes of every file at the HEAD commit of its main
 *    branch (+ configured branches) via /src, with per-scan generations, snapshots, deletes and
 *    renames, under sources/bitbucket/<ws>/<repo>/code/ (./paths.ts).
 */

/**
 * Slim PullRequest sync records carry no repository, so the donor renders them at
 * `sources/bitbucket/unknown-repo/pr-<id>.md`. PR ids are only unique per repository: PR #7 of
 * two repositories overwrite each other there, and the file flaps as the PR-detail sweep deletes
 * it. The projection is not exported (its raw record still is, under _raw/); the per-repository
 * projection from the detail lane is the exported one.
 */
export function unknownRepoRoot(): string {
  return `${repoSourceDirectory("unknown-repo")}/`;
}

export function mapBitbucketMirror(path: string): SourceFileChange[] | null {
  return path.startsWith(unknownRepoRoot()) ? [] : null;
}

export const bitbucketProvider: SourceProviderModule = {
  id: "bitbucket",
  eventSources: ["bitbucket"],
  mirrorRoots: ["sources/bitbucket/"],
  mapMirror: (path) => mapBitbucketMirror(path),
  extraTables: BITBUCKET_EXTRA_TABLES,
  coverage: (ctx) => bitbucketCoverage(ctx),
  taskHandlers: () => bitbucketContentTaskHandlers(),
  internalRoutes: (app, deps) =>
    registerBitbucketInternalRoutes(app, deps, {
      db: async () => (await import("../../../db/client.js")).db as unknown as BitbucketDb,
      client: () => new BitbucketClient(),
    }),
};
