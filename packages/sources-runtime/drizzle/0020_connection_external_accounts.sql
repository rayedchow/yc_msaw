-- Allow multiple accounts/sites for one provider in a tenant while keeping
-- one accountless connection per provider.

DROP INDEX IF EXISTS "uq_connection_tenant_provider";
CREATE UNIQUE INDEX "uq_connection_tenant_provider_external_account"
  ON "connections" ("tenant_id", "provider", COALESCE("external_account_id", ''));
