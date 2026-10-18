-- Confluence deep source lane (provider range 9200-9249).
--
-- Additive only: no donor table is altered. The donor Nango /records lane
-- (activity_events + mirror_files written by src/integrations/atlassian) is
-- unchanged; these tables hold what the Confluence REST API returns through the
-- authenticated Nango proxy: per-site inventory, every page/blog post version
-- body, comments, attachment bytes, space permissions and page restrictions.
--
-- Every row is scoped by tenant_id (= donor user_id = yc_msaw tenantNs,
-- assigned server-side), connection_id (Nango connection) AND cloud_id
-- (Atlassian site), because Confluence content ids are only unique per site.
-- row_key is computed by the application as percent-encoded
-- <connection>/<cloud>/<type>/<id>[/<record>] and is the journal key.
-- Nothing here stores a credential, a signed URL or a cookie.

-- 1. Upstream quota coordination keyed by the ACTUAL Atlassian bucket: the
--    OAuth app (Nango provider config key) on one site (cloudId). Two tenants
--    that connected the same site through the same app share one cooldown and
--    one active sweep lease, so the budget is never multiplied by tenants.
CREATE TABLE IF NOT EXISTS confluence_source_quota (
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

-- 2a. Last site-discovery outcome per connection (a grant that cannot list any
--     site has no site row, but its coverage must still say why).
CREATE TABLE IF NOT EXISTS confluence_source_connections (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  status text NOT NULL,
  reason text,
  sites integer NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id)
);

-- 2b. Sites reachable through a connection, with the granted OAuth scopes.
CREATE TABLE IF NOT EXISTS confluence_source_sites (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  connection_id text NOT NULL,
  provider_config_key text NOT NULL,
  cloud_id text NOT NULL,
  site_url text,
  site_name text,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- active | removed (no longer in accessible-resources) | blocked (auth/scope failure)
  status text NOT NULL DEFAULT 'active',
  status_reason text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, connection_id, cloud_id)
);

-- 3. Durable sweep state per (tenant, connection, site).
--    generation              full inventory pass number (0 = never started)
--    full_complete_generation = generation once every work item of that pass
--                             finished without failure AND the missing-object
--                             reconcile ran; never set from a bounded pass
--    delta_watermark         CQL lastmodified watermark, advanced only after a
--                             delta search was paged to exhaustion
CREATE TABLE IF NOT EXISTS confluence_source_sync_state (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  cloud_id text NOT NULL,
  provider_config_key text NOT NULL,
  quota_key text NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  -- scan (listing/fetch items) -> confirm (missing-object 404 checks) -> closed
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
  PRIMARY KEY (tenant_id, connection_id, cloud_id)
);

-- 4. Restart-safe work queue: every listing/fetch step is an item with a
--    deterministic key. Listing items carry their pagination cursor in
--    payload and advance it only after the page was stored.
CREATE TABLE IF NOT EXISTS confluence_source_work (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  cloud_id text NOT NULL,
  item_key text NOT NULL,
  kind text NOT NULL,
  priority integer NOT NULL DEFAULT 5,
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
  PRIMARY KEY (tenant_id, connection_id, cloud_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_confluence_source_work_pending
  ON confluence_source_work (tenant_id, connection_id, cloud_id, state, priority, created_at);

-- 5. Current state per provider object (space, page, blogpost, footer_comment,
--    inline_comment, attachment). raw is the latest redacted provider payload
--    (exported as stored jsonb text); tombstoned_at marks provider deletion /
--    trash / whole-space deletion; inaccessible_at marks objects the
--    connection can no longer read (never treated as deleted).
CREATE TABLE IF NOT EXISTS confluence_source_objects (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  connection_id text NOT NULL,
  cloud_id text NOT NULL,
  content_type text NOT NULL,
  content_id text NOT NULL,
  space_id text,
  space_key text,
  container_type text,
  container_id text,
  parent_comment_id text,
  status text,
  title text,
  version_number integer,
  version_created_at timestamptz,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  adf jsonb,
  adf_version integer,
  restrictions jsonb,
  restrictions_status text,
  permissions jsonb,
  permissions_status text,
  binary_status text,
  binary_sha256 text,
  binary_size bigint,
  binary_version integer,
  binary_media_type text,
  binary_error text,
  history_through integer,
  seen_generation integer,
  last_seen_at timestamptz,
  inaccessible_at timestamptz,
  inaccessible_reason text,
  tombstoned_at timestamptz,
  tombstone_reason text,
  children_epoch integer NOT NULL DEFAULT 0,
  parent_epoch integer NOT NULL DEFAULT 0,
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, connection_id, cloud_id, content_type, content_id)
);
CREATE INDEX IF NOT EXISTS idx_confluence_source_objects_container
  ON confluence_source_objects (tenant_id, connection_id, cloud_id, container_id);
CREATE INDEX IF NOT EXISTS idx_confluence_source_objects_space
  ON confluence_source_objects (tenant_id, connection_id, cloud_id, space_id);

-- 6. Append-only raw ledger: every distinct observed payload (record_kind
--    'observation', keyed by content hash, so a repeated poll is a no-op) and
--    every historical version body fetched from the version API
--    (record_kind 'version', keyed by version number). Never updated except
--    space_id/parent_epoch when the container moves (path bookkeeping).
CREATE TABLE IF NOT EXISTS confluence_source_records (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  object_key text NOT NULL,
  connection_id text NOT NULL,
  cloud_id text NOT NULL,
  content_type text NOT NULL,
  content_id text NOT NULL,
  record_kind text NOT NULL,
  version_number integer,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  endpoint text,
  space_id text,
  parent_epoch integer NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key)
);
CREATE INDEX IF NOT EXISTS idx_confluence_source_records_object
  ON confluence_source_records (tenant_id, object_key, record_kind);

-- 7. Exact attachment bytes as ordered <= 8 MiB chunks (yc_msaw blob limit).
--    Per tenant: no cross-tenant dedupe, so blob existence is never an oracle.
CREATE TABLE IF NOT EXISTS confluence_source_chunks (
  tenant_id text NOT NULL,
  chunk_sha256 text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_sha256)
);

CREATE TABLE IF NOT EXISTS confluence_source_blobs (
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
DROP TRIGGER IF EXISTS trg_source_lane_journal_confluence_sites ON confluence_source_sites;
CREATE TRIGGER trg_source_lane_journal_confluence_sites
  AFTER INSERT OR UPDATE OR DELETE ON confluence_source_sites
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'last_seen_at', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_confluence_objects ON confluence_source_objects;
CREATE TRIGGER trg_source_lane_journal_confluence_objects
  AFTER INSERT OR UPDATE OR DELETE ON confluence_source_objects
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'seen_generation', 'last_seen_at', 'updated_at', 'history_through');

DROP TRIGGER IF EXISTS trg_source_lane_journal_confluence_records ON confluence_source_records;
CREATE TRIGGER trg_source_lane_journal_confluence_records
  AFTER INSERT OR UPDATE OR DELETE ON confluence_source_records
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key');
