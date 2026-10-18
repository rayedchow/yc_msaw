-- Operator identity directory: tenant-wide ground-truth identity groups.
-- A group ('philip-meng') asserts that several strong identity values (four
-- emails, a github handle, ...) all name one real-world principal. The linker
-- injects a synthetic strong key 'directory' = group_slug into mentions whose
-- keys appear in the directory, so every mention carrying ANY of the group's
-- keys resolves deterministically to one canonical entity.
--
-- Deliberately NOT kb-scoped and NOT a v2 graph table: graph.rebuild
-- (src/graph/admin/reset.ts -> deleteV2RowsInTransaction) wipes v2 graph rows
-- per kb; operator assertions must survive rebuilds, so they live here.
CREATE TABLE "identity_directory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "group_slug" text NOT NULL,
  "display_name" text NOT NULL,
  "entity_type" text NOT NULL DEFAULT 'Person',
  "key_kind" text NOT NULL,
  "key_value" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_identity_directory_key" UNIQUE ("tenant_id", "key_kind", "key_value"),
  CONSTRAINT "ck_identity_directory_group_slug" CHECK (
    "group_slug" ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' AND length("group_slug") <= 128
  ),
  CONSTRAINT "ck_identity_directory_display_name" CHECK (length(btrim("display_name")) > 0),
  CONSTRAINT "ck_identity_directory_entity_type" CHECK (
    "entity_type" IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')
  ),
  CONSTRAINT "ck_identity_directory_key_kind" CHECK (
    "key_kind" <> 'directory' AND length(btrim("key_kind")) > 0
  ),
  -- key_value is stored normalized (lower/trim; digits-only for phone) by the
  -- CLI and asserted here so the UNIQUE constraint cannot be dodged by casing.
  CONSTRAINT "ck_identity_directory_key_value" CHECK (
    length(btrim("key_value")) > 0 AND "key_value" = lower(btrim("key_value"))
  )
);

CREATE INDEX "idx_identity_directory_group" ON "identity_directory" ("tenant_id", "group_slug");

