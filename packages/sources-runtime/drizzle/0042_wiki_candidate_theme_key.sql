ALTER TABLE "wiki_candidates"
  ADD COLUMN "theme_key" text;

CREATE INDEX "idx_wiki_candidate_kb_theme_key"
  ON "wiki_candidates" ("kb_id", "theme_key")
  WHERE "theme_key" IS NOT NULL;
