import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NANGO_WEBHOOK_SECRET = "jira-shared-patch-webhook-secret";
});

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { processJiraIssueRecord } from "../../../../src/integrations/atlassian/processors.js";
import { processGenericNangoRecord } from "../../../../src/integrations/nango/capture.js";
import { handleNangoProxyDetailsTask } from "../../../../src/integrations/nango/proxy-details.js";
import { disableNangoPollSchedule, saveStoredCursor } from "../../../../src/integrations/nango/tasks.js";
import { handleNangoWebhook } from "../../../../src/integrations/nango/webhook.js";
import { startNangoPolling } from "../../../../src/queue/dispatch.js";
import { FakeJira } from "./fake-jira.js";
import { CONN, seedSite, sweepUntilQuiet } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

/** Regressions for patch-requests/jira.md requests 1-5 (shared dispatch.ts, nango/tasks.ts, atlassian/processors.ts, nango/webhook.ts, nango/proxy-details.ts). PGlite, real SQL. */

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await resetAll();
});

const T = "tenant-jsp";

function detailProxy(issue: Record<string, unknown>) {
  return vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
    if (input.endpoint === "/oauth/token/accessible-resources") return { status: 200, data: [{ id: "cloud-1", url: "https://acme.atlassian.net" }] };
    if (input.endpoint.endsWith("/rest/api/3/search/jql")) return { status: 200, data: { issues: input.params?.fields === "id" ? [] : [issue] } };
    return { status: 200, data: {} };
  });
}

