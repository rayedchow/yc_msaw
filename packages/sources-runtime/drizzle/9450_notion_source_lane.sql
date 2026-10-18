-- Notion deep source lane (provider range 9450-9499).
--
-- Additive only: no donor table is altered. The donor lane (notion.poll /
-- notion.render / notion.reconcile, native snapshot tables from 0025 and the
-- sources/notion/<Title>-page-<id>/content.md mirror) is unchanged. These tables
-- hold what the source-lane collector (task notion.source_sweep,
-- src/source-lane/providers/notion/sweep.ts) reads from the Notion REST API
-- (Notion-Version 2026-03-11): every page, database, data source, block,
-- comment and Notion-hosted file reachable by the connection, fully paginated,
-- with durable cursors, generation-based missing-object confirmation and an
-- append-only raw ledger.
--
-- Every row is scoped by tenant_id (= donor user_id = yc_msaw tenantNs, taken
-- from the server-written task row) AND connection_id (the Notion bot id of the
-- OAuth installation / internal integration the tenant connected). row_key is
-- computed by the application as <connection>/<type>/<id>[/...] (percent-encoded
-- segments) and is the journal key. Nothing here stores an access token, a
-- signed file URL (query strings are dropped before any write) or a cookie.

-- 1. Upstream quota coordination keyed by the ACTUAL Notion budgets: the
--    per-connection budget (bot id) and the per-workspace budget shared by all
--    connections of a workspace, plus per-endpoint limits. A 429 records the
--    Retry-After on the key Notion named in additional_data.rate_limit_reason;
--    every tenant/worker using that connection or workspace waits.
CREATE TABLE IF NOT EXISTS notion_source_quota (
  quota_key text PRIMARY KEY,
  blocked_until timestamptz,
  rate_limit_streak integer NOT NULL DEFAULT 0,
  last_status integer,
  last_retry_after_ms bigint,
  last_reason text,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. The connection as the collector last saw it (GET /v1/users/me + stored token
--    metadata). Exported as _connection.json; status/capabilities drive coverage.
CREATE TABLE IF NOT EXISTS notion_source_connections (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  connection_id text NOT NULL,
  workspace_id text,
  workspace_name text,
  bot_id text,
  auth_mode text,
  owner jsonb,
  bot jsonb,
  -- active | blocked (auth failure / token missing) | replaced (tenant connected another bot)
  status text NOT NULL DEFAULT 'active',
  status_reason text,
  -- observed capability denials, e.g. {"comments": "restricted_resource"}
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, connection_id)
);

-- 3. Durable sweep state per (tenant, connection).
--    generation               full inventory pass number (0 = never started)
--    full_complete_generation = generation once every work item of that pass
--                               finished without failure AND missing objects
--                               were confirmed; never set from a bounded pass
--    delta_watermark          last_edited_time watermark of the newest-first
--                             search, advanced only after the delta listing
--                             reached the watermark (or was exhausted)
CREATE TABLE IF NOT EXISTS notion_source_sync_state (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  quota_key text NOT NULL,
  workspace_quota_key text,
  generation integer NOT NULL DEFAULT 0,
  generation_phase text NOT NULL DEFAULT 'closed',
  generation_reason text,
  generation_started_at timestamptz,
  generation_finished_at timestamptz,
  generation_failed_items integer NOT NULL DEFAULT 0,
  generation_inaccessible_items integer NOT NULL DEFAULT 0,
  full_complete_generation integer,
  full_complete_at timestamptz,
  delta_watermark timestamptz,
  delta_checked_at timestamptz,
  blocked_code text,
  blocked_reason text,
  last_error text,
  last_error_at timestamptz,
  error_streak integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id)
);

