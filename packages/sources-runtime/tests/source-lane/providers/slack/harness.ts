/**
 * Slack source-lane test harness: in-process PostgreSQL (PGlite) with the real donor source
 * migrations, core 9000-9002 and this provider's 9400 (journal triggers, ON CONFLICT ordering,
 * numeric ts comparisons and the quota slot statement run for real), an in-memory token vault,
 * and a controllable clock whose sleep advances time instead of waiting. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { INCLUDED_DONOR_MIGRATIONS, MIGRATIONS_DIR } from "../../../../src/source-lane/core/migrations.js";

export const pg = new PGlite();
export const db = drizzle(pg);

const LANE = ["9000_source_lane_export.sql", "9001_source_lane_donor_statements.sql", "9002_source_lane_tenant_locks.sql", "9400_slack_source_lane.sql"];

export const ready: Promise<void> = (async () => {
  for (const file of [...INCLUDED_DONOR_MIGRATIONS, ...LANE]) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
})();

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

export async function resetAll(): Promise<void> {
  await pg.exec(`
    TRUNCATE slack_source_quota, slack_source_workspaces, slack_source_conversations, slack_source_reconcile_seen,
      slack_source_chunks, slack_source_blobs, slack_source_files, activity_events, mirror_files, conversation_watermarks,
      thread_watermarks, source_lane_journal, source_lane_exported, source_lane_bindings, source_lane_tenant_locks,
      task_queue, connections, integration_tokens, outbox_events;
  `);
  tokens.clear();
}

/** In-memory replacement for vault/tokens.js (the real one encrypts with ENCRYPTION_KEY into integration_tokens). */
export const tokens = new Map<string, { token: string; metadata: Record<string, unknown> | null }>();

export const tokenVault = {
  async getTokenWithMetadata(userId: string, provider: string) {
    return tokens.get(`${userId}:${provider}`) ?? null;
  },
  async getTokenMetadata(userId: string, provider: string) {
    return tokens.get(`${userId}:${provider}`)?.metadata ?? null;
  },
  async getToken(userId: string, provider: string) {
    return tokens.get(`${userId}:${provider}`)?.token ?? null;
  },
  async mergeTokenMetadata(userId: string, provider: string, fields: Record<string, unknown>) {
    const cur = tokens.get(`${userId}:${provider}`);
    if (cur) cur.metadata = { ...(cur.metadata ?? {}), ...fields };
  },
  async storeToken(userId: string, provider: string, token: string, metadata: Record<string, unknown> | null) {
    tokens.set(`${userId}:${provider}`, { token, metadata });
  },
};

/** Connect a tenant: token in the vault (+ the integration_tokens marker row coverage reads) and a connections row. */
export async function connectSlack(tenantId: string, token: string, teamId: string | null, teamName = "Acme"): Promise<void> {
  tokens.set(`${tenantId}:slack`, { token, metadata: teamId ? { slackTeamId: teamId, slackUserId: "UME", teamName } : {} });
  await pg.query(`INSERT INTO integration_tokens (user_id, provider, access_token) VALUES ($1, 'slack', 'synthetic-ciphertext') ON CONFLICT DO NOTHING`, [tenantId]);
  await pg.query(
    `INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ($1, 'slack', $2, 'active') ON CONFLICT DO NOTHING`,
    [tenantId, teamId],
  );
}

/** Controllable clock: sleep() advances time immediately (rate-limit waits are observable, never real). */
export class Clock {
  t: number;
  slept: number[] = [];
  constructor(start = Date.parse("2027-01-20T12:00:00.000Z")) {
    this.t = start;
  }
  readonly now = (): number => this.t;
  readonly sleep = async (ms: number): Promise<void> => {
    this.slept.push(ms);
    this.t += ms;
  };
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Slack ts for an instant (seconds.micro, 6 digits like Slack). */
export function ts(ms: number, micro = 100): string {
  return `${Math.floor(ms / 1000)}.${String(micro).padStart(6, "0")}`;
}

export async function slackRows(tenantId: string): Promise<Array<{ id: string; source_event_id: string; event_type: string; raw_payload: Record<string, any>; source_namespace: string | null; source_object_id: string | null }>> {
  return query(
    `SELECT id::text AS id, source_event_id, event_type, raw_payload, source_namespace, source_object_id FROM activity_events
     WHERE user_id = $1 AND source = 'slack' ORDER BY source_event_id`,
    [tenantId],
  );
}

export async function conversationState(tenantId: string, channelId: string): Promise<Record<string, any>> {
  const [row] = await query(`SELECT * FROM slack_source_conversations WHERE tenant_id = $1 AND channel_id = $2`, [tenantId, channelId]);
  if (!row) throw new Error(`no conversation state for ${channelId}`);
  return row;
}
