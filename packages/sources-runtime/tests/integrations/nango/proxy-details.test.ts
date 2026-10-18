import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as unknown[]));
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const upsertScheduleMock = vi.hoisted(() => vi.fn(async (_input: { kind: string; groupKey?: string; payload?: Record<string, unknown> }) => undefined));

vi.mock("../../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../../src/queue/sweeper.js", () => ({
  upsertTaskSchedule: upsertScheduleMock,
}));

// Keep the real dispatch module (so startNangoPolling is exercised) but stub
// the outbox emit that capture.ts triggers.
vi.mock("../../../src/queue/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/queue/dispatch.js")>();
  return { ...actual, enqueueCollectedEventForProcessing: enqueueCollectedEventMock };
});

import { handleNangoProxyDetailsTask } from "../../../src/integrations/nango/proxy-details.js";
import { startNangoPolling } from "../../../src/queue/dispatch.js";
import type { NangoExecutor } from "../../../src/integrations/nango/types.js";

interface RouteState {
  connections: Array<{ external_account_id: string | null; nango_connection_id: string | null; provider_config_key: string | null }>;
  repos: string[];
  /** Repos with an explicit `syncing = true` selection row (github is opt-in). */
  syncedRepos: string[];
  cursor: string | null;
  /** `issue_deletion_sweep` watermark (last jira deletion reconcile timestamp). */
  deletionSweepCursor: string | null;
  /** Rows for the jira captured-issue enumeration query. */
  capturedIssues: Array<{ issue_id: string; issue_key: string | null; tombstoned: boolean }>;
  failCapturedIssuesQuery: boolean;
  storeEvents: boolean;
  githubParentRows: Array<{ id: string; event_type: string; source_event_id: string; raw_payload: Record<string, unknown> }>;
  githubCommentRows: Array<Record<string, unknown>>;
}

let state: RouteState;
let eventSeq: number;

function routeExecute(query: unknown): unknown[] {
  const text = sqlText(query);
  if (text.includes("INSERT INTO activity_events")) {
    if (!state.storeEvents) return [];
    eventSeq += 1;
    return [{ id: `event-${eventSeq}` }];
  }
  if (text.includes("INSERT INTO conversation_watermarks")) return [];
  if (text.includes("conversation_watermarks")) {
    const params = sqlParams(query);
    if (params.some((p) => typeof p === "string" && p.endsWith(":issue_deletion_sweep"))) {
      return state.deletionSweepCursor ? [{ last_seen_ts: state.deletionSweepCursor }] : [];
    }
    return state.cursor ? [{ last_seen_ts: state.cursor }] : [];
  }
  if (text.includes("FROM github_repo_sync")) {
    return state.syncedRepos.map((repo_full_name) => ({ repo_full_name, syncing: true }));
  }
  if (text.includes("FROM connections")) return state.connections;
  if (text.includes("WITH latest AS") && text.includes("source = 'github'")) return state.githubCommentRows;
  if (text.includes("source = 'github'") && text.includes("LIMIT 1") && text.includes("raw_payload->>'number'")) {
    return state.githubParentRows;
  }
  if (text.includes("FROM activity_events") && text.includes("issue_id")) {
    if (state.failCapturedIssuesQuery) throw new Error("enumeration unavailable");
    return state.capturedIssues;
  }
  if (text.includes("FROM activity_events")) return state.repos.map((full_name) => ({ full_name }));
  return [];
}

const JIRA_SITE = { id: "cloud-1", url: "https://acme.atlassian.net", name: "acme" };

function jiraSearchIssue(): Record<string, unknown> {
  return {
    id: "10001",
    key: "PROJ-9",
    self: "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10001",
    fields: {
      summary: "Deep capture",
      description: "Full issue description body",
      updated: "2026-07-02T00:00:00.000Z",
      project: { key: "PROJ" },
      status: { name: "In Progress" },
      reporter: { displayName: "Riley Reporter", emailAddress: "riley@example.com" },
      comment: {
        total: 1,
        comments: [{
          id: "501",
          body: "Comment body text",
          updated: "2026-07-02T01:00:00.000Z",
          author: { displayName: "Commenter", emailAddress: "commenter@example.com" },
        }],
      },
    },
    changelog: {
      histories: [{
        created: "2026-07-02T00:00:00.000Z",
        author: { displayName: "Edna Editor", emailAddress: "edna@example.com" },
      }],
    },
  };
}

