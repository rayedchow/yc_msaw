-- Source lane: change journal for the sources/ exporter, per-tenant publish
-- bindings, and a database-level refusal of graph/wiki work.

-- Every source-relevant row change appends one journal row in the writer's own
-- transaction, so the exporter can never miss a change (including deletes made
-- by bulk DELETE statements that bypass application hooks). The exporter claims
-- rows with a lease, re-reads the current row state, publishes it, and deletes
-- the journal rows only after the store accepted every change.
CREATE TABLE "source_lane_journal" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "table_name" text NOT NULL,
  "row_key" text NOT NULL,
  "op" text NOT NULL CHECK ("op" IN ('INSERT', 'UPDATE', 'DELETE')),
  "enqueued_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "lease_owner" text,
  "lease_until" timestamptz,
  "last_error" text,
  "dead_lettered_at" timestamptz
);

CREATE INDEX "idx_source_lane_journal_due"
  ON "source_lane_journal" ("next_attempt_at", "id")
  WHERE "dead_lettered_at" IS NULL;
CREATE INDEX "idx_source_lane_journal_key"
  ON "source_lane_journal" ("tenant_id", "table_name", "row_key");

-- Generic row journal trigger.
--   TG_ARGV[0]   tenant column
--   TG_ARGV[1]   key column (text representation is the journal row_key)
--   TG_ARGV[2..] columns whose changes alone do not need an export (lifecycle bookkeeping)
-- An UPDATE that moves a row to a different tenant/key journals the old key too.
CREATE FUNCTION "source_lane_journal_row"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_rec jsonb;
  old_rec jsonb;
  i integer;
BEGIN
  IF TG_OP <> 'DELETE' THEN new_rec := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN old_rec := to_jsonb(OLD); END IF;
  IF TG_OP = 'UPDATE' AND TG_NARGS > 2 THEN
    DECLARE
      a jsonb := new_rec;
      b jsonb := old_rec;
    BEGIN
      FOR i IN 2 .. TG_NARGS - 1 LOOP
        a := a - TG_ARGV[i];
        b := b - TG_ARGV[i];
      END LOOP;
      IF a = b THEN RETURN NULL; END IF;
    END;
  END IF;
  IF new_rec IS NOT NULL AND new_rec ->> TG_ARGV[0] IS NOT NULL AND new_rec ->> TG_ARGV[1] IS NOT NULL THEN
    INSERT INTO "source_lane_journal" ("tenant_id", "table_name", "row_key", "op")
    VALUES (new_rec ->> TG_ARGV[0], TG_TABLE_NAME, new_rec ->> TG_ARGV[1], TG_OP);
  END IF;
  IF old_rec IS NOT NULL AND old_rec ->> TG_ARGV[0] IS NOT NULL AND old_rec ->> TG_ARGV[1] IS NOT NULL
     AND (new_rec IS NULL
          OR (old_rec ->> TG_ARGV[0]) IS DISTINCT FROM (new_rec ->> TG_ARGV[0])
          OR (old_rec ->> TG_ARGV[1]) IS DISTINCT FROM (new_rec ->> TG_ARGV[1])) THEN
    INSERT INTO "source_lane_journal" ("tenant_id", "table_name", "row_key", "op")
    VALUES (old_rec ->> TG_ARGV[0], TG_TABLE_NAME, old_rec ->> TG_ARGV[1], 'DELETE');
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_source_lane_journal_mirror_files"
  AFTER INSERT OR UPDATE OR DELETE ON "mirror_files"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('user_id', 'path');

-- processing_status / wiki_eligibility_at are pipeline bookkeeping, not provider state.
CREATE TRIGGER "trg_source_lane_journal_activity_events"
  AFTER INSERT OR UPDATE OR DELETE ON "activity_events"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('user_id', 'id', 'processing_status', 'wiki_eligibility_at');

-- Paths last published for each exported row, so a deleted row (whose state is gone)
-- can still be turned into deletes of exactly the files it produced.
CREATE TABLE "source_lane_exported" (
  "tenant_id" text NOT NULL,
  "table_name" text NOT NULL,
  "row_key" text NOT NULL,
  "path" text NOT NULL,
  "exported_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "table_name", "row_key", "path")
);
CREATE INDEX "idx_source_lane_exported_path" ON "source_lane_exported" ("tenant_id", "path");

-- Publish credential per runtime tenant. tenant_id is the yc_msaw tenant namespace,
-- assigned by yc_msaw over the service-authenticated internal API (never by a caller).
-- token_ciphertext is the psb_ binding token encrypted with vault/encryption.ts.
CREATE TABLE "source_lane_bindings" (
  "tenant_id" text PRIMARY KEY,
  "binding_id" text NOT NULL,
  "token_ciphertext" text NOT NULL,
  "publish_url" text NOT NULL,
  "providers" jsonb NOT NULL DEFAULT '["*"]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- The source lane never runs graph or wiki work. Donor connect/dispatch code still
-- schedules `graph.ensure_default_kb`; such rows are refused here (and counted) so no
-- graph task can ever be queued, claimed or "handled" by a placeholder.
CREATE TABLE "source_lane_refused_tasks" (
  "id" bigserial PRIMARY KEY,
  "table_name" text NOT NULL,
  "tenant_id" text,
  "queue" text,
  "kind" text NOT NULL,
  "group_key" text,
  "refused_at" timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION "source_lane_refuse_graph_tasks"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" LIKE 'graph.%' OR NEW."kind" LIKE 'wiki.%' OR NEW."queue" IN ('graph', 'wiki') THEN
    INSERT INTO "source_lane_refused_tasks" ("table_name", "tenant_id", "queue", "kind", "group_key")
    VALUES (TG_TABLE_NAME, NEW."tenant_id", NEW."queue", NEW."kind", NEW."group_key");
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_source_lane_refuse_graph_task_queue"
  BEFORE INSERT OR UPDATE ON "task_queue"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_refuse_graph_tasks"();
CREATE TRIGGER "trg_source_lane_refuse_graph_task_schedules"
  BEFORE INSERT OR UPDATE ON "task_schedules"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_refuse_graph_tasks"();
