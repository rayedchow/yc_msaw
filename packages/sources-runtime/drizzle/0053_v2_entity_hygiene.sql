-- V2 entity hygiene: Organization domain identity, typed domain aliases, and
-- an explicit rename relation. Existing v1 graph tables and read paths remain
-- untouched.

-- Compiled from DOMAIN_NORMALIZATION in definition.ts.
CREATE FUNCTION graph_v2_domain_norm(value text)
RETURNS text AS $$
BEGIN
  RETURN regexp_replace(regexp_replace(regexp_replace(lower(btrim(value)), '^[a-z][a-z0-9+.-]*://', ''), '^www\.', ''), '/.*$', '');
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

ALTER TABLE "canonical_entities"
  DROP CONSTRAINT "ck_canonical_entity_identity_keys",
  ADD CONSTRAINT "ck_canonical_entity_identity_keys" CHECK (
    jsonb_typeof("identity_keys") = 'object'
    AND ("identity_keys" - ARRAY['email', 'phone', 'repo_key', 'domain', 'handle:slack', 'handle:discord', 'handle:instagram', 'handle:github', 'handle:x', 'handle:linkedin', 'source_ref:granola', 'source_ref:gcal', 'source_ref:gmail', 'source_ref:slack', 'source_ref:imessage', 'source_ref:notion', 'source_ref:github']::text[]) = '{}'::jsonb
    AND (NOT ("identity_keys" ? 'email') OR (jsonb_typeof("identity_keys" -> 'email') = 'string' AND length(btrim("identity_keys" ->> 'email')) > 0))
    AND (NOT ("identity_keys" ? 'phone') OR (jsonb_typeof("identity_keys" -> 'phone') = 'string' AND length(graph_v2_phone_norm("identity_keys" ->> 'phone')) >= 7))
    AND (NOT ("identity_keys" ? 'repo_key') OR (jsonb_typeof("identity_keys" -> 'repo_key') = 'string' AND length(btrim("identity_keys" ->> 'repo_key')) > 0))
    AND (NOT ("identity_keys" ? 'domain') OR ("entity_type" = 'Organization' AND jsonb_typeof("identity_keys" -> 'domain') = 'string' AND length(graph_v2_domain_norm("identity_keys" ->> 'domain')) > 0))
    AND (NOT ("identity_keys" ? 'handle:slack') OR (jsonb_typeof("identity_keys" -> 'handle:slack') = 'string' AND length(btrim("identity_keys" ->> 'handle:slack')) > 0))
    AND (NOT ("identity_keys" ? 'handle:discord') OR (jsonb_typeof("identity_keys" -> 'handle:discord') = 'string' AND length(btrim("identity_keys" ->> 'handle:discord')) > 0))
    AND (NOT ("identity_keys" ? 'handle:instagram') OR (jsonb_typeof("identity_keys" -> 'handle:instagram') = 'string' AND length(btrim("identity_keys" ->> 'handle:instagram')) > 0))
    AND (NOT ("identity_keys" ? 'handle:github') OR (jsonb_typeof("identity_keys" -> 'handle:github') = 'string' AND length(btrim("identity_keys" ->> 'handle:github')) > 0))
    AND (NOT ("identity_keys" ? 'handle:x') OR (jsonb_typeof("identity_keys" -> 'handle:x') = 'string' AND length(btrim("identity_keys" ->> 'handle:x')) > 0))
    AND (NOT ("identity_keys" ? 'handle:linkedin') OR (jsonb_typeof("identity_keys" -> 'handle:linkedin') = 'string' AND length(btrim("identity_keys" ->> 'handle:linkedin')) > 0))
    AND (NOT ("identity_keys" ? 'source_ref:granola') OR (jsonb_typeof("identity_keys" -> 'source_ref:granola') = 'string' AND length(btrim("identity_keys" ->> 'source_ref:granola')) > 0))
    AND (NOT ("identity_keys" ? 'source_ref:gcal') OR (jsonb_typeof("identity_keys" -> 'source_ref:gcal') = 'string' AND length(btrim("identity_keys" ->> 'source_ref:gcal')) > 0))
    AND (NOT ("identity_keys" ? 'source_ref:gmail') OR (jsonb_typeof("identity_keys" -> 'source_ref:gmail') = 'string' AND length(btrim("identity_keys" ->> 'source_ref:gmail')) > 0))
    AND (NOT ("identity_keys" ? 'source_ref:slack') OR (jsonb_typeof("identity_keys" -> 'source_ref:slack') = 'string' AND length(btrim("identity_keys" ->> 'source_ref:slack')) > 0))
    AND (NOT ("identity_keys" ? 'source_ref:imessage') OR (jsonb_typeof("identity_keys" -> 'source_ref:imessage') = 'string' AND length(btrim("identity_keys" ->> 'source_ref:imessage')) > 0))
    AND (NOT ("identity_keys" ? 'source_ref:notion') OR (jsonb_typeof("identity_keys" -> 'source_ref:notion') = 'string' AND length(btrim("identity_keys" ->> 'source_ref:notion')) > 0))
    AND (NOT ("identity_keys" ? 'source_ref:github') OR (jsonb_typeof("identity_keys" -> 'source_ref:github') = 'string' AND length(btrim("identity_keys" ->> 'source_ref:github')) > 0))
  );