function resetProxyDetailsTestState(): void {
  eventSeq = 0;
  state = {
    connections: [{ external_account_id: "conn-1", nango_connection_id: null, provider_config_key: "jira" }],
    repos: [],
    syncedRepos: ["octo/hello"],
    cursor: null,
    deletionSweepCursor: null,
    capturedIssues: [],
    failCapturedIssuesQuery: false,
    storeEvents: true,
    githubParentRows: [],
    githubCommentRows: [],
  };
  executeMock.mockReset().mockImplementation(async (query: unknown) => routeExecute(query));
  enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
  upsertScheduleMock.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

describe("Nango proxy details capture", () => {
  beforeEach(() => {
    resetProxyDetailsTestState();
  });

  it("captures full jira issue details + comments, mirrors them, and advances the per-site cursor", async () => {
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/oauth/token/accessible-resources") {
        return { status: 200, data: [JIRA_SITE] };
      }
      if (input.endpoint === "/ex/jira/cloud-1/rest/api/3/search/jql") {
        return { status: 200, data: { issues: [jiraSearchIssue()] } };
      }
      return { status: 200, data: {} };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "jira" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ connections: 1, issues: 1, captured: 1, comments: 1, materialized: 1 });

    // First run has no cursor → full-history backfill JQL.
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/ex/jira/cloud-1/rest/api/3/search/jql",
      params: expect.objectContaining({
        jql: 'updated >= "1970-01-01" ORDER BY updated ASC',
        fields: "*all",
        expand: "changelog",
      }),
    }));

    const inserts = insertParams("INSERT INTO activity_events");
    // Distinct versioned kinds: full detail + each comment individually.
    expect(inserts.some((p) => p.includes("nango:jira:issue_detail:10001:2026-07-02T00:00:00.000Z"))).toBe(true);
    expect(inserts.some((p) => p.includes("nango:jira:issue_comment:501:2026-07-02T01:00:00.000Z"))).toBe(true);
    const eventInserts = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .filter((call) => call.text.includes("INSERT INTO activity_events"));
    const detail = eventInserts.find((call) => call.params.includes("nango:jira:issue_detail:10001:2026-07-02T00:00:00.000Z"));
    const comment = eventInserts.find((call) => call.params.includes("nango:jira:issue_comment:501:2026-07-02T01:00:00.000Z"));
    expect(detail?.params).toEqual(expect.arrayContaining(["site:cloud-1", "issue:10001"]));
    expect(comment?.params).toEqual(expect.arrayContaining(["site:cloud-1", "comment:501"]));

    // Mirror re-materialized from the FULL payload: description, comment,
    // reporter email + last-updater email in the envelope.
    const mirror = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO mirror_files") && c.params.includes("sources/jira/PROJ/PROJ-9.md"));
    expect(mirror).toBeDefined();
    const content = mirror!.params.find((p): p is string => typeof p === "string" && p.includes("# PROJ-9: Deep capture"));
    expect(content).toContain("Full issue description body");
    expect(content).toContain("Comment body text");
    expect(content).toContain("### Comment 501");
    const meta = mirror!.params.find((p): p is string => typeof p === "string" && p.includes("\"authorEmail\""));
    expect(meta).toContain("riley@example.com");
    expect(meta).toContain("\"updatedByEmail\":\"edna@example.com\"");
    expect(JSON.parse(meta!).sourceRefs).toContainEqual({
      anchor: "Comment 501",
      sourceEventId: "nango:jira:issue_comment:501:2026-07-02T01:00:00.000Z",
    });

    // Per-site cursor saved from the issue's updated stamp.
    const cursorSave = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO conversation_watermarks"));
    expect(cursorSave?.params).toContain("issue_details:cloud-1");
    expect(cursorSave?.params).toContain("2026-07-02T00:00:00.000Z");
  });

  it("merges overflow Jira comments into the mirror, deduped and chronological", async () => {
    const issue = jiraSearchIssue();
    const fields = issue.fields as Record<string, unknown>;
    fields.comment = {
      total: 3,
      comments: [{
        id: "502",
        body: "Second inline copy",
        created: "2026-07-02T02:00:00.000Z",
      }],
    };
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/oauth/token/accessible-resources") {
        return { status: 200, data: [JIRA_SITE] };
      }
      if (input.endpoint === "/ex/jira/cloud-1/rest/api/3/search/jql") {
        return { status: 200, data: { issues: [issue] } };
      }
      if (input.endpoint.endsWith("/issue/10001/comment")) {
        return {
          status: 200,
          data: {
            total: 3,
            comments: [
              { id: "503", body: "Third comment", created: "2026-07-02T03:00:00.000Z" },
              { id: "501", body: "First comment", created: "2026-07-02T01:00:00.000Z" },
              { id: "502", body: "Second paged copy", created: "2026-07-02T02:00:00.000Z" },
            ],
          },
        };
      }
      return { status: 200, data: {} };
    });

    await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "jira" },
      { client: { proxy } },
    );

    const mirror = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO mirror_files") && c.params.includes("sources/jira/PROJ/PROJ-9.md"));
    const content = mirror!.params.find((p): p is string => typeof p === "string" && p.includes("# PROJ-9: Deep capture"))!;
    expect(content).toContain("First comment");
    expect(content).toContain("Second paged copy");
    expect(content).toContain("Third comment");
    expect(content).not.toContain("Second inline copy");
    expect(content.indexOf("First comment")).toBeLessThan(content.indexOf("Second paged copy"));
    expect(content.indexOf("Second paged copy")).toBeLessThan(content.indexOf("Third comment"));
    expect(content.match(/Second paged copy/gu)).toHaveLength(1);
    const pagedComment = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((call) => call.text.includes("INSERT INTO activity_events")
        && call.params.includes("nango:jira:issue_comment:503:2026-07-02T03:00:00.000Z"));
    expect(pagedComment?.params).toEqual(expect.arrayContaining(["site:cloud-1", "comment:503"]));
  });

  it("applies the timezone-safe JQL lookback window to a stored jira cursor", async () => {
    state.cursor = "2026-07-02T00:00:00.000Z";
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/oauth/token/accessible-resources") {
        return { status: 200, data: [JIRA_SITE] };
      }
      return { status: 200, data: { issues: [] as unknown[] } };
    });

    await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "jira" },
      { client: { proxy } },
    );

    // 26h before the cursor, formatted for JQL (naive local-time semantics).
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        jql: 'updated >= "2026-06-30 22:00" ORDER BY updated ASC',
      }),
    }));
  });

  it("skips comments + mirror for an already-captured jira issue version (idempotent re-scan)", async () => {
    state.storeEvents = false; // every activity_events insert conflicts
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/oauth/token/accessible-resources") {
        return { status: 200, data: [JIRA_SITE] };
      }
      if (input.endpoint === "/ex/jira/cloud-1/rest/api/3/search/jql") {
        return { status: 200, data: { issues: [jiraSearchIssue()] } };
      }
      return { status: 200, data: {} };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "jira" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ issues: 1, captured: 0, comments: 0, materialized: 0 });
    const mirrorInsert = executeMock.mock.calls.find(([q]) => sqlText(q).includes("INSERT INTO mirror_files"));
    expect(mirrorInsert).toBeUndefined();
  });

  it("sweeps github issue + PR review comments per repo with since cursors", async () => {
    state.connections = [{ external_account_id: "conn-g", nango_connection_id: null, provider_config_key: "github" }];
    state.repos = ["octo/hello"];
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/repos/octo/hello/issues/comments") {
        return { status: 200, data: [{ id: 11, body: "conversation comment", updated_at: "2026-07-04T00:00:00Z" }] };
      }
      if (input.endpoint === "/repos/octo/hello/pulls/comments") {
        return { status: 200, data: [{ id: 22, body: "review comment", updated_at: "2026-07-05T00:00:00Z" }] };
      }
      return { status: 200, data: [] as unknown[] };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ repos: 1, captured: 2 });
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/repos/octo/hello/issues/comments",
      params: expect.objectContaining({ sort: "updated", direction: "asc", per_page: 100 }),
    }));

    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes("nango:github:issue_comment:11:2026-07-04T00:00:00Z"))).toBe(true);
    expect(inserts.some((p) => p.includes("nango:github:pr_review_comment:22:2026-07-05T00:00:00Z"))).toBe(true);

    const cursorSaves = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .filter((c) => c.text.includes("INSERT INTO conversation_watermarks"));
    expect(cursorSaves.some((c) => c.params.includes("issue_comments:octo/hello") && c.params.includes("2026-07-04T00:00:00Z"))).toBe(true);
    expect(cursorSaves.some((c) => c.params.includes("pr_review_comments:octo/hello") && c.params.includes("2026-07-05T00:00:00Z"))).toBe(true);
  });

  it("rematerializes a changed comment's parent issue with current comments rendered", async () => {
    state.connections = [{ external_account_id: "conn-g", nango_connection_id: null, provider_config_key: "github" }];
    state.repos = ["octo/hello"];
    state.githubParentRows = [{
      id: "parent-1",
      event_type: "issue",
      source_event_id: "nango:github:issues:101:2026-07-04T00:00:00Z",
      raw_payload: {
        id: 101,
        number: 5,
        title: "Bug",
        body: "Issue body",
        updated_at: "2026-07-04T00:00:00Z",
        repository_url: "https://api.github.com/repos/octo/hello",
      },
    }];
    state.githubCommentRows = [{
      comment_id: "11",
      event_type: "issue_comment",
      source_event_id: "nango:github:issue_comment:11:2026-07-04T01:00:00Z",
      raw_payload: {
        id: 11,
        body: "Fixed in the latest build",
        created_at: "2026-07-04T00:30:00Z",
        updated_at: "2026-07-04T01:00:00Z",
        user: { login: "mona" },
        issue_url: "https://api.github.com/repos/octo/hello/issues/5",
      },
      created_at: "2026-07-04T00:30:00Z",
      updated_at: "2026-07-04T01:00:00Z",
      total_count: "1",
    }];
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/repos/octo/hello/issues/comments") {
        return {
          status: 200,
          data: [{
            id: 11,
            body: "Fixed in the latest build",
            created_at: "2026-07-04T00:30:00Z",
            updated_at: "2026-07-04T01:00:00Z",
            user: { login: "mona" },
            issue_url: "https://api.github.com/repos/octo/hello/issues/5",
            html_url: "https://github.com/octo/hello/issues/5#issuecomment-11",
          }],
        };
      }
      return { status: 200, data: [] as unknown[] };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ captured: 1, materialized: 1 });
    const parentLookup = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("source = 'github'") && c.text.includes("raw_payload->>'number'") && c.text.includes("LIMIT 1"));
    expect(parentLookup?.text).toContain("right(");
    expect(parentLookup?.text).not.toContain(["ends", "with("].join("_"));
    expect(parentLookup?.params).toContain("/repos/octo/hello".length);
    expect(parentLookup?.params).toContain("/repos/octo/hello");
    expect(parentLookup?.params).toContain("/issues/5".length);
    expect(parentLookup?.params).toContain("/issues/5");
    const mirror = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO mirror_files") && c.params.includes("sources/github/octo/hello/issue-5.md"));
    expect(mirror).toBeDefined();
    const content = mirror!.params.find((p): p is string => typeof p === "string" && p.includes("# Bug"));
    expect(content).toContain("## Comments");
    expect(content).toContain("Author: mona");
    expect(content).toContain("Fixed in the latest build");
  });

  it("re-seeds an enabled repo's repository record via /installation/repositories when none captured yet", async () => {
    state.connections = [{ external_account_id: "conn-g", nango_connection_id: null, provider_config_key: "github" }];
    state.repos = [];
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/installation/repositories") {
        return {
          status: 200,
          data: { repositories: [{ id: 555, full_name: "octo/hello", name: "hello", updated_at: "2026-07-01T00:00:00Z" }] },
        };
      }
      return { status: 200, data: [] as unknown[] };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ repos: 1, discoveredRepos: 1, forbidden: 0 });
    // The discovered repo flowed through the Repository processor: raw event
    // (sync-convention key) + repo.md mirror + seeds issue-sweep discovery.
    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes("github:repo:555:2026-07-01T00:00:00Z"))).toBe(true);
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/repos/octo/hello/issues/comments" }));
  });

  it("applies the opt-in github_repo_sync selection to proxy-discovered repos too", async () => {
    state.connections = [{ external_account_id: "conn-g", nango_connection_id: null, provider_config_key: "github" }];
    state.repos = [];
    state.syncedRepos = ["octo/hello"];
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/installation/repositories") {
        return {
          status: 200,
          data: {
            repositories: [
              { id: 555, full_name: "octo/hello", name: "hello", updated_at: "2026-07-01T00:00:00Z" },
              { id: 556, full_name: "octo/stopped", name: "stopped", updated_at: "2026-07-01T00:00:00Z" },
            ],
          },
        };
      }
      return { status: 200, data: [] as unknown[] };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    // Only the ENABLED repo is captured as a repository record and swept;
    // the unselected repo is neither captured (the selection reconcile would
    // purge it again) nor swept.
    expect(result).toMatchObject({ repos: 1, discoveredRepos: 1 });
    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes("github:repo:555:"))).toBe(true);
    expect(inserts.some((p) => p.includes("github:repo:556:"))).toBe(false);
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/repos/octo/hello/issues/comments" }));
    expect(proxy).not.toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/repos/octo/stopped/issues/comments" }));
  });

  it("counts a forbidden github repo discovery instead of crashing", async () => {
    state.connections = [{ external_account_id: "conn-g", nango_connection_id: null, provider_config_key: "github" }];
    state.repos = [];
    const proxy = vi.fn(async () => ({ status: 403, data: null }));

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    // The enabled repo still counts toward the sweep set (selection-based);
    // the record re-seed is what got the forbidden stop.
    expect(result).toMatchObject({ repos: 1, forbidden: 1, captured: 0 });
  });

  it("captures bitbucket PR details + comments and mirrors the full description", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/repo"];
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/repositories/ws/repo/pullrequests") {
        return { status: 200, data: { values: [{ id: 3, title: "A PR", updated_on: "2026-07-05T00:00:00Z" }] } };
      }
      if (input.endpoint === "/repositories/ws/repo/pullrequests/3") {
        return {
          status: 200,
          data: {
            id: 3,
            title: "A PR",
            state: "MERGED",
            description: "Full bitbucket PR description",
            updated_on: "2026-07-05T00:00:00Z",
            author: { display_name: "Betty Bucket" },
            destination: { repository: { full_name: "ws/repo", uuid: "{repo-uuid}" } },
          },
        };
      }
      if (input.endpoint === "/repositories/ws/repo/pullrequests/3/comments") {
        return { status: 200, data: { values: [{ id: 9, content: { raw: "pr comment" }, updated_on: "2026-07-05T01:00:00Z" }] } };
      }
      return { status: 200, data: { values: [] as unknown[] } };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ repos: 1, pullRequests: 1, captured: 1, comments: 1, materialized: 1 });

    // Every-state PR listing (bitbucket defaults to OPEN only).
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/repositories/ws/repo/pullrequests",
      params: expect.objectContaining({
        sort: "updated_on",
        q: '(state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")',
      }),
    }));

    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes("nango:bitbucket:pull_request_detail:ws/repo#3:2026-07-05T00:00:00Z"))).toBe(true);
    expect(inserts.some((p) => p.includes("nango:bitbucket:pr_comment:ws/repo#3#9:2026-07-05T01:00:00Z"))).toBe(true);

    const mirror = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO mirror_files") && c.params.includes("sources/bitbucket/ws/repo/pr-3.md"));
    expect(mirror).toBeDefined();
    const content = mirror!.params.find((p): p is string => typeof p === "string" && p.includes("Full bitbucket PR description"));
    expect(content).toBeDefined();

    const cursorSave = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO conversation_watermarks"));
    expect(cursorSave?.params).toContain("pr_details:ws/repo");
    expect(cursorSave?.params).toContain("2026-07-05T00:00:00Z");
  });

  it("captures PR activity entries with deterministic keys, distinguished kinds, and skips comment entries", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/repo"];
    const proxy = vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
      if (input.endpoint === "/repositories/ws/repo/pullrequests") {
        // Windowed activity listing (OPEN + recent) vs the cursor-filtered main listing.
        if (String(input.params?.q).startsWith('(state = "OPEN" OR ((state')) {
          return { status: 200, data: { values: [{ id: 3 }] } };
        }
        return { status: 200, data: { values: [{ id: 3, title: "A PR", updated_on: "2026-07-05T00:00:00Z" }] } };
      }
      if (input.endpoint === "/repositories/ws/repo/pullrequests/3") {
        return {
          status: 200,
          data: {
            id: 3,
            title: "A PR",
            updated_on: "2026-07-05T00:00:00Z",
            participants: [
              { user: { display_name: "Rita Reviewer" }, role: "REVIEWER", approved: true, state: "approved", participated_on: "2026-07-05T02:00:00Z" },
              { user: { display_name: "Colin Commenter" }, role: "PARTICIPANT", approved: false, state: null },
            ],
          },
        };
      }
      if (input.endpoint === "/repositories/ws/repo/pullrequests/3/activity") {
        return {
          status: 200,
          data: {
            values: [
              { approval: { date: "2026-07-05T02:00:00Z", user: { uuid: "{alice}", display_name: "Alice" }, pullrequest: { id: 3 } } },
              { changes_requested: { date: "2026-07-05T03:00:00Z", user: { uuid: "{bob}" } } },
              { update: { date: "2026-07-05T00:00:00Z", state: "OPEN", author: { uuid: "{carol}" }, title: "A PR" } },
              { comment: { id: 9, created_on: "2026-07-05T01:00:00Z", content: { raw: "pr comment" }, user: { uuid: "{dave}" } } },
            ],
          },
        };
      }
      return { status: 200, data: { values: [] as unknown[] } };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ activityPrs: 1, activityPages: 1, activityCaptured: 3, activityCommentEntries: 1, activityForbidden: 0 });

    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes("nango:bitbucket:pr_activity:ws/repo#3:approval:{alice}:2026-07-05T02:00:00Z"))).toBe(true);
    expect(inserts.some((p) => p.includes("nango:bitbucket:pr_activity:ws/repo#3:changes_requested:{bob}:2026-07-05T03:00:00Z"))).toBe(true);
    expect(inserts.some((p) => p.includes("nango:bitbucket:pr_activity:ws/repo#3:update:{carol}:2026-07-05T00:00:00Z"))).toBe(true);
    // The raw entry + activity_kind field distinguish approval vs changes_requested vs update downstream.
    expect(inserts.some((p) => p.includes('"activity_kind":"approval"'))).toBe(true);
    expect(inserts.some((p) => p.includes('"activity_kind":"changes_requested"'))).toBe(true);
    // Comment entries ride the comments lane (real ids), never pr_activity.
    expect(inserts.filter((p) => p.includes("nango:bitbucket:pr_activity:")).length).toBe(3);

    // The PR mirror renders reviewer verdicts from the detail payload's participants.
    const mirror = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO mirror_files") && c.params.includes("sources/bitbucket/ws/repo/pr-3.md"));
    expect(mirror).toBeDefined();
    const content = mirror!.params.find((p): p is string => typeof p === "string" && p.includes("## Reviews"));
    expect(content).toContain("Rita Reviewer — approved");
    expect(content).not.toContain("Colin Commenter");
  });

  it("re-runs produce identical pr_activity keys (idempotent, no duplicates)", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/repo"];
    const proxy = vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
      if (input.endpoint === "/repositories/ws/repo/pullrequests") {
        if (String(input.params?.q).startsWith('(state = "OPEN" OR ((state')) {
          return { status: 200, data: { values: [{ id: 3 }] } };
        }
        return { status: 200, data: { values: [{ id: 3, updated_on: "2026-07-05T00:00:00Z" }] } };
      }
      if (input.endpoint === "/repositories/ws/repo/pullrequests/3/activity") {
        return {
          status: 200,
          data: { values: [{ approval: { date: "2026-07-05T02:00:00Z", user: { uuid: "{alice}" } } }] },
        };
      }
      return { status: 200, data: { values: [] as unknown[] } };
    });

    const run = () => handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );
    const activityKeys = () => insertParams("INSERT INTO activity_events")
      .flatMap((p) => p.match(/nango:bitbucket:pr_activity:\S+/gu) ?? []);

    await run();
    const first = activityKeys();
    executeMock.mockClear();
    await run();
    const second = activityKeys();

    expect(first).toEqual(["nango:bitbucket:pr_activity:ws/repo#3:approval:{alice}:2026-07-05T02:00:00Z"]);
    // Deterministic keys → the DB's ON CONFLICT (user_id, source_event_id) makes run 2 a no-op.
    expect(second).toEqual(first);
  });

  it("sweeps activity for OPEN PRs via the window listing when updated_on never advanced past the cursor", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/repo"];
    state.cursor = "2026-07-06T00:00:00Z"; // main listing filtered to nothing
    const proxy = vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
      if (input.endpoint === "/repositories/ws/repo/pullrequests") {
        if (String(input.params?.q).startsWith('(state = "OPEN" OR ((state')) {
          return { status: 200, data: { values: [{ id: 7, state: "OPEN" }] } };
        }
        return { status: 200, data: { values: [] as unknown[] } };
      }
      if (input.endpoint === "/repositories/ws/repo/pullrequests/7/activity") {
        return { status: 200, data: { values: [{ approval: { date: "2026-07-07T09:00:00Z", user: { uuid: "{eve}" } } }] } };
      }
      return { status: 200, data: { values: [] as unknown[] } };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );

    // No PR detail re-captured (nothing updated), but the approval was still caught.
    expect(result).toMatchObject({ pullRequests: 0, captured: 0, activityPrs: 1, activityCaptured: 1 });
    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes("nango:bitbucket:pr_activity:ws/repo#7:approval:{eve}:2026-07-07T09:00:00Z"))).toBe(true);
  });

  it("counts a 403 on the activity feed as a skip without failing the PR detail capture", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/repo"];
    const proxy = vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
      if (input.endpoint === "/repositories/ws/repo/pullrequests") {
        if (String(input.params?.q).startsWith('(state = "OPEN" OR ((state')) {
          return { status: 200, data: { values: [] as unknown[] } };
        }
        return { status: 200, data: { values: [{ id: 3, updated_on: "2026-07-05T00:00:00Z" }] } };
      }
      if (input.endpoint === "/repositories/ws/repo/pullrequests/3/activity") {
        return { status: 403, data: null };
      }
      return { status: 200, data: { values: [] as unknown[] } };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ captured: 1, activityPrs: 1, activityForbidden: 1, activityCaptured: 0 });
  });

  it("caps activity paging and follows Bitbucket next-URLs (ctx tokens, not numeric pages)", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/repo"];
    const activityCalls: Array<Record<string, unknown> | undefined> = [];
    const proxy = vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
      if (input.endpoint === "/repositories/ws/repo/pullrequests") {
        if (String(input.params?.q).startsWith('(state = "OPEN" OR ((state')) {
          return { status: 200, data: { values: [] as unknown[] } };
        }
        return { status: 200, data: { values: [{ id: 3, updated_on: "2026-07-05T00:00:00Z" }] } };
      }
      if (input.endpoint === "/repositories/ws/repo/pullrequests/3/activity") {
        activityCalls.push(input.params);
        return {
          status: 200,
          data: {
            values: [{ approval: { date: "2026-07-05T02:00:00Z", user: { uuid: "{alice}" } } }],
            next: "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/3/activity?ctx=tok7&pagelen=50",
          },
        };
      }
      return { status: 200, data: { values: [] as unknown[] } };
    });

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );

    // next is always present → the per-PR page cap is what stops the loop.
    expect(activityCalls).toHaveLength(20);
    expect(result).toMatchObject({ activityPages: 20 });
    // Follow-up pages use the parsed next-URL params (opaque ctx cursor).
    expect(activityCalls[1]).toMatchObject({ ctx: "tok7", pagelen: "50" });
  });

  it("no-ops (counted) when the tenant has no active connection", async () => {
    state.connections = [];
    const proxy = vi.fn();

    const result = await handleNangoProxyDetailsTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "jira" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ connections: 0, captured: 0 });
    expect(proxy).not.toHaveBeenCalled();
  });

  it("schedules nango.proxy_details for jira/github/bitbucket but not confluence", async () => {
    await startNangoPolling("tenant-1", "jira");
    await startNangoPolling("tenant-1", "github");
    await startNangoPolling("tenant-1", "bitbucket");
    await startNangoPolling("tenant-1", "confluence");

    const kinds = upsertScheduleMock.mock.calls.map(([input]) => input);
    for (const provider of ["jira", "github", "bitbucket"]) {
      expect(kinds).toContainEqual(expect.objectContaining({
        kind: "nango.proxy_details",
        groupKey: `tenant-1:nango:${provider}`,
      }));
    }
    const confluenceDetails = kinds.filter((k) =>
      k.kind === "nango.proxy_details" && (k.payload as { provider?: string } | undefined)?.provider === "confluence");
    expect(confluenceDetails).toHaveLength(0);
  });
});

