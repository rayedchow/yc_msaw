-- Zoom transcripts source lane (ported from askshepherd/aqueduct c7e1415 branch himanalot/zoom-transcripts-integration).
-- Single-use tenant-bound OAuth state, leased resumable window cursors, and the current meeting snapshot per
-- meeting UUID (exported as summary.md / transcript.md / meeting.json). Every snapshot version stays raw in
-- activity_events (`zoom:<uuid>:<sha256 of the redacted observation>`, the donor identity).
CREATE TABLE IF NOT EXISTS "zoom_oauth_states" (
  "state_sha256" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "principal_subject" text,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "zoom_sync_state" (
  "tenant_id" text NOT NULL,
  "lane" text NOT NULL CHECK ("lane" IN ('poll', 'backfill')),
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'running', 'complete', 'error', 'blocked')),
  "range_from" date,
  "range_to" date,
  "window_index" integer NOT NULL DEFAULT 0,
  "next_page_token" text,
  "page_token_at" timestamptz,
  "covered_from" date,
  "last_success_at" timestamptz,
  "completed_at" timestamptz,
  "retry_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "lease_owner" text,
  "lease_until" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "lane")
);

CREATE TABLE IF NOT EXISTS "zoom_meetings" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "meeting_uuid" text NOT NULL,
  "topic" text,
  "content_hash" text NOT NULL,
  "source_event_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "meeting_start" timestamptz,
  "source_updated_at" timestamptz,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER "trg_source_lane_journal_zoom_meetings"
  AFTER INSERT OR UPDATE OR DELETE ON "zoom_meetings"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'updated_at');
