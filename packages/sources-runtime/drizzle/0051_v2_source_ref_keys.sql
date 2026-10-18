-- Strong identities for provider-owned source objects. The provider set is
-- deliberately closed; unknown providers are quarantined by the extractor.

ALTER TABLE "canonical_entities"
  DROP CONSTRAINT "ck_canonical_entity_identity_keys",
  ADD CONSTRAINT "ck_canonical_entity_identity_keys" CHECK (
    jsonb_typeof("identity_keys") = 'object'
    AND ("identity_keys" - ARRAY['email', 'phone', 'repo_key', 'handle:slack', 'handle:discord', 'handle:instagram', 'handle:github', 'handle:x', 'handle:linkedin', 'source_ref:granola', 'source_ref:gcal', 'source_ref:gmail', 'source_ref:slack', 'source_ref:imessage', 'source_ref:notion', 'source_ref:github']::text[]) = '{}'::jsonb
    AND (NOT ("identity_keys" ? 'email') OR (jsonb_typeof("identity_keys" -> 'email') = 'string' AND length(btrim("identity_keys" ->> 'email')) > 0))
    AND (NOT ("identity_keys" ? 'phone') OR (jsonb_typeof("identity_keys" -> 'phone') = 'string' AND length(graph_v2_phone_norm("identity_keys" ->> 'phone')) >= 7))
    AND (NOT ("identity_keys" ? 'repo_key') OR (jsonb_typeof("identity_keys" -> 'repo_key') = 'string' AND length(btrim("identity_keys" ->> 'repo_key')) > 0))
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

CREATE UNIQUE INDEX "uq_canonical_entity_kb_source_ref_granola"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'source_ref:granola')))
  WHERE "identity_keys" ? 'source_ref:granola';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_source_ref_gcal"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'source_ref:gcal')))
  WHERE "identity_keys" ? 'source_ref:gcal';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_source_ref_gmail"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'source_ref:gmail')))
  WHERE "identity_keys" ? 'source_ref:gmail';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_source_ref_slack"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'source_ref:slack')))
  WHERE "identity_keys" ? 'source_ref:slack';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_source_ref_imessage"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'source_ref:imessage')))
  WHERE "identity_keys" ? 'source_ref:imessage';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_source_ref_notion"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'source_ref:notion')))
  WHERE "identity_keys" ? 'source_ref:notion';
CREATE UNIQUE INDEX "uq_canonical_entity_kb_source_ref_github"
  ON "canonical_entities" ("kb_id", lower(btrim("identity_keys" ->> 'source_ref:github')))
  WHERE "identity_keys" ? 'source_ref:github';

ALTER TABLE "ontology_proposals"
  DROP CONSTRAINT "ck_ontology_proposal_kind",
  ADD CONSTRAINT "ck_ontology_proposal_kind" CHECK (
    "proposal_kind" IN ('ENTITY_TYPE', 'RELATION', 'SCALAR_PROPERTY', 'IDENTITY_KEY')
  );

-- Slice 1 already emits typed aliases, but source-object fallback aliases must
-- survive until Slice 2 resolution. This remains v2-only state.
ALTER TABLE "mention_occurrences"
  ADD COLUMN "aliases" jsonb NOT NULL DEFAULT '[]',
  ADD CONSTRAINT "ck_mention_occurrence_aliases" CHECK (jsonb_typeof("aliases") = 'array');
