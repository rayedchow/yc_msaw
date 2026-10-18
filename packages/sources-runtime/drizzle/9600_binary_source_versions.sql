-- Binary source lane: donor binary_documents rows (bytes in S3 at binary/<tenant>/<sha256>) exported as exact
-- binary source files. binary_documents keeps only the latest bytes per (tenant, provider, external_id), so every
-- byte state it ever pointed at is recorded here, append-only, and exported as an immutable version file.
-- `chunks` is the export-time 8 MiB chunk manifest (whole-object sha verified against sha256 while it is built);
-- it and the manifest_* bookkeeping are ignored by the journal so recording them never re-exports the row.
CREATE TABLE IF NOT EXISTS "binary_document_versions" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "binary_documents" ("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "sha256" text NOT NULL,
  "size_bytes" bigint,
  "mime_type" text NOT NULL,
  "storage_key" text NOT NULL,
  "version_ref" text,
  "source_updated_at" timestamptz,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  "document_tombstoned_at" timestamptz,
  "chunks" jsonb,
  "manifest_error" text,
  "manifest_attempts" integer NOT NULL DEFAULT 0,
  "manifest_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "idx_binary_document_versions_document" ON "binary_document_versions" ("tenant_id", "document_id", "captured_at");

CREATE OR REPLACE FUNCTION "binary_document_version_capture"() RETURNS trigger AS $$
BEGIN
  IF NEW.sha256 IS NOT NULL AND NEW.storage_key IS NOT NULL THEN
    INSERT INTO binary_document_versions (id, tenant_id, document_id, provider, external_id, sha256, size_bytes, mime_type,
                                          storage_key, version_ref, source_updated_at, document_tombstoned_at)
    VALUES (NEW.id::text || ':' || NEW.sha256, NEW.tenant_id, NEW.id, NEW.provider, NEW.external_id, NEW.sha256, NEW.size_bytes,
            NEW.mime_type, NEW.storage_key, NEW.version_ref, NEW.source_updated_at, NEW.tombstoned_at)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  -- Withdraw / restore of the document withdraws / restores its history with it.
  IF TG_OP = 'UPDATE' AND NEW.tombstoned_at IS DISTINCT FROM OLD.tombstoned_at THEN
    UPDATE binary_document_versions SET document_tombstoned_at = NEW.tombstoned_at
    WHERE document_id = NEW.id AND document_tombstoned_at IS DISTINCT FROM NEW.tombstoned_at;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_binary_document_version_capture"
  AFTER INSERT OR UPDATE ON "binary_documents"
  FOR EACH ROW EXECUTE FUNCTION "binary_document_version_capture"();

-- Rows captured before this lane existed: their current bytes are their first recorded version.
INSERT INTO binary_document_versions (id, tenant_id, document_id, provider, external_id, sha256, size_bytes, mime_type,
                                      storage_key, version_ref, source_updated_at, captured_at, document_tombstoned_at)
SELECT id::text || ':' || sha256, tenant_id, id, provider, external_id, sha256, size_bytes, mime_type, storage_key,
       version_ref, source_updated_at, updated_at, tombstoned_at
FROM binary_documents WHERE sha256 IS NOT NULL AND storage_key IS NOT NULL
ON CONFLICT (id) DO NOTHING;

CREATE TRIGGER "trg_source_lane_journal_binary_documents"
  AFTER INSERT OR UPDATE OR DELETE ON "binary_documents"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'updated_at');

CREATE TRIGGER "trg_source_lane_journal_binary_document_versions"
  AFTER INSERT OR UPDATE OR DELETE ON "binary_document_versions"
  FOR EACH ROW EXECUTE FUNCTION "source_lane_journal_row"('tenant_id', 'id', 'chunks', 'manifest_error', 'manifest_attempts', 'manifest_at');
