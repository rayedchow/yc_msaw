CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Knowledge graph core
-- ---------------------------------------------------------------------------

CREATE TABLE "kb_containers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_kb_container_tenant_slug" ON "kb_containers" ("tenant_id", "slug");

CREATE TABLE "kb_members" (
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "subject_id" text NOT NULL,
  "role" text NOT NULL,
  CONSTRAINT "ck_kb_member_role" CHECK ("role" IN ('admin', 'sme', 'member'))
);
CREATE UNIQUE INDEX "uq_kb_member_subject" ON "kb_members" ("kb_id", "subject_id");

CREATE TABLE "kb_sources" (
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "provider" text NOT NULL,
  "selector" jsonb NOT NULL DEFAULT '{}',
  "selector_hash" text NOT NULL
);
CREATE UNIQUE INDEX "uq_kb_source_provider_selector" ON "kb_sources" ("kb_id", "provider", "selector_hash");

-- ---------------------------------------------------------------------------
-- Graph lineage bridge
-- ---------------------------------------------------------------------------

CREATE TABLE "source_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "kind" text NOT NULL,
  "title" text,
  "mirror_path" text,
  "content_sha" text,
  "source_acl" jsonb,
  "source_updated_at" timestamp with time zone,
  "ingested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  "version_ref" text,
  CONSTRAINT "ck_source_document_kind" CHECK ("kind" IN ('document', 'conversation_window', 'code_file'))
);
CREATE UNIQUE INDEX "uq_source_document_kb_provider_external" ON "source_documents" ("kb_id", "provider", "external_id");

CREATE TABLE "chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "document_id" uuid NOT NULL REFERENCES "source_documents" ("id"),
  "ordinal" integer NOT NULL,
  "chunk_hash" text NOT NULL,
  "text" text NOT NULL,
  "meta" jsonb NOT NULL DEFAULT '{}',
  "superseded_at" timestamp with time zone
);
CREATE UNIQUE INDEX "uq_chunk_document_ordinal_live" ON "chunks" ("document_id", "ordinal") WHERE "superseded_at" IS NULL;
CREATE INDEX "idx_chunk_document_hash" ON "chunks" ("document_id", "chunk_hash");

-- ---------------------------------------------------------------------------
-- Graph entities
-- ---------------------------------------------------------------------------

CREATE TABLE "entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "type" text NOT NULL,
  "name" text NOT NULL,
  "canonical_id" uuid REFERENCES "entities" ("id"),
  "status" text NOT NULL DEFAULT 'active',
  "scope_tags" jsonb NOT NULL DEFAULT '{}',
  "summary" text,
  "summary_inputs_hash" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_entity_status" CHECK ("status" IN ('active', 'merged', 'archived'))
);
CREATE INDEX "idx_entity_kb_type" ON "entities" ("kb_id", "type");
CREATE INDEX "idx_entity_kb_canonical" ON "entities" ("kb_id", "canonical_id");

CREATE TABLE "entity_aliases" (
  "entity_id" uuid NOT NULL REFERENCES "entities" ("id"),
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "source_document_id" uuid REFERENCES "source_documents" ("id")
);
CREATE UNIQUE INDEX "uq_entity_alias_kind_value" ON "entity_aliases" ("entity_id", "kind", "value");
CREATE INDEX "idx_entity_alias_kind_value" ON "entity_aliases" ("kind", "value");

CREATE TABLE "entity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "a_entity_id" uuid NOT NULL REFERENCES "entities" ("id"),
  "b_entity_id" uuid NOT NULL REFERENCES "entities" ("id"),
  "score" real,
  "method" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "decided_by" text,
  "decided_at" timestamp with time zone,
  CONSTRAINT "ck_entity_link_state" CHECK ("state" IN ('pending', 'merged', 'rejected'))
);
CREATE UNIQUE INDEX "uq_entity_link_pair" ON "entity_links" ("a_entity_id", "b_entity_id");

-- ---------------------------------------------------------------------------
-- Graph claims
-- ---------------------------------------------------------------------------

CREATE TABLE "claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "text" text NOT NULL,
  "kind" text NOT NULL,
  "subject_entity_id" uuid REFERENCES "entities" ("id"),
  "predicate" text,
  "object_entity_id" uuid REFERENCES "entities" ("id"),
  "object_value" text,
  "document_id" uuid NOT NULL REFERENCES "source_documents" ("id"),
  "chunk_id" uuid REFERENCES "chunks" ("id"),
  "chunk_hash" text NOT NULL,
  "extractor_version" text NOT NULL,
  "source_acl" jsonb,
  "trust_tier" smallint NOT NULL,
  "confidence" real,
  "event_at" timestamp with time zone,
  "ingested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "invalid_at" timestamp with time zone,
  "superseded_by" uuid REFERENCES "claims" ("id"),
  "invalidation_reason" text,
  "tsv" tsvector NOT NULL,
  CONSTRAINT "ck_claim_kind" CHECK ("kind" IN ('fact', 'relation', 'summary', 'compiled', 'procedure_check')),
  CONSTRAINT "ck_claim_invalidation_reason" CHECK (
    "invalidation_reason" IS NULL OR
    "invalidation_reason" IN ('chunk_changed', 'contradicted', 'sme_correction', 'source_deleted', 'extractor_upgraded')
  )
);
CREATE INDEX "idx_claim_subject_predicate_live" ON "claims" ("kb_id", "subject_entity_id", "predicate") WHERE "invalid_at" IS NULL;
CREATE INDEX "idx_claim_chunk" ON "claims" ("kb_id", "chunk_id");
CREATE INDEX "idx_claim_document_live" ON "claims" ("document_id") WHERE "invalid_at" IS NULL;
CREATE INDEX "idx_claim_tsv" ON "claims" USING gin ("tsv");

