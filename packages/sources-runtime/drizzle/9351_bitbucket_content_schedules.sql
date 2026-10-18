-- Bitbucket repository content sweep schedule for tenants that were already
-- connected when this lane was installed (new connections get it from
-- startNangoPolling, see AUDIT/implementation/patch-requests/bitbucket.md). One
-- schedule per tenant in its own group, so a long sweep never blocks the 60 s
-- nango.poll floor. The sweep enumerates the tenant's active Bitbucket
-- connections and SELECTED repositories; with none it is a no-op.
INSERT INTO task_schedules (tenant_id, queue, group_key, kind, payload, frequency_seconds, due_at, enabled)
SELECT DISTINCT c.tenant_id, 'sync', c.tenant_id || ':bitbucket:content', 'bitbucket.content_sweep',
       jsonb_build_object('tenantId', c.tenant_id), 300, now(), true
FROM connections c
WHERE c.provider = 'bitbucket' AND c.status = 'active'
ON CONFLICT (group_key, kind) DO NOTHING;
