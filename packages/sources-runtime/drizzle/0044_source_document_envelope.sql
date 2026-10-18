ALTER TABLE "mirror_files" ADD COLUMN "meta_sha" text;

ALTER TABLE "source_documents"
  ADD COLUMN "author_email" text,
  ADD COLUMN "author_name" text,
  ADD COLUMN "updated_by_email" text,
  ADD COLUMN "aliases" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "source_refs" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "source_documents" DROP CONSTRAINT "ck_source_document_kind";
ALTER TABLE "source_documents"
  ADD CONSTRAINT "ck_source_document_kind"
  CHECK ("kind" IN ('document', 'conversation_window', 'transcript', 'code_file', 'comments', 'synthesis'));
