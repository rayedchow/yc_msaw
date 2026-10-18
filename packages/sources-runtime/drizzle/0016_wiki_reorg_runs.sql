CREATE TABLE "wiki_reorg_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "page_id" uuid NOT NULL REFERENCES "pages" ("id"),
  "status" text NOT NULL DEFAULT 'pending',
  "planned_payload" jsonb NOT NULL DEFAULT '{}',
  "applied_payload" jsonb,
  "reviewer_verdict" jsonb,
  "running_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_wiki_reorg_run_status"
    CHECK ("status" IN ('pending', 'running', 'reviewing', 'applying', 'applied', 'rejected', 'failed'))
);

CREATE INDEX "idx_wiki_reorg_runs_kb_status_created"
  ON "wiki_reorg_runs" ("kb_id", "status", "created_at" ASC);

CREATE INDEX "idx_wiki_reorg_runs_page_completed"
  ON "wiki_reorg_runs" ("kb_id", "page_id", "completed_at" DESC);

CREATE UNIQUE INDEX "uq_wiki_reorg_run_active_page"
  ON "wiki_reorg_runs" ("kb_id", "page_id")
  WHERE "status" IN ('pending', 'running', 'reviewing', 'applying');
