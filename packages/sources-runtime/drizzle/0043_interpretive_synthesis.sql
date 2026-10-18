ALTER TABLE "claims"
  ADD COLUMN "synthesis_grade" text,
  ADD COLUMN "conclusion_carried_from" uuid REFERENCES "claims"("id");

ALTER TABLE "claims"
  ADD CONSTRAINT "ck_claim_synthesis_grade"
  CHECK ("synthesis_grade" IS NULL OR "synthesis_grade" IN ('restatement', 'interpretive'));

UPDATE "claims"
SET "synthesis_grade" = 'restatement'
WHERE "kind" = 'synthesis'
  AND "synthesis_grade" IS NULL;
