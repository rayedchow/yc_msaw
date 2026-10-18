-- Google Docs / Drive source lane (provider range 9100-9149).
--
-- Additive only: no donor table is altered. Everything is tenant-scoped by
-- tenant_id (= donor user_id = yc_msaw tenantNs, assigned server-side).
--
-- 1. Content-addressed byte storage. Files of any size are stored as ordered
--    8 MiB chunks (the same chunking the yc_msaw SourceStore uses), so the
--    exporter can upload chunk blobs by sha without re-reading providers.
--    Bytes are exact (no text coercion, no truncation at write).
CREATE TABLE IF NOT EXISTS gdocs_source_chunks (
  tenant_id text NOT NULL,
  chunk_sha256 text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_sha256)
);

CREATE TABLE IF NOT EXISTS gdocs_source_blobs (
  tenant_id text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  chunks jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256)
);

-- 2. Append-only file versions: one row per (tenant, path, seq). The exporter
--    publishes every row in id order, so intermediate versions (image bytes,
--    native JSON, changelog status) survive even when the exporter lags.
CREATE TABLE IF NOT EXISTS gdocs_source_file_versions (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  path text NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  op text NOT NULL CHECK (op IN ('put', 'delete')),
  kind text NOT NULL CHECK (kind IN ('projection', 'raw', 'binary', 'tombstone')),
  content_type text,
  sha256 text,
  size bigint,
  chunks jsonb,
  file_id text NOT NULL,
  source_version text,
  source_order bigint,
  source_updated_at timestamptz,
  captured_at timestamptz NOT NULL,
  deleted_reason text,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, path, seq),
  CHECK ((op = 'put' AND sha256 IS NOT NULL AND size IS NOT NULL AND chunks IS NOT NULL) OR (op = 'delete'))
);

CREATE INDEX IF NOT EXISTS idx_gdocs_source_file_versions_file
  ON gdocs_source_file_versions (tenant_id, file_id, id);

-- Current head per path: the version guard. A write is applied only when the
-- incoming source_order is not older than the head (out-of-order polls are
-- `stale`) and the content/op actually differs (repeat polls are `unchanged`).
CREATE TABLE IF NOT EXISTS gdocs_source_file_heads (
  tenant_id text NOT NULL,
  path text NOT NULL,
  file_id text NOT NULL,
  seq integer NOT NULL,
  op text NOT NULL CHECK (op IN ('put', 'delete')),
  sha256 text,
  source_version text,
  source_order bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, path)
);

CREATE INDEX IF NOT EXISTS idx_gdocs_source_file_heads_file
  ON gdocs_source_file_heads (tenant_id, file_id);

-- 3. Durable per-file checkpoints: Drive version seen, content export state,
--    changelog (OT history) completeness, and the deletion lifecycle that
--    fixes the donor's one-tombstone-per-kind gap (re-trash, restore).
CREATE TABLE IF NOT EXISTS gdocs_file_checkpoints (
  tenant_id text NOT NULL,
  file_id text NOT NULL,
  mailbox text,
  mime_type text,
  name text,
  parents jsonb,
  export_directory text,
  drive_version text,
  drive_modified_at timestamptz,
  drive_seen_at timestamptz,

  content_state text NOT NULL DEFAULT 'pending'
    CHECK (content_state IN ('pending', 'complete', 'partial', 'blocked', 'error', 'unsupported')),
  content_reason text,
  content_version text,
  content_exported_at timestamptz,
  content_retry_at timestamptz,
  content_attempts integer NOT NULL DEFAULT 0,

  history_state text NOT NULL DEFAULT 'pending'
    CHECK (history_state IN ('pending', 'complete', 'partial', 'blocked', 'error', 'not_applicable')),
  history_reason text,
  history_complete_entries integer NOT NULL DEFAULT 0,
  history_complete_at timestamptz,
  history_fetched_entries integer,
  history_attempted_at timestamptz,
  history_retry_at timestamptz,
  history_attempts integer NOT NULL DEFAULT 0,

  lifecycle_state text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'trashed', 'removed')),
  lifecycle_kind text,
  lifecycle_generation integer NOT NULL DEFAULT 0,
  lifecycle_changed_at timestamptz,
  rematerialize_pending boolean NOT NULL DEFAULT false,

  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_gdocs_file_checkpoints_content_retry
  ON gdocs_file_checkpoints (tenant_id, content_retry_at)
  WHERE content_state IN ('pending', 'partial', 'error');

CREATE INDEX IF NOT EXISTS idx_gdocs_file_checkpoints_history_retry
  ON gdocs_file_checkpoints (tenant_id, history_retry_at)
  WHERE history_state IN ('pending', 'partial', 'error');

-- 4. Export journal (core 9000 `source_lane_journal_row`): every appended
--    version is journaled in the writer's transaction; the provider module's
--    extraTables mapper turns version rows into put/delete changes.
CREATE TRIGGER trg_source_lane_journal_gdocs_source_file_versions
  AFTER INSERT OR UPDATE OR DELETE ON gdocs_source_file_versions
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'id');
