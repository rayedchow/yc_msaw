-- Notion native snapshot store (src/integrations/notion/snapshot.ts). The
-- code shipped before its migration: persistNotionNativeSnapshot upserts and
-- the poller's remove* paths hit ALL of these tables in one transaction, so
-- the full set is provisioned here, not just notion_block_snapshots. Unique
-- indexes match snapshot.ts's ON CONFLICT targets exactly.

CREATE TABLE "notion_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "object_id" text NOT NULL,
  "object_type" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "url" text,
  "parent_type" text,
  "parent_id" text,
  "data_source_id" text,
  "database_id" text,
  "block_type" text,
  "has_children" boolean NOT NULL DEFAULT false,
  "archived" boolean NOT NULL DEFAULT false,
  "in_trash" boolean NOT NULL DEFAULT false,
  "plain_text" text NOT NULL DEFAULT '',
  "object_hash" text NOT NULL,
  "properties" jsonb NOT NULL DEFAULT '{}',
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "raw" jsonb NOT NULL DEFAULT '{}',
  "created_time" timestamptz,
  "last_edited_time" timestamptz,
  "created_by" jsonb,
  "last_edited_by" jsonb,
  "last_synced_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_notion_object_user_object" ON "notion_objects" ("user_id", "object_id");
CREATE INDEX "idx_notion_object_user_type" ON "notion_objects" ("user_id", "object_type");

CREATE TABLE "notion_object_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "parent_object_id" text NOT NULL,
  "child_object_id" text NOT NULL,
  "relation_type" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "source_object_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "child_hash" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_notion_object_edge" ON "notion_object_edges" ("user_id", "parent_object_id", "child_object_id", "relation_type");
CREATE INDEX "idx_notion_object_edge_child" ON "notion_object_edges" ("user_id", "child_object_id");
CREATE INDEX "idx_notion_object_edge_source" ON "notion_object_edges" ("user_id", "source_object_id");

CREATE TABLE "notion_block_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "block_id" text NOT NULL,
  "page_id" text,
  "parent_type" text,
  "parent_id" text,
  "block_type" text NOT NULL,
  "has_children" boolean NOT NULL DEFAULT false,
  "archived" boolean NOT NULL DEFAULT false,
  "in_trash" boolean NOT NULL DEFAULT false,
  "plain_text" text NOT NULL DEFAULT '',
  "markdown" text NOT NULL DEFAULT '',
  "content_hash" text NOT NULL,
  "children_hash" text NOT NULL,
  "table_cell_rich_text" jsonb,
  "raw" jsonb NOT NULL DEFAULT '{}',
  "created_time" timestamptz,
  "last_edited_time" timestamptz,
  "created_by" jsonb,
  "last_edited_by" jsonb,
  "last_synced_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_notion_block_snapshot_user_block" ON "notion_block_snapshots" ("user_id", "block_id");
CREATE INDEX "idx_notion_block_snapshot_page" ON "notion_block_snapshots" ("user_id", "page_id");

CREATE TABLE "notion_data_source_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "data_source_id" text NOT NULL,
  "database_id" text,
  "title" text NOT NULL DEFAULT '',
  "description" jsonb,
  "url" text,
  "public_url" text,
  "parent_type" text,
  "parent_id" text,
  "is_inline" boolean NOT NULL DEFAULT false,
  "archived" boolean NOT NULL DEFAULT false,
  "in_trash" boolean NOT NULL DEFAULT false,
  "icon" jsonb,
  "cover" jsonb,
  "properties" jsonb NOT NULL DEFAULT '{}',
  "property_hash" text NOT NULL,
  "raw" jsonb NOT NULL DEFAULT '{}',
  "created_time" timestamptz,
  "last_edited_time" timestamptz,
  "created_by" jsonb,
  "last_edited_by" jsonb,
  "last_synced_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_notion_data_source_snapshot" ON "notion_data_source_snapshots" ("user_id", "data_source_id");

CREATE TABLE "notion_database_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "database_id" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "description" jsonb,
  "url" text,
  "public_url" text,
  "parent_type" text,
  "parent_id" text,
  "is_inline" boolean NOT NULL DEFAULT false,
  "is_locked" boolean NOT NULL DEFAULT false,
  "in_trash" boolean NOT NULL DEFAULT false,
  "icon" jsonb,
  "cover" jsonb,
  "properties" jsonb NOT NULL DEFAULT '{}',
  "data_sources" jsonb NOT NULL DEFAULT '[]',
  "raw" jsonb NOT NULL DEFAULT '{}',
  "created_time" timestamptz,
  "last_edited_time" timestamptz,
  "created_by" jsonb,
  "last_edited_by" jsonb,
  "last_synced_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_notion_database_snapshot" ON "notion_database_snapshots" ("user_id", "database_id");

CREATE TABLE "notion_view_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "view_id" text NOT NULL,
  "database_id" text,
  "data_source_id" text,
  "name" text NOT NULL DEFAULT '',
  "view_type" text NOT NULL,
  "url" text,
  "parent_type" text,
  "parent_id" text,
  "dashboard_view_id" text,
  "filter" jsonb,
  "sorts" jsonb,
  "quick_filters" jsonb,
  "configuration" jsonb,
  "query_result_page_ids" jsonb NOT NULL DEFAULT '[]',
  "query_total_count" integer,
  "query_has_more" boolean NOT NULL DEFAULT false,
  "query_next_cursor" text,
  "query_request_status" jsonb,
  "query_expires_at" timestamptz,
  "query_fetched_at" timestamptz,
  "query_raw" jsonb,
  "raw" jsonb NOT NULL DEFAULT '{}',
  "created_time" timestamptz,
  "last_edited_time" timestamptz,
  "created_by" jsonb,
  "last_edited_by" jsonb,
  "last_synced_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_notion_view_snapshot" ON "notion_view_snapshots" ("user_id", "view_id");
CREATE INDEX "idx_notion_view_snapshot_data_source" ON "notion_view_snapshots" ("user_id", "data_source_id");

CREATE TABLE "notion_comment_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "comment_id" text NOT NULL,
  "page_id" text,
  "block_id" text,
  "parent_type" text,
  "parent_id" text,
  "discussion_id" text,
  "plain_text" text NOT NULL DEFAULT '',
  "rich_text" jsonb NOT NULL DEFAULT '[]',
  "retrieval_request_status" jsonb,
  "retrieval_complete" boolean,
  "retrieval_has_more" boolean,
  "retrieval_next_cursor" text,
  "raw" jsonb NOT NULL DEFAULT '{}',
  "created_time" timestamptz,
  "last_edited_time" timestamptz,
  "created_by" jsonb,
  "last_synced_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "uq_notion_comment_snapshot" ON "notion_comment_snapshots" ("user_id", "comment_id");
CREATE INDEX "idx_notion_comment_snapshot_page" ON "notion_comment_snapshots" ("user_id", "page_id");
