-- Window ledger for the wiki ingestion agents (architecture_plan/17).
-- Exactly-once event feeding with crash-safe leases, per gigabrain's
-- wiki_ingestion_windows pattern adapted to aqueduct's evidence layer.
CREATE TABLE IF NOT EXISTS wiki_agent_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  kb_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live', 'backfill')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wiki_agent_windows_kb_status ON wiki_agent_windows (kb_id, status);

CREATE TABLE IF NOT EXISTS wiki_agent_window_events (
  window_id uuid NOT NULL REFERENCES wiki_agent_windows (id) ON DELETE CASCADE,
  kb_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('fact', 'document')),
  event_id uuid NOT NULL,
  event_at timestamptz,
  PRIMARY KEY (window_id, event_kind, event_id)
);
-- Exactly-once: an event may appear in at most one window per KB.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wiki_agent_event_once ON wiki_agent_window_events (kb_id, event_kind, event_id);
