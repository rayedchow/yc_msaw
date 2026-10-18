/**
 * Granola source-lane test harness: in-process PostgreSQL (PGlite) with the real donor source
 * migrations, core 9000-9002 and this provider's 9500 (catalog trigger, journal trigger, state
 * tables run for real), an in-memory token vault, and a minimal yc_msaw publish endpoint that
 * keeps every version per path. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { INCLUDED_DONOR_MIGRATIONS, MIGRATIONS_DIR } from "../../../../src/source-lane/core/migrations.js";

export const pg = new PGlite();
const pgliteDb = drizzle(pg);
/**
 * drizzle/pglite's execute() resolves to `{ rows }`; drizzle/postgres-js (production) to the row
 * array. Donor code reads the array form, lane code accepts both: hand back an array that also
 * carries `rows`, so every caller sees what it sees in production.
 */
export const db = new Proxy(pgliteDb, {
  get(target, prop, receiver) {
    if (prop !== "execute") return Reflect.get(target, prop, receiver);
    return async (query: Parameters<typeof pgliteDb.execute>[0]) => {
      const result = await target.execute(query);
      return Object.assign([...result.rows], { rows: result.rows, fields: result.fields });
    };
  },
});

const LANE = ["9000_source_lane_export.sql", "9001_source_lane_donor_statements.sql", "9002_source_lane_tenant_locks.sql", "9500_granola_source_lane.sql"];

export const ready: Promise<void> = (async () => {
  for (const file of [...INCLUDED_DONOR_MIGRATIONS, ...LANE]) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
})();

export async function query<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

export async function resetAll(): Promise<void> {
  await pg.exec(`
    TRUNCATE granola_source_state, granola_source_quota, granola_source_notes, activity_events, mirror_files,
      conversation_watermarks, source_lane_journal, source_lane_exported, source_lane_bindings, source_lane_tenant_locks,
      task_queue, connections, integration_tokens, outbox_events, source_sync_runs;
  `);
  tokens.clear();
}

type StoredToken = { token: string; refreshToken: string | null; metadata: Record<string, unknown> | null };
/** In-memory replacement for vault/tokens.js (the real one encrypts into integration_tokens). */
export const tokens = new Map<string, StoredToken>();

export const tokenVault = {
  async getTokenFull(userId: string, provider: string) {
    const t = tokens.get(`${userId}:${provider}`);
    return t ? { ...t, metadata: t.metadata ? { ...t.metadata } : null } : null;
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
  async storeToken(userId: string, provider: string, token: string, metadata: Record<string, unknown> | null, refreshToken?: string) {
    tokens.set(`${userId}:${provider}`, { token, refreshToken: refreshToken ?? null, metadata });
  },
  async deleteToken(userId: string, provider: string) {
    tokens.delete(`${userId}:${provider}`);
  },
};

/** Connect a tenant with an API key: vault entry, the integration_tokens marker row coverage reads, a connections row. */
export async function connectGranola(tenantId: string, apiKey: string, metadata: Record<string, unknown> = {}): Promise<void> {
  tokens.set(`${tenantId}:granola`, {
    token: apiKey,
    refreshToken: null,
    metadata: { auth_mode: "api_key", includeTranscript: true, folderId: null, lastUpdatedAt: "2027-01-01T00:00:00.000Z", ...metadata },
  });
  await pg.query(`INSERT INTO integration_tokens (user_id, provider, access_token) VALUES ($1, 'granola', 'synthetic-ciphertext') ON CONFLICT DO NOTHING`, [tenantId]);
  await pg.query(`INSERT INTO connections (tenant_id, provider, status) VALUES ($1, 'granola', 'active') ON CONFLICT DO NOTHING`, [tenantId]);
}

export async function granolaRows(tenantId: string): Promise<Array<{ id: string; source_event_id: string; event_type: string; raw_payload: Record<string, any>; source_object_id: string | null }>> {
  return query(
    `SELECT id::text AS id, source_event_id, event_type, raw_payload, source_object_id FROM activity_events
      WHERE user_id = $1 AND source = 'granola' ORDER BY created_at, source_event_id`,
    [tenantId],
  );
}

export async function laneState(tenantId: string): Promise<Record<string, any>> {
  const [row] = await query(`SELECT * FROM granola_source_state WHERE tenant_id = $1`, [tenantId]);
  if (!row) throw new Error(`no granola_source_state for ${tenantId}`);
  return row;
}

export async function catalog(tenantId: string, noteId: string): Promise<Record<string, any> | undefined> {
  const [row] = await query(`SELECT * FROM granola_source_notes WHERE tenant_id = $1 AND note_id = $2`, [tenantId, noteId]);
  return row;
}

export async function mirror(tenantId: string): Promise<Map<string, string>> {
  const rows = await query<{ path: string; content: string }>(`SELECT path, content FROM mirror_files WHERE user_id = $1 AND path LIKE 'sources/granola/%' ORDER BY path`, [tenantId]);
  return new Map(rows.map((r) => [r.path, r.content]));
}

export { bindingToken, PublishStore, type PublishedVersion } from "./publish.js";
