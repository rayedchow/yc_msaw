-- Gmail attachment bytes reuse the existing S3 + binary_documents lane as a
-- new provider value. Widening the provider CHECK is additive: the existing
-- values (including 'slack' from 0028) remain valid, one new value is allowed.

ALTER TABLE "binary_documents" DROP CONSTRAINT IF EXISTS "ck_binary_document_provider";
ALTER TABLE "binary_documents" ADD CONSTRAINT "ck_binary_document_provider"
  CHECK ("provider" IN ('drive-pdf', 'upload', 'slack', 'gmail-attachment'));
