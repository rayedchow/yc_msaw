import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { NangoClient } from "../../../../src/integrations/nango/client.js";
import { handleNangoProxyDetailsTask } from "../../../../src/integrations/nango/proxy-details.js";
import { loadStoredCursor, saveStoredCursor } from "../../../../src/integrations/nango/tasks.js";
import { startNangoPolling } from "../../../../src/queue/dispatch.js";
import { JiraClient } from "../../../../src/source-lane/providers/jira/api.js";
import { quotaKeyFor } from "../../../../src/source-lane/providers/jira/identity.js";
import { runJiraSweep, type SweepOptions } from "../../../../src/source-lane/providers/jira/sweep.js";
import { FakeJira, NANGO_BASE, NANGO_KEY, type FakeIssue } from "./fake-jira.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

/**
 * Jira duplicate-sync efficiency (jira-efficiency): both Jira schedules that startNangoPolling creates -
 * the donor `nango.proxy_details` sweep and the deep `jira.sweep` - run against ONE synthetic Jira site
 * through their production entrypoints (real NangoClient / JiraClient over a counting fetch, PGlite with
 * the real migrations). Counts every Atlassian request per lane and snapshots every donor output
 * (activity_events issue_detail / issue_comment / tombstone rows, sources/jira mirror files) and every
 * deep-lane output (jira_source_objects / jira_source_records) so a before/after run can be compared.
 *
 * JIRA_EFF_BASELINE=1 records only (run on the unpatched tree); JIRA_EFF_OUT=<file> writes the JSON.
 */

const BASELINE = process.env.JIRA_EFF_BASELINE === "1";
const T = "tenant-eff";
const CONN = "conn-eff";
const CLOUD = "cloud-eff";
const SITE = "https://acme.atlassian.net";
const ENG = "20000";
const OPS = "20001";
const ISSUES = 120;
const OLD = "2026-02-01T09:00:00.000+0000";

type Lane = "donor" | "deep";
const calls: Record<Lane, URL[]> = { donor: [], deep: [] };

function klass(u: URL): string {
  const p = u.pathname.replace(/^\/proxy/u, "");
  if (u.hostname === "api.media.atlassian.com") return "media";
  if (p === "/oauth/token/accessible-resources") return "accessible-resources";
  if (p.endsWith("/rest/api/3/search/jql")) return u.searchParams.get("fields") === "id" ? "search(ids)" : "search(*all)";
  if (p.endsWith("/rest/api/3/project/search")) return "project/search";
  if (/\/issue\/[^/]+\/comment(\/|$)/u.test(p)) return "comment";
  if (/\/issue\/[^/]+\/changelog$/u.test(p)) return "changelog";
  if (/\/issue\/[^/]+$/u.test(p)) return "issue";
  if (p.includes("/attachment/")) return "attachment";
  if (p.endsWith("/mypermissions")) return "mypermissions";
  if (/\/project\/[^/]+$/u.test(p)) return "project";
  return `other:${p}`;
}

