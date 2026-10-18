-- Per-doc changelog-sync watermark: the doc's last_seen_ts (= modifiedTime) at
-- the last SUCCESSFUL sync. Lets the hourly full sweep skip unchanged docs.
-- Only advanced on success, so transient changelog failures retry.

CREATE TABLE "google_doc_sync_state" (
  "user_id" text NOT NULL,
  "doc_id" text NOT NULL,
  "last_synced_seen_ts" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_google_doc_sync_state" ON "google_doc_sync_state" ("user_id", "doc_id");
