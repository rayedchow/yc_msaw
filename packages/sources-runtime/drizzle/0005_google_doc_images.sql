-- Google Docs embedded-image bytes (base64), fetched within the contentUri's
-- ~30-min window. The contentUri itself is NEVER persisted (requester-scoped
-- access token). Capped per image and per doc.

CREATE TABLE "google_doc_images" (
  "user_id" text NOT NULL,
  "doc_id" text NOT NULL,
  "object_id" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'image',
  "alt_text" text,
  "mime_type" text,
  "sha256" text,
  "size_bytes" integer,
  "data_base64" text,
  "fetched_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_google_doc_image" ON "google_doc_images" ("user_id", "doc_id", "object_id");
CREATE INDEX "idx_google_doc_image_doc" ON "google_doc_images" ("user_id", "doc_id");
