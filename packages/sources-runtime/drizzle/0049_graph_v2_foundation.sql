-- Graph ontology v2.0.0. This migration is additive: v1 entities/claims and
-- their live writers are intentionally unchanged.

-- Compiled from PHONE_NORMALIZATION in definition.ts. Phone identity is
-- digits-exact: punctuation is removed, but no country code is inferred.
CREATE FUNCTION graph_v2_phone_norm(value text)
RETURNS text AS $$
BEGIN
  RETURN regexp_replace(value, '\D', '', 'g');
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE TABLE "canonical_entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "entity_type" text NOT NULL,
  "canonical_name" text NOT NULL,
  "identity_keys" jsonb NOT NULL DEFAULT '{}',
  "source_categories" jsonb NOT NULL DEFAULT '[]',
  "summary" text,
  "canonical_id" uuid REFERENCES "canonical_entities" ("id"),
  "status" text NOT NULL DEFAULT 'active',
  "merged_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_canonical_entity_id_not_statement_sentinel" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT "ck_canonical_entity_type" CHECK (
    "entity_type" IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')
  ),
  CONSTRAINT "ck_canonical_entity_status" CHECK ("status" IN ('active', 'merged', 'archived')),
  CONSTRAINT "ck_canonical_entity_name" CHECK (length(btrim("canonical_name")) > 0),
  CONSTRAINT "ck_canonical_entity_identity_keys" CHECK (
    jsonb_typeof("identity_keys") = 'object'
    AND ("identity_keys" - ARRAY['email', 'phone', 'repo_key', 'handle:slack', 'handle:discord', 'handle:instagram', 'handle:github', 'handle:x', 'handle:linkedin']::text[]) = '{}'::jsonb
    AND (NOT ("identity_keys" ? 'email') OR (jsonb_typeof("identity_keys" -> 'email') = 'string' AND length(btrim("identity_keys" ->> 'email')) > 0))
    AND (NOT ("identity_keys" ? 'phone') OR (jsonb_typeof("identity_keys" -> 'phone') = 'string' AND length(graph_v2_phone_norm("identity_keys" ->> 'phone')) >= 7))
    AND (NOT ("identity_keys" ? 'repo_key') OR (jsonb_typeof("identity_keys" -> 'repo_key') = 'string' AND length(btrim("identity_keys" ->> 'repo_key')) > 0))
    AND (NOT ("identity_keys" ? 'handle:slack') OR (jsonb_typeof("identity_keys" -> 'handle:slack') = 'string' AND length(btrim("identity_keys" ->> 'handle:slack')) > 0))
    AND (NOT ("identity_keys" ? 'handle:discord') OR (jsonb_typeof("identity_keys" -> 'handle:discord') = 'string' AND length(btrim("identity_keys" ->> 'handle:discord')) > 0))
    AND (NOT ("identity_keys" ? 'handle:instagram') OR (jsonb_typeof("identity_keys" -> 'handle:instagram') = 'string' AND length(btrim("identity_keys" ->> 'handle:instagram')) > 0))
    AND (NOT ("identity_keys" ? 'handle:github') OR (jsonb_typeof("identity_keys" -> 'handle:github') = 'string' AND length(btrim("identity_keys" ->> 'handle:github')) > 0))
    AND (NOT ("identity_keys" ? 'handle:x') OR (jsonb_typeof("identity_keys" -> 'handle:x') = 'string' AND length(btrim("identity_keys" ->> 'handle:x')) > 0))
    AND (NOT ("identity_keys" ? 'handle:linkedin') OR (jsonb_typeof("identity_keys" -> 'handle:linkedin') = 'string' AND length(btrim("identity_keys" ->> 'handle:linkedin')) > 0))
  ),
  CONSTRAINT "ck_canonical_entity_source_categories" CHECK (
    jsonb_typeof("source_categories") = 'array'
    AND "source_categories" <@ '["PUBLISHED_CONTENT", "COLLABORATIVE_CONTENT", "MESSAGING", "EMAIL", "CALENDAR", "CODE_REPOSITORY", "MEETING_TRANSCRIPT", "KNOWLEDGE_HUB", "PEOPLE"]'::jsonb
  ),
  CONSTRAINT "ck_canonical_entity_merge_state" CHECK (
    ("status" = 'merged' AND "canonical_id" IS NOT NULL AND "merged_at" IS NOT NULL)
    OR ("status" <> 'merged' AND "canonical_id" IS NULL AND "merged_at" IS NULL)
  )
);
CREATE INDEX "idx_canonical_entity_kb_type" ON "canonical_entities" ("kb_id", "entity_type");
CREATE INDEX "idx_canonical_entity_kb_canonical" ON "canonical_entities" ("kb_id", "canonical_id");
CREATE UNIQUE INDEX "uq_canonical_entity_kb_email"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'email')))
  WHERE "identity_keys" ? 'email';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_phone"
  ON "canonical_entities" ("kb_id", graph_v2_phone_norm("identity_keys" ->> 'phone'))
  WHERE "identity_keys" ? 'phone';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_repo_key"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'repo_key')))
  WHERE "identity_keys" ? 'repo_key';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_handle_slack"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'handle:slack')))
  WHERE "identity_keys" ? 'handle:slack';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_handle_discord"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'handle:discord')))
  WHERE "identity_keys" ? 'handle:discord';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_handle_instagram"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'handle:instagram')))
  WHERE "identity_keys" ? 'handle:instagram';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_handle_github"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'handle:github')))
  WHERE "identity_keys" ? 'handle:github';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_handle_x"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'handle:x')))
  WHERE "identity_keys" ? 'handle:x';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_handle_linkedin"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'handle:linkedin')))
  WHERE "identity_keys" ? 'handle:linkedin';

