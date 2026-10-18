-- V2 relational same-as decisions and the guarded canonical merge primitive.
-- This is additive: v1 entities/entity_links and their writers are untouched.

CREATE TABLE "v2_same_as_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "a_entity_id" uuid NOT NULL REFERENCES "canonical_entities" ("id"),
  "b_entity_id" uuid NOT NULL REFERENCES "canonical_entities" ("id"),
  "state" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "judge_model" text NOT NULL,
  "judge_reason" text NOT NULL,
  "winner_entity_id" uuid REFERENCES "canonical_entities" ("id"),
  "loser_entity_id" uuid REFERENCES "canonical_entities" ("id"),
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_v2_same_as_decision_pair" UNIQUE ("kb_id", "a_entity_id", "b_entity_id"),
  CONSTRAINT "ck_v2_same_as_decision_pair_order" CHECK ("a_entity_id" < "b_entity_id"),
  CONSTRAINT "ck_v2_same_as_decision_state" CHECK ("state" IN ('merged', 'judge_rejected', 'key_conflict', 'merge_conflict')),
  CONSTRAINT "ck_v2_same_as_decision_evidence" CHECK (jsonb_typeof("evidence") = 'object'),
  CONSTRAINT "ck_v2_same_as_decision_reason" CHECK (length(btrim("judge_reason")) > 0),
  CONSTRAINT "ck_v2_same_as_decision_merge_ids" CHECK (
    ("state" = 'merged' AND "winner_entity_id" IS NOT NULL AND "loser_entity_id" IS NOT NULL)
    OR "state" <> 'merged'
  )
);
CREATE INDEX "idx_v2_same_as_decision_kb_state"
  ON "v2_same_as_decisions" ("kb_id", "state", "decided_at");

CREATE FUNCTION graph_v2_identity_norm(kind text, value text)
RETURNS text AS $$
BEGIN
  IF kind = 'phone' THEN RETURN graph_v2_phone_norm(value); END IF;
  IF kind = 'domain' THEN RETURN graph_v2_domain_norm(value); END IF;
  RETURN lower(btrim(value));
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- 0049's reference guard remains the default. Only this transaction-scoped
-- merge primitive may install a canonical_id pointer on a referenced entity.
CREATE OR REPLACE FUNCTION graph_v2_validate_canonical_entity() RETURNS trigger AS $$
DECLARE target_row record;
BEGIN
  IF NEW.canonical_id IS NOT NULL THEN
    IF NEW.canonical_id = NEW.id THEN RAISE EXCEPTION 'canonical entity cannot merge into itself'; END IF;
    SELECT tenant_id, kb_id, entity_type, status, canonical_id
      INTO target_row FROM canonical_entities WHERE id = NEW.canonical_id;
    IF NOT FOUND OR target_row.tenant_id <> NEW.tenant_id OR target_row.kb_id <> NEW.kb_id
        OR target_row.entity_type <> NEW.entity_type OR target_row.status <> 'active' OR target_row.canonical_id IS NOT NULL THEN
      RAISE EXCEPTION 'canonical merge target must be an active same-scope entity of the same type';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
      AND ((NEW.status = 'merged' AND OLD.status IS DISTINCT FROM 'merged')
        OR NEW.entity_type IS DISTINCT FROM OLD.entity_type)
      AND current_setting('graph_v2.merge_context', true) IS DISTINCT FROM 'on'
      AND (
        EXISTS (SELECT 1 FROM canonical_entities WHERE canonical_id = NEW.id)
        OR EXISTS (
          SELECT 1 FROM canonical_facts
          WHERE invalid_at IS NULL
            AND (subject_entity_id = NEW.id OR object_entity_id = NEW.id)
        )
        OR EXISTS (SELECT 1 FROM mention_occurrences WHERE resolved_entity_id = NEW.id)
      ) THEN
    RAISE EXCEPTION 'referenced canonical entity cannot be merged or change type';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION graph_v2_merge_canonical_entities(
  input_a uuid,
  input_b uuid,
  preferred_winner uuid
) RETURNS TABLE(result text, winner_id uuid, loser_id uuid) AS $$
DECLARE
  a_row canonical_entities%ROWTYPE;
  b_row canonical_entities%ROWTYPE;
  a_kb_id uuid;
  b_kb_id uuid;
  a_root_id uuid;
  b_root_id uuid;
  winner_row canonical_entities%ROWTYPE;
  loser_row canonical_entities%ROWTYPE;
  key_name text;
  key_value text;
  merged_keys jsonb;
  merged_categories jsonb;
