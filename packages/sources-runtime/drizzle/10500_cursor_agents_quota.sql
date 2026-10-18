-- Cursor background agents: Retry-After cooldowns shared by every connection holding the same API key.
-- Cursor applies its rate limits to the authenticated user, team or organization behind a key
-- (cursor.com/docs/api.md#rate-limits), not to a connection row. With owner scopes, two members may connect one
-- key under two scope tenants, and a single tenant may connect it twice. A 429 seen through any of those
-- connections must hold all of them. The key is the finest identity the v0 API exposes, so cooldowns are keyed by
-- its fingerprint (sha256 prefix, never the key itself), like granola_source_quota.
CREATE TABLE IF NOT EXISTS "cursor_agents_quota" (
  "quota_key" text PRIMARY KEY,
  "blocked_until" timestamptz,
  "last_status" integer,
  "last_retry_after_seconds" integer,
  "rate_limit_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
