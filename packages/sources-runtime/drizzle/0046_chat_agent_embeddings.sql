CREATE TABLE "entity_summary_embeddings" (
  "entity_id" uuid PRIMARY KEY REFERENCES "entities" ("id") ON DELETE CASCADE,
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "embedding" vector(1536) NOT NULL,
  "embedding_inputs_hash" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_entity_summary_embedding_hnsw"
  ON "entity_summary_embeddings" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX "idx_entity_summary_embeddings_kb"
  ON "entity_summary_embeddings" ("kb_id");

CREATE TABLE "document_embeddings" (
  "document_id" uuid PRIMARY KEY REFERENCES "source_documents" ("id") ON DELETE CASCADE,
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "embedding" vector(1536) NOT NULL,
  "embedding_inputs_hash" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_document_embedding_hnsw"
  ON "document_embeddings" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX "idx_document_embeddings_kb"
  ON "document_embeddings" ("kb_id");

CREATE TABLE "chat_traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "subject_id" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "reasoning_effort" text NOT NULL,
  "question" text NOT NULL,
  "answer" text NOT NULL,
  "tool_calls" jsonb NOT NULL DEFAULT '[]',
  "claim_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "entity_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "turns" integer NOT NULL DEFAULT 0,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "compactions" integer NOT NULL DEFAULT 0,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_chat_trace_kb_created"
  ON "chat_traces" ("kb_id", "created_at" DESC);

CREATE INDEX "idx_chat_trace_entity_ids"
  ON "chat_traces" USING gin ("entity_ids");
