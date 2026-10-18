-- Discord source lane over the official bot API (semantic reference: gigabrain 5448774
-- brain/src/integrations/discord-personal/*; that donor's user/selfbot tokens are NOT supported).
-- Per-tenant bot connections (encrypted token), an explicit channel allowlist with durable per-channel
-- cursors, and current message state exported as files. Every observed message version and deletion is also
-- kept raw in activity_events (source 'discord').
CREATE TABLE IF NOT EXISTS "discord_connections" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "bot_user_id" text NOT NULL,
  "bot_username" text,
  "application_id" text,
  "bot_token_ciphertext" text NOT NULL,
  -- From GET /applications/@me flags: enabled (GATEWAY_MESSAGE_CONTENT), limited, disabled, unknown.
  "message_content_intent" text NOT NULL DEFAULT 'unknown' CHECK ("message_content_intent" IN ('enabled', 'limited', 'disabled', 'unknown')),
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked', 'error')),
  "status_reason" text,
  "retry_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "idx_discord_connections_tenant" ON "discord_connections" ("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "discord_channels" (
  "connection_id" text NOT NULL REFERENCES "discord_connections" ("id") ON DELETE CASCADE,
  "channel_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "guild_id" text NOT NULL,
  "name" text,
  "type" integer,
  "selected" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'blocked', 'removed')),
  "status_reason" text,
  -- Backfill walks newest -> oldest with `before`; complete when Discord returns an empty page.
  "backfill_before" text,
  "backfill_complete_at" timestamptz,
  -- Forward polling with `after` from the newest id ever stored.
  "newest_id" text,
  "last_poll_at" timestamptz,
  "last_reconcile_at" timestamptz,
  "retry_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "lease_owner" text,
  "lease_until" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("connection_id", "channel_id")
);

CREATE TABLE IF NOT EXISTS "discord_messages" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "connection_id" text NOT NULL REFERENCES "discord_connections" ("id") ON DELETE CASCADE,
  "guild_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "message_id" text NOT NULL,
  "message_ts" timestamptz NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_sha256" text NOT NULL,
  "edited_timestamp" timestamptz,
  "observed_at" timestamptz NOT NULL,
  "deleted" boolean NOT NULL DEFAULT false,
  "deleted_reason" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_discord_messages_channel" ON "discord_messages" ("connection_id", "channel_id", "message_ts");

CREATE TRIGGER "trg_source_lane_journal_discord_messages"
  AFTER INSERT OR UPDATE OR DELETE ON "discord_messages"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'updated_at');
