-- Per-mailbox Google sync cursors. The single integration_tokens metadata
-- blob (unique on user_id+provider) held ONE email + ONE gmail historyId +
-- ONE drivePageToken, which capped every tenant at one delegated mailbox.
-- Gmail and Gdocs pollers write cursors concurrently, so this is a table
-- with per-column updates rather than a JSON map on the token row.
CREATE TABLE IF NOT EXISTS google_mailbox_sync_state (
  tenant_id text NOT NULL,
  email text NOT NULL,
  history_id text,
  last_backfill_at bigint,
  drive_page_token text,
  last_edit_poll_at text,
  last_comment_poll_at text,
  last_docs_backfill_at bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, email)
);
