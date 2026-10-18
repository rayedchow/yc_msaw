-- Content-addressed binary raw store. The row is the capture-time metadata;
-- bytes live in S3 at storage_key.

CREATE TABLE "binary_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "sha256" text,
  "mime_type" text NOT NULL,
  "size_bytes" bigint,
  "storage_key" text,
  "version_ref" text,
  "source_updated_at" timestamp with time zone,
  "author_email" text,
  "source_acl" jsonb NOT NULL DEFAULT '{}',
  "parse_status" text NOT NULL DEFAULT 'pending',
  "tombstoned_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_binary_document_provider" CHECK ("provider" IN ('drive-pdf', 'upload')),
  CONSTRAINT "ck_binary_document_parse_status" CHECK ("parse_status" IN ('pending', 'parsed', 'failed_fetch', 'failed_unsupported'))
);

CREATE UNIQUE INDEX "uq_binary_document_origin" ON "binary_documents" ("tenant_id", "provider", "external_id");
CREATE INDEX "idx_binary_document_tenant_parse_status" ON "binary_documents" ("tenant_id", "parse_status");