CREATE FUNCTION graph_claims_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW."tsv" := to_tsvector('english', coalesce(NEW."text", ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER graph_claims_tsv_update
BEFORE INSERT OR UPDATE OF "text" ON "claims"
FOR EACH ROW EXECUTE FUNCTION graph_claims_tsv_update();

CREATE TABLE "claim_entities" (
  "claim_id" uuid NOT NULL REFERENCES "claims" ("id"),
  "entity_id" uuid NOT NULL REFERENCES "entities" ("id"),
  "role" text NOT NULL,
  PRIMARY KEY ("claim_id", "entity_id", "role"),
  CONSTRAINT "ck_claim_entity_role" CHECK ("role" IN ('about', 'subject', 'object', 'mentions'))
);
CREATE INDEX "idx_claim_entity_entity" ON "claim_entities" ("entity_id");

CREATE TABLE "claim_embeddings" (
  "claim_id" uuid PRIMARY KEY REFERENCES "claims" ("id"),
  "model" text NOT NULL,
  "embedding" vector(1536) NOT NULL
);
CREATE INDEX "idx_claim_embedding_hnsw" ON "claim_embeddings" USING hnsw ("embedding" vector_cosine_ops);

CREATE TABLE "chunk_extractions" (
  "chunk_id" uuid NOT NULL REFERENCES "chunks" ("id"),
  "extractor_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "model" text,
  "completed_at" timestamp with time zone,
  "error" text,
  CONSTRAINT "ck_chunk_extraction_status" CHECK ("status" IN ('pending', 'completed', 'failed'))
);
CREATE UNIQUE INDEX "uq_chunk_extraction" ON "chunk_extractions" ("chunk_id", "extractor_version");

-- ---------------------------------------------------------------------------
-- Graph pages and wiki
-- ---------------------------------------------------------------------------

CREATE TABLE "pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "kind" text NOT NULL,
  "entity_id" uuid REFERENCES "entities" ("id"),
  "tree_path" text NOT NULL,
  "title" text NOT NULL,
  "section_defs" jsonb NOT NULL,
  "owner_sme" text,
  "verification_state" text NOT NULL DEFAULT 'unverified',
  "verified_by" text,
  "verified_at" timestamp with time zone,
  "verified_content_hash" text,
  "content" text,
  "content_hash" text,
  "inputs_hash" text,
  "generated_at" timestamp with time zone,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_page_kind" CHECK ("kind" IN ('entity', 'topic', 'standard', 'module', 'generation', 'codebase_map', 'index', 'procedure')),
  CONSTRAINT "ck_page_verification_state" CHECK ("verification_state" IN ('unverified', 'verified', 'stale'))
);
CREATE UNIQUE INDEX "uq_page_kb_tree_path_live" ON "pages" ("kb_id", "tree_path") WHERE "archived_at" IS NULL;

CREATE TABLE "page_claims" (
  "page_id" uuid NOT NULL REFERENCES "pages" ("id"),
  "claim_id" uuid NOT NULL REFERENCES "claims" ("id"),
  PRIMARY KEY ("page_id", "claim_id")
);
CREATE INDEX "idx_page_claim_claim" ON "page_claims" ("claim_id");

CREATE TABLE "page_entities" (
  "page_id" uuid NOT NULL REFERENCES "pages" ("id"),
  "entity_id" uuid NOT NULL REFERENCES "entities" ("id"),
  PRIMARY KEY ("page_id", "entity_id")
);
CREATE INDEX "idx_page_entity_entity" ON "page_entities" ("entity_id");

CREATE TABLE "page_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "page_id" uuid NOT NULL REFERENCES "pages" ("id"),
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "anchor" jsonb NOT NULL DEFAULT '{}',
  "kind" text NOT NULL,
  "body" text NOT NULL,
  "mapped_claim_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "state" text NOT NULL DEFAULT 'open',
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "resulting_claim_id" uuid REFERENCES "claims" ("id"),
  CONSTRAINT "ck_page_feedback_kind" CHECK ("kind" IN ('flag', 'fix', 'freeform')),
  CONSTRAINT "ck_page_feedback_state" CHECK ("state" IN ('open', 'applied', 'dismissed'))
);

CREATE TABLE "page_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "page_id" uuid NOT NULL REFERENCES "pages" ("id"),
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "inputs_hash" text,
  "generated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "human_edited" boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- Graph eval
-- ---------------------------------------------------------------------------

CREATE TABLE "eval_questions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "question" text NOT NULL,
  "expected_answer" text,
  "grader_notes" text,
  "hop_type" text,
  "created_by" text NOT NULL
);

CREATE TABLE "eval_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
  "config" jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE "eval_results" (
  "run_id" uuid NOT NULL REFERENCES "eval_runs" ("id"),
  "question_id" uuid NOT NULL REFERENCES "eval_questions" ("id"),
  "answer" text NOT NULL,
  "grade" smallint,
  "graded_by" text,
  "notes" text,
  PRIMARY KEY ("run_id", "question_id")
);
