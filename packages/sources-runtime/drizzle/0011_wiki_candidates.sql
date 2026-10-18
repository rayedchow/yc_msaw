CREATE TABLE "wiki_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "seed_entity_ids" uuid[] NOT NULL,
  "trigger" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "score" real NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "judged_at" timestamp with time zone,
  "judge_rationale" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_wiki_candidate_trigger"
    CHECK ("trigger" IN ('supply', 'demand', 'both', 'agent', 'sme')),
  CONSTRAINT "ck_wiki_candidate_status"
    CHECK ("status" IN ('pending', 'judging', 'created', 'skipped', 'deferred', 'cooldown'))
);

CREATE UNIQUE INDEX "uq_wiki_candidate_nonterminal_cluster"
  ON "wiki_candidates" ("kb_id", "seed_entity_ids")
  WHERE "status" IN ('pending', 'judging');

CREATE INDEX "idx_wiki_candidate_kb_status_created"
  ON "wiki_candidates" ("kb_id", "status", "created_at" DESC);