CREATE TABLE "mention_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "chunk_id" uuid NOT NULL REFERENCES "chunks" ("id"),
  "surface_text" text NOT NULL,
  "entity_type" text NOT NULL,
  "source_category" text NOT NULL,
  "span" jsonb NOT NULL,
  "identity_keys" jsonb NOT NULL DEFAULT '{}',
  "resolution_status" text NOT NULL DEFAULT 'unresolved',
  "resolved_entity_id" uuid REFERENCES "canonical_entities" ("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_mention_occurrence_entity_type" CHECK (
    "entity_type" IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue')
  ),
  CONSTRAINT "ck_mention_occurrence_source_category" CHECK (
    "source_category" IN ('PUBLISHED_CONTENT', 'COLLABORATIVE_CONTENT', 'MESSAGING', 'EMAIL', 'CALENDAR', 'CODE_REPOSITORY', 'MEETING_TRANSCRIPT', 'KNOWLEDGE_HUB', 'PEOPLE')
  ),
  CONSTRAINT "ck_mention_occurrence_surface" CHECK (length(btrim("surface_text")) > 0),
  CONSTRAINT "ck_mention_occurrence_resolution" CHECK ("resolution_status" IN ('link', 'new', 'unresolved')),
  CONSTRAINT "ck_mention_occurrence_resolved_entity" CHECK (
    ("resolution_status" = 'unresolved' AND "resolved_entity_id" IS NULL)
    OR ("resolution_status" IN ('link', 'new') AND "resolved_entity_id" IS NOT NULL)
  ),
  CONSTRAINT "ck_mention_occurrence_span" CHECK (
    jsonb_typeof("span") = 'object'
    AND jsonb_typeof("span" -> 'start') = 'number'
    AND jsonb_typeof("span" -> 'end') = 'number'
    AND ("span" ->> 'start')::integer >= 0
    AND ("span" ->> 'end')::integer > ("span" ->> 'start')::integer
  )
);
CREATE INDEX "idx_mention_occurrence_chunk" ON "mention_occurrences" ("chunk_id");
CREATE INDEX "idx_mention_occurrence_kb_resolution" ON "mention_occurrences" ("kb_id", "resolution_status");
CREATE UNIQUE INDEX "uq_mention_occurrence_chunk_span_type"
  ON "mention_occurrences" ("chunk_id", "span", "entity_type", "surface_text");

