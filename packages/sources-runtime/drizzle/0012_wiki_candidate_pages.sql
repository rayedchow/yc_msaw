ALTER TABLE "wiki_candidates"
  ADD COLUMN "created_page_ids" uuid[],
  ADD COLUMN "judging_at" timestamp with time zone;
