-- A statement subject is an attribution anchor, not necessarily a human
-- speaker. Content objects must be able to own explicit source statements so
-- documents, meetings, messages, repositories, issues, and events do not lose
-- their narrative content when no person-level author is available.

DO $$
DECLARE
  function_name text;
  definition text;
  updated_definition text;
  old_clause constant text := 'subject_row.entity_type NOT IN (''Person'', ''Organization'', ''Team'', ''Product'')';
  new_clause constant text := 'subject_row.entity_type NOT IN (''Person'', ''Organization'', ''Team'', ''Document'', ''Meeting'', ''Message'', ''Repository'', ''Project'', ''Topic'', ''Product'', ''Event'', ''CodeSymbol'', ''Issue'')';
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'graph_v2_validate_evidence_assertion()',
    'graph_v2_validate_canonical_fact()'
  ] LOOP
    SELECT pg_get_functiondef(function_name::regprocedure) INTO definition;
    updated_definition := replace(definition, old_clause, new_clause);
    IF updated_definition = definition THEN
      RAISE EXCEPTION 'expected statement subject clause was not found in %', function_name;
    END IF;
    EXECUTE updated_definition;
  END LOOP;
END;
$$;
