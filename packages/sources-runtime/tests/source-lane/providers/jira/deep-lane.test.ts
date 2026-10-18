import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { jiraCoverage } from "../../../../src/source-lane/providers/jira/coverage.js";
import { enqueueJiraIssueHint, runJiraSweep } from "../../../../src/source-lane/providers/jira/sweep.js";
import { handleJiraForwardWebhook, jiraWebhookIssueId } from "../../../../src/source-lane/providers/jira/webhook.js";
import { FakeJira, MEDIA_TOKEN, NANGO_KEY } from "./fake-jira.js";
import { CLOUD, CONN, drain, ENG, issuePath, makeExporter, nowJira, OPS, PDF, PNG, ROOT, seedSite, sweepOptions, sweepUntilQuiet } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

const T = "tenant-j1";
let fake: FakeJira;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  fake = new FakeJira();
  seedSite(fake);
  await connect(T, CONN);
});

const cov = async (tenantId = T) => jiraCoverage({ tenantId, executor: db as never });
const siteScope = `site:${CLOUD}/${CONN}`;

describe("jira deep lane: initial full capture", () => {
  it("captures projects, every issue field, all comments, the full paged changelog and exact attachment bytes", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    const site = await yc.json(`${ROOT}/_site.json`);
    expect(site).toMatchObject({ cloudId: CLOUD, connectionId: CONN, siteUrl: "https://acme.atlassian.net", status: "active", projectSelection: { mode: "all", source: "default" } });
    expect(site.grantedScopes).toContain("read:jira-work");
    expect(await yc.text(`${ROOT}/projects/ENG/_project.md`)).toContain("- Project ID: 10000");

    // Issue projection: donor layout (header, ADF description, ### Comment <id>) plus identity and access state.
    const md = await yc.text(issuePath("ENG", "ENG-1"));
    expect(md).toContain("# ENG-1: Login fails");
    expect(md).toContain("- Issue ID: 10001");
    expect(md).toContain("- Status: In Progress");
    expect(md).toContain("- Security level: Internal");
    expect(md).toContain("Users cannot log in after the deploy");
    for (const c of ["c1", "c2", "c3", "c4"]) expect(md).toContain(`### Comment ${c}`);
    expect(md.indexOf("Comment c1")).toBeLessThan(md.indexOf("Comment c4"));
    expect(md).not.toContain("Comments omitted");
    expect(md).toContain("- Changelog captured: 7 of 7 history entries (complete");
    // Search embedded only 2 of 4 comments: the comment endpoint was paged (page size 2).
    expect(fake.callsTo(/\/issue\/10001\/comment\?.*startAt=2/u)).toHaveLength(1);

    // Raw: the exact stored payload, redacted at capture (avatar URLs), id-keyed observations.
    const raw = await yc.json(issuePath("ENG", "ENG-1", "issue.json"));
    expect(raw).toMatchObject({ issueId: "10001", issueKey: "ENG-1", raw: { id: "10001", key: "ENG-1", fields: { summary: "Login fails" } } });
    expect(raw.raw.fields.assignee.avatarUrls["48x48"]).toBe("[redacted: credentialed ephemeral URL]");
    expect((await yc.paths(`${ROOT}/_raw/issue/10001/observed`)).length).toBe(1);
    const comments = await yc.json(issuePath("ENG", "ENG-1", "comments.json"));
    expect(comments.comments.map((c: any) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);

    // Changelog: 250 histories, search embedded 3, the changelog endpoint was paged to the end (100 per page).
    const busy = await yc.text(issuePath("ENG", "ENG-3", "changelog.md"));
    expect(busy).toContain("- History entries captured: 250 of 250");
    expect(busy).toContain("(history 10004001)");
    expect(busy).toContain("(history 10004250)");
    expect(fake.callsTo(/\/issue\/10004\/changelog\?/u).length).toBeGreaterThanOrEqual(3);
    expect((await yc.paths(`${ROOT}/_raw/issue/10004/changelog`)).length).toBe(250);
    const h1 = await yc.json(`${ROOT}/_raw/issue/10004/changelog/h-10004001.json`);
    expect(h1).toMatchObject({ recordKind: "changelog", historyId: "10004001", raw: { id: "10004001", items: [{ field: "status", fromString: "S0", toString: "S1" }] } });

    // Attachments: exact bytes as binary files (via the media redirect, without credentials), metadata separately.
    const png = await yc.file(`${ROOT}/projects/ENG/issues/ENG-2/attachments/a1/screenshot.png`);
    expect(png?.kind).toBe("binary");
    expect(png?.contentType).toBe("image/png");
    expect(png?.bytes.equals(PNG)).toBe(true);
    expect((await yc.file(`${ROOT}/projects/ENG/issues/ENG-2/attachments/a2/receipt.pdf`))?.bytes.equals(PDF)).toBe(true);
    const meta = await yc.json(`${ROOT}/projects/ENG/issues/ENG-2/attachments/a1/_attachment.json`);
    expect(meta.binary).toMatchObject({ status: "stored", size: PNG.length });
    expect(await yc.text(issuePath("ENG", "ENG-2"))).toContain("[screenshot.png](attachments/a1/screenshot.png)");
    const media = fake.calls.filter((c) => c.url.hostname === "api.media.atlassian.com");
    expect(media).toHaveLength(2);
    expect(media.every((c) => c.auth === null)).toBe(true);

    // Restricted-visibility comment is labelled.
    expect(await yc.text(issuePath("ENG", "ENG-2"))).toContain("- Visibility: role: Developers");

    // Every issue search is bounded (project or updated restriction); every proxied call is the tenant's own connection.
    const searches = fake.callsTo(/\/search\/jql\?/u);
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((c) => /project = \d+ |updated >= /u.test(c.url.searchParams.get("jql") ?? ""))).toBe(true);
    expect(fake.calls.filter((c) => c.url.hostname !== "api.media.atlassian.com").every((c) => c.connectionId === CONN && c.providerConfigKey === "jira")).toBe(true);

    // Credentials and signed URLs never persist or export.
    const everything = await yc.allText();
    expect(everything).not.toContain(MEDIA_TOKEN);
    expect(everything).not.toContain(NANGO_KEY);
    const dbText = await query<{ t: string }>(`
      SELECT string_agg(x, ' ') AS t FROM (
        SELECT raw::text AS x FROM jira_source_objects UNION ALL SELECT raw::text FROM jira_source_records UNION ALL SELECT payload::text FROM jira_source_work) s`);
    expect(dbText[0]!.t).not.toContain(MEDIA_TOKEN);
    expect(dbText[0]!.t).not.toContain(NANGO_KEY);

    // Truthful coverage: current state complete for the (default: all) selection, history explicitly partial.
    const report = await cov();
    const s = report.find((c) => c.scope === siteScope)!;
    expect(s.state, s.reason).toBe("complete");
    expect(s.counts).toMatchObject({ projects: 2, issues: 4, comments: 5, attachmentsStored: 2, changelogIncomplete: 0, commentsIncomplete: 0 });
    expect(report.find((c) => c.scope === `${siteScope}:history`)?.state).toBe("partial");
  });
});

