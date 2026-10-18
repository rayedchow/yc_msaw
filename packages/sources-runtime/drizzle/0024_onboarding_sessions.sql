CREATE TABLE "auth_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "return_to" text,
  "state" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "workos_user" jsonb,
  "workos_organization" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "authenticated_at" timestamptz,
  "consumed_at" timestamptz,
  CONSTRAINT "ck_auth_session_status" CHECK ("status" IN ('pending', 'authenticated', 'consumed', 'failed'))
);
CREATE UNIQUE INDEX "uq_auth_session_state" ON "auth_sessions" ("state");
CREATE INDEX "idx_auth_session_status_created" ON "auth_sessions" ("status", "created_at");

CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "workos_user_id" text NOT NULL,
  "workos_organization_id" text NOT NULL,
  "email" text NOT NULL,
  "name" text NOT NULL,
  "organization_name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX "idx_sessions_tenant" ON "sessions" ("tenant_id");
CREATE INDEX "idx_sessions_expires" ON "sessions" ("expires_at");