/** A last-sweep stamp comfortably older than the hourly reconcile interval. */
const OLD_SWEEP_AT = "2026-07-01T00:00:00.000Z";
const JIRA_SITE_2 = { id: "cloud-2", url: "https://acme2.atlassian.net", name: "acme2" };

/**
 * Proxy mock for reconcile scenarios: empty details sweep (`fields=*all`),
 * ids-only full listing (`fields=id`) per site, and a per-issue confirm hook
 * (return a response, or an Error to make the proxy call throw like a
 * non-tolerated 403/5xx would).
 */
function jiraReconcileProxy(opts: {
  sites?: Array<Record<string, unknown>>;
  listedIds?: string[];
  confirm?: (issueId: string, cloudId: string) => { status: number; data: unknown } | Error;
}) {
  return vi.fn(async (input: { endpoint: string; params?: Record<string, unknown> }) => {
    if (input.endpoint === "/oauth/token/accessible-resources") {
      return { status: 200, data: opts.sites ?? [JIRA_SITE] };
    }
    if (input.endpoint.endsWith("/rest/api/3/search/jql")) {
      if (input.params?.fields === "id") {
        return { status: 200, data: { issues: (opts.listedIds ?? []).map((id) => ({ id })) } };
      }
      return { status: 200, data: { issues: [] as unknown[] } };
    }
    const confirm = input.endpoint.match(/^\/ex\/jira\/([^/]+)\/rest\/api\/3\/issue\/([^/]+)$/u);
    if (confirm) {
      const out = opts.confirm?.(confirm[2]!, confirm[1]!) ?? { status: 200, data: { id: confirm[2] } };
      if (out instanceof Error) throw out;
      return out;
    }
    return { status: 200, data: {} };
  });
}

