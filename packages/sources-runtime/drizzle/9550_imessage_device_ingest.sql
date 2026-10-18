-- iMessage device ingest (Mac uploader receiver) for the source lane.
-- Port of gigabrain@5448774e brain/src/routes/imessage-ingest.ts storage, adapted:
-- tenant = yc_msaw tenant namespace (activity_events.user_id), lifecycle
-- collected -> mirrored (no brain processing columns), device credentials bound to
-- a yc_msaw kind=device source binding and stored only as sha256.

-- One row per enrolled Mac uploader. binding_id is the yc_msaw source binding
-- (`sb-...`) whose secret the device key `gimsg_<tenant>.<binding>.<secret>` shares;
-- token_sha256 = sha256(device key). Revocation is a state change (never a delete),
-- so receipts, commands and raw rows keep pointing at the device that produced them.
CREATE TABLE "imessage_devices" (
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "token_sha256" text NOT NULL,
  "label" text,
  "handles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "created_by_subject" text NOT NULL,
  "created_by_issuer" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "revoked_reason" text,
  "last_seen_at" timestamptz,
  "last_device_id" text,
  "last_agent_version" text,
  "last_agent_channel" text,
  "local_status" jsonb,
  "local_status_at" timestamptz,
  PRIMARY KEY ("tenant_id", "binding_id"),
  CONSTRAINT "ck_imessage_device_status" CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "ck_imessage_device_binding" CHECK ("binding_id" ~ '^sb-[0-9a-f]{16}$'),
  CONSTRAINT "ck_imessage_device_token_sha" CHECK ("token_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ck_imessage_device_revoked" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "uq_imessage_device_token" ON "imessage_devices" ("token_sha256");

-- Donor gigabrain brain/src/db/schema.ts activityEventSourceAliases (verbatim columns
-- and indexes). Records legacy/raw-chat ids that resolve to a canonical event.
CREATE TABLE "activity_event_source_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "source" text NOT NULL,
  "alias_event_id" uuid REFERENCES "activity_events" ("id") ON DELETE CASCADE,
  "canonical_event_id" uuid NOT NULL REFERENCES "activity_events" ("id") ON DELETE CASCADE,
  "alias_source_event_id" text NOT NULL,
  "canonical_source_event_id" text NOT NULL,
  "provider_identity" text,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_activity_event_source_alias" ON "activity_event_source_aliases" ("user_id", "alias_source_event_id");
CREATE UNIQUE INDEX "uq_activity_event_alias_event" ON "activity_event_source_aliases" ("alias_event_id");
CREATE INDEX "idx_activity_event_alias_canonical" ON "activity_event_source_aliases" ("canonical_event_id");
CREATE INDEX "idx_activity_event_alias_user_source" ON "activity_event_source_aliases" ("user_id", "source");

-- Identity lookups the donor receiver performs on every batch (GUID / messageId in
-- raw_payload) and the per-(conversation, month) projection reads.
CREATE INDEX "idx_imessage_event_provider_guid"
  ON "activity_events" ("user_id", (("raw_payload" ->> 'providerMessageGuid')))
  WHERE "source" = 'imessage';
CREATE INDEX "idx_imessage_event_message_id"
  ON "activity_events" ("user_id", (("raw_payload" ->> 'messageId')))
  WHERE "source" = 'imessage';
CREATE INDEX "idx_imessage_event_reaction_target"
  ON "activity_events" ("user_id", (regexp_replace("raw_payload" -> 'reaction' ->> 'targetMessageId', '^(p:[0-9]+/|bp:)', '')))
  WHERE "source" = 'imessage' AND jsonb_typeof("raw_payload" -> 'reaction') = 'object';
CREATE INDEX "idx_imessage_event_conversation_ts"
  ON "activity_events" ("user_id", (("raw_payload" ->> '_normalized_conversation_id')), "timestamp")
  WHERE "source" = 'imessage';

-- Durable device command queue (donor kept a single command in token metadata).
-- At most one pending command per (device, type): a newer request supersedes it.
CREATE TABLE "imessage_device_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "source_sync_run_id" uuid REFERENCES "source_sync_runs" ("id") ON DELETE SET NULL,
  "requested_by" text NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "acknowledged_at" timestamptz,
  "ack_status" text,
  "result" jsonb,
  "error" text,
  FOREIGN KEY ("tenant_id", "binding_id") REFERENCES "imessage_devices" ("tenant_id", "binding_id"),
  CONSTRAINT "ck_imessage_command_type" CHECK ("type" IN ('messages_backfill_reset', 'messages_source_sync')),
  CONSTRAINT "ck_imessage_command_status" CHECK ("status" IN ('pending', 'completed', 'failed', 'superseded', 'cancelled'))
);
CREATE UNIQUE INDEX "uq_imessage_command_pending"
  ON "imessage_device_commands" ("tenant_id", "binding_id", "type") WHERE "status" = 'pending';
CREATE INDEX "idx_imessage_command_device" ON "imessage_device_commands" ("tenant_id", "binding_id", "requested_at");

-- Contact names synced from the Mac's address book (POST /sync-contacts). Keyed by the
-- normalized handle; variants are the donor's imessageHandleVariants used for matching.
CREATE TABLE "imessage_contacts" (
  "tenant_id" text NOT NULL,
  "handle" text NOT NULL,
  "name" text NOT NULL,
  "variants" jsonb NOT NULL,
  "binding_id" text NOT NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "handle")
);

