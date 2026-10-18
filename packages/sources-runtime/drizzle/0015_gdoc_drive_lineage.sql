ALTER TABLE "google_doc_sync_state"
  ADD COLUMN "folder_ids" text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "mirror_path_prefix" text,
  ADD COLUMN "drive_lineage_synced_at" timestamptz,
  ADD COLUMN "drive_lineage_failure_count" integer NOT NULL DEFAULT 0;

CREATE INDEX "idx_google_doc_sync_state_folder_ids"
  ON "google_doc_sync_state" USING gin ("folder_ids");

CREATE INDEX "idx_google_doc_sync_state_mirror_path"
  ON "google_doc_sync_state" ("user_id", "mirror_path_prefix");
