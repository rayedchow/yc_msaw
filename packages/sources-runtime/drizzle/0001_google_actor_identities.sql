-- Google People identity cache: Drive Activity person IDs resolved to
-- email/name, user-scoped (People API visibility is per-requester).
-- status: resolved (email visible) | partial (name only) | unresolved.
-- Partial/unresolved rows carry next_retry_at backoff so permanently
-- invisible actors aren't re-fetched every poll cycle.

CREATE TABLE "google_actor_identities" (
  "user_id" text NOT NULL,
  "person_id" text NOT NULL,
  "email" text,
  "display_name" text,
  "status" text NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_retry_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_google_actor_identity" ON "google_actor_identities" ("user_id", "person_id");
CREATE INDEX "idx_google_actor_identity_retry" ON "google_actor_identities" ("user_id", "next_retry_at");
