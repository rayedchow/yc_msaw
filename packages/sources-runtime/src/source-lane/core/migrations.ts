import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

/**
 * Source-lane migration plan.
 *
 * The donor drizzle/ directory is kept verbatim (donor tests read it), but the
 * source lane applies only the donor migrations its code needs. Every donor file
 * is classified here: included, or excluded with a reason. An unclassified donor
 * file is an error, never a silent skip. Source-lane files (`9NNN_*.sql`, core
 * 9000-9099 and provider ranges per CONTRACT.md) are always applied, in order,
 * after the donor set. Verified against a real PostgreSQL 18 without pgvector by
 * tests/source-lane/core/runtime-pg.test.ts.
 */

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "drizzle");

/** Donor migrations whose every statement targets source-lane tables. */
export const INCLUDED_DONOR_MIGRATIONS: readonly string[] = [
  "0000_init.sql",
  "0001_google_actor_identities.sql",
  "0002_google_doc_suggestions.sql",
  "0003_google_doc_tabs.sql",
  "0004_google_doc_sync_state.sql",
  "0005_google_doc_images.sql",
  "0015_gdoc_drive_lineage.sql",
  "0020_connection_external_accounts.sql",
  "0021_binary_documents.sql",
  "0022_connection_pending_status.sql",
  "0023_slack_thread_watermarks.sql",
  "0024_onboarding_sessions.sql",
  "0025_notion_block_snapshots.sql",
  "0026_google_doc_tab_snapshots.sql",
  "0027_mirror_files_meta.sql",
  "0028_slack_binary_documents.sql",
  "0029_gmail_attachment_binary_provider.sql",
  "0030_github_repo_sync.sql",
  "0031_retrieval_indexes.sql",
  "0064_google_contact_names.sql",
  "0070_google_mailbox_sync_state.sql",
];

const GRAPH = "graph/wiki/chat plane (not used by source-lane code)";
const NEEDS_VECTOR = "requires pgvector; graph plane";
const MIXED = "mixed: its source-table statements are copied verbatim into 9001_source_lane_donor_statements.sql; the rest alter graph tables";

/** Donor migrations not applied in the source lane, with the reason. */
export const EXCLUDED_DONOR_MIGRATIONS: Readonly<Record<string, string>> = {
  "0006_graph_core.sql": NEEDS_VECTOR,
  "0007_pg_trgm.sql": `${GRAPH}: trigram index on entities`,
  "0008_graph_transactional_claims.sql": GRAPH,
  "0009_claim_salience.sql": GRAPH,
  "0010_answer_traces.sql": GRAPH,
  "0011_wiki_candidates.sql": GRAPH,
  "0012_wiki_candidate_pages.sql": GRAPH,
  "0013_claim_modality.sql": GRAPH,
  "0014_er_hardening.sql": GRAPH,
  "0016_wiki_reorg_runs.sql": GRAPH,
  "0017_code_file_parses.sql": GRAPH,
  "0018_synthesis_claims.sql": GRAPH,
  "0019_code_repos.sql": GRAPH,
  "0032_claim_first_ingested_at.sql": GRAPH,
  "0033_hygiene_report.sql": GRAPH,
  "0034_contradiction_nominations.sql": GRAPH,
  "0035_sweep_runs.sql": GRAPH,
  "0036_page_embeddings.sql": NEEDS_VECTOR,
  "0037_same_as_adjudication.sql": GRAPH,
  "0038_claim_links.sql": GRAPH,
  "0039_truth_escalation.sql": GRAPH,
  "0040_deep_dive_pages.sql": GRAPH,
  "0041_escalation_backoff.sql": GRAPH,
  "0042_wiki_candidate_theme_key.sql": GRAPH,
  "0043_interpretive_synthesis.sql": GRAPH,
  "0044_source_document_envelope.sql": MIXED,
  "0045_chunk_extraction_retries.sql": `${GRAPH}: also enqueues graph.* tasks`,
  "0046_chat_agent_embeddings.sql": NEEDS_VECTOR,
  "0047_chat_conversations.sql": GRAPH,
  "0048_wiki_cold_start_readiness.sql": MIXED,
  "0049_graph_v2_foundation.sql": GRAPH,
  "0050_v2_entity_aliases.sql": GRAPH,
  "0051_v2_source_ref_keys.sql": GRAPH,
  "0052_entity_link_human_review.sql": GRAPH,
  "0053_v2_entity_hygiene.sql": GRAPH,
  "0054_v2_relational_same_as.sql": GRAPH,
  "0055_v2_replay_shadow_isolation.sql": GRAPH,
  "0056_kb_graph_version.sql": GRAPH,
  "0057_merge_review_audit.sql": GRAPH,
  "0058_v2_bridge_merge.sql": GRAPH,
  "0059_v2_identity_key_value_hygiene.sql": GRAPH,
  "0060_graph_structure_refinement.sql": GRAPH,
  "0061_v2_statement_source_anchors.sql": GRAPH,
  "0062_fk_delete_indexes.sql": GRAPH,
  "0063_graph_v2_build_snapshots.sql": GRAPH,
  "0065_identity_directory.sql": GRAPH,
  "0066_source_record_contract.sql": MIXED,
  "0067_dead_vocabulary_cleanup.sql": GRAPH,
  "0068_ontology_version_default.sql": GRAPH,
  "0069_bulk_rebuild_staging.sql": GRAPH,
  "0071_fact_evidence_merge_aware_validation.sql": GRAPH,
  "0072_has_access_relation.sql": GRAPH,
  "0073_wiki_agent_windows.sql": GRAPH,
  "0074_wiki_agent_fact_invalidated.sql": GRAPH,
  "0075_wiki_agent_entity_merged.sql": GRAPH,
  "0076_wiki_agent_document_updated.sql": GRAPH,
  "0077_wiki_entity_agent_state.sql": GRAPH,
  "0078_repair_has_access_validator.sql": GRAPH,
};

