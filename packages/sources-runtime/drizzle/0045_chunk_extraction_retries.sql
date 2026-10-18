ALTER TABLE "chunk_extractions"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz;

UPDATE "chunk_extractions"
SET "next_attempt_at" = now()
WHERE "status" = 'failed';

INSERT INTO "task_queue" (
  "queue", "tenant_id", "group_key", "kind", "payload", "dedupe_key",
  "run_at", "priority"
)
SELECT DISTINCT
  'sync',
  chunk."tenant_id",
  'graph:' || chunk."kb_id"::text || ':extract:0',
  'graph.extract_chunks',
  jsonb_build_object(
    'kbId', chunk."kb_id"::text,
    'tenantId', chunk."tenant_id",
    'shard', 0,
    'shardCount', 1,
    'continuationSlot', 0
  ),
  'migration:0045:retry:' || chunk."kb_id"::text || ':1:0:slot:0',
  now() + interval '15 minutes',
  0
FROM "chunk_extractions" extraction
JOIN "chunks" chunk ON chunk."id" = extraction."chunk_id"
WHERE extraction."status" = 'failed'
ON CONFLICT DO NOTHING;

ALTER TABLE "chunk_extractions" DROP CONSTRAINT IF EXISTS "ck_chunk_extraction_status";
ALTER TABLE "chunk_extractions"
  ADD CONSTRAINT "ck_chunk_extraction_status"
  CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'terminal'));

CREATE INDEX IF NOT EXISTS "idx_chunk_extractions_retry"
  ON "chunk_extractions" ("status", "next_attempt_at");

INSERT INTO "task_schedules" (
  "tenant_id", "queue", "group_key", "kind", "payload",
  "frequency_seconds", "due_at", "enabled"
)
SELECT
  kb."tenant_id",
  'sync',
  'graph:' || kb."id"::text,
  'graph.reconcile_mirror',
  jsonb_build_object('kbId', kb."id"::text, 'tenantId', kb."tenant_id"),
  3600,
  now() + interval '1 hour',
  true
FROM "kb_containers" kb
WHERE EXISTS (
  SELECT 1 FROM "kb_sources" source WHERE source."kb_id" = kb."id"
)
ON CONFLICT ("group_key", "kind") DO UPDATE SET
  "tenant_id" = EXCLUDED."tenant_id",
  "queue" = EXCLUDED."queue",
  "payload" = EXCLUDED."payload",
  "frequency_seconds" = EXCLUDED."frequency_seconds",
  "enabled" = true,
  "updated_at" = now();
