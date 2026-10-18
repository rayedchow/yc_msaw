import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_MESSAGES_PER_INGEST_BATCH } from "../../../../src/source-lane/providers/imessage/ingest.js";
import { enroll, events, ingest, message, mirror, query, ready, resetTenant, wire, type Enrolled } from "./harness.js";

/**
 * POST /api/imessage/ingest identity and dedupe (donor canonical / GUID / legacy / alias
 * rules), batch bounds, parse failures and cursors, through the real route on PostgreSQL.
 */

const T = "acme";
let d: Enrolled;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetTenant(T);
  d = await enroll(T);
});

async function journalCount(table: string): Promise<number> {
  return Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = $1 AND table_name = $2`, [T, table]))[0]!.n);
}

describe("dedupe", () => {
  it("treats a replayed batch as skipped duplicates: no new rows, no mutations, no new journal entries", async () => {
    const batch = [message({ rowId: 1 }), message({ rowId: 2, text: "second" })];
    expect(await ingest(d, batch)).toMatchObject({ stored: 2, updated: 0, skipped: 0, total: 2 });
    const journaled = await journalCount("activity_events");
    const replay = await ingest(d, batch);
    expect(replay).toMatchObject({ stored: 0, updated: 0, skipped: 2, total: 2 });
    expect(await events(T)).toHaveLength(2);
    expect(await query(`SELECT 1 FROM imessage_message_mutations WHERE tenant_id = $1`, [T])).toHaveLength(0);
    expect(await journalCount("activity_events")).toBe(journaled);
  });

  it("stores one row for the same GUID seen through different chat aliases (iMessage/SMS/any) and records the aliases", async () => {
    await ingest(d, [message({ messageId: "G-ALIAS", chatId: "iMessage;-;+15550001111" })]);
    const r = await ingest(d, [message({ messageId: "G-ALIAS", chatId: "SMS;-;+15550001111", service: "SMS" }), message({ messageId: "G-ALIAS", chatId: "any;-;+15550001111" })]);
    expect(r).toMatchObject({ stored: 0, updated: 2 });
    const rows = await events(T);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_event_id).toBe("imessage:message:G-ALIAS");
    expect(rows[0]!.raw_payload._normalized_conversation_id).toBe("imessage:dm:+15550001111");
    expect(rows[0]!.raw_payload._observed_raw_chat_ids.sort()).toEqual(["SMS;-;+15550001111", "any;-;+15550001111", "iMessage;-;+15550001111"].sort());
    const aliases = await query<{ alias_source_event_id: string; canonical_source_event_id: string; reason: string }>(
      `SELECT alias_source_event_id, canonical_source_event_id, reason FROM activity_event_source_aliases WHERE user_id = $1 ORDER BY 1`,
      [T],
    );
    expect(aliases.map((a) => a.alias_source_event_id)).toEqual(["imessage:SMS;-;+15550001111:G-ALIAS", "imessage:any;-;+15550001111:G-ALIAS", "imessage:iMessage;-;+15550001111:G-ALIAS"].sort());
    expect(new Set(aliases.map((a) => a.canonical_source_event_id))).toEqual(new Set(["imessage:message:G-ALIAS"]));
    // Watermarks are kept for the normalized conversation only (raw chat ids folded away).
    expect((await query(`SELECT conversation_id FROM conversation_watermarks WHERE user_id = $1`, [T])).map((w: any) => w.conversation_id)).toEqual(["imessage:dm:+15550001111"]);
    // One projection, both raw chat ids listed.
    const summary = (await mirror(T)).find((f) => f.path.endsWith("/conversation.json"))!;
    expect(JSON.parse(summary.content).rawChatIds).toHaveLength(3);
  });

  it("folds a message repeated inside one batch into a single row", async () => {
    const r = await ingest(d, [message({ messageId: "G-TWICE" }), message({ messageId: "G-TWICE", chatId: "SMS;-;+15550001111" })]);
    expect(r).toMatchObject({ stored: 1, updated: 1, total: 2 });
    expect(await events(T)).toHaveLength(1);
  });

  it("keeps the same chat.db ROWID from two Macs (no GUID) as two messages, and dedupes per Mac", async () => {
    const a = { messageId: "42", providerMessageGuid: null, _provider_guid_explicit: null, rowId: 42, localRowId: 42 };
    const macA = message({ ...a, deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "from mac A" });
    const macB = message({ ...a, deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", text: "from mac B" });
    expect(await ingest(d, [macA])).toMatchObject({ stored: 1 });
    expect(await ingest(d, [macB])).toMatchObject({ stored: 1 });
    expect(await ingest(d, [macA])).toMatchObject({ stored: 0, skipped: 1 });
    const rows = await events(T);
    expect(rows.map((r) => r.raw_payload.text).sort()).toEqual(["from mac A", "from mac B"]);
    expect(rows.map((r) => r.source_event_id).sort()).toEqual([
      "imessage:local:device:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:imessage:dm:+15550001111:42",
      "imessage:local:device:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:imessage:dm:+15550001111:42",
    ]);
    // Two separately enrolled Macs without a device id are scoped by their binding.
    const d2 = await enroll(T);
    const noDevice = message({ ...a, deviceId: null, text: "binding scoped" });
    await ingest(d, [noDevice]);
    await ingest(d2, [noDevice]);
    expect((await events(T)).filter((r) => r.raw_payload.text === "binding scoped")).toHaveLength(2);
  });

  it("matches a donor legacy row by its legacy id and a GUID row across devices; archives a pre-existing duplicate", async () => {
    // A row written by the donor before canonical ids (legacy source_event_id, no canonical marker).
    const legacy = message({ messageId: "G-LEGACY", text: "legacy text" });
    await query(
      `INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id)
       VALUES ($1, 'imessage', 'message_received', '2026-09-10T12:00:00Z', $2::jsonb, 'imessage:iMessage;-;+15550001111:G-LEGACY')`,
      [T, JSON.stringify({ ...legacy, _normalized_conversation_id: "imessage:dm:+15550001111" })],
    );
    // And a second copy under the canonical id (the donor's duplicate case).
    await query(
      `INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id)
       VALUES ($1, 'imessage', 'message_received', '2026-09-10T12:00:00Z', $2::jsonb, 'imessage:message:G-LEGACY')`,
      [T, JSON.stringify({ ...legacy, _normalized_conversation_id: "imessage:dm:+15550001111", _resolved_name: "Grace" })],
    );
    const r = await ingest(d, [legacy]);
    expect(r.stored).toBe(0);
    const live = await events(T);
    expect(live).toHaveLength(1);
    expect(live[0]!.source_event_id).toBe("imessage:message:G-LEGACY");
    const archived = await events(T, "imessage_alias");
    expect(archived).toHaveLength(1);
    expect(archived[0]!.raw_payload).toMatchObject({ _archived_duplicate_source: "imessage", _canonical_event_id: live[0]!.id, _original_source_event_id: "imessage:iMessage;-;+15550001111:G-LEGACY" });
    const [alias] = await query(`SELECT alias_event_id::text AS alias_event_id, reason FROM activity_event_source_aliases WHERE user_id = $1 AND alias_source_event_id = 'imessage:iMessage;-;+15550001111:G-LEGACY'`, [T]);
    expect(alias).toEqual({ alias_event_id: archived[0]!.id, reason: "imessage_canonical_duplicate" });
    // A later upload of the same GUID from another Mac and another raw chat still lands on the canonical row.
    expect(await ingest(d, [message({ messageId: "G-LEGACY", text: "legacy text", chatId: "SMS;-;+15550001111", deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })])).toMatchObject({ stored: 0, updated: 1 });
    expect(await events(T)).toHaveLength(1);
  });
});

describe("batch bounds and parse failures", () => {
  it("accepts exactly 10000 messages and refuses 10001", async () => {
    expect(MAX_MESSAGES_PER_INGEST_BATCH).toBe(10_000);
    const big = Array.from({ length: 10_001 }, (_, i) => message({ rowId: i + 1, text: `m${i}` }));
    const refused = await wire("POST", "", d, { messages: big });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Maximum 10000 messages per batch" });
    expect(await events(T)).toHaveLength(0);
    const ok = await ingest(d, big.slice(0, 10_000));
    expect(ok).toMatchObject({ stored: 10_000, total: 10_000, rejected: 0 });
    expect(Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM activity_events WHERE user_id = $1`, [T]))[0]!.n)).toBe(10_000);
  }, 180_000);

  it("answers unusable bodies with the donor {error} shape and stores nothing", async () => {
    for (const body of ["{not json", JSON.stringify({}), JSON.stringify({ messages: [] }), JSON.stringify({ messages: "x" })]) {
      const res = await wire("POST", "", d, body);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as any).error).toBe("string");
    }
    expect(await events(T)).toHaveLength(0);
  });

  it("stores the valid entries of a batch, keeps the invalid ones verbatim as rejections, and reports them", async () => {
    const r = await ingest(d, [
      message({ rowId: 1, text: "ok \u0000with NUL" }),
      "not an object",
      message({ rowId: 2, chatId: "" }),
      message({ rowId: 3, messageId: "" }),
      message({ rowId: 4, createdAt: "yesterday-ish" }),
      message({ rowId: 5, editedAt: "garbage" }),
      message({ rowId: 6, text: 12 }),
    ]);
    expect(r).toMatchObject({ stored: 1, rejected: 6, skipped: 6, total: 7 });
    expect((await events(T))[0]!.raw_payload.text).toBe("ok with NUL");
    const rejections = await query<{ reason: string; batch_index: number; uploaded: unknown }>(`SELECT reason, batch_index, uploaded FROM imessage_ingest_rejections WHERE tenant_id = $1 ORDER BY batch_index`, [T]);
    expect(rejections.map((x) => [x.batch_index, x.reason])).toEqual([
      [1, "message must be a JSON object"],
      [2, "chatId is required"],
      [3, "messageId is required"],
      [4, "createdAt must be a valid timestamp"],
      [5, "editedAt must be a valid timestamp or null"],
      [6, "text must be a string or null"],
    ]);
    expect(rejections[0]!.uploaded).toBe("not an object");
    const status = (await (await (await import("./harness.js")).internal("GET", `/tenants/${T}/devices/imessage`, { tenant: T })).json()) as any;
    expect(status.coverage.find((c: any) => c.scope === "rejected-uploads")).toMatchObject({ state: "partial", counts: { rejected: 6 } });
  });
});

