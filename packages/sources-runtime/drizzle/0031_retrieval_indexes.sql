-- Retrieval/queryability wins for the raw capture DB (additive-only: indexes +
-- one read-model view; no writer or pipeline changes). Lets the graph plane
-- pick up "what changed since cursor T", resolve latest entity versions, query
-- the mirror envelope (provider/externalId/author/sourceUpdatedAt/aliases), and
-- read a cross-source change feed. See docs/source-pipeline-plan.md §3/§5.
-- NOTE: the text_pattern_ops indexes only help LIKE 'prefix%' on non-C-collated
-- databases; drop them if the database has lc_collate = 'C' (plain btree
-- already handles prefix scans there).

-- 1. Capture cursor: incremental pickup by arrival time (correct under backfills).
CREATE INDEX IF NOT EXISTS "idx_event_user_created"
  ON "activity_events" ("user_id", "created_at", "id");

-- 1b. "Recently changed by source-time": source_updated_at is populated by all
-- sources but was previously unindexed (only (user_id, timestamp) existed).
CREATE INDEX IF NOT EXISTS "idx_event_user_source_updated"
  ON "activity_events" ("user_id", "source_updated_at");

-- 2. Prefix scans on the frozen id/path schemes (latest-version + entity/channel lookups).
CREATE INDEX IF NOT EXISTS "idx_event_user_source_event_prefix"
  ON "activity_events" ("user_id", "source_event_id" text_pattern_ops);
CREATE INDEX IF NOT EXISTS "idx_mirror_file_user_path_prefix"
  ON "mirror_files" ("user_id", "path" text_pattern_ops);

-- 3. Mirror envelope (meta jsonb) high-value fields as expression indexes.
CREATE INDEX IF NOT EXISTS "idx_mirror_file_user_provider_external"
  ON "mirror_files" ("user_id", (("meta"->>'provider')), (("meta"->>'externalId')));
CREATE INDEX IF NOT EXISTS "idx_mirror_file_user_author"
  ON "mirror_files" ("user_id", (("meta"->>'authorEmail')));
CREATE INDEX IF NOT EXISTS "idx_mirror_file_user_source_updated"
  ON "mirror_files" ("user_id", (("meta"->>'sourceUpdatedAt')));
CREATE INDEX IF NOT EXISTS "idx_mirror_file_user_updated"
  ON "mirror_files" ("user_id", "updated_at");

-- 4. Identity/alias seed for entity resolution (GIN over meta.aliases).
CREATE INDEX IF NOT EXISTS "idx_mirror_file_meta_aliases"
  ON "mirror_files" USING gin ((("meta"->'aliases')) jsonb_path_ops);

-- 5. Content-addressed byte lookup / dedup.
CREATE INDEX IF NOT EXISTS "idx_binary_document_tenant_sha"
  ON "binary_documents" ("tenant_id", "sha256") WHERE "sha256" IS NOT NULL;

-- 6. Cross-source change-feed read-model (zero storage; CREATE OR REPLACE to
-- evolve). entity_hint and actor_email are best-effort extractions from the
-- frozen sourceEventId schemes and known raw_payload shapes:
--   slack  id: slack:<channelId>:<ts>                      -> part 2 (channel)
--   jira   id: jira:<cloudId>:issue:<issueId>:...          -> part 4 (issue id)
--   actor: slack/gmail `_user_email`, calendar `organizer.email`,
--          jira `comment.author.emailAddress` / `issue.fields.reporter.emailAddress`.
-- change_kind normalizes the inconsistent per-source event_type naming (5+
-- spellings of "deleted", unlabeled "update" for Nango sources) into one
-- lifecycle vocabulary. Best-effort pattern CASE, evaluated top-down (first
-- match wins, so 'deleted' patterns are checked before 'lifecycle' ones that
-- would otherwise catch e.g. member_removed / channel_deleted); read-model, so
-- refine freely later.
CREATE OR REPLACE VIEW "activity_change_feed" AS
SELECT
  "user_id"        AS tenant_id,
  "source",
  "event_type",
  CASE
    WHEN "event_type" LIKE '%deleted%'
      OR "event_type" LIKE '%\_removed'
      OR "event_type" IN ('doc_trashed', 'doc_removed', 'calendar_event_cancelled', 'page_unshared')
      THEN 'deleted'
    WHEN "event_type" LIKE '%reaction%' THEN 'reaction'
    WHEN "event_type" LIKE '%comment%'
      OR "event_type" LIKE '%reply%'
      OR "event_type" LIKE '%suggestion%'
      THEN 'comment'
    WHEN "event_type" LIKE '%edited%'
      OR "event_type" LIKE '%\_updated%'
      OR "event_type" LIKE '%changed%'
      OR "event_type" LIKE 'label\_%'
      OR "event_type" LIKE '%rescheduled%'
      THEN 'updated'
    WHEN "event_type" LIKE '%shared%'
      OR "event_type" LIKE '%\_locked'
      OR "event_type" LIKE '%\_unlocked'
      OR "event_type" LIKE 'channel\_%'
      OR "event_type" LIKE 'member\_%'
      OR "event_type" LIKE '%restored%'
      OR "event_type" LIKE '%moved%'
      OR "event_type" LIKE '%renamed%'
      THEN 'lifecycle'
    ELSE 'created'
  END              AS change_kind,
  "source_event_id",
  CASE
    WHEN "source" = 'jira' THEN split_part("source_event_id", ':', 4)
    ELSE split_part("source_event_id", ':', 2)
  END              AS entity_hint,
  "timestamp"      AS occurred_at,
  "source_updated_at",
  "created_at"     AS captured_at,
  COALESCE(
    "raw_payload"->>'_user_email',
    "raw_payload"#>>'{organizer,email}',
    "raw_payload"#>>'{comment,author,emailAddress}',
    "raw_payload"#>>'{issue,fields,reporter,emailAddress}'
  )                AS actor_email,
  "extracted_entities" AS actor_entities,
  "id"             AS event_id
FROM "activity_events";
