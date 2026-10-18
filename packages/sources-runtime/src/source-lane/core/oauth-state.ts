import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "./types.js";

/**
 * Single use for the donor HMAC-signed OAuth states (Slack, Notion; final-audit L3). The callback first validates the
 * signature and expiry as before, then records sha256(state) here: a second callback with the same state is refused.
 * Rows older than a day are pruned on the way (states expire after minutes).
 */
export async function consumeOAuthStateOnce(executor: DbExecutor, provider: string, state: string): Promise<boolean> {
  const sha = createHash("sha256").update(state, "utf8").digest("hex");
  await executor.execute(sql`DELETE FROM source_lane_oauth_state_uses WHERE consumed_at < now() - interval '1 day'`);
  const res = (await executor.execute(sql`
    INSERT INTO source_lane_oauth_state_uses (state_sha256, provider) VALUES (${sha}, ${provider})
    ON CONFLICT (state_sha256) DO NOTHING
    RETURNING state_sha256
  `)) as unknown as { rows?: unknown[] } | unknown[];
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.length === 1;
}