-- 4. Restart-safe work queue: every listing/fetch step is an item with a
--    deterministic key. Listing items carry their Notion start_cursor in payload
--    and advance it only after the page of results was stored. page_id groups a
--    page walk's child listings so the walk can be finalized exactly once.
CREATE TABLE IF NOT EXISTS notion_source_work (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  item_key text NOT NULL,
  kind text NOT NULL,
  priority integer NOT NULL DEFAULT 5,
  page_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  generation integer NOT NULL,
  -- pending | done | failed | inaccessible
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  not_before timestamptz,
  last_error text,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_notion_source_work_pending
  ON notion_source_work (tenant_id, connection_id, state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_notion_source_work_page
  ON notion_source_work (tenant_id, connection_id, page_id, state);

-- 5. Current state per page / data source / database. raw is the latest
--    redacted provider object (exported as stored jsonb text). Pages carry the
--    hydrated values of paginated properties (relation/people/rollup/... beyond
--    the 25 items embedded in the page object). tombstoned_at marks trash,
--    archive and confirmed 404 (Notion answers 404 for both deleted and
--    unshared objects); restores clear it. content_epoch is bumped whenever the
--    page's block tree or comments changed, path_epoch when an ancestor moved or
--    was renamed, rows_epoch when a data source's row set changed - each bump
--    re-exports the dependent files.
CREATE TABLE IF NOT EXISTS notion_source_nodes (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  connection_id text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  parent_type text,
  parent_id text,
  database_id text,
  title text NOT NULL DEFAULT '',
  url text,
  created_time timestamptz,
  last_edited_time timestamptz,
  in_trash boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  is_locked boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  hydrated_properties jsonb,
  properties_status text,
  walk_epoch integer NOT NULL DEFAULT 0,
  walk_started_at timestamptz,
  walked_at timestamptz,
  walk_status text,
  walk_error text,
  tree_sha256 text,
  content_epoch integer NOT NULL DEFAULT 0,
  comments_status text,
  comments_checked_at timestamptz,
  query_status text,
  query_checked_at timestamptz,
  rows_epoch integer NOT NULL DEFAULT 0,
  seen_generation integer,
  last_seen_at timestamptz,
  tombstoned_at timestamptz,
  tombstone_reason text,
  inaccessible_at timestamptz,
  inaccessible_reason text,
  path_epoch integer NOT NULL DEFAULT 0,
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, connection_id, object_id)
);
CREATE INDEX IF NOT EXISTS idx_notion_source_nodes_parent
  ON notion_source_nodes (tenant_id, connection_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_notion_source_nodes_type
  ON notion_source_nodes (tenant_id, connection_id, object_type);

-- 6. Blocks of every walked page (not journaled themselves: a page's content_epoch
--    re-exports its blocks.json / page.md). page_id is the page whose walk owns
--    the block; position orders siblings exactly as Notion listed them.
CREATE TABLE IF NOT EXISTS notion_source_blocks (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  block_id text NOT NULL,
  page_id text NOT NULL,
  parent_id text NOT NULL,
  parent_type text,
  position integer NOT NULL DEFAULT 0,
  depth integer NOT NULL DEFAULT 0,
  block_type text NOT NULL,
  has_children boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  last_edited_time timestamptz,
  seen_epoch integer NOT NULL DEFAULT 0,
  comments_checked_at timestamptz,
  tombstoned_at timestamptz,
  tombstone_reason text,
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, block_id)
);
CREATE INDEX IF NOT EXISTS idx_notion_source_blocks_page
  ON notion_source_blocks (tenant_id, connection_id, page_id, parent_id, position);

-- 7. Comments (page-level and block-level discussions). List comments returns
--    only un-resolved comments, so a comment missing from a complete listing is
--    confirmed with GET /v1/comments/{id}: 200 = resolved (kept), 404 = deleted
--    (content kept, marked deleted). Never hard-deleted here.
CREATE TABLE IF NOT EXISTS notion_source_comments (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  comment_id text NOT NULL,
  page_id text NOT NULL,
  block_id text,
  discussion_id text,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  created_time timestamptz,
  last_edited_time timestamptz,
  -- open | resolved | deleted
  status text NOT NULL DEFAULT 'open',
  missing_since timestamptz,
  deleted_at timestamptz,
  deleted_reason text,
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_notion_source_comments_page
  ON notion_source_comments (tenant_id, connection_id, page_id);

-- 8. Files referenced by blocks, page covers/icons and `files` properties.
--    Notion-hosted files (type file) are fetched immediately from the signed URL
--    (valid one hour) without credentials, from allowlisted hosts only, and kept
--    as exact bytes; the URL itself is never stored (url_path = host + path).
--    External files are recorded, never fetched.
CREATE TABLE IF NOT EXISTS notion_source_files (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  connection_id text NOT NULL,
  file_key text NOT NULL,
  owner_type text NOT NULL,
  owner_id text NOT NULL,
  page_id text NOT NULL,
  slot text NOT NULL,
  source_type text NOT NULL,
  name text,
  url_host text,
  url_path text,
  file_upload_id text,
  -- pending | stored | failed | too_large | host_refused | external | unsupported
  status text NOT NULL DEFAULT 'pending',
  sha256 text,
  size bigint,
  media_type text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  owner_last_edited_time timestamptz,
  fetched_at timestamptz,
  tombstoned_at timestamptz,
  tombstone_reason text,
  path_epoch integer NOT NULL DEFAULT 0,
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, connection_id, file_key)
);
CREATE INDEX IF NOT EXISTS idx_notion_source_files_page
  ON notion_source_files (tenant_id, connection_id, page_id);

-- 9a. Content-addressed store of every distinct block payload ever observed (not
--     journaled). Page tree records reference blocks by (block_id, raw_sha256),
--     so an edit stores only the changed blocks, while every historical tree
--     snapshot stays exactly reconstructible.
CREATE TABLE IF NOT EXISTS notion_source_block_versions (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  block_id text NOT NULL,
  raw_sha256 text NOT NULL,
  raw jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, block_id, raw_sha256)
);

