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

// The selection reconcile's scope tombstone refreshes source-wiki indexes
// through the materializer - stub just that; PR mirror rendering stays real.
const materializeSourceWikiIndexesMock = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../../../src/mirror/materializer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/mirror/materializer.js")>();
  return { ...actual, materializeSourceWikiIndexes: materializeSourceWikiIndexesMock };
});

import { handleNangoProxyIssuesTask, issueSourceEventId } from "../../../src/integrations/nango/proxy-issues.js";
import { startNangoPolling } from "../../../src/queue/dispatch.js";
import type { NangoExecutor } from "../../../src/integrations/nango/types.js";

interface RouteState {
  connections: Array<{ external_account_id: string | null; nango_connection_id: string | null; provider_config_key: string | null }>;
  repos: string[];
  /** Repos with an explicit `syncing = true` selection row (github is opt-in). */
  syncedRepos: string[];
  cursor: string | null;
}

let state: RouteState;
let eventSeq: number;

function routeExecute(query: unknown): unknown[] {
  const text = sqlText(query);
  if (text.includes("INSERT INTO activity_events")) {
    eventSeq += 1;
    return [{ id: `event-${eventSeq}` }];
  }
  if (text.includes("INSERT INTO conversation_watermarks")) return [];
  if (text.includes("conversation_watermarks")) return state.cursor ? [{ last_seen_ts: state.cursor }] : [];
  if (text.includes("FROM github_repo_sync")) {
    return state.syncedRepos.map((repo_full_name) => ({ repo_full_name, syncing: true }));
  }
  if (text.includes("FROM connections")) return state.connections;
  if (text.includes("WITH latest AS") && text.includes("source = 'github'")) return [];
  if (text.includes("activity_events")) return state.repos.map((full_name) => ({ full_name }));
  return [];
}

