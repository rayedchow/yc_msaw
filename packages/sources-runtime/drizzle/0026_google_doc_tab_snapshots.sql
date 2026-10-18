-- Google Docs tab-content snapshots, captured when the Drive change feed
-- reports a doc changed (gdocs.content-snapshot task). Version-append: one
-- row per (user, doc, tab, revision); a new revision inserts new rows, never
-- overwrites. Content is rendered from the REDACTED documents.get JSON —
-- contentUris (requester-scoped credentials) never land in a row.

CREATE TABLE "google_doc_tab_snapshots" (
  "user_id" text NOT NULL,
  "doc_id" text NOT NULL,
  "tab_id" text NOT NULL,
  "revision_id" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "content" jsonb NOT NULL,
  "content_sha" text NOT NULL,
  "source_updated_at" timestamptz,
  "captured_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_google_doc_tab_snapshot" ON "google_doc_tab_snapshots" ("user_id", "doc_id", "tab_id", "revision_id");
CREATE INDEX "idx_google_doc_tab_snapshot_doc" ON "google_doc_tab_snapshots" ("user_id", "doc_id", "captured_at");
