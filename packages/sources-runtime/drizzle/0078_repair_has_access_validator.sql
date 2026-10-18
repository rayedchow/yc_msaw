-- 0072 added HAS_ACCESS to the relation matrix but accidentally replaced the
-- evidence validator with a pre-HAS_ACCESS relation allow-list and the older
-- narrow statement subject set. Repair the live functions in place.

DO $$
DECLARE
  definition text;
  repaired text;
  old_relation_list constant text := '(''FORMERLY_KNOWN_AS'', ''COFOUNDER_OF'', ''FOUNDER_OF'', ''HOLDS_ROLE_AT'', ''EMPLOYED_BY'', ''MEMBER_OF'', ''LEADS'', ''REPORTS_TO'', ''INVITED_TO'', ''ATTENDED'', ''ORGANIZED'', ''AUTHORED'', ''MAINTAINS'', ''CONTRIBUTED_TO'', ''OWNS'', ''ASSIGNED_TO'', ''REFERENCES'', ''MENTIONS'', ''PART_OF'', ''RELATED_TO_TOPIC'', ''SCHEDULED_FOR'', ''SENT'', ''RECEIVED'', ''USES'', ''DEPENDS_ON'', ''IMPLEMENTS'', ''DOCUMENTS'', ''TRACKED_IN'', ''BLOCKS'')';
  new_relation_list constant text := '(''FORMERLY_KNOWN_AS'', ''COFOUNDER_OF'', ''FOUNDER_OF'', ''HOLDS_ROLE_AT'', ''EMPLOYED_BY'', ''MEMBER_OF'', ''LEADS'', ''REPORTS_TO'', ''INVITED_TO'', ''ATTENDED'', ''ORGANIZED'', ''AUTHORED'', ''MAINTAINS'', ''CONTRIBUTED_TO'', ''OWNS'', ''ASSIGNED_TO'', ''REFERENCES'', ''MENTIONS'', ''PART_OF'', ''RELATED_TO_TOPIC'', ''SCHEDULED_FOR'', ''SENT'', ''RECEIVED'', ''USES'', ''DEPENDS_ON'', ''IMPLEMENTS'', ''DOCUMENTS'', ''TRACKED_IN'', ''BLOCKS'', ''HAS_ACCESS'')';
  old_statement_subjects constant text := 'subject_row.entity_type NOT IN (''Person'', ''Organization'', ''Team'', ''Product'')';
  new_statement_subjects constant text := 'subject_row.entity_type NOT IN (''Person'', ''Organization'', ''Team'', ''Document'', ''Meeting'', ''Message'', ''Repository'', ''Project'', ''Topic'', ''Product'', ''Event'', ''CodeSymbol'', ''Issue'')';
BEGIN
  SELECT pg_get_functiondef('graph_v2_validate_evidence_assertion()'::regprocedure) INTO definition;
  repaired := replace(definition, old_relation_list, new_relation_list);
  repaired := replace(repaired, old_statement_subjects, new_statement_subjects);
  IF repaired NOT LIKE '%HAS_ACCESS%' THEN
    RAISE EXCEPTION 'HAS_ACCESS was not installed into graph_v2_validate_evidence_assertion';
  END IF;
  IF repaired NOT LIKE '%Document'', ''Meeting'', ''Message'', ''Repository'', ''Project'', ''Topic'', ''Product'', ''Event'', ''CodeSymbol'', ''Issue''%' THEN
    RAISE EXCEPTION 'source-object statement subjects were not installed into graph_v2_validate_evidence_assertion';
  END IF;
  EXECUTE repaired;

  SELECT pg_get_functiondef('graph_v2_validate_canonical_fact()'::regprocedure) INTO definition;
  repaired := replace(definition, old_statement_subjects, new_statement_subjects);
  IF repaired NOT LIKE '%Document'', ''Meeting'', ''Message'', ''Repository'', ''Project'', ''Topic'', ''Product'', ''Event'', ''CodeSymbol'', ''Issue''%' THEN
    RAISE EXCEPTION 'source-object statement subjects were not installed into graph_v2_validate_canonical_fact';
  END IF;
  EXECUTE repaired;
END;
$$;
