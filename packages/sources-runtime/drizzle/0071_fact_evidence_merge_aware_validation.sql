-- graph_v2_validate_fact_evidence predates entity merges: it compared the
-- mention's RAW resolved_entity_id against the fact's subject/object, but
-- facts are consolidated onto merge ROOTS (resolveActiveEntityRoot) while
-- evidence-cited mention resolutions are deliberately immutable and keep
-- pointing at merged losers. Every assertion citing a merged entity became
-- permanently unattachable ("evidence assertion does not match canonical
-- fact tuple" — 35 chunks live, issue #190). Root both sides through the
-- same canonical_id chain before comparing. Also accept the consolidator's
-- statement self-reference collapse (about == speaker => fact object NULL).
CREATE OR REPLACE FUNCTION graph_v2_entity_active_root(entity_id uuid) RETURNS uuid AS $$
  WITH RECURSIVE entity_chain AS (
    SELECT entity.id, entity.canonical_id, entity.status, ARRAY[entity.id] AS path
    FROM canonical_entities entity
    WHERE entity.id = entity_id
    UNION ALL
    SELECT parent.id, parent.canonical_id, parent.status, chain.path || parent.id
    FROM entity_chain chain
    JOIN canonical_entities parent ON parent.id = chain.canonical_id
    WHERE chain.status = 'merged' AND NOT parent.id = ANY(chain.path)
  )
  SELECT id FROM entity_chain WHERE status = 'active' AND canonical_id IS NULL LIMIT 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION graph_v2_validate_fact_evidence() RETURNS trigger AS $$
DECLARE fact_row canonical_facts%ROWTYPE; evidence_row evidence_assertions%ROWTYPE; subject_entity uuid; object_entity uuid;
BEGIN
  SELECT * INTO fact_row FROM canonical_facts WHERE id = NEW.canonical_fact_id;
  SELECT * INTO evidence_row FROM evidence_assertions WHERE id = NEW.evidence_assertion_id;
  IF fact_row.id IS NULL OR evidence_row.id IS NULL OR fact_row.tenant_id <> evidence_row.tenant_id OR fact_row.kb_id <> evidence_row.kb_id THEN
    RAISE EXCEPTION 'fact evidence must share tenant and knowledge base';
  END IF;
  IF fact_row.origin <> 'extracted' THEN
    RAISE EXCEPTION 'inferred facts cannot be source-grounded through fact_evidence';
  END IF;
  SELECT graph_v2_entity_active_root(resolved_entity_id) INTO subject_entity
  FROM mention_occurrences WHERE id = evidence_row.subject_mention_id;
  IF evidence_row.object_mention_id IS NOT NULL THEN
    SELECT graph_v2_entity_active_root(resolved_entity_id) INTO object_entity
    FROM mention_occurrences WHERE id = evidence_row.object_mention_id;
  END IF;
  IF subject_entity IS NULL OR subject_entity <> fact_row.subject_entity_id
      OR evidence_row.assertion_kind <> fact_row.assertion_kind
      OR evidence_row.relation IS DISTINCT FROM fact_row.relation
      OR evidence_row.scalar_property IS DISTINCT FROM fact_row.scalar_property
      OR (fact_row.assertion_kind = 'statement' AND graph_v2_statement_hash(evidence_row.statement_text) IS DISTINCT FROM fact_row.statement_hash)
      OR (
        object_entity IS DISTINCT FROM fact_row.object_entity_id
        AND NOT (fact_row.assertion_kind = 'statement' AND fact_row.object_entity_id IS NULL AND object_entity = subject_entity)
      )
      OR evidence_row.object_value IS DISTINCT FROM fact_row.scalar_value
      OR (fact_row.assertion_kind <> 'statement' AND evidence_row.qualifiers IS DISTINCT FROM fact_row.qualifiers) THEN
    RAISE EXCEPTION 'evidence assertion does not match canonical fact tuple';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
