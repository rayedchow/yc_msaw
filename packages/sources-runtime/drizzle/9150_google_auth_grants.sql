-- Google provider grants for the source lane (google-auth agent, range 9150-9159).
--
-- Google data access runs in exactly one explicit mode per (tenant, account):
--   * domain-wide delegation (DWD): no row here; the mailbox is a `connections`
--     row (metadata.authMode = 'domain_wide_delegation') and must be inside the
--     operator-approved tenant allowlist (GOOGLE_DWD_TENANT_APPROVALS).
--   * oauth_direct: per-user 3-legged Google OAuth (PKCE + OIDC nonce). Tokens are
--     AES-256-GCM encrypted with additional authenticated data bound to
--     (tenant, account, field), so a ciphertext copied to another row fails to decrypt.
--   * composio_proxy: per-user OAuth held by Composio; no bearer token is stored or
--     handed to callers, only the server-verified connected account id.
-- A connection never silently falls back to another mode.

-- One row per authorization attempt. The raw state value is never stored, only its
-- sha256. Consumption is a single UPDATE ... WHERE consumed_at IS NULL AND
-- expires_at > now(), so a state is usable at most once and only before expiry.
CREATE TABLE IF NOT EXISTS google_oauth_states (
  state_sha256 text PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_subject text NOT NULL,
  principal_issuer text NOT NULL,
  principal_email text,
  mode text NOT NULL CHECK (mode IN ('oauth_direct', 'composio_proxy')),
  capabilities text[] NOT NULL DEFAULT '{}',
  requested_scopes text[] NOT NULL DEFAULT '{}',
  expected_email text,
  expected_account_source text NOT NULL CHECK (expected_account_source IN ('principal', 'admin_specified', 'any')),
  pkce_verifier_ciphertext text,
  oidc_nonce_sha256 text,
  redirect_uri text NOT NULL,
  browser_binding_sha256 text,
  launched_at timestamptz,
  composio_connected_account_id text,
  composio_user_id text,
  composio_toolkit text,
  -- Composio Connect Link redirect (contains a short-lived link token); cleared on launch.
  composio_redirect_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  outcome text
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_states_tenant_created
  ON google_oauth_states (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_google_oauth_states_expires
  ON google_oauth_states (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS google_oauth_grants (
  tenant_id text NOT NULL,
  account_email text NOT NULL CHECK (account_email = lower(account_email) AND account_email <> ''),
  google_sub text,
  hosted_domain text,
  mode text NOT NULL CHECK (mode IN ('oauth_direct', 'composio_proxy')),
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_ciphertext text,
  refresh_token_expires_at timestamptz,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  composio_connected_account_id text,
  composio_user_id text,
  composio_toolkit text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required', 'revoked')),
  reauth_reason text,
  reauth_at timestamptz,
  connected_by_subject text NOT NULL,
  connected_by_issuer text NOT NULL,
  token_version bigint NOT NULL DEFAULT 1,
  last_refresh_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_email),
  CHECK (mode <> 'oauth_direct' OR status <> 'active' OR refresh_token_ciphertext IS NOT NULL OR access_token_ciphertext IS NOT NULL),
  CHECK (mode <> 'composio_proxy' OR composio_connected_account_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_oauth_grants_tenant_sub
  ON google_oauth_grants (tenant_id, google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_oauth_grants_composio_account
  ON google_oauth_grants (composio_connected_account_id) WHERE composio_connected_account_id IS NOT NULL;
