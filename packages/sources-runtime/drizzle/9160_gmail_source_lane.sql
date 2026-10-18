-- Gmail source lane (provider range 9160-9174).
--
-- Additive only: no donor table is altered. Every row is scoped by tenant_id
-- (= donor user_id = yc_msaw tenantNs, assigned server-side) AND mailbox (the
-- connected Google account), because Gmail message/thread/history ids are
-- mailbox-scoped. Nothing here stores a credential.

-- 1. Upstream quota coordination, keyed by the ACTUAL upstream mailbox (opaque
--    hash of the account), never by tenant: two tenants connected to the same
--    mailbox share one cooldown and one active sync lease, so the per-user Gmail
--    budget is not multiplied by the number of bindings. Durable, so a cooldown
--    survives the worker process and is seen by every worker.
CREATE TABLE IF NOT EXISTS gmail_source_quota (
  quota_key text PRIMARY KEY,
  cooldown_until timestamptz,
  rate_limit_streak integer NOT NULL DEFAULT 0,
  last_status integer,
  last_reason text,
  last_retry_after_seconds integer,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Durable per-(tenant, mailbox) sync state.
--    generation                  full-capture pass number (1 = initial; +1 on history expiry / reset)
--    generation_start_history_id mailbox historyId read BEFORE listing started; the history
--                                cursor starts here, so nothing changed during listing is lost
--    list_page_token             messages.list checkpoint, advanced only after a page is stored
--    full_complete_generation    = generation once the listing, the absent-message sweep and
--                                every pending fetch are done (never set from a bounded pass)
--    history_id                  history.list cursor (advanced per processed page)
CREATE TABLE IF NOT EXISTS gmail_source_sync_state (
  tenant_id text NOT NULL,
  mailbox text NOT NULL,
  quota_key text,
  auth_mode text,
  generation integer NOT NULL DEFAULT 0,
  generation_reason text,
  generation_started_at timestamptz,
  generation_start_history_id numeric(20, 0),
  list_include_spam_trash boolean,
  list_page_token text,
  list_pages_done integer NOT NULL DEFAULT 0,
  list_messages_seen bigint NOT NULL DEFAULT 0,
  list_exhausted_at timestamptz,
  last_list_progress_at timestamptz,
  full_complete_at timestamptz,
  full_complete_generation integer,
  history_id numeric(20, 0),
  history_checked_at timestamptz,
  history_resets integer NOT NULL DEFAULT 0,
  continuation_seq integer NOT NULL DEFAULT 0,
  blocked_code text,
  blocked_reason text,
  last_error text,
  last_error_at timestamptz,
  error_streak integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mailbox)
);

-- 3. Content-addressed exact bytes (RFC822 messages, attachments), ordered
--    chunks of <= 8 MiB like the yc_msaw store. Per tenant: no cross-tenant
--    dedupe, so blob existence is never an oracle across tenants.
CREATE TABLE IF NOT EXISTS gmail_source_chunks (
  tenant_id text NOT NULL,
  chunk_sha256 text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_sha256)
);

CREATE TABLE IF NOT EXISTS gmail_source_blobs (
  tenant_id text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  chunks jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256)
);

-- 4. Messages. raw_json is the exact post-redaction messages.get(format=full)
--    payload of the FIRST capture (messages are immutable; only labels change),
--    with attachment part bytes stripped (they live in gmail_source_attachments).
--    Labels are current state, ordered by Gmail historyId (label_history_id), so
--    an older observation never overwrites a newer one.
CREATE TABLE IF NOT EXISTS gmail_source_messages (
  tenant_id text NOT NULL,
  mailbox text NOT NULL,
  message_id text NOT NULL,
  source_key text GENERATED ALWAYS AS (mailbox || '/' || message_id) STORED,
  thread_id text,
  internal_date timestamptz,
  size_estimate bigint,
  message_history_id numeric(20, 0),
  raw_json text,
  raw_sha256 text,
  redaction_applied boolean NOT NULL DEFAULT false,
  label_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  label_history_id numeric(20, 0),
  observed_history_id numeric(20, 0),
  rfc822_status text NOT NULL DEFAULT 'pending'
    CHECK (rfc822_status IN ('pending', 'captured', 'disabled', 'oversize', 'withheld_redaction', 'failed', 'unavailable')),
  rfc822_sha256 text,
  rfc822_size bigint,
  rfc822_error text,
  rfc822_attempts integer NOT NULL DEFAULT 0,
  rfc822_next_attempt_at timestamptz,
  attachments_rev integer NOT NULL DEFAULT 0,
  seen_generation integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  deleted_history_id numeric(20, 0),
  deleted_reason text CHECK (deleted_reason IS NULL OR deleted_reason IN ('provider_deleted', 'absent_from_listing')),
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mailbox, message_id)
);

