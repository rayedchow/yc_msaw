import { expect } from "vitest";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { BitbucketClient } from "../../../../src/source-lane/providers/bitbucket/api.js";
import { runBitbucketContentSweep, type ContentSweepOptions, type ContentSweepReport } from "../../../../src/source-lane/providers/bitbucket/content.js";
import { bitbucketProvider } from "../../../../src/source-lane/providers/bitbucket/index.js";
import { setSelection, type BitbucketDb } from "../../../../src/source-lane/providers/bitbucket/store.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { FakeBitbucket, NANGO_BASE, NANGO_KEY } from "./fake-bitbucket.js";
import { db } from "./harness.js";
import { BINDING_ID, bindingToken, YcStore } from "./yc-store.js";

export const ROOT = "sources/bitbucket";

export function codePath(fullName: string, ref: string, file: string): string {
  return `${ROOT}/${fullName}/code/${ref}/files/${file}`;
}

export function headPath(fullName: string, ref: string): string {
  return `${ROOT}/${fullName}/code/${ref}/_head.json`;
}

export function clientFor(fake: FakeBitbucket): BitbucketClient {
  return new BitbucketClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch });
}

export async function select(tenantId: string, fullName: string, extraRefs?: string[]): Promise<void> {
  await setSelection(db as never, { tenantId, fullName, selected: true, ...(extraRefs ? { extraRefs } : {}), by: "user-1" });
}

export async function sweep(fake: FakeBitbucket, tenantId: string, options: ContentSweepOptions = {}): Promise<ContentSweepReport> {
  return runBitbucketContentSweep(db as unknown as BitbucketDb, tenantId, { client: clientFor(fake), leaseOwner: `test-${tenantId}`, ...options });
}

/** Sweep until no branch is in progress (each run is one bounded task execution). */
export async function sweepUntilQuiet(fake: FakeBitbucket, tenantId: string, options: ContentSweepOptions = {}, maxRuns = 30): Promise<ContentSweepReport[]> {
  const reports: ContentSweepReport[] = [];
  for (let i = 0; i < maxRuns; i++) {
    const r = await sweep(fake, tenantId, options);
    reports.push(r);
    const busy = r.quotas.some((q) => q.outcome !== "ran" || q.refs.some((x) => x.outcome === "in_progress"));
    if (!busy) return reports;
  }
  throw new Error(`sweep did not settle: ${JSON.stringify(reports.at(-1))}`);
}

export async function makeExporter(tenantId: string): Promise<{ exporter: SourceExporter; yc: YcStore }> {
  const yc = await YcStore.create(tenantId);
  await setTenantBinding(db as never, { tenantId, bindingId: BINDING_ID, token: bindingToken(tenantId), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
  const exporter = new SourceExporter({ db: db as never, registry: new SourceProviderRegistry([bitbucketProvider]), fetchImpl: yc.fetch, log: () => {} });
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
