-- Unipile personal connectors (WhatsApp / Instagram): account linking through Unipile hosted auth.
-- A Unipile API key is a workspace credential that reads every account linked in that workspace, so a key plus an
-- account id does not prove whose account it is. A member starts a single-use, expiring link bound to their own
-- (owner-scope) tenant; only Unipile's notify callback for that link, carrying the secret `name` the runtime gave
-- Unipile (stored here as sha256 only), attaches the newly linked account to that tenant.
CREATE TABLE IF NOT EXISTS "unipile_personal_hosted_links" (
  "id" text PRIMARY KEY,
  "provider" text NOT NULL CHECK ("provider" IN ('whatsapp_personal', 'instagram_personal')),
  "tenant_id" text NOT NULL,
  "connection_id" text NOT NULL UNIQUE,
  "name_sha256" text NOT NULL,
  "api_base" text NOT NULL,
  "api_key_ciphertext" text NOT NULL,
  "webhook_secret_sha256" text NOT NULL,
  "selected_chat_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'connected', 'failed')),
  "failure" text,
  "account_id" text,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_unipile_personal_hosted_links_tenant" ON "unipile_personal_hosted_links" ("tenant_id", "provider", "created_at");
