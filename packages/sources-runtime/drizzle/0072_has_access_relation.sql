-- HAS_ACCESS: actor can access a document (Drive permissions, share lists).
-- Product decision 2026-07-12 (Ishan): person↔document linking is premised on
-- ACCESS, not just authorship — at customer scale share lists are sparse and
-- informative. Capture-side: source_acl principals. HAS_ACCESS is classified
-- as a presence relation everywhere rankings/qualification are computed.
ALTER TABLE "evidence_assertions"
  ADD CONSTRAINT "ck_evidence_assertion_relation_0072" CHECK (
    "relation" IS NULL OR "relation" IN (
      'FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT',
      'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'INVITED_TO',
      'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO',
      'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF',
      'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES',
      'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS',
      'HAS_ACCESS'
    )
  ) NOT VALID;
ALTER TABLE "evidence_assertions" VALIDATE CONSTRAINT "ck_evidence_assertion_relation_0072";
ALTER TABLE "evidence_assertions" DROP CONSTRAINT "ck_evidence_assertion_relation";
ALTER TABLE "evidence_assertions" RENAME CONSTRAINT "ck_evidence_assertion_relation_0072" TO "ck_evidence_assertion_relation";

ALTER TABLE "canonical_facts"
  ADD CONSTRAINT "ck_canonical_fact_relation_0072" CHECK (
    "relation" IS NULL OR "relation" IN (
      'FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT',
      'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'INVITED_TO',
      'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO',
      'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF',
      'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES',
      'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS',
      'HAS_ACCESS'
    )
  ) NOT VALID;
ALTER TABLE "canonical_facts" VALIDATE CONSTRAINT "ck_canonical_fact_relation_0072";
ALTER TABLE "canonical_facts" DROP CONSTRAINT "ck_canonical_fact_relation";
ALTER TABLE "canonical_facts" RENAME CONSTRAINT "ck_canonical_fact_relation_0072" TO "ck_canonical_fact_relation";

-- Type matrix: HAS_ACCESS actor -> Document
CREATE OR REPLACE FUNCTION graph_v2_relation_allowed(relation_name text, subject_type text, object_type text)
RETURNS boolean AS $$
BEGIN
  RETURN CASE relation_name
    WHEN 'FORMERLY_KNOWN_AS' THEN subject_type IN ('Organization') AND object_type IN ('Organization')
    WHEN 'COFOUNDER_OF' THEN subject_type IN ('Person') AND object_type IN ('Organization', 'Product')
    WHEN 'FOUNDER_OF' THEN subject_type IN ('Person') AND object_type IN ('Organization', 'Product')
    WHEN 'HOLDS_ROLE_AT' THEN subject_type IN ('Person') AND object_type IN ('Organization', 'Team', 'Project', 'Product')
    WHEN 'EMPLOYED_BY' THEN subject_type IN ('Person') AND object_type IN ('Organization')
    WHEN 'MEMBER_OF' THEN subject_type IN ('Person', 'Team') AND object_type IN ('Team', 'Organization', 'Project')
    WHEN 'LEADS' THEN subject_type IN ('Person') AND object_type IN ('Organization', 'Team', 'Project', 'Product')
    WHEN 'REPORTS_TO' THEN subject_type IN ('Person') AND object_type IN ('Person')
    WHEN 'INVITED_TO' THEN subject_type IN ('Person', 'Team') AND object_type IN ('Meeting', 'Event')
    WHEN 'ATTENDED' THEN subject_type IN ('Person') AND object_type IN ('Meeting', 'Event')
    WHEN 'ORGANIZED' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Meeting', 'Event')
    WHEN 'HAS_ACCESS' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Document')
    WHEN 'AUTHORED' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Document', 'Message', 'CodeSymbol', 'Issue')
    WHEN 'MAINTAINS' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Repository', 'Project', 'Product', 'CodeSymbol', 'Issue')
    WHEN 'CONTRIBUTED_TO' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Document', 'Repository', 'Project', 'Product', 'CodeSymbol', 'Issue')
    WHEN 'OWNS' THEN subject_type IN ('Person', 'Organization', 'Team') AND object_type IN ('Document', 'Repository', 'Project', 'Product', 'CodeSymbol', 'Issue')
    WHEN 'ASSIGNED_TO' THEN subject_type IN ('Issue') AND object_type IN ('Person', 'Team')
    WHEN 'REFERENCES' THEN subject_type IN ('Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue') AND object_type IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')
    WHEN 'MENTIONS' THEN subject_type IN ('Document', 'Meeting', 'Message', 'Issue') AND object_type IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')
    WHEN 'PART_OF' THEN subject_type IN ('Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Product', 'CodeSymbol', 'Issue') AND object_type IN ('Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Product', 'Issue')
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

-- Keep 0053's provenance, immutability, quarantine, and legacy scalar behavior.
-- Ontology 2.1 only adds INVITED_TO and its optional rsvpStatus qualifier.
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
    IF NEW.relation NOT IN ('FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'INVITED_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
        OR NOT graph_v2_relation_allowed(NEW.relation, subject_row.entity_type, object_row.entity_type) THEN
      PERFORM graph_v2_quarantine_ontology_candidate(
        NEW.tenant_id, NEW.kb_id, NEW.ontology_version, 'RELATION', NEW.relation,
        jsonb_build_object(
          'reason', CASE
            WHEN NEW.relation IN ('FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'INVITED_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
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
    IF NEW.relation = 'HOLDS_ROLE_AT' AND (NEW.qualifiers - 'role') <> '{}'::jsonb THEN
      RAISE EXCEPTION 'HOLDS_ROLE_AT accepts only the role qualifier';
    ELSIF NEW.relation = 'INVITED_TO' AND (NEW.qualifiers - 'rsvpStatus') <> '{}'::jsonb THEN
      RAISE EXCEPTION 'INVITED_TO accepts only the rsvpStatus qualifier';
    ELSIF NEW.relation NOT IN ('HOLDS_ROLE_AT', 'INVITED_TO') AND NEW.qualifiers <> '{}'::jsonb THEN
      RAISE EXCEPTION 'relation % does not accept qualifiers', NEW.relation;
    END IF;
    IF NEW.relation = 'INVITED_TO' AND NEW.qualifiers ? 'rsvpStatus'
        AND (jsonb_typeof(NEW.qualifiers -> 'rsvpStatus') IS DISTINCT FROM 'string'
          OR NEW.qualifiers ->> 'rsvpStatus' NOT IN ('ACCEPTED', 'DECLINED', 'TENTATIVE', 'NEEDS_ACTION')) THEN
      RAISE EXCEPTION 'INVITED_TO rsvpStatus qualifier is invalid';
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
