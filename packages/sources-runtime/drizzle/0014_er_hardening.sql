ALTER TABLE "entity_aliases"
  ADD COLUMN "superseded_at" timestamptz;

CREATE TABLE "er_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers"("id"),
  "mention_name" text NOT NULL,
  "mention_type" text NOT NULL,
  "method" text NOT NULL,
  "candidate_count" integer NOT NULL DEFAULT 0,
  "top_candidate_score" real,
  "adjudicator_confidence" real,
  "resolved_entity_id" uuid REFERENCES "entities"("id"),
  "created_entity" boolean NOT NULL DEFAULT false,
  "pending_link_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_er_decisions_kb_method" ON "er_decisions" ("kb_id", "method", "created_at");

ALTER TABLE "er_decisions"
  ADD CONSTRAINT "ck_er_decision_method"
  CHECK ("method" IN ('identifier', 'name_exact', 'adjudicated', 'created', 'created_flagged', 'ambiguous_names'));
