-- Entity merges enter the wiki-agent event stream: facts get repointed on
-- merge with no new fact rows, so without this the ingestion agent never
-- learns two wiki pages should become one (spec 17 stream parity).
ALTER TABLE "wiki_agent_window_events"
  DROP CONSTRAINT IF EXISTS "wiki_agent_window_events_event_kind_check";
ALTER TABLE "wiki_agent_window_events"
  ADD CONSTRAINT "wiki_agent_window_events_event_kind_check"
  CHECK (event_kind IN ('fact', 'document', 'fact_invalidated', 'entity_merged'));
