ALTER TABLE "claims"
  ADD COLUMN "salience" smallint;

ALTER TABLE "claims"
  ADD CONSTRAINT "ck_claim_salience"
  CHECK ("salience" IS NULL OR "salience" BETWEEN 0 AND 100);
