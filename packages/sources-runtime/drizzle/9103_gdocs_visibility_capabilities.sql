-- Owner-only attribution of Google-wide Docs/Drive data (google-docs range 9100-9149, additive).
-- gdocs_file_visibility (9102) already records which roster mailbox sees each file. This adds what that mailbox's own
-- Drive `capabilities.canReadRevisions` said (NULL = not observed yet), so revision history, OT changelog, comments and
-- older byte versions are attributed only to mailboxes Google lets read them, and an index to look a mailbox's files up.
-- Drive PDFs (binary drive-pdf lane) now get visibility rows too. Bookkeeping only (not exported).
ALTER TABLE gdocs_file_visibility ADD COLUMN IF NOT EXISTS can_read_revisions boolean;
CREATE INDEX IF NOT EXISTS gdocs_file_visibility_mailbox_idx ON gdocs_file_visibility (tenant_id, mailbox) WHERE visible;