CREATE INDEX IF NOT EXISTS idx_gmail_source_messages_thread
  ON gmail_source_messages (tenant_id, mailbox, thread_id);
CREATE INDEX IF NOT EXISTS idx_gmail_source_messages_sweep
  ON gmail_source_messages (tenant_id, mailbox, seen_generation) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gmail_source_messages_rfc822_retry
  ON gmail_source_messages (tenant_id, mailbox, rfc822_next_attempt_at) WHERE rfc822_status IN ('pending', 'failed');

-- 5. Attachment parts (keyed by message + MIME part, never by the volatile attachmentId).
CREATE TABLE IF NOT EXISTS gmail_source_attachments (
  tenant_id text NOT NULL,
  mailbox text NOT NULL,
  message_id text NOT NULL,
  part_ref text NOT NULL,
  source_key text GENERATED ALWAYS AS (mailbox || '/' || message_id || '/' || part_ref) STORED,
  part_id text,
  filename text,
  mime_type text,
  declared_size bigint,
  content_id text,
  disposition text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'stored', 'skipped_oversize', 'failed', 'unavailable')),
  sha256 text,
  size bigint,
  capture text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz,
  deleted_at timestamptz,
  captured_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mailbox, message_id, part_ref)
);

CREATE INDEX IF NOT EXISTS idx_gmail_source_attachments_retry
  ON gmail_source_attachments (tenant_id, mailbox, next_attempt_at) WHERE status IN ('pending', 'failed') AND deleted_at IS NULL;

-- 6. Threads: one row per (mailbox, thread) touched whenever a member message
--    changes; the exporter renders the thread view from the current messages.
CREATE TABLE IF NOT EXISTS gmail_source_threads (
  tenant_id text NOT NULL,
  mailbox text NOT NULL,
  thread_id text NOT NULL,
  source_key text GENERATED ALWAYS AS (mailbox || '/' || thread_id) STORED,
  touched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mailbox, thread_id)
);

-- 7. Exact history.list pages (post-redaction) with at least one record.
CREATE TABLE IF NOT EXISTS gmail_source_history_pages (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  mailbox text NOT NULL,
  start_history_id numeric(20, 0) NOT NULL,
  response_history_id numeric(20, 0),
  first_record_id numeric(20, 0),
  last_record_id numeric(20, 0),
  record_count integer NOT NULL,
  raw_json text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mailbox, start_history_id)
);

-- 8. Message fetches that failed for a non-quota reason. Their existence keeps
--    the mailbox `partial`; they are retried with backoff so one bad message
--    never pins the history cursor (the donor refused to advance forever).
CREATE TABLE IF NOT EXISTS gmail_source_pending (
  tenant_id text NOT NULL,
  mailbox text NOT NULL,
  message_id text NOT NULL,
  reason text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mailbox, message_id)
);

-- Journal triggers (source_lane_journal_row(tenant column, key column, ignored lifecycle columns...)).
CREATE TRIGGER trg_source_lane_journal_gmail_source_messages
  AFTER INSERT OR UPDATE OR DELETE ON gmail_source_messages
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row(
    'tenant_id', 'source_key',
    'seen_generation', 'observed_history_id', 'rfc822_attempts', 'rfc822_next_attempt_at', 'rfc822_error', 'updated_at'
  );

CREATE TRIGGER trg_source_lane_journal_gmail_source_attachments
  AFTER INSERT OR UPDATE OR DELETE ON gmail_source_attachments
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row(
    'tenant_id', 'source_key', 'attempts', 'last_error', 'next_attempt_at', 'updated_at'
  );

CREATE TRIGGER trg_source_lane_journal_gmail_source_threads
  AFTER INSERT OR UPDATE OR DELETE ON gmail_source_threads
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'source_key');

CREATE TRIGGER trg_source_lane_journal_gmail_source_history_pages
  AFTER INSERT OR UPDATE OR DELETE ON gmail_source_history_pages
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'id');
