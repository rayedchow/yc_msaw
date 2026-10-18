import type { SourceProviderModule } from "../../core/types.js";
import { granolaCoverage } from "./coverage.js";
import { GRANOLA_EXTRA_TABLES } from "./export-map.js";

/**
 * Granola source-lane module (owned by the granola agent).
 *
 * One lane on the tenant's Granola credential (donor integration_tokens: public-API key,
 * or OAuth to Granola's MCP server). The donor tasks granola.poll / granola.backfill run
 * through ./lane.ts (inventory passes with page checkpoints, Retry-After cooldowns per
 * credential, retries by id, transcript re-checks, durable state); see
 * drizzle/9500_granola_source_lane.sql. Exported:
 *
 *  - raw ledger (default mapping): every captured revision of every note
 *    (`granola:<id>:<updated_at>`, content revisions `...#<sha16>`, tombstones
 *    `granola:<id>:deleted[:<version>]`) under sources/granola/_raw/tenant/meeting_note:<id>/.
 *  - donor projections (default mapping): sources/granola/<Title>-meeting-<hash>/{summary,transcript}.md.
 *  - native catalog (granola_source_notes): note.json (people, calendar link, folders, revision
 *    index with raw paths) and transcript.json (segments exactly as stored) in the same directory.
 */
export const granolaProvider: SourceProviderModule = {
  id: "granola",
  eventSources: ["granola"],
  mirrorRoots: ["sources/granola/"],
  extraTables: GRANOLA_EXTRA_TABLES,
  coverage: (ctx) => granolaCoverage(ctx),
};