function counts(lane: Lane, from = 0): Record<string, number> {
  const out: Record<string, number> = { total: 0 };
  for (const u of calls[lane].slice(from)) {
    const k = klass(u);
    out[k] = (out[k] ?? 0) + 1;
    out.total! += 1;
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");

/**
 * The FakeJira search understands the deep lane's `project = <id>` and relative `updated >= "-Nm"` JQL. The donor
 * lane sends ABSOLUTE `updated >= "yyyy-MM-dd HH:mm"` (UTC, 26h lookback) and the ids-only `created >= "1970-01-01"`
 * deletion listing; serve those faithfully here (same visibility, same issue JSON, nextPageToken paging).
 */
function serveDonorJql(fake: FakeJira): void {
  const visible = (i: FakeIssue) => {
    const p = fake.projects.find((x) => x.id === i.projectId);
    return !i.deleted && !i.hidden && Boolean(p && !p.noBrowse && !p.trashed);
  };
  fake.intercept(
    (u) => u.pathname.endsWith("/rest/api/3/search/jql") && /(updated|created) >= "\d{4}-\d{2}-\d{2}/u.test(u.searchParams.get("jql") ?? ""),
    (u) => {
      const q = u.searchParams;
      const jql = q.get("jql")!;
      const m = /(updated|created) >= "(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?"/u.exec(jql)!;
      const floor = Date.parse(`${m[2]}T${m[3] ?? "00:00"}:00Z`);
      const field = m[1] as "updated" | "created";
      const list = fake.issues.filter((i) => visible(i) && Date.parse(i[field]) >= floor).sort((a, b) => Date.parse(a[field]) - Date.parse(b[field]) || a.id.localeCompare(b.id));
      const idsOnly = q.get("fields") === "id";
      const offset = q.get("nextPageToken") ? Number(Buffer.from(q.get("nextPageToken")!, "base64url").toString("utf8").replace(/^d-/u, "")) : 0;
      const size = Math.min(Number(q.get("maxResults") ?? 50), idsOnly ? 1000 : fake.searchPageSize);
      const page = list.slice(offset, offset + size);
      const more = offset + size < list.length;
      return Response.json({ issues: page.map((i) => (idsOnly ? { id: i.id } : fake.issueJson(i))), ...(more ? { nextPageToken: Buffer.from(`d-${offset + size}`).toString("base64url") } : {}), isLast: !more });
    },
    Number.POSITIVE_INFINITY,
  );
}

function seed(fake: FakeJira, now: number): void {
  fake.site(CONN, CLOUD, SITE);
  fake.searchPageSize = 50;
  fake.projects.push({ id: ENG, key: "ENG", name: "Engineering" }, { id: OPS, key: "OPS", name: "Operations" });
  const eng = { n: 0 };
  const ops = { n: 0 };
  for (let k = 1; k <= ISSUES; k++) {
    const id = String(30000 + k);
    const proj = k % 2 ? ENG : OPS;
    const counter = proj === ENG ? eng : ops;
    counter.n += 1;
    const created = iso(Date.UTC(2026, 0, 1) + k * 60_000);
    // 10 issues updated inside the last 26h (what the donor re-reads every 5 minutes); the rest are old.
    const updated = k > ISSUES - 10 ? iso(now - (ISSUES - k + 1) * 60 * 60_000) : OLD;
    const nComments = k % 10 === 0 ? 5 : k % 3 === 0 ? 1 : 0;
    fake.issues.push({
      id,
      key: `${proj === ENG ? "ENG" : "OPS"}-${counter.n}`,
      projectId: proj,
      summary: `Synthetic issue ${k}`,
      description: `Body of synthetic issue ${k}`,
      status: "To Do",
      created,
      updated,
      comments: Array.from({ length: nComments }, (_, c) => ({ id: `${id}${c}`, created: iso(Date.UTC(2026, 0, 10, c)), updated: iso(Date.UTC(2026, 0, 10, c)), authorId: `acct-${c}`, text: `Comment ${c} on ${k}` })),
      histories: Array.from({ length: k % 25 === 0 ? 150 : 2 }, (_, h) => ({ id: `${id}${String(h).padStart(3, "0")}`, created: iso(Date.UTC(2026, 0, 2, 0, h)), authorId: "acct-h", items: [{ field: "status", fromString: `S${h}`, toString: `S${h + 1}` }] })),
      attachments: k % 40 === 0 ? [{ id: `att-${k}`, filename: `f${k}.bin`, mimeType: "application/octet-stream", created, bytes: Buffer.from([0, 255, 13, 10, k]) }] : [],
    });
  }
}

function deepOptions(fake: FakeJira, extra: Partial<SweepOptions> = {}): SweepOptions {
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.deep.push(new URL(input instanceof Request ? input.url : String(input)));
    return fake.fetch(input, init);
  };
  return { client: new JiraClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl }), maxRequestsPerSite: 10_000, deltaIntervalMs: 0, fullScanIntervalMs: 365 * 24 * 3600_000, siteRefreshMs: 3600_000, leaseOwner: "eff-worker", ...extra };
}

