-- GitHub repository content sweep schedule for tenants that were already
-- connected when this lane was installed (new connections get it from
-- startNangoPolling, see AUDIT/implementation/patch-requests/github.md). One
-- schedule per tenant; the sweep enumerates the tenant's active GitHub
-- connections and SELECTED repositories, so an unselected repo or a revoked
-- connection makes the run a no-op.
INSERT INTO task_schedules (tenant_id, queue, group_key, kind, payload, frequency_seconds, due_at, enabled)
SELECT DISTINCT c.tenant_id, 'sync', c.tenant_id || ':github:content', 'github.content_sweep',
       jsonb_build_object('tenantId', c.tenant_id), 300, now(), true
FROM connections c
WHERE c.provider = 'github' AND c.status = 'active'
ON CONFLICT (group_key, kind) DO NOTHING;