describe("jira deep lane: moves, edits, deletions", () => {
  it("keeps a moved issue's stable id, re-places every projection and attachment under the new key and removes the old paths", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const oldDir = `${ROOT}/projects/ENG/issues/ENG-2`;
    expect(await yc.file(`${oldDir}/attachments/a1/screenshot.png`)).not.toBeNull();

    // Moved to OPS: Jira keeps the numeric id, issues a new key and bumps `updated` (found by the relative-JQL delta).
    const issue = fake.issue("10002");
    issue.key = "OPS-9";
    issue.projectId = OPS;
    issue.updated = nowJira();
    await sweepUntilQuiet(T, fake);
    await drain(exporter);

    const md = await yc.text(issuePath("OPS", "OPS-9"));
    expect(md).toContain("# OPS-9: Payment receipt is blank");
    expect(md).toContain("- Issue ID: 10002");
    expect((await yc.file(`${ROOT}/projects/OPS/issues/OPS-9/attachments/a1/screenshot.png`))?.bytes.equals(PNG)).toBe(true);
    for (const f of ["issue.md", "issue.json", "changelog.md", "comments.json", "attachments/a1/screenshot.png", "attachments/a1/_attachment.json", "attachments/a2/receipt.pdf"]) {
      expect(await yc.file(`${oldDir}/${f}`), f).toBeNull();
      expect((await yc.tombstone(`${oldDir}/${f}`))?.reason, f).toBe("jira_issue_moved");
    }
    // Raw ledger is id-keyed: the old observation stays, the move is a new observation.
    expect((await yc.paths(`${ROOT}/_raw/issue/10002/observed`)).length).toBe(2);
    expect((await yc.paths(`${ROOT}/projects`)).filter((p) => p.includes("ENG-2"))).toEqual([]);
    // The attachment bytes were not downloaded again (immutable attachment, settled).
    expect(fake.calls.filter((c) => c.url.hostname === "api.media.atlassian.com")).toHaveLength(2);
  });

  it("records comment edits as new observations, removes 404-confirmed deleted comments and keeps restricted ones as inaccessible", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    const eng1 = fake.issue("10001");
    eng1.comments.find((c) => c.id === "c1")!.text = "Reproduced on staging AND production";
    eng1.comments.find((c) => c.id === "c1")!.updated = nowJira();
    eng1.comments.find((c) => c.id === "c2")!.deleted = true;
    eng1.updated = nowJira();
    const eng2 = fake.issue("10002");
    eng2.comments[0]!.hidden = true; // restricted-visibility comment the grant can no longer see
    eng2.updated = nowJira();
    await sweepUntilQuiet(T, fake);
    await drain(exporter);

    const md = await yc.text(issuePath("ENG", "ENG-1"));
    expect(md).toContain("Reproduced on staging AND production");
    expect(md).not.toContain("Looking into the session cookie");
    expect(md).not.toContain("### Comment c2");
    expect((await yc.json(issuePath("ENG", "ENG-1", "comments.json"))).comments.map((c: any) => c.id)).toEqual(["c1", "c3", "c4"]);
    // Both versions of c1 are in the append-only raw ledger; c2's raw survives its deletion.
    expect((await yc.paths(`${ROOT}/_raw/comment/c1/observed`)).length).toBe(2);
    expect((await yc.paths(`${ROOT}/_raw/comment/c2/observed`)).length).toBe(1);
    const rows = await query<{ content_id: string; tombstone_reason: string | null; inaccessible_reason: string | null }>(
      `SELECT content_id, tombstone_reason, inaccessible_reason FROM jira_source_objects WHERE tenant_id = $1 AND content_type = 'comment' AND content_id IN ('c2', 'c5') ORDER BY content_id`,
      [T],
    );
    expect(rows[0]).toMatchObject({ content_id: "c2", tombstone_reason: "not_found" });
    expect(rows[1]).toMatchObject({ content_id: "c5", tombstone_reason: null });
    expect(rows[1]!.inaccessible_reason).toMatch(/restricted visibility/u);
    // The restricted comment stays, labelled; it is not presented as deleted.
    const eng2md = await yc.text(issuePath("ENG", "ENG-2"));
    expect(eng2md).toContain("### Comment c5");
    expect(eng2md).toContain("no longer readable by this connection");
    const report = (await cov()).find((c) => c.scope === siteScope)!;
    expect(report.state).toBe("partial");
    expect(report.reason).toMatch(/1 object\(s\) no longer readable by this grant/u);
  });

  it("picks up a comment edit that did not bump the issue on the next full pass, not before", async () => {
    await sweepUntilQuiet(T, fake);
    const c3 = fake.issue("10001").comments.find((c) => c.id === "c3")!;
    c3.text = "Root cause: rotated signing key";
    c3.updated = nowJira();
    await sweepUntilQuiet(T, fake);
    expect((await query(`SELECT 1 FROM jira_source_records WHERE tenant_id = $1 AND content_type = 'comment' AND content_id = 'c3'`, [T])).length).toBe(1);
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    expect((await query(`SELECT 1 FROM jira_source_records WHERE tenant_id = $1 AND content_type = 'comment' AND content_id = 'c3'`, [T])).length).toBe(2);
  });

  it("tombstones an issue only on a 404 with project browse permission and no security level; lost access is kept and labelled", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    fake.issue("10001").hidden = true; // had security level "Internal": 404 may be lost access
    fake.issue("10002").deleted = true; // no security level, project still browsable: deleted
    fake.project(OPS).noBrowse = true; // project browse permission removed
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    await drain(exporter);

    // Deleted: every projection and attachment removed with the Jira reason; raw history kept.
    for (const f of ["issue.md", "issue.json", "attachments/a1/screenshot.png"]) expect((await yc.tombstone(`${ROOT}/projects/ENG/issues/ENG-2/${f}`))?.reason, f).toMatch(/^jira_(issue_)?not_found$/u);
    expect((await yc.paths(`${ROOT}/_raw/issue/10002/observed`)).length).toBe(1);
    // Possibly lost access: kept, labelled, not deleted.
    const eng1 = await yc.text(issuePath("ENG", "ENG-1"));
    expect(eng1).toContain("no longer readable by this connection");
    expect(eng1).toMatch(/issue security level/u);
    // Project no longer browsable: project and its issue kept, project labelled.
    expect(await yc.text(`${ROOT}/projects/OPS/_project.md`)).toContain("no longer readable by this connection");
    expect(await yc.file(issuePath("OPS", "OPS-1"))).not.toBeNull();
    const objects = await query<{ content_type: string; content_id: string; tombstone_reason: string | null; inaccessible: boolean }>(
      `SELECT content_type, content_id, tombstone_reason, inaccessible_at IS NOT NULL AS inaccessible FROM jira_source_objects WHERE tenant_id = $1 AND content_id IN ('10001', '10002', $2) ORDER BY content_id`,
      [T, OPS],
    );
    expect(objects).toEqual([
      { content_type: "issue", content_id: "10001", tombstone_reason: null, inaccessible: true },
      { content_type: "project", content_id: OPS, tombstone_reason: null, inaccessible: true },
      { content_type: "issue", content_id: "10002", tombstone_reason: "not_found", inaccessible: false },
    ]);
    const report = (await cov()).find((c) => c.scope === siteScope)!;
    expect(report.state).toBe("partial");
    expect(report.reason).toMatch(/2 object\(s\) no longer readable/u);
  });
});

