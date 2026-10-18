CREATE TABLE "answer_traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "subject_id" text NOT NULL,
  "question" text NOT NULL,
  "mode" text NOT NULL,
  "kind" text NOT NULL,
  "claim_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "entity_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "tokens_used" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_answer_trace_kind" CHECK ("kind" IN ('answer', 'abstain', 'error'))
);

CREATE INDEX "idx_answer_trace_kb_created"
  ON "answer_traces" ("kb_id", "created_at" DESC);

CREATE INDEX "idx_answer_trace_entity_ids"
  ON "answer_traces" USING gin ("entity_ids");
