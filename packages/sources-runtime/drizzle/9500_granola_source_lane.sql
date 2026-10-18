-- Granola source lane (provider range 9500-9549).
--
-- Additive only: no donor table or column is altered. The donor lane
-- (src/integrations/granola: granola.poll / granola.backfill, raw
-- activity_events rows `granola:<id>:<updated_at>` and the mirror
-- sources/granola/<Title>-meeting-<id>/{summary,transcript}.md) keeps writing
-- what it always wrote. These tables add what the source lane needs on top:
--
--   granola_source_state   durable per-tenant sync state (inventory pass with a
--                          page checkpoint, poll outcome, deletion sweep, notes
--                          whose fetch failed) read by coverage. Not exported.
--   granola_source_quota   Retry-After cooldowns keyed by the credential Granola
--                          rate-limits (API key fingerprint / OAuth account).
--   granola_source_notes   one catalog row per captured note, maintained by a
--                          trigger from the raw ledger (so it can never drift from
--                          activity_events) and exported as
--                          sources/granola/<Title>-meeting-<id>/note.json.
--
-- Every row is scoped by tenant_id (= donor user_id = yc_msaw tenantNs, taken
-- from the server-written task row). Nothing here stores an API key, OAuth
-- token, signed asset URL or cookie: credential identity is a truncated sha256.