async function deepUntilQuiet(fake: FakeJira, extra: Partial<SweepOptions> = {}, tenant = T): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await runJiraSweep(db as never, tenant, deepOptions(fake, extra));
    extra = { ...extra, fullScanIntervalMs: 365 * 24 * 3600_000 };
    const pending = await query<{ n: number }>(`SELECT count(*)::int AS n FROM jira_source_work WHERE tenant_id = $1 AND state = 'pending' AND (not_before IS NULL OR not_before <= now())`, [tenant]);
    const open = await query<{ n: number }>(`SELECT count(*)::int AS n FROM jira_source_sync_state WHERE tenant_id = $1 AND generation_phase <> 'closed'`, [tenant]);
    if (Number(pending[0]!.n) === 0 && Number(open[0]!.n) === 0) return;
  }
  throw new Error("deep sweep did not settle");
}

async function donorTick(fake: FakeJira, tenant = T): Promise<Record<string, unknown>> {
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.donor.push(new URL(input instanceof Request ? input.url : String(input)));
    return fake.fetch(input, init);
  };
  const client = new NangoClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl, retryDelayMs: 1 });
  return handleNangoProxyDetailsTask(db as never, { tenantId: tenant, provider: "jira" }, { client });
}

/** Run-relative clock: fixture timestamps derived from `now` are rewritten as offsets so two runs compare equal. */
let runNow = 0;
const TS = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gu;
function rel(text: string): string {
  return text.replace(TS, (m) => {
    const t = Date.parse(/[+-]\d{4}$/u.test(m) ? `${m.slice(0, -2)}:${m.slice(-2)}` : m);
    return Number.isFinite(t) && Math.abs(t - runNow) < 40 * 86_400_000 ? `now${t - runNow >= 0 ? "+" : ""}${Math.round((t - runNow) / 1000)}s` : m;
  });
}
const sha = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 16);

/** Donor outputs, normalized only for per-run row uuids (rendered as "Event ID") and the detection instant of a tombstone. */
async function donorSnapshot(tenant = T): Promise<{ events: string[]; mirrors: Record<string, string> }> {
  const events = await query<{ event_type: string; source_event_id: string; raw_payload: Record<string, unknown>; source_updated_at: string | null }>(
    `SELECT event_type, source_event_id, raw_payload, (extract(epoch from source_updated_at) * 1000)::bigint::text AS source_updated_at FROM activity_events WHERE user_id = $1 AND source = 'jira' ORDER BY source_event_id`,
    [tenant],
  );
  const mirrors = await query<{ path: string; content: string }>(`SELECT path, content FROM mirror_files WHERE user_id = $1 AND path LIKE 'sources/jira/%' ORDER BY path`, [tenant]);
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
  return {
    events: events.map((e) => {
      const { deletionDetectedAt: _d, ...raw } = e.raw_payload;
      const updatedAt = e.event_type.endsWith(".deleted") || e.source_updated_at === null ? "-" : rel(new Date(Number(e.source_updated_at)).toISOString());
      return `${e.event_type} ${rel(e.source_event_id)} ${sha(rel(JSON.stringify(raw)))} ${updatedAt}`;
    }).sort(),
    mirrors: Object.fromEntries(mirrors.map((m) => [m.path, sha(rel(m.content.replace(uuid, "<uuid>")))])),
  };
}

