-- perf-verification: providers/slack/direct.ts isDirectChannel() asks, per conversation and minute, whether any raw
-- Slack event of the tenant marks the conversation as a DM. Without an index the common negative answer scans every
-- Slack event of the tenant (137 ms at 500k events). Only DM events are indexed, so the index stays tiny.
CREATE INDEX IF NOT EXISTS "idx_activity_events_slack_direct"
  ON "activity_events" ("user_id", (COALESCE("raw_payload" ->> '_channel', "raw_payload" ->> 'channel')))
  WHERE "source" = 'slack' AND COALESCE("raw_payload" ->> '_channel_type', "raw_payload" ->> 'channel_type') IN ('im', 'mpim');
