import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

import { materializeConfluenceCommentsSourceWiki } from "../../src/mirror/materializer.js";

type Row = Record<string, unknown>;

function footerComment(input: {
  id: string;
  body: string;
  version?: number;
  createdAt?: string;
  parentCommentId?: string;
  author?: Record<string, unknown>;
  deleted?: boolean;
  pageId?: string;
  spaceId?: string;
}): Row {
  const version = input.version ?? 1;
  const createdAt = input.createdAt ?? "2026-07-01T10:00:00.000Z";
  return {
    id: `ae-${input.id}-v${version}${input.deleted ? "-del" : ""}`,
    event_type: input.deleted ? "footer_comment.deleted" : "footer_comment",
    source_event_id: `nango:confluence:footercomment:${input.id}:v${version}`,
    raw_payload: {
      id: input.id,
      pageId: input.pageId ?? "page-1",
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.parentCommentId ? { parentCommentId: input.parentCommentId } : {}),
      ...(input.author ? { author: input.author } : {}),
      version: { number: version, createdAt, authorId: "acct-123" },
      body: { storage: { representation: "storage", value: input.body } },
    },
    timestamp: createdAt,
    source_updated_at: createdAt,
  };
}

function inlineComment(input: {
  id: string;
  body: string;
  selection?: string;
  resolutionStatus?: string;
  createdAt?: string;
  pageId?: string;
}): Row {
  const createdAt = input.createdAt ?? "2026-07-02T09:00:00.000Z";
  return {
    id: `ae-${input.id}`,
    event_type: "inline_comment",
    source_event_id: `nango:confluence:inlinecomment:${input.id}:v1`,
    raw_payload: {
      id: input.id,
      pageId: input.pageId ?? "page-1",
      resolutionStatus: input.resolutionStatus ?? "open",
      properties: input.selection ? { inlineOriginalSelection: input.selection } : {},
      version: { number: 1, createdAt, authorId: "acct-456" },
      body: { storage: { representation: "storage", value: input.body } },
    },
    timestamp: createdAt,
    source_updated_at: createdAt,
  };
}

function pageRow(overrides: Row = {}): Row {
  return {
    event_type: "page",
    source_event_id: "nango:confluence:page:page-1:v3",
    raw_payload: { id: "page-1", title: "Release Runbook", spaceId: "ENG" },
    ...overrides,
  };
}

function setupDb(input: { commentRows: Row[]; containerRows: Row[] }): void {
  executeMock.mockImplementation(async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("FROM activity_events")) {
      // The container lookup is the only LIMIT 1 activity_events query.
      return text.includes("LIMIT 1") ? input.containerRows : input.commentRows;
    }
    if (text.includes("INSERT INTO activity_events")) return [{ id: "event-x" }];
    return [];
  });
}

function mirrorUpsertsFor(path: string): unknown[][] {
  return executeMock.mock.calls.filter((call) =>
    sqlText(call[0]).includes("INSERT INTO mirror_files") && sqlParams(call[0]).includes(path)
  );
}

function mirrorDeletes(): unknown[][] {
  return executeMock.mock.calls.filter((call) =>
    sqlText(call[0]).includes("DELETE FROM mirror_files")
  );
}

