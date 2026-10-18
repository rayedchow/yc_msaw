ALTER TABLE "kb_containers"
  ADD COLUMN "graph_version" text NOT NULL DEFAULT 'v1';

ALTER TABLE "kb_containers"
  ADD CONSTRAINT "ck_kb_containers_graph_version"
  CHECK ("graph_version" IN ('v1', 'v2'));
