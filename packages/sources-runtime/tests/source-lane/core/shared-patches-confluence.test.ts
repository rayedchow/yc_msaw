import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/client.js", async () => {
  const h = await import("../providers/stripe/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, pg, query, ready } from "../providers/stripe/harness.js";
import { startNangoPolling } from "../../../src/queue/dispatch.js";
import { disableNangoPollSchedule } from "../../../src/integrations/nango/tasks.js";
import { processConfluencePageRecord } from "../../../src/integrations/atlassian/processors.js";

/** Regressions for confluence patch requests 1-3 (shared dispatch.ts, nango/tasks.ts, atlassian/processors.ts). PGlite, real SQL. */
beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM task_schedules; DELETE FROM activity_events WHERE source = 'confluence'; DELETE FROM mirror_files;`);
});

describe("confluence shared patches", () => {
  it("startNangoPolling schedules the Confluence deep sweep in its own group (request 1)", async () => {
    await startNangoPolling("t-cf", "confluence");
    const rows = await query<{ kind: string; group_key: string; frequency_seconds: number }>(`SELECT kind, group_key, frequency_seconds FROM task_schedules WHERE tenant_id = 't-cf' ORDER BY kind`);
    expect(rows.map((r) => [r.kind, r.group_key, r.frequency_seconds])).toEqual([
      ["confluence.sweep", "t-cf:confluence:sweep", 300],
      ["nango.poll", "t-cf:nango:confluence", 60],
    ]);
    await startNangoPolling("t-cf", "jira");
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM task_schedules WHERE kind = 'confluence.sweep'`))[0]!.n).toBe(1);
  });

  it("disableNangoPollSchedule also disables the Confluence deep sweep (request 2)", async () => {
    await startNangoPolling("t-cf2", "confluence");
    await disableNangoPollSchedule(db as never, "t-cf2", "confluence");
    expect(await query(`SELECT kind, enabled FROM task_schedules WHERE tenant_id = 't-cf2' ORDER BY kind`))
      .toEqual([{ kind: "confluence.sweep", enabled: false }, { kind: "nango.poll", enabled: false }]);
  });

  it("raw ids use the Confluence version, not the per-delivery Nango cursor; tombstones stay distinct (request 3)", async () => {
    const page = { id: "page-7", spaceId: "ENG", title: "P", versionNumber: 7, bodyStorage: "<p>x</p>" };
    await processConfluencePageRecord(db as never, { ...page, _nango_metadata: { cursor: "Y3Vyc29yLTE=", last_modified_at: "2026-07-03T00:00:00.000Z" } } as never, { tenantId: "t-cf3" } as never);
    await processConfluencePageRecord(db as never, { ...page, _nango_metadata: { cursor: "Y3Vyc29yLTI=", last_modified_at: "2026-07-04T00:00:00.000Z" } } as never, { tenantId: "t-cf3" } as never);
    await processConfluencePageRecord(db as never, { ...page, _nango_metadata: { cursor: "Y3Vyc29yLTM=", last_action: "DELETED", deleted_at: "2026-07-05T00:00:00.000Z" } } as never, { tenantId: "t-cf3" } as never);
    const ids = (await query<{ source_event_id: string }>(`SELECT source_event_id FROM activity_events WHERE user_id = 't-cf3' ORDER BY source_event_id`)).map((r) => r.source_event_id);
    expect(ids).toEqual(["nango:confluence:page:page-7:v7", "nango:confluence:page:page-7:v7:deleted:2026-07-05T00:00:00.000Z"]);
  });
});
