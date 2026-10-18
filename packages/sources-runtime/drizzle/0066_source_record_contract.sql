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

ALTER TABLE "source_documents"
  ADD COLUMN "source_links" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "ck_source_document_source_links" CHECK (jsonb_typeof("source_links") = 'array') NOT VALID;
ALTER TABLE "source_documents" VALIDATE CONSTRAINT "ck_source_document_source_links";

ALTER TABLE "source_documents" DROP CONSTRAINT "ck_source_document_represented_type";
ALTER TABLE "source_documents"
  ADD CONSTRAINT "ck_source_document_represented_type" CHECK (
    "represented_type" IS NULL OR (
      "represented_type" IN (
        'Person', 'Organization', 'Team', 'Document', 'Meeting', 'Message',
        'Repository', 'Project', 'Topic', 'Product', 'Event', 'CodeSymbol', 'Issue'
      )
      AND length(btrim("provider")) > 0
      AND length(btrim("source_namespace")) > 0
      AND length(btrim("external_id")) > 0
    )
  ) NOT VALID;
ALTER TABLE "source_documents" VALIDATE CONSTRAINT "ck_source_document_represented_type";

DROP INDEX "uq_source_document_kb_provider_external_kind";
CREATE UNIQUE INDEX "uq_source_document_kb_provider_namespace_external_kind"
  ON "source_documents" ("kb_id", "provider", "source_namespace", "external_id", "kind")
  NULLS NOT DISTINCT;
