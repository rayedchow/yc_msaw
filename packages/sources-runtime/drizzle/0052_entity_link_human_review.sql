ALTER TABLE "entity_links"
  DROP CONSTRAINT "ck_entity_link_state";

ALTER TABLE "entity_links"
  ADD CONSTRAINT "ck_entity_link_state"
  CHECK ("state" IN ('pending', 'adjudicating', 'merged', 'rejected', 'needs_human_review'));
