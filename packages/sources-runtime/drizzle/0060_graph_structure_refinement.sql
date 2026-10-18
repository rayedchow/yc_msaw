-- Graph v2 source identity, canonical source mappings, and ontology 2.1.
-- Existing graph rows remain valid, including ontology 2.0 evidence and the
-- legacy RSVP_STATUS and ROLE_TITLE scalar properties.

ALTER TABLE "source_documents"
  ADD COLUMN "source_namespace" text,
  ADD COLUMN "source_object_id" text,
  ADD COLUMN "represented_type" text;

ALTER TABLE "source_documents"
  ADD CONSTRAINT "ck_source_document_source_object" CHECK (
    ("source_namespace" IS NULL AND "source_object_id" IS NULL)
    OR (
      "source_namespace" IS NOT NULL
      AND "source_object_id" IS NOT NULL
      AND length(btrim("source_namespace")) > 0
      AND length(btrim("source_object_id")) > 0
    )
  ) NOT VALID,
  ADD CONSTRAINT "ck_source_document_represented_type" CHECK (
    "represented_type" IS NULL OR "represented_type" IN (
      'Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message',
      'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue'
    )
  ) NOT VALID;

ALTER TABLE "source_documents"
  VALIDATE CONSTRAINT "ck_source_document_source_object";
ALTER TABLE "source_documents"
  VALIDATE CONSTRAINT "ck_source_document_represented_type";

-- Historical Granola summary and transcript facets used synthetic suffixes.
-- Remove them before installing kind-aware uniqueness. A normalized target
-- that already exists wins; the historical row stays unchanged rather than
-- risking a collision or deleting provenance.
-- DEPLOYMENT: drain graph task consumers around this migration. The old
-- three-column ON CONFLICT target cannot coexist with facet duplicates.
DROP INDEX "uq_source_document_kb_provider_external";

UPDATE "source_documents" AS historical
SET "external_id" = left(historical."external_id", -length('#summary'))
WHERE historical."provider" = 'granola'
  AND historical."kind" = 'document'
  AND historical."external_id" LIKE '%#summary'
  AND length(historical."external_id") > length('#summary')
  AND NOT EXISTS (
    SELECT 1
    FROM "source_documents" AS target
    WHERE target."kb_id" = historical."kb_id"
      AND target."provider" = historical."provider"
      AND target."external_id" = left(historical."external_id", -length('#summary'))
      AND target."kind" = historical."kind"
      AND target."id" <> historical."id"
  );

UPDATE "source_documents" AS historical
SET "external_id" = left(historical."external_id", -length('#transcript'))
WHERE historical."provider" = 'granola'
  AND historical."kind" = 'transcript'
  AND historical."external_id" LIKE '%#transcript'
  AND length(historical."external_id") > length('#transcript')
  AND NOT EXISTS (
    SELECT 1
    FROM "source_documents" AS target
    WHERE target."kb_id" = historical."kb_id"
      AND target."provider" = historical."provider"
      AND target."external_id" = left(historical."external_id", -length('#transcript'))
      AND target."kind" = historical."kind"
      AND target."id" <> historical."id"
  );

-- Promote only source facets that the source-object registry can identify
-- without category or path guesses.
UPDATE "source_documents"
SET "source_namespace" = 'tenant',
    "source_object_id" = "external_id",
    "represented_type" = CASE
      WHEN "provider" = 'granola' THEN 'Meeting'
      ELSE 'Document'
    END
WHERE "source_namespace" IS NULL
  AND "source_object_id" IS NULL
  AND "represented_type" IS NULL
  AND length(btrim("external_id")) > 0
  AND (
    ("provider" = 'granola' AND "kind" IN ('document', 'transcript'))
    OR ("provider" IN ('gdocs', 'google-docs', 'notion') AND "kind" = 'document')
  );

UPDATE "source_documents"
SET "source_namespace" = 'site:' || btrim("source_acl" ->> 'cloudId'),
    "source_object_id" = "external_id",
    "represented_type" = CASE WHEN "provider" = 'jira' THEN 'Issue' ELSE 'Document' END
WHERE "source_namespace" IS NULL
  AND "source_object_id" IS NULL
  AND "represented_type" IS NULL
  AND "provider" IN ('jira', 'confluence')
  AND "kind" = 'document'
  AND length(btrim("external_id")) > 0
  AND jsonb_typeof("source_acl") = 'object'
  AND jsonb_typeof("source_acl" -> 'cloudId') = 'string'
  AND length(btrim("source_acl" ->> 'cloudId')) > 0;

