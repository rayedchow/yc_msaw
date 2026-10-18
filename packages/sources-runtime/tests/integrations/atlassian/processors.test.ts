import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

import {
  processConfluenceCommentRecord,
  processConfluencePageRecord,
  processJiraCommentRecord,
  processJiraIssueRecord,
} from "../../../src/integrations/atlassian/processors.js";

describe("Atlassian Nango processors", () => {
  const executor = { execute: executeMock };

  beforeEach(() => {
    executeMock.mockReset().mockResolvedValue([{ id: "event-1" }]);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
  });

  it("captures a Jira Issue row and materializes its mirror markdown", async () => {
    await processJiraIssueRecord(executor, {
      id: "10001",
      key: "PROJ-123",
      summary: "Fix login",
      status: { name: "In Progress" },
      assignee: { displayName: "Alice Assignee", emailAddress: "alice@example.com" },
      reporter: { displayName: "Riley Reporter" },
      issueType: { name: "Bug" },
      labels: ["auth", "urgent"],
      description: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "ADF body" }] }],
      },
      comments: [{
        id: "embedded-1",
        created: "2026-07-01T09:00:00.000Z",
        author: { displayName: "Commenter" },
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Comment body" }] }] },
      }],
      _nango_metadata: { updated_at: "2026-07-01T10:00:00.000Z" },
    }, { tenantId: "tenant-1", connectionId: "cloud-1" });

    const activityInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    expect(sqlParams(activityInsert![0])).toContain("nango:jira:issue:10001:2026-07-01T10:00:00.000Z");
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("event-1", "tenant-1", "jira");

    const mirrorInsert = executeMock.mock.calls.find((call) => {
      const parts = sqlParts(call[0]).join(" ");
      return parts.includes("INSERT INTO mirror_files") && sqlParams(call[0]).includes("sources/jira/PROJ/PROJ-123.md");
    });
    expect(mirrorInsert).toBeTruthy();
    const mirrorParams = sqlParams(mirrorInsert![0]);
    const content = mirrorParams.find((param): param is string => typeof param === "string" && param.includes("# PROJ-123: Fix login"));
    expect(content).toContain("Status: In Progress");
    expect(content).toContain("Alice Assignee <alice@example.com>");
    expect(content).toContain("ADF body");
    expect(content).toContain("Comment body");
    expect(content).toContain("### Comment embedded-1");
    const meta = mirrorParams.find((param): param is string =>
      typeof param === "string" && param.includes("\"sourceRefs\"")
    );
    expect(JSON.parse(meta!).sourceRefs).not.toContainEqual(expect.objectContaining({ anchor: "Comment embedded-1" }));
  });

  it("rematerializes a locally captured parent after a standalone Jira comment", async () => {
    const comment = {
      id: "c-2",
      issueId: "10001",
      issueKey: "PROJ-123",
      body: "Standalone comment",
      created: "2026-07-02T12:00:00.000Z",
    };
    executeMock.mockImplementation(async (query: any) => {
      const text = sqlParts(query).join(" ");
      if (text.includes("INSERT INTO activity_events")) return [{ id: "comment-event" }];
      if (text.includes("event_type IN ('issue_detail', 'issue')")) {
        return [{
          id: "parent-event",
          event_type: "issue_detail",
          source_event_id: "nango:jira:issue_detail:10001:v1",
          raw_payload: {
            id: "10001",
            key: "PROJ-123",
            fields: { summary: "Fix login", project: { key: "PROJ" }, comment: { total: 0, comments: [] } },
          },
        }];
      }
      if (text.includes("event_type IN ('issue_comment', 'issue_comment.deleted')")) {
        return [{
          id: "comment-event",
          event_type: "issue_comment",
          // A legacy raw key need not match the currently derived scheme; the
          // rebuilt mirror must retain the exact selected ledger row.
          source_event_id: "legacy:jira:issue_comment:c-2:v7",
          raw_payload: comment,
          timestamp: comment.created,
          source_updated_at: comment.created,
        }];
      }
      return [];
    });

    const result = await processJiraCommentRecord(
      executor,
      comment,
      { tenantId: "tenant-1", connectionId: "cloud-1" },
    );

    expect(result).toEqual({ stored: true, skipped: false });
    const mirrorInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO mirror_files")
        && sqlParams(call[0]).includes("sources/jira/PROJ/PROJ-123.md")
    );
    expect(mirrorInsert).toBeTruthy();
    const content = sqlParams(mirrorInsert![0]).find((param): param is string =>
      typeof param === "string" && param.includes("# PROJ-123: Fix login")
    );
    expect(content).toContain("Standalone comment");
    expect(content).toContain("### Comment c-2");
    const meta = sqlParams(mirrorInsert![0]).find((param): param is string =>
      typeof param === "string" && param.includes("\"sourceRefs\"")
    );
    expect(JSON.parse(meta!).sourceRefs).toContainEqual({
      anchor: "Comment c-2",
      sourceEventId: "legacy:jira:issue_comment:c-2:v7",
    });
  });

  it("uses Confluence version numbers in source event ids", async () => {
    await processConfluencePageRecord(executor, {
      id: "page-7",
      title: "Release Runbook",
      spaceId: "ENG",
      versionNumber: 7,
      bodyStorage: "<p>Hello <strong>world</strong></p>",
      author: { displayName: "Pat Writer" },
      _nango_metadata: { updated_at: "2026-07-03T00:00:00.000Z" },
    }, { tenantId: "tenant-1", connectionId: "conf-connection" });

    const activityInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    expect(sqlParams(activityInsert![0])).toContain("nango:confluence:page:page-7:v7");

    const mirrorInsert = executeMock.mock.calls.find((call) => {
      const parts = sqlParts(call[0]).join(" ");
      return parts.includes("INSERT INTO mirror_files") && sqlParams(call[0]).includes("sources/confluence/ENG/page-7.md");
    });
    expect(mirrorInsert).toBeTruthy();
    const content = sqlParams(mirrorInsert![0]).find((param): param is string =>
      typeof param === "string" && param.includes("# Release Runbook")
    );
    expect(content).toContain("Version: v7");
    expect(content).toContain("Hello **world**");
  });

  it("captures a Confluence footer comment and rebuilds the page comments doc", async () => {
    const commentRecord = {
      id: "c-1",
      pageId: "page-7",
      version: { number: 2, createdAt: "2026-07-04T10:00:00.000Z", authorId: "acct-1" },
      body: { storage: { representation: "storage", value: "<p>Ship it</p>" } },
      _nango_metadata: { updated_at: "2026-07-04T10:00:00.000Z" },
    };
    executeMock.mockImplementation(async (query: any) => {
      const text = sqlParts(query).join(" ");
      if (text.includes("INSERT INTO activity_events")) return [{ id: "event-9" }];
      if (text.includes("FROM activity_events")) {
        if (text.includes("LIMIT 1")) {
          // Container lookup: the previously captured page record.
          return [{
            event_type: "page",
            source_event_id: "nango:confluence:page:page-7:v7",
            raw_payload: { id: "page-7", title: "Release Runbook", spaceId: "ENG" },
          }];
        }
        // Comment ledger for the page: the row just captured.
        return [{
          id: "ae-1",
          event_type: "footer_comment",
          source_event_id: "nango:confluence:footercomment:c-1:2026-07-04T10:00:00.000Z",
          raw_payload: commentRecord,
          timestamp: "2026-07-04T10:00:00.000Z",
          source_updated_at: "2026-07-04T10:00:00.000Z",
        }];
      }
      return [];
    });

    const result = await processConfluenceCommentRecord(
      executor,
      commentRecord,
      { tenantId: "tenant-1", connectionId: "conf-connection" },
      "FooterComment",
    );
    expect(result).toEqual({ stored: true, skipped: false });

    // Raw capture is unchanged: footer_comment event type, versioned id.
    const activityInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    const activityParams = sqlParams(activityInsert![0]);
    expect(activityParams).toContain("footer_comment");
    expect(activityParams.some((param) =>
      typeof param === "string" && param.startsWith("nango:confluence:footercomment:c-1:")
    )).toBe(true);
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("event-9", "tenant-1", "confluence");

    // Rendered comments doc lands next to the page mirror file.
    const mirrorInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO mirror_files")
        && sqlParams(call[0]).includes("sources/confluence/ENG/page-7-comments.md")
    );
    expect(mirrorInsert).toBeTruthy();
    const content = sqlParams(mirrorInsert![0]).find((param): param is string =>
      typeof param === "string" && param.includes("# Comments: Release Runbook")
    );
    expect(content).toContain("### Comment c-1");
    expect(content).toContain("Ship it");
    expect(content).toContain("Author: acct-1");
  });

  it("removes both the page doc and its comments doc when the page is deleted", async () => {
    await processConfluencePageRecord(executor, {
      id: "page-7",
      spaceId: "ENG",
      _nango_metadata: { last_action: "DELETED", updated_at: "2026-07-05T00:00:00.000Z" },
    }, { tenantId: "tenant-1", connectionId: "conf-connection" });

    const mirrorDelete = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("DELETE FROM mirror_files")
    );
    expect(mirrorDelete).toBeTruthy();
    const params = sqlParams(mirrorDelete![0]);
    expect(params).toContain("sources/confluence/ENG/page-7.md");
    expect(params).toContain("sources/confluence/ENG/page-7-comments.md");
  });
});

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