-- Allow the synthetic 'directory' identity key on canonical entities: the
-- 0059 constraint body, with 'directory' added to the allowed-kind array and
-- a slug-shaped value guard appended.
ALTER TABLE "canonical_entities"
  DROP CONSTRAINT "ck_canonical_entity_identity_keys",
  ADD CONSTRAINT "ck_canonical_entity_identity_keys" CHECK (
    jsonb_typeof("identity_keys") = 'object'
    AND ("identity_keys" - ARRAY['directory', 'email', 'phone', 'repo_key', 'domain', 'handle:slack', 'handle:discord', 'handle:instagram', 'handle:github', 'handle:x', 'handle:linkedin', 'source_ref:granola', 'source_ref:gcal', 'source_ref:gmail', 'source_ref:slack', 'source_ref:imessage', 'source_ref:notion', 'source_ref:github']::text[]) = '{}'::jsonb
    AND (NOT ("identity_keys" ? 'email') OR (jsonb_typeof("identity_keys" -> 'email') = 'string' AND strpos("identity_keys" ->> 'email', '..') = 0 AND strpos("identity_keys" ->> 'email', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'email'))) >= 3 AND lower(btrim("identity_keys" ->> 'email')) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'))
    AND (NOT ("identity_keys" ? 'phone') OR (jsonb_typeof("identity_keys" -> 'phone') = 'string' AND strpos("identity_keys" ->> 'phone', '..') = 0 AND strpos("identity_keys" ->> 'phone', '…') = 0 AND length(graph_v2_phone_norm("identity_keys" ->> 'phone')) >= 7 AND graph_v2_phone_norm("identity_keys" ->> 'phone') ~ '^\d{7,}$'))
    AND (NOT ("identity_keys" ? 'repo_key') OR (jsonb_typeof("identity_keys" -> 'repo_key') = 'string' AND strpos("identity_keys" ->> 'repo_key', '..') = 0 AND strpos("identity_keys" ->> 'repo_key', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'repo_key'))) >= 1 AND lower(btrim("identity_keys" ->> 'repo_key')) ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'domain') OR ("entity_type" = 'Organization' AND jsonb_typeof("identity_keys" -> 'domain') = 'string' AND strpos("identity_keys" ->> 'domain', '..') = 0 AND strpos("identity_keys" ->> 'domain', '…') = 0 AND length(graph_v2_domain_norm("identity_keys" ->> 'domain')) >= 1 AND graph_v2_domain_norm("identity_keys" ->> 'domain') ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'handle:slack') OR (jsonb_typeof("identity_keys" -> 'handle:slack') = 'string' AND strpos("identity_keys" ->> 'handle:slack', '..') = 0 AND strpos("identity_keys" ->> 'handle:slack', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'handle:slack'))) >= 7 AND lower(btrim("identity_keys" ->> 'handle:slack')) ~ '^[uw][a-z0-9]{6,}$'))
    AND (NOT ("identity_keys" ? 'handle:discord') OR (jsonb_typeof("identity_keys" -> 'handle:discord') = 'string' AND strpos("identity_keys" ->> 'handle:discord', '..') = 0 AND strpos("identity_keys" ->> 'handle:discord', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'handle:discord'))) >= 2 AND length(lower(btrim("identity_keys" ->> 'handle:discord'))) <= 32 AND lower(btrim("identity_keys" ->> 'handle:discord')) ~ '^[a-z0-9_](?:[a-z0-9_]|\.[a-z0-9_])+$'))
    AND (NOT ("identity_keys" ? 'handle:instagram') OR (jsonb_typeof("identity_keys" -> 'handle:instagram') = 'string' AND strpos("identity_keys" ->> 'handle:instagram', '..') = 0 AND strpos("identity_keys" ->> 'handle:instagram', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'handle:instagram'))) >= 2 AND length(lower(btrim("identity_keys" ->> 'handle:instagram'))) <= 30 AND lower(btrim("identity_keys" ->> 'handle:instagram')) ~ '^[a-z0-9_](?:[a-z0-9_]|\.[a-z0-9_])+$'))
    AND (NOT ("identity_keys" ? 'handle:github') OR (jsonb_typeof("identity_keys" -> 'handle:github') = 'string' AND strpos("identity_keys" ->> 'handle:github', '..') = 0 AND strpos("identity_keys" ->> 'handle:github', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'handle:github'))) >= 2 AND length(lower(btrim("identity_keys" ->> 'handle:github'))) <= 39 AND lower(btrim("identity_keys" ->> 'handle:github')) ~ '^[a-z0-9](?:[a-z0-9]|-[a-z0-9])+$'))
    AND (NOT ("identity_keys" ? 'handle:x') OR (jsonb_typeof("identity_keys" -> 'handle:x') = 'string' AND strpos("identity_keys" ->> 'handle:x', '..') = 0 AND strpos("identity_keys" ->> 'handle:x', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'handle:x'))) >= 2 AND length(lower(btrim("identity_keys" ->> 'handle:x'))) <= 15 AND lower(btrim("identity_keys" ->> 'handle:x')) ~ '^[a-z0-9_]{2,15}$'))
    AND (NOT ("identity_keys" ? 'handle:linkedin') OR (jsonb_typeof("identity_keys" -> 'handle:linkedin') = 'string' AND strpos("identity_keys" ->> 'handle:linkedin', '..') = 0 AND strpos("identity_keys" ->> 'handle:linkedin', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'handle:linkedin'))) >= 3 AND length(lower(btrim("identity_keys" ->> 'handle:linkedin'))) <= 100 AND lower(btrim("identity_keys" ->> 'handle:linkedin')) ~ '^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){2,99}$'))
    AND (NOT ("identity_keys" ? 'source_ref:granola') OR (jsonb_typeof("identity_keys" -> 'source_ref:granola') = 'string' AND strpos("identity_keys" ->> 'source_ref:granola', '..') = 0 AND strpos("identity_keys" ->> 'source_ref:granola', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'source_ref:granola'))) >= 1 AND lower(btrim("identity_keys" ->> 'source_ref:granola')) ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'source_ref:gcal') OR (jsonb_typeof("identity_keys" -> 'source_ref:gcal') = 'string' AND strpos("identity_keys" ->> 'source_ref:gcal', '..') = 0 AND strpos("identity_keys" ->> 'source_ref:gcal', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'source_ref:gcal'))) >= 1 AND lower(btrim("identity_keys" ->> 'source_ref:gcal')) ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'source_ref:gmail') OR (jsonb_typeof("identity_keys" -> 'source_ref:gmail') = 'string' AND strpos("identity_keys" ->> 'source_ref:gmail', '..') = 0 AND strpos("identity_keys" ->> 'source_ref:gmail', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'source_ref:gmail'))) >= 1 AND lower(btrim("identity_keys" ->> 'source_ref:gmail')) ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'source_ref:slack') OR (jsonb_typeof("identity_keys" -> 'source_ref:slack') = 'string' AND strpos("identity_keys" ->> 'source_ref:slack', '..') = 0 AND strpos("identity_keys" ->> 'source_ref:slack', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'source_ref:slack'))) >= 1 AND lower(btrim("identity_keys" ->> 'source_ref:slack')) ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'source_ref:imessage') OR (jsonb_typeof("identity_keys" -> 'source_ref:imessage') = 'string' AND strpos("identity_keys" ->> 'source_ref:imessage', '..') = 0 AND strpos("identity_keys" ->> 'source_ref:imessage', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'source_ref:imessage'))) >= 1 AND lower(btrim("identity_keys" ->> 'source_ref:imessage')) ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'source_ref:notion') OR (jsonb_typeof("identity_keys" -> 'source_ref:notion') = 'string' AND strpos("identity_keys" ->> 'source_ref:notion', '..') = 0 AND strpos("identity_keys" ->> 'source_ref:notion', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'source_ref:notion'))) >= 1 AND lower(btrim("identity_keys" ->> 'source_ref:notion')) ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'source_ref:github') OR (jsonb_typeof("identity_keys" -> 'source_ref:github') = 'string' AND strpos("identity_keys" ->> 'source_ref:github', '..') = 0 AND strpos("identity_keys" ->> 'source_ref:github', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'source_ref:github'))) >= 1 AND lower(btrim("identity_keys" ->> 'source_ref:github')) ~ '^.+$'))
    AND (NOT ("identity_keys" ? 'directory') OR (jsonb_typeof("identity_keys" -> 'directory') = 'string' AND strpos("identity_keys" ->> 'directory', '..') = 0 AND strpos("identity_keys" ->> 'directory', '…') = 0 AND length(lower(btrim("identity_keys" ->> 'directory'))) >= 1 AND length(lower(btrim("identity_keys" ->> 'directory'))) <= 128 AND lower(btrim("identity_keys" ->> 'directory')) ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'))
  ) NOT VALID;

-- One canonical entity per directory group per kb: the strong-key upsert in
-- the linker conflicts on this index when the mention's first key is
-- 'directory'.
CREATE UNIQUE INDEX "uq_canonical_entity_kb_directory"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'directory')))
  WHERE "identity_keys" ? 'directory';

