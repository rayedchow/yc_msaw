import { expect } from "vitest";
import { ConfluenceClient } from "../../../../src/source-lane/providers/confluence/api.js";
import { runConfluenceSweep, type SweepOptions, type SweepReport } from "../../../../src/source-lane/providers/confluence/sweep.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { confluenceProvider } from "../../../../src/source-lane/providers/confluence/index.js";
import { FakeConfluence, NANGO_BASE, NANGO_KEY } from "./fake-confluence.js";
import { bindingToken, db, query, YcStore } from "./harness.js";

export * from "./seed.js";

export function client(fake: FakeConfluence): ConfluenceClient {
  return new ConfluenceClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch });
}

export function sweepOptions(fake: FakeConfluence, extra: Partial<SweepOptions> = {}): SweepOptions {
  return { client: client(fake), maxRequestsPerSite: 10_000, deltaIntervalMs: 0, fullScanIntervalMs: 365 * 24 * 3600_000, siteRefreshMs: 3600_000, leaseOwner: "test-worker", ...extra };
}

/** Run sweeps until the site's generation is closed and nothing is pending (bounded). */
export async function sweepUntilQuiet(tenantId: string, fake: FakeConfluence, extra: Partial<SweepOptions> = {}, max = 20): Promise<SweepReport[]> {
  const reports: SweepReport[] = [];
  for (let i = 0; i < max; i++) {
    const r = await runConfluenceSweep(db as never, tenantId, sweepOptions(fake, extra));
    reports.push(r);
    const pending = await query<{ n: number }>(`SELECT count(*)::int AS n FROM confluence_source_work WHERE tenant_id = $1 AND state = 'pending' AND (not_before IS NULL OR not_before <= now())`, [tenantId]);
    const open = await query<{ n: number }>(`SELECT count(*)::int AS n FROM confluence_source_sync_state WHERE tenant_id = $1 AND generation_phase <> 'closed'`, [tenantId]);
    if (Number(pending[0]!.n) === 0 && Number(open[0]!.n) === 0) return reports;
    if (r.sites.some((s) => s.outcome === "deferred" || s.outcome === "blocked")) return reports;
  }
  throw new Error("sweep did not settle");
}

export async function makeExporter(tenantId: string): Promise<{ exporter: SourceExporter; yc: YcStore }> {
  const yc = await YcStore.create(tenantId);
  await setTenantBinding(db as never, { tenantId, bindingId: "sb-0123456789abcdef", token: bindingToken(tenantId), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
  const exporter = new SourceExporter({ db: db as never, registry: new SourceProviderRegistry([confluenceProvider]), fetchImpl: yc.fetch, log: () => {} });
  return { exporter, yc };
}

export async function drain(exporter: SourceExporter): Promise<number> {
  let acked = 0;
  for (let i = 0; i < 50; i++) {
    const r = await exporter.runOnce();
    expect(r.deadLettered, "exporter dead-lettered a change").toBe(0);
    acked += r.acked;
    if (r.claimed === 0) return acked;
  }
  throw new Error("exporter did not drain");
}

export async function journalCount(tenantId: string): Promise<number> {
  return Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = $1`, [tenantId]))[0]!.n);
}
