CREATE TABLE "thread_watermarks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "thread_ts" text NOT NULL,
  "last_reply_ts" text,
  "reply_count" text,
  "last_polled_at" timestamptz,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "uq_thread_watermark_user_channel_thread"
  ON "thread_watermarks" ("user_id", "channel_id", "thread_ts");
CREATE INDEX "idx_thread_watermark_user_active"
  ON "thread_watermarks" ("user_id", "is_active");
CREATE INDEX "idx_thread_watermark_channel_active"
  ON "thread_watermarks" ("user_id", "channel_id", "is_active");
