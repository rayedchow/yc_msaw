-- Ontology 2.1 has been the only emitted version since the scalar/qualifier
-- migration; refresh the column defaults so an insert relying on the default
-- can never stamp 2.0.0 again. Explicit inserts are unaffected.
ALTER TABLE "evidence_assertions" ALTER COLUMN "ontology_version" SET DEFAULT '2.1.0';
ALTER TABLE "canonical_facts" ALTER COLUMN "ontology_version" SET DEFAULT '2.1.0';
