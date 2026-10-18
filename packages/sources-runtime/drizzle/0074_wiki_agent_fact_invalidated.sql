-- Event-stream parity with gigabrain (spec 17): mutations must re-enter the
-- stream. fact_invalidated feeds a fact's retraction exactly once, so the
-- ingestion agent learns to remove/correct stale wiki claims.
ALTER TABLE "wiki_agent_window_events"
  DROP CONSTRAINT IF EXISTS "wiki_agent_window_events_event_kind_check";
ALTER TABLE "wiki_agent_window_events"
  ADD CONSTRAINT "wiki_agent_window_events_event_kind_check"
  CHECK (event_kind IN ('fact', 'document', 'fact_invalidated'));