describe("jira shared patches", () => {
  it("startNangoPolling schedules the Jira deep sweep in its own group; disconnect disables it (requests 1, 2)", async () => {
    await startNangoPolling(T, "jira");
    const rows = await query<{ kind: string; group_key: string; frequency_seconds: number }>(`SELECT kind, group_key, frequency_seconds FROM task_schedules WHERE tenant_id = $1 ORDER BY kind`, [T]);
    expect(rows.map((r) => [r.kind, r.group_key, r.frequency_seconds])).toEqual([
      ["jira.sweep", `${T}:jira:sweep`, 300],
      ["nango.poll", `${T}:nango:jira`, 60],
      ["nango.proxy_details", `${T}:nango:jira`, 300],
    ]);
    await startNangoPolling(T, "confluence");
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM task_schedules WHERE kind = 'jira.sweep'`))[0]!.n).toBe(1);
    await disableNangoPollSchedule(db as never, T, "jira");
    expect(await query(`SELECT kind, enabled FROM task_schedules WHERE tenant_id = $1 AND group_key LIKE '%jira%' ORDER BY kind`, [T])).toEqual([
      { kind: "jira.sweep", enabled: false },
      { kind: "nango.poll", enabled: false },
      { kind: "nango.proxy_details", enabled: false },
    ]);
  });

  it("a slim Issue record no longer overwrites the mirror rendered from a newer-or-equal issue_detail (request 3)", async () => {
    await connect(T, "conn-sp");
    const updated = "2026-07-05T09:00:00.000+0000";
    const detail = {
      id: "10001",
      key: "ENG-1",
      fields: {
        summary: "Login fails",
        updated,
        project: { key: "ENG" },
        reporter: { displayName: "Riley", emailAddress: "riley@example.test" },
        comment: { total: 1, comments: [{ id: "c1", created: "2026-07-02T09:00:00.000+0000", author: { displayName: "Ann" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Rich comment" }] }] } }] },
      },
    };
    await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "jira" }, { client: { proxy: detailProxy(detail) as never } });
    const mirror = async () => (await query<{ content: string }>(`SELECT content FROM mirror_files WHERE user_id = $1 AND path = 'sources/jira/ENG/ENG-1.md'`, [T]))[0]!.content;
    expect(await mirror()).toContain("Rich comment");

    // Same `updated` (the poll lagging behind the proxy sweep): the rich mirror survives.
    await processJiraIssueRecord(db as never, { id: "10001", key: "ENG-1", summary: "Login fails", projectKey: "ENG", updatedAt: "2026-07-05T09:00:00.000Z", reporter_id: "acct-1" }, { tenantId: T, connectionId: "conn-sp" });
    expect(await mirror()).toContain("Rich comment");
    expect(await mirror()).toContain("riley@example.test");
    // The slim record itself is still captured raw (append-only ledger unchanged).
    expect((await query(`SELECT 1 FROM activity_events WHERE user_id = $1 AND event_type = 'issue'`, [T])).length).toBe(1);

    // A genuinely newer slim record still renders (donor behaviour) until the next detail sweep.
    await processJiraIssueRecord(db as never, { id: "10001", key: "ENG-1", summary: "Login fails (renamed)", projectKey: "ENG", updatedAt: "2026-07-06T09:00:00.000Z" }, { tenantId: T, connectionId: "conn-sp" });
    expect(await mirror()).toContain("Login fails (renamed)");
  });

  it("a signed Jira forward webhook queues a by-id refresh in the deep lane (request 4)", async () => {
    const fake = new FakeJira();
    seedSite(fake);
    await connect(T, CONN);
    await sweepUntilQuiet(T, fake);
    const body = JSON.stringify({ type: "forward", from: "jira", connectionId: CONN, providerConfigKey: "jira", payload: { webhookEvent: "jira:issue_updated", issue: { id: "10003" } } });
    const signature = createHmac("sha256", process.env.NANGO_WEBHOOK_SECRET!).update(body).digest("hex");
    expect((await handleNangoWebhook({ body, signature })).status).toBe(204);
    expect(await query(`SELECT item_key, state FROM jira_source_work WHERE tenant_id = $1 AND item_key = 'refresh:issue:10003'`, [T])).toEqual([{ item_key: "refresh:issue:10003", state: "pending" }]);
    expect((await handleNangoWebhook({ body, signature: "00".repeat(32) })).status).toBe(401);
  });

  it("the donor deletion reconcile lists with bounded JQL and deletes the newest key's mirror, not max(key) (request 5)", async () => {
    await connect(T, "conn-sp");
    const ctx = { tenantId: T, connectionId: "conn-sp" };
    await processJiraIssueRecord(db as never, { id: "10009", key: "ZZZ-1", summary: "old key", projectKey: "ZZZ", updatedAt: "2026-07-01T00:00:00.000Z" }, ctx);
    await processJiraIssueRecord(db as never, { id: "10009", key: "AAA-1", summary: "moved", projectKey: "AAA", updatedAt: "2026-07-02T00:00:00.000Z" }, ctx);
    await saveStoredCursor(db as never, { tenantId: T, provider: "jira", connectionId: "conn-sp", model: "issue_deletion_sweep" }, "2026-01-01T00:00:00.000Z");
    const proxy = vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
      if (input.endpoint === "/oauth/token/accessible-resources") return { status: 200, data: [{ id: "cloud-1", url: "https://acme.atlassian.net" }] };
      if (input.endpoint.endsWith("/rest/api/3/search/jql")) return { status: 200, data: { issues: [] } };
      if (input.endpoint.endsWith("/rest/api/3/issue/10009")) return { status: 404, data: null };
      return { status: 200, data: {} };
    });
    const r = (await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "jira" }, { client: { proxy: proxy as never } })) as { deletionReconcile: Record<string, number> };
    expect(r.deletionReconcile).toMatchObject({ tombstoned: 1, mirrorsDeleted: 1 });
    const listing = proxy.mock.calls.map((c) => c[0]).find((c) => c.params?.fields === "id");
    expect(listing?.params?.jql).toBe('created >= "1970-01-01" ORDER BY created ASC');
    const paths = (await query<{ path: string }>(`SELECT path FROM mirror_files WHERE user_id = $1 AND path LIKE 'sources/jira/%/%-1.md' ORDER BY path`, [T])).map((x) => x.path);
    // The donor removes only one key per issue; it is now the current one (the stale old-key file is removed at export by the jira module).
    expect(paths).toEqual(["sources/jira/ZZZ/ZZZ-1.md"]);
  });
});
