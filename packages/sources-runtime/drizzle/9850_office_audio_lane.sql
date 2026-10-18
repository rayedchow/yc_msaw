-- Office audio (room transcript) device lane, ported from gigabrain 5448774 brain/src/integrations/office-audio
-- (deterministic transcript intake only: no audio, no STT, no voice profiling, no graph/LLM). Devices hold
-- `goa_<tenantNs>.<bindingId>.<secret>` keys minted by yc_msaw (sha256 only here; yc_msaw confirms each request).
-- Participant consent is SERVER-issued by an authorized actor; consents asserted in the upload body are kept
-- only as the device's claim and never authorize storage.
CREATE TABLE IF NOT EXISTS "office_audio_devices" (
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "token_sha256" text NOT NULL,
  "label" text,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked')),
  "last_seen_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  PRIMARY KEY ("tenant_id", "binding_id")
);

CREATE TABLE IF NOT EXISTS "office_audio_participant_consents" (
  "tenant_id" text NOT NULL,
  "participant_key" text NOT NULL,
  "display_name" text,
  "granted_by_subject" text NOT NULL,
  "granted_by_issuer" text,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "revoked_by_subject" text,
  PRIMARY KEY ("tenant_id", "participant_key")
);

CREATE TABLE IF NOT EXISTS "office_audio_sessions" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "source_session_id" text NOT NULL,
  "content_hash" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "participant_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "payload" jsonb NOT NULL,
  "started_at" timestamptz NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  "deleted" boolean NOT NULL DEFAULT false,
  "deleted_reason" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "office_audio_rejections" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "source_session_id" text,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER "trg_source_lane_journal_office_audio_sessions"
  AFTER INSERT OR UPDATE OR DELETE ON "office_audio_sessions"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'updated_at');
