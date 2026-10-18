ALTER TABLE "task_schedules"
  ADD COLUMN IF NOT EXISTS "deferred_since" timestamp with time zone;

WITH "ranked_live_entity_pages" AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "kb_id", "entity_id"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS "live_rank"
  FROM "pages"
  WHERE "archived_at" IS NULL
    AND "kind" = 'entity'
    AND "entity_id" IS NOT NULL
)
UPDATE "pages"
SET "archived_at" = now()
FROM "ranked_live_entity_pages"
WHERE "pages"."id" = "ranked_live_entity_pages"."id"
  AND "ranked_live_entity_pages"."live_rank" > 1
  AND "pages"."archived_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_page_kb_entity_live"
  ON "pages" ("kb_id", "entity_id")
  WHERE "archived_at" IS NULL
    AND "kind" = 'entity'
    AND "entity_id" IS NOT NULL;
