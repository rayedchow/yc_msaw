import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { mapSlackMirror, resetDirectChannelCacheForTests, withheldProjectionsOf } from "../../../../src/source-lane/providers/slack/direct.js";

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
});
