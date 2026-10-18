CREATE TABLE "wiki_entity_agent_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers"("id"),
  "entity_id" uuid NOT NULL REFERENCES "canonical_entities"("id"),
  "status" text DEFAULT 'pending_bootstrap' NOT NULL,
  "cursor_at" timestamptz,
  "bootstrap_completed_at" timestamptz,
  "last_run_at" timestamptz,
  "last_result" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "wiki_entity_agent_state_status_check"
    CHECK ("status" IN ('pending_bootstrap', 'active', 'archived')),
  CONSTRAINT "wiki_entity_agent_state_kb_entity_unique" UNIQUE("kb_id", "entity_id")
);

CREATE INDEX "wiki_entity_agent_state_tenant_kb_status_idx"
  ON "wiki_entity_agent_state" ("tenant_id", "kb_id", "status");
