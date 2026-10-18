import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { processJiraIssueRecord } from "../../../../src/integrations/atlassian/processors.js";
import { AttachmentTooLargeError, JiraApiError, assertApiPath, resolveDownloadRedirect, retryAfterMsOf } from "../../../../src/source-lane/providers/jira/api.js";
import { jiraCoverage } from "../../../../src/source-lane/providers/jira/coverage.js";
import { parseSelectionBody, registerJiraInternalRoutes } from "../../../../src/source-lane/providers/jira/routes.js";
import { FakeJira, NANGO_BASE } from "./fake-jira.js";
import { CLOUD, CONN, drain, ENG, issuePath, makeExporter, nowJira, OPS, ROOT, seedSite, sweepUntilQuiet } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

const T = "tenant-j3";
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

/** Internal API as core mounts it: tenant already verified equal to the forwarded principal. */
function internalApp(tenantId: string, scopes: string[] | undefined): Hono {
  const app = new Hono();
  app.use("/tenants/:tenantId/*", async (c, next) => {
    (c as any).set("principal", { tenantNs: tenantId, subject: "user-1", issuer: "https://auth.test", ...(scopes ? { scopes } : {}) });
    (c as any).set("tenantId", tenantId);
    await next();
  });
  registerJiraInternalRoutes(app, { tenantOf: (c) => (c as any).get("tenantId") }, async () => db as never);
  return app;
}

