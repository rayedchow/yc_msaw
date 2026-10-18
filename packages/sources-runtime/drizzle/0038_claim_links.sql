CREATE TABLE "claim_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "kb_id" uuid NOT NULL REFERENCES "kb_containers" ("id"),
  "claim_a_id" uuid NOT NULL REFERENCES "claims" ("id") ON DELETE CASCADE,
  "claim_b_id" uuid NOT NULL REFERENCES "claims" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "weight" real NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_claim_link_kind"
    CHECK ("kind" IN ('knn')),
  CONSTRAINT "ck_claim_link_normalized_pair"
    CHECK ("claim_a_id" < "claim_b_id")
);

CREATE UNIQUE INDEX "uq_claim_link_pair_kind"
  ON "claim_links" ("kb_id", "claim_a_id", "claim_b_id", "kind");

CREATE INDEX "idx_claim_links_kb_claim_a"
  ON "claim_links" ("kb_id", "claim_a_id");

CREATE INDEX "idx_claim_links_kb_claim_b"
  ON "claim_links" ("kb_id", "claim_b_id");
