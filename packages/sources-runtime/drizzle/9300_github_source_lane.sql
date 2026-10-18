-- GitHub repository CONTENT source lane (provider range 9300-9349).
--
-- Additive only: no donor table is altered. The donor Nango lanes (records,
-- proxy issues/PR details/comments, github_repo_sync selection) are unchanged.
-- These tables hold what the GitHub Git Database API returns through the
-- authenticated Nango proxy for every SELECTED repository (donor
-- github_repo_sync.syncing = true): repository metadata, per-ref confirmed
-- scans (commit + tree), the file set of each ref and the exact blob bytes.
--
-- Every row is scoped by tenant_id (= donor user_id = yc_msaw tenantNs,
-- assigned server-side) and the immutable numeric GitHub repository id.
-- Nothing here stores a credential, a signed URL or a cookie.

-- 1. Upstream quota coordination keyed by the ACTUAL GitHub bucket: the GitHub
--    App installation when Nango exposes its id, else the Nango connection
--    (one user-to-server or installation grant). One active content sweep per
--    bucket across workers and tenants; Retry-After / X-RateLimit-Reset
--    cooldowns and the last observed remaining budget live here.
CREATE TABLE IF NOT EXISTS github_source_quota (
  quota_key text PRIMARY KEY,
  blocked_until timestamptz,
  blocked_kind text,
  rate_limit_streak integer NOT NULL DEFAULT 0,
  last_status integer,
  last_retry_after_ms bigint,
  last_reason text,
  rate_limit integer,
  rate_remaining integer,
  rate_reset_at timestamptz,
  rate_resource text,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Discovery outcome per tenant connection (a grant that sees no selected
--    repository still needs a truthful coverage line).
CREATE TABLE IF NOT EXISTS github_source_connections (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  provider_config_key text NOT NULL,
  installation_id text,
  quota_key text NOT NULL,
  status text NOT NULL,
  reason text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id)
);

-- 3. Selected repositories by immutable id. full_name follows renames/transfers
--    (path_epoch bumps re-export every file at the new path); selected_name is
--    the donor github_repo_sync name that put it in scope.
--    status: active | out_of_scope | inaccessible | blocked
CREATE TABLE IF NOT EXISTS github_source_repos (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  repo_id text NOT NULL,
  connection_id text NOT NULL,
  provider_config_key text NOT NULL,
  quota_key text NOT NULL,
  full_name text NOT NULL,
  selected_name text NOT NULL,
  default_branch text,
  extra_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  private boolean,
  visibility text,
  archived boolean,
  raw jsonb,
  raw_sha256 text,
  status text NOT NULL DEFAULT 'active',
  status_reason text,
  path_epoch integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, repo_id)
);

-- 4. Refs (branches) of a repository and their scan generations.
--    next_generation        monotonic counter; every CONFIRMED scan (ref resolved
--                           to a commit) takes next_generation + 1, never reused
--    scan_generation        the scan in progress (null = none); staging rows are
--                           keyed by it
--    committed_generation   the scan whose file set is current; a commit is
--                           accepted only for scan_generation AND only when it is
--                           greater than committed_generation, so a late
--                           completion of an older scan can never replace a newer
--                           one. Ordering is by generation, never by commit dates
--                           or SHAs (a HEAD may legitimately roll back A->B->A).
--    status: active | retired (no longer configured / default branch moved) |
--            not_found (ref deleted upstream) | empty (repository has no commits)
CREATE TABLE IF NOT EXISTS github_source_refs (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  repo_id text NOT NULL,
  ref_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  status_reason text,
  next_generation integer NOT NULL DEFAULT 0,
  scan_generation integer,
  scan_commit_sha text,
  scan_tree_sha text,
  scan_commit_raw jsonb,
  scan_phase text,
  scan_started_at timestamptz,
  scan_reason text,
  scan_incomplete_prefixes jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_generation integer,
  committed_commit_sha text,
  committed_tree_sha text,
  committed_commit_raw jsonb,
  committed_at timestamptz,
  committed_counts jsonb,
  observed_head_sha text,
  observed_head_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  error_streak integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, repo_id, ref_name)
);

-- 5. Durable tree traversal for one scan generation. A recursive tree that
--    GitHub reports as truncated is discarded and the commit tree is walked
--    one non-recursive tree at a time; each tree is marked done only after
--    its entries and subtrees were stored, so a crash or rate limit resumes
--    exactly there.
CREATE TABLE IF NOT EXISTS github_source_scan_trees (
  tenant_id text NOT NULL,
  repo_id text NOT NULL,
  ref_name text NOT NULL,
  generation integer NOT NULL,
  prefix text NOT NULL,
  tree_sha text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  not_before timestamptz,
  last_error text,
  PRIMARY KEY (tenant_id, repo_id, ref_name, generation, prefix)
);

