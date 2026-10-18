-- Replay inputs are copied into a shadow KB before graph-v2 extraction. These
-- nullable lineage columns give each source row one stable copy per shadow KB
-- while leaving ordinary ingestion rows unchanged.
ALTER TABLE "source_documents"
  ADD COLUMN "replay_of_document_id" uuid
  REFERENCES "source_documents" ("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX "uq_source_document_kb_replay_source"
  ON "source_documents" ("kb_id", "replay_of_document_id")
  WHERE "replay_of_document_id" IS NOT NULL;

ALTER TABLE "chunks"
  ADD COLUMN "replay_of_chunk_id" uuid
  REFERENCES "chunks" ("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX "uq_chunk_kb_replay_source"
  ON "chunks" ("kb_id", "replay_of_chunk_id")
  WHERE "replay_of_chunk_id" IS NOT NULL;