CREATE UNIQUE INDEX "uq_source_document_kb_provider_external_kind"
  ON "source_documents" ("kb_id", "provider", "external_id", "kind");

ALTER TABLE "canonical_entities"
  ADD COLUMN "summary_inputs_hash" text;

ALTER TABLE "canonical_entities"
  ADD CONSTRAINT "uq_canonical_entity_tenant_kb_id" UNIQUE ("tenant_id", "kb_id", "id");

CREATE TABLE "canonical_entity_sources" (
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "provider" text NOT NULL,
  "source_namespace" text NOT NULL,
  "source_object_id" text NOT NULL,
  "canonical_entity_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("kb_id", "provider", "source_namespace", "source_object_id"),
  CONSTRAINT "ck_canonical_entity_sources_provider" CHECK (length(btrim("provider")) > 0),
  CONSTRAINT "ck_canonical_entity_sources_namespace" CHECK (length(btrim("source_namespace")) > 0),
  CONSTRAINT "ck_canonical_entity_sources_object_id" CHECK (length(btrim("source_object_id")) > 0),
  CONSTRAINT "fk_canonical_entity_sources_scope" FOREIGN KEY ("tenant_id", "kb_id", "canonical_entity_id")
    REFERENCES "canonical_entities" ("tenant_id", "kb_id", "id") ON DELETE CASCADE
);
CREATE INDEX "idx_canonical_entity_sources_entity"
  ON "canonical_entity_sources" ("kb_id", "canonical_entity_id");

-- Older merge code could leave A -> B -> C chains. Flatten them once so all
-- graph readers can retain the established one-hop root contract.
WITH RECURSIVE chain AS (
  SELECT entity.id AS start_id, entity.id AS current_id, entity.canonical_id AS next_id
  FROM canonical_entities entity
  WHERE entity.status = 'merged'
  UNION ALL
  SELECT chain.start_id, target.id, target.canonical_id
  FROM chain
  JOIN canonical_entities target ON target.id = chain.next_id
  WHERE chain.next_id IS NOT NULL
), roots AS (
  SELECT start_id, current_id AS root_id
  FROM chain
  WHERE next_id IS NULL
)
UPDATE canonical_entities entity
SET canonical_id = roots.root_id, updated_at = now()
FROM roots
WHERE entity.id = roots.start_id
  AND entity.canonical_id IS DISTINCT FROM roots.root_id;

-- Preserve legacy provider source-ref ownership before new extraction stops
-- writing those keys. Only explicitly promoted documents participate, so an
-- ambiguous provider object cannot acquire a mapping during migration.
WITH candidates AS (
  SELECT
    document.tenant_id,
    document.kb_id,
    document.provider,
    document.source_namespace,
    document.source_object_id,
    CASE WHEN entity.status = 'merged' THEN entity.canonical_id ELSE entity.id END AS canonical_entity_id,
    row_number() OVER (
      PARTITION BY document.kb_id, document.provider, document.source_namespace, document.source_object_id
      ORDER BY
        CASE WHEN entity.status = 'active' THEN 0 ELSE 1 END,
        (SELECT count(*) FROM mention_occurrences mention
         WHERE mention.resolved_entity_id = CASE WHEN entity.status = 'merged' THEN entity.canonical_id ELSE entity.id END) DESC,
        entity.created_at,
        entity.id
    ) AS candidate_rank
  FROM source_documents document
  JOIN canonical_entities entity
    ON entity.tenant_id = document.tenant_id
   AND entity.kb_id = document.kb_id
   AND entity.entity_type = document.represented_type
   AND lower(btrim(
     CASE
       WHEN document.provider = 'granola' AND document.kind = 'document'
         THEN regexp_replace(entity.identity_keys ->> 'source_ref:granola', '#summary$', '', 'i')
       WHEN document.provider = 'granola' AND document.kind = 'transcript'
         THEN regexp_replace(entity.identity_keys ->> 'source_ref:granola', '#transcript$', '', 'i')
       ELSE entity.identity_keys ->> ('source_ref:' || document.provider)
     END
   )) = lower(btrim(document.source_object_id))
  WHERE document.source_namespace IS NOT NULL
    AND document.source_object_id IS NOT NULL
    AND document.represented_type IS NOT NULL
    AND entity.status IN ('active', 'merged')
    AND entity.identity_keys ? ('source_ref:' || document.provider)
)
INSERT INTO canonical_entity_sources (
  tenant_id, kb_id, provider, source_namespace, source_object_id, canonical_entity_id
)
SELECT tenant_id, kb_id, provider, source_namespace, source_object_id, canonical_entity_id
FROM candidates
WHERE candidate_rank = 1
ON CONFLICT (kb_id, provider, source_namespace, source_object_id) DO NOTHING;

