-- Bitbucket repository CONTENT source lane (provider range 9350-9399).
--
-- Additive only: no donor table is altered. The donor Nango lanes (records sync,
-- proxy issues, PR details/comments/activity) are unchanged. These tables hold
-- what the Bitbucket Cloud source API (/2.0/repositories/.../src, /diffstat,
-- /refs/branches) returns through the authenticated Nango proxy for every
-- repository the tenant SELECTED: repository metadata, per-branch confirmed
-- scans at an exact commit, the file set of each branch and the exact bytes.
--
-- Every row is scoped by tenant_id (= donor user_id = yc_msaw tenantNs,
-- assigned server-side) and the immutable Bitbucket repository UUID. Nothing
-- here stores a credential, a signed URL or a cookie.

-- 1. Upstream quota coordination keyed by the ACTUAL Bitbucket rate-limit
--    identity: the Bitbucket account behind the grant (GET /user uuid) when
--    known, else the Nango connection. One active content sweep per key across
--    workers and tenants; Retry-After / X-RateLimit-Reset / backoff cooldowns.
CREATE TABLE IF NOT EXISTS bitbucket_source_quota (
  quota_key text PRIMARY KEY,
  blocked_until timestamptz,
  blocked_kind text,
  rate_limit_streak integer NOT NULL DEFAULT 0,
  last_status integer,
  last_retry_after_ms bigint,
  last_reason text,
  rate_limit integer,
  rate_resource text,
  near_limit boolean,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Per tenant connection: resolved account (quota identity) and the outcome
--    of the last sweep through it (blocked grants need a coverage line).
CREATE TABLE IF NOT EXISTS bitbucket_source_connections (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  provider_config_key text NOT NULL,
  account_uuid text,
  quota_key text NOT NULL,
  status text NOT NULL DEFAULT 'unchecked',
  reason text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id)
);

-- 3. Opt-in repository selection (Bitbucket has no donor selection table).
--    repo_key = lower(workspace/slug) as selected; extra_refs = branches
--    captured in addition to the main branch.
CREATE TABLE IF NOT EXISTS bitbucket_source_selection (
  tenant_id text NOT NULL,
  repo_key text NOT NULL,
  full_name text NOT NULL,
  selected boolean NOT NULL DEFAULT true,
  extra_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, repo_key)
);

-- 4. Resolved repositories by immutable UUID. full_name follows renames and
--    transfers. status: active | out_of_scope | inaccessible | not_found
--    (not_found_streak counts consecutive 404s through every grant; the files
--    are tombstoned only once it is confirmed).
CREATE TABLE IF NOT EXISTS bitbucket_source_repos (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  repo_uuid text NOT NULL,
  workspace_uuid text,
  connection_id text NOT NULL,
  provider_config_key text NOT NULL,
  quota_key text NOT NULL,
  full_name text NOT NULL,
  selected_key text NOT NULL,
  main_branch text,
  is_private boolean,
  raw jsonb,
  status text NOT NULL DEFAULT 'active',
  status_reason text,
  not_found_streak integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, repo_uuid)
);

-- export_epoch (refs, files, snapshots) is bumped when the repository is renamed
-- (every path moves) or leaves/re-enters scope, so the journal re-exports rows
-- whose own columns did not change.

-- 5. Branches and their scan generations.
--    next_generation        monotonic counter; every scan takes next_generation + 1,
--                           never reused. It is the exported sourceVersion.ordinal:
--                           ordering never uses commit dates (author-controlled) or
--                           SHAs, so a HEAD rollback A->B->A is three generations.
--    scan_generation        the scan in progress (null = none)
--    committed_generation   the scan whose file set is current; a commit is accepted
--                           only for scan_generation AND only when greater than
--                           committed_generation (late older scans are refused).
--    scan_mode              full  = list every directory page, fetch every file
--                           diff  = /diffstat/<new>..<old> against the committed commit
--    scan_cursor            durable checkpoint of the diffstat page walk (next URL)
--    status: active | retired | not_found | empty | blocked
CREATE TABLE IF NOT EXISTS bitbucket_source_refs (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  repo_uuid text NOT NULL,
  ref_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  status_reason text,
  next_generation integer NOT NULL DEFAULT 0,
  scan_generation integer,
  scan_commit_sha text,
  scan_commit_raw jsonb,
  scan_mode text,
  scan_base_commit_sha text,
  scan_phase text,
  scan_cursor text,
  scan_pages integer NOT NULL DEFAULT 0,
  scan_started_at timestamptz,
  scan_reason text,
  scan_incomplete_prefixes jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_generation integer,
  committed_commit_sha text,
  committed_commit_raw jsonb,
  committed_mode text,
  committed_at timestamptz,
  committed_counts jsonb,
  last_full_at timestamptz,
  observed_head_sha text,
  observed_head_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  error_streak integer NOT NULL DEFAULT 0,
  export_epoch integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, repo_uuid, ref_name)
);

-- 6. Durable directory walk of a full scan: one row per directory, with the
--    page checkpoint (Bitbucket `next` URL) so a crash or rate limit resumes on
--    the exact page. state: pending | done | truncated (listing could not be
--    completed; nothing under it is ever deleted by this scan).
CREATE TABLE IF NOT EXISTS bitbucket_source_scan_dirs (
  tenant_id text NOT NULL,
  repo_uuid text NOT NULL,
  ref_name text NOT NULL,
  generation integer NOT NULL,
  path text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  next_url text,
  pages integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  not_before timestamptz,
  last_error text,
  PRIMARY KEY (tenant_id, repo_uuid, ref_name, generation, path)
);

