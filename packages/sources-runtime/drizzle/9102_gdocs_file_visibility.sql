-- Per-mailbox Drive visibility for the Docs/Drive source lane. A `removed` change from one mailbox's changes
-- feed means that mailbox lost access (or the file was hard-deleted). The file is tombstoned for the tenant
-- only when no other roster mailbox still sees it; otherwise the checkpoint moves to a mailbox that does.
-- `trashed` is a file property and still retires the file for every mailbox. Bookkeeping only (not exported).
CREATE TABLE IF NOT EXISTS gdocs_file_visibility (
  tenant_id text NOT NULL,
  file_id text NOT NULL,
  mailbox text NOT NULL,
  visible boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, file_id, mailbox)
);
CREATE INDEX IF NOT EXISTS gdocs_file_visibility_visible_idx ON gdocs_file_visibility (tenant_id, file_id) WHERE visible;
