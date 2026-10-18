-- Google Calendar + Google Contacts source lane (calendar-contacts agent, range 9175-9199).
--
-- Calendar keeps the donor tables (google_calendar_event_snapshots = current
-- per-mailbox event state, google_calendar_watch_channels = push channels) and adds:
--   * google_calendar_lane_cursors: per (tenant, mailbox, calendar list | calendar)
--     sync token, resumable full-sync checkpoint (page token + started_at), lease,
--     backoff and calendar lifecycle (active / deleted / not_syncable / over_cap / removed).
--   * google_calendar_event_revisions: append-only raw revision ledger written by a
--     trigger on the snapshot table, so no observed state (create, change, removal)
--     can be skipped by journal coalescing.
-- Contacts adds per (tenant, mailbox, endpoint) cursors, current contact snapshots
-- with deleted / merged / removed states, and the same append-only revision ledger.
-- google_source_mailbox_status records per-mailbox auth / rate-limit / error state
-- (mailbox '*' = tenant roster) for truthful coverage.

CREATE TABLE "google_calendar_lane_cursors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "mailbox" text NOT NULL,
  "resource_type" text NOT NULL CHECK ("resource_type" IN ('calendar_list', 'events')),
  "resource_key" text NOT NULL,
  "calendar" jsonb,
  "calendar_state" text NOT NULL DEFAULT 'active'
    CHECK ("calendar_state" IN ('active', 'deleted', 'not_syncable', 'over_cap', 'removed')),
  "listed_at" timestamptz,
  "sync_token" text,
  "full_sync_started_at" timestamptz,
  "full_sync_page_token" text,
  "full_sync_pages" integer NOT NULL DEFAULT 0,
  "full_sync_reason" text,
  "full_sync_completed_at" timestamptz,
  "first_full_sync_completed_at" timestamptz,
  "last_incremental_at" timestamptz,
  "last_success_at" timestamptz,
  "last_attempt_at" timestamptz,
  "last_error" text,
  "last_error_code" text,
  "last_error_at" timestamptz,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  "lease_owner" text,
  "lease_until" timestamptz,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_google_calendar_lane_cursor" UNIQUE ("tenant_id", "mailbox", "resource_type", "resource_key")
);
CREATE INDEX "idx_google_calendar_lane_cursor_tenant" ON "google_calendar_lane_cursors" ("tenant_id", "mailbox");

-- Items returned so far by the in-progress (resumable, multi-run) full listing of a
-- cursor. When the listing completes, current items absent from this set are the ones
-- the provider no longer returns: they are tombstoned, with no clock comparison.
CREATE TABLE "google_lane_full_listing_seen" (
  "cursor_id" uuid NOT NULL,
  "item_key" text NOT NULL,
  PRIMARY KEY ("cursor_id", "item_key")
);

CREATE TABLE "google_source_mailbox_status" (
  "tenant_id" text NOT NULL,
  "lane" text NOT NULL CHECK ("lane" IN ('calendar', 'contacts')),
  "mailbox" text NOT NULL,
  "auth_mode" text,
  "state" text NOT NULL DEFAULT 'pending'
    CHECK ("state" IN ('pending', 'ok', 'partial', 'blocked', 'rate_limited', 'error')),
  "reason" text,
  "last_error" text,
  "last_error_code" text,
  "last_error_at" timestamptz,
  "last_success_at" timestamptz,
  "last_attempt_at" timestamptz,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "lane", "mailbox")
);

CREATE TABLE "google_calendar_event_revisions" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "mailbox" text NOT NULL,
  "calendar_id" text NOT NULL,
  "event_id" text NOT NULL,
  "op" text NOT NULL CHECK ("op" IN ('created', 'updated', 'removed')),
  "reason" text,
  "status" text,
  "content_hash" text NOT NULL,
  "previous_content_hash" text,
  "source_updated_at" timestamptz,
  "raw_payload" jsonb NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "idx_google_calendar_event_revisions_key"
  ON "google_calendar_event_revisions" ("tenant_id", "mailbox", "calendar_id", "event_id", "id");