/** Lane files: 9000-9999 (core + provider ranges) and 10000+ (additional providers, CONTRACT/EXTRA_ASSIGNMENTS). */
const LANE_RE = /^(9\d{3}|[1-9]\d{4})_[a-z0-9_]+\.sql$/;
const DONOR_RE = /^0\d{3}_[a-z0-9_]+\.sql$/;

export interface MigrationPlan {
  apply: string[];
  excluded: Array<{ file: string; reason: string }>;
}

/** Classify every migration file; throws on any file that is neither included, excluded nor a lane file. */
export function planMigrations(dir = MIGRATIONS_DIR): MigrationPlan {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const included = new Set(INCLUDED_DONOR_MIGRATIONS);
  const apply: string[] = [];
  const lane: string[] = [];
  const excluded: MigrationPlan["excluded"] = [];
  const unknown: string[] = [];
  for (const f of files) {
    if (LANE_RE.test(f)) lane.push(f);
    else if (DONOR_RE.test(f) && included.has(f)) apply.push(f);
    else if (DONOR_RE.test(f) && EXCLUDED_DONOR_MIGRATIONS[f]) excluded.push({ file: f, reason: EXCLUDED_DONOR_MIGRATIONS[f]! });
    else unknown.push(f);
  }
  const missing = INCLUDED_DONOR_MIGRATIONS.filter((f) => !files.includes(f));
  if (unknown.length || missing.length) {
    throw new Error(
      `source-lane migration plan is incomplete: unclassified ${JSON.stringify(unknown)}, missing included ${JSON.stringify(missing)} ` +
        "(classify new donor files in src/source-lane/core/migrations.ts; lane files must be named 9NNN_name.sql or NNNNN_name.sql >= 10000)",
    );
  }
  // Numeric order, so 10000_* runs after 9999_* (plain string order would not).
  lane.sort((a, b) => Number(a.slice(0, a.indexOf("_"))) - Number(b.slice(0, b.indexOf("_"))) || (a < b ? -1 : 1));
  return { apply: [...apply, ...lane], excluded };
}

/** Apply pending migrations in plan order, each in its own transaction, recorded in schema_migrations. */
export async function applySourceLaneMigrations(sql: Sql, dir = MIGRATIONS_DIR, log: (m: string) => void = () => {}): Promise<string[]> {
  const plan = planMigrations(dir);
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const file of plan.apply) {
    if (done.has(file)) continue;
    const ddl = readFileSync(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    applied.push(file);
    log(`applied ${file}`);
  }
  return applied;
}

/** Boot guard for source-lane entrypoints: every planned migration must be recorded. */
export async function pendingSourceLaneMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const plan = planMigrations(dir);
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  return plan.apply.filter((f) => !done.has(f));
}
