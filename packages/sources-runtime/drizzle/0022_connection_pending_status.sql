ALTER TABLE "connections" DROP CONSTRAINT IF EXISTS "ck_connection_status";

ALTER TABLE "connections"
  ADD CONSTRAINT "ck_connection_status"
  CHECK ("status" IN ('pending', 'active', 'paused', 'revoked', 'error'));