describe("jira deep lane: rate limits, checkpoints and the delta watermark", () => {
  it("honours Retry-After on the Atlassian bucket and resumes the paged changelog from its checkpoint", async () => {
    fake.rateLimitNext((u) => u.pathname.endsWith("/issue/10004/changelog") && u.searchParams.get("startAt") === "100", { "Retry-After": "120" });
    const first = await runJiraSweep(db as never, T, sweepOptions(fake));
    const site = first.sites[0]!;
    expect(site.outcome).toBe("deferred");
    const until = Date.parse(site.deferredUntil!);
    expect(until - Date.now()).toBeGreaterThan(110_000);
    expect(until - Date.now()).toBeLessThanOrEqual(121_000);
    const quota = await query<{ quota_key: string; last_status: number; last_retry_after_ms: string }>(`SELECT quota_key, last_status, last_retry_after_ms::text AS last_retry_after_ms FROM jira_source_quota`);
    expect(quota).toEqual([{ quota_key: `atlassian-jira:jira:${CLOUD}`, last_status: 429, last_retry_after_ms: "120000" }]);
    const item = await query<{ payload: any; state: string }>(`SELECT payload, state FROM jira_source_work WHERE tenant_id = $1 AND item_key = 'changelog:10004'`, [T]);
    expect(item[0]).toMatchObject({ state: "pending", payload: { startAt: 100 } });
    expect((await cov()).find((c) => c.scope === siteScope)?.reason).toMatch(/rate limit cooldown until/u);

    // Inside the cooldown nothing is requested.
    const calls = fake.calls.length;
    const second = await runJiraSweep(db as never, T, sweepOptions(fake));
    expect(second.sites[0]).toMatchObject({ outcome: "deferred", requests: 0 });
    expect(fake.calls.length).toBe(calls);

    // After it expires the listing continues at startAt=100: page 0 is never re-read.
    await query(`UPDATE jira_source_quota SET blocked_until = now() - interval '1 second'`);
    await sweepUntilQuiet(T, fake);
    expect(fake.callsTo(/\/issue\/10004\/changelog\?startAt=0&/u)).toHaveLength(1);
    expect(fake.callsTo(/\/issue\/10004\/changelog\?startAt=100&/u)).toHaveLength(2);
    expect(Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM jira_source_records WHERE tenant_id = $1 AND content_id = '10004' AND record_kind = 'changelog'`, [T]))[0]!.n)).toBe(250);
  });

  it("backs off exponentially without a provider hint and shares the cooldown with every tenant on the same app and site", async () => {
    await connect("tenant-j2", "conn-other");
    fake.site("conn-other", CLOUD, "https://acme.atlassian.net");
    fake.rateLimitNext((u) => u.pathname.endsWith("/project/search"), {}, 1, 503);
    const a = await runJiraSweep(db as never, T, sweepOptions(fake));
    expect(a.sites[0]?.outcome).toBe("deferred");
    const wait = Date.parse(a.sites[0]!.deferredUntil!) - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThanOrEqual(61_000);
    // Another tenant connected to the same site through the same OAuth app is the same Atlassian bucket.
    const b = await runJiraSweep(db as never, "tenant-j2", sweepOptions(fake));
    expect(b.sites[0]).toMatchObject({ outcome: "deferred", requests: 0 });
  });

  it("advances the delta watermark only after the relative-JQL search is paged to exhaustion", async () => {
    await sweepUntilQuiet(T, fake);
    const before = (await query<{ w: string }>(`SELECT delta_watermark::text AS w FROM jira_source_sync_state WHERE tenant_id = $1`, [T]))[0]!.w;
    for (const id of ["10001", "10003", "10004"]) fake.issue(id).updated = nowJira();
    fake.issue("10003").summary = "Restart cache nodes (rescheduled)";
    fake.searchPageSize = 1;
    // Second delta page is rate limited: the window must not be marked as covered.
    fake.rateLimitNext((u) => u.pathname.endsWith("/search/jql") && /updated >= /u.test(u.searchParams.get("jql") ?? "") && u.searchParams.has("nextPageToken"), { "Retry-After": "30" });
    await new Promise((r) => setTimeout(r, 5));
    const r1 = await runJiraSweep(db as never, T, sweepOptions(fake));
    expect(r1.sites[0]?.outcome).toBe("deferred");
    expect((await query<{ w: string }>(`SELECT delta_watermark::text AS w FROM jira_source_sync_state WHERE tenant_id = $1`, [T]))[0]!.w).toBe(before);
    const delta = (await query<{ payload: any }>(`SELECT payload FROM jira_source_work WHERE tenant_id = $1 AND item_key = 'delta'`, [T]))[0]!.payload;
    expect(delta.jql).toMatch(/^updated >= "-\d+m" ORDER BY updated ASC$/u);
    expect(delta.cursor).toBeTruthy();

    await query(`UPDATE jira_source_quota SET blocked_until = now() - interval '1 second'`);
    await sweepUntilQuiet(T, fake);
    const resumed = fake.callsTo(/\/search\/jql\?/u).filter((c) => c.url.searchParams.get("jql") === delta.jql);
    // Same JQL string continued with the checkpointed page token (no new window computed while resuming).
    expect(resumed.some((c) => c.url.searchParams.get("nextPageToken") === delta.cursor)).toBe(true);
    const after = (await query<{ w: string; title: string }>(`SELECT s.delta_watermark::text AS w, o.title FROM jira_source_sync_state s JOIN jira_source_objects o ON o.tenant_id = s.tenant_id AND o.content_id = '10003' WHERE s.tenant_id = $1`, [T]))[0]!;
    expect(after.w > before).toBe(true);
    expect(after.title).toBe("Restart cache nodes (rescheduled)");
  });

  it("refreshes an issue named by a webhook hint by id (the body is never trusted as data)", async () => {
    await sweepUntilQuiet(T, fake);
    fake.issue("10003").summary = "Changed without an updated bump";
    expect(await enqueueJiraIssueHint(db as never, T, { connectionId: CONN, issueId: "10003" })).toBe(1);
    expect(await enqueueJiraIssueHint(db as never, T, { connectionId: CONN, issueId: "../10003" })).toBe(0);
    expect(await enqueueJiraIssueHint(db as never, "tenant-other", { connectionId: CONN, issueId: "10003" })).toBe(0);
    await sweepUntilQuiet(T, fake);
    expect((await query<{ title: string }>(`SELECT title FROM jira_source_objects WHERE tenant_id = $1 AND content_id = '10003'`, [T]))[0]!.title).toBe("Changed without an updated bump");
    expect(fake.callsTo(/\/issue\/10003\?/u)).toHaveLength(1);
  });

  it("turns a verified Nango forward webhook into a by-id refresh for the mapped tenant only", async () => {
    await sweepUntilQuiet(T, fake);
    await connect("tenant-elsewhere", "conn-elsewhere");
    fake.issue("10003").summary = "Edited (webhook)";
    const body = { webhookEvent: "jira:issue_updated", issue: { id: "10003", key: "OPS-1", fields: { summary: "FORGED SUMMARY" } } };
    expect(jiraWebhookIssueId(body)).toBe("10003");
    expect(jiraWebhookIssueId({ comment: { id: "c1" }, issue: { id: "x1; DROP" } })).toBeNull();
    expect(await handleJiraForwardWebhook(db as never, { type: "forward", from: "confluence", connectionId: CONN, payload: body })).toMatchObject({ handled: false });
    expect(await handleJiraForwardWebhook(db as never, { type: "forward", from: "jira", connectionId: "conn-unknown", providerConfigKey: "jira", payload: body })).toMatchObject({ handled: true, queued: 0 });
    expect(await handleJiraForwardWebhook(db as never, { type: "forward", from: "jira", connectionId: CONN, providerConfigKey: "jira", payload: body })).toMatchObject({ handled: true, queued: 1 });
    expect((await query(`SELECT 1 FROM jira_source_work WHERE tenant_id = 'tenant-elsewhere'`)).length).toBe(0);
    await sweepUntilQuiet(T, fake);
    const row = (await query<{ title: string; raw: any }>(`SELECT title, raw FROM jira_source_objects WHERE tenant_id = $1 AND content_id = '10003'`, [T]))[0]!;
    // The stored state is what Jira returned for the id, never the forwarded body.
    expect(row.title).toBe("Edited (webhook)");
    expect(JSON.stringify(row.raw)).not.toContain("FORGED SUMMARY");
  });
});