ALTER TABLE "mention_occurrences"
  ADD COLUMN "source_object_ref" jsonb;

ALTER TABLE "mention_occurrences"
  ADD CONSTRAINT "ck_mention_occurrence_source_object_ref" CHECK (
    "source_object_ref" IS NULL OR (
      jsonb_typeof("source_object_ref") = 'object'
      AND jsonb_typeof("source_object_ref" -> 'provider') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof("source_object_ref" -> 'namespace') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof("source_object_ref" -> 'id') IS NOT DISTINCT FROM 'string'
      AND length(btrim("source_object_ref" ->> 'provider')) > 0
      AND length(btrim("source_object_ref" ->> 'namespace')) > 0
      AND length(btrim("source_object_ref" ->> 'id')) > 0
      AND ("source_object_ref" - ARRAY['provider', 'namespace', 'id']::text[]) = '{}'::jsonb
    )
  ) NOT VALID;
ALTER TABLE "mention_occurrences"
  VALIDATE CONSTRAINT "ck_mention_occurrence_source_object_ref";

-- Stage and validate replacement checks before dropping the existing checks.
ALTER TABLE "evidence_assertions"
  ADD CONSTRAINT "ck_evidence_assertion_relation_0059" CHECK (
    "relation" IS NULL OR "relation" IN (
      'FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT',
      'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'INVITED_TO',
      'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO',
      'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF',
      'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES',
      'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS'
    )
  ) NOT VALID,
  ADD CONSTRAINT "ck_evidence_assertion_ontology_version_0059" CHECK (
    "ontology_version" IN ('2.0.0', '2.1.0')
  ) NOT VALID;
ALTER TABLE "evidence_assertions"
  VALIDATE CONSTRAINT "ck_evidence_assertion_relation_0059";
ALTER TABLE "evidence_assertions"
  VALIDATE CONSTRAINT "ck_evidence_assertion_ontology_version_0059";
ALTER TABLE "evidence_assertions"
  DROP CONSTRAINT "ck_evidence_assertion_relation",
  DROP CONSTRAINT "ck_evidence_assertion_ontology_version";
ALTER TABLE "evidence_assertions"
  RENAME CONSTRAINT "ck_evidence_assertion_relation_0059" TO "ck_evidence_assertion_relation";
ALTER TABLE "evidence_assertions"
  RENAME CONSTRAINT "ck_evidence_assertion_ontology_version_0059" TO "ck_evidence_assertion_ontology_version";

ALTER TABLE "canonical_facts"
  ADD CONSTRAINT "ck_canonical_fact_relation_0059" CHECK (
    "relation" IS NULL OR "relation" IN (
      'FORMERLY_KNOWN_AS', 'COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT',
      'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'INVITED_TO',
      'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO',
      'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF',
      'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES',
      'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS'
    )
  ) NOT VALID,
  ADD CONSTRAINT "ck_canonical_fact_ontology_version_0059" CHECK (
    "ontology_version" IN ('2.0.0', '2.1.0')
  ) NOT VALID;
ALTER TABLE "canonical_facts"
  VALIDATE CONSTRAINT "ck_canonical_fact_relation_0059";
ALTER TABLE "canonical_facts"
  VALIDATE CONSTRAINT "ck_canonical_fact_ontology_version_0059";
ALTER TABLE "canonical_facts"
  DROP CONSTRAINT "ck_canonical_fact_relation",
  DROP CONSTRAINT "ck_canonical_fact_ontology_version";
ALTER TABLE "canonical_facts"
  RENAME CONSTRAINT "ck_canonical_fact_relation_0059" TO "ck_canonical_fact_relation";
ALTER TABLE "canonical_facts"
  RENAME CONSTRAINT "ck_canonical_fact_ontology_version_0059" TO "ck_canonical_fact_ontology_version";

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