-- TRUE when two values of one key kind belong to the same directory group for
-- the tenant. STABLE (reads identity_directory), never errors on unknown keys.
CREATE FUNCTION graph_v2_identity_directory_same_group(
  input_tenant_id text,
  input_key_kind text,
  left_value text,
  right_value text
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM identity_directory left_key
    JOIN identity_directory right_key
      ON right_key.tenant_id = left_key.tenant_id
     AND right_key.group_slug = left_key.group_slug
    WHERE left_key.tenant_id = input_tenant_id
      AND left_key.key_kind = input_key_kind
      AND left_key.key_value = graph_v2_identity_norm(input_key_kind, left_value)
      AND right_key.key_kind = input_key_kind
      AND right_key.key_value = graph_v2_identity_norm(input_key_kind, right_value)
  );
$$ LANGUAGE sql STABLE STRICT;

-- 0060's merge behavior is unchanged except that same-kind key values grouped
-- by the operator identity directory no longer abort the merge, and the
-- loser's dropped grouped values are preserved as mention_surface aliases.
CREATE OR REPLACE FUNCTION graph_v2_merge_canonical_entities(
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
  PERFORM pg_advisory_xact_lock(hashtextextended('graph_v2_merge:' || a_kb_id::text, 0));

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
      OR a_row.status <> 'active' OR b_row.status <> 'active'
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

  FOR key_name, key_value IN SELECT key, value FROM jsonb_each_text(loser_row.identity_keys) LOOP
    IF key_name <> 'domain' AND winner_row.identity_keys ? key_name
        AND graph_v2_identity_norm(key_name, winner_row.identity_keys ->> key_name)
          <> graph_v2_identity_norm(key_name, key_value)
        -- Operator identity directory: two values of one kind asserted to name
        -- the same principal are not a merge conflict. The winner keeps its
        -- value; the loser's value survives below as a mention_surface alias.
        AND NOT graph_v2_identity_directory_same_group(
          winner_row.tenant_id, key_name,
          winner_row.identity_keys ->> key_name, key_value
        ) THEN
      RETURN QUERY SELECT 'key_conflict'::text, winner_row.id, loser_row.id;
      RETURN;
    END IF;
  END LOOP;

  merged_keys := (loser_row.identity_keys - 'domain') || winner_row.identity_keys;
  IF NOT (winner_row.identity_keys ? 'domain') AND loser_row.identity_keys ? 'domain' THEN
    merged_keys := merged_keys || jsonb_build_object('domain', graph_v2_domain_norm(loser_row.identity_keys ->> 'domain'));
  END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) INTO merged_categories
  FROM (SELECT DISTINCT value FROM jsonb_array_elements(winner_row.source_categories || loser_row.source_categories)) categories;

  BEGIN
    PERFORM set_config('graph_v2.merge_context', 'on', true);

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
    SET canonical_id = winner_row.id, updated_at = now()
    WHERE kb_id = winner_row.kb_id
      AND status = 'merged'
      AND canonical_id = loser_row.id;

    UPDATE canonical_entities
    SET identity_keys = merged_keys, source_categories = merged_categories,
        summary = NULL, summary_inputs_hash = NULL, updated_at = now()
    WHERE id = winner_row.id AND status = 'active' AND canonical_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'canonical merge winner stopped being an active root';
    END IF;

    UPDATE canonical_entity_sources source
    SET canonical_entity_id = winner_row.id, updated_at = now()
    WHERE source.kb_id = winner_row.kb_id
      AND source.canonical_entity_id IN (
        SELECT entity.id
        FROM canonical_entities entity
        WHERE entity.kb_id = winner_row.kb_id
          AND entity.canonical_id = winner_row.id
      );

    INSERT INTO canonical_entity_aliases (tenant_id, kb_id, entity_id, alias_kind, alias_value)
    SELECT tenant_id, kb_id, winner_row.id, alias_kind, alias_value
    FROM canonical_entity_aliases WHERE entity_id = loser_row.id
    ON CONFLICT (kb_id, entity_id, alias_kind, lower(btrim(alias_value))) DO NOTHING;
    INSERT INTO canonical_entity_aliases (tenant_id, kb_id, entity_id, alias_kind, alias_value)
    VALUES (winner_row.tenant_id, winner_row.kb_id, winner_row.id, 'name', loser_row.canonical_name)
    ON CONFLICT (kb_id, entity_id, alias_kind, lower(btrim(alias_value))) DO NOTHING;
    -- Directory-suppressed loser key values are dropped from merged_keys
    -- (one value per kind); keep them searchable as aliases.
    INSERT INTO canonical_entity_aliases (tenant_id, kb_id, entity_id, alias_kind, alias_value)
    SELECT winner_row.tenant_id, winner_row.kb_id, winner_row.id, 'mention_surface', dropped.value
    FROM jsonb_each_text(loser_row.identity_keys) dropped(key, value)
    WHERE dropped.key <> 'domain'
      AND winner_row.identity_keys ? dropped.key
      AND graph_v2_identity_norm(dropped.key, winner_row.identity_keys ->> dropped.key)
        <> graph_v2_identity_norm(dropped.key, dropped.value)
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
