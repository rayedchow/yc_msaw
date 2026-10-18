-- WhatsApp (personal) source lane over Unipile (ported from gigabrain 5448774 brain/src/integrations/whatsapp-personal/*, adapted).
-- Read-only and operator opt-in: Unipile automates the personal account through unofficial clients, which
-- carries Terms of Service risk (gigabrain policy research 0a92129868), and coverage says so. The tenant is
-- bound by a per-connection webhook URL and secret, never resolved from a payload account id alone.
CREATE TABLE IF NOT EXISTS "whatsapp_personal_connections" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "account_id" text NOT NULL,
  "account_user_id" text,
  "display_name" text,
  "api_base" text NOT NULL,
  "api_key_ciphertext" text NOT NULL,
  "webhook_secret_sha256" text NOT NULL,
  "sync_mode" text NOT NULL DEFAULT 'all_accessible' CHECK ("sync_mode" IN ('all_accessible', 'selected_conversations')),
  "selected_chat_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source_status" text NOT NULL DEFAULT 'UNKNOWN',
  "initial_sync_status" text,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked', 'error')),
  "status_reason" text,
  "last_webhook_at" timestamptz,
  "last_poll_at" timestamptz,
  "retry_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "lease_owner" text,
  "lease_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "idx_whatsapp_personal_connections_tenant" ON "whatsapp_personal_connections" ("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "whatsapp_personal_chats" (
  "connection_id" text NOT NULL REFERENCES "whatsapp_personal_connections" ("id") ON DELETE CASCADE,
  "chat_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "name" text,
  "conversation_type" text,
  "backfill_cursor" text,
  "backfill_complete_at" timestamptz,
  "newest_message_id" text,
  "newest_message_at" timestamptz,
  "last_error" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("connection_id", "chat_id")
);

CREATE TABLE IF NOT EXISTS "whatsapp_personal_messages" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "connection_id" text NOT NULL REFERENCES "whatsapp_personal_connections" ("id") ON DELETE CASCADE,
  "account_id" text NOT NULL,
  "chat_id" text NOT NULL,
  "message_id" text NOT NULL,
  "message_ts" timestamptz NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_sha256" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "deleted" boolean NOT NULL DEFAULT false,
  "deleted_reason" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "whatsapp_personal_attachments" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "connection_id" text NOT NULL REFERENCES "whatsapp_personal_connections" ("id") ON DELETE CASCADE,
  "account_id" text NOT NULL,
  "chat_id" text NOT NULL,
  "message_id" text NOT NULL,
  "attachment_id" text NOT NULL,
  "content_type" text,
  "size" integer,
  "sha256" text,
  "bytes" bytea,
  "state" text NOT NULL CHECK ("state" IN ('stored', 'too_large', 'unavailable', 'error')),
  "reason" text,
  "observed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER "trg_source_lane_journal_whatsapp_personal_messages"
  AFTER INSERT OR UPDATE OR DELETE ON "whatsapp_personal_messages"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'updated_at');

CREATE TRIGGER "trg_source_lane_journal_whatsapp_personal_attachments"
  AFTER INSERT OR UPDATE OR DELETE ON "whatsapp_personal_attachments"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id');
