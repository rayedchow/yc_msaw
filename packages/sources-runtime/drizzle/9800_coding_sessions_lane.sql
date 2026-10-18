-- Coding sessions (Codex / Claude Code) device lane, ported from gigabrain 5448774
-- brain/src/integrations/coding-sessions/{ingest,commands,auth}.ts (artifact-sync LLM enrichment excluded).
-- Devices hold `gcs_<tenantNs>.<bindingId>.<secret>` keys minted by yc_msaw device bindings; only sha256(key)
-- is stored here and yc_msaw confirms every request. Sessions are exported as files with immutable versions.
CREATE TABLE IF NOT EXISTS "coding_session_devices" (
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "token_sha256" text NOT NULL,
  "label" text,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked')),
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_seen_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  PRIMARY KEY ("tenant_id", "binding_id")
);

CREATE TABLE IF NOT EXISTS "coding_session_commands" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "command_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result" jsonb,
  "error_message" text,
  "requested_by" text,
  "claimed_at" timestamptz,
  "lease_expires_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_coding_session_commands_device" ON "coding_session_commands" ("tenant_id", "binding_id", "status", "created_at");

CREATE TABLE IF NOT EXISTS "coding_sessions" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "provider" text NOT NULL CHECK ("provider" IN ('codex', 'claude')),
  "session_id" text NOT NULL,
  "content_hash" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "payload" jsonb NOT NULL,
  "session_ts" timestamptz NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER "trg_source_lane_journal_coding_sessions"
  AFTER INSERT OR UPDATE OR DELETE ON "coding_sessions"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'updated_at');