CREATE TABLE "evidence_assertions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "subject_mention_id" uuid NOT NULL REFERENCES "mention_occurrences" ("id"),
  "assertion_kind" text NOT NULL,
  "relation" text,
  "scalar_property" text,
  "statement_text" text,
  "object_mention_id" uuid REFERENCES "mention_occurrences" ("id"),
  "object_value" jsonb,
  "qualifiers" jsonb NOT NULL DEFAULT '{}',
  "source_category" text NOT NULL,
  "chunk_id" uuid NOT NULL REFERENCES "chunks" ("id"),
  "document_id" uuid NOT NULL REFERENCES "source_documents" ("id"),
  "extractor_version" text NOT NULL,
  "ontology_version" text NOT NULL DEFAULT '2.0.0',
  "confidence" real,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_evidence_assertion_observation" UNIQUE NULLS NOT DISTINCT (
    "chunk_id", "extractor_version", "ontology_version", "subject_mention_id",
    "relation", "scalar_property", "statement_text", "object_mention_id", "object_value", "qualifiers"
  ),
  CONSTRAINT "ck_evidence_assertion_kind" CHECK ("assertion_kind" IN ('relation', 'scalar_property', 'statement')),
  CONSTRAINT "ck_evidence_assertion_relation" CHECK (
    "relation" IS NULL OR "relation" IN ('COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
  ),
  CONSTRAINT "ck_evidence_assertion_scalar_property" CHECK (
    "scalar_property" IS NULL OR "scalar_property" IN ('EMAIL', 'URL', 'START_TIME', 'END_TIME', 'RSVP_STATUS', 'ROLE_TITLE', 'STATUS')
  ),
  CONSTRAINT "ck_evidence_assertion_shape" CHECK (
    ("assertion_kind" = 'relation' AND "relation" IS NOT NULL AND "scalar_property" IS NULL AND "statement_text" IS NULL AND "object_mention_id" IS NOT NULL AND "object_value" IS NULL)
    OR ("assertion_kind" = 'scalar_property' AND "relation" IS NULL AND "scalar_property" IS NOT NULL AND "statement_text" IS NULL AND "object_mention_id" IS NULL AND "object_value" IS NOT NULL)
    OR ("assertion_kind" = 'statement' AND "statement_text" IS NOT NULL AND length(btrim("statement_text")) > 0 AND "relation" IS NULL AND "scalar_property" IS NULL AND "object_value" IS NULL)
  ),
  CONSTRAINT "ck_evidence_assertion_source_category" CHECK (
    "source_category" IN ('PUBLISHED_CONTENT', 'COLLABORATIVE_CONTENT', 'MESSAGING', 'EMAIL', 'CALENDAR', 'CODE_REPOSITORY', 'MEETING_TRANSCRIPT', 'KNOWLEDGE_HUB', 'PEOPLE')
  ),
  CONSTRAINT "ck_evidence_assertion_ontology_version" CHECK ("ontology_version" = '2.0.0'),
  CONSTRAINT "ck_evidence_assertion_confidence" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1),
  CONSTRAINT "ck_evidence_assertion_distinct_mentions" CHECK ("object_mention_id" IS NULL OR "subject_mention_id" <> "object_mention_id")
);
CREATE INDEX "idx_evidence_assertion_chunk" ON "evidence_assertions" ("chunk_id");
CREATE INDEX "idx_evidence_assertion_kb_relation" ON "evidence_assertions" ("kb_id", "relation");