-- Removal reason for snapshot DELETEs: the lane sets it transaction-locally with
-- set_config('procmem.calendar_removed_reason', ..., true) before deleting.
CREATE FUNCTION "google_calendar_event_revision_row"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "google_calendar_event_revisions"
      ("tenant_id", "snapshot_id", "mailbox", "calendar_id", "event_id", "op", "status", "content_hash", "previous_content_hash", "source_updated_at", "raw_payload")
    VALUES (NEW."user_id", NEW."id", NEW."delegated_email", NEW."calendar_id", NEW."event_id", 'created', NEW."status", NEW."content_hash", NULL, NEW."source_updated_at", NEW."raw_payload");
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."content_hash" IS DISTINCT FROM OLD."content_hash" THEN
      INSERT INTO "google_calendar_event_revisions"
        ("tenant_id", "snapshot_id", "mailbox", "calendar_id", "event_id", "op", "status", "content_hash", "previous_content_hash", "source_updated_at", "raw_payload")
      VALUES (NEW."user_id", NEW."id", NEW."delegated_email", NEW."calendar_id", NEW."event_id", 'updated', NEW."status", NEW."content_hash", OLD."content_hash", NEW."source_updated_at", NEW."raw_payload");
    END IF;
  ELSE
    INSERT INTO "google_calendar_event_revisions"
      ("tenant_id", "snapshot_id", "mailbox", "calendar_id", "event_id", "op", "reason", "status", "content_hash", "previous_content_hash", "source_updated_at", "raw_payload")
    VALUES (OLD."user_id", OLD."id", OLD."delegated_email", OLD."calendar_id", OLD."event_id", 'removed',
            COALESCE(NULLIF(current_setting('procmem.calendar_removed_reason', true), ''), 'snapshot_deleted'),
            OLD."status", OLD."content_hash", OLD."content_hash", OLD."source_updated_at", OLD."raw_payload");
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_google_calendar_event_revision"
  AFTER INSERT OR UPDATE OR DELETE ON "google_calendar_event_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "google_calendar_event_revision_row"();

CREATE TABLE "google_contact_lane_cursors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "mailbox" text NOT NULL,
  "endpoint" text NOT NULL CHECK ("endpoint" IN ('connections', 'other_contacts')),
  "field_mask" text NOT NULL,
  "sync_token" text,
  "full_sync_started_at" timestamptz,
  "full_sync_page_token" text,
  "full_sync_pages" integer NOT NULL DEFAULT 0,
  "full_sync_reason" text,
  "full_sync_completed_at" timestamptz,
  "first_full_sync_completed_at" timestamptz,
  "last_incremental_at" timestamptz,
  "last_success_at" timestamptz,
  "last_attempt_at" timestamptz,
  "last_error" text,
  "last_error_code" text,
  "last_error_at" timestamptz,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  "lease_owner" text,
  "lease_until" timestamptz,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_google_contact_lane_cursor" UNIQUE ("tenant_id", "mailbox", "endpoint")
);

CREATE TABLE "google_contact_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "mailbox" text NOT NULL,
  "endpoint" text NOT NULL CHECK ("endpoint" IN ('connections', 'other_contacts')),
  "resource_name" text NOT NULL,
  "etag" text,
  "state" text NOT NULL DEFAULT 'active' CHECK ("state" IN ('active', 'deleted', 'merged', 'removed')),
  "merged_into" text,
  "display_name" text,
  "emails" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "content_hash" text NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "source_updated_at" timestamptz,
  "state_changed_at" timestamptz,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_google_contact_snapshot" UNIQUE ("tenant_id", "mailbox", "endpoint", "resource_name")
);
CREATE INDEX "idx_google_contact_snapshots_sweep" ON "google_contact_snapshots" ("tenant_id", "mailbox", "endpoint", "state", "last_seen_at");