describe("cursors and progress", () => {
  it("keeps the conversation watermark monotonic and accumulates per-device sync progress", async () => {
    await ingest(d, [message({ rowId: 50 }), message({ rowId: 60 })], { syncProgress: { operationId: "op-1", syncKind: "first_fill", status: "running", totalCount: 100, scannedCount: 60 } });
    await ingest(d, [message({ rowId: 10 })], { syncProgress: { operationId: "op-1", syncKind: "first_fill", status: "completed", scannedCount: 100, completedAt: "2026-09-11T00:00:00Z" } });
    const [w] = await query<{ last_seen_ts: string }>(`SELECT last_seen_ts FROM conversation_watermarks WHERE user_id = $1`, [T]);
    expect(w!.last_seen_ts).toBe("60");
    const [p] = await query<any>(`SELECT * FROM imessage_sync_progress WHERE tenant_id = $1`, [T]);
    expect(p).toMatchObject({ binding_id: d.bindingId, operation_id: "op-1", status: "completed" });
    expect([Number(p.uploaded), Number(p.stored)]).toEqual([3, 3]);
    expect(p.progress).toMatchObject({ totalCount: 100, scannedCount: 100, completedAt: "2026-09-11T00:00:00.000Z" });
    const [dev] = await query<any>(`SELECT last_seen_at, last_device_id, last_agent_version FROM imessage_devices WHERE binding_id = $1`, [d.bindingId]);
    expect(dev.last_seen_at).toBeTruthy();
    expect(dev.last_agent_version).toBe("0.9.0-test");
  });
});
