-- Slack attachment bytes ride the existing binary_documents lane. Widen the
-- check constraints (value additions only; no columns or rows change):
--   provider     += 'slack'  (Slack message file attachments)
--   parse_status += 'stored' (bytes captured for a non-PDF type; raw capture
--                             only, no parse pipeline)

ALTER TABLE "binary_documents" DROP CONSTRAINT IF EXISTS "ck_binary_document_provider";
ALTER TABLE "binary_documents" ADD CONSTRAINT "ck_binary_document_provider"
  CHECK ("provider" IN ('drive-pdf', 'upload', 'slack'));

ALTER TABLE "binary_documents" DROP CONSTRAINT IF EXISTS "ck_binary_document_parse_status";
ALTER TABLE "binary_documents" ADD CONSTRAINT "ck_binary_document_parse_status"
  CHECK ("parse_status" IN ('pending', 'parsed', 'failed_fetch', 'failed_unsupported', 'stored'));