-- Upload progress the agent attaches to ingest batches (donor source_sync_progress, scoped per device).
CREATE TABLE "imessage_sync_progress" (
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "sync_kind" text NOT NULL,
  "status" text NOT NULL,
  "progress" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "uploaded" bigint NOT NULL DEFAULT 0,
  "stored" bigint NOT NULL DEFAULT 0,
  "updated" bigint NOT NULL DEFAULT 0,
  "skipped" bigint NOT NULL DEFAULT 0,
  "rejected" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "binding_id", "operation_id")
);

-- Raw mutation ledger: every in-place change of an iMessage activity_events row keeps
-- the exact previous stored payload and the upload that changed it, so edit/unsend/
-- tapback/attachment history survives even when the exporter coalesces quick updates.
CREATE TABLE "imessage_message_mutations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "event_id" uuid NOT NULL,
  "source_event_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "kinds" jsonb NOT NULL,
  "previous_payload" jsonb NOT NULL,
  "next_payload_sha256" text NOT NULL,
  "uploaded" jsonb NOT NULL,
  "event_timestamp" timestamptz NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "idx_imessage_mutation_event" ON "imessage_message_mutations" ("tenant_id", "event_id", "observed_at");

-- Uploaded messages the receiver could not store (missing ids, invalid timestamps,
-- non-object entries). Kept verbatim (NUL-stripped) and reported as partial coverage.
CREATE TABLE "imessage_ingest_rejections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "reason" text NOT NULL,
  "batch_index" integer NOT NULL,
  "uploaded" jsonb,
  "received_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "idx_imessage_rejection_tenant" ON "imessage_ingest_rejections" ("tenant_id", "received_at");

-- (conversation, month) projections that must be re-rendered. Written in the ingest
-- transaction; cleared only after the projection committed, so a crash between the two
-- leaves the work visible (coverage reports it pending) and the imessage.project task drains it.
CREATE TABLE "imessage_projection_dirty" (
  "tenant_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "month" text NOT NULL,
  "marked_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "conversation_id", "month"),
  CONSTRAINT "ck_imessage_projection_month" CHECK ("month" ~ '^\d{4}-\d{2}$' OR "month" = '*')
);

CREATE TRIGGER "trg_source_lane_journal_imessage_message_mutations"
  AFTER INSERT OR UPDATE OR DELETE ON "imessage_message_mutations"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id');
CREATE TRIGGER "trg_source_lane_journal_imessage_ingest_rejections"
  AFTER INSERT OR UPDATE OR DELETE ON "imessage_ingest_rejections"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id');
