-- Aqueduct initial schema. Hand-written to match src/db/schema.ts exactly
-- (drizzle-kit can take over generation once a config lands).

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE "tenants" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_tenant_slug" ON "tenants" ("slug");

CREATE TABLE "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "key_hash" text NOT NULL,
  "key_prefix" text NOT NULL DEFAULT '',
  "revoked_at" timestamptz,
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_api_key_hash" ON "api_keys" ("key_hash");
CREATE INDEX "idx_api_key_tenant" ON "api_keys" ("tenant_id");

CREATE TABLE "connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "provider" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "external_account_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_connection_status" CHECK ("status" IN ('active', 'paused', 'revoked', 'error'))
);
CREATE UNIQUE INDEX "uq_connection_tenant_provider" ON "connections" ("tenant_id", "provider");
CREATE INDEX "idx_connection_provider" ON "connections" ("provider");

-- ---------------------------------------------------------------------------
-- Vault
-- ---------------------------------------------------------------------------

CREATE TABLE "integration_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_token_user_provider" ON "integration_tokens" ("user_id", "provider");
CREATE INDEX "idx_integration_tokens_provider" ON "integration_tokens" ("provider");

-- ---------------------------------------------------------------------------
-- Raw event store
-- ---------------------------------------------------------------------------

CREATE TABLE "activity_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "source" text NOT NULL,
  "event_type" text NOT NULL,
  "timestamp" timestamptz NOT NULL,
  "source_updated_at" timestamptz,
  "wiki_eligibility_at" timestamptz,
  "raw_payload" jsonb NOT NULL,
  "extracted_entities" jsonb,
  "source_event_id" text NOT NULL,
  "processing_status" text NOT NULL DEFAULT 'collected',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_event_user_source" ON "activity_events" ("user_id", "source_event_id");
CREATE INDEX "idx_event_user_ts" ON "activity_events" ("user_id", "timestamp");
CREATE INDEX "idx_event_user_source_ts" ON "activity_events" ("user_id", "source", "timestamp");

CREATE TABLE "conversation_watermarks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "conversation_id" text NOT NULL,
  "conversation_type" text,
  "conversation_name" text,
  "last_seen_ts" text,
  "last_polled_at" timestamptz,
  "is_active" boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "uq_watermark_user_provider_convo" ON "conversation_watermarks" ("user_id", "provider", "conversation_id");
CREATE INDEX "idx_watermark_user_provider_active" ON "conversation_watermarks" ("user_id", "provider", "is_active");

CREATE TABLE "source_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "phase" text NOT NULL DEFAULT 'queued',
  "requested_by" text NOT NULL DEFAULT 'api',
  "coverage_from" timestamptz,
  "coverage_to" timestamptz NOT NULL,
  "exhausted" boolean NOT NULL DEFAULT false,
  "cap_hit" boolean NOT NULL DEFAULT false,
  "result" jsonb NOT NULL DEFAULT '{}',
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "attempts" integer NOT NULL DEFAULT 0,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_source_sync_status" CHECK ("status" IN ('queued', 'running', 'completed', 'blocked', 'failed'))
);
CREATE INDEX "idx_source_sync_runs_user_provider_status" ON "source_sync_runs" ("user_id", "provider", "status");
CREATE INDEX "idx_source_sync_runs_status_updated" ON "source_sync_runs" ("status", "updated_at");

-- ---------------------------------------------------------------------------
-- Mirror
-- ---------------------------------------------------------------------------

