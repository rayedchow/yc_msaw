ALTER TABLE "claims"
  ADD COLUMN "modality" text NOT NULL DEFAULT 'asserted';

ALTER TABLE "claims"
  ADD CONSTRAINT "ck_claim_modality"
  CHECK ("modality" IN ('asserted', 'believed', 'planned', 'speculated', 'reported'));
