-- Retire unused source vocabulary and the unused derivation store.

ALTER TABLE "canonical_entities"
  DROP CONSTRAINT "ck_canonical_entity_source_categories",
  ADD CONSTRAINT "ck_canonical_entity_source_categories" CHECK (
    jsonb_typeof("source_categories") = 'array'
    AND "source_categories" <@ '["COLLABORATIVE_CONTENT", "MESSAGING", "EMAIL", "CALENDAR", "CODE_REPOSITORY", "MEETING_TRANSCRIPT", "KNOWLEDGE_HUB", "PEOPLE"]'::jsonb
  );

ALTER TABLE "mention_occurrences"
  DROP CONSTRAINT "ck_mention_occurrence_source_category",
  ADD CONSTRAINT "ck_mention_occurrence_source_category" CHECK (
    "source_category" IN ('COLLABORATIVE_CONTENT', 'MESSAGING', 'EMAIL', 'CALENDAR', 'CODE_REPOSITORY', 'MEETING_TRANSCRIPT', 'KNOWLEDGE_HUB', 'PEOPLE')
  );

ALTER TABLE "evidence_assertions"
  DROP CONSTRAINT "ck_evidence_assertion_source_category",
  ADD CONSTRAINT "ck_evidence_assertion_source_category" CHECK (
    "source_category" IN ('COLLABORATIVE_CONTENT', 'MESSAGING', 'EMAIL', 'CALENDAR', 'CODE_REPOSITORY', 'MEETING_TRANSCRIPT', 'KNOWLEDGE_HUB', 'PEOPLE')
  );

-- Preserve the cumulative statement-subject and snapshot-KB changes while
-- removing only the obsolete derivation citation guard from the live trigger.
DO $$
DECLARE
  definition text;
  updated_definition text;
  obsolete_clause constant text := E'      IF EXISTS (SELECT 1 FROM fact_derivations WHERE source_fact_id = OLD.id) THEN\n        RAISE EXCEPTION ''canonical fact cited by a derivation cannot change meaning'';\n      END IF;\n';
BEGIN
  SELECT pg_get_functiondef('graph_v2_validate_canonical_fact()'::regprocedure) INTO definition;
  updated_definition := replace(definition, obsolete_clause, '');
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'expected fact derivation citation guard was not found';
  END IF;
  EXECUTE updated_definition;
END;
$$;

-- Snapshot KBs intentionally copy only canonical rows. Every live fact must
-- instead retain at least one source-evidence edge.
CREATE OR REPLACE FUNCTION graph_v2_assert_fact_provenance(fact_id uuid) RETURNS void AS $$
DECLARE fact_kb uuid; evidence_count bigint;
BEGIN
  SELECT kb_id INTO fact_kb FROM canonical_facts WHERE id = fact_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF graph_v2_is_snapshot_kb(fact_kb) THEN RETURN; END IF;
  SELECT count(*) INTO evidence_count FROM fact_evidence WHERE canonical_fact_id = fact_id;
  IF evidence_count < 1 THEN
    RAISE EXCEPTION 'canonical fact must have fact_evidence';
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TABLE "fact_derivations";
DROP FUNCTION graph_v2_validate_fact_derivation();
DROP FUNCTION graph_v2_check_fact_derivation_provenance();