describe("Nango proxy issues capture", () => {
  beforeEach(() => {
    eventSeq = 0;
    state = {
      connections: [{ external_account_id: "conn-1", nango_connection_id: null, provider_config_key: "github" }],
      repos: ["octo/hello"],
      syncedRepos: ["octo/hello"],
      cursor: null,
    };
    executeMock.mockReset().mockImplementation(async (query: unknown) => routeExecute(query));
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    upsertScheduleMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("captures github issues, filters PRs, redacts, and advances the cursor", async () => {
    const proxy = vi.fn(async () => ({
      status: 200,
      data: [
        { id: 101, number: 5, title: "Bug", state: "open", updated_at: "2026-07-01T00:00:00Z" },
        { id: 102, number: 6, title: "A PR", updated_at: "2026-07-09T00:00:00Z", pull_request: { url: "https://api.github.com/pulls/6" } },
        { id: 103, number: 7, title: "Creds", updated_at: "2026-07-03T00:00:00Z", avatar_url: "https://gh.example.com/a?token=supersecret" },
      ],
    }));

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result.captured).toBe(2);
    expect(result.filtered).toBe(1);
    expect(result.repos).toBe(1);

    // Proxy called with the github issues endpoint + capture-all params.
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfigKey: "github",
      connectionId: "conn-1",
      endpoint: "/repos/octo/hello/issues",
      params: expect.objectContaining({ state: "all", per_page: 100, sort: "updated" }),
      tolerateStatuses: [404],
    }));

    const inserts = insertParams("INSERT INTO activity_events");
    // Versioned source_event_id, model `issues`, PR (id 102) never inserted as an issue.
    expect(inserts.some((p) => p.includes("nango:github:issues:101:2026-07-01T00:00:00Z"))).toBe(true);
    expect(inserts.some((p) => p.includes("nango:github:issues:103:2026-07-03T00:00:00Z"))).toBe(true);
    expect(inserts.some((p) => p.includes("nango:github:issues:102:"))).toBe(false);

    // Proxy issues use the same issue renderer as registered sync records.
    const issueMirror = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO mirror_files") && c.params.includes("sources/github/octo/hello/issue-5.md"));
    expect(issueMirror).toBeDefined();
    expect(issueMirror!.params.some((p) => typeof p === "string" && p.includes("# Bug"))).toBe(true);

    // The PR item triggered a full REST detail fetch (the sync PR model is slim).
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/repos/octo/hello/pulls/6",
    }));

    // Redaction ran pre-persist: the tokenized url is scrubbed from raw_payload.
    const creds = inserts.find((p) => p.includes("nango:github:issues:103"));
    expect(creds).toBeDefined();
    expect(creds).not.toContain("supersecret");
    expect(creds).toContain("[redacted");

    // Cursor advanced to the max updated across issues AND PR items (the
    // since-bounded PR-detail fetch depends on PR activity moving it too).
    const cursorSave = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO conversation_watermarks"));
    expect(cursorSave?.params).toContain("2026-07-09T00:00:00Z");
    expect(cursorSave?.params).toContain("issues:octo/hello");
  });

  it("captures the full PR detail payload for github PR items and mirrors it", async () => {
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/repos/octo/hello/issues") {
        return {
          status: 200,
          data: [
            { id: 102, number: 6, title: "A PR", updated_at: "2026-07-09T00:00:00Z", pull_request: { url: "https://api.github.com/pulls/6" } },
          ],
        };
      }
      if (input.endpoint === "/repos/octo/hello/pulls/6") {
        return {
          status: 200,
          data: {
            id: 900,
            number: 6,
            title: "A PR",
            state: "open",
            merged: true,
            body: "Full PR description body",
            updated_at: "2026-07-09T00:00:00Z",
            base: { repo: { id: 555, full_name: "octo/hello" } },
            user: { login: "octocat" },
          },
        };
      }
      return { status: 200, data: [] as unknown[] };
    });

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result.filtered).toBe(1);
    expect(result.prDetails).toBe(1);

    const inserts = insertParams("INSERT INTO activity_events");
    // Distinct versioned kind so slim sync records and full details coexist.
    expect(inserts.some((p) => p.includes("nango:github:pull_request_detail:octo/hello#6:2026-07-09T00:00:00Z"))).toBe(true);

    // The full body reached the PR mirror file.
    const mirror = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO mirror_files") && c.params.includes("sources/github/octo/hello/pr-6.md"));
    expect(mirror).toBeDefined();
    const content = mirror!.params.find((p): p is string => typeof p === "string" && p.includes("Full PR description body"));
    expect(content).toBeDefined();
  });

  it("captures bitbucket issue comments for newly stored issue versions", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/repo"];
    const proxy = vi.fn(async (input: { endpoint: string }) => {
      if (input.endpoint === "/repositories/ws/repo/issues") {
        return {
          status: 200,
          data: { values: [{
            id: 1,
            title: "BB issue",
            state: "open",
            reporter: { display_name: "Riley Reporter" },
            content: { raw: "Issue body" },
            updated_on: "2026-07-05T00:00:00Z",
          }] },
        };
      }
      if (input.endpoint === "/repositories/ws/repo/issues/1/comments") {
        return {
          status: 200,
          data: { values: [{ id: 77, content: { raw: "a comment" }, updated_on: "2026-07-05T01:00:00Z" }] },
        };
      }
      return { status: 200, data: { values: [] as unknown[] } };
    });

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );

    expect(result.captured).toBe(1);
    expect(result.comments).toBe(1);
    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes("nango:bitbucket:issue_comment:ws/repo#1#77:2026-07-05T01:00:00Z"))).toBe(true);
    const mirror = executeMock.mock.calls
      .map(([query]) => ({ text: sqlText(query), params: sqlParams(query) }))
      .find((call) => call.text.includes("INSERT INTO mirror_files") && call.params.includes("sources/bitbucket/ws/repo/issue-1.md"));
    expect(mirror).toBeDefined();
    const content = mirror!.params.find((param): param is string => typeof param === "string" && param.includes("# BB issue"));
    expect(content).toContain("State: open");
    expect(content).toContain("Author: Riley Reporter");
    expect(content).toContain("Issue body");
  });

  it("passes the stored cursor to github as the `since` param", async () => {
    state.cursor = "2026-07-01T00:00:00Z";
    const proxy = vi.fn(async () => ({ status: 200, data: [] as unknown[] }));

    await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ since: "2026-07-01T00:00:00Z" }),
    }));
  });

  it("captures bitbucket issues with repo-qualified ids", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/repo"];
    const proxy = vi.fn(async () => ({
      status: 200,
      data: { values: [{ id: 1, title: "BB issue", updated_on: "2026-07-05T00:00:00Z" }] },
    }));

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );

    expect(result.captured).toBe(1);
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/repositories/ws/repo/issues" }));
    const inserts = insertParams("INSERT INTO activity_events");
    expect(inserts.some((p) => p.includes("nango:bitbucket:issues:ws/repo#1:2026-07-05T00:00:00Z"))).toBe(true);
  });

  it("treats a bitbucket 404 as a disabled issue tracker (counted skip, not error)", async () => {
    state.connections = [{ external_account_id: "conn-b", nango_connection_id: null, provider_config_key: "bitbucket" }];
    state.repos = ["ws/no-tracker"];
    const proxy = vi.fn(async () => ({ status: 404, data: null }));

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "bitbucket" },
      { client: { proxy } },
    );

    expect(result.captured).toBe(0);
    expect(result.trackersDisabled).toBe(1);
    expect(insertParams("INSERT INTO activity_events")).toHaveLength(0);
  });

  it("no-ops (counted) when the tenant has no repos enabled - github syncs nothing by default", async () => {
    state.repos = [];
    state.syncedRepos = [];
    const proxy = vi.fn();

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ connections: 1, repos: 0, captured: 0 });
    expect(proxy).not.toHaveBeenCalled();
  });

  it("sweeps only repos explicitly enabled in github_repo_sync (opt-in) and tombstones the rest", async () => {
    state.repos = ["octo/hello", "octo/stopped"];
    state.syncedRepos = ["octo/hello"];
    const proxy = vi.fn(async () => ({ status: 200, data: [] }));

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result.repos).toBe(1);
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/repos/octo/hello/issues" }));
    expect(proxy).not.toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/repos/octo/stopped/issues" }));

    // The unselected-but-captured repo receives a scope tombstone; raw history
    // stays intact while derived files/cursors are removed. The enabled repo
    // is never touched.
    expect(result.reconciledTombstoned).toBe(1);
    const tombstone = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .find((c) => c.text.includes("INSERT INTO activity_events") && c.text.includes("'repository.moved_out_of_scope'"));
    expect(tombstone?.params.some((param) => typeof param === "string" && param.includes("octo/stopped"))).toBe(true);
    expect(tombstone?.text).toContain("'tombstone'");
    const deletes = executeMock.mock.calls
      .map(([q]) => ({ text: sqlText(q), params: sqlParams(q) }))
      .filter((c) => c.text.includes("DELETE FROM"));
    expect(deletes.some((c) => c.text.includes("activity_events"))).toBe(false);
    expect(deletes.some((c) => c.text.includes("mirror_files") && c.params.some((param) => typeof param === "string" && param.includes("octo/stopped")))).toBe(true);
    for (const call of deletes) {
      for (const param of call.params) {
        if (typeof param === "string") expect(param).not.toContain("octo/hello");
      }
    }
  });

  it("still sweeps a just-enabled repo with NO captured events (re-ingest after scope exit)", async () => {
    state.repos = [];
    state.syncedRepos = ["octo/reborn"];
    const proxy = vi.fn(async () => ({ status: 200, data: [] as unknown[] }));

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result.repos).toBe(1);
    expect(result.reconciledTombstoned).toBe(0);
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/repos/octo/reborn/issues" }));
  });

  it("no-ops when the tenant has no active connection", async () => {
    state.connections = [];
    const proxy = vi.fn();

    const result = await handleNangoProxyIssuesTask(
      { execute: executeMock } as unknown as NangoExecutor,
      { tenantId: "tenant-1", provider: "github" },
      { client: { proxy } },
    );

    expect(result).toMatchObject({ connections: 0, captured: 0 });
    expect(proxy).not.toHaveBeenCalled();
  });

  it("schedules nango.proxy_issues for github/bitbucket but not other Nango providers", async () => {
    await startNangoPolling("tenant-1", "github");
    await startNangoPolling("tenant-1", "jira");

    const kinds = upsertScheduleMock.mock.calls.map(([input]) => input);
    expect(kinds).toContainEqual(expect.objectContaining({ kind: "nango.proxy_issues", groupKey: "tenant-1:nango:github" }));
    // jira scheduled a poll floor but never a proxy-issues sweep.
    const jiraIssues = kinds.filter((k) => k.kind === "nango.proxy_issues" && (k.payload as { provider?: string } | undefined)?.provider === "jira");
    expect(jiraIssues).toHaveLength(0);
  });

  it("builds the versioned source_event_id scheme per provider", () => {
    expect(issueSourceEventId("github", "octo/hello", { id: 101, updated_at: "t1" }, "t1"))
      .toBe("nango:github:issues:101:t1");
    expect(issueSourceEventId("bitbucket", "ws/repo", { id: 1, updated_on: "t2" }, "t2"))
      .toBe("nango:bitbucket:issues:ws/repo#1:t2");
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
