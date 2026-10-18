ALTER TABLE "entity_links"
  DROP CONSTRAINT "ck_entity_link_state";

ALTER TABLE "entity_links"
  ADD COLUMN "adjudicating_at" timestamp with time zone,
  ADD COLUMN "defer_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "deferred_until" timestamp with time zone,
  ADD COLUMN "verdict_rationale" text;

ALTER TABLE "entity_links"
  ADD CONSTRAINT "ck_entity_link_state"
  CHECK ("state" IN ('pending', 'adjudicating', 'merged', 'rejected'));

CREATE INDEX "idx_entity_links_kb_state_created"
  ON "entity_links" ("kb_id", "state", "created_at");
