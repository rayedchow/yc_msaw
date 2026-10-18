import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * perf-verification: the DM check of the Slack export (providers/slack/direct.ts isDirectChannel) must be an index
 * probe, not a scan of every Slack event of the tenant. Real PostgreSQL, own throwaway database, synthetic rows.
 */
const PG = process.env.SOURCES_TEST_PG_URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;

describe.skipIf(!PG)("Slack DM check uses the partial DM index (real PostgreSQL)", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `slack_dm_index_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.href, { max: 1, onnotice: () => {} });
    const { applySourceLaneMigrations } = await import("../../../../src/source-lane/core/migrations.js");
    await applySourceLaneMigrations(sql);
    await sql.unsafe(`
      INSERT INTO activity_events (user_id, source, record_kind, event_type, timestamp, raw_payload, source_event_id)
      SELECT 't-dm', 'slack', 'activity', 'message', now(), jsonb_build_object('channel', CASE WHEN g % 100 = 0 THEN 'D0000' || (g % 7) ELSE 'C0000' || (g % 50) END,
             'channel_type', CASE WHEN g % 100 = 0 THEN 'im' ELSE 'channel' END), 'e:' || g
      FROM generate_series(1, 30000) g`);
    await sql.unsafe(`ANALYZE activity_events`);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (adminSql && dbName) await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await adminSql?.end({ timeout: 5 });
  });

  it("answers a normal channel without scanning the tenant's Slack events", async () => {
    const q = `SELECT EXISTS (SELECT 1 FROM activity_events WHERE user_id = 't-dm' AND source = 'slack'
      AND COALESCE(raw_payload->>'_channel', raw_payload->>'channel') = 'C00007'
      AND COALESCE(raw_payload->>'_channel_type', raw_payload->>'channel_type') IN ('im','mpim')) AS direct`;
    const plan = (await sql.unsafe(`EXPLAIN ${q}`)).map((r: Any) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain("idx_activity_events_slack_direct");
    expect(plan).not.toMatch(/Seq Scan on activity_events/);
    expect((await sql.unsafe(q))[0].direct).toBe(false);
    expect((await sql.unsafe(q.replace("'C00007'", "'D00003'")))[0].direct).toBe(true);
  });

  it("answers Slack's own event channel_type with its partial index too (collector type still unknown)", async () => {
    await sql.unsafe(`INSERT INTO activity_events (user_id, source, record_kind, event_type, timestamp, raw_payload, source_event_id)
      VALUES ('t-dm', 'slack', 'activity', 'message', now(), '{"channel":"G0LATE","_channel":"G0LATE","channel_type":"mpim","_channel_type":"unknown"}'::jsonb, 'e:late')`);
    await sql.unsafe(`ANALYZE activity_events`);
    const q = `SELECT EXISTS (SELECT 1 FROM activity_events WHERE user_id = 't-dm' AND source = 'slack'
      AND COALESCE(raw_payload->>'_channel', raw_payload->>'channel') = 'C00007'
      AND raw_payload->>'channel_type' IN ('im','mpim')) AS direct`;
    const plan = (await sql.unsafe(`EXPLAIN ${q}`)).map((r: Any) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain("idx_activity_events_slack_direct_event_type");
    expect(plan).not.toMatch(/Seq Scan on activity_events/);
    expect((await sql.unsafe(q))[0].direct).toBe(false);
    expect((await sql.unsafe(q.replace("'C00007'", "'G0LATE'")))[0].direct).toBe(true);
  });
});