-- 7. Staged entries of the scan. change: put (file present at the scan commit)
--    | delete (diff mode: removed or renamed away). fetch_state: pending |
--    stored | omitted (omit_reason: too_large, fetch_failed, submodule) | none
--    (deletes). attributes = Bitbucket's (link, executable, binary, lfs,
--    subrepository); meta_known = attributes/size came from a listing or
--    format=meta response.
CREATE TABLE IF NOT EXISTS bitbucket_source_scan_entries (
  tenant_id text NOT NULL,
  repo_uuid text NOT NULL,
  ref_name text NOT NULL,
  generation integer NOT NULL,
  path text NOT NULL,
  change text NOT NULL,
  entry_type text,
  attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
  size bigint,
  meta_known boolean NOT NULL DEFAULT false,
  renamed_from text,
  renamed_to text,
  content_sha256 text,
  fetch_state text NOT NULL DEFAULT 'pending',
  omit_reason text,
  attempts integer NOT NULL DEFAULT 0,
  not_before timestamptz,
  last_error text,
  PRIMARY KEY (tenant_id, repo_uuid, ref_name, generation, path)
);
CREATE INDEX IF NOT EXISTS idx_bitbucket_source_scan_entries_pending
  ON bitbucket_source_scan_entries (tenant_id, repo_uuid, ref_name, generation, fetch_state);

-- 8. Current file set of each branch (one row per path ever seen). state: live |
--    deleted. content_generation = the scan generation in which this path last
--    changed bytes/attributes or reappeared: the exported sourceVersion.ordinal.
--    retired_reason hides a live file while its repository/branch is out of
--    scope; omit_reason marks a path whose bytes are not exported.
CREATE TABLE IF NOT EXISTS bitbucket_source_files (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  repo_uuid text NOT NULL,
  ref_name text NOT NULL,
  path text NOT NULL,
  entry_type text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
  size bigint,
  content_sha256 text,
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
  export_epoch integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, repo_uuid, ref_name, path)
);

-- 9. Append-only snapshot ledger: one row per committed generation with the
--    resolved commit (raw, post-redaction), mode, counts and path changes.
CREATE TABLE IF NOT EXISTS bitbucket_source_snapshots (
  tenant_id text NOT NULL,
  row_key text NOT NULL,
  repo_uuid text NOT NULL,
  ref_name text NOT NULL,
  generation integer NOT NULL,
  previous_generation integer,
  commit_sha text,
  base_commit_sha text,
  mode text,
  commit_raw jsonb,
  counts jsonb NOT NULL,
  changes jsonb NOT NULL,
  changes_truncated boolean NOT NULL DEFAULT false,
  complete boolean NOT NULL,
  incomplete_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  export_epoch integer NOT NULL DEFAULT 0,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key),
  UNIQUE (tenant_id, repo_uuid, ref_name, generation)
);

-- 10. Exact file bytes, content-addressed by sha256 per tenant (no
--     cross-tenant dedupe, so existence is never an oracle), as ordered
--     <= 8 MiB chunks (yc_msaw blob limit).
CREATE TABLE IF NOT EXISTS bitbucket_source_chunks (
  tenant_id text NOT NULL,
  chunk_sha256 text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_sha256)
);

CREATE TABLE IF NOT EXISTS bitbucket_source_blobs (
  tenant_id text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL,
  chunks jsonb NOT NULL,
  is_text boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256)
);

-- Journal triggers (drizzle/9000 source_lane_journal_row(tenant col, key col,
-- ignored lifecycle cols...)): sweep bookkeeping never re-exports.
DROP TRIGGER IF EXISTS trg_source_lane_journal_bitbucket_repos ON bitbucket_source_repos;
CREATE TRIGGER trg_source_lane_journal_bitbucket_repos
  AFTER INSERT OR UPDATE OR DELETE ON bitbucket_source_repos
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key',
    'last_checked_at', 'updated_at', 'connection_id', 'provider_config_key', 'quota_key', 'not_found_streak');

DROP TRIGGER IF EXISTS trg_source_lane_journal_bitbucket_refs ON bitbucket_source_refs;
CREATE TRIGGER trg_source_lane_journal_bitbucket_refs
  AFTER INSERT OR UPDATE OR DELETE ON bitbucket_source_refs
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key',
    'next_generation', 'scan_generation', 'scan_commit_sha', 'scan_commit_raw', 'scan_mode', 'scan_base_commit_sha', 'scan_phase',
    'scan_cursor', 'scan_pages', 'scan_started_at', 'scan_reason', 'scan_incomplete_prefixes', 'observed_head_sha', 'observed_head_at',
    'last_success_at', 'last_error', 'last_error_at', 'error_streak', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_bitbucket_files ON bitbucket_source_files;
CREATE TRIGGER trg_source_lane_journal_bitbucket_files
  AFTER INSERT OR UPDATE OR DELETE ON bitbucket_source_files
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key', 'updated_at');

DROP TRIGGER IF EXISTS trg_source_lane_journal_bitbucket_snapshots ON bitbucket_source_snapshots;
CREATE TRIGGER trg_source_lane_journal_bitbucket_snapshots
  AFTER INSERT OR UPDATE OR DELETE ON bitbucket_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'row_key');
