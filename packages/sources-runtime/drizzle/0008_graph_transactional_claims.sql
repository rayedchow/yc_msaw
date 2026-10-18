ALTER TABLE "chunk_extractions"
  ADD COLUMN "started_at" timestamp with time zone;

ALTER TABLE "chunk_extractions" DROP CONSTRAINT "ck_chunk_extraction_status";
ALTER TABLE "chunk_extractions"
  ADD CONSTRAINT "ck_chunk_extraction_status"
  CHECK ("status" IN ('pending', 'running', 'completed', 'failed'));

CREATE UNIQUE INDEX "uq_chunk_claim_provenance"
  ON "chunks" ("id", "document_id", "kb_id", "chunk_hash");

ALTER TABLE "claims"
  ADD CONSTRAINT "fk_claim_chunk_provenance"
  FOREIGN KEY ("chunk_id", "document_id", "kb_id", "chunk_hash")
  REFERENCES "chunks" ("id", "document_id", "kb_id", "chunk_hash");

CREATE UNIQUE INDEX "uq_claim_extraction_live"
  ON "claims" ("chunk_id", "extractor_version", "text")
  WHERE "chunk_id" IS NOT NULL AND "invalid_at" IS NULL;
