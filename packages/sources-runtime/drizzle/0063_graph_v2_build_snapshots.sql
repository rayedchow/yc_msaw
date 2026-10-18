-- Graph v2 build snapshots. Before a rebuild wipes a KB's v2 graph, the
-- canonical layer (canonical_entities, canonical_facts,
-- canonical_entity_aliases) is copied into a read-only snapshot
-- kb_container (slug 'v2-snapshot:<kbId-prefix>:<ISO timestamp>').
--
-- The snapshot deliberately EXCLUDES the mention/evidence layer
-- (mention_occurrences, evidence_assertions, fact_evidence):
-- graph_v2_validate_mention and graph_v2_validate_evidence_assertion
-- require the cited chunk to live in the SAME kb as the row, so copying
-- that layer would mean duplicating every chunk and source document per
-- snapshot. The dashboard explorer reads only the canonical layer.
--
-- Snapshot rows are verbatim copies of rows that already passed live
-- validation, and snapshot KBs are never written by extraction or
-- consolidation. Re-validation is therefore skipped for snapshot KBs so
-- historical shapes stay copyable:
--   * merged entities are re-inserted as-is (the live trigger forbids
--     inserting facts/mentions against non-active entities),
--   * facts referencing since-merged entities are re-inserted as-is,
--   * extracted facts carry no fact_evidence inside the snapshot, so the
--     deferred provenance constraint must not fire for snapshot KBs.

CREATE FUNCTION graph_v2_is_snapshot_kb(kb uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM kb_containers WHERE id = kb AND slug LIKE 'v2-snapshot:%'
  );
$$ LANGUAGE sql STABLE;

-- Inject a snapshot-KB early return at the top of each canonical-layer
-- validation trigger. pg_get_functiondef is used (as in 0061) so the current
-- cumulative definitions (0049 + 0053 + 0060 + 0061) are preserved verbatim.
DO $$
DECLARE
  function_name text;
  definition text;
  updated_definition text;
  guard constant text :=
    E'\nBEGIN\n  IF graph_v2_is_snapshot_kb(NEW.kb_id) THEN RETURN NEW; END IF;\n';
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'graph_v2_validate_canonical_entity()',
    'graph_v2_validate_canonical_fact()',
    'graph_v2_validate_canonical_entity_alias()'
  ] LOOP
    SELECT pg_get_functiondef(function_name::regprocedure) INTO definition;
    updated_definition := regexp_replace(definition, '\nBEGIN\n', guard);
    IF updated_definition = definition THEN
      RAISE EXCEPTION 'BEGIN anchor was not found in %', function_name;
    END IF;
    EXECUTE updated_definition;
  END LOOP;
END;
$$;

-- The deferred provenance constraint must not require fact_evidence /
-- fact_derivations for facts copied into a snapshot KB: provenance stays
-- with the live KB and is wiped together with it.
CREATE OR REPLACE FUNCTION graph_v2_assert_fact_provenance(fact_id uuid) RETURNS void AS $$
DECLARE fact_origin text; fact_kb uuid; evidence_count bigint; derivation_count bigint;
BEGIN
  SELECT origin, kb_id INTO fact_origin, fact_kb FROM canonical_facts WHERE id = fact_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF graph_v2_is_snapshot_kb(fact_kb) THEN RETURN; END IF;
  SELECT count(*) INTO evidence_count FROM fact_evidence WHERE canonical_fact_id = fact_id;
  SELECT count(*) INTO derivation_count FROM fact_derivations WHERE inferred_fact_id = fact_id;
  IF fact_origin = 'extracted' AND (evidence_count < 1 OR derivation_count <> 0) THEN
    RAISE EXCEPTION 'extracted fact must have fact_evidence and no fact_derivations';
  ELSIF fact_origin = 'inferred' AND (derivation_count < 1 OR evidence_count <> 0) THEN
    RAISE EXCEPTION 'inferred fact must have fact_derivations and no fact_evidence';
  END IF;
END;
$$ LANGUAGE plpgsql;