async function runJiraDetails(proxy: ReturnType<typeof vi.fn>) {
  return await handleNangoProxyDetailsTask(
    { execute: executeMock } as unknown as NangoExecutor,
    { tenantId: "tenant-1", provider: "jira" },
    { client: { proxy: proxy as unknown as (input: never) => Promise<{ status: number; data: unknown }> } },
  ) as { deletionReconcile: Record<string, unknown> | null };
}

describe("Nango proxy details: jira issue-deletion reconcile", () => {
  beforeEach(() => {
    resetProxyDetailsTestState();
    state.deletionSweepCursor = OLD_SWEEP_AT;
    state.capturedIssues = [
      { issue_id: "10001", issue_key: "PROJ-9", tombstoned: false },
      { issue_id: "10002", issue_key: "PROJ-10", tombstoned: false },
    ];
  });

  it("tombstones a captured issue missing from the listing AND 404 on direct fetch, then deletes its mirror", async () => {
    const proxy = jiraReconcileProxy({
      listedIds: ["10002"],
      confirm: () => ({ status: 404, data: null }),
    });

    const result = await runJiraDetails(proxy);

    expect(result.deletionReconcile).toMatchObject({
      tracked: 2,
      missing: 1,
      tombstoned: 1,
      mirrorsDeleted: 1,
      confirmFailed: 0,
      listingIncomplete: false,
    });

    // Deletion was confirmed by the direct per-issue fetch, not the listing.
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/ex/jira/cloud-1/rest/api/3/issue/10001",
      params: expect.objectContaining({ fields: "id" }),
      tolerateStatuses: [404],
    }));

    // Stable tombstone key + `.deleted` event type, scoped to the tenant.
    const inserts = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .filter((c) => c.text.includes("INSERT INTO activity_events"));
    const tombstone = inserts.find((c) => c.params.includes("nango:jira:issue:10001:deleted"));
    expect(tombstone).toBeDefined();
    expect(tombstone!.params).toContain("issue.deleted");
    expect(tombstone!.params).toContain("tenant-1");
    // The still-listed issue was never confirmed nor tombstoned.
    expect(proxy).not.toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/ex/jira/cloud-1/rest/api/3/issue/10002" }));
    expect(inserts.some((c) => c.params.includes("nango:jira:issue:10002:deleted"))).toBe(false);

    // Mirror file removed for the deleted issue's key, scoped to the tenant.
    const mirrorDelete = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("DELETE FROM mirror_files") && c.params.includes("sources/jira/%/PROJ-9.md"));
    expect(mirrorDelete).toBeDefined();
    expect(mirrorDelete!.params).toContain("tenant-1");

    // Sweep watermark advanced.
    const sweepSave = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO conversation_watermarks") && c.params.includes("issue_deletion_sweep"));
    expect(sweepSave).toBeDefined();
  });

  it("does not tombstone a missing-but-fetchable issue (moved/renamed issues still fetch by id)", async () => {
    const proxy = jiraReconcileProxy({
      listedIds: ["10002"],
      confirm: (issueId) => ({ status: 200, data: { id: issueId } }),
    });

    const result = await runJiraDetails(proxy);

    expect(result.deletionReconcile).toMatchObject({ tracked: 2, missing: 1, tombstoned: 0, mirrorsDeleted: 0 });
    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes(":deleted"))).toBe(false);
  });

  it("skips (counted) when the confirm fetch fails with 403/5xx instead of tombstoning", async () => {
    const proxy = jiraReconcileProxy({
      listedIds: ["10002"],
      confirm: () => new Error("Nango proxy request failed with HTTP 403"),
    });

    const result = await runJiraDetails(proxy);

    expect(result.deletionReconcile).toMatchObject({ missing: 1, confirmFailed: 1, tombstoned: 0, mirrorsDeleted: 0 });
    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes(":deleted"))).toBe(false);
  });

  it("multi-site: an issue fetchable on ANY site is not tombstoned; 404 must hold everywhere", async () => {
    state.capturedIssues = [{ issue_id: "10001", issue_key: "PROJ-9", tombstoned: false }];
    const proxy = jiraReconcileProxy({
      sites: [JIRA_SITE, JIRA_SITE_2],
      listedIds: [],
      confirm: (_issueId, cloudId) => (cloudId === "cloud-1" ? { status: 404, data: null } : { status: 200, data: { id: "10001" } }),
    });

    const result = await runJiraDetails(proxy);

    expect(result.deletionReconcile).toMatchObject({ missing: 1, tombstoned: 0, mirrorsDeleted: 0 });
    // Both sites were consulted before deciding.
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/ex/jira/cloud-1/rest/api/3/issue/10001" }));
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/ex/jira/cloud-2/rest/api/3/issue/10001" }));
  });

  it("is idempotent: already-tombstoned ids are excluded from the diff entirely", async () => {
    state.capturedIssues = [{ issue_id: "10001", issue_key: "PROJ-9", tombstoned: true }];
    const proxy = jiraReconcileProxy({ listedIds: [] });

    const result = await runJiraDetails(proxy);

    expect(result.deletionReconcile).toMatchObject({ tracked: 0, missing: 0, tombstoned: 0 });
    expect(proxy).not.toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/ex/jira/cloud-1/rest/api/3/issue/10001" }));
  });

  it("re-observing a deletion conflicts away on the stable key but still clears the mirror", async () => {
    state.storeEvents = false; // tombstone insert hits ON CONFLICT DO NOTHING
    state.capturedIssues = [{ issue_id: "10001", issue_key: "PROJ-9", tombstoned: false }];
    const proxy = jiraReconcileProxy({ listedIds: [], confirm: () => ({ status: 404, data: null }) });

    const result = await runJiraDetails(proxy);

    // No new tombstone row counted, but the crash-window mirror delete ran.
    expect(result.deletionReconcile).toMatchObject({ missing: 1, tombstoned: 0, mirrorsDeleted: 1 });
  });

  it("baselines the sweep watermark on first run without listing or tombstoning", async () => {
    state.deletionSweepCursor = null;
    const proxy = jiraReconcileProxy({ listedIds: [] });

    const result = await runJiraDetails(proxy);

    expect(result.deletionReconcile).toBeNull();
    expect(proxy).not.toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ fields: "id" }),
    }));
    const sweepSave = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO conversation_watermarks") && c.params.includes("issue_deletion_sweep"));
    expect(sweepSave).toBeDefined();
  });

  it("gates the sweep to the hourly interval (recent watermark → no enumeration, no listing)", async () => {
    state.deletionSweepCursor = new Date().toISOString();
    const proxy = jiraReconcileProxy({ listedIds: [] });

    const result = await runJiraDetails(proxy);

    expect(result.deletionReconcile).toBeNull();
    expect(proxy).not.toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ fields: "id" }),
    }));
    // Watermark untouched: the next due sweep isn't pushed back by a gated run.
    const sweepSave = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO conversation_watermarks") && c.params.includes("issue_deletion_sweep"));
    expect(sweepSave).toBeUndefined();
  });

  it("fails soft when enumeration fails: no tombstones, capture sweep still succeeds, sweep backs off", async () => {
    state.failCapturedIssuesQuery = true;
    const proxy = jiraReconcileProxy({ listedIds: [], confirm: () => ({ status: 404, data: null }) });

    const result = await runJiraDetails(proxy);

    expect(result.deletionReconcile).toBeNull();
    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes(":deleted"))).toBe(false);
    // Backed off a full interval instead of retrying every 300s tick.
    const sweepSave = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO conversation_watermarks") && c.params.includes("issue_deletion_sweep"));
    expect(sweepSave).toBeDefined();
  });
});

function insertParams(marker: string): string[] {
  return executeMock.mock.calls
    .filter(([q]) => sqlText(q).includes(marker))
    .map(([q]) => sqlParams(q).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
}

function sqlText(value: unknown): string {
  return sqlParts(value).join(" ");
}

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [];
  });
}

function sqlParams(value: any): unknown[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return [chunk];
    if (Array.isArray(chunk.queryChunks)) return sqlParams(chunk);
    if (Array.isArray(chunk.value)) return [];
    if ("value" in chunk) return [chunk.value];
    return [];
  });
}