CREATE TABLE "google_contact_revisions" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "mailbox" text NOT NULL,
  "endpoint" text NOT NULL,
  "resource_name" text NOT NULL,
  "op" text NOT NULL CHECK ("op" IN ('created', 'updated', 'deleted', 'merged', 'removed', 'restored')),
  "state" text NOT NULL,
  "merged_into" text,
  "content_hash" text NOT NULL,
  "previous_content_hash" text,
  "source_updated_at" timestamptz,
  "raw_payload" jsonb NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "idx_google_contact_revisions_key"
  ON "google_contact_revisions" ("tenant_id", "mailbox", "endpoint", "resource_name", "id");

CREATE FUNCTION "google_contact_revision_row"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rev_op text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    rev_op := CASE WHEN NEW."state" = 'active' THEN 'created' ELSE NEW."state" END;
    INSERT INTO "google_contact_revisions"
      ("tenant_id", "snapshot_id", "mailbox", "endpoint", "resource_name", "op", "state", "merged_into", "content_hash", "previous_content_hash", "source_updated_at", "raw_payload")
    VALUES (NEW."tenant_id", NEW."id", NEW."mailbox", NEW."endpoint", NEW."resource_name", rev_op, NEW."state", NEW."merged_into", NEW."content_hash", NULL, NEW."source_updated_at", NEW."raw_payload");
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."content_hash" IS DISTINCT FROM OLD."content_hash" OR NEW."state" IS DISTINCT FROM OLD."state"
       OR NEW."merged_into" IS DISTINCT FROM OLD."merged_into" THEN
      rev_op := CASE
        WHEN NEW."state" = 'active' AND OLD."state" <> 'active' THEN 'restored'
        WHEN NEW."state" = 'active' THEN 'updated'
        ELSE NEW."state"
      END;
      INSERT INTO "google_contact_revisions"
        ("tenant_id", "snapshot_id", "mailbox", "endpoint", "resource_name", "op", "state", "merged_into", "content_hash", "previous_content_hash", "source_updated_at", "raw_payload")
      VALUES (NEW."tenant_id", NEW."id", NEW."mailbox", NEW."endpoint", NEW."resource_name", rev_op, NEW."state", NEW."merged_into", NEW."content_hash", OLD."content_hash", NEW."source_updated_at", NEW."raw_payload");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_google_contact_revision"
  AFTER INSERT OR UPDATE ON "google_contact_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "google_contact_revision_row"();

-- Export journal triggers (core source_lane_journal_row: tenant column, key column, ignored bookkeeping columns).
CREATE TRIGGER "trg_source_lane_journal_google_calendar_event_snapshots"
  AFTER INSERT OR UPDATE OR DELETE ON "google_calendar_event_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('user_id', 'id', 'last_seen_at', 'updated_at');

CREATE TRIGGER "trg_source_lane_journal_google_calendar_event_revisions"
  AFTER INSERT OR UPDATE OR DELETE ON "google_calendar_event_revisions"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id');

CREATE TRIGGER "trg_source_lane_journal_google_calendar_lane_cursors"
  AFTER INSERT OR UPDATE OR DELETE ON "google_calendar_lane_cursors"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id',
    'listed_at', 'sync_token', 'full_sync_started_at', 'full_sync_page_token', 'full_sync_pages', 'full_sync_reason',
    'full_sync_completed_at', 'first_full_sync_completed_at', 'last_incremental_at', 'last_success_at', 'last_attempt_at',
    'last_error', 'last_error_code', 'last_error_at', 'consecutive_failures', 'next_attempt_at', 'lease_owner', 'lease_until',
    'counts', 'updated_at');

CREATE TRIGGER "trg_source_lane_journal_google_contact_snapshots"
  AFTER INSERT OR UPDATE OR DELETE ON "google_contact_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'last_seen_at', 'updated_at');

CREATE TRIGGER "trg_source_lane_journal_google_contact_revisions"
  AFTER INSERT OR UPDATE OR DELETE ON "google_contact_revisions"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id');
