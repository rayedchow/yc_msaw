CREATE TABLE "contradiction_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "new_claim_id" uuid NOT NULL REFERENCES "claims" ("id"),
  "existing_claim_id" uuid NOT NULL REFERENCES "claims" ("id"),
  "verdict" text NOT NULL,
  "confident" boolean,
  "superseded" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_contradiction_verdict"
    CHECK ("verdict" IN ('supersedes', 'coexists', 'unrelated', 'unrated', 'supersedes_downward_softened', 'tier_guarded'))
);

CREATE INDEX "idx_contradiction_verdicts_kb_verdict_created"
  ON "contradiction_verdicts" ("kb_id", "verdict", "created_at");

CREATE TABLE "hygiene_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "window_days" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_hygiene_reports_kb_created"
  ON "hygiene_reports" ("kb_id", "created_at" DESC);

ALTER TABLE "entity_links"
  ADD COLUMN "created_at" timestamp with time zone NOT NULL DEFAULT now();
