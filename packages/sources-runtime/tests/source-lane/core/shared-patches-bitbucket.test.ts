import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/client.js", async () => {
  const h = await import("../providers/bitbucket/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, pg, query, ready } from "../providers/bitbucket/harness.js";
import { startNangoPolling } from "../../../src/queue/dispatch.js";
import { disableNangoPollSchedule } from "../../../src/integrations/nango/tasks.js";

/** Regressions for bitbucket patch requests 1-2 (shared dispatch.ts, nango/tasks.ts). PGlite, real SQL. */
beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM task_schedules;`);
});

describe("bitbucket shared patches", () => {
  it("startNangoPolling schedules the Bitbucket content sweep in its own group (request 1)", async () => {
    await startNangoPolling("t-bb", "bitbucket");
    const rows = await query<{ kind: string; group_key: string; frequency_seconds: number; payload: unknown }>(
      `SELECT kind, group_key, frequency_seconds, payload FROM task_schedules WHERE tenant_id = 't-bb' ORDER BY kind`,
    );
    expect(rows).toContainEqual({ kind: "bitbucket.content_sweep", group_key: "t-bb:bitbucket:content", frequency_seconds: 300, payload: { tenantId: "t-bb" } });
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["nango.poll", "nango.proxy_issues", "nango.proxy_details"]));
    await startNangoPolling("t-bb", "bitbucket");
    await startNangoPolling("t-bb", "github");
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM task_schedules WHERE kind = 'bitbucket.content_sweep'`))[0]!.n).toBe(1);
  });

  it("disableNangoPollSchedule also disables the Bitbucket content sweep, and reconnecting re-enables it (request 2)", async () => {
    await startNangoPolling("t-bb2", "bitbucket");
    await disableNangoPollSchedule(db as never, "t-bb2", "bitbucket");
    expect((await query<{ enabled: boolean }>(`SELECT enabled FROM task_schedules WHERE tenant_id = 't-bb2' AND kind = 'bitbucket.content_sweep'`))[0]!.enabled).toBe(false);
    await startNangoPolling("t-bb2", "bitbucket");
    expect((await query<{ enabled: boolean }>(`SELECT enabled FROM task_schedules WHERE tenant_id = 't-bb2' AND kind = 'bitbucket.content_sweep'`))[0]!.enabled).toBe(true);
  });
});
