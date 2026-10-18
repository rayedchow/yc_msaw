-- Google Retry-After cooldowns of the legacy donor Google Docs tasks (gdocs.poll, discovery, comment-sweep/refresh,
-- actor-repair, suggestion-sync, content-snapshot), shared by every runtime process.
-- Those tasks call Google through gFetch / fetchDocContent, whose cooldown lived only in the process. After a restart,
-- or in a second worker, a task could call Google before a valid long Retry-After had passed. The keys are the ones
-- the in-process map uses: `google-workspace` (project-wide limits), `google-workspace:cred:<sha256 prefix>` (per-user
-- quota of one credential; never the token itself) and `google-docs-api`. blocked_until only ever moves later.
CREATE TABLE IF NOT EXISTS "google_rate_limit_cooldowns" (
  "service_key" text PRIMARY KEY,
  "blocked_until" timestamptz NOT NULL,
  "last_status" integer,
  "last_reason" text,
  "last_retry_after_seconds" double precision,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
