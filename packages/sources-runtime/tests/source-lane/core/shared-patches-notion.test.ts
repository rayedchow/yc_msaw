import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/client.js", async () => {
  const h = await import("../providers/notion/harness.js");
  return { db: h.db, pgClient: null };
});

import { pg, query, ready } from "../providers/notion/harness.js";
import { startNotionPolling } from "../../../src/queue/dispatch.js";

/** Regression for notion patch requests 1-2 (shared dispatch.ts). PGlite, real SQL. */
beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM task_schedules;`);
});

describe("notion shared patches", () => {
  it("startNotionPolling schedules the Notion deep sweep on the donor notion group and slows the donor poll (requests 1, 2)", async () => {
    await startNotionPolling("t-no");
    await startNotionPolling("t-no");
    const rows = await query<{ kind: string; group_key: string; frequency_seconds: number; payload: unknown }>(
      `SELECT kind, group_key, frequency_seconds, payload FROM task_schedules WHERE tenant_id = 't-no' AND kind LIKE 'notion.%' ORDER BY kind`,
    );
    expect(rows.map((r) => [r.kind, r.group_key, r.frequency_seconds])).toEqual([
      ["notion.poll", "t-no:notion", 300],
      ["notion.reconcile", "t-no:notion", 3600],
      ["notion.render", "t-no:notion", 60],
      ["notion.source_sweep", "t-no:notion", 120],
    ]);
    expect(rows.find((r) => r.kind === "notion.source_sweep")!.payload).toEqual({ tenantId: "t-no" });
  });
});
