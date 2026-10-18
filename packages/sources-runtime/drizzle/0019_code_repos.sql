CREATE TABLE "code_repos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "repo" text NOT NULL,
  "clone_url" text,
  "local_dir" text,
  "tracked_ref" text NOT NULL DEFAULT 'main',
  "include_globs" jsonb NOT NULL DEFAULT '[]',
  "exclude_globs" jsonb NOT NULL DEFAULT '[]',
  "macro_denylist" jsonb NOT NULL DEFAULT '[]',
  "last_indexed_commit" text,
  "last_reconcile_at" timestamptz,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_code_repo_status" CHECK ("status" IN ('active', 'paused', 'error')),
  CONSTRAINT "ck_code_repo_clone_or_local" CHECK ("clone_url" IS NOT NULL OR "local_dir" IS NOT NULL)
);

CREATE UNIQUE INDEX "uq_code_repo_kb_repo"
  ON "code_repos" ("kb_id", "repo");

CREATE INDEX "idx_code_repo_tenant_status"
  ON "code_repos" ("tenant_id", "status");

CREATE INDEX "idx_code_repo_kb_status"
  ON "code_repos" ("kb_id", "status");

ALTER TABLE "code_file_parses"
  ADD COLUMN "deleted_at" timestamptz;

CREATE INDEX "idx_code_file_parse_kb_repo_live"
  ON "code_file_parses" ("kb_id", "repo")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "claims" DROP CONSTRAINT "ck_claim_invalidation_reason";
ALTER TABLE "claims"
  ADD CONSTRAINT "ck_claim_invalidation_reason"
  CHECK (
    "invalidation_reason" IS NULL OR
    "invalidation_reason" IN ('chunk_changed', 'contradicted', 'sme_correction', 'source_deleted', 'extractor_upgraded', 'file_changed', 'input_superseded', 'resynthesized', 'file_deleted')
  );