describe("Confluence comments doc materializer", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("rebuilds a threaded page comments doc from captured footer and inline comments", async () => {
    setupDb({
      commentRows: [
        footerComment({
          id: "c-1",
          body: "<p>First <strong>comment</strong></p>",
          author: { displayName: "Pat Writer", email: "pat@example.com" },
          createdAt: "2026-07-01T10:00:00.000Z",
        }),
        inlineComment({
          id: "c-2",
          body: "<p>Inline note</p>",
          selection: "the exact phrase",
          resolutionStatus: "open",
          createdAt: "2026-07-02T09:00:00.000Z",
        }),
        footerComment({
          id: "c-3",
          body: "<p>A reply</p>",
          parentCommentId: "c-1",
          createdAt: "2026-07-03T08:00:00.000Z",
        }),
      ],
      containerRows: [pageRow()],
    });

    const file = await materializeConfluenceCommentsSourceWiki("tenant-1", {
      containerType: "page",
      containerId: "page-1",
    });

    expect(file?.path).toBe("sources/confluence/ENG/page-1-comments.md");
    expect(file?.content).toContain("# Comments: Release Runbook");
    expect(file?.content).toContain("- Page ID: page-1");
    expect(file?.content).toContain("- External ID: page-1:comments");
    expect(file?.content).toContain("- Comments: 3");
    // Footer comment with rendered storage-format body and person label.
    expect(file?.content).toContain("### Comment c-1");
    expect(file?.content).toContain("First **comment**");
    expect(file?.content).toContain("Pat Writer <pat@example.com>");
    // Reply is nested one heading deeper under its parent.
    expect(file?.content).toContain("#### Comment c-3");
    expect(file?.content).toContain("A reply");
    // Inline comment carries its highlighted-text context and resolution.
    expect(file?.content).toContain("### Comment c-2");
    expect(file?.content).toContain("- Type: Inline comment");
    expect(file?.content).toContain('- Highlighted text: "the exact phrase"');
    expect(file?.content).toContain("- Resolution: open");
    // Bare accountId author fallback (no person object on c-2/c-3).
    expect(file?.content).toContain("- Author: acct-123");

    // Envelope.
    expect(file?.meta).toMatchObject({
      provider: "confluence",
      externalId: "page-1:comments",
      kind: "comments",
      title: "Comments: Release Runbook",
      sourceUpdatedAt: "2026-07-03T08:00:00.000Z",
      versionRef: "2026-07-03T08:00:00.000Z",
      authorEmail: "pat@example.com",
      authorName: "Pat Writer",
      sourceAcl: {},
    });
    expect(file?.meta?.aliases).toContainEqual({ kind: "email", value: "pat@example.com" });
    expect(file?.meta?.sourceRefs).toContainEqual({
      anchor: "Comments",
      sourceEventId: "nango:confluence:page:page-1:v3",
    });
    expect(file?.meta?.sourceRefs).toContainEqual({
      anchor: "Comment c-2",
      sourceEventId: "nango:confluence:inlinecomment:c-2:v1",
    });

    // The doc is persisted to the mirror with its envelope.
    const upserts = mirrorUpsertsFor("sources/confluence/ENG/page-1-comments.md");
    expect(upserts.length).toBe(1);
    const metaParam = sqlParams(upserts[0]![0]).find(
      (param): param is string => typeof param === "string" && param.includes('"externalId":"page-1:comments"'),
    );
    expect(metaParam).toBeTruthy();
  });

  it("keeps only the latest captured version of an updated comment", async () => {
    setupDb({
      commentRows: [
        footerComment({ id: "c-1", body: "<p>Old text</p>", version: 1, createdAt: "2026-07-01T10:00:00.000Z" }),
        footerComment({ id: "c-1", body: "<p>New text</p>", version: 2, createdAt: "2026-07-04T10:00:00.000Z" }),
      ],
      containerRows: [pageRow()],
    });

    const file = await materializeConfluenceCommentsSourceWiki("tenant-1", {
      containerType: "page",
      containerId: "page-1",
    });

    expect(file?.content).toContain("New text");
    expect(file?.content).not.toContain("Old text");
    expect(file?.content).toContain("- Version: v2");
    expect(file?.content).toContain("- Comments: 1");
  });

  it("rebuilds without tombstoned comments while keeping live ones", async () => {
    setupDb({
      commentRows: [
        footerComment({ id: "c-1", body: "<p>Keep me</p>" }),
        footerComment({ id: "c-2", body: "<p>Drop me</p>", createdAt: "2026-07-02T10:00:00.000Z" }),
        footerComment({ id: "c-2", body: "<p>Drop me</p>", createdAt: "2026-07-05T10:00:00.000Z", deleted: true }),
      ],
      containerRows: [pageRow()],
    });

    const file = await materializeConfluenceCommentsSourceWiki("tenant-1", {
      containerType: "page",
      containerId: "page-1",
    });

    expect(file?.content).toContain("Keep me");
    expect(file?.content).not.toContain("Drop me");
    expect(file?.content).toContain("- Comments: 1");
  });

  it("deletes the comments doc when the last live comment is tombstoned", async () => {
    setupDb({
      commentRows: [
        footerComment({ id: "c-1", body: "<p>Gone</p>" }),
        footerComment({ id: "c-1", body: "<p>Gone</p>", createdAt: "2026-07-05T10:00:00.000Z", deleted: true }),
      ],
      containerRows: [pageRow()],
    });

    const file = await materializeConfluenceCommentsSourceWiki("tenant-1", {
      containerType: "page",
      containerId: "page-1",
    });

    expect(file).toBeNull();
    const deletes = mirrorDeletes();
    expect(deletes.length).toBe(1);
    expect(sqlParams(deletes[0]![0])).toContain("sources/confluence/ENG/page-1-comments.md");
  });

  it("removes the comments doc when the page itself is tombstoned", async () => {
    setupDb({
      commentRows: [footerComment({ id: "c-1", body: "<p>Still captured</p>" })],
      containerRows: [pageRow({ event_type: "page.deleted" })],
    });

    const file = await materializeConfluenceCommentsSourceWiki("tenant-1", {
      containerType: "page",
      containerId: "page-1",
    });

    expect(file).toBeNull();
    expect(sqlParams(mirrorDeletes()[0]![0])).toContain("sources/confluence/ENG/page-1-comments.md");
  });

  it("returns null without touching the mirror when no comments were ever captured", async () => {
    setupDb({ commentRows: [], containerRows: [pageRow()] });

    const file = await materializeConfluenceCommentsSourceWiki("tenant-1", {
      containerType: "page",
      containerId: "page-1",
    });

    expect(file).toBeNull();
    expect(mirrorDeletes().length).toBe(0);
    expect(mirrorUpsertsFor("sources/confluence/ENG/page-1-comments.md").length).toBe(0);
  });

  it("skips materialization until the container's space is known", async () => {
    setupDb({
      commentRows: [footerComment({ id: "c-1", body: "<p>Early comment</p>" })],
      containerRows: [],
    });

    const file = await materializeConfluenceCommentsSourceWiki("tenant-1", {
      containerType: "page",
      containerId: "page-1",
    });

    expect(file).toBeNull();
    expect(executeMock.mock.calls.some((call) => sqlText(call[0]).includes("mirror_files"))).toBe(false);
  });

  it("renders blog-post comments symmetrically under the blog post's space", async () => {
    setupDb({
      commentRows: [
        footerComment({ id: "c-9", body: "<p>Blog feedback</p>", pageId: undefined }),
      ].map((row) => {
        const payload = row.raw_payload as Record<string, unknown>;
        delete payload.pageId;
        payload.blogPostId = "blog-4";
        return row;
      }),
      containerRows: [{
        event_type: "blog_post",
        source_event_id: "nango:confluence:blogpost:blog-4:v1",
        raw_payload: { id: "blog-4", title: "Launch Recap", spaceId: "ENG" },
      }],
    });

    const file = await materializeConfluenceCommentsSourceWiki("tenant-1", {
      containerType: "blog_post",
      containerId: "blog-4",
    });

    expect(file?.path).toBe("sources/confluence/ENG/blog-4-comments.md");
    expect(file?.content).toContain("# Comments: Launch Recap");
    expect(file?.content).toContain("- Blog post ID: blog-4");
    expect(file?.content).toContain("Blog feedback");
    expect(file?.meta).toMatchObject({
      externalId: "blog-4:comments",
      sourceAcl: {},
    });
  });
});

function sqlText(value: any): string {
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