async function deepSnapshot(): Promise<{ objects: number; records: number; digest: string }> {
  const objects = await query<{ row_key: string; raw: unknown; tombstoned: boolean; binary_status: string | null }>(`SELECT row_key, raw, tombstoned_at IS NOT NULL AS tombstoned, binary_status FROM jira_source_objects WHERE tenant_id = $1 ORDER BY row_key`, [T]);
  const records = await query<{ row_key: string; raw_sha256: string }>(`SELECT row_key, raw_sha256 FROM jira_source_records WHERE tenant_id = $1 ORDER BY row_key`, [T]);
  const raws = await query<{ row_key: string; raw: unknown }>(`SELECT row_key, raw FROM jira_source_records WHERE tenant_id = $1 ORDER BY row_key`, [T]);
  // Observation row keys embed sha256(raw); re-derive them from the run-relative raw so two runs compare.
  return { objects: objects.length, records: records.length, digest: sha([objects.map((o) => [o.row_key, sha(rel(JSON.stringify(o.raw))), o.tombstoned, o.binary_status]), raws.map((r) => [r.row_key.replace(/obs-[0-9a-f]{24}$/u, "obs"), sha(rel(JSON.stringify(r.raw)))]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`))]) };
}

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await resetAll();
  calls.donor = [];
  calls.deep = [];
});

describe("jira duplicate sync (both default Jira schedules against one site)", () => {
  it("counts Atlassian requests per lane for backfill, idle tick, change tick, reconcile and full pass; snapshots every output", async () => {
    const now = Date.now();
    runNow = now;
    const fake = new FakeJira();
    seed(fake, now);
    serveDonorJql(fake);
    await connect(T, CONN);
    await startNangoPolling(T, "jira");
    const schedules = await query<{ kind: string; enabled: boolean }>(`SELECT kind, enabled FROM task_schedules WHERE tenant_id = $1 ORDER BY kind`, [T]);
    const report: Record<string, unknown> = { schedules: schedules.map((s) => `${s.kind}:${s.enabled}`) };

    // 1. initial backfill: one donor tick (it backfills in one run) + the deep lane until its first generation closes.
    let d0 = calls.donor.length;
    let p0 = calls.deep.length;
    await donorTick(fake);
    await deepUntilQuiet(fake);
    report.backfill = { donor: counts("donor", d0), deep: counts("deep", p0) };
    report.afterBackfill = { donor: await donorSnapshot(), deep: await deepSnapshot() };

    // 2. idle 5-minute tick: nothing changed upstream.
    d0 = calls.donor.length;
    p0 = calls.deep.length;
    await donorTick(fake);
    await runJiraSweep(db as never, T, deepOptions(fake));
    report.idleTick = { donor: counts("donor", d0), deep: counts("deep", p0) };

    // 3. change tick: an issue edited + commented past the inline window, another issue edited.
    const busy = fake.issue("30120"); // already has 5 comments (inline shows 2)
    busy.summary = "Edited busy issue";
    busy.comments.push({ id: "30120new", created: iso(now - 60_000), updated: iso(now - 60_000), authorId: "acct-n", text: "Fresh comment after backfill" });
    busy.updated = iso(now - 60_000);
    const quiet = fake.issue("30001");
    quiet.description = "Edited description";
    quiet.updated = iso(now - 30_000);
    d0 = calls.donor.length;
    p0 = calls.deep.length;
    await donorTick(fake);
    await deepUntilQuiet(fake);
    report.changeTick = { donor: counts("donor", d0), deep: counts("deep", p0) };
    report.afterChange = { donor: await donorSnapshot(), deep: await deepSnapshot() };

    // 4. hourly donor deletion reconcile (forced due), after one issue was deleted upstream.
    fake.issue("30002").deleted = true;
    await saveStoredCursor(db as never, { tenantId: T, provider: "jira", connectionId: CONN, model: "issue_deletion_sweep" }, new Date(now - 2 * 3600_000).toISOString());
    d0 = calls.donor.length;
    const reconcile = await donorTick(fake);
    report.reconcileTick = { donor: counts("donor", d0), result: reconcile.deletionReconcile ?? null };
    report.afterReconcile = { donor: await donorSnapshot() };

    // 5. one scheduled 12h deep full pass (forced), settles the deleted issue in the deep lane too.
    p0 = calls.deep.length;
    await deepUntilQuiet(fake, { fullScanIntervalMs: 1 });
    report.fullPass = { deep: counts("deep", p0) };
    report.afterFullPass = { donor: await donorSnapshot(), deep: await deepSnapshot() };

    const idle = report.idleTick as { donor: { total: number }; deep: { total: number } };
    const full = report.fullPass as { deep: { total: number } };
    const rec = report.reconcileTick as { donor: { total: number } };
    report.perDay = {
      note: "288 five-minute ticks of both schedules + 2 deep full passes + 24 donor reconciles (this fixture: 120 issues, 10 updated in the last 26h)",
      donor: idle.donor.total * 288 + rec.donor.total * 24,
      deep: idle.deep.total * 288 + full.deep.total * 2,
    };
    if (process.env.JIRA_EFF_OUT) writeFileSync(process.env.JIRA_EFF_OUT, `${JSON.stringify(report, null, 2)}\n`);

    // Outputs both lanes must always produce, before and after the change.
    const after = report.afterChange as { donor: { events: string[]; mirrors: Record<string, string> } };
    expect(after.donor.events.some((e) => e.startsWith("issue_detail nango:jira:issue_detail:30120:"))).toBe(true);
    expect(after.donor.events.some((e) => e.startsWith("issue_comment nango:jira:issue_comment:30120new:"))).toBe(true);
    const busyMirror = (await query<{ content: string }>(`SELECT content FROM mirror_files WHERE user_id = $1 AND path = 'sources/jira/OPS/OPS-60.md'`, [T]))[0]!.content;
    expect(busyMirror).toContain("Fresh comment after backfill");
    expect(busyMirror).toContain("Comment 4 on 120");
    expect((report.afterReconcile as { donor: { events: string[] } }).donor.events.some((e) => e.startsWith("issue.deleted nango:jira:issue:30002:deleted"))).toBe(true);
    if (BASELINE) return;
    // After the change: the donor lane never pages a project itself while jira.sweep is enabled.
    const lanes = report as Record<string, { donor?: Record<string, number> }>;
    for (const phase of ["backfill", "idleTick", "changeTick"]) {
      expect(lanes[phase]!.donor!["search(*all)"] ?? 0, phase).toBe(0);
      expect(lanes[phase]!.donor!.comment ?? 0, phase).toBe(0);
    }
    expect(idle.donor.total).toBe(0);
  });
});


const disableDeepLane = (tenant: string) => query(`UPDATE task_schedules SET enabled = false WHERE tenant_id = $1 AND kind = 'jira.sweep'`, [tenant]);
const rows = async (tenant: string, eventType: string) => (await query<{ source_event_id: string }>(`SELECT source_event_id FROM activity_events WHERE user_id = $1 AND source = 'jira' AND event_type = $2 ORDER BY source_event_id`, [tenant, eventType])).map((r) => r.source_event_id);
const watermark = (tenant: string) => loadStoredCursor(db as never, { tenantId: tenant, provider: "jira", connectionId: CONN, model: "issue_deletion_sweep" });

async function setup(tenant = T): Promise<FakeJira> {
  runNow = Date.now();
  const fake = new FakeJira();
  seed(fake, runNow);
  serveDonorJql(fake);
  await connect(tenant, CONN);
  await startNangoPolling(tenant, "jira");
  return fake;
}

describe("jira duplicate sync: scenarios", () => {
  it("a tenant without an enabled jira.sweep schedule keeps the donor lane's own paged sweep (legacy fallback)", async () => {
    const fake = await setup();
    await disableDeepLane(T);
    const result = await donorTick(fake);
    expect(result.deepLane).toBeUndefined();
    expect(counts("donor")["search(*all)"]).toBe(3);
    expect(counts("donor").comment).toBe(12);
    expect((await rows(T, "issue_detail")).length).toBe(ISSUES);
  });

  it("donor outputs written by the deep lane equal the donor lane's own sweep in the same process (rows, raw payloads, mirrors)", async () => {
    const fake = await setup("tenant-legacy");
    await disableDeepLane("tenant-legacy");
    await donorTick(fake, "tenant-legacy");
    await connect(T, CONN);
    await startNangoPolling(T, "jira");
    await deepUntilQuiet(fake);
    const before = calls.donor.length;
    await donorTick(fake);
    expect(calls.donor.length - before).toBe(1); // only the reconcile's one-time baseline site lookup
    const legacy = await donorSnapshot("tenant-legacy");
    const fed = await donorSnapshot(T);
    expect(fed.events.length).toBe(legacy.events.length);
    expect(fed.events).toEqual(legacy.events);
    expect(fed.mirrors).toEqual(legacy.mirrors);
  });

  it("the donor reconcile honours the Retry-After cooldown the deep lane stored on the shared Atlassian bucket", async () => {
    const fake = await setup();
    await deepUntilQuiet(fake);
    await donorTick(fake); // baseline
    const due = new Date(Date.now() - 2 * 3600_000).toISOString();
    await saveStoredCursor(db as never, { tenantId: T, provider: "jira", connectionId: CONN, model: "issue_deletion_sweep" }, due);
    fake.rateLimitNext((u) => u.pathname.endsWith("/search/jql"), { "retry-after": "120" });
    const deep = await runJiraSweep(db as never, T, deepOptions(fake));
    expect(deep.sites[0]!.outcome).toBe("deferred");
    const cooling = await query<{ blocked_until: string; last_retry_after_ms: string }>(`SELECT blocked_until::text, last_retry_after_ms::text FROM jira_source_quota WHERE quota_key = $1`, [quotaKeyFor("jira", CLOUD)]);
    expect(Number(cooling[0]!.last_retry_after_ms)).toBe(120_000);
    const before = calls.donor.length;
    const blocked = await donorTick(fake);
    expect(blocked.deletionReconcile).toBeNull();
    expect(calls.donor.slice(before).map(klass)).toEqual(["accessible-resources"]);
    expect(await watermark(T)).toBe(due); // not advanced: retried on the next tick
    await query(`UPDATE jira_source_quota SET blocked_until = now() - interval '1 second' WHERE quota_key = $1`, [quotaKeyFor("jira", CLOUD)]);
    const ran = await donorTick(fake);
    expect((ran.deletionReconcile as { listedPages: number }).listedPages).toBe(1);
    expect(await watermark(T)).not.toBe(due);
  });

  it("comment paging interrupted by the request budget resumes from its checkpoint; donor rows and mirror end complete, nothing is re-fetched by the donor", async () => {
    const fake = await setup();
    const busy = fake.issue("30120");
    for (let c = 5; c < 11; c++) busy.comments.push({ id: `30120${c}`, created: iso(Date.UTC(2026, 0, 11, c)), updated: iso(Date.UTC(2026, 0, 11, c)), authorId: "acct-x", text: `Late comment ${c}` });
    for (let i = 0; i < 60; i++) {
      await runJiraSweep(db as never, T, deepOptions(fake, { maxRequestsPerSite: 3, commentPageSize: 2 }));
      const open = await query<{ n: number }>(`SELECT count(*)::int AS n FROM jira_source_work WHERE tenant_id = $1 AND state = 'pending' AND (not_before IS NULL OR not_before <= now())`, [T]);
      if (Number(open[0]!.n) === 0) break;
    }
    await donorTick(fake);
    expect(counts("donor")["search(*all)"] ?? 0).toBe(0);
    const ids = (await rows(T, "issue_comment")).filter((k) => k.startsWith("nango:jira:issue_comment:30120"));
    expect(ids.length).toBe(11);
    expect(new Set(ids).size).toBe(11);
    const mirror = (await query<{ content: string }>(`SELECT content FROM mirror_files WHERE user_id = $1 AND path = 'sources/jira/OPS/OPS-60.md'`, [T]))[0]!.content;
    for (const text of ["Comment 0 on 120", "Comment 4 on 120", "Late comment 5", "Late comment 10"]) expect(mirror).toContain(text);
    expect(mirror).not.toContain("Comments omitted");
  });

  it("only the tenant's first connection feeds the connection-less donor lane; a second account stays in its own deep-lane scope", async () => {
    const fake = await setup();
    // A second Atlassian account of the same tenant: its own site with its own issues.
    const other = new FakeJira();
    other.site("conn-eff-2", "cloud-eff-2", "https://other.atlassian.net");
    other.projects.push({ id: "50000", key: "OTH", name: "Other" });
    other.issues.push({ id: "40001", key: "OTH-1", projectId: "50000", summary: "Other account issue", description: "x", status: "Done", created: OLD, updated: OLD, comments: [], histories: [], attachments: [] });
    fake.site("conn-eff-2", "cloud-eff-2", "https://other.atlassian.net");
    await query(`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata, created_at) VALUES ($1, 'jira', 'conn-eff-2', 'active', $2::jsonb, now() + interval '1 second')`, [T, JSON.stringify({ providerConfigKey: "jira", nangoConnectionId: "conn-eff-2" })]);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.deep.push(url);
      return (url.pathname.includes("/ex/jira/cloud-eff-2/") ? other : fake).fetch(input, init);
    };
    const client = new JiraClient({ apiKey: NANGO_KEY, baseUrl: NANGO_BASE, fetchImpl });
    for (let i = 0; i < 10; i++) await runJiraSweep(db as never, T, deepOptions(fake, { client }));
    const sites = await query<{ connection_id: string; n: number }>(`SELECT connection_id, count(*)::int AS n FROM jira_source_objects WHERE tenant_id = $1 AND content_type = 'issue' GROUP BY connection_id ORDER BY connection_id`, [T]);
    expect(sites.map((r) => [r.connection_id, Number(r.n)])).toEqual([[CONN, ISSUES], ["conn-eff-2", 1]]);
    const cloudIds = await query<{ cloud: string; n: number }>(`SELECT raw_payload->>'cloudId' AS cloud, count(*)::int AS n FROM activity_events WHERE user_id = $1 AND event_type = 'issue_detail' GROUP BY 1`, [T]);
    expect(cloudIds.map((r) => [r.cloud, Number(r.n)])).toEqual([[CLOUD, ISSUES]]);
  });

  it("an auth-failed grant blocks the deep lane and the gated donor lane makes no search of its own", async () => {
    const fake = await setup();
    fake.intercept(() => true, () => Response.json({ error: { code: "unknown_connection" } }, { status: 401 }), Number.POSITIVE_INFINITY);
    const deep = await runJiraSweep(db as never, T, deepOptions(fake));
    expect(deep.sites[0]?.outcome).toBe("blocked");
    await expect(donorTick(fake)).rejects.toThrow(/401/u); // the reconcile's baseline site lookup surfaces the dead grant, as before
    expect(calls.donor.map(klass)).toEqual(["accessible-resources"]);
    expect((await rows(T, "issue_detail")).length).toBe(0);
  });

  it("a donor row missing for a version the deep lane already holds (webhook refresh) still gets every paged comment in its mirror", async () => {
    const fake = await setup();
    await deepUntilQuiet(fake);
    // e.g. the version was captured by the deep lane before this patch, while the donor lane missed it.
    await query(`DELETE FROM activity_events WHERE user_id = $1 AND source = 'jira' AND (raw_payload->>'id' = '30120' OR raw_payload->>'issueId' = '30120')`, [T]);
    await query(`DELETE FROM mirror_files WHERE user_id = $1 AND path = 'sources/jira/OPS/OPS-60.md'`, [T]);
    const { enqueueJiraIssueHint } = await import("../../../../src/source-lane/providers/jira/sweep.js");
    expect(await enqueueJiraIssueHint(db as never, T, { connectionId: CONN, issueId: "30120" })).toBe(1);
    await deepUntilQuiet(fake);
    const mirror = (await query<{ content: string }>(`SELECT content FROM mirror_files WHERE user_id = $1 AND path = 'sources/jira/OPS/OPS-60.md'`, [T]))[0]!.content;
    for (let c = 0; c < 5; c++) expect(mirror).toContain(`Comment ${c} on 120`);
    expect((await rows(T, "issue_comment")).filter((k) => k.startsWith("nango:jira:issue_comment:30120")).length).toBe(5);
  });

  it("project selection is honoured: only selected projects reach the donor rows", async () => {
    const fake = await setup();
    const { putSelection } = await import("../../../../src/source-lane/providers/jira/store.js");
    await putSelection(db as never, T, CONN, "*", "projects", ["ENG"], "test");
    await deepUntilQuiet(fake);
    const ids = new Set((await query<{ id: string }>(`SELECT raw_payload->>'id' AS id FROM activity_events WHERE user_id = $1 AND event_type = 'issue_detail'`, [T])).map((r) => r.id));
    expect(ids.size).toBe(ISSUES / 2);
    for (const id of ids) expect(Number(id) % 2).toBe(1); // odd k = ENG
    expect(calls.donor.length).toBe(0);
  });
});
