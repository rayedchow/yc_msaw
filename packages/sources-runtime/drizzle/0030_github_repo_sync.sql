-- Per-tenant, per-repo GitHub sync selection. Capture-everything default: a
-- repo with NO row here syncs; a row with syncing = false stops FUTURE proxy
-- sweeps for that repo only. Stopping never deletes already-captured
-- activity_events / mirror_files / binary_documents.
-- TEMP migration number: integrator renumbers before merge.

CREATE TABLE "github_repo_sync" (
  "tenant_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "syncing" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "repo_full_name")
);
