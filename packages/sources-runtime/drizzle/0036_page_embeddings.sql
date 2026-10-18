CREATE TABLE "page_embeddings" (
  "page_id" uuid PRIMARY KEY REFERENCES "pages" ("id") ON DELETE CASCADE,
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "embedding" vector(1536) NOT NULL,
  "embedding_inputs_hash" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_page_embedding_hnsw"
  ON "page_embeddings" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX "idx_page_embeddings_kb"
  ON "page_embeddings" ("kb_id");