CREATE TABLE "canonical_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "subject_entity_id" uuid NOT NULL REFERENCES "canonical_entities" ("id"),
  "assertion_kind" text NOT NULL,
  "relation" text,
  "scalar_property" text,
  "statement_text" text,
  "statement_hash" text,
  "object_entity_id" uuid REFERENCES "canonical_entities" ("id"),
  "scalar_value" jsonb,
  "qualifiers" jsonb NOT NULL DEFAULT '{}',
  "origin" text NOT NULL DEFAULT 'extracted',
  "derived_by_model" text,
  "derived_by_run" text,
  "ontology_version" text NOT NULL DEFAULT '2.0.0',
  "confidence" real,
  "event_at" timestamptz,
  "first_observed_at" timestamptz NOT NULL DEFAULT now(),
  "invalid_at" timestamptz,
  "superseded_by" uuid REFERENCES "canonical_facts" ("id"),
  "invalidation_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_canonical_fact_kind" CHECK ("assertion_kind" IN ('relation', 'scalar_property', 'statement')),
  CONSTRAINT "ck_canonical_fact_relation" CHECK (
    "relation" IS NULL OR "relation" IN ('COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
  ),
  CONSTRAINT "ck_canonical_fact_scalar_property" CHECK (
    "scalar_property" IS NULL OR "scalar_property" IN ('EMAIL', 'URL', 'START_TIME', 'END_TIME', 'RSVP_STATUS', 'ROLE_TITLE', 'STATUS')
  ),
  CONSTRAINT "ck_canonical_fact_shape" CHECK (
    ("assertion_kind" = 'relation' AND "relation" IS NOT NULL AND "scalar_property" IS NULL AND "statement_text" IS NULL AND "statement_hash" IS NULL AND "object_entity_id" IS NOT NULL AND "scalar_value" IS NULL)
    OR ("assertion_kind" = 'scalar_property' AND "relation" IS NULL AND "scalar_property" IS NOT NULL AND "statement_text" IS NULL AND "statement_hash" IS NULL AND "object_entity_id" IS NULL AND "scalar_value" IS NOT NULL)
    OR ("assertion_kind" = 'statement' AND "statement_text" IS NOT NULL AND length(btrim("statement_text")) > 0 AND "statement_hash" IS NOT NULL AND "relation" IS NULL AND "scalar_property" IS NULL AND "scalar_value" IS NULL)
  ),
  CONSTRAINT "ck_canonical_fact_ontology_version" CHECK ("ontology_version" = '2.0.0'),
  CONSTRAINT "ck_canonical_fact_confidence" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1),
  CONSTRAINT "ck_canonical_fact_distinct_entities" CHECK ("object_entity_id" IS NULL OR "subject_entity_id" <> "object_entity_id"),
  CONSTRAINT "ck_canonical_fact_origin" CHECK ("origin" IN ('extracted', 'inferred')),
  CONSTRAINT "ck_canonical_fact_derivation_attribution" CHECK (
    ("origin" = 'extracted' AND "derived_by_model" IS NULL AND "derived_by_run" IS NULL)
    OR ("origin" = 'inferred' AND "derived_by_model" IS NOT NULL AND "derived_by_run" IS NOT NULL)
  ),
  CONSTRAINT "ck_canonical_fact_supersession" CHECK (
    ("invalid_at" IS NULL AND "superseded_by" IS NULL AND "invalidation_reason" IS NULL)
    OR ("invalid_at" IS NOT NULL AND "invalidation_reason" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "uq_canonical_fact_tuple"
  ON "canonical_facts" ("kb_id", "subject_entity_id", "relation", "scalar_property", "object_entity_id", "scalar_value", "qualifiers") NULLS NOT DISTINCT
  WHERE "assertion_kind" IN ('relation', 'scalar_property');
-- The zero UUID represents a NULL about-entity here; canonical_entities forbids it as a real id.
CREATE UNIQUE INDEX "uq_canonical_statement"
  ON "canonical_facts" ("kb_id", "subject_entity_id", COALESCE("object_entity_id", '00000000-0000-0000-0000-000000000000'::uuid), "statement_hash")
  WHERE "assertion_kind" = 'statement';
CREATE INDEX "idx_canonical_fact_subject_live"
  ON "canonical_facts" ("kb_id", "subject_entity_id", "relation", "scalar_property")
  WHERE "invalid_at" IS NULL;

CREATE TABLE "fact_evidence" (
  "canonical_fact_id" uuid NOT NULL REFERENCES "canonical_facts" ("id"),
  "evidence_assertion_id" uuid NOT NULL REFERENCES "evidence_assertions" ("id"),
  "attached_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("canonical_fact_id", "evidence_assertion_id")
);
CREATE INDEX "idx_fact_evidence_fact" ON "fact_evidence" ("canonical_fact_id");
CREATE INDEX "idx_fact_evidence_assertion" ON "fact_evidence" ("evidence_assertion_id");

CREATE TABLE "fact_derivations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "inferred_fact_id" uuid NOT NULL REFERENCES "canonical_facts" ("id"),
  "source_fact_id" uuid REFERENCES "canonical_facts" ("id"),
  "source_evidence_id" uuid REFERENCES "evidence_assertions" ("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_fact_derivation_source" UNIQUE NULLS NOT DISTINCT ("inferred_fact_id", "source_fact_id", "source_evidence_id"),
  CONSTRAINT "ck_fact_derivation_exactly_one_source" CHECK (
    (("source_fact_id" IS NOT NULL)::integer + ("source_evidence_id" IS NOT NULL)::integer) = 1
  )
);
CREATE INDEX "idx_fact_derivation_inferred" ON "fact_derivations" ("inferred_fact_id");
CREATE INDEX "idx_fact_derivation_source_fact" ON "fact_derivations" ("source_fact_id");
CREATE INDEX "idx_fact_derivation_source_evidence" ON "fact_derivations" ("source_evidence_id");

CREATE TABLE "ontology_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "ontology_version" text NOT NULL,
  "proposal_kind" text NOT NULL,
  "proposed_name" text NOT NULL,
  "context" jsonb NOT NULL DEFAULT '{}',
  "source_chunk_id" uuid REFERENCES "chunks" ("id"),
  "status" text NOT NULL DEFAULT 'pending',
  "occurrence_count" integer NOT NULL DEFAULT 1,
  "reviewed_by" text,
  "review_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "reviewed_at" timestamptz,
  CONSTRAINT "ck_ontology_proposal_kind" CHECK ("proposal_kind" IN ('ENTITY_TYPE', 'RELATION', 'SCALAR_PROPERTY')),
  CONSTRAINT "ck_ontology_proposal_status" CHECK ("status" IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT "ck_ontology_proposal_name" CHECK (length(btrim("proposed_name")) > 0),
  CONSTRAINT "ck_ontology_proposal_occurrence_count" CHECK ("occurrence_count" > 0)
);
CREATE UNIQUE INDEX "uq_ontology_proposal_pending"
  ON "ontology_proposals" ("kb_id", "ontology_version", "proposal_kind", "proposed_name")
  WHERE "status" = 'pending';
CREATE INDEX "idx_ontology_proposal_kb_status" ON "ontology_proposals" ("kb_id", "status", "created_at");

-- Compiled domain/range table encoded as an immutable function so every SQL
-- writer observes the same closed relation contract.
CREATE FUNCTION graph_v2_relation_allowed(relation_name text, subject_type text, object_type text)
RETURNS boolean AS $$
BEGIN
  RETURN CASE relation_name
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

CREATE FUNCTION graph_v2_is_timestamptz(value text)
RETURNS boolean AS $$
BEGIN
  PERFORM value::timestamptz;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION graph_v2_scalar_allowed(property_name text, subject_type text, scalar_value jsonb)
RETURNS boolean AS $$
DECLARE text_value text;
BEGIN
  IF jsonb_typeof(scalar_value) <> 'string' THEN RETURN false; END IF;
  text_value := scalar_value #>> '{}';
  IF length(btrim(text_value)) = 0 THEN RETURN false; END IF;
  RETURN CASE property_name
    WHEN 'EMAIL' THEN subject_type IN ('Person', 'Organization', 'Team') AND text_value ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    WHEN 'URL' THEN text_value ~ '^[A-Za-z][A-Za-z0-9+.-]*://'
    WHEN 'START_TIME' THEN subject_type IN ('Meeting', 'Event') AND text_value ~ '^\d{4}-\d{2}-\d{2}T' AND graph_v2_is_timestamptz(text_value)
    WHEN 'END_TIME' THEN subject_type IN ('Meeting', 'Event') AND text_value ~ '^\d{4}-\d{2}-\d{2}T' AND graph_v2_is_timestamptz(text_value)
    WHEN 'RSVP_STATUS' THEN subject_type = 'Person' AND text_value IN ('ACCEPTED', 'DECLINED', 'TENTATIVE', 'NEEDS_ACTION')
    WHEN 'ROLE_TITLE' THEN subject_type = 'Person'
    WHEN 'STATUS' THEN subject_type IN ('Document', 'Meeting', 'Repository', 'Project', 'Product', 'Event', 'CodeSymbol', 'Issue')
    ELSE false
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- Compiled from STATEMENT_NORMALIZATION in definition.ts. The identity
-- contract is deliberately ASCII-only: fold A-Z, collapse ASCII whitespace,
-- trim ASCII spaces, then md5. All other Unicode code points are preserved;
-- NFC normalization and locale-sensitive Unicode case folding are out of scope.
CREATE FUNCTION graph_v2_statement_hash(value text)
RETURNS text AS $$
BEGIN
  RETURN md5(btrim(regexp_replace(translate(value, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ \t\n\r\f\v]+', ' ', 'g'), ' '));
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION graph_v2_quarantine_ontology_candidate(
  candidate_tenant_id text,
  candidate_kb_id uuid,
  candidate_ontology_version text,
  candidate_kind text,
  candidate_name text,
  candidate_context jsonb,
  candidate_source_chunk_id uuid
) RETURNS void AS $$
BEGIN
  INSERT INTO ontology_proposals (
    tenant_id, kb_id, ontology_version, proposal_kind, proposed_name,
    context, source_chunk_id
  ) VALUES (
    candidate_tenant_id, candidate_kb_id, candidate_ontology_version,
    candidate_kind, candidate_name, candidate_context, candidate_source_chunk_id
  )
  ON CONFLICT (kb_id, ontology_version, proposal_kind, proposed_name)
  WHERE status = 'pending'
  DO UPDATE SET
    occurrence_count = ontology_proposals.occurrence_count + 1,
    last_seen_at = now(),
    context = ontology_proposals.context || EXCLUDED.context;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION graph_v2_validate_canonical_entity() RETURNS trigger AS $$
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
CREATE TRIGGER graph_v2_canonical_entity_validate
BEFORE INSERT OR UPDATE ON "canonical_entities"
FOR EACH ROW EXECUTE FUNCTION graph_v2_validate_canonical_entity();

CREATE FUNCTION graph_v2_validate_mention() RETURNS trigger AS $$
DECLARE chunk_row record; resolved_row record;
BEGIN
  SELECT tenant_id, kb_id INTO chunk_row FROM chunks WHERE id = NEW.chunk_id;
  IF NOT FOUND OR chunk_row.tenant_id <> NEW.tenant_id OR chunk_row.kb_id <> NEW.kb_id THEN
    RAISE EXCEPTION 'mention occurrence scope must match its chunk';
  END IF;
  IF NEW.entity_type NOT IN ('Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message', 'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue') THEN
    PERFORM graph_v2_quarantine_ontology_candidate(
      NEW.tenant_id,
      NEW.kb_id,
      '2.0.0',
      'ENTITY_TYPE',
      NEW.entity_type,
      jsonb_build_object(
        'reason', 'unknown_ontology_term',
        'surfaceText', NEW.surface_text,
        'span', NEW.span,
        'identityKeys', NEW.identity_keys,
        'sourceCategory', NEW.source_category,
        'resolutionStatus', NEW.resolution_status,
        'resolvedEntityId', NEW.resolved_entity_id
      ),
      NEW.chunk_id
    );
    RETURN NULL;
  END IF;
  IF NEW.resolved_entity_id IS NOT NULL THEN
    SELECT tenant_id, kb_id, entity_type, status INTO resolved_row FROM canonical_entities WHERE id = NEW.resolved_entity_id;
    IF NOT FOUND OR resolved_row.tenant_id <> NEW.tenant_id OR resolved_row.kb_id <> NEW.kb_id
        OR resolved_row.entity_type <> NEW.entity_type OR resolved_row.status <> 'active' THEN
      RAISE EXCEPTION 'resolved entity must be an active same-scope entity of the mention type';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.resolved_entity_id IS DISTINCT FROM OLD.resolved_entity_id
      AND EXISTS (
        SELECT 1
        FROM evidence_assertions
        JOIN fact_evidence ON fact_evidence.evidence_assertion_id = evidence_assertions.id
        WHERE evidence_assertions.subject_mention_id = NEW.id
           OR evidence_assertions.object_mention_id = NEW.id
      ) THEN
    RAISE EXCEPTION 'mention resolution cited by fact evidence cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER graph_v2_mention_validate
BEFORE INSERT OR UPDATE ON "mention_occurrences"
FOR EACH ROW EXECUTE FUNCTION graph_v2_validate_mention();

CREATE FUNCTION graph_v2_validate_evidence_assertion() RETURNS trigger AS $$
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
      AND EXISTS (
        SELECT 1 FROM fact_evidence WHERE evidence_assertion_id = OLD.id
      ) THEN
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
    IF NEW.relation NOT IN ('COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
        OR NOT graph_v2_relation_allowed(NEW.relation, subject_row.entity_type, object_row.entity_type) THEN
      PERFORM graph_v2_quarantine_ontology_candidate(
        NEW.tenant_id,
        NEW.kb_id,
        NEW.ontology_version,
        'RELATION',
        NEW.relation,
        jsonb_build_object(
          'reason', CASE
            WHEN NEW.relation IN ('COFOUNDER_OF', 'FOUNDER_OF', 'HOLDS_ROLE_AT', 'EMPLOYED_BY', 'MEMBER_OF', 'LEADS', 'REPORTS_TO', 'ATTENDED', 'ORGANIZED', 'AUTHORED', 'MAINTAINS', 'CONTRIBUTED_TO', 'OWNS', 'ASSIGNED_TO', 'REFERENCES', 'MENTIONS', 'PART_OF', 'RELATED_TO_TOPIC', 'SCHEDULED_FOR', 'SENT', 'RECEIVED', 'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DOCUMENTS', 'TRACKED_IN', 'BLOCKS')
              THEN 'domain_range_violation'
            ELSE 'unknown_ontology_term'
          END,
          'subjectMentionId', NEW.subject_mention_id,
          'subjectType', subject_row.entity_type,
          'objectMentionId', NEW.object_mention_id,
          'objectType', object_row.entity_type,
          'sourceCategory', NEW.source_category,
          'documentId', NEW.document_id,
          'extractorVersion', NEW.extractor_version,
          'qualifiers', NEW.qualifiers,
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
      NEW.tenant_id,
      NEW.kb_id,
      NEW.ontology_version,
      'SCALAR_PROPERTY',
      NEW.scalar_property,
      jsonb_build_object(
        'reason', 'unknown_ontology_term',
        'subjectMentionId', NEW.subject_mention_id,
        'subjectType', subject_row.entity_type,
        'sourceCategory', NEW.source_category,
        'documentId', NEW.document_id,
        'extractorVersion', NEW.extractor_version,
        'value', NEW.object_value,
        'confidence', NEW.confidence
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
CREATE TRIGGER graph_v2_evidence_assertion_validate
BEFORE INSERT OR UPDATE ON "evidence_assertions"
FOR EACH ROW EXECUTE FUNCTION graph_v2_validate_evidence_assertion();

CREATE FUNCTION graph_v2_validate_canonical_fact() RETURNS trigger AS $$
DECLARE subject_row record; object_row record;
BEGIN
  IF TG_OP = 'UPDATE'
      AND (
        NEW.assertion_kind IS DISTINCT FROM OLD.assertion_kind
        OR NEW.relation IS DISTINCT FROM OLD.relation
        OR NEW.scalar_property IS DISTINCT FROM OLD.scalar_property
        OR NEW.statement_text IS DISTINCT FROM OLD.statement_text
        OR NEW.object_entity_id IS DISTINCT FROM OLD.object_entity_id
        OR NEW.scalar_value IS DISTINCT FROM OLD.scalar_value
        OR NEW.qualifiers IS DISTINCT FROM OLD.qualifiers
        OR NEW.subject_entity_id IS DISTINCT FROM OLD.subject_entity_id
      ) THEN
    IF EXISTS (SELECT 1 FROM fact_evidence WHERE canonical_fact_id = OLD.id) THEN
      RAISE EXCEPTION 'canonical fact cited by fact evidence cannot change meaning';
    END IF;
    IF EXISTS (SELECT 1 FROM fact_derivations WHERE source_fact_id = OLD.id) THEN
      RAISE EXCEPTION 'canonical fact cited by a derivation cannot change meaning';
    END IF;
  END IF;
  SELECT tenant_id, kb_id, entity_type, status INTO subject_row FROM canonical_entities WHERE id = NEW.subject_entity_id;
  IF NOT FOUND OR subject_row.tenant_id <> NEW.tenant_id OR subject_row.kb_id <> NEW.kb_id OR subject_row.status <> 'active' THEN
    RAISE EXCEPTION 'canonical fact subject must be an active same-scope entity';
  END IF;
  IF NEW.assertion_kind = 'statement' THEN
    NEW.statement_hash := graph_v2_statement_hash(NEW.statement_text);
    IF subject_row.entity_type NOT IN ('Person', 'Organization', 'Team', 'Product') THEN
      RAISE EXCEPTION 'statement speaker type % is not eligible', subject_row.entity_type;
    END IF;
    IF NEW.object_entity_id IS NOT NULL THEN
      SELECT tenant_id, kb_id, entity_type, status INTO object_row FROM canonical_entities WHERE id = NEW.object_entity_id;
      IF NOT FOUND OR object_row.tenant_id <> NEW.tenant_id OR object_row.kb_id <> NEW.kb_id OR object_row.status <> 'active' THEN
        RAISE EXCEPTION 'canonical statement about-entity must be an active same-scope entity';
      END IF;
    END IF;
  ELSIF NEW.assertion_kind = 'relation' THEN
    SELECT tenant_id, kb_id, entity_type, status INTO object_row FROM canonical_entities WHERE id = NEW.object_entity_id;
    IF NOT FOUND OR object_row.tenant_id <> NEW.tenant_id OR object_row.kb_id <> NEW.kb_id OR object_row.status <> 'active' THEN
      RAISE EXCEPTION 'canonical fact object must be an active same-scope entity';
    END IF;
    IF NOT graph_v2_relation_allowed(NEW.relation, subject_row.entity_type, object_row.entity_type) THEN
      RAISE EXCEPTION 'relation % does not allow % -> %', NEW.relation, subject_row.entity_type, object_row.entity_type;
    END IF;
    IF NEW.relation = 'HOLDS_ROLE_AT' AND (jsonb_typeof(NEW.qualifiers -> 'role') IS DISTINCT FROM 'string' OR length(btrim(NEW.qualifiers ->> 'role')) = 0) THEN
      RAISE EXCEPTION 'HOLDS_ROLE_AT requires a role qualifier';
    END IF;
  ELSIF NEW.assertion_kind = 'scalar_property' AND NOT graph_v2_scalar_allowed(NEW.scalar_property, subject_row.entity_type, NEW.scalar_value) THEN
    RAISE EXCEPTION 'scalar property % does not accept type/value', NEW.scalar_property;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER graph_v2_canonical_fact_validate
BEFORE INSERT OR UPDATE ON "canonical_facts"
FOR EACH ROW EXECUTE FUNCTION graph_v2_validate_canonical_fact();

CREATE FUNCTION graph_v2_validate_fact_evidence() RETURNS trigger AS $$
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
  SELECT resolved_entity_id INTO subject_entity FROM mention_occurrences WHERE id = evidence_row.subject_mention_id;
  IF evidence_row.object_mention_id IS NOT NULL THEN
    SELECT resolved_entity_id INTO object_entity FROM mention_occurrences WHERE id = evidence_row.object_mention_id;
  END IF;
  IF subject_entity IS NULL OR subject_entity <> fact_row.subject_entity_id
      OR evidence_row.assertion_kind <> fact_row.assertion_kind
      OR evidence_row.relation IS DISTINCT FROM fact_row.relation
      OR evidence_row.scalar_property IS DISTINCT FROM fact_row.scalar_property
      OR (fact_row.assertion_kind = 'statement' AND graph_v2_statement_hash(evidence_row.statement_text) IS DISTINCT FROM fact_row.statement_hash)
      OR object_entity IS DISTINCT FROM fact_row.object_entity_id
      OR evidence_row.object_value IS DISTINCT FROM fact_row.scalar_value
      OR (fact_row.assertion_kind <> 'statement' AND evidence_row.qualifiers IS DISTINCT FROM fact_row.qualifiers) THEN
    RAISE EXCEPTION 'evidence assertion does not match canonical fact tuple';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER graph_v2_fact_evidence_validate
BEFORE INSERT OR UPDATE ON "fact_evidence"
FOR EACH ROW EXECUTE FUNCTION graph_v2_validate_fact_evidence();

CREATE FUNCTION graph_v2_validate_fact_derivation() RETURNS trigger AS $$
DECLARE inferred_row canonical_facts%ROWTYPE; source_row record;
BEGIN
  -- Let the named CHECK own the exactly-one diagnostic.
  IF ((NEW.source_fact_id IS NOT NULL)::integer + (NEW.source_evidence_id IS NOT NULL)::integer) <> 1 THEN
    RETURN NEW;
  END IF;
  SELECT * INTO inferred_row FROM canonical_facts WHERE id = NEW.inferred_fact_id;
  IF inferred_row.id IS NULL OR inferred_row.origin <> 'inferred'
      OR inferred_row.tenant_id <> NEW.tenant_id OR inferred_row.kb_id <> NEW.kb_id THEN
    RAISE EXCEPTION 'fact derivation target must be an inferred fact in the same scope';
  END IF;
  IF NEW.source_fact_id IS NOT NULL THEN
    IF NEW.source_fact_id = NEW.inferred_fact_id THEN
      RAISE EXCEPTION 'an inferred fact cannot derive from itself';
    END IF;
    SELECT tenant_id, kb_id INTO source_row FROM canonical_facts WHERE id = NEW.source_fact_id;
  ELSE
    SELECT tenant_id, kb_id INTO source_row FROM evidence_assertions WHERE id = NEW.source_evidence_id;
  END IF;
  IF NOT FOUND OR source_row.tenant_id <> NEW.tenant_id OR source_row.kb_id <> NEW.kb_id THEN
    RAISE EXCEPTION 'fact derivation source must exist in the same scope';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER graph_v2_fact_derivation_validate
BEFORE INSERT OR UPDATE ON "fact_derivations"
FOR EACH ROW EXECUTE FUNCTION graph_v2_validate_fact_derivation();

-- Grounding is a commit-time invariant so writers can insert a fact and its
-- support edge in either order inside one transaction. Default retrieval may
-- filter origin to present source facts and model inferences distinctly.
CREATE FUNCTION graph_v2_assert_fact_provenance(fact_id uuid) RETURNS void AS $$
DECLARE fact_origin text; evidence_count bigint; derivation_count bigint;
BEGIN
  SELECT origin INTO fact_origin FROM canonical_facts WHERE id = fact_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO evidence_count FROM fact_evidence WHERE canonical_fact_id = fact_id;
  SELECT count(*) INTO derivation_count FROM fact_derivations WHERE inferred_fact_id = fact_id;
  IF fact_origin = 'extracted' AND (evidence_count < 1 OR derivation_count <> 0) THEN
    RAISE EXCEPTION 'extracted fact must have fact_evidence and no fact_derivations';
  ELSIF fact_origin = 'inferred' AND (derivation_count < 1 OR evidence_count <> 0) THEN
    RAISE EXCEPTION 'inferred fact must have fact_derivations and no fact_evidence';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION graph_v2_check_canonical_fact_provenance() RETURNS trigger AS $$
BEGIN
  PERFORM graph_v2_assert_fact_provenance(NEW.id);
  IF TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id THEN
    PERFORM graph_v2_assert_fact_provenance(OLD.id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER graph_v2_canonical_fact_provenance
AFTER INSERT OR UPDATE ON "canonical_facts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION graph_v2_check_canonical_fact_provenance();

CREATE FUNCTION graph_v2_check_fact_evidence_provenance() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM graph_v2_assert_fact_provenance(OLD.canonical_fact_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM graph_v2_assert_fact_provenance(NEW.canonical_fact_id); END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER graph_v2_fact_evidence_provenance
AFTER INSERT OR UPDATE OR DELETE ON "fact_evidence"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION graph_v2_check_fact_evidence_provenance();

CREATE FUNCTION graph_v2_check_fact_derivation_provenance() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM graph_v2_assert_fact_provenance(OLD.inferred_fact_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM graph_v2_assert_fact_provenance(NEW.inferred_fact_id); END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER graph_v2_fact_derivation_provenance
AFTER INSERT OR UPDATE OR DELETE ON "fact_derivations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION graph_v2_check_fact_derivation_provenance();