-- 6. Staged entries of the tree being scanned (blob / symlink / submodule).
--    blob_state: pending | stored | omitted (omit_reason: too_large,
--    fetch_failed, submodule).
CREATE TABLE IF NOT EXISTS github_source_scan_entries (
  tenant_id text NOT NULL,
  repo_id text NOT NULL,
  ref_name text NOT NULL,
  generation integer NOT NULL,
  path text NOT NULL,
  mode text NOT NULL,
  entry_type text NOT NULL,
  blob_sha text NOT NULL,
  size bigint,
  blob_state text NOT NULL DEFAULT 'pending',
  omit_reason text,
  attempts integer NOT NULL DEFAULT 0,
  not_before timestamptz,
  last_error text,
  PRIMARY KEY (tenant_id, repo_id, ref_name, generation, path)
);
CREATE INDEX IF NOT EXISTS idx_github_source_scan_entries_pending
  ON github_source_scan_entries (tenant_id, repo_id, ref_name, generation, blob_state);

-- 7. Current file set of each ref (one row per path ever seen; never reused
--    for another path). state: live | deleted. content_generation is the scan
--    generation in which this path last changed bytes/mode or reappeared - it is
--    the exported sourceVersion.ordinal, so an unchanged file is not re-versioned
--    by later scans. retired_reason hides a live file from the export while its
--    repository/ref is out of scope; omit_reason marks a path whose bytes are not
--    exported (too large, fetch failed, submodule).
CREATE TABLE IF NOT EXISTS github_source_files (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  repo_id text NOT NULL,
  ref_name text NOT NULL,
  path text NOT NULL,
  mode text NOT NULL,
  entry_type text NOT NULL,
  blob_sha text NOT NULL,
  size bigint,
  state text NOT NULL DEFAULT 'live',
  omit_reason text,
  retired_reason text,
  content_generation integer NOT NULL,
  content_commit_sha text NOT NULL,
  first_generation integer NOT NULL,
  deleted_generation integer,
  deleted_commit_sha text,
  delete_reason text,
  renamed_from text,
  renamed_to text,
  path_epoch integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, repo_id, ref_name, path)
);

-- 8. Append-only snapshot ledger: one row per committed scan generation with the
--    resolved commit (raw, post-redaction), tree, counts and the path changes
--    relative to the previous committed generation (capped list + counts).
CREATE TABLE IF NOT EXISTS github_source_snapshots (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  repo_id text NOT NULL,
  ref_name text NOT NULL,
  generation integer NOT NULL,
  previous_generation integer,
  commit_sha text,
  tree_sha text,
  commit_raw jsonb,
  counts jsonb NOT NULL,
  changes jsonb NOT NULL,
  changes_truncated boolean NOT NULL DEFAULT false,
  complete boolean NOT NULL,
  incomplete_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  path_epoch integer NOT NULL DEFAULT 0,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, repo_id, ref_name, generation)
);

-- 9. Exact blob bytes, keyed by git blob SHA-1 (verified against the bytes),
--    as ordered <= 8 MiB chunks (yc_msaw blob limit). Per tenant: no
--    cross-tenant dedupe, so blob existence is never an oracle.
CREATE TABLE IF NOT EXISTS github_source_chunks (
  tenant_id text NOT NULL,
  chunk_sha256 text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_sha256)
);

CREATE TABLE IF NOT EXISTS github_source_blobs (
  tenant_id text NOT NULL,
  blob_sha text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL,
  chunks jsonb NOT NULL,
  is_text boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, blob_sha)
);

-- Journal triggers (drizzle/9000 source_lane_journal_row(tenant col, key col,
-- ignored lifecycle cols...)): sweep bookkeeping columns never re-export.
DROP TRIGGER IF EXISTS trg_source_lane_journal_github_repos ON github_source_repos;
CREATE TRIGGER trg_source_lane_journal_github_repos
  AFTER INSERT OR UPDATE OR DELETE ON github_source_repos
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'last_checked_at', 'updated_at', 'connection_id', 'quota_key');

DROP TRIGGER IF EXISTS trg_source_lane_journal_github_refs ON github_source_refs;
CREATE TRIGGER trg_source_lane_journal_github_refs
  AFTER INSERT OR UPDATE OR DELETE ON github_source_refs
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key',
    'next_generation', 'scan_generation', 'scan_commit_sha', 'scan_tree_sha', 'scan_commit_raw', 'scan_phase', 'scan_started_at', 'scan_reason',
    'scan_incomplete_prefixes', 'observed_head_sha', 'observed_head_at', 'last_success_at', 'last_error', 'last_error_at', 'error_streak', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_github_files ON github_source_files;
CREATE TRIGGER trg_source_lane_journal_github_files
  AFTER INSERT OR UPDATE OR DELETE ON github_source_files
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_github_snapshots ON github_source_snapshots;
CREATE TRIGGER trg_source_lane_journal_github_snapshots
  AFTER INSERT OR UPDATE OR DELETE ON github_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key');
