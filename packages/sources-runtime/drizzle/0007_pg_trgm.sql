CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "idx_entities_name_trgm" ON "entities" USING gin ("name" gin_trgm_ops);
