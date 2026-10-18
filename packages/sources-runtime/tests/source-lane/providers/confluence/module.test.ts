import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import { sourceLaneTaskHandlers } from "../../../../src/source-lane/worker.js";
import { confluenceProvider } from "../../../../src/source-lane/providers/confluence/index.js";
import { CONFLUENCE_SWEEP_TASK, confluenceTaskHandlers } from "../../../../src/source-lane/providers/confluence/sweep.js";
import { FakeConfluence, NANGO_BASE, NANGO_KEY } from "./fake-confluence.js";
import { CONN, drain, makeExporter, ROOT, seedSite } from "./fixtures.js";
import { connect, pg, query, ready, resetAll } from "./harness.js";

const T = "tenant-md";

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
});

function taskCtx(tenantId: string) {
  return { task: { id: "t-1", queue: "sync", tenantId, groupKey: `${tenantId}:confluence:sweep`, kind: CONFLUENCE_SWEEP_TASK, payload: {}, attempt: 1, maxAttempts: 3, priority: 0, prevRunId: null }, heartbeat: vi.fn(async () => {}) };
}

describe("confluence provider module wiring", () => {
  it("is registered once with its tables, mappers, coverage and the sweep task, alongside the donor handlers", () => {
    const registry = defaultRegistry();
    expect(registry.get("confluence")).toBe(confluenceProvider);
    for (const t of ["confluence_source_sites", "confluence_source_objects", "confluence_source_records"]) {
      expect(registry.extraTable(t)?.provider.id).toBe("confluence");
      expect(registry.extraTable(t)?.table).toMatchObject({ tenantColumn: "tenant_id", keyColumn: "row_key" });
    }
    expect(registry.forMirrorPath(`${ROOT}/spaces/1/pages/2/page.md`)?.id).toBe("confluence");
    const handlers = sourceLaneTaskHandlers(registry);
    expect(handlers[CONFLUENCE_SWEEP_TASK]).toBeTypeOf("function");
    expect(handlers["nango.poll"]).toBeTypeOf("function");
  });

  it("ships its migrations in the lane plan", () => {
    const plan = planMigrations();
    expect(plan.apply).toEqual(expect.arrayContaining(["9200_confluence_source_lane.sql", "9201_confluence_sweep_schedules.sql"]));
  });

  it("schedules a sweep for every tenant with an active Confluence connection (idempotent backfill migration)", async () => {
    await connect(T, CONN);
    await connect("tenant-revoked", "conn-r", "confluence", "revoked");
    const file = readFileSync(join(MIGRATIONS_DIR, "9201_confluence_sweep_schedules.sql"), "utf8");
    await pg.exec(file);
    await pg.exec(file);
    const rows = await query(`SELECT tenant_id, queue, group_key, kind, payload, frequency_seconds, enabled FROM task_schedules WHERE kind = 'confluence.sweep'`);
    expect(rows).toEqual([{ tenant_id: T, queue: "sync", group_key: `${T}:confluence:sweep`, kind: "confluence.sweep", payload: { tenantId: T }, frequency_seconds: 300, enabled: true }]);
  });

  it("runs the sweep task for the task row's tenant only and refuses a mismatched payload tenant", async () => {
    const fake = new FakeConfluence();
    seedSite(fake);
    await connect(T, CONN);
    const handler = confluenceTaskHandlers({ clientOptions: { apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch }, maxRequestsPerSite: 10_000 })[CONFLUENCE_SWEEP_TASK]!;
    await expect(handler({ tenantId: "someone-else" }, taskCtx(T) as never)).rejects.toThrow(/does not match/u);
    const ctx = taskCtx(T);
    const out = (await handler({ tenantId: T }, ctx as never)) as Record<string, any>;
    expect(out.tenantId).toBe(T);
    expect(out.sites[0]).toMatchObject({ connectionId: CONN, outcome: "ran" });
    expect(ctx.heartbeat).toHaveBeenCalled();
    // A tenant without a Confluence connection makes no upstream call at all.
    const calls = fake.calls.length;
    expect((await handler({}, taskCtx("tenant-none") as never)) as Record<string, any>).toMatchObject({ connections: 0, sites: [] });
    expect(fake.calls.length).toBe(calls);
  });

  it("backfills existing deep-lane rows on (re)provisioning and republishes them unchanged", async () => {
    const fake = new FakeConfluence();
    seedSite(fake);
    await connect(T, CONN);
    const handler = confluenceTaskHandlers({ clientOptions: { apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch }, maxRequestsPerSite: 10_000 })[CONFLUENCE_SWEEP_TASK]!;
    for (let i = 0; i < 5; i++) await handler({}, taskCtx(T) as never);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const files = await yc.paths(ROOT);
    expect(files.length).toBeGreaterThan(20);
    const counts = await exporter.enqueueTenantBackfill(T);
    expect(counts.confluence_source_objects).toBeGreaterThan(0);
    expect(counts.confluence_source_records).toBeGreaterThan(0);
    const before = yc.results.length;
    await drain(exporter);
    const replayed = yc.results.slice(before).filter((r) => r.path.startsWith(ROOT));
    expect(replayed.length).toBe(files.length);
    expect(replayed.every((r) => r.outcome === "unchanged")).toBe(true);
    expect(await yc.paths(ROOT)).toEqual(files);
  });
});
