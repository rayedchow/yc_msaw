import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => ({ events: [] as string[], removed: [] as string[] }));
vi.hoisted(() => {
  process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN = "notion-webhook-test-secret";
});

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
// Observe the removal step of the donor webhook (ledger-first ordering); everything else is real.
vi.mock("../../../../src/integrations/notion/poller.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../../src/integrations/notion/poller.js")>();
  return {
    ...real,
    removeNotionPageContent: vi.fn(async (userId: string, pageId: string) => {
      const h = await import("./harness.js");
      const rows = await h.query(`SELECT event_type FROM activity_events WHERE user_id = $1 AND source = 'notion'`, [userId]);
      order.events.push(...rows.map((r) => String(r.event_type)));
      order.removed.push(pageId);
    }),
  };
});

import { handleNotionWebhook } from "../../../../src/integrations/notion/webhook.js";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { notionProvider } from "../../../../src/source-lane/providers/notion/index.js";
import { NOTION_SOURCE_SWEEP_TASK, notionSourceTaskHandlers } from "../../../../src/source-lane/providers/notion/sweep.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import { sourceLaneTaskHandlers } from "../../../../src/source-lane/worker.js";
import { BOT_ID, FakeNotion, WORKSPACE_ID } from "./fake-notion.js";
import { drain, ID, makeExporter, P1_DIR, seedWorkspace, sweepUntilQuiet } from "./fixtures.js";
import { pg, query, ready, resetAll } from "./harness.js";

const T = "tenant-nm";

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  await query(`DELETE FROM integration_tokens`);
  order.events.length = 0;
  order.removed.length = 0;
});

function taskCtx(tenantId: string) {
  return { task: { id: "t-1", queue: "sync", tenantId, groupKey: `${tenantId}:notion`, kind: NOTION_SOURCE_SWEEP_TASK, payload: {}, attempt: 1, maxAttempts: 3, priority: 0, prevRunId: null }, heartbeat: vi.fn(async () => {}) };
}

function signed(event: Record<string, unknown>): { body: string; signature: string } {
  const body = JSON.stringify(event);
  return { body, signature: `sha256=${createHmac("sha256", "notion-webhook-test-secret").update(body).digest("hex")}` };
}

describe("notion provider module wiring", () => {
  it("registers once with its journaled tables, coverage and the sweep task, next to the donor notion handlers", () => {
    const registry = defaultRegistry();
    expect(registry.get("notion")).toBe(notionProvider);
    for (const t of ["notion_source_connections", "notion_source_nodes", "notion_source_files", "notion_source_records"]) {
      expect(registry.extraTable(t)?.provider.id).toBe("notion");
      expect(registry.extraTable(t)?.table).toMatchObject({ tenantColumn: "tenant_id", keyColumn: "row_key" });
    }
    expect(registry.forMirrorPath(`${P1_DIR}/page.md`)?.id).toBe("notion");
    expect(registry.forEventSource("notion")?.id).toBe("notion");
    const handlers = sourceLaneTaskHandlers(registry);
    expect(handlers[NOTION_SOURCE_SWEEP_TASK]).toBeTypeOf("function");
    expect(handlers["notion.poll"]).toBeTypeOf("function");
    expect(handlers["notion.render"]).toBeTypeOf("function");
  });

  it("ships its migrations in the lane plan and installs journal triggers that ignore sweep bookkeeping", async () => {
    expect(planMigrations().apply).toEqual(expect.arrayContaining(["9450_notion_source_lane.sql", "9451_notion_source_schedules.sql"]));
    const triggers = await query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_source_lane_journal_notion%' ORDER BY tgname`);
    expect(triggers.map((t) => t.tgname)).toEqual([
      "trg_source_lane_journal_notion_connections",
      "trg_source_lane_journal_notion_files",
      "trg_source_lane_journal_notion_nodes",
      "trg_source_lane_journal_notion_records",
    ]);
    await query(`INSERT INTO notion_source_nodes (tenant_id, row_key, connection_id, object_type, object_id, raw, raw_sha256) VALUES ($1, 'k', 'c', 'page', 'p', '{}'::jsonb, 'x')`, [T]);
    await query(`UPDATE notion_source_nodes SET walked_at = now(), walk_status = 'complete', seen_generation = 3, last_seen_at = now(), updated_at = now() WHERE row_key = 'k'`);
    expect((await query(`SELECT op FROM source_lane_journal WHERE tenant_id = $1 ORDER BY id`, [T])).map((r) => r.op)).toEqual(["INSERT"]);
    await query(`UPDATE notion_source_nodes SET path_epoch = path_epoch + 1 WHERE row_key = 'k'`);
    expect((await query(`SELECT op FROM source_lane_journal WHERE tenant_id = $1 ORDER BY id`, [T])).map((r) => r.op)).toEqual(["INSERT", "UPDATE"]);
  });

  it("schedules a sweep for every tenant with an active Notion connection (idempotent backfill migration)", async () => {
    await query(`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ($1, 'notion', 'ws-1', 'active'), ('tenant-gone', 'notion', 'ws-2', 'revoked'), ('tenant-slack', 'slack', 'x', 'active')`, [T]);
    const file = readFileSync(join(MIGRATIONS_DIR, "9451_notion_source_schedules.sql"), "utf8");
    await pg.exec(file);
    await pg.exec(file);
    const rows = await query(`SELECT tenant_id, queue, group_key, kind, payload, frequency_seconds, enabled FROM task_schedules WHERE kind = 'notion.source_sweep'`);
    expect(rows).toEqual([{ tenant_id: T, queue: "sync", group_key: `${T}:notion`, kind: "notion.source_sweep", payload: { tenantId: T }, frequency_seconds: 120, enabled: true }]);
  });

  it("the task handler takes the tenant from the task row and refuses a disagreeing payload tenant", async () => {
    const handler = notionSourceTaskHandlers({ clientOptions: { credential: async () => null } })[NOTION_SOURCE_SWEEP_TASK]!;
    await expect(handler({ tenantId: "someone-else" }, taskCtx(T) as never)).rejects.toThrow(/does not match/u);
    await expect(handler({}, taskCtx(T) as never)).resolves.toMatchObject({ tenantId: T, outcome: "no_connection" });
  });

  it("re-exports the lane's current state for a newly provisioned binding without new versions on replay", async () => {
    const fake = new FakeNotion();
    seedWorkspace(fake);
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const n = (await yc.paths()).length;
    const seen = yc.results.length;
    const counts = await exporter.enqueueTenantBackfill(T);
    expect(counts).toMatchObject({ notion_source_nodes: 11, notion_source_connections: 1 });
    await drain(exporter);
    const replay = yc.results.slice(seen);
    expect(replay.length).toBeGreaterThanOrEqual(n);
    expect(replay.every((r) => r.outcome === "unchanged")).toBe(true);
    expect((await yc.paths()).length).toBe(n);
  });
});

