-- Source-lane extraction of the source-table statements from donor migrations that also
-- touch graph tables (askshepherd/aqueduct@b26d3f46236a36d64f841539abff2b1ffdace5cf).
-- Each block below is copied byte-for-byte from the named donor file and line range;
-- the remaining statements of those files alter graph/wiki tables and are excluded
-- (see src/source-lane/core/migrations.ts EXCLUDED_DONOR_MIGRATIONS).

-- donor drizzle/0044_source_document_envelope.sql lines 1-1
ALTER TABLE "mirror_files" ADD COLUMN "meta_sha" text;

-- donor drizzle/0048_wiki_cold_start_readiness.sql lines 1-2
ALTER TABLE "task_schedules"
  ADD COLUMN IF NOT EXISTS "deferred_since" timestamp with time zone;

-- donor drizzle/0066_source_record_contract.sql lines 1-63
-- Minimal Phase-1 source-record and staged-projection contract.

ALTER TABLE "activity_events"
  ADD COLUMN "source_namespace" text,
  ADD COLUMN "source_object_id" text,
  ADD COLUMN "record_kind" text;

ALTER TABLE "activity_events"
  ADD CONSTRAINT "ck_activity_event_source_object" CHECK (
    ("source_namespace" IS NULL AND "source_object_id" IS NULL)
    OR (
      "source_namespace" IS NOT NULL
      AND "source_object_id" IS NOT NULL
      AND length(btrim("source_namespace")) > 0
      AND length(btrim("source_object_id")) > 0
    )
  ) NOT VALID,
  ADD CONSTRAINT "ck_activity_event_record_kind" CHECK (
    "record_kind" IS NULL OR "record_kind" IN ('snapshot', 'activity', 'tombstone')
  ) NOT VALID;

-- Backfill only rows whose immutable namespace, object id, and semantics are
-- present in captured payload fields. Ambiguous legacy rows remain NULL.
UPDATE "activity_events"
SET "source_namespace" = 'mailbox:' || lower(btrim("raw_payload" ->> '_user_email')),
    "source_object_id" = 'message:' || btrim(COALESCE("raw_payload" ->> 'gmailId', "raw_payload" ->> 'id')),
    "record_kind" = CASE WHEN "event_type" = 'message_deleted' THEN 'tombstone' ELSE 'activity' END
WHERE "source" = 'gmail'
  AND "event_type" IN ('message_received', 'message_sent', 'thread_reply', 'message_deleted')
  AND jsonb_typeof("raw_payload" -> '_user_email') = 'string'
  AND length(btrim("raw_payload" ->> '_user_email')) > 0
  AND length(btrim(COALESCE("raw_payload" ->> 'gmailId', "raw_payload" ->> 'id', ''))) > 0;

UPDATE "activity_events"
SET "source_namespace" = 'tenant',
    "source_object_id" = 'meeting_note:' || btrim("raw_payload" ->> 'granolaId'),
    "record_kind" = CASE WHEN "event_type" = 'meeting_note.deleted' THEN 'tombstone' ELSE 'snapshot' END
WHERE "source" = 'granola'
  AND "event_type" IN ('meeting_note', 'meeting_note.deleted')
  AND jsonb_typeof("raw_payload" -> 'granolaId') = 'string'
  AND length(btrim("raw_payload" ->> 'granolaId')) > 0;

UPDATE "activity_events"
SET "source_namespace" = 'calendar:' || btrim("raw_payload" ->> 'calendarId'),
    "source_object_id" = 'event:' || btrim(COALESCE("raw_payload" ->> 'id', "raw_payload" ->> 'eventId')),
    "record_kind" = CASE
      WHEN "event_type" ~ '(^|[._-])(deleted|removed|cancelled)([._-]|$)' THEN 'tombstone'
      WHEN "event_type" ~ '(^|[._-])(created|edited|updated|changed)([._-]|$)' THEN 'activity'
      ELSE 'snapshot'
    END
WHERE "source" = 'calendar'
  AND jsonb_typeof("raw_payload" -> 'calendarId') = 'string'
  AND length(btrim("raw_payload" ->> 'calendarId')) > 0
  AND length(btrim(COALESCE("raw_payload" ->> 'id', "raw_payload" ->> 'eventId', ''))) > 0;

ALTER TABLE "activity_events"
  VALIDATE CONSTRAINT "ck_activity_event_source_object";
ALTER TABLE "activity_events"
  VALIDATE CONSTRAINT "ck_activity_event_record_kind";

CREATE INDEX "idx_event_object_history"
  ON "activity_events" ("user_id", "source", "source_namespace", "source_object_id", "timestamp")
  WHERE "source_namespace" IS NOT NULL AND "source_object_id" IS NOT NULL;
