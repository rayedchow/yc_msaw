ALTER TABLE "entities"
  ADD COLUMN "last_swept_at" timestamp with time zone;

CREATE INDEX "idx_entities_kb_last_swept"
  ON "entities" ("kb_id", "last_swept_at" ASC NULLS FIRST);

CREATE TABLE "sweep_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "entity_id" uuid NOT NULL REFERENCES "entities" ("id"),
  "trigger" text NOT NULL,
  "status" text NOT NULL,
  "claims_seen" integer NOT NULL,
  "claims_truncated" integer NOT NULL DEFAULT 0,
  "hops" integer NOT NULL DEFAULT 0,
  "nominations_emitted" integer NOT NULL,
  "nominations_dropped" integer NOT NULL DEFAULT 0,
  "duration_ms" integer NOT NULL,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_sweep_run_trigger"
    CHECK ("trigger" IN ('touched', 'merge', 'patrol')),
  CONSTRAINT "ck_sweep_run_status"
    CHECK ("status" IN ('ok', 'error'))
);

CREATE INDEX "idx_sweep_runs_kb_created"
  ON "sweep_runs" ("kb_id", "created_at" DESC);
