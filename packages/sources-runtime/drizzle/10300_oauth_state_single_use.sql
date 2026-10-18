-- final-audit L3: the donor Slack and Notion OAuth `state` is HMAC + expiry only, so one state could be replayed
-- until it expires. A state is now accepted once: its sha256 is recorded at the callback (no state value stored).
CREATE TABLE IF NOT EXISTS source_lane_oauth_state_uses (
  state_sha256 text PRIMARY KEY,
  provider text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_lane_oauth_state_uses_consumed_at ON source_lane_oauth_state_uses (consumed_at);
