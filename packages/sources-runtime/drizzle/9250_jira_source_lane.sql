-- Jira deep source lane (provider range 9250-9299).
--
-- Additive only: no donor table is altered. The donor Nango lanes (record sync
-- + nango.proxy_details, writing activity_events / mirror_files) are unchanged;
-- these tables hold what the Jira Cloud REST API returns through the
-- authenticated Nango proxy: per-site projects, issues (all fields), every
-- changelog history entry (paged, not only the search-embedded subset),
-- comments, attachment metadata and exact attachment bytes.
--
-- Every row is scoped by tenant_id (= donor user_id = yc_msaw tenantNs,
-- assigned server-side), connection_id (Nango connection) AND cloud_id
-- (Atlassian site), because Jira ids are only unique per site. Objects are
-- keyed by the stable numeric provider id; the issue KEY is data (it changes
-- on move / project rename). row_key is computed by the application as
-- percent-encoded <connection>/<cloud>/<type>/<id>[/<record>] and is the
-- journal key. Nothing here stores a credential, a signed URL or a cookie.

-- 1. Upstream quota coordination keyed by the ACTUAL Atlassian bucket: the
--    OAuth app (Nango provider config key) on one site (cloudId).
CREATE TABLE IF NOT EXISTS jira_source_quota (
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

-- 2a. Last site-discovery outcome per connection.
CREATE TABLE IF NOT EXISTS jira_source_connections (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  status text NOT NULL,
  reason text,
  sites integer NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id)
);

-- 2b. Sites reachable through a connection, with the granted OAuth scopes.
CREATE TABLE IF NOT EXISTS jira_source_sites (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  connection_id text NOT NULL,
  provider_config_key text NOT NULL,
  cloud_id text NOT NULL,
  site_url text,
  site_name text,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- active | removed (not in accessible-resources / connection replaced) | blocked (auth failure)
  status text NOT NULL DEFAULT 'active',
  status_reason text,
  -- hash of the project selection in force (re-exports _site.json when it changes)
  selection_sha text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, connection_id, cloud_id)
);

-- 3. Project selection, written only through the runtime internal API with the
--    tenant taken from yc_msaw's verified principal (never from a body or a
--    global setting). cloud_id '*' applies to every site of the connection; a
--    site-specific row wins. No row = every project the grant can browse.
CREATE TABLE IF NOT EXISTS jira_source_selection (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  cloud_id text NOT NULL DEFAULT '*',
  mode text NOT NULL CHECK (mode IN ('all', 'projects')),
  projects jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, cloud_id)
);

-- 4. Durable sweep state per (tenant, connection, site).
--    full_complete_generation = generation once every scan item of that pass
--      finished without failure AND the missing-object confirmations ran;
--      never set from a bounded pass.
--    delta_watermark advances only after a delta JQL search was paged to
--      exhaustion (to the instant that search started).
CREATE TABLE IF NOT EXISTS jira_source_sync_state (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  cloud_id text NOT NULL,
  provider_config_key text NOT NULL,
  quota_key text NOT NULL,
  selection_sha text,
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
  PRIMARY KEY (tenant_id, connection_id, cloud_id)
);

-- 5. Restart-safe work queue: every listing/fetch step is an item with a
--    deterministic key; listings checkpoint their cursor (nextPageToken /
--    startAt) in payload only after the page was stored.
CREATE TABLE IF NOT EXISTS jira_source_work (
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
CREATE INDEX IF NOT EXISTS idx_jira_source_work_pending
  ON jira_source_work (tenant_id, connection_id, cloud_id, state, priority, created_at);

-- 6. Current state per provider object (project, issue, comment, attachment).
--    raw is the latest redacted provider payload (exported as stored jsonb
--    text). tombstoned_at = confirmed deleted / trashed / outside the project
--    selection; inaccessible_at = no longer readable by this grant (kept, never
--    treated as deleted).
CREATE TABLE IF NOT EXISTS jira_source_objects (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  connection_id text NOT NULL,
  cloud_id text NOT NULL,
  content_type text NOT NULL,
  content_id text NOT NULL,
  issue_key text,
  project_id text,
  project_key text,
  container_id text,
  status text,
  title text,
  source_updated_at timestamptz,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  -- issue security level / comment visibility present: a 404 may be lost access
  restricted boolean NOT NULL DEFAULT false,
  changelog_total integer,
  changelog_stored integer,
  changelog_status text,
  comments_total integer,
  comments_status text,
  binary_status text,
  binary_sha256 text,
  binary_size bigint,
  binary_media_type text,
  binary_error text,
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
CREATE INDEX IF NOT EXISTS idx_jira_source_objects_container
  ON jira_source_objects (tenant_id, connection_id, cloud_id, container_id);
CREATE INDEX IF NOT EXISTS idx_jira_source_objects_project
  ON jira_source_objects (tenant_id, connection_id, cloud_id, project_id);

-- 7. Append-only raw ledger: every distinct observed payload ('observation',
--    keyed by content hash, so a repeated poll is a no-op) and every changelog
--    history entry ('changelog', keyed by history id). Never updated.
CREATE TABLE IF NOT EXISTS jira_source_records (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  object_key text NOT NULL,
  connection_id text NOT NULL,
  cloud_id text NOT NULL,
  content_type text NOT NULL,
  content_id text NOT NULL,
  record_kind text NOT NULL,
  history_id text,
  history_created timestamptz,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  endpoint text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key)
);
CREATE INDEX IF NOT EXISTS idx_jira_source_records_object
  ON jira_source_records (tenant_id, object_key, record_kind);

-- 8. Exact attachment bytes as ordered <= 8 MiB chunks (yc_msaw blob limit).
--    Per tenant: no cross-tenant dedupe, so blob existence is never an oracle.
CREATE TABLE IF NOT EXISTS jira_source_chunks (
  tenant_id text NOT NULL,
  chunk_sha256 text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_sha256)
);

CREATE TABLE IF NOT EXISTS jira_source_blobs (
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
DROP TRIGGER IF EXISTS trg_source_lane_journal_jira_sites ON jira_source_sites;
CREATE TRIGGER trg_source_lane_journal_jira_sites
  AFTER INSERT OR UPDATE OR DELETE ON jira_source_sites
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'last_seen_at', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_jira_objects ON jira_source_objects;
CREATE TRIGGER trg_source_lane_journal_jira_objects
  AFTER INSERT OR UPDATE OR DELETE ON jira_source_objects
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'seen_generation', 'last_seen_at', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_jira_records ON jira_source_records;
CREATE TRIGGER trg_source_lane_journal_jira_records
  AFTER INSERT OR UPDATE OR DELETE ON jira_source_records
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key');