CREATE TABLE IF NOT EXISTS granola_source_state (
  tenant_id text PRIMARY KEY,
  auth_mode text,
  -- sha256(auth mode, account identity, folder scope)[:32]; a change means the
  -- notes visible to the credential may differ, so a new inventory pass is due.
  inventory_key text,
  account_label text,
  -- granola_source_quota key of the current credential
  quota_key text,
  folder_id text,
  include_transcript boolean,
  inventory_generation integer NOT NULL DEFAULT 0,
  -- none | running | complete
  inventory_phase text NOT NULL DEFAULT 'none',
  inventory_cursor text,
  inventory_pages integer NOT NULL DEFAULT 0,
  inventory_listed integer NOT NULL DEFAULT 0,
  inventory_failed integer NOT NULL DEFAULT 0,
  inventory_started_at timestamptz,
  inventory_finished_at timestamptz,
  -- the pass listed every page (no cap, no hasMore-without-cursor)
  inventory_listing_complete boolean NOT NULL DEFAULT false,
  -- inventory_key of the last pass that listed every page and fetched every note.
  inventory_complete_key text,
  inventory_complete_at timestamptz,
  poll_watermark text,
  -- start of the first run of a poll window that is being drained through a
  -- resume cursor (capped runs); the watermark never passes it.
  poll_window_started_at timestamptz,
  last_poll_at timestamptz,
  last_poll_ok_at timestamptz,
  last_poll_error_at timestamptz,
  last_poll_error text,
  -- the listing reported more pages without a cursor (MCP list tools without a
  -- cursor argument): the window cannot be drained, never complete.
  listing_truncated_at timestamptz,
  last_sweep_at timestamptz,
  last_sweep jsonb,
  -- {"<note id>": {"error": "...", "at": "...", "attempts": n}}; retried by id.
  failed_notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocked_code text,
  blocked_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS granola_source_quota (
  quota_key text PRIMARY KEY,
  blocked_until timestamptz,
  last_status integer,
  last_retry_after_ms bigint,
  rate_limit_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS granola_source_notes (
  tenant_id text NOT NULL,
  note_id text NOT NULL,
  title text,
  note_created_at text,
  latest_updated_at text,
  meeting_start text,
  latest_event_id text,
  latest_source_event_id text,
  latest_captured_at timestamptz,
  revision_count integer NOT NULL DEFAULT 0,
  first_captured_at timestamptz,
  transcript_included boolean,
  transcript_segments integer,
  deleted_at timestamptz,
  deletion_reason text,
  deletion_event_id text,
  -- bookkeeping of the transcript re-check (not provider state; ignored by the journal)
  transcript_recheck_at timestamptz,
  transcript_recheck_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_granola_source_notes_recheck
  ON granola_source_notes (tenant_id, transcript_recheck_at)
  WHERE deleted_at IS NULL;

-- Recompute one catalog row from the raw ledger: the latest snapshot (by
-- provider updated_at, then capture order), the revision count, and whether the
-- newest observation is a deletion tombstone (a snapshot captured after a
-- tombstone is a restore).
CREATE OR REPLACE FUNCTION granola_source_catalog_refresh(p_tenant text, p_note text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  snap record;
  tomb record;
  revs integer;
  first_at timestamptz;
BEGIN
  -- Serialize refreshes of one note: under READ COMMITTED every following
  -- statement takes a fresh snapshot once the lock is held, so a concurrent
  -- insert for the same note is seen instead of being overwritten.
  PERFORM pg_advisory_xact_lock(hashtextextended('granola_source_notes:' || p_tenant || ':' || p_note, 0));
  SELECT a.id::text AS id, a.source_event_id, a.created_at, a.raw_payload AS p
    INTO snap
    FROM activity_events a
   WHERE a.user_id = p_tenant AND a.source = 'granola' AND a.event_type = 'meeting_note'
     AND a.source_object_id = 'meeting_note:' || p_note
   ORDER BY a.source_updated_at DESC NULLS LAST, a.created_at DESC, a.id DESC
   LIMIT 1;
  SELECT count(*), min(a.created_at) INTO revs, first_at
    FROM activity_events a
   WHERE a.user_id = p_tenant AND a.source = 'granola' AND a.event_type = 'meeting_note'
     AND a.source_object_id = 'meeting_note:' || p_note;
  SELECT a.id::text AS id, a.created_at, a.raw_payload AS p
    INTO tomb
    FROM activity_events a
   WHERE a.user_id = p_tenant AND a.source = 'granola' AND a.event_type = 'meeting_note.deleted'
     AND a.source_object_id = 'meeting_note:' || p_note
   ORDER BY a.created_at DESC, a.id DESC
   LIMIT 1;
  IF snap.id IS NULL AND tomb.id IS NULL THEN
    DELETE FROM granola_source_notes WHERE tenant_id = p_tenant AND note_id = p_note;
    RETURN;
  END IF;
  INSERT INTO granola_source_notes AS n (
    tenant_id, note_id, title, note_created_at, latest_updated_at, meeting_start, latest_event_id,
    latest_source_event_id, latest_captured_at, revision_count, first_captured_at,
    transcript_included, transcript_segments, deleted_at, deletion_reason, deletion_event_id
  ) VALUES (
    p_tenant, p_note,
    COALESCE(snap.p ->> 'title', tomb.p ->> 'title'),
    snap.p ->> 'createdAt',
    snap.p ->> 'updatedAt',
    COALESCE(snap.p -> 'calendarEvent' ->> 'scheduled_start_time', snap.p ->> 'createdAt'),
    snap.id, snap.source_event_id, snap.created_at, COALESCE(revs, 0), first_at,
    CASE WHEN snap.id IS NULL THEN NULL ELSE jsonb_typeof(snap.p -> 'transcript') = 'array' END,
    CASE WHEN jsonb_typeof(snap.p -> 'transcript') = 'array' THEN jsonb_array_length(snap.p -> 'transcript') END,
    CASE WHEN tomb.id IS NOT NULL AND (snap.id IS NULL OR tomb.created_at >= snap.created_at) THEN tomb.created_at END,
    CASE WHEN tomb.id IS NOT NULL AND (snap.id IS NULL OR tomb.created_at >= snap.created_at) THEN tomb.p ->> 'deletionReason' END,
    CASE WHEN tomb.id IS NOT NULL AND (snap.id IS NULL OR tomb.created_at >= snap.created_at) THEN tomb.id END
  )
  ON CONFLICT (tenant_id, note_id) DO UPDATE SET
    title = EXCLUDED.title,
    note_created_at = EXCLUDED.note_created_at,
    latest_updated_at = EXCLUDED.latest_updated_at,
    meeting_start = EXCLUDED.meeting_start,
    latest_event_id = EXCLUDED.latest_event_id,
    latest_source_event_id = EXCLUDED.latest_source_event_id,
    latest_captured_at = EXCLUDED.latest_captured_at,
    revision_count = EXCLUDED.revision_count,
    first_captured_at = EXCLUDED.first_captured_at,
    transcript_included = EXCLUDED.transcript_included,
    transcript_segments = EXCLUDED.transcript_segments,
    deleted_at = EXCLUDED.deleted_at,
    deletion_reason = EXCLUDED.deletion_reason,
    deletion_event_id = EXCLUDED.deletion_event_id,
    -- a new revision re-arms the transcript re-check
    transcript_recheck_at = CASE WHEN n.latest_event_id IS DISTINCT FROM EXCLUDED.latest_event_id THEN NULL ELSE n.transcript_recheck_at END,
    transcript_recheck_count = CASE WHEN n.latest_event_id IS DISTINCT FROM EXCLUDED.latest_event_id THEN 0 ELSE n.transcript_recheck_count END;
END;
$$;

CREATE OR REPLACE FUNCTION granola_source_catalog_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec record;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  IF rec.source <> 'granola' OR rec.source_object_id IS NULL OR rec.source_object_id NOT LIKE 'meeting_note:%' THEN
    RETURN NULL;
  END IF;
  PERFORM granola_source_catalog_refresh(rec.user_id, substr(rec.source_object_id, length('meeting_note:') + 1));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_granola_source_catalog ON activity_events;
CREATE TRIGGER trg_granola_source_catalog
  AFTER INSERT OR DELETE OR UPDATE OF raw_payload, source_object_id, event_type, source_updated_at ON activity_events
  FOR EACH ROW EXECUTE FUNCTION granola_source_catalog_event();

DROP TRIGGER IF EXISTS trg_source_lane_journal_granola_source_notes ON granola_source_notes;
CREATE TRIGGER trg_source_lane_journal_granola_source_notes
  AFTER INSERT OR UPDATE OR DELETE ON granola_source_notes
  FOR EACH ROW EXECUTE FUNCTION source_lane_journal_row('tenant_id', 'note_id', 'transcript_recheck_at', 'transcript_recheck_count');

-- Catalog rows for notes captured before this lane was installed.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT user_id, substr(source_object_id, length('meeting_note:') + 1) AS note_id
      FROM activity_events
     WHERE source = 'granola' AND source_object_id LIKE 'meeting_note:%'
  LOOP
    PERFORM granola_source_catalog_refresh(r.user_id, r.note_id);
  END LOOP;
END;
$$;
