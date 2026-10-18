-- Per-account current views of Google Docs (google-docs range 9100-9149, additive).
-- A roster mailbox that sees a Doc without Drive `capabilities.canReadRevisions` (reader or commenter) gets its OWN
-- capture of the current document, fetched under that mailbox's own credential and exported under
-- sources/google-docs/_accounts/<mailbox>/<doc-dir>/. The shared Doc unit (captured under another credential, with
-- writer-only history, suggestions and permissions) is never served to it. Bookkeeping only (not exported).
CREATE TABLE IF NOT EXISTS gdocs_account_captures (
  tenant_id text NOT NULL,
  file_id text NOT NULL,
  mailbox text NOT NULL,
  -- pending | complete | partial | blocked | error | superseded (the mailbox may now read revisions) | retired
  state text NOT NULL DEFAULT 'pending',
  reason text,
  -- Drive modifiedTime the changes feed / inventory last reported to this mailbox, and that of the last capture.
  drive_version text,
  captured_version text,
  revision_id text,
  export_directory text,
  -- suggestionsViewMode Google applied for this mailbox (SUGGESTIONS_INLINE or PREVIEW_WITHOUT_SUGGESTIONS).
  view_mode text,
  retry_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  captured_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, file_id, mailbox)
);
CREATE INDEX IF NOT EXISTS gdocs_account_captures_due_idx ON gdocs_account_captures (tenant_id, updated_at)
  WHERE state IN ('pending', 'partial', 'error');