-- 9b. Append-only raw ledger: every distinct observed node/comment payload
--    (record_kind 'observation', raw = the redacted provider object) and every
--    distinct page tree (record_kind 'tree', raw = ordered block/comment
--    structure with content hashes; the exported file is composed from the
--    stored jsonb of each referenced version). Keyed by content hash, so a
--    repeated poll is a no-op.
CREATE TABLE IF NOT EXISTS notion_source_records (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  connection_id text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  record_kind text NOT NULL,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  endpoint text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key)
);
CREATE INDEX IF NOT EXISTS idx_notion_source_records_object
  ON notion_source_records (tenant_id, connection_id, object_id, record_kind);

-- 10. Exact file bytes as ordered <= 8 MiB chunks (yc_msaw blob limit). Per tenant:
--     no cross-tenant dedupe, so blob existence is never an oracle.
CREATE TABLE IF NOT EXISTS notion_source_chunks (
  tenant_id text NOT NULL,
  chunk_sha256 text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_sha256)
);

CREATE TABLE IF NOT EXISTS notion_source_blobs (
  tenant_id text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL,
  chunks jsonb NOT NULL,
  media_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256)
);

-- Journal triggers (drizzle/9000 source_lane_journal_row(tenant col, key col,
-- ignored lifecycle cols...)): sweep bookkeeping columns never re-export.
DROP TRIGGER IF EXISTS trg_source_lane_journal_notion_connections ON notion_source_connections;
CREATE TRIGGER trg_source_lane_journal_notion_connections
  AFTER INSERT OR UPDATE OR DELETE ON notion_source_connections
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'checked_at', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_notion_nodes ON notion_source_nodes;
CREATE TRIGGER trg_source_lane_journal_notion_nodes
  AFTER INSERT OR UPDATE OR DELETE ON notion_source_nodes
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key',
    'walk_epoch', 'walk_started_at', 'walked_at', 'walk_status', 'walk_error', 'comments_status', 'comments_checked_at',
    'query_status', 'query_checked_at', 'seen_generation', 'last_seen_at', 'properties_status', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_notion_files ON notion_source_files;
CREATE TRIGGER trg_source_lane_journal_notion_files
  AFTER INSERT OR UPDATE OR DELETE ON notion_source_files
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'attempts', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_notion_records ON notion_source_records;
CREATE TRIGGER trg_source_lane_journal_notion_records
  AFTER INSERT OR UPDATE OR DELETE ON notion_source_records
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key');