BEGIN
  IF input_a = input_b THEN RAISE EXCEPTION 'same-as pair must contain two entities'; END IF;

  SELECT kb_id INTO a_kb_id FROM canonical_entities WHERE id = input_a;
  SELECT kb_id INTO b_kb_id FROM canonical_entities WHERE id = input_b;
  IF a_kb_id IS NULL OR b_kb_id IS NULL THEN RAISE EXCEPTION 'same-as entities must exist'; END IF;
  IF a_kb_id <> b_kb_id THEN
    RETURN QUERY SELECT 'scope_or_root_conflict'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  -- Overlapping A/B and B/C merges must not choose roots from stale snapshots.
  PERFORM pg_advisory_xact_lock(hashtextextended('graph_v2_merge:' || a_kb_id::text, 0));

  -- Always acquire pair locks in UUID order so reversed concurrent calls cannot
  -- deadlock. Re-reading after the locks also observes a merge that won the race.
  PERFORM id FROM canonical_entities
  WHERE id IN (input_a, input_b)
  ORDER BY id
  FOR UPDATE;
  SELECT * INTO a_row FROM canonical_entities WHERE id = input_a;
  SELECT * INTO b_row FROM canonical_entities WHERE id = input_b;
  IF a_row.id IS NULL OR b_row.id IS NULL THEN RAISE EXCEPTION 'same-as entities must exist'; END IF;
  a_root_id := CASE WHEN a_row.status = 'merged' THEN a_row.canonical_id ELSE a_row.id END;
  b_root_id := CASE WHEN b_row.status = 'merged' THEN b_row.canonical_id ELSE b_row.id END;
  PERFORM id FROM canonical_entities
  WHERE id IN (a_root_id, b_root_id)
  ORDER BY id
  FOR UPDATE;
  SELECT * INTO a_row FROM canonical_entities WHERE id = a_root_id;
  SELECT * INTO b_row FROM canonical_entities WHERE id = b_root_id;

  IF a_row.id = b_row.id THEN
    RETURN QUERY SELECT 'already_merged'::text, a_row.id, CASE WHEN input_a = a_row.id THEN input_b ELSE input_a END;
    RETURN;
  END IF;
  IF a_row.tenant_id <> b_row.tenant_id OR a_row.kb_id <> b_row.kb_id OR a_row.entity_type <> b_row.entity_type
      OR a_row.entity_type <> 'Organization' OR a_row.status <> 'active' OR b_row.status <> 'active'
      OR a_row.canonical_id IS NOT NULL OR b_row.canonical_id IS NOT NULL THEN
    RETURN QUERY SELECT 'scope_or_root_conflict'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  IF preferred_winner IN (input_a, a_row.id) THEN winner_row := a_row; loser_row := b_row;
  ELSIF preferred_winner IN (input_b, b_row.id) THEN winner_row := b_row; loser_row := a_row;
  ELSE
    RETURN QUERY SELECT 'preferred_winner_outside_pair'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- One JSON slot cannot losslessly hold two distinct values of the same hard
  -- key kind. Domain is special: the loser's primary domain becomes an alias.
  FOR key_name, key_value IN SELECT key, value FROM jsonb_each_text(loser_row.identity_keys) LOOP
    IF key_name <> 'domain' AND winner_row.identity_keys ? key_name
        AND graph_v2_identity_norm(key_name, winner_row.identity_keys ->> key_name)
          <> graph_v2_identity_norm(key_name, key_value) THEN
      RETURN QUERY SELECT 'key_conflict'::text, winner_row.id, loser_row.id;
      RETURN;
    END IF;
  END LOOP;

  -- Preserve the winner's spelling when both rows carry the same normalized
  -- key; otherwise fill the winner's missing slots from the loser.
  merged_keys := (loser_row.identity_keys - 'domain') || winner_row.identity_keys;
  IF NOT (winner_row.identity_keys ? 'domain') AND loser_row.identity_keys ? 'domain' THEN
    merged_keys := merged_keys || jsonb_build_object('domain', graph_v2_domain_norm(loser_row.identity_keys ->> 'domain'));
  END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) INTO merged_categories
  FROM (SELECT DISTINCT value FROM jsonb_array_elements(winner_row.source_categories || loser_row.source_categories)) categories;

  BEGIN
    PERFORM set_config('graph_v2.merge_context', 'on', true);

    -- The loser keeps its immutable mentions, facts, aliases, and categories.
    -- Hard identity keys move because their indexes are globally unique within
    -- the KB; the canonical_id pointer preserves how consumers resolve them.
    UPDATE canonical_entities
    SET identity_keys = '{}'::jsonb, canonical_id = winner_row.id,
        status = 'merged', merged_at = now(), updated_at = now()
    WHERE id = loser_row.id AND status = 'active' AND canonical_id IS NULL;
    IF NOT FOUND THEN
      PERFORM set_config('graph_v2.merge_context', 'off', true);
      RETURN QUERY SELECT 'scope_or_root_conflict'::text, winner_row.id, loser_row.id;
      RETURN;
    END IF;

    UPDATE canonical_entities
    SET identity_keys = merged_keys, source_categories = merged_categories, updated_at = now()
    WHERE id = winner_row.id AND status = 'active' AND canonical_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'canonical merge winner stopped being an active root';
    END IF;

    INSERT INTO canonical_entity_aliases (tenant_id, kb_id, entity_id, alias_kind, alias_value)
    SELECT tenant_id, kb_id, winner_row.id, alias_kind, alias_value
    FROM canonical_entity_aliases WHERE entity_id = loser_row.id
    ON CONFLICT (kb_id, entity_id, alias_kind, lower(btrim(alias_value))) DO NOTHING;
    INSERT INTO canonical_entity_aliases (tenant_id, kb_id, entity_id, alias_kind, alias_value)
    VALUES (winner_row.tenant_id, winner_row.kb_id, winner_row.id, 'name', loser_row.canonical_name)
    ON CONFLICT (kb_id, entity_id, alias_kind, lower(btrim(alias_value))) DO NOTHING;
    IF loser_row.identity_keys ? 'domain' THEN
      INSERT INTO canonical_entity_aliases (tenant_id, kb_id, entity_id, alias_kind, alias_value)
      VALUES (winner_row.tenant_id, winner_row.kb_id, winner_row.id, 'domain', graph_v2_domain_norm(loser_row.identity_keys ->> 'domain'))
      ON CONFLICT (kb_id, entity_id, alias_kind, lower(btrim(alias_value))) DO NOTHING;
    END IF;

    PERFORM set_config('graph_v2.merge_context', 'off', true);
  EXCEPTION WHEN unique_violation THEN
    PERFORM set_config('graph_v2.merge_context', 'off', true);
    RETURN QUERY SELECT 'key_conflict'::text, winner_row.id, loser_row.id;
    RETURN;
  END;

  RETURN QUERY SELECT 'merged'::text, winner_row.id, loser_row.id;
END;
$$ LANGUAGE plpgsql;
