-- Mutable documents re-enter the wiki-agent stream once per content version.
ALTER TABLE "wiki_agent_window_events"
  DROP CONSTRAINT IF EXISTS "wiki_agent_window_events_event_kind_check";
ALTER TABLE "wiki_agent_window_events"
  ADD CONSTRAINT "wiki_agent_window_events_event_kind_check"
  CHECK (event_kind IN ('fact', 'document', 'fact_invalidated', 'entity_merged', 'document_updated'));

-- Already-fed documents start with their current version consumed so a deploy
-- does not replay history. The original window keeps the foreign key valid.
INSERT INTO wiki_agent_window_events (window_id, kb_id, event_kind, event_id, event_at)
SELECT fed.window_id, fed.kb_id, 'document_updated',
       md5(d.id::text || COALESCE(d.content_sha, ''))::uuid,
       COALESCE(d.source_updated_at, d.ingested_at)
FROM wiki_agent_window_events fed
JOIN source_documents d ON d.id = fed.event_id
WHERE fed.event_kind = 'document'
ON CONFLICT DO NOTHING;
