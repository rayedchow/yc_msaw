-- Linear source lane (port of gigabrain f74c62ca8db7911c819c174bab9a2a34a2a52fc1 origin/codex/linear-connector).
-- Per-tenant encrypted API key + per-connection webhook secret, durable per-resource polling cursors, and the
-- current state of issues / comments / projects / cycles exported as files. Raw snapshots (donor ids
-- `linear:<type>:<id>:updated:<updatedAt>`) and signed deliveries (`linear:webhook:<Linear-Delivery>`) stay in
-- activity_events.
CREATE TABLE IF NOT EXISTS "linear_connections" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "organization_key" text,
  "viewer_id" text,
  "api_key_ciphertext" text NOT NULL,
  "webhook_secret_ciphertext" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked', 'error')),
  "status_reason" text,
  "retry_at" timestamptz,
  "last_webhook_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "idx_linear_connections_tenant" ON "linear_connections" ("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "linear_cursors" (
  "connection_id" text NOT NULL REFERENCES "linear_connections" ("id") ON DELETE CASCADE,
  "resource" text NOT NULL CHECK ("resource" IN ('issue', 'comment', 'project', 'cycle')),
  "tenant_id" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'full' CHECK ("mode" IN ('full', 'delta')),
  "after_cursor" text,
  "run_id" text,
  "watermark" timestamptz,
  "pass_max_updated" timestamptz,
  "last_full_at" timestamptz,
  "last_success_at" timestamptz,
  "status" text NOT NULL DEFAULT 'pending',
  "retry_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "lease_owner" text,
  "lease_until" timestamptz,
  PRIMARY KEY ("connection_id", "resource")
);

CREATE TABLE IF NOT EXISTS "linear_objects" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "connection_id" text NOT NULL REFERENCES "linear_connections" ("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "resource" text NOT NULL,
  "object_id" text NOT NULL,
  "label" text,
  "payload" jsonb NOT NULL,
  "provider_updated_at" timestamptz,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  "deleted" boolean NOT NULL DEFAULT false,
  "deleted_reason" text,
  "last_seen_run" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER "trg_source_lane_journal_linear_objects"
  AFTER INSERT OR UPDATE OR DELETE ON "linear_objects"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'last_seen_run', 'updated_at');