CREATE TABLE "mirror_files" (
  "path" text NOT NULL,
  "user_id" text NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "content_sha" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_mirror_file_user_path" ON "mirror_files" ("user_id", "path");
CREATE INDEX "idx_mirror_file_path" ON "mirror_files" ("path");
CREATE INDEX "idx_mirror_file_user_content_sha" ON "mirror_files" ("user_id", "content_sha");

-- ---------------------------------------------------------------------------
-- Google Calendar connector state
-- ---------------------------------------------------------------------------

CREATE TABLE "google_calendar_sync_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "delegated_email" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_key" text NOT NULL,
  "calendar_id" text,
  "calendar_summary" text,
  "calendar_access_role" text,
  "calendar_time_zone" text,
  "calendar_primary" boolean NOT NULL DEFAULT false,
  "sync_token" text,
  "last_full_sync_at" timestamptz,
  "last_incremental_sync_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_google_calendar_sync_resource_type" CHECK ("resource_type" IN ('calendar_list', 'events'))
);
CREATE UNIQUE INDEX "uq_google_calendar_sync_state" ON "google_calendar_sync_states" ("user_id", "delegated_email", "resource_type", "resource_key");
CREATE INDEX "idx_google_calendar_sync_state_user_type" ON "google_calendar_sync_states" ("user_id", "resource_type");

CREATE TABLE "google_calendar_watch_channels" (
  "channel_id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "delegated_email" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_key" text NOT NULL,
  "calendar_id" text,
  "resource_id" text NOT NULL,
  "resource_uri" text,
  "token_hash" text NOT NULL,
  "event_types" jsonb NOT NULL DEFAULT '[]',
  "expiration" timestamptz,
  "status" text NOT NULL DEFAULT 'active',
  "last_message_number" text,
  "last_notification_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_google_calendar_watch_resource_type" CHECK ("resource_type" IN ('calendar_list', 'events')),
  CONSTRAINT "ck_google_calendar_watch_status" CHECK ("status" IN ('active', 'superseded', 'stopped', 'expired'))
);
CREATE INDEX "idx_google_calendar_watch_user_status" ON "google_calendar_watch_channels" ("user_id", "status");
CREATE INDEX "idx_google_calendar_watch_resource" ON "google_calendar_watch_channels" ("user_id", "delegated_email", "resource_type", "resource_key", "status");
CREATE INDEX "idx_google_calendar_watch_expiration" ON "google_calendar_watch_channels" ("expiration");
CREATE INDEX "idx_google_calendar_watch_resource_id" ON "google_calendar_watch_channels" ("resource_id");

CREATE TABLE "google_calendar_event_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "delegated_email" text NOT NULL,
  "calendar_id" text NOT NULL,
  "event_id" text NOT NULL,
  "ical_uid" text,
  "recurring_event_id" text,
  "event_type" text,
  "status" text,
  "summary" text,
  "start" jsonb,
  "end" jsonb,
  "source_updated_at" timestamptz,
  "content_hash" text NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_google_calendar_event_snapshot" ON "google_calendar_event_snapshots" ("user_id", "delegated_email", "calendar_id", "event_id");
CREATE INDEX "idx_google_calendar_event_snapshot_user_calendar" ON "google_calendar_event_snapshots" ("user_id", "delegated_email", "calendar_id");
CREATE INDEX "idx_google_calendar_event_snapshot_user_updated" ON "google_calendar_event_snapshots" ("user_id", "source_updated_at");
CREATE INDEX "idx_google_calendar_event_snapshot_ical_uid" ON "google_calendar_event_snapshots" ("user_id", "ical_uid");

-- ---------------------------------------------------------------------------
-- Google Docs connector state
-- ---------------------------------------------------------------------------

CREATE TABLE "document_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "doc_id" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "overview" text NOT NULL DEFAULT '',
  "tab_summaries" jsonb NOT NULL DEFAULT '{}',
  "contributors" jsonb NOT NULL DEFAULT '[]',
  "last_synthesis_entry" integer NOT NULL DEFAULT 0,
  "pending_buffer" jsonb NOT NULL DEFAULT '[]',
  "dirty_at" timestamptz,
  "last_updated" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_docsummary_user_doc" ON "document_summaries" ("user_id", "doc_id");
CREATE INDEX "idx_docsummary_dirty" ON "document_summaries" ("dirty_at");

-- ---------------------------------------------------------------------------
-- Notion connector state
-- ---------------------------------------------------------------------------