describe("notion webhook -> deep lane", () => {
  async function connectedTenant(): Promise<FakeNotion> {
    const fake = new FakeNotion();
    seedWorkspace(fake);
    await sweepUntilQuiet(T, fake);
    await query(`INSERT INTO integration_tokens (user_id, provider, access_token, metadata) VALUES ($1, 'notion', 'encrypted-placeholder', $2::jsonb)`, [T, JSON.stringify({ botId: BOT_ID, workspaceId: WORKSPACE_ID })]);
    return fake;
  }

  it("turns verified events into targeted refresh items and a sweep task; comment.deleted is confirmed by id", async () => {
    await connectedTenant();
    const res = await handleNotionWebhook(signed({ id: "evt-1", type: "page.content_updated", workspace_id: WORKSPACE_ID, entity: { id: ID.C1, type: "page" }, accessible_by: [{ id: BOT_ID, type: "bot" }] }));
    expect(res.status).toBe(204);
    const del = await handleNotionWebhook(signed({ id: "evt-2", type: "comment.deleted", workspace_id: WORKSPACE_ID, entity: { id: ID.CM3, type: "comment" }, data: { page_id: ID.P1, parent: { id: ID.P1, type: "page" } }, accessible_by: [{ id: BOT_ID, type: "bot" }] }));
    expect(del.status).toBe(204);
    const items = await query(`SELECT item_key, state FROM notion_source_work WHERE tenant_id = $1 AND state = 'pending' ORDER BY item_key`, [T]);
    expect(items.map((i) => i.item_key)).toEqual(expect.arrayContaining([`node:page:${ID.C1}`, `comments:${ID.P1}:page`, `comment_confirm:${ID.CM3}`, `finalize:${ID.P1}`]));
    const tasks = await query(`SELECT tenant_id, kind, group_key FROM task_queue WHERE kind = 'notion.source_sweep'`);
    expect(tasks).toEqual([{ tenant_id: T, kind: "notion.source_sweep", group_key: `${T}:notion` }]);
    // An unsigned event does nothing.
    expect((await handleNotionWebhook({ body: JSON.stringify({ type: "page.deleted", entity: { id: ID.P1, type: "page" } }), signature: "sha256=bad" })).status).toBe(401);
  });

  it("writes the page.deleted ledger event before removing content (ledger first)", async () => {
    await connectedTenant();
    const res = await handleNotionWebhook(signed({ id: "evt-del", type: "page.deleted", workspace_id: WORKSPACE_ID, entity: { id: ID.C1, type: "page" }, accessible_by: [{ id: BOT_ID, type: "bot" }] }));
    expect(res.status).toBe(204);
    expect(order.removed).toEqual([ID.C1]);
    expect(order.events).toContain("page_deleted");
    expect((await query(`SELECT item_key FROM notion_source_work WHERE tenant_id = $1 AND item_key = $2 AND state = 'pending'`, [T, `node:page:${ID.C1}`]))).toHaveLength(1);
  });
});
