import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

import {
  materializeGithubIssueSourceWiki,
  materializeGithubPullRequestSourceWiki,
} from "../../src/mirror/materializer.js";

describe("GitHub mirror comments", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("renders current edited state, omits deleted state, and reports the 200-comment bound", async () => {
    const liveRows = Array.from({ length: 200 }, (_, index) => {
      const id = 205 - index;
      const createdAt = `2026-07-${String(Math.floor((id - 1) / 24) + 1).padStart(2, "0")}T${String((id - 1) % 24).padStart(2, "0")}:00:00Z`;
      const updatedAt = id === 100 ? "2026-07-09T23:59:00Z" : createdAt;
      const eventType = id % 2 === 0 ? "issue_comment" : "pr_review_comment";
      return {
        comment_id: String(id),
        event_type: eventType,
        source_event_id: `nango:github:${eventType}:${id}:${updatedAt}`,
        raw_payload: {
          id,
          body: id === 100 ? "edited current body" : `current body ${id}`,
          created_at: createdAt,
          updated_at: id === 100 ? updatedAt : undefined,
          user: { login: `user-${id}` },
        },
        created_at: createdAt,
        updated_at: id === 100 ? "2026-07-09T23:59:00Z" : null,
        total_count: "205",
      };
    });
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("WITH latest AS")) return liveRows;
      if (text.includes("INSERT INTO mirror_files")) return [];
      return [];
    });

    const file = await materializeGithubPullRequestSourceWiki("tenant-1", {
      eventId: "parent-1",
      sourceEventId: "pr:9:current",
      repoKey: "42",
      repoFullName: "octo/hello",
      number: "9",
      rawPayload: {
        id: 900,
        number: 9,
        title: "Ship comments",
        body: "PR body",
        user: { login: "dependabot[bot]", type: "Bot" },
        updated_at: "2026-07-09T00:00:00Z",
      },
    }, { refreshIndexes: false });

    const commentQuery = executeMock.mock.calls
      .map(([query]) => query)
      .find((query) => sqlText(query).includes("WITH latest AS"));
    expect(sqlText(commentQuery)).toContain("DISTINCT ON");
    expect(sqlText(commentQuery)).toContain("event_type NOT LIKE '%.deleted'");
    expect(sqlText(commentQuery)).toContain("right(");
    expect(sqlText(commentQuery)).not.toContain(["ends", "with("].join("_"));
    expect(sqlParams(commentQuery)).toContain(200);
    expect(sqlParams(commentQuery)).toContain("/repos/octo/hello/issues/9".length);
    expect(sqlParams(commentQuery)).toContain("/repos/octo/hello/pulls/9".length);
    expect(sqlParams(commentQuery)).toContain("/repos/octo/hello/issues/9");
    expect(sqlParams(commentQuery)).toContain("/repos/octo/hello/pulls/9");

    const mirrorInsert = executeMock.mock.calls
      .map(([query]) => query)
      .find((query) => sqlText(query).includes("INSERT INTO mirror_files"));
    const content = sqlParams(mirrorInsert).find((param): param is string =>
      typeof param === "string" && param.includes("# Ship comments")
    );
    expect(content).toContain("## Comments");
    expect(content).toContain("Author type: Bot");
    expect(content).toContain("Showing the latest 200 of 205 comments; 5 earlier comments omitted");
    expect(content).toContain("edited current body");
    expect(content).not.toContain("old pre-edit body");
    expect(content).not.toContain("deleted comment body");
    expect(content!.indexOf("current body 6")).toBeLessThan(content!.indexOf("current body 205"));
    expect(content).toContain("### Comment 6");
    expect(content).toContain("### Comment 205");
    expect(file?.meta?.sourceRefs?.[0]).toEqual({ anchor: "Body", sourceEventId: "pr:9:current" });
    expect(file?.meta?.sourceRefs?.slice(1)).toEqual(liveRows.slice().reverse().map((row) => ({
      anchor: `Comment ${row.comment_id}`,
      sourceEventId: row.source_event_id,
    })));
  });

  it("maps an issue's stable comment heading to its exact captured raw version", async () => {
    executeMock.mockImplementation(async (query: unknown) => {
      if (sqlText(query).includes("WITH latest AS")) {
        return [{
          comment_id: "77",
          event_type: "issue_comment",
          source_event_id: "nango:github:issue_comment:77:2026-07-10T01:02:03Z",
          raw_payload: {
            id: 77,
            body: "Issue discussion",
            created_at: "2026-07-10T00:00:00Z",
            updated_at: "2026-07-10T01:02:03Z",
            user: { login: "commenter" },
          },
          created_at: "2026-07-10T00:00:00Z",
          updated_at: "2026-07-10T01:02:03Z",
          total_count: "1",
        }];
      }
      return [];
    });

    const file = await materializeGithubIssueSourceWiki("tenant-1", {
      eventId: "issue-parent-1",
      sourceEventId: "nango:github:issues:500:2026-07-10T00:00:00Z",
      repoKey: "immutable-repo-42",
      repoFullName: "octo/hello",
      number: "5",
      rawPayload: {
        id: 500,
        number: 5,
        title: "Track exact evidence",
        body: "Issue body",
        updated_at: "2026-07-10T00:00:00Z",
      },
    }, { refreshIndexes: false });

    expect(file?.content).toContain("### Comment 77");
    expect(file?.meta?.sourceRefs).toEqual([
      { anchor: "Body", sourceEventId: "nango:github:issues:500:2026-07-10T00:00:00Z" },
      { anchor: "Comment 77", sourceEventId: "nango:github:issue_comment:77:2026-07-10T01:02:03Z" },
    ]);
  });
});

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
