-- Realtime Slack events carry Slack's own `channel_type` (im/mpim) next to the collector's `_channel_type`, which is
-- "unknown" when the conversation has no watermark yet. providers/slack/direct.ts treats either as a DM; this partial
-- index keeps the second check as cheap as the first (9401). Only DM events are indexed.
CREATE INDEX IF NOT EXISTS "idx_activity_events_slack_direct_event_type"
  ON "activity_events" ("user_id", (COALESCE("raw_payload" ->> '_channel', "raw_payload" ->> 'channel')))
  WHERE "source" = 'slack' AND "raw_payload" ->> 'channel_type' IN ('im', 'mpim');
