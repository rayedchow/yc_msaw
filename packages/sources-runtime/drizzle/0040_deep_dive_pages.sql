ALTER TABLE "pages"
  DROP CONSTRAINT "ck_page_kind";

ALTER TABLE "pages"
  ADD CONSTRAINT "ck_page_kind"
  CHECK ("kind" IN (
    'entity',
    'topic',
    'standard',
    'module',
    'generation',
    'codebase_map',
    'index',
    'procedure',
    'deep_dive'
  ));
