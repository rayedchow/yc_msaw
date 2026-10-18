import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { processJiraCommentRecord, processJiraIssueRecord } from "../../../../src/integrations/atlassian/processors.js";
import { registerJiraInternalRoutes } from "../../../../src/source-lane/providers/jira/routes.js";
import { CONN, drain, makeExporter } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

/**
 * Coordinator regression: donor Jira rows (Nango record sync and the detail sweep: raw ledger under
 * sources/jira/_raw/ and the donor projection sources/jira/<PROJECT>/<KEY>.md) follow the tenant's project
 * selection at export. Deselecting removes them from $SOURCES; reselecting restores them. Real exporter, PGlite.
 */

const T = "tenant-jdx";

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await resetAll();
  await query(`DELETE FROM jira_source_selection`);
  await connect(T, CONN);
});

function internalApp(): Hono {
  const app = new Hono();
  app.use("/tenants/:tenantId/*", async (c, next) => {
    (c as any).set("principal", { tenantNs: T, subject: "user-1", issuer: "https://auth.test", scopes: ["memory:build", "memory:read"] });
    (c as any).set("tenantId", T);
    await next();
  });
  registerJiraInternalRoutes(app, { tenantOf: (c) => (c as any).get("tenantId") }, async () => db as never);
  return app;
}
const select = (body: unknown) =>
  internalApp().request(`/tenants/${T}/jira/selection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function seedDonor() {
  const ctx = { tenantId: T, connectionId: CONN, providerConfigKey: "jira" };
  await processJiraIssueRecord(db as never, { id: "20001", key: "ENG-1", summary: "Engineering issue", projectKey: "ENG", updatedAt: "2026-02-01T09:00:00.000Z" }, ctx);
  await processJiraIssueRecord(db as never, { id: "20002", key: "OPS-1", summary: "Ops issue", projectKey: "OPS", updatedAt: "2026-02-01T09:00:00.000Z" }, ctx);
  // A comment without its issue key: its project is resolved through the captured issue row.
  await processJiraCommentRecord(db as never, { id: "c-ops", issueId: "20002", body: "ops comment", created: "2026-02-02T09:00:00.000Z" }, ctx);
  await processJiraCommentRecord(db as never, { id: "c-eng", issueId: "20001", issueKey: "ENG-1", body: "eng comment", created: "2026-02-02T09:00:00.000Z" }, ctx);
}

async function rawTexts(yc: Awaited<ReturnType<typeof makeExporter>>["yc"]): Promise<string[]> {
  const out: string[] = [];
  for (const p of await yc.paths("sources/jira/_raw")) out.push(await yc.text(p));
  return out;
}

describe("donor Jira rows follow the project selection at export", () => {
  it("exports every project by default, hides deselected projects' raw rows, comments and projections, and restores them", async () => {
    await seedDonor();
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.file("sources/jira/OPS/OPS-1.md")).not.toBeNull();
    expect(await yc.file("sources/jira/ENG/ENG-1.md")).not.toBeNull();
    const all = await rawTexts(yc);
    expect(all.some((t) => t.includes("ops comment"))).toBe(true);

    expect((await select({ mode: "projects", projects: ["ENG"] })).status).toBe(200);
    await drain(exporter);
    expect(await yc.file("sources/jira/OPS/OPS-1.md")).toBeNull();
    expect((await yc.tombstone("sources/jira/OPS/OPS-1.md"))?.reason).toBe("jira_outside_selection");
    expect(await yc.file("sources/jira/ENG/ENG-1.md")).not.toBeNull();
    const selected = await rawTexts(yc);
    expect(selected.some((t) => t.includes("Ops issue") || t.includes("ops comment"))).toBe(false);
    expect(selected.some((t) => t.includes("Engineering issue"))).toBe(true);
    expect(selected.some((t) => t.includes("eng comment"))).toBe(true);

    // New donor capture of a deselected project never reaches $SOURCES.
    await processJiraIssueRecord(db as never, { id: "20003", key: "OPS-2", summary: "Later ops issue", projectKey: "OPS", updatedAt: "2026-02-03T09:00:00.000Z" }, { tenantId: T, connectionId: CONN, providerConfigKey: "jira" });
    await drain(exporter);
    expect(await yc.file("sources/jira/OPS/OPS-2.md")).toBeNull();
    expect((await rawTexts(yc)).some((t) => t.includes("Later ops issue"))).toBe(false);

    expect((await select({ mode: "all" })).status).toBe(200);
    await drain(exporter);
    expect(await yc.file("sources/jira/OPS/OPS-1.md")).not.toBeNull();
    expect(await yc.file("sources/jira/OPS/OPS-2.md")).not.toBeNull();
    expect((await rawTexts(yc)).some((t) => t.includes("ops comment"))).toBe(true);
  });

  it("ignores selections of connections that are no longer active", async () => {
    await seedDonor();
    await query(`INSERT INTO jira_source_selection (tenant_id, connection_id, cloud_id, mode, projects) VALUES ($1, 'conn-old', '*', 'projects', '["ENG"]'::jsonb)`, [T]);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.file("sources/jira/OPS/OPS-1.md")).not.toBeNull();
  });
});
