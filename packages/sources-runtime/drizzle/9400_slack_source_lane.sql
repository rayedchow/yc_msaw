-- Slack source lane (provider range 9400-9449).
--
-- Additive only: no donor table is altered. Message rows stay in the donor's
-- append-only activity_events ledger (base message + `_ledger` edit/delete/
-- reaction/revision observations); these tables add what the donor lacked:
-- a durable upstream quota shared by every worker, restart-safe history
-- checkpoints per conversation, conversation access state, and exact file
-- bytes. Every tenant row is scoped by tenant_id (= donor user_id = yc_msaw
-- tenantNs, assigned server-side) AND team_id (the Slack workspace the stored
-- token was validated against). Nothing here stores a credential or a
-- credentialed (url_private*) URL.

-- 1. Upstream quota per ACTUAL Slack quota identity: Web API limits are per
--    app, per workspace, per method, so two tenants connected to the same
--    workspace share one budget. quota_key is an opaque hash of (app, team).
--    next_slot_at spaces requests (60s / per-minute tier); blocked_until is the
--    latest Retry-After, honoured by every worker.
CREATE TABLE IF NOT EXISTS slack_source_quota (
  quota_key text NOT NULL,
  method text NOT NULL,
  next_slot_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  rate_limit_streak integer NOT NULL DEFAULT 0,
  last_retry_after_seconds integer,
  last_rate_limited_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quota_key, method)
);

-- 2. Per (tenant, workspace) state: run leases (one history and one thread
--    runner at a time, including realtime gap-fill), discovery and auth state.
CREATE TABLE IF NOT EXISTS slack_source_workspaces (
  tenant_id text NOT NULL,
  team_id text NOT NULL,
  team_name text,
  quota_key text NOT NULL,
  history_lease_owner text,
  history_lease_until timestamptz,
  threads_lease_owner text,
  threads_lease_until timestamptz,
  discovery_complete_at timestamptz,
  discovery_error text,
  discovery_error_at timestamptz,
  auth_state text NOT NULL DEFAULT 'ok' CHECK (auth_state IN ('ok', 'blocked')),
  auth_error text,
  auth_error_at timestamptz,
  thread_scan_at timestamptz,
  last_history_run_at timestamptz,
  last_threads_run_at timestamptz,
  rate_limited_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id)
);

-- 3. Per (tenant, workspace, conversation) history state.
--    head_ts / tail_ts   everything in [tail_ts, head_ts] is captured (Slack ts strings)
--    history_complete_at the backward walk reached history_bound_ts (NULL bound = the
--                        start of the channel as visible to the token). Never set by a
--                        bounded (backfillDays) walk unless the bound is recorded.
--    fwd_*               in-progress forward pass (newer than head_ts): fixed
--                        (oldest, latest) query + Slack cursor; fwd_low_ts is the
--                        lowest ts already stored, used to restart without the
--                        cursor (invalid/expired cursor or legacy resume).
--    bwd_*               in-progress backward pass (older than tail_ts), same shape.
--    rec_*               in-progress reconcile sweep over the recent window that
--                        detects edits/deletes made while realtime was not running.
CREATE TABLE IF NOT EXISTS slack_source_conversations (
  tenant_id text NOT NULL,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  source_key text GENERATED ALWAYS AS (team_id || '/' || channel_id) STORED,
  channel_name text,
  channel_type text,
  is_archived boolean NOT NULL DEFAULT false,
  is_member boolean,
  access_state text NOT NULL DEFAULT 'listed'
    CHECK (access_state IN ('listed', 'not_listed', 'not_in_channel', 'channel_not_found', 'missing_scope', 'access_denied', 'error')),
  access_reason text,
  head_ts text,
  tail_ts text,
  history_bound_ts text,
  history_started_at timestamptz,
  history_complete_at timestamptz,
  fwd_oldest text,
  fwd_latest text,
  fwd_cursor text,
  fwd_low_ts text,
  fwd_top_ts text,
  fwd_started_at timestamptz,
  bwd_latest text,
  bwd_inclusive boolean NOT NULL DEFAULT false,
  bwd_cursor text,
  rec_oldest text,
  rec_latest text,
  rec_cursor text,
  rec_low_ts text,
  rec_top_ts text,
  rec_started_at timestamptz,
  last_reconcile_at timestamptz,
  messages_seen bigint NOT NULL DEFAULT 0,
  pages_done bigint NOT NULL DEFAULT 0,
  last_listed_at timestamptz,
  last_forward_at timestamptz,
  last_forward_complete_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  error_streak integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_source_conversations_work
  ON slack_source_conversations (tenant_id, team_id, access_state, last_forward_at);

-- Message ts values seen by the in-progress reconcile sweep (cleared per sweep).
CREATE TABLE IF NOT EXISTS slack_source_reconcile_seen (
  tenant_id text NOT NULL,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  ts text NOT NULL,
  PRIMARY KEY (tenant_id, team_id, channel_id, ts)
);

-- 4. Exact file bytes: content-addressed ordered chunks of <= 8 MiB (the yc_msaw
--    blob limit). Per tenant: no cross-tenant dedupe, so blob existence is never
--    an oracle across tenants.
CREATE TABLE IF NOT EXISTS slack_source_chunks (
  tenant_id text NOT NULL,
  chunk_sha256 text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_sha256)
);

