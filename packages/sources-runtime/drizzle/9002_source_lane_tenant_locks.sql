-- Per-tenant export lease with a fencing counter: one exporter maps, publishes and keeps
-- path bookkeeping for a tenant at a time. A holder whose lease lapsed loses the fence and
-- can no longer acknowledge, release or record anything for that tenant.
CREATE TABLE "source_lane_tenant_locks" (
  "tenant_id" text PRIMARY KEY,
  "owner" text NOT NULL,
  "fence" bigint NOT NULL,
  "lease_until" timestamptz NOT NULL,
  "acquired_at" timestamptz NOT NULL DEFAULT now()
);
