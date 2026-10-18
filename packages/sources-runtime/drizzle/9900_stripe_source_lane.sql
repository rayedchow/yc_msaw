-- Stripe source lane (ported from gigabrain 5448774 brain/src/integrations/stripe/*, adapted):
-- per-tenant connections with encrypted credentials and a per-connection webhook URL (the tenant is never
-- read from an event body), durable cursors for the events backfill/poll and per-resource object listings,
-- and current object snapshots exported as files. Raw events stay in activity_events (event.id dedupe).
CREATE TABLE IF NOT EXISTS "stripe_connections" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "account_id" text NOT NULL,
  "account_verified" boolean NOT NULL DEFAULT false,
  "livemode" boolean NOT NULL,
  "label" text,
  "api_key_ciphertext" text NOT NULL,
  "key_kind" text NOT NULL CHECK ("key_kind" IN ('restricted', 'secret')),
  "webhook_secret_ciphertext" text,
  "webhook_secret_previous_ciphertext" text,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked', 'error')),
  "status_reason" text,
  "last_webhook_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "idx_stripe_connections_tenant" ON "stripe_connections" ("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "stripe_cursors" (
  "connection_id" text NOT NULL REFERENCES "stripe_connections" ("id") ON DELETE CASCADE,
  "lane" text NOT NULL,
  "tenant_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'running', 'complete', 'error', 'blocked')),
  "state" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_success_at" timestamptz,
  "completed_at" timestamptz,
  "retry_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "lease_owner" text,
  "lease_until" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("connection_id", "lane")
);

CREATE TABLE IF NOT EXISTS "stripe_object_snapshots" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "connection_id" text NOT NULL REFERENCES "stripe_connections" ("id") ON DELETE CASCADE,
  "account_id" text NOT NULL,
  "livemode" boolean NOT NULL,
  "resource" text NOT NULL,
  "object_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_sha256" text NOT NULL,
  -- Stripe-side ordering of the captured state (unix seconds: event.created, or the listing request time).
  "source_order" bigint NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "deleted" boolean NOT NULL DEFAULT false,
  "deleted_reason" text,
  "last_seen_run" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_stripe_object_snapshots_object" ON "stripe_object_snapshots" ("connection_id", "resource", "object_id");

CREATE TRIGGER "trg_source_lane_journal_stripe_object_snapshots"
  AFTER INSERT OR UPDATE OR DELETE ON "stripe_object_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'last_seen_run', 'updated_at');