CREATE TABLE IF NOT EXISTS slack_source_blobs (
  tenant_id text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  chunks jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256)
);

-- One row per Slack file. metadata_json is the post-redaction file object
-- (url_private*, thumb_*, permalink_public removed by vault/redaction.ts).
-- version_ref changes when Slack reports a new file revision; the exported
-- binary is then a new version of the same path (earlier bytes stay in history).
CREATE TABLE IF NOT EXISTS slack_source_files (
  tenant_id text NOT NULL,
  team_id text NOT NULL,
  file_id text NOT NULL,
  source_key text GENERATED ALWAYS AS (team_id || '/' || file_id) STORED,
  name text,
  title text,
  mimetype text,
  filetype text,
  declared_size bigint,
  version_ref text,
  version_ordinal bigint,
  channel_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata_json text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'stored', 'skipped_oversize', 'external', 'no_download_url', 'disallowed_host', 'failed', 'unavailable')),
  status_reason text,
  sha256 text,
  size bigint,
  stored_version_ref text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz,
  deleted_at timestamptz,
  deleted_reason text CHECK (deleted_reason IS NULL OR deleted_reason IN ('file_deleted', 'file_tombstoned', 'file_not_found')),
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_source_files_retry
  ON slack_source_files (tenant_id, team_id, next_attempt_at) WHERE status IN ('pending', 'failed') AND deleted_at IS NULL;

-- Journal triggers (source_lane_journal_row(tenant column, key column, ignored lifecycle columns...)).
-- Conversations export only their access/coverage label; cursors and page progress are ignored.
CREATE TRIGGER trg_source_lane_journal_slack_source_conversations
  AFTER INSERT OR UPDATE OR DELETE ON slack_source_conversations
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row(
    'tenant_id', 'source_key',
    'head_ts', 'tail_ts', 'history_started_at', 'fwd_oldest', 'fwd_latest', 'fwd_cursor', 'fwd_low_ts', 'fwd_top_ts', 'fwd_started_at',
    'bwd_latest', 'bwd_inclusive', 'bwd_cursor', 'rec_oldest', 'rec_latest', 'rec_cursor', 'rec_low_ts', 'rec_top_ts', 'rec_started_at',
    'last_reconcile_at', 'messages_seen', 'pages_done', 'last_listed_at', 'last_forward_at', 'last_forward_complete_at', 'last_success_at',
    'last_error', 'last_error_at', 'error_streak', 'updated_at'
  );

CREATE TRIGGER trg_source_lane_journal_slack_source_files
  AFTER INSERT OR UPDATE OR DELETE ON slack_source_files
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row(
    'tenant_id', 'source_key', 'attempts', 'last_error', 'next_attempt_at', 'updated_at'
  );