CREATE UNIQUE INDEX "uq_canonical_entity_kb_domain"
  ON "canonical_entities" ("kb_id", graph_v2_domain_norm("identity_keys" ->> 'domain'))
  WHERE "identity_keys" ? 'domain';

ALTER TABLE "canonical_entity_aliases"
  DROP CONSTRAINT "ck_canonical_entity_alias_kind",
  ADD CONSTRAINT "ck_canonical_entity_alias_kind" CHECK (
    "alias_kind" IN ('domain', 'display_name', 'mention_surface', 'name')
  );

ALTER TABLE "evidence_assertions"
  DROP CONSTRAINT "ck_evidence_assertion_relation",
  ADD CONSTRAINT "ck_evidence_assertion_relation" CHECK (
    "relation" IS NULL OR "relation" IN ('FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
  );

ALTER TABLE "canonical_facts"
  DROP CONSTRAINT "ck_canonical_fact_relation",
  ADD CONSTRAINT "ck_canonical_fact_relation" CHECK (
    "relation" IS NULL OR "relation" IN ('FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
  );

CREATE OR REPLACE FUNCTION graph_v2_relation_allowed(relation_name text, subject_type text, object_type text)
RETURNS boolean AS $$
BEGIN
  RETURN CASE relation_name
    WHEN 'FORMERLY_KNOWN_AS' THEN subject_type IN ('Organization') AND object_type IN ('Organization')
    WHEN 'COFOUNDER_OF' THEN subject_type IN ('Person') AND object_type IN ('Organization', 'Product')
    WHEN 'FOUNDER_OF' THEN subject_type IN ('Person') AND object_type IN ('Organization', 'Product')
    WHEN 'HOLDS_ROLE_AT' THEN subject_type IN ('Person') AND object_type IN ('Organization', 'Team', 'Project', 'Product')
    WHEN 'EMPLOYED_BY' THEN subject_type IN ('Person') AND object_type IN ('Organization')
    WHEN 'MEMBER_OF' THEN subject_type IN ('Person', 'Team') AND object_type IN ('Team', 'Organization')
    WHEN 'LEADS' THEN subject_type IN ('Person') AND object_type IN ('Organization', 'Team', 'Project', 'Product')
    WHEN 'REPORTS_TO' THEN subject_type IN ('Person') AND object_type IN ('Person')
    WHEN 'ATTENDED' THEN subject_type IN ('Person') AND object_type IN ('Meeting', 'Event')
    WHEN 'ORGANIZED' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Meeting', 'Event')
    WHEN 'AUTHORED' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Document', 'Message', 'CodeSymbol', 'Issue')
    WHEN 'MAINTAINS' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Repository', 'Project', 'Product', 'CodeSymbol', 'Issue')
    WHEN 'CONTRIBUTED_TO' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Document', 'Repository', 'Project', 'Product', 'CodeSymbol', 'Issue')
    WHEN 'OWNS' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Document', 'Repository', 'Project', 'Product', 'CodeSymbol', 'Issue')
    WHEN 'ASSIGNED_TO' THEN subject_type IN ('Issue') AND object_type IN ('Person', 'Team')
    WHEN 'REFERENCES' THEN subject_type IN ('Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue') AND object_type IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')
    WHEN 'MENTIONS' THEN subject_type IN ('Document', 'Meeting', 'Message', 'Issue') AND object_type IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')
    WHEN 'PART_OF' THEN subject_type IN ('Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Product', 'CodeSymbol', 'Issue') AND object_type IN ('Organization', 'Team', 'Document', 'Meeting', 'Repository', 'Project', 'Product')
    WHEN 'RELATED_TO_TOPIC' THEN subject_type IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue') AND object_type IN ('Topic')
    WHEN 'SCHEDULED_FOR' THEN subject_type IN ('Meeting', 'Event') AND object_type IN ('Project', 'Product', 'Event')
    WHEN 'SENT' THEN subject_type IN ('Person') AND object_type IN ('Message')
    WHEN 'RECEIVED' THEN subject_type IN ('Person', 'Team') AND object_type IN ('Message')
    WHEN 'USES' THEN subject_type IN ('Person', 'Organization', 'Team', 'Repository', 'Project', 'Product', 'CodeSymbol') AND object_type IN ('Product', 'Repository', 'Document', 'CodeSymbol')
    WHEN 'DEPENDS_ON' THEN subject_type IN ('Repository', 'Project', 'Product', 'CodeSymbol') AND object_type IN ('Repository', 'Project', 'Product', 'CodeSymbol')
    WHEN 'IMPLEMENTS' THEN subject_type IN ('Repository', 'Project', 'Product', 'CodeSymbol') AND object_type IN ('Product', 'Project', 'Topic', 'Document', 'Issue')
    WHEN 'DOCUMENTS' THEN subject_type IN ('Document') AND object_type IN ('Repository', 'Project', 'Product', 'Topic', 'CodeSymbol', 'Issue')
    WHEN 'TRACKED_IN' THEN subject_type IN ('Issue') AND object_type IN ('Repository', 'Project')
    WHEN 'BLOCKS' THEN subject_type IN ('Issue', 'Project') AND object_type IN ('Issue', 'Project', 'Product', 'Event')
    ELSE false
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- The evidence trigger owns counted quarantine for unknown relation values, so
-- its closed-list branch must move in lockstep with the relation function.
CREATE OR REPLACE FUNCTION graph_v2_validate_evidence_assertion() RETURNS trigger AS $$
DECLARE subject_row record; object_row record; chunk_row record;
BEGIN
  IF TG_OP = 'UPDATE'
      AND (
        NEW.assertion_kind IS DISTINCT FROM OLD.assertion_kind
        OR NEW.relation IS DISTINCT FROM OLD.relation
        OR NEW.scalar_property IS DISTINCT FROM OLD.scalar_property
        OR NEW.statement_text IS DISTINCT FROM OLD.statement_text
        OR NEW.object_mention_id IS DISTINCT FROM OLD.object_mention_id
        OR NEW.object_value IS DISTINCT FROM OLD.object_value
        OR NEW.qualifiers IS DISTINCT FROM OLD.qualifiers
        OR NEW.subject_mention_id IS DISTINCT FROM OLD.subject_mention_id
      )
      AND EXISTS (SELECT 1 FROM fact_evidence WHERE evidence_assertion_id = OLD.id) THEN
    RAISE EXCEPTION 'evidence assertion cited by fact evidence cannot change meaning';
  END IF;
  SELECT tenant_id, kb_id, chunk_id, entity_type, source_category
    INTO subject_row FROM mention_occurrences WHERE id = NEW.subject_mention_id;
  IF NOT FOUND OR subject_row.tenant_id <> NEW.tenant_id OR subject_row.kb_id <> NEW.kb_id
      OR subject_row.chunk_id <> NEW.chunk_id OR subject_row.source_category <> NEW.source_category THEN
    RAISE EXCEPTION 'evidence subject mention provenance mismatch';
  END IF;
  SELECT tenant_id, kb_id, document_id INTO chunk_row FROM chunks WHERE id = NEW.chunk_id;
  IF NOT FOUND OR chunk_row.tenant_id <> NEW.tenant_id OR chunk_row.kb_id <> NEW.kb_id OR chunk_row.document_id <> NEW.document_id THEN
    RAISE EXCEPTION 'evidence chunk/document provenance mismatch';
  END IF;
  IF NEW.assertion_kind IN ('relation', 'statement') AND NEW.object_mention_id IS NOT NULL THEN
    SELECT tenant_id, kb_id, chunk_id, entity_type INTO object_row FROM mention_occurrences WHERE id = NEW.object_mention_id;
    IF NOT FOUND OR object_row.tenant_id <> NEW.tenant_id OR object_row.kb_id <> NEW.kb_id OR object_row.chunk_id <> NEW.chunk_id THEN
      RAISE EXCEPTION 'evidence object mention provenance mismatch';
    END IF;
  END IF;
  IF NEW.assertion_kind = 'relation' THEN
    IF NEW.relation NOT IN ('FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
        OR NOT graph_v2_relation_allowed(NEW.relation, subject_row.entity_type, object_row.entity_type) THEN
      PERFORM graph_v2_quarantine_ontology_candidate(
        NEW.tenant_id, NEW.kb_id, NEW.ontology_version, 'RELATION', NEW.relation,
        jsonb_build_object(
          'reason', CASE
            WHEN NEW.relation IN ('FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
              THEN 'domain_range_violation' ELSE 'unknown_ontology_term' END,
          'subjectMentionId', NEW.subject_mention_id, 'subjectType', subject_row.entity_type,
          'objectMentionId', NEW.object_mention_id, 'objectType', object_row.entity_type,
          'sourceCategory', NEW.source_category, 'documentId', NEW.document_id,
          'extractorVersion', NEW.extractor_version, 'qualifiers', NEW.qualifiers,
          'confidence', NEW.confidence
        ),
        NEW.chunk_id
      );
      RETURN NULL;
    END IF;
    IF NEW.relation = 'HOLDS_ROLE_AT' AND (jsonb_typeof(NEW.qualifiers -> 'role') IS DISTINCT FROM 'string' OR length(btrim(NEW.qualifiers ->> 'role')) = 0) THEN
      RAISE EXCEPTION 'HOLDS_ROLE_AT requires a role qualifier';
    END IF;
  ELSIF NEW.assertion_kind = 'statement' THEN
    IF subject_row.entity_type NOT IN ('Person', 'Organization', 'Team', 'Product') THEN
      RAISE EXCEPTION 'statement speaker type % is not eligible', subject_row.entity_type;
    END IF;
  ELSIF NEW.scalar_property NOT IN ('EMAIL', 'URL', 'START_TIME', 'END_TIME', 'RSVP_STATUS', 'ROLE_TITLE', 'STATUS') THEN
    PERFORM graph_v2_quarantine_ontology_candidate(
      NEW.tenant_id, NEW.kb_id, NEW.ontology_version, 'SCALAR_PROPERTY', NEW.scalar_property,
      jsonb_build_object(
        'reason', 'unknown_ontology_term', 'subjectMentionId', NEW.subject_mention_id,
        'subjectType', subject_row.entity_type, 'sourceCategory', NEW.source_category,
        'documentId', NEW.document_id, 'extractorVersion', NEW.extractor_version,
        'value', NEW.object_value, 'confidence', NEW.confidence
      ),
      NEW.chunk_id
    );
    RETURN NULL;
  ELSIF NOT graph_v2_scalar_allowed(NEW.scalar_property, subject_row.entity_type, NEW.object_value) THEN
    RAISE EXCEPTION 'scalar property % does not accept type/value', NEW.scalar_property;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
