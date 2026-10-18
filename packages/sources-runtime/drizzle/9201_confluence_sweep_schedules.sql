-- Confluence deep sweep schedule for tenants that were already connected when
-- this lane was installed (new connections get it from startNangoPolling, see
-- AUDIT/implementation/patch-requests/confluence.md). One schedule per tenant;
-- the sweep itself enumerates the tenant's active connections and sites, so a
-- revoked connection makes the run a no-op.
INSERT INTO task_schedules (tenant_id, queue, group_key, kind, payload, frequency_seconds, due_at, enabled)
SELECT DISTINCT c.tenant_id, 'sync', c.tenant_id || ':confluence:sweep', 'confluence.sweep',
       jsonb_build_object('tenantId', c.tenant_id), 300, now(), true
FROM connections c
WHERE c.provider = 'confluence' AND c.status = 'active'
ON CONFLICT (group_key, kind) DO NOTHING;
