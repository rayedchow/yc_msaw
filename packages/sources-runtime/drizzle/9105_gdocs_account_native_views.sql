-- Per-account current views of every native type a view-only mailbox may read (google-docs range 9100-9149, additive).
-- 9104 introduced gdocs_account_captures for Google Docs. The same rows now also track Sheets, Slides, other Drive
-- files and Drive PDFs a roster mailbox sees without Drive `capabilities.canReadRevisions`, plus the comments Google
-- returns to that account (Drive comments.list as that account). The new columns are bookkeeping only (not exported).
ALTER TABLE gdocs_account_captures ADD COLUMN IF NOT EXISTS mime_type text;
-- complete | partial | not_visible (Google refused comments to this account) | error | none (type has no comment lane)
ALTER TABLE gdocs_account_captures ADD COLUMN IF NOT EXISTS comments_state text;
ALTER TABLE gdocs_account_captures ADD COLUMN IF NOT EXISTS comments_reason text;
-- The account's own Drive Activity comment sweep saw comment activity since the last comments capture.
ALTER TABLE gdocs_account_captures ADD COLUMN IF NOT EXISTS comments_due boolean NOT NULL DEFAULT false;
ALTER TABLE gdocs_account_captures ADD COLUMN IF NOT EXISTS comments_captured_at timestamptz;
CREATE INDEX IF NOT EXISTS gdocs_account_captures_comments_due_idx ON gdocs_account_captures (tenant_id, updated_at)
  WHERE comments_due AND state NOT IN ('retired', 'superseded');
