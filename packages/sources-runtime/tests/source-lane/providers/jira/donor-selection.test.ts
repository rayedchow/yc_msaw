import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { handleNangoProxyDetailsTask, jiraSelectionJql } from "../../../../src/integrations/nango/proxy-details.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

/**
 * Coordinator regression: the donor nango.proxy_details Jira sweep honors jira_source_selection (the deep lane's
 * project selection) instead of capturing every project. PGlite, real SQL, fake Nango proxy.
 */

const T = "tenant-jsel";
const CONN = "conn-jsel";

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await resetAll();
  await query(`DELETE FROM jira_source_selection`);
});

function proxyFor(issues: Array<Record<string, unknown>>) {
  return vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
    if (input.endpoint === "/oauth/token/accessible-resources") return { status: 200, data: [{ id: "cloud-1", url: "https://acme.atlassian.net" }] };
    if (input.endpoint.endsWith("/rest/api/3/search/jql")) return { status: 200, data: { issues: input.params?.fields === "id" ? [] : issues } };
    return { status: 200, data: {} };
  });
}

const issue = (id: string, key: string) => ({ id, key, fields: { summary: key, updated: "2026-07-05T09:00:00.000+0000", project: { key: key.split("-")[0] } } });
const detailJql = (proxy: ReturnType<typeof proxyFor>) =>
  proxy.mock.calls.map((c) => c[0]).filter((c) => c.endpoint.endsWith("/search/jql") && c.params?.fields === "*all").map((c) => c.params?.jql);
const select = (mode: string, projects: string[], cloudId = "*") =>
  query(`INSERT INTO jira_source_selection (tenant_id, connection_id, cloud_id, mode, projects) VALUES ($1, $2, $3, $4, $5::jsonb)`, [T, CONN, cloudId, mode, JSON.stringify(projects)]);

describe("donor Jira proxy_details sweep and project selection", () => {
  it("keeps the donor query when every project is selected (default)", async () => {
    await connect(T, CONN);
    const proxy = proxyFor([issue("10001", "ENG-1")]);
    await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "jira" }, { client: { proxy: proxy as never } });
    expect(detailJql(proxy)).toEqual(['updated >= "1970-01-01" ORDER BY updated ASC']);
  });

  it("restricts the JQL to the selected projects and backfills a changed selection from the start", async () => {
    await connect(T, CONN);
    await select("projects", ["eng", "10200"]);
    const proxy = proxyFor([issue("10001", "ENG-1")]);
    await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "jira" }, { client: { proxy: proxy as never } });
    expect(detailJql(proxy)).toEqual(['project in (10200, "ENG") AND updated >= "1970-01-01" ORDER BY updated ASC']);

    // Same selection: the cursor advanced. A new selection gets its own cursor and starts from the beginning.
    const again = proxyFor([]);
    await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "jira" }, { client: { proxy: again as never } });
    expect(detailJql(again)[0]).not.toContain("1970-01-01");
    await query(`UPDATE jira_source_selection SET projects = '["ENG","OPS"]'::jsonb`);
    const widened = proxyFor([]);
    await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "jira" }, { client: { proxy: widened as never } });
    expect(detailJql(widened)).toEqual(['project in ("ENG", "OPS") AND updated >= "1970-01-01" ORDER BY updated ASC']);
  });

  it("captures nothing when the selection names no project, and never splices unsafe text into JQL", async () => {
    await connect(T, CONN);
    await select("projects", []);
    const proxy = proxyFor([issue("10001", "ENG-1")]);
    await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "jira" }, { client: { proxy: proxy as never } });
    expect(detailJql(proxy)).toEqual([]);
    expect(await query(`SELECT 1 FROM activity_events WHERE user_id = $1 AND event_type = 'issue_detail'`, [T])).toEqual([]);
    expect(jiraSelectionJql({ mode: "projects", projects: ['ENG") OR project is not EMPTY OR ("', "OPS"], source: "site", updatedBy: null, updatedAt: null })).toBe('project in ("OPS") AND ');
    expect(jiraSelectionJql({ mode: "projects", projects: ["a b"], source: "site", updatedBy: null, updatedAt: null })).toBeNull();
  });
});
