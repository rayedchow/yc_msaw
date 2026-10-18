-- Generic Nango records lane (nango-expansion agent, range 9650-9699).
--
-- Operational state only: captured records go to the donor raw ledger
-- (activity_events), which the core exporter already journals. Nothing here is
-- exported as source content, so no journal triggers are installed.
--
-- Authority model:
--   * A Nango connection belongs to exactly one tenant. The mapping is created
--     only by consuming a connect session this server created for a verified
--     yc_msaw principal (signed auth webhook or authenticated Nango list call),
--     never from a tenant in a webhook body, query or client request.
--   * A session is usable once and only before expiry (+ webhook delivery grace).

CREATE TABLE IF NOT EXISTS nango_records_connect_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Random correlation tag sent to Nango as tags.procmem_session; Nango copies it
  -- onto the created connection and into auth webhooks.
  session_tag text NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  principal_subject text NOT NULL,
  principal_issuer text NOT NULL,
  source text NOT NULL,
  provider_config_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  connection_id text,
  -- pending | connected | expired | refused
  outcome text NOT NULL DEFAULT 'pending',
  last_error text,
  last_checked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_nango_records_sessions_tenant
  ON nango_records_connect_sessions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nango_records_sessions_open
  ON nango_records_connect_sessions (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS nango_records_connections (
  provider_config_key text NOT NULL,
  connection_id text NOT NULL,
  tenant_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'error', 'revoked')),
  session_id uuid REFERENCES nango_records_connect_sessions (id) ON DELETE SET NULL,
  nango_provider text,
  auth_mode text,
  last_error text,
  -- When Nango created the connection (from GET /connections), when known.
  remote_created_at timestamptz,
  -- 'webhook' (signed auth webhook) or 'reconcile' (authenticated tag lookup).
  bound_via text NOT NULL,
  last_auth_event_at timestamptz,
  -- Last authenticated GET /connections?connectionId= health check.
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Globally unique: a second tenant can never claim an existing connection.
  PRIMARY KEY (provider_config_key, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_nango_records_connections_tenant
  ON nango_records_connections (tenant_id, source, status);

-- Durable /records checkpoint per (connection x model). The cursor only ever
-- advances after every record of the page it came from was committed.
CREATE TABLE IF NOT EXISTS nango_records_checkpoints (
  tenant_id text NOT NULL,
  provider_config_key text NOT NULL,
  connection_id text NOT NULL,
  model text NOT NULL,
  cursor text,
  -- Highest _nango_metadata.last_modified_at committed; used (minus a safety
  -- window) as modified_after when Nango rejects a stored cursor.
  high_water_modified_at timestamptz,
  modified_after_fallback timestamptz,
  full_pass_started_at timestamptz,
  full_pass_completed_at timestamptz,
  caught_up_at timestamptz,
  backlog boolean NOT NULL DEFAULT false,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  last_sync_webhook_error text,
  last_sync_webhook_error_at timestamptz,
  pages_total bigint NOT NULL DEFAULT 0,
  records_total bigint NOT NULL DEFAULT 0,
  stored_total bigint NOT NULL DEFAULT 0,
  tombstones_total bigint NOT NULL DEFAULT 0,
  pruned_skipped_total bigint NOT NULL DEFAULT 0,
  cursor_resets integer NOT NULL DEFAULT 0,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_config_key, connection_id, model)
);

-- Rate-limit state per actual quota identity (the Nango account behind the API
-- key; never multiplied by tenant or connection).
CREATE TABLE IF NOT EXISTS nango_records_quota (
  quota_key text PRIMARY KEY,
  blocked_until timestamptz,
  next_allowed_at timestamptz,
  last_status integer,
  last_retry_after_ms integer,
  last_limit integer,
  last_remaining integer,
  last_reset_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Concurrency leases (e.g. at most N concurrent record syncs per Nango integration).
CREATE TABLE IF NOT EXISTS nango_records_slots (
  quota_key text NOT NULL,
  slot integer NOT NULL,
  holder text,
  lease_until timestamptz,
  PRIMARY KEY (quota_key, slot)
);

-- Signed webhook deliveries already processed (sha256 of the raw body). Nango
-- sends no timestamp/nonce, so exact replays are recognised by body digest.
CREATE TABLE IF NOT EXISTS nango_records_webhook_deliveries (
  body_sha256 text PRIMARY KEY,
  webhook_type text,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nango_records_webhook_received
  ON nango_records_webhook_deliveries (received_at);

-- What the Nango environment actually deploys (GET /integrations/{key}/functions?type=sync).
-- checked_at is NULL until the first successful check; claimed_until is a short
-- lease so only one worker re-verifies an integration at a time.
CREATE TABLE IF NOT EXISTS nango_records_verification (
  provider_config_key text PRIMARY KEY,
  checked_at timestamptz,
  claimed_until timestamptz,
  integration_found boolean,
  error text,
  error_at timestamptz
);

-- One row per (integration, model, deployed sync function returning it).
CREATE TABLE IF NOT EXISTS nango_records_capabilities (
  provider_config_key text NOT NULL,
  model text NOT NULL,
  sync_name text NOT NULL,
  enabled boolean NOT NULL,
  track_deletes boolean,
  runs text,
  last_deployed timestamptz,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (provider_config_key, model, sync_name)
);

-- Models Nango reported (signed sync webhooks, deployed functions) that the
-- operator has not enabled; surfaced as pending coverage, never silently dropped.
CREATE TABLE IF NOT EXISTS nango_records_unconfigured_models (
  provider_config_key text NOT NULL,
  model text NOT NULL,
  tenant_id text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (provider_config_key, model, tenant_id)
);

CREATE TABLE IF NOT EXISTS nango_records_tenant_state (
  tenant_id text PRIMARY KEY,
  last_poll_at timestamptz,
  last_poll_error text,
  last_poll_error_at timestamptz
);