-- Liveness-only updates must remain valid after same-as merges because facts
-- intentionally retain their original endpoint ids for provenance. Inserts and
-- meaning changes still require active canonical roots.
CREATE OR REPLACE FUNCTION graph_v2_validate_canonical_fact() RETURNS trigger AS $$
DECLARE subject_row record; object_row record; state_only_update boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    state_only_update :=
      NEW.id IS NOT DISTINCT FROM OLD.id
      AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
      AND NEW.kb_id IS NOT DISTINCT FROM OLD.kb_id
      AND NEW.assertion_kind IS NOT DISTINCT FROM OLD.assertion_kind
      AND NEW.relation IS NOT DISTINCT FROM OLD.relation
      AND NEW.scalar_property IS NOT DISTINCT FROM OLD.scalar_property
      AND NEW.statement_text IS NOT DISTINCT FROM OLD.statement_text
      AND NEW.statement_hash IS NOT DISTINCT FROM OLD.statement_hash
      AND NEW.object_entity_id IS NOT DISTINCT FROM OLD.object_entity_id
      AND NEW.scalar_value IS NOT DISTINCT FROM OLD.scalar_value
      AND NEW.qualifiers IS NOT DISTINCT FROM OLD.qualifiers
      AND NEW.subject_entity_id IS NOT DISTINCT FROM OLD.subject_entity_id
      AND NEW.origin IS NOT DISTINCT FROM OLD.origin
      AND NEW.derived_by_model IS NOT DISTINCT FROM OLD.derived_by_model
      AND NEW.derived_by_run IS NOT DISTINCT FROM OLD.derived_by_run
      AND NEW.ontology_version IS NOT DISTINCT FROM OLD.ontology_version
      AND NEW.confidence IS NOT DISTINCT FROM OLD.confidence
      AND NEW.event_at IS NOT DISTINCT FROM OLD.event_at
      AND NEW.first_observed_at IS NOT DISTINCT FROM OLD.first_observed_at
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    IF NOT state_only_update THEN
      IF EXISTS (SELECT 1 FROM fact_evidence WHERE canonical_fact_id = OLD.id) THEN
        RAISE EXCEPTION 'canonical fact cited by fact evidence cannot change meaning';
      END IF;
      IF EXISTS (SELECT 1 FROM fact_derivations WHERE source_fact_id = OLD.id) THEN
        RAISE EXCEPTION 'canonical fact cited by a derivation cannot change meaning';
      END IF;
    END IF;
  END IF;

  SELECT tenant_id, kb_id, entity_type, status INTO subject_row
  FROM canonical_entities WHERE id = NEW.subject_entity_id;
  IF NOT FOUND OR subject_row.tenant_id <> NEW.tenant_id OR subject_row.kb_id <> NEW.kb_id
      OR (NOT state_only_update AND subject_row.status <> 'active') THEN
    RAISE EXCEPTION 'canonical fact subject must be a same-scope entity with an active root';
  END IF;

  IF NEW.object_entity_id IS NOT NULL THEN
    SELECT tenant_id, kb_id, entity_type, status INTO object_row
    FROM canonical_entities WHERE id = NEW.object_entity_id;
    IF NOT FOUND OR object_row.tenant_id <> NEW.tenant_id OR object_row.kb_id <> NEW.kb_id
        OR (NOT state_only_update AND object_row.status <> 'active') THEN
      RAISE EXCEPTION 'canonical fact object must be a same-scope entity with an active root';
    END IF;
  END IF;

  IF state_only_update THEN RETURN NEW; END IF;

  IF NEW.assertion_kind = 'statement' THEN
    NEW.statement_hash := graph_v2_statement_hash(NEW.statement_text);
    IF subject_row.entity_type NOT IN ('Person', 'Organization', 'Team', 'Product') THEN
      RAISE EXCEPTION 'statement speaker type % is not eligible', subject_row.entity_type;
    END IF;
  ELSIF NEW.assertion_kind = 'relation' THEN
    IF NOT graph_v2_relation_allowed(NEW.relation, subject_row.entity_type, object_row.entity_type) THEN
      RAISE EXCEPTION 'relation % does not allow % -> %', NEW.relation, subject_row.entity_type, object_row.entity_type;
    END IF;
    IF NEW.relation = 'HOLDS_ROLE_AT'
        AND (jsonb_typeof(NEW.qualifiers -> 'role') IS DISTINCT FROM 'string'
          OR length(btrim(NEW.qualifiers ->> 'role')) = 0) THEN
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
  ELSIF NEW.assertion_kind = 'scalar_property'
      AND NOT graph_v2_scalar_allowed(NEW.scalar_property, subject_row.entity_type, NEW.scalar_value) THEN
    RAISE EXCEPTION 'scalar property % does not accept type/value', NEW.scalar_property;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 0058's merge behavior is unchanged except that source-object mappings owned
-- by the loser are repointed to the selected root in the same transaction.
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
          <> graph_v2_identity_norm(key_name, key_value) THEN
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
