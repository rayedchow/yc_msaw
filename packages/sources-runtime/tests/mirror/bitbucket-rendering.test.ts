import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

import {
  materializeBitbucketIssueSourceWiki,
  materializeBitbucketPullRequestSourceWiki,
} from "../../src/mirror/materializer.js";

type CommentRow = {
  id: string;
  event_type: string;
  source_event_id: string;
  raw_payload: Record<string, unknown>;
  timestamp: string;
  source_updated_at: string;
};

let commentRows: CommentRow[];

describe("Bitbucket mirror rendering", () => {
  beforeEach(() => {
    commentRows = [];
    executeMock.mockReset().mockImplementation(async (query: unknown) => {
      if (sqlText(query).includes("FROM activity_events")) return commentRows;
      if (sqlText(query).includes("FROM mirror_files")
        && sqlParams(query).includes("sources/bitbucket/unknown-repo/pr-7.md")) {
        return [{ path: "sources/bitbucket/unknown-repo/pr-7.md" }];
      }
      return [];
    });
  });

  it("materializes an issue with its state, author, timestamps, body, and comments", async () => {
    commentRows = [commentRow({
      id: "77",
      parent: "1",
      eventType: "issue_comment",
      updated: "2026-07-05T01:00:00Z",
      body: "First issue comment",
      author: "Casey Commenter",
    })];

    const file = await materializeBitbucketIssueSourceWiki("tenant-1", {
      eventId: "event-1",
      sourceEventId: "nango:bitbucket:issues:ws/repo#1:2026-07-05T00:00:00Z",
      repoFullName: "ws/repo",
      issueId: "1",
      rawPayload: {
        id: 1,
        title: "Fix the renderer",
        state: "open",
        reporter: { display_name: "Riley Reporter" },
        created_on: "2026-07-04T00:00:00Z",
        updated_on: "2026-07-05T00:00:00Z",
        content: { raw: "Issue body text" },
      },
    }, { refreshIndexes: false });

    expect(file?.path).toBe("sources/bitbucket/ws/repo/issue-1.md");
    expect(file?.content).toContain("# Fix the renderer");
    expect(file?.content).toContain("State: open");
    expect(file?.content).toContain("Author: Riley Reporter");
    expect(file?.content).toContain("Created: 2026-07-04T00:00:00.000Z");
    expect(file?.content).toContain("Updated: 2026-07-05T00:00:00.000Z");
    expect(file?.content).toContain("Issue body text");
    expect(file?.content).toContain("## Comments");
    expect(file?.content).toContain("### Comment 77");
    expect(file?.content).toContain("First issue comment");
    expect(file?.meta?.sourceRefs).toContainEqual({
      anchor: "Comment 77",
      sourceEventId: "nango:bitbucket:issue_comment:ws/repo#1#77:2026-07-05T01:00:00Z",
    });
  });

  it("folds comment versions by id and renders only the latest 200 with a counted truncation", async () => {
    commentRows = Array.from({ length: 202 }, (_, index) => commentRow({
      id: String(index + 1),
      parent: "9",
      eventType: "pr_comment",
      updated: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      body: index === 2 ? "OLD_THREE_BODY" : `original comment ${index + 1}`,
    }));
    commentRows.push(commentRow({
      id: "3",
      parent: "9",
      eventType: "pr_comment",
      updated: "2026-07-09T00:00:00Z",
      body: "updated comment body 3",
    }));

    const file = await materializeBitbucketPullRequestSourceWiki("tenant-1", {
      eventId: "event-pr",
      sourceEventId: "nango:bitbucket:pull_request_detail:ws/repo#9:v1",
      repoFullName: "ws/repo",
      pullRequestId: "9",
      rawPayload: { id: 9, title: "Busy PR", description: "PR body" },
    }, { refreshIndexes: false });

    expect(file?.content).toContain("Showing the latest 200 of 202 comments; 2 earlier comments omitted");
    expect(file?.content).not.toContain("### Comment 1\n");
    expect(file?.content).not.toContain("### Comment 2\n");
    expect(file?.content).toContain("### Comment 3");
    expect(file?.content).toContain("updated comment body 3");
    expect(file?.content).not.toContain("OLD_THREE_BODY");
    expect(file?.content).toContain("### Comment 202");
    expect(file?.meta?.sourceRefs).toContainEqual({
      anchor: "Comment 3",
      sourceEventId: "nango:bitbucket:pr_comment:ws/repo#9#3:2026-07-09T00:00:00Z",
    });
    expect(file?.meta?.sourceRefs).not.toContainEqual({
      anchor: "Comment 3",
      sourceEventId: "nango:bitbucket:pr_comment:ws/repo#9#3:2026-01-01T00:02:00.000Z",
    });
    expect(file?.meta?.sourceRefs).not.toContainEqual({
      anchor: "Comment 1",
      sourceEventId: "nango:bitbucket:pr_comment:ws/repo#9#1:2026-01-01T00:00:00.000Z",
    });
  });

  it("deletes an earlier unknown-repo PR mirror when the repository becomes known", async () => {
    const base = {
      eventId: "event-pr",
      sourceEventId: "bitbucket:pr:unknown-repo:7:v1",
      pullRequestId: "7",
      rawPayload: { id: 7, title: "Identify me" },
    };
    await materializeBitbucketPullRequestSourceWiki("tenant-1", {
      ...base,
      repoFullName: "unknown-repo",
    }, { refreshIndexes: false });
    await materializeBitbucketPullRequestSourceWiki("tenant-1", {
      ...base,
      sourceEventId: "nango:bitbucket:pull_request_detail:ws/repo#7:v2",
      repoFullName: "ws/repo",
    }, { refreshIndexes: false });

    const calls = executeMock.mock.calls.map(([query]) => ({
      text: sqlText(query),
      params: sqlParams(query),
    }));
    expect(calls.some((call) =>
      call.text.includes("DELETE FROM mirror_files")
      && call.params.includes("sources/bitbucket/unknown-repo/pr-7.md")
    )).toBe(true);
    expect(calls.some((call) =>
      call.text.includes("INSERT INTO mirror_files")
      && call.params.includes("sources/bitbucket/ws/repo/pr-7.md")
    )).toBe(true);
  });
});

function commentRow(input: {
  id: string;
  parent: string;
  eventType: "issue_comment" | "pr_comment";
  updated: string;
  body: string;
  author?: string;
}): CommentRow {
  return {
    id: `${input.eventType}-${input.id}-${input.updated}`,
    event_type: input.eventType,
    source_event_id: `nango:bitbucket:${input.eventType}:ws/repo#${input.parent}#${input.id}:${input.updated}`,
    raw_payload: {
      id: input.id,
      content: { raw: input.body },
      user: input.author ? { display_name: input.author } : undefined,
      updated_on: input.updated,
    },
    timestamp: input.updated,
    source_updated_at: input.updated,
  };
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
