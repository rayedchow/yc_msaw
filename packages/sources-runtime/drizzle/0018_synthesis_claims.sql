ALTER TABLE "claims" DROP CONSTRAINT "ck_claim_kind";
ALTER TABLE "claims"
  ADD CONSTRAINT "ck_claim_kind"
  CHECK ("kind" IN ('fact', 'relation', 'summary', 'compiled', 'procedure_check', 'synthesis'));

ALTER TABLE "claims" DROP CONSTRAINT "ck_claim_invalidation_reason";
ALTER TABLE "claims"
  ADD CONSTRAINT "ck_claim_invalidation_reason"
  CHECK (
    "invalidation_reason" IS NULL OR
    "invalidation_reason" IN (
      'chunk_changed',
      'contradicted',
      'sme_correction',
      'source_deleted',
      'extractor_upgraded',
      'file_changed',
      'input_superseded',
      'resynthesized'
    )
  );

ALTER TABLE "source_documents" DROP CONSTRAINT "ck_source_document_kind";
ALTER TABLE "source_documents"
  ADD CONSTRAINT "ck_source_document_kind"
  CHECK ("kind" IN ('document', 'conversation_window', 'code_file', 'synthesis'));

CREATE TABLE "claim_inputs" (
  "derived_claim_id" uuid NOT NULL REFERENCES "claims"("id"),
  "input_claim_id" uuid NOT NULL REFERENCES "claims"("id"),
  PRIMARY KEY ("derived_claim_id", "input_claim_id")
);
CREATE INDEX "idx_claim_inputs_input" ON "claim_inputs" ("input_claim_id");

CREATE TABLE "synthesis_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers"("id"),
  "subject_entity_id" uuid NOT NULL REFERENCES "entities"("id"),
  "tier" smallint NOT NULL,
  "trigger" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('applied','escalated','failed','skipped')),
  "live_claim_count" int NOT NULL,
  "truncated" boolean NOT NULL DEFAULT false,
  "dead_synthesis_count" int NOT NULL,
  "produced_count" int NOT NULL,
  "gate_failure_count" int NOT NULL,
  "gate_failures" jsonb,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
