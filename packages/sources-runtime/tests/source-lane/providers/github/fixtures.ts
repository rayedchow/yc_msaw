/** Shared helpers for the GitHub lane tests (production sweep + exporter into the real yc_msaw store). */
import { GithubClient } from "../../../../src/source-lane/providers/github/api.js";
import { runGithubContentSweep, type ContentSweepOptions } from "../../../../src/source-lane/providers/github/content.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import { FakeGithub, NANGO_BASE, NANGO_KEY } from "./fake-github.js";
import { bindingToken, db, query, YcStore } from "./harness.js";

export const T = "tenant-gh1";
export const CONN = "conn-1";
export const REPO_ID = 4242;
export const REPO = "acme/widgets";
export const CODE = "sources/github/acme/widgets/code";
export const MAIN = `${CODE}/main`;

/** 1x1 PNG plus bytes that are invalid UTF-8 and contain NUL. */
export const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
export const BIN = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x00, 0xc3, 0x28, 0x7f]);

export function client(fake: FakeGithub): GithubClient {
  return new GithubClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch });
}

export function sweepOptions(fake: FakeGithub, extra: ContentSweepOptions = {}): ContentSweepOptions {
  return { client: client(fake), maxRequestsPerQuota: 10_000, reserveRemaining: 0, leaseOwner: "test-worker", ...extra };
}

export async function sweep(fake: FakeGithub, extra: ContentSweepOptions = {}, tenantId = T) {
  return runGithubContentSweep(db as never, tenantId, sweepOptions(fake, extra));
}

/** Sweep until no ref reports in_progress (bounded). */
export async function sweepUntilQuiet(fake: FakeGithub, extra: ContentSweepOptions = {}, tenantId = T): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const r = await sweep(fake, extra, tenantId);
    if (r.quotas.every((q) => q.outcome === "ran" && !q.deferredUntil && q.refs.every((x) => x.outcome !== "in_progress"))) return;
  }
  throw new Error("github sweep did not settle");
}

export async function makeExporter(tenantId = T): Promise<{ exporter: SourceExporter; yc: YcStore }> {
  const yc = await YcStore.create(tenantId);
  await setTenantBinding(db as never, { tenantId, bindingId: "sb-0123456789abcdef", token: bindingToken(tenantId), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
  const exporter = new SourceExporter({ db: db as never, registry: defaultRegistry(), fetchImpl: yc.fetch, log: () => {} });
  return { exporter, yc };
}

export async function drain(exporter: SourceExporter): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await exporter.runOnce();
    if (r.deadLettered) {
      const dead = await query(`SELECT table_name, row_key, last_error FROM source_lane_journal WHERE dead_lettered_at IS NOT NULL`).catch(() => []);
      throw new Error(`exporter dead-lettered ${r.deadLettered}: ${JSON.stringify(dead)}`);
    }
    if (r.claimed === 0) return;
  }
  throw new Error("exporter did not drain");
}

export async function journalCount(tenantId = T): Promise<number> {
  return (await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = $1`, [tenantId]))[0]!.n;
}
