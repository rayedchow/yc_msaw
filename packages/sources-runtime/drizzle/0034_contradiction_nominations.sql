CREATE TABLE "contradiction_nominations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "claim_a_id" uuid NOT NULL REFERENCES "claims" ("id"),
  "claim_b_id" uuid NOT NULL REFERENCES "claims" ("id"),
  "source" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "adjudicating_at" timestamp with time zone,
  "verdict_id" uuid REFERENCES "contradiction_verdicts" ("id"),
  "dismiss_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_at" timestamp with time zone,
  CONSTRAINT "ck_contradiction_nomination_source"
    CHECK ("source" IN ('read_time', 'sweep', 'merge')),
  CONSTRAINT "ck_contradiction_nomination_state"
    CHECK ("state" IN ('pending', 'adjudicating', 'resolved', 'dismissed')),
  CONSTRAINT "ck_contradiction_nomination_distinct_claims"
    CHECK ("claim_a_id" <> "claim_b_id"),
  CONSTRAINT "ck_contradiction_nomination_normalized_pair"
    CHECK ("claim_a_id" < "claim_b_id")
);

CREATE UNIQUE INDEX "uq_contradiction_nomination_pair"
  ON "contradiction_nominations" ("kb_id", "claim_a_id", "claim_b_id");

CREATE INDEX "idx_contradiction_nominations_kb_state_created"
  ON "contradiction_nominations" ("kb_id", "state", "created_at");
