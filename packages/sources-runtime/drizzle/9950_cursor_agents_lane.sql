-- Cursor background agents source lane (read-only port of gigabrain 9411c1a362fffb7e5a778080d991082810da2510
-- brain/src/{polling,webhooks}/cursor-background-agents.ts). Per-tenant connections (encrypted API key and
-- webhook secret), a resumable listing cursor, and current agent + conversation snapshots exported as files.
-- Raw versions stay in activity_events (source 'cursor_background_agents').
CREATE TABLE IF NOT EXISTS "cursor_agents_connections" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "api_base" text NOT NULL,
  "api_key_ciphertext" text NOT NULL,
  "webhook_secret_ciphertext" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked', 'error')),
  "status_reason" text,
  "list_cursor" text,
  "list_run" text,
  "last_complete_listing_at" timestamptz,
  "last_poll_at" timestamptz,
  "last_webhook_at" timestamptz,
  "retry_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "lease_owner" text,
  "lease_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "idx_cursor_agents_connections_tenant" ON "cursor_agents_connections" ("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "cursor_agents_snapshots" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "connection_id" text NOT NULL REFERENCES "cursor_agents_connections" ("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL,
  "status" text,
  "agent_payload" jsonb NOT NULL,
  "agent_sha256" text NOT NULL,
  "conversation_payload" jsonb,
  "conversation_sha256" text,
  "conversation_state" text NOT NULL DEFAULT 'pending' CHECK ("conversation_state" IN ('pending', 'stored', 'error')),
  "conversation_error" text,
  "created_at_provider" timestamptz,
  "observed_at" timestamptz NOT NULL,
  "deleted" boolean NOT NULL DEFAULT false,
  "deleted_reason" text,
  "last_seen_run" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER "trg_source_lane_journal_cursor_agents_snapshots"
  AFTER INSERT OR UPDATE OR DELETE ON "cursor_agents_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'last_seen_run', 'updated_at');