const put = (app: Hono, tenantId: string, body: unknown) =>
  app.request(`/tenants/${tenantId}/jira/selection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("jira project selection (server-bound per tenant connection)", () => {
  it("parses strictly: no tenant field, no unknown keys, valid project keys only", () => {
    expect(parseSelectionBody({ mode: "projects", projects: ["ENG"], tenantId: "other" })).toMatch(/unknown field/u);
    expect(parseSelectionBody({ mode: "projects", projects: [] })).toMatch(/at least one/u);
    expect(parseSelectionBody({ mode: "projects", projects: ["ENG; DROP"] })).toMatch(/project keys/u);
    expect(parseSelectionBody({ mode: "all", projects: ["ENG"] })).toMatch(/takes no projects/u);
    expect(parseSelectionBody({ mode: "projects", projects: ["ENG", "10001"] })).toEqual({ connectionId: undefined, cloudId: undefined, mode: "projects", projects: ["ENG", "10001"] });
  });

  it("requires memory:build to change and memory:read to view; never reaches another tenant's connection", async () => {
    expect((await put(internalApp(T, ["memory:read"]), T, { mode: "all" })).status).toBe(403);
    expect((await put(internalApp(T, undefined), T, { mode: "all" })).status).toBe(403);
    expect((await internalApp(T, []).request(`/tenants/${T}/jira/selection`)).status).toBe(403);
    await connect("tenant-rival", "conn-rival");
    const r = await put(internalApp(T, ["memory:build"]), T, { connectionId: "conn-rival", mode: "all" });
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("unknown_connection");
    expect((await query(`SELECT 1 FROM jira_source_selection`)).length).toBe(0);
    const unknownSite = await put(internalApp(T, ["memory:build"]), T, { cloudId: "cloud-elsewhere", mode: "all" });
    expect(unknownSite.status).toBe(404);
  });

  it("limits capture to the selected projects, removes deselected ones from the mirror (not as deletions) and restores them when reselected", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.file(issuePath("OPS", "OPS-1"))).not.toBeNull();

    const app = internalApp(T, ["memory:build", "memory:read"]);
    const r = await put(app, T, { mode: "projects", projects: ["ENG"] });
    expect(r.status).toBe(200);
    const view = await r.json();
    expect(view.connections[0].sites[0].selection).toMatchObject({ mode: "projects", projects: ["ENG"], source: "connection" });
    expect((await query<{ updated_by: string }>(`SELECT updated_by FROM jira_source_selection WHERE tenant_id = $1`, [T]))[0]!.updated_by).toBe("https://auth.test#user-1");

    fake.issue("10003").updated = nowJira();
    await sweepUntilQuiet(T, fake);
    await drain(exporter);
    expect((await yc.tombstone(issuePath("OPS", "OPS-1")))?.reason).toBe("jira_outside_selection");
    expect((await yc.tombstone(`${ROOT}/projects/OPS/_project.md`))?.reason).toBe("jira_outside_selection");
    expect(await yc.file(issuePath("ENG", "ENG-1"))).not.toBeNull();
    expect((await yc.json(`${ROOT}/_site.json`)).projectSelection).toEqual({ mode: "projects", projects: ["ENG"], source: "connection" });
    // Deltas are restricted to the selected project ids; OPS was not re-read although it changed.
    const deltas = fake.callsTo(/\/search\/jql\?/u).map((c) => c.url.searchParams.get("jql") ?? "").filter((j) => j.includes("updated >="));
    expect(deltas.at(-1)).toMatch(new RegExp(`^project in \\(${ENG}\\) AND updated >= "-\\d+m"`, "u"));
    const s = (await jiraCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(s.reason).toMatch(/^selected projects only \(ENG\)/u);
    expect(s.counts?.outsideSelection).toBeGreaterThan(0);

    await put(app, T, { mode: "all" });
    await sweepUntilQuiet(T, fake);
    await drain(exporter);
    expect(await yc.text(issuePath("OPS", "OPS-1"))).toContain("- Issue ID: 10003");
  });
});

describe("donor mirror (sources/jira/<PROJECT>/<KEY>.md) export-time cleanup", () => {
  it("removes the old-key donor file of a moved issue, keyed by the stable numeric id, and keeps the new one", async () => {
    const ctx = { tenantId: T, connectionId: CONN, providerConfigKey: "jira" };
    // Donor lane, production processor: slim Nango Issue records.
    await processJiraIssueRecord(db as never, { id: "10001", key: "ENG-1", summary: "Login fails", projectKey: "ENG", updatedAt: "2026-01-05T09:00:00.000Z" }, ctx);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.text("sources/jira/ENG/ENG-1.md")).toContain("ENG-1: Login fails");

    await processJiraIssueRecord(db as never, { id: "10001", key: "OPS-9", summary: "Login fails", projectKey: "OPS", updatedAt: "2026-01-09T09:00:00.000Z" }, ctx);
    // The donor writes the new path and leaves the old one in mirror_files.
    expect((await query(`SELECT path FROM mirror_files WHERE user_id = $1 AND path LIKE 'sources/jira/%/%.md' ORDER BY path`, [T])).map((r: any) => r.path)).toEqual(
      expect.arrayContaining(["sources/jira/ENG/ENG-1.md", "sources/jira/OPS/OPS-9.md"]),
    );
    await drain(exporter);
    expect(await yc.text("sources/jira/OPS/OPS-9.md")).toContain("OPS-9: Login fails");
    expect(await yc.file("sources/jira/ENG/ENG-1.md")).toBeNull();
    expect((await yc.tombstone("sources/jira/ENG/ENG-1.md"))?.reason).toBe("jira_issue_moved");
    // A later rewrite of the stale row (e.g. index refresh) cannot resurrect it.
    await query(`UPDATE mirror_files SET content = content || ' ', updated_at = now() WHERE user_id = $1 AND path = 'sources/jira/ENG/ENG-1.md'`, [T]);
    await drain(exporter);
    expect(await yc.file("sources/jira/ENG/ENG-1.md")).toBeNull();
    // Raw donor ledger rows stay (append-only).
    expect((await yc.paths("sources/jira/_raw")).length).toBe(2);
  });

  it("does not let a stale deep-lane key delete a newer donor file, and leaves files of issues that only lost access", async () => {
    await sweepUntilQuiet(T, fake);
    const ctx = { tenantId: T, connectionId: CONN, providerConfigKey: "jira" };
    // Donor saw the move first (newer updated stamp than the deep lane's row).
    await processJiraIssueRecord(db as never, { id: "10002", key: "OPS-5", summary: "Payment receipt is blank", projectKey: "OPS", updatedAt: nowJira() }, ctx);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.file("sources/jira/OPS/OPS-5.md")).not.toBeNull();
    // Access lost (security level): deep lane keeps it; the donor file is not removed either.
    await processJiraIssueRecord(db as never, { id: "10001", key: "ENG-1", summary: "Login fails", projectKey: "ENG", updatedAt: "2026-01-05T09:00:00.000Z" }, ctx);
    fake.issue("10001").hidden = true;
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    await drain(exporter);
    expect(await yc.file("sources/jira/ENG/ENG-1.md")).not.toBeNull();
  });

  it("disables id-based donor cleanup when the tenant reaches several Jira sites (donor paths are not site-scoped)", async () => {
    fake.site(CONN, "cloud-j2", "https://other.atlassian.net");
    await sweepUntilQuiet(T, fake);
    const ctx = { tenantId: T, connectionId: CONN, providerConfigKey: "jira" };
    await processJiraIssueRecord(db as never, { id: "10001", key: "ENG-1", summary: "x", projectKey: "ENG", updatedAt: "2026-01-05T09:00:00.000Z" }, ctx);
    await processJiraIssueRecord(db as never, { id: "10001", key: "OPS-9", summary: "x", projectKey: "OPS", updatedAt: "2026-01-09T09:00:00.000Z" }, ctx);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.file("sources/jira/ENG/ENG-1.md")).not.toBeNull();
    const donor = (await jiraCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === "nango-records")!;
    expect(donor.state).toBe("partial");
    expect(donor.reason).toMatch(/several Jira sites/u);
  });
});

describe("jira client transport", () => {
  it("parses Retry-After seconds / HTTP-date and Atlassian X-RateLimit-Reset", () => {
    const now = Date.parse("2026-10-17T00:00:00Z");
    expect(retryAfterMsOf(new Headers({ "retry-after": "17" }), now)).toBe(17_000);
    expect(retryAfterMsOf(new Headers({ "retry-after": "Sat, 17 Oct 2026 00:01:00 GMT" }), now)).toBe(60_000);
    expect(retryAfterMsOf(new Headers({ "x-ratelimit-reset": "2026-10-17T00:00:30Z" }), now)).toBe(30_000);
    expect(retryAfterMsOf(new Headers({}), now)).toBeNull();
  });

  it("never forwards credentials off the proxy and refuses non-REST paths", () => {
    const current = new URL(`${NANGO_BASE}/proxy/ex/jira/${CLOUD}/rest/api/3/attachment/content/1`);
    expect(() => resolveDownloadRedirect("https://evil.example/x", CLOUD, NANGO_BASE, current)).toThrow(JiraApiError);
    expect(() => resolveDownloadRedirect("http://api.media.atlassian.com/x", CLOUD, NANGO_BASE, current)).toThrow(/non-https/u);
    expect(() => resolveDownloadRedirect("/secure/admin/x", CLOUD, NANGO_BASE, current)).toThrow(/outside the site attachment API/u);
    expect(resolveDownloadRedirect("https://api.media.atlassian.com/file/1/binary?token=t", CLOUD, NANGO_BASE, current)).toMatchObject({ authenticated: false });
    expect(resolveDownloadRedirect("/rest/api/3/attachment/content/1?redirect=false", CLOUD, NANGO_BASE, current).url.href).toBe(`${NANGO_BASE}/proxy/ex/jira/${CLOUD}/rest/api/3/attachment/content/1?redirect=false`);
    expect(() => assertApiPath("/rest/api/3/../../admin")).toThrow();
    expect(() => assertApiPath("/wiki/api/v2/pages")).toThrow();
  });

  it("refuses an attachment redirect to a foreign host and reports the bytes as missing, not complete", async () => {
    fake.downloadMode = "evil-redirect";
    await sweepUntilQuiet(T, fake, { maxItemAttempts: 1 });
    expect(fake.calls.some((c) => c.url.hostname === "evil.example")).toBe(false);
    const s = (await jiraCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(s.state).toBe("partial");
    expect(s.reason).toMatch(/2 live attachment\(s\) without bytes/u);
    expect(s.reason).toMatch(/work item\(s\) failed after retries/u);
  });

  it("marks attachments over the byte limit too_large and says so in coverage", async () => {
    fake.downloadMode = "direct";
    await sweepUntilQuiet(T, fake, { maxAttachmentBytes: 1024 });
    const rows = await query<{ content_id: string; binary_status: string }>(`SELECT content_id, binary_status FROM jira_source_objects WHERE tenant_id = $1 AND content_type = 'attachment' ORDER BY content_id`, [T]);
    expect(rows).toEqual([{ content_id: "a1", binary_status: "too_large" }, { content_id: "a2", binary_status: "too_large" }]);
    expect(fake.callsTo(/attachment\/content/u)).toHaveLength(0); // declared size checked before downloading
    const s = (await jiraCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === `site:${CLOUD}/${CONN}`)!;
    expect(s.reason).toMatch(/2 over the size limit/u);
    expect(new AttachmentTooLargeError(2048, 1024).message).toMatch(/over the 1024 byte capture limit/u);
  });

  it("blocks the site on an unusable grant and reports it", async () => {
    fake.intercept((u) => u.pathname.endsWith("/project/search"), () => Response.json({ error: { code: "invalid_credentials" } }, { status: 401 }), 5);
    await sweepUntilQuiet(T, fake);
    const s = (await jiraCoverage({ tenantId: T, executor: db as never })).find((x) => x.scope === `site:${CLOUD}/${CONN}`)!;
    expect(s.state).toBe("blocked");
    expect(s.reason).toMatch(/not authorized/u);
  });

  it("reports a revoked connection as blocked and makes no provider call for it", async () => {
    await query(`UPDATE connections SET status = 'revoked' WHERE tenant_id = $1`, [T]);
    await sweepUntilQuiet(T, fake);
    expect(fake.calls).toHaveLength(0);
    const r = await jiraCoverage({ tenantId: T, executor: db as never });
    expect(r).toEqual([expect.objectContaining({ scope: `connection:${CONN}`, state: "blocked" })]);
  });

  it("tombstones a project found in the Jira trash together with its issues", async () => {
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    fake.project(OPS).trashed = true;
    await sweepUntilQuiet(T, fake, { fullScanIntervalMs: 0 });
    await drain(exporter);
    expect((await yc.tombstone(`${ROOT}/projects/OPS/_project.md`))?.reason).toBe("jira_trashed");
    expect((await yc.tombstone(issuePath("OPS", "OPS-1")))?.reason).toBe("jira_project_trashed");
    expect(await yc.file(issuePath("ENG", "ENG-1"))).not.toBeNull();
  });
});