CREATE TABLE "notion_page_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "page_id" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "url" text,
  "parent_type" text,
  "parent_id" text,
  "data_source_id" text,
  "overview" text NOT NULL DEFAULT '',
  "section_summaries" jsonb NOT NULL DEFAULT '{}',
  "properties" jsonb NOT NULL DEFAULT '{}',
  "page_metadata" jsonb NOT NULL DEFAULT '{}',
  "content_hash" text,
  "last_edited_time" timestamptz,
  "dirty_at" timestamptz,
  "last_synced_at" timestamptz,
  "markdown_truncated" boolean NOT NULL DEFAULT false,
  "unknown_block_ids" jsonb NOT NULL DEFAULT '[]',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_notion_page_summary_user_page" ON "notion_page_summaries" ("user_id", "page_id");
CREATE INDEX "idx_notion_page_summary_dirty" ON "notion_page_summaries" ("dirty_at");
CREATE INDEX "idx_notion_page_summary_user_edited" ON "notion_page_summaries" ("user_id", "last_edited_time");

-- ---------------------------------------------------------------------------
-- Task engine
-- ---------------------------------------------------------------------------

CREATE TABLE "task_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "queue" text NOT NULL,
  "tenant_id" text NOT NULL,
  "group_key" text NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "dedupe_key" text,
  "state" text NOT NULL DEFAULT 'queued',
  "run_at" timestamptz NOT NULL DEFAULT now(),
  "priority" integer NOT NULL DEFAULT 0,
  "attempt" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "started_at" timestamptz,
  "last_heartbeat_at" timestamptz,
  "heartbeat_timeout_seconds" integer NOT NULL DEFAULT 120,
  "finished_at" timestamptz,
  "output" jsonb,
  "error_message" text,
  "prev_run_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_task_state" CHECK ("state" IN ('queued', 'running', 'succeeded', 'failed', 'expired', 'cancelled'))
);
CREATE INDEX "idx_task_dequeue" ON "task_queue" ("queue", "state", "run_at");
CREATE INDEX "idx_task_group_state" ON "task_queue" ("group_key", "state");
CREATE INDEX "idx_task_tenant_state" ON "task_queue" ("tenant_id", "state");
CREATE INDEX "idx_task_running_heartbeat" ON "task_queue" ("state", "last_heartbeat_at");
CREATE UNIQUE INDEX "uq_task_dedupe_active" ON "task_queue" ("dedupe_key")
  WHERE state IN ('queued', 'running') AND dedupe_key IS NOT NULL;

CREATE TABLE "task_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "queue" text NOT NULL DEFAULT 'sync',
  "group_key" text NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "frequency_seconds" integer NOT NULL,
  "due_at" timestamptz NOT NULL DEFAULT now(),
  "enabled" boolean NOT NULL DEFAULT true,
  "last_enqueued_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_task_schedule_frequency" CHECK ("frequency_seconds" > 0)
);
CREATE UNIQUE INDEX "uq_task_schedule_group_kind" ON "task_schedules" ("group_key", "kind");
CREATE INDEX "idx_task_schedule_due" ON "task_schedules" ("enabled", "due_at");

-- ---------------------------------------------------------------------------
-- Outbox -> customer webhooks
-- ---------------------------------------------------------------------------

CREATE TABLE "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "ordering_key" text,
  "state" text NOT NULL DEFAULT 'pending',
  "delivered_endpoint_ids" jsonb NOT NULL DEFAULT '[]',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "delivered_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_outbox_state" CHECK ("state" IN ('pending', 'delivering', 'delivered', 'dead'))
);
CREATE INDEX "idx_outbox_dispatch" ON "outbox_events" ("state", "next_attempt_at");
CREATE INDEX "idx_outbox_tenant_created" ON "outbox_events" ("tenant_id", "created_at");

CREATE TABLE "webhook_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "event_types" jsonb NOT NULL DEFAULT '[]',
  "enabled" boolean NOT NULL DEFAULT true,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "circuit_open_until" timestamptz,
  "last_delivery_at" timestamptz,
  "last_failure_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_webhook_endpoint_tenant" ON "webhook_endpoints" ("tenant_id", "enabled");
