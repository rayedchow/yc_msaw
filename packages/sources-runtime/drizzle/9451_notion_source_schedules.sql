-- Notion deep sweep schedule for tenants that were already connected when this
-- lane was installed (new connections get it from scheduleNotionIngestion in
-- src/integrations/notion/connect.ts, SOURCE-LANE PATCH). One schedule per
-- tenant; the sweep resolves the tenant's current Notion token itself, so a
-- disconnected tenant makes the run a no-op. Same group key as the donor
-- notion.* tasks, so the worker never runs two Notion tasks of a tenant at once.
INSERT INTO task_schedules (tenant_id, queue, group_key, kind, payload, frequency_seconds, due_at, enabled)
SELECT DISTINCT c.tenant_id, 'sync', c.tenant_id || ':notion', 'notion.source_sweep',
       jsonb_build_object('tenantId', c.tenant_id), 120, now(), true
FROM connections c
WHERE c.provider = 'notion' AND c.status = 'active'
ON CONFLICT (group_key, kind) DO NOTHING;
