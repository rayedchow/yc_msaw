CREATE TABLE "code_file_parses" (
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "repo" text NOT NULL,
  "path" text NOT NULL,
  "content_sha" text NOT NULL,
  "parser_version" text NOT NULL,
  "parse_health" jsonb NOT NULL DEFAULT '{}',
  "symbols" jsonb NOT NULL DEFAULT '[]',
  "imports" jsonb NOT NULL DEFAULT '[]',
  "call_sites" jsonb NOT NULL DEFAULT '[]',
  "indexed_commit" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_code_file_parse_kb_repo_path"
  ON "code_file_parses" ("kb_id", "repo", "path");

CREATE INDEX "idx_code_file_parse_kb_repo_commit"
  ON "code_file_parses" ("kb_id", "repo", "indexed_commit");

ALTER TABLE "claims" DROP CONSTRAINT "ck_claim_invalidation_reason";
ALTER TABLE "claims"
  ADD CONSTRAINT "ck_claim_invalidation_reason"
  CHECK (
    "invalidation_reason" IS NULL OR
    "invalidation_reason" IN ('chunk_changed', 'contradicted', 'sme_correction', 'source_deleted', 'extractor_upgraded', 'file_changed')
  );
