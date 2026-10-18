import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { JiraClient } from "../../../../src/source-lane/providers/jira/api.js";
import { jiraProvider } from "../../../../src/source-lane/providers/jira/index.js";
import { runJiraSweep, type SweepOptions, type SweepReport } from "../../../../src/source-lane/providers/jira/sweep.js";
import { FakeJira, NANGO_BASE, NANGO_KEY, type FakeHistory } from "./fake-jira.js";
import { bindingToken, db, query, YcStore } from "./harness.js";

export const CLOUD = "cloud-j1";
export const SITE_URL = "https://acme.atlassian.net";
export const CONN = "conn-j";
export const ROOT = `sources/jira/_sites/${CLOUD}/${CONN}`;
export const ENG = "10000";
export const OPS = "10001";

/** Binary-looking bytes (NUL, 0xff, CR/LF) so any text coercion would be visible. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]), randomBytes(4096)]);
export const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(3000), Buffer.from([0x00, 0xff, 0x0d, 0x0a])]);

/** Jira's own timestamp format (offset without a colon). */
export const jt = (day: number, hour = 9) => `2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000+0000`;
export const nowJira = () => new Date().toISOString().replace("Z", "+0000");

export function histories(issueId: string, n: number): FakeHistory[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(Number(issueId) * 1000 + i + 1),
    created: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString().replace("Z", "+0000"),
    authorId: `acct-${i % 3}`,
    items: [{ field: "status", fromString: `S${i}`, toString: `S${i + 1}` }],
  }));
}

export function seedSite(fake: FakeJira, connectionId = CONN): void {
  fake.site(connectionId, CLOUD, SITE_URL);
  fake.projects.push({ id: ENG, key: "ENG", name: "Engineering" }, { id: OPS, key: "OPS", name: "Operations" });
  fake.issues.push(
    {
      id: "10001",
      key: "ENG-1",
      projectId: ENG,
      summary: "Login fails",
      description: "Users cannot log in after the deploy",
      status: "In Progress",
      created: jt(1),
      updated: jt(5),
      security: { id: "100", name: "Internal" },
      comments: [
        { id: "c1", created: jt(2), updated: jt(2), authorId: "acct-1", text: "Reproduced on staging" },
        { id: "c2", created: jt(3), updated: jt(3), authorId: "acct-2", text: "Looking into the session cookie" },
        { id: "c3", created: jt(3, 10), updated: jt(3, 10), authorId: "acct-1", text: "Root cause: expired signing key" },
        { id: "c4", created: jt(4), updated: jt(4), authorId: "acct-3", text: "Fixed in deploy 42" },
      ],
      histories: histories("10001", 7),
      attachments: [],
    },
    {
      id: "10002",
      key: "ENG-2",
      projectId: ENG,
      summary: "Payment receipt is blank",
      description: "Receipt PDF renders empty",
      status: "To Do",
      created: jt(2),
      updated: jt(6),
      comments: [{ id: "c5", created: jt(6), updated: jt(6), authorId: "acct-4", text: "Internal note for devs", visibility: { type: "role", value: "Developers" } }],
      histories: histories("10002", 2),
      attachments: [
        { id: "a1", filename: "screenshot.png", mimeType: "image/png", created: jt(2), bytes: PNG },
        { id: "a2", filename: "receipt.pdf", mimeType: "application/pdf", created: jt(3), bytes: PDF },
      ],
    },
    { id: "10003", key: "OPS-1", projectId: OPS, summary: "Restart cache nodes", description: "Weekly restart", status: "Done", created: jt(3), updated: jt(7), comments: [], histories: histories("10003", 1), attachments: [] },
    { id: "10004", key: "ENG-3", projectId: ENG, summary: "Busy issue", description: "Many transitions", status: "Done", created: jt(4), updated: jt(8), comments: [], histories: histories("10004", 250), attachments: [] },
  );
}

export function client(fake: FakeJira): JiraClient {
  return new JiraClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl: fake.fetch });
}

export function sweepOptions(fake: FakeJira, extra: Partial<SweepOptions> = {}): SweepOptions {
  return { client: client(fake), maxRequestsPerSite: 10_000, deltaIntervalMs: 0, fullScanIntervalMs: 365 * 24 * 3600_000, siteRefreshMs: 3600_000, commentPageSize: 2, leaseOwner: "test-worker", ...extra };
}

/** Run sweeps until the site's generation is closed and nothing is pending (bounded). */
export async function sweepUntilQuiet(tenantId: string, fake: FakeJira, extra: Partial<SweepOptions> = {}, max = 20): Promise<SweepReport[]> {
  const reports: SweepReport[] = [];
  for (let i = 0; i < max; i++) {
    const r = await runJiraSweep(db as never, tenantId, sweepOptions(fake, extra));
    reports.push(r);
    const pending = await query<{ n: number }>(`SELECT count(*)::int AS n FROM jira_source_work WHERE tenant_id = $1 AND state = 'pending' AND (not_before IS NULL OR not_before <= now())`, [tenantId]);
    const open = await query<{ n: number }>(`SELECT count(*)::int AS n FROM jira_source_sync_state WHERE tenant_id = $1 AND generation_phase <> 'closed'`, [tenantId]);
    if (Number(pending[0]!.n) === 0 && Number(open[0]!.n) === 0) return reports;
    if (r.sites.some((s) => s.outcome === "deferred" || s.outcome === "blocked")) return reports;
    // After the first run, later runs must not start another full pass on their own.
    extra = { ...extra, fullScanIntervalMs: 365 * 24 * 3600_000 };
  }
  throw new Error("sweep did not settle");
}

export async function makeExporter(tenantId: string): Promise<{ exporter: SourceExporter; yc: YcStore }> {
  const yc = await YcStore.create(tenantId);
  await setTenantBinding(db as never, { tenantId, bindingId: "sb-0123456789abcdef", token: bindingToken(tenantId), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
  const exporter = new SourceExporter({ db: db as never, registry: new SourceProviderRegistry([jiraProvider]), fetchImpl: yc.fetch, log: () => {} });
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

export function issuePath(project: string, key: string, file = "issue.md"): string {
  return `${ROOT}/projects/${project}/issues/${key}/${file}`;
}
