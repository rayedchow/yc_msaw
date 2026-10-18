CREATE TABLE "chat_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers"("id"),
  "subject_id" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "token_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'active',
  "source" text NOT NULL DEFAULT 'web',
  "archived_messages" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_chat_conversation_owner_updated"
  ON "chat_conversations" ("tenant_id", "kb_id", "subject_id", "updated_at" DESC);
