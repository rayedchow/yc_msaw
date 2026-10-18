-- Zoom transcript retry ledger (audit M6). One row per transcript file that a lane listed but could not capture:
--   processing  Zoom listed the VTT asset but it was not ready (status `processing` or no download_url);
--   failed      the download failed with a non-429 error (5xx, network, expired/denied URL, CDN error);
--   gone        a later successful re-list no longer contains the meeting or the file (deleted at Zoom).
-- A captured file deletes its row. `processing`/`failed` rows are retried by the leased lane run (re-listing the
-- meeting's own date window `list_from..list_to`, then the 30-day window it was first listed in
-- `window_from..window_to`, for fresh metadata and download URLs) and keep account coverage `partial`.
-- No download URL or token is stored. Not exported (operational state only).
CREATE TABLE IF NOT EXISTS "zoom_transcript_files" (
  "tenant_id" text NOT NULL,
  "meeting_uuid" text NOT NULL,
  "file_id" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('processing', 'failed', 'gone')),
  "meeting_start" timestamptz,
  "list_from" date NOT NULL,
  "list_to" date NOT NULL,
  "window_from" date NOT NULL,
  "window_to" date NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_status" integer,
  "last_error" text,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "meeting_uuid", "file_id")
);

CREATE INDEX IF NOT EXISTS "zoom_transcript_files_due_idx"
  ON "zoom_transcript_files" ("tenant_id", "next_attempt_at")
  WHERE "state" <> 'gone';
