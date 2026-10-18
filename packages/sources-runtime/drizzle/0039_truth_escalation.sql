ALTER TABLE "contradiction_verdicts"
  DROP CONSTRAINT "ck_contradiction_verdict";

ALTER TABLE "contradiction_verdicts"
  ADD CONSTRAINT "ck_contradiction_verdict"
  CHECK ("verdict" IN (
    'supersedes',
    'coexists',
    'unrelated',
    'unrated',
    'supersedes_downward_softened',
    'tier_guarded',
    'extraction_error',
    'human_pinned'
  ));

ALTER TABLE "contradiction_verdicts"
  ADD COLUMN "escalation_state" text NOT NULL DEFAULT 'none',
  ADD COLUMN "escalating_at" timestamp with time zone,
  ADD COLUMN "escalated_at" timestamp with time zone,
  ADD COLUMN "escalation_verdict_id" uuid REFERENCES "contradiction_verdicts" ("id"),
  ADD COLUMN "suspect_claim_id" uuid REFERENCES "claims" ("id"),
  ADD CONSTRAINT "ck_contradiction_verdict_escalation_state"
    CHECK ("escalation_state" IN ('none', 'pending', 'escalating', 'done'));

UPDATE "contradiction_verdicts"
SET "escalation_state" = 'pending'
WHERE "verdict" = 'supersedes_downward_softened'
  AND "superseded" = false;

CREATE INDEX "idx_contradiction_verdicts_kb_escalation_active"
  ON "contradiction_verdicts" ("kb_id", "escalation_state")
  WHERE "escalation_state" IN ('pending', 'escalating');

CREATE TABLE "resolution_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "claim_a_id" uuid NOT NULL REFERENCES "claims" ("id"),
  "claim_b_id" uuid NOT NULL REFERENCES "claims" ("id"),
  "action" text NOT NULL,
  "reinstated_claim_id" uuid REFERENCES "claims" ("id"),
  "actor" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_resolution_override_action"
    CHECK ("action" IN ('reinstate', 'confirm')),
  CONSTRAINT "ck_resolution_override_normalized_pair"
    CHECK ("claim_a_id" < "claim_b_id"),
  CONSTRAINT "uq_resolution_override_pair"
    UNIQUE ("kb_id", "claim_a_id", "claim_b_id")
);

CREATE TABLE "sme_digests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_sme_digests_kb_created"
  ON "sme_digests" ("kb_id", "created_at" DESC);
