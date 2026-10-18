import { expect } from "vitest";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { notionProvider } from "../../../../src/source-lane/providers/notion/index.js";
import { runNotionSweep, type SweepOptions, type SweepReport } from "../../../../src/source-lane/providers/notion/sweep.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { FakeNotion } from "./fake-notion.js";
import { bindingToken, db, query, YcStore } from "./harness.js";
import { credentialFor } from "./seed.js";

export * from "./seed.js";

export function sweepOptions(fake: FakeNotion, extra: Partial<SweepOptions> = {}): SweepOptions {
  return {
    clientOptions: { fetchImpl: fake.fetch, credential: credentialFor(), ...(extra.clientOptions ?? {}) },
    maxRequestsPerRun: 10_000,
    minRequestIntervalMs: 0,
    deltaIntervalMs: 0,
    fullScanIntervalMs: 365 * 24 * 3600_000,
    pageSize: 2,
    leaseOwner: "test-worker",
    sleep: async () => {},
    ...extra,
    ...(extra.clientOptions ? { clientOptions: { fetchImpl: fake.fetch, credential: credentialFor(), ...extra.clientOptions } } : {}),
  };
}

/** Run sweeps until nothing due is pending and the generation is closed (bounded). */
export async function sweepUntilQuiet(tenantId: string, fake: FakeNotion, extra: Partial<SweepOptions> = {}, max = 30): Promise<SweepReport[]> {
  const reports: SweepReport[] = [];
  for (let i = 0; i < max; i++) {
    const r = await runNotionSweep(db as never, tenantId, sweepOptions(fake, extra));
    reports.push(r);
    if (r.outcome !== "ran") return reports;
    const pending = await query<{ n: number }>(`SELECT count(*)::int AS n FROM notion_source_work WHERE tenant_id = $1 AND state = 'pending'`, [tenantId]);
    const open = await query<{ n: number }>(`SELECT count(*)::int AS n FROM notion_source_sync_state WHERE tenant_id = $1 AND generation_phase <> 'closed'`, [tenantId]);
    if (Number(pending[0]!.n) === 0 && Number(open[0]!.n) === 0) return reports;
    // Deferred items (finalizers waiting, retries) become due without real time passing.
    await query(`UPDATE notion_source_work SET not_before = NULL WHERE tenant_id = $1 AND state = 'pending'`, [tenantId]);
  }
  throw new Error("notion sweep did not settle");
}

export async function makeExporter(tenantId: string): Promise<{ exporter: SourceExporter; yc: YcStore }> {
  const yc = await YcStore.create(tenantId);
  await setTenantBinding(db as never, { tenantId, bindingId: "sb-0123456789abcdef", token: bindingToken(tenantId), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
  const exporter = new SourceExporter({ db: db as never, registry: new SourceProviderRegistry([notionProvider]), fetchImpl: yc.fetch, log: () => {} });
  return { exporter, yc };
}

export async function drain(exporter: SourceExporter): Promise<number> {
  let acked = 0;
  for (let i = 0; i < 100; i++) {
    const r = await exporter.runOnce();
    expect(r.deadLettered, "exporter dead-lettered a change").toBe(0);
    acked += r.acked;
    if (r.claimed === 0) return acked;
  }
  throw new Error("exporter did not drain");
}

/** Make a full pass due on the next run. */
export async function forceFullPass(tenantId: string): Promise<void> {
  await query(`UPDATE notion_source_sync_state SET generation_started_at = now() - interval '400 days' WHERE tenant_id = $1`, [tenantId]);
}
