import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { isDirectChannel, mapSlackEvent, mapSlackMirror, markDirectChannel, resetDirectChannelCacheForTests, withheldProjectionsOf } from "../../../../src/source-lane/providers/slack/direct.js";

/** Slack DM withholding edge cases: unknown conversation (fail closed) and DM metadata that arrives late. */
const pg = new PGlite();
const db = drizzle(pg);
const T = "tenant-slack-direct";
const ctx = { tenantId: T, executor: db as never };
const journal = { op: "INSERT" as const, enqueuedAt: "2027-01-20T12:00:00.000Z" };
const row = (path: string, meta: unknown) => ({ path, user_id: T, content: "x", content_sha: null, meta: meta as Record<string, unknown>, meta_sha: null, updated_at: journal.enqueuedAt });

beforeAll(async () => {
  for (const file of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
});
beforeEach(() => resetDirectChannelCacheForTests());

describe("Slack direct-message withholding", () => {
  it("withholds a donor projection whose conversation cannot be determined, keeps a known channel's", async () => {
    const unknown = await mapSlackMirror("sources/slack/notes-channel-abc123/threads/t.md", row("sources/slack/notes-channel-abc123/threads/t.md", { title: "?" }), ctx, journal);
    expect(unknown).toMatchObject([{ op: "delete", reason: "slack_direct_message_withheld" }]);
    const channel = await mapSlackMirror("sources/slack/general-channel-abc123/threads/t.md", row("sources/slack/general-channel-abc123/threads/t.md", { staged: { sourceAcl: { channelId: "C0GENERAL1" } } }), ctx, journal);
    expect(channel).toBeNull();
  });

  it("withholds already exported projections once a conversation turns out to be a group DM", async () => {
    await pg.query(`INSERT INTO mirror_files (path, user_id, content, meta, updated_at) VALUES ($1, $2, 'grp', $3::jsonb, now()), ($4, $2, 'pub', $5::jsonb, now())`, [
      "sources/slack/mpdm-a--b-channel-9f/threads/t1.md", T, JSON.stringify({ sourceAcl: { channelId: "G0MPIM123" } }),
      "sources/slack/general-channel-11/threads/t1.md", JSON.stringify({ sourceAcl: { channelId: "C0GENERAL1" } }),
    ]);
    const out = await withheldProjectionsOf(ctx, "G0MPIM123", journal.enqueuedAt);
    expect(out.map((c) => c.path)).toEqual(["sources/slack/mpdm-a--b-channel-9f/threads/t1.md"]);
    expect(out[0]).toMatchObject({ op: "delete", reason: "slack_direct_message_withheld" });
  });

  it("asks once per export pass about a conversation of unknown type, again in the next pass, and lets a DM found mid-pass win", async () => {
    let queries = 0;
    const counting = { execute: (q: unknown) => { queries++; return (db as unknown as { execute(q: unknown): Promise<unknown> }).execute(q); } };
    const pass1 = { tenantId: T, executor: counting as never };
    for (let i = 0; i < 50; i++) expect(await isDirectChannel(pass1, "C0NOMETA1")).toBe(false);
    expect(queries).toBe(1); // unpatched: one query per row
    markDirectChannel(T, "C0NOMETA1"); // its metadata arrived during the pass
    expect(await isDirectChannel(pass1, "C0NOMETA1")).toBe(true);
    resetDirectChannelCacheForTests();
    const pass2 = { tenantId: T, executor: counting as never };
    expect(await isDirectChannel(pass2, "C0NOMETA1")).toBe(false);
    expect(queries).toBe(2); // a new pass asks again: unknown answers never outlive their pass
  });

  it("withholds a realtime group-DM event whose collector type is still unknown (Slack's channel_type says mpim)", async () => {
    // Realtime events before the conversation has a watermark: _channel_type "unknown", Slack's own channel_type "mpim",
    // and a group-DM id that is not a D… id.
    const raw = { type: "message", channel: "G0LATEMPIM", channel_type: "mpim", ts: "1800000000.000100", text: "group dm: needle-late", _channel: "G0LATEMPIM", _channel_type: "unknown" };
    const ev = {
      id: "00000000-0000-4000-8000-000000000001", user_id: T, source: "slack", source_namespace: null, source_object_id: null, record_kind: null,
      event_type: "message", timestamp: journal.enqueuedAt, source_updated_at: null, raw_payload: raw, raw_payload_text: JSON.stringify(raw),
      extracted_entities: null, extracted_entities_text: null, source_event_id: "slack:G0LATEMPIM:1800000000.000100", created_at: journal.enqueuedAt,
    };
    const out = await mapSlackEvent(ev as never, ctx, journal);
    expect(out?.length).toBeGreaterThan(0);
    for (const c of out!) expect(c).toMatchObject({ op: "delete", reason: "slack_direct_message_withheld" });
    // A donor projection of that conversation is withheld too once such an event is stored (raw ledger check).
    await pg.query(`INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id, processing_status) VALUES ($1, 'slack', 'message', now(), $2::jsonb, $3, 'received')`, [T, JSON.stringify(raw), ev.source_event_id]);
    resetDirectChannelCacheForTests();
    expect(await isDirectChannel({ tenantId: T, executor: db as never }, "G0LATEMPIM")).toBe(true);
  });
});
