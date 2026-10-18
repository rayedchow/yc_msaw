-- Indexes for FK columns exercised by mass deletes (graph.rebuild / KB reset).
-- Without them, deleting N parent rows fires per-row FK triggers that
-- seq-scan the referencing tables: with 286k contradiction_verdicts the
-- self-referencing escalation FK made the reset O(n^2) — two live rebuilds
-- spun 70+ minutes inside DELETE and died (diagnosed 2026-07-10 on dev).
-- IF NOT EXISTS because dev RDS received these manually during the incident.

CREATE INDEX IF NOT EXISTS "idx_contradiction_nominations_verdict_id"
  ON "contradiction_nominations" ("verdict_id");

CREATE INDEX IF NOT EXISTS "idx_contradiction_verdicts_escalation_verdict_id"
  ON "contradiction_verdicts" ("escalation_verdict_id");

CREATE INDEX IF NOT EXISTS "idx_claims_superseded_by"
  ON "claims" ("superseded_by");

CREATE INDEX IF NOT EXISTS "idx_claims_conclusion_carried_from"
  ON "claims" ("conclusion_carried_from");

CREATE INDEX IF NOT EXISTS "idx_entities_canonical_id"
  ON "entities" ("canonical_id");
