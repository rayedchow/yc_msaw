-- Bulk set-based rebuild staging (github issue #141).
--
-- These tables are a transport surface for the flag-gated bulk rebuild path
-- (src/graph/rebuild/bulk): the planner replays the deterministic per-chunk
-- pipeline in memory, stages the fully-resolved plan here in chunked bulk
-- inserts, and then materializes the canonical layer with a handful of
-- INSERT ... SELECT statements. They hold no durable state:
--   * UNLOGGED — rebuild-scratch data; crash recovery re-runs the rebuild.
--   * truncated at the start of every bulk run (an advisory lock serializes
--     concurrent bulk materializations).
--   * no foreign keys — rows are validated by the planner and by the real
--     tables' own constraints/triggers on materialization.
--
-- Entity-level payloads ride on "representative" mention rows and fact-level
-- payloads on representative assertion rows (positional: plan entity i is
-- carried by staged mention i) instead of dedicated staging tables.

CREATE UNLOGGED TABLE "bulk_rebuild_mentions" (
  "mention_id" uuid PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "chunk_id" uuid NOT NULL,
  "surface_text" text NOT NULL,
  "entity_type" text NOT NULL,
  "source_category" text NOT NULL,
  "span" jsonb NOT NULL,
  "identity_keys" jsonb NOT NULL DEFAULT '{}',
  "aliases" jsonb NOT NULL DEFAULT '[]',
  "source_object_ref" jsonb,
  "resolution_status" text NOT NULL,
  "resolved_entity_id" uuid,
  "resolution_reason" text,
  "resolution_context" jsonb,
  -- Entity payload (representative rows only; unrelated to this row's own resolution).
  "entity_representative" boolean NOT NULL DEFAULT false,
  "entity_id" uuid,
  "entity_entity_type" text,
  "entity_canonical_name" text,
  "entity_identity_keys" jsonb,
  "entity_source_categories" jsonb,
  "entity_status" text,
  "entity_canonical_id" uuid,
  "entity_aliases" jsonb
);
CREATE INDEX "idx_bulk_rebuild_mentions_kb_chunk" ON "bulk_rebuild_mentions" ("kb_id", "chunk_id");
CREATE INDEX "idx_bulk_rebuild_mentions_entity_rep" ON "bulk_rebuild_mentions" ("kb_id", "entity_representative");

CREATE UNLOGGED TABLE "bulk_rebuild_assertions" (
  "evidence_id" uuid PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "chunk_id" uuid NOT NULL,
  "subject_mention_id" uuid NOT NULL,
  "object_mention_id" uuid,
  "assertion_kind" text NOT NULL,
  "relation" text,
  "scalar_property" text,
  "statement_text" text,
  "object_value" jsonb,
  "qualifiers" jsonb NOT NULL DEFAULT '{}',
  "source_category" text NOT NULL,
  "extractor_version" text NOT NULL,
  "ontology_version" text NOT NULL,
  -- Consolidation plan: the canonical fact this evidence attaches to
  -- (NULL when an endpoint mention parked unresolved).
  "fact_id" uuid,
  -- Fact payload (representative rows only; positional like entity payloads).
  "fact_representative" boolean NOT NULL DEFAULT false,
  "fact_self_id" uuid,
  "fact_assertion_kind" text,
  "fact_relation" text,
  "fact_scalar_property" text,
  "fact_subject_entity_id" uuid,
  "fact_object_entity_id" uuid,
  "fact_scalar_value" jsonb,
  "fact_qualifiers" jsonb,
  "fact_event_at" timestamptz
);
CREATE INDEX "idx_bulk_rebuild_assertions_kb_chunk" ON "bulk_rebuild_assertions" ("kb_id", "chunk_id");
CREATE INDEX "idx_bulk_rebuild_assertions_fact_rep" ON "bulk_rebuild_assertions" ("kb_id", "fact_representative");
