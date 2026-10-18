-- Deterministic Google Docs suggestion cards, synced from the OT changelog
-- (gdocs.suggestion-sync job). One row per (user, doc, suggestion), upserted
-- each sync. changelog_resolved=false means only Docs API content/placement
-- was available (reader role or endpoint down); author/status/timestamps null.

CREATE TABLE "google_doc_suggestions" (
  "user_id" text NOT NULL,
  "doc_id" text NOT NULL,
  "suggestion_id" text NOT NULL,
  "tab_id" text,
  "tab_name" text,
  "inserted_text" text NOT NULL DEFAULT '',
  "deleted_text" text NOT NULL DEFAULT '',
  "context_before" text NOT NULL DEFAULT '',
  "context_after" text NOT NULL DEFAULT '',
  "author_user_id" text,
  "author_name" text,
  "status" text NOT NULL DEFAULT 'unknown',
  "created_at" timestamp with time zone,
  "last_modified_at" timestamp with time zone,
  "modification_count" integer NOT NULL DEFAULT 0,
  "resolved_at" timestamp with time zone,
  "resolved_by_name" text,
  "changelog_resolved" boolean NOT NULL DEFAULT false,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_google_doc_suggestion" ON "google_doc_suggestions" ("user_id", "doc_id", "suggestion_id");
CREATE INDEX "idx_google_doc_suggestion_doc" ON "google_doc_suggestions" ("user_id", "doc_id");
