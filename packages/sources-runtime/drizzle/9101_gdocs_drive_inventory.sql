-- Full Drive inventory per (tenant, mailbox): a resumable files.list sweep over My Drive + shared-with-me
-- (corpora=user) and then every shared drive the mailbox can see (corpora=drive), so files that never changed
-- after connect still get a checkpoint and are exported. Bookkeeping only (never exported, not journaled):
-- page tokens are short-lived Drive cursors, not source data.
CREATE TABLE IF NOT EXISTS gdocs_drive_inventory (
  tenant_id text NOT NULL,
  mailbox text NOT NULL,
  run_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'complete', 'partial', 'blocked', 'error')),
  reason text,
  -- Ordered listing phases: "user", then "drive:<sharedDriveId>" per shared drive (resolved when a run starts).
  phases jsonb,
  phase_index integer NOT NULL DEFAULT 0,
  page_token text,
  pages integer NOT NULL DEFAULT 0,
  files_listed bigint NOT NULL DEFAULT 0,
  files_recorded bigint NOT NULL DEFAULT 0,
  pdfs_listed bigint NOT NULL DEFAULT 0,
  -- A phase Google answered with incompleteSearch, or a shared drive that could not be listed: the run is partial.
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz,
  last_page_at timestamptz,
  completed_at timestamptz,
  -- Most recent run that listed every phase without gaps (survives the next refresh run starting).
  last_complete_at timestamptz,
  last_complete_files bigint,
  retry_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mailbox)
);
