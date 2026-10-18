-- Human review audit fields for v2 same-as conflicts. V1 entity_links already
-- has decided_by/decided_at from 0037; its needs_human_review state was added
-- in 0052.
ALTER TABLE "v2_same_as_decisions"
  ADD COLUMN "decided_by" text;

ALTER TABLE "v2_same_as_decisions"
  DROP CONSTRAINT "ck_v2_same_as_decision_state";

ALTER TABLE "v2_same_as_decisions"
  ADD CONSTRAINT "ck_v2_same_as_decision_state"
  CHECK ("state" IN ('merged', 'judge_rejected', 'key_conflict', 'merge_conflict', 'human_rejected'));
