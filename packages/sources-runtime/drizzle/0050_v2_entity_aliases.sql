-- Slice 2: durable aliases and explicit entity-linking outcomes. Additive and
-- deliberately scoped to graph-v2 tables.

CREATE TABLE "canonical_entity_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "entity_id" uuid NOT NULL REFERENCES "canonical_entities" ("id"),
  "alias_kind" text NOT NULL,
  "alias_value" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_canonical_entity_alias_kind" CHECK (
    "alias_kind" IN ('name', 'display_name', 'mention_surface')
  ),
  CONSTRAINT "ck_canonical_entity_alias_value" CHECK (length(btrim("alias_value")) > 0)
);

CREATE UNIQUE INDEX "uq_canonical_entity_alias"
  ON "canonical_entity_aliases" ("kb_id", "entity_id", "alias_kind", lower(btrim("alias_value")));
CREATE INDEX "idx_canonical_entity_alias_lookup"
  ON "canonical_entity_aliases" USING gin (lower(btrim("alias_value")) gin_trgm_ops);

CREATE FUNCTION graph_v2_validate_canonical_entity_alias() RETURNS trigger AS $$
DECLARE entity_row record;
BEGIN
  SELECT tenant_id, kb_id INTO entity_row
  FROM canonical_entities
  WHERE id = NEW.entity_id;
  IF NOT FOUND OR entity_row.tenant_id <> NEW.tenant_id OR entity_row.kb_id <> NEW.kb_id THEN
    RAISE EXCEPTION 'canonical entity alias must share tenant and kb with its entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER graph_v2_canonical_entity_alias_validate
BEFORE INSERT OR UPDATE ON "canonical_entity_aliases"
FOR EACH ROW EXECUTE FUNCTION graph_v2_validate_canonical_entity_alias();

CREATE INDEX "idx_canonical_entity_name_trgm"
  ON "canonical_entities" USING gin (lower(btrim("canonical_name")) gin_trgm_ops);

ALTER TABLE "mention_occurrences"
  ADD COLUMN "resolution_reason" text,
  ADD COLUMN "resolution_context" jsonb,
  ADD COLUMN "resolved_at" timestamptz;
