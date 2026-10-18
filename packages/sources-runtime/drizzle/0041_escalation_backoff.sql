ALTER TABLE "contradiction_verdicts"
  ADD COLUMN "escalation_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "escalation_next_attempt_at" timestamp with time zone;

CREATE INDEX "idx_contradiction_verdicts_kb_escalation_due"
  ON "contradiction_verdicts" ("kb_id", "escalation_state", "escalation_next_attempt_at")
  WHERE "escalation_state" IN ('pending', 'escalating');
