-- Google Docs tab-change events + current tab tree, from the OT changelog
-- (gdocs.suggestion-sync derives both suggestions and tab changes from one
-- changelog fetch). Writer+-gated, fail-soft, same access model as suggestions.

CREATE TABLE "google_doc_tab_events" (
  "user_id" text NOT NULL,
  "doc_id" text NOT NULL,
  "tab_id" text NOT NULL,
  "event_type" text NOT NULL,
  "changelog_index" integer NOT NULL,
  "actor_user_id" text,
  "actor_name" text,
  "old_name" text,
  "new_name" text,
  "from_position" jsonb,
  "to_position" jsonb,
  "occurred_at" timestamp with time zone,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_google_doc_tab_event" ON "google_doc_tab_events" ("user_id", "doc_id", "tab_id", "event_type", "changelog_index");
CREATE INDEX "idx_google_doc_tab_event_doc" ON "google_doc_tab_events" ("user_id", "doc_id");

CREATE TABLE "google_doc_tabs" (
  "user_id" text NOT NULL,
  "doc_id" text NOT NULL,
  "tab_id" text NOT NULL,
  "name" text,
  "position" jsonb,
  "parent_tab_id" text,
  "created_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_google_doc_tab" ON "google_doc_tabs" ("user_id", "doc_id", "tab_id");
CREATE INDEX "idx_google_doc_tab_doc" ON "google_doc_tabs" ("user_id", "doc_id");
