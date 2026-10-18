import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { MIGRATIONS_DIR } from "../../../../src/source-lane/core/migrations.js";
import { processGithubIssueRecord, processGithubPullRequestRecord } from "../../../../src/integrations/github/processors.js";
import { GITHUB_CONTENT_TASK, githubContentTaskHandlers } from "../../../../src/source-lane/providers/github/content.js";
import { githubCoverage } from "../../../../src/source-lane/providers/github/coverage.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import { sourceLaneTaskHandlers } from "../../../../src/source-lane/worker.js";
import { FakeGithub } from "./fake-github.js";
import { CONN, drain, journalCount, makeExporter, REPO, REPO_ID, sweepUntilQuiet, T } from "./fixtures.js";
import { connect, db, pg, query, ready, resetAll, select } from "./harness.js";

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
});

describe("github source-lane module", () => {
  it("is registered with its tables, task and routes, without colliding with donor handlers", () => {
    const reg = defaultRegistry();
    const m = reg.get("github")!;
    expect(m.eventSources).toEqual(["github"]);
    expect(m.extraTables!.map((t) => t.table)).toEqual(["github_source_repos", "github_source_refs", "github_source_files", "github_source_snapshots"]);
    for (const t of m.extraTables!) expect(reg.extraTable(t.table)?.provider.id).toBe("github");
    const handlers = sourceLaneTaskHandlers(reg);
    expect(typeof handlers[GITHUB_CONTENT_TASK]).toBe("function");
    expect(typeof handlers["nango.proxy_issues"]).toBe("function");
    expect(typeof m.internalRoutes).toBe("function");
  });

  it("9301 schedules the content sweep once per tenant with an active GitHub connection", async () => {
    await connect("t-a", "c-a");
    await connect("t-a", "c-a2");
    await connect("t-b", "c-b", { status: "pending" });
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, "9301_github_content_schedules.sql"), "utf8"));
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, "9301_github_content_schedules.sql"), "utf8"));
    expect(await query(`SELECT tenant_id, queue, group_key, kind, frequency_seconds, payload FROM task_schedules ORDER BY tenant_id`)).toEqual([
      { tenant_id: "t-a", queue: "sync", group_key: "t-a:github:content", kind: GITHUB_CONTENT_TASK, frequency_seconds: 300, payload: { tenantId: "t-a" } },
    ]);
  });

  it("journals provider-state changes only (scan bookkeeping, HEAD checks and timestamps never re-export)", async () => {
    const fake = new FakeGithub();
    fake.repo(REPO_ID, REPO);
    fake.commit(REPO_ID, "main", { "a.txt": "a" });
    await connect(T, CONN);
    await select(T, REPO);
    await sweepUntilQuiet(fake);
    const { exporter } = await makeExporter();
    await drain(exporter);
    expect(await journalCount()).toBe(0);
    await pg.exec(`
      UPDATE github_source_refs SET observed_head_sha = 'x', observed_head_at = now(), last_success_at = now(), error_streak = 3, last_error = 'e', updated_at = now(), next_generation = next_generation + 5;
      UPDATE github_source_files SET updated_at = now();
      UPDATE github_source_repos SET last_checked_at = now(), updated_at = now();
      INSERT INTO github_source_scan_entries (tenant_id, repo_id, ref_name, generation, path, mode, entry_type, blob_sha) VALUES ('${T}', '${REPO_ID}', 'main', 99, 'z', '100644', 'blob', 'b');
    `);
    expect(await journalCount()).toBe(0);
    await pg.exec(`UPDATE github_source_repos SET status = 'inaccessible'`);
    expect(await journalCount()).toBe(1);
  });

  it("refuses a task whose payload names another tenant than the server-written task row", async () => {
    const handler = githubContentTaskHandlers()[GITHUB_CONTENT_TASK]!;
    await expect(handler({ tenantId: "victim" }, { task: { id: "1", queue: "sync", tenantId: T }, heartbeat: async () => {} } as never)).rejects.toThrow(/does not match/u);
  });
});

describe("github donor lanes next to the content lane", () => {
  it("keeps the donor issue/PR projections and raw ledger rows (default mappings) and reports them as partial", async () => {
    await connect(T, CONN);
    const issue = { id: 1, number: 7, title: "Bug", body: "It breaks", state: "open", updated_at: "2026-07-02T00:00:00Z", repository: { id: REPO_ID, full_name: REPO }, user: { login: "dev" } };
    await processGithubIssueRecord(db as never, issue as never, { tenantId: T, provider: "github", providerConfigKey: "github", connectionId: CONN, model: "Issue" } as never);
    const pr = { id: 2, number: 8, title: "Fix", body: "Fixes #7", state: "open", updated_at: "2026-07-03T00:00:00Z", base: { repo: { id: REPO_ID, full_name: REPO } } };
    await processGithubPullRequestRecord(db as never, pr as never, { tenantId: T, provider: "github", providerConfigKey: "github", connectionId: CONN, model: "PullRequest" } as never);
    const ids = (await query(`SELECT source_event_id FROM activity_events WHERE user_id = $1 ORDER BY source_event_id`, [T])).map((r) => r.source_event_id);
    expect(ids).toEqual([`github:issue:${REPO_ID}:7:2026-07-02T00:00:00Z`, `github:pr:${REPO_ID}:8:2026-07-03T00:00:00Z`]);
    const { exporter, yc } = await makeExporter();
    await drain(exporter);
    expect(await yc.text("sources/github/acme/widgets/issue-7.md")).toContain("It breaks");
    expect(await yc.text("sources/github/acme/widgets/pr-8.md")).toContain("Fixes #7");
    const raw = (await yc.paths("sources/github/_raw")).find((p) => p.includes("github:issue:"));
    expect(raw).toBeTruthy();
    expect((await yc.json(raw!)).raw_payload.body).toBe("It breaks");
    const cov = await githubCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === "activity")).toMatchObject({ state: "partial", counts: { issue: 1, pull_request: 1 } });
    expect(cov.find((c) => c.scope === "repositories")).toMatchObject({ state: "pending" });
  });
});
