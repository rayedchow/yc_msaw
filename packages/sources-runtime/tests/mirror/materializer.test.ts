import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkMarkdown } from "../../src/graph/bridge/chunker.js";

const executeMock = vi.hoisted(() => vi.fn());
const enqueueGraphDeleteMock = vi.hoisted(() => vi.fn());
const enqueueGraphIngestMock = vi.hoisted(() => vi.fn());
const graphIngestEnabledMock = vi.hoisted(() => vi.fn(() => false));
const getGoogleAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../src/graph/wiring/ingest-hook.js", () => ({
  enqueueGraphDeleteForMirrorFile: enqueueGraphDeleteMock,
  enqueueGraphIngestForMirrorFile: enqueueGraphIngestMock,
  graphIngestEnabled: graphIngestEnabledMock,
}));

vi.mock("../../src/vault/google-auth.js", () => ({
  getGoogleAccessToken: getGoogleAccessTokenMock,
}));

import {
  deleteGmailMessageSourceWiki,
  deleteGranolaMeetingSourceWiki,
  deleteNotionPageSourceWiki,
  gmailMessageSourcePath,
  googleDocSourceDirectory,
  granolaMeetingSourceDirectory,
  materializeCalendarEventSourceWiki,
  materializeGmailMessageSourceWiki,
  materializeGoogleDocSourceWiki,
  materializeGranolaMeetingSourceWiki,
  materializeImessageMonthSourceWiki,
  materializeSlackChannelDaySourceWiki,
  materializeSlackWindowSourceWiki,
  materializeNotionPageSourceWiki,
  materializeSourceWikiIndexes,
  notionPageSourceDirectory,
  slackChannelDaySourcePath,
} from "../../src/mirror/materializer.js";

describe("source wiki materializer", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    enqueueGraphDeleteMock.mockReset();
    enqueueGraphIngestMock.mockReset();
    getGoogleAccessTokenMock.mockReset();
    getGoogleAccessTokenMock.mockRejectedValue(new Error("no google token"));
    graphIngestEnabledMock.mockReset();
    graphIngestEnabledMock.mockReturnValue(false);
  });

  it("enqueues graph deletes only for children removed by a directory replacement", async () => {
    graphIngestEnabledMock.mockReturnValue(true);
    const directory = googleDocSourceDirectory("doc-replace", "Replacement Test");
    const removedPath = `${directory}/tabs/tab-removed.md`;
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlParts(query).join(" ");
      return text.includes("SELECT path") && text.includes("path NOT IN")
        ? [{ path: removedPath }]
        : [];
    });

    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-replace",
      title: "Replacement Test",
      overview: "",
      tabSummaries: {},
      tabContents: [{ tabId: "tab-kept", tabName: "Kept", content: "Current." }],
      refreshIndexes: false,
    });

    expect(files.map((file) => file.path)).not.toContain(removedPath);
    expect(enqueueGraphDeleteMock).toHaveBeenCalledTimes(1);
    expect(enqueueGraphDeleteMock).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "u1", path: removedPath },
    );
  });

  it("materializes Google Docs as raw per-tab content files (no generated summaries)", async () => {
    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-123",
      title: "Product Plan",
      overview: "Document-level overview.",
      tabSummaries: {
        tabA: {
          tabId: "tab-a",
          tabName: "Overview",
          summary: "Tab summary.",
          contentHash: "hash-a",
        },
      },
      tabContents: [{ tabId: "tab-a", tabName: "Overview", content: "Actual tab body text." }],
      lastUpdated: "2026-06-25T12:00:00.000Z",
    });

    const directory = googleDocSourceDirectory("doc-123", "Product Plan");
    expect(files.map((file) => file.path)).toEqual([
      expect.stringMatching(new RegExp(`^${escapeRegex(directory)}/tabs/tab-[a-f0-9]{12}\\.md$`)),
    ]);
    expect(directory).toMatch(/^sources\/google-docs\/product-plan-doc-[a-f0-9]{12}$/u);
    // Raw mirror: the actual tab content, never the generated overview/summary.
    expect(files[0]?.content).toContain("# Overview");
    expect(files[0]?.content).toContain("Actual tab body text.");
    expect(files[0]?.content).not.toContain("Document-level overview.");
    expect(files[0]?.content).not.toContain("Tab summary.");
    // Legacy projections without a captured snapshot revision retain the
    // previous unversioned locator rather than guessing one.
    expect(files[0]?.meta?.sourceRefs).toEqual([{
      anchor: "Content",
      sourceEventId: "gdoc:doc-123:tab-a",
      url: "https://docs.google.com/document/d/doc-123/edit?tab=tab-a",
    }]);
    // 1 folder-acl select + 1 tab upsert + directory sweep + stale-entity sweep + index select + 12 index upserts (root + 11 providers)
    expect(executeMock).toHaveBeenCalledTimes(17);

    const suffix = directory.match(/doc-[a-f0-9]{12}$/u)?.[0];
    expect(suffix).toBeTruthy();
    const cleanupParts = executeMock.mock.calls
      .map((call) => sqlParts(call[0]).join(" "))
      .find((parts) => parts.includes(`sources/google-docs/${suffix}/%`)) ?? "";
    expect(cleanupParts).toContain(`sources/google-docs/${suffix}/%`);
    expect(cleanupParts).toContain(`sources/google-docs/%-${suffix}/%`);
    expect(cleanupParts).toContain(`${directory}/%`);
  });

  it("offers both: a lossless raw.json companion and a markdown tab with a verification note", async () => {
    const rawDoc = { documentId: "doc-777", title: "Fidelity Doc", body: { content: [{ paragraph: {} }] } };
    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-777",
      title: "Fidelity Doc",
      overview: "",
      tabSummaries: {},
      tabContents: [{ tabId: "tab-a", tabName: "Main", content: "Body." }],
      rawJson: rawDoc,
      lastUpdated: "2026-06-25T12:00:00.000Z",
    });

    const directory = googleDocSourceDirectory("doc-777", "Fidelity Doc");
    // Lossless companion present at the doc directory (markdown-wrapped JSON).
    const rawFile = files.find((f) => f.path === `${directory}/raw.md`);
    expect(rawFile).toBeTruthy();
    const fenced = rawFile!.content.match(/```json\n([\s\S]*?)\n```/);
    expect(fenced).toBeTruthy();
    expect(JSON.parse(fenced![1])).toEqual(rawDoc);
    // Markdown tab carries the verification caveat pointing at raw.md.
    const tabFile = files.find((f) => f.path.includes("/tabs/"));
    expect(tabFile?.content).toContain("best-effort markdown");
    expect(tabFile?.content).toContain("raw.md");
    expect(tabFile?.content).toContain("Verify the markdown against");
  });

  it("omits raw.md when no rawJson is supplied", async () => {
    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-888",
      title: "No Raw",
      overview: "",
      tabSummaries: {},
      tabContents: [{ tabId: "tab-a", tabName: "Main", content: "Body." }],
      lastUpdated: "2026-06-25T12:00:00.000Z",
    });
    expect(files.some((f) => f.path.endsWith("/raw.md"))).toBe(false);
  });

  it("renders pending Google Docs suggestions as a section of the tab file", async () => {
    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-456",
      title: "Draft Spec",
      overview: "",
      tabSummaries: {},
      tabContents: [
        {
          tabId: "tab-a",
          tabName: "Main",
          revisionId: "rev-suggestions",
          content: "Body text.",
          suggestions: [
            {
              suggestionId: "suggest.abc",
              insertedText: "new sentence",
              deletedText: "",
              contextBefore: "the Q3 targets are",
              contextAfter: "as discussed last week",
            },
            { suggestionId: "suggest.def", insertedText: "replacement", deletedText: "old wording" },
            { suggestionId: "suggest.empty", insertedText: "", deletedText: "" },
          ],
        },
      ],
      lastUpdated: "2026-06-25T12:00:00.000Z",
    });

    const content = files[0]?.content ?? "";
    expect(content).toContain("## Pending suggestions");
    expect(content).toContain("### Suggestion suggest.abc");
    expect(content).toContain("Location: …the Q3 targets are ⟦here⟧ as discussed last week…");
    expect(content).toContain("> new sentence");
    expect(content).toContain("Proposes deleting:");
    expect(content).toContain("> old wording");
    expect(content).toContain("> replacement");
    // Metadata line reflects only substantive suggestions.
    expect(content).toContain("Pending suggestions: 2");
    expect(content).not.toContain("suggest.empty");
    expect(files[0]?.meta?.sourceRefs).toEqual([
      {
        anchor: "Content",
        sourceEventId: "gdoc:doc-456:tab-a:rev-suggestions",
        url: "https://docs.google.com/document/d/doc-456/edit?tab=tab-a",
      },
      {
        anchor: "Suggestion suggest.abc",
        sourceEventId: "gdoc:doc-456:tab-a:rev-suggestions",
        url: "https://docs.google.com/document/d/doc-456/edit?tab=tab-a",
      },
      {
        anchor: "Suggestion suggest.def",
        sourceEventId: "gdoc:doc-456:tab-a:rev-suggestions",
        url: "https://docs.google.com/document/d/doc-456/edit?tab=tab-a",
      },
    ]);
  });

  it("populates envelope authorship + container identity on Google Doc tab and raw metas", async () => {
    // Folder lineage comes from the already-captured google_doc_sync_state row.
    executeMock.mockImplementation(async (query: unknown) => {
      const parts = sqlParts(query).join(" ");
      if (parts.includes("FROM google_doc_sync_state")) {
        return [{ folder_ids: ["folder-1", "folder-2"] }];
      }
      return [];
    });

    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-auth",
      title: "Authored Doc",
      overview: "",
      tabSummaries: {},
      tabContents: [{ tabId: "tab-a", tabName: "Main", content: "Body." }],
      rawJson: { documentId: "doc-auth", revisionId: "rev-9" },
      lastUpdated: "2026-07-07T10:00:00.000Z",
      authorEmail: "owner@corp.com",
      authorName: "Own Er",
      updatedByEmail: "editor@corp.com",
    });

    const tabFile = files.find((f) => f.path.includes("/tabs/"));
    expect(tabFile?.meta).toMatchObject({
      provider: "google-docs",
      authorEmail: "owner@corp.com",
      authorName: "Own Er",
      updatedByEmail: "editor@corp.com",
      versionRef: "rev-9",
      sourceAcl: {},
    });
    expect(tabFile?.meta?.aliases).toEqual(expect.arrayContaining([
      { kind: "email", value: "owner@corp.com" },
      { kind: "email", value: "editor@corp.com" },
    ]));

    const rawFile = files.find((f) => f.path.endsWith("/raw.md"));
    expect(rawFile?.meta).toMatchObject({
      authorEmail: "owner@corp.com",
      updatedByEmail: "editor@corp.com",
      sourceAcl: {},
    });
  });

  it("leaves Google Doc envelope authorship absent (and sourceAcl empty) when nothing was captured", async () => {
    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-anon",
      title: "Anonymous Doc",
      overview: "",
      tabSummaries: {},
      tabContents: [{ tabId: "tab-a", tabName: "Main", content: "Body." }],
      lastUpdated: "2026-07-07T10:00:00.000Z",
    });

    const meta = files[0]?.meta as Record<string, unknown>;
    expect(meta.authorEmail).toBeUndefined();
    expect(meta.updatedByEmail).toBeUndefined();
    expect(meta.sourceAcl).toEqual({});
  });

  it("captures Google Doc access principals into sourceAcl when Drive permissions are available", async () => {
    executeMock.mockImplementation(async (query: unknown) =>
      sqlParts(query).join(" ").includes("FROM google_doc_sync_state")
        ? [{ folder_ids: ["folder-a"] }]
        : []);
    getGoogleAccessTokenMock.mockResolvedValue("google-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      permissions: [
        { emailAddress: "reader@example.com", role: "reader", type: "user" },
        { emailAddress: "group@example.com", role: "commenter", type: "group" },
        { emailAddress: "owner@example.com", role: "owner", type: "user" },
        { emailAddress: "writer@example.com", role: "writer", type: "user" },
        { emailAddress: "public@example.com", role: "reader", type: "anyone" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const files = await materializeGoogleDocSourceWiki({
        userId: "u1",
        docId: "doc-acl",
        title: "ACL Doc",
        overview: "",
        tabSummaries: {},
        tabContents: [{ tabId: "tab-a", tabName: "Main", content: "Body." }],
      });

      const tabFile = files.find((file) => file.path.includes("/tabs/"));
      expect(tabFile?.meta?.sourceAcl).toEqual({
        driveFolderIds: ["folder-a"],
        readers: ["reader@example.com", "group@example.com"],
        writers: ["owner@example.com", "writer@example.com"],
      });
      expect(fetchSpy.mock.calls[0]?.[0]).toContain("/drive/v3/files/doc-acl/permissions");
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        headers: { Authorization: "Bearer google-token" },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps Google Doc ACL fail-soft when Drive permissions are unavailable", async () => {
    executeMock.mockImplementation(async (query: unknown) =>
      sqlParts(query).join(" ").includes("FROM google_doc_sync_state")
        ? [{ folder_ids: ["folder-a"] }]
        : []);
    getGoogleAccessTokenMock.mockResolvedValue("google-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));
    try {
      const files = await materializeGoogleDocSourceWiki({
        userId: "u1",
        docId: "doc-no-acl",
        title: "No ACL Doc",
        overview: "",
        tabSummaries: {},
        tabContents: [{ tabId: "tab-a", tabName: "Main", content: "Body." }],
      });

      const tabFile = files.find((file) => file.path.includes("/tabs/"));
      expect(tabFile?.meta?.sourceAcl).toEqual({ driveFolderIds: ["folder-a"] });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("notes when suggestions are hidden by view-only access", async () => {
    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-789",
      title: "Shared Read-Only Doc",
      overview: "",
      tabSummaries: {},
      tabContents: [
        { tabId: "tab-a", tabName: "Main", content: "Body.", suggestions: [], suggestionsAccessible: false },
      ],
      lastUpdated: "2026-06-25T12:00:00.000Z",
    });

    const content = files[0]?.content ?? "";
    expect(content).toContain("Suggestions: not visible (view-only access to this document)");
    expect(content).not.toContain("Pending suggestions:");
  });

  it("materializes Notion pages as raw content plus nested row/child pages", async () => {
    const files = await materializeNotionPageSourceWiki({
      userId: "u1",
      pageId: "page-123",
      title: "Customer Notes",
      url: "https://notion.so/page-123",
      overview: "Page overview.",
      sourceMarkdown: "Full processed page markdown.\n\n## Comments\n\n- Page comment.",
      sectionSummaries: [
        {
          sectionId: "section-1",
          sectionTitle: "Discovery",
          summary: "Section summary.",
          contentHash: "section-hash",
          sectionKind: "heading",
          anchorBlockId: "block-1",
          rootBlockIds: ["block-1", "block-2"],
          warningCodes: ["unsupported_block"],
          structuredFacts: {
            visualBlockCount: 1,
            visualBlocks: [{ blockId: "callout-1", type: "callout", text: "Important callout" }],
            externalReferenceBlockCount: 1,
            externalReferenceBlocks: [{ blockId: "bookmark-1", type: "bookmark", url: "https://example.com/bookmark" }],
            referenceCount: 1,
            referenceTargets: [{ kind: "mention", blockId: "block-1", mentionType: "page", targetId: "roadmap-page", title: "Roadmap" }],
            blockStructure: [{
              blockId: "block-1",
              type: "paragraph",
              references: [{ kind: "mention", mentionType: "page", targetId: "roadmap-page", title: "Roadmap" }],
            }],
          },
          sourceContent: "Processed section content.",
        },
        {
          sectionId: "row-section-1",
          sectionTitle: "Google docs fix integration",
          summary: "Row page summary.",
          contentHash: "row-section-hash",
          sectionKind: "database_row_page",
          anchorBlockId: "row-1",
          rootBlockIds: ["row-block-1"],
          sourceContent: "Stale row-page section content.",
        },
      ],
      contentHash: "page-hash",
      hasComments: true,
      lastEditedTime: "2026-06-25T13:00:00.000Z",
      structuredIngestion: true,
      warnings: [{ code: "unsupported_block", blockId: "block-2", message: "Unsupported block." }],
      references: [{ kind: "child_page", targetId: "child-1", title: "Child page" }],
      rowPages: [{
        pageId: "row-1",
        title: "Google docs fix integration",
        dataSourceId: "data-source-1",
        dataSourceTitle: "to do",
        relativePath: "pages/to-do-data-source-abc123/google-docs-fix-integration-page-def456/content.md",
        sourceContent: "# Google docs fix integration\n\n## Body\n\nFix the Google Docs ingestion path.\n\n## Comments\n\n- Row comment.",
        contentHash: "row-hash",
        hasComments: true,
        structuredFacts: {
          rowPageId: "row-1",
          dataSourceId: "data-source-1",
          blockStructureCount: 1,
          blockStructure: [{ blockId: "row-block-1", type: "paragraph", text: "Fix the Google Docs ingestion path." }],
        },
      }, {
        pageId: "row-1",
        title: "Google docs fix integration",
        dataSourceId: "data-source-1",
        dataSourceTitle: "to do",
        relativePath: "pages/to-do-data-source-abc123/google-docs-fix-integration-page-def456/content.md",
        sourceContent: "# Duplicate row should be ignored.",
        contentHash: "duplicate-row-hash",
      }],
      childPages: [{
        pageId: "child-1",
        title: "Child page",
        url: "https://notion.so/child-1",
        parentBlockId: "child-block-1",
        relativePath: "pages/child-page-page-abc789/content.md",
        sourceContent: "# Child page\n\n## Body\n\nNested child content.\n\n## Comments\n\n- Child comment.",
        contentHash: "child-hash",
        hasComments: true,
        structuredFacts: {
          childPageId: "child-1",
          parentBlockId: "child-block-1",
          nestedChildPageIds: ["grandchild-1"],
          blockStructureCount: 1,
          blockStructure: [{ blockId: "child-body-1", type: "paragraph", text: "Nested child content." }],
        },
        childPages: [{
          pageId: "grandchild-1",
          title: "Grandchild page",
          url: "https://notion.so/grandchild-1",
          parentBlockId: "grandchild-block-1",
          relativePath: "pages/grandchild-page-page-fed321/content.md",
          sourceContent: "# Grandchild page\n\n## Body\n\nNested grandchild content.",
          contentHash: "grandchild-hash",
          structuredFacts: {
            childPageId: "grandchild-1",
            parentBlockId: "grandchild-block-1",
            blockStructureCount: 1,
            blockStructure: [{ blockId: "grandchild-body-1", type: "paragraph", text: "Nested grandchild content." }],
          },
        }],
      }, {
        pageId: "child-1",
        title: "Child page duplicate",
        parentBlockId: "child-block-1",
        relativePath: "pages/child-page-page-abc789/content.md",
        sourceContent: "# Duplicate child should be ignored.",
        contentHash: "duplicate-child-hash",
      }],
    });

    const directory = notionPageSourceDirectory("page-123", "Customer Notes");
    expect(directory).toMatch(/^sources\/notion\/customer-notes-page-[a-f0-9]{12}$/u);
    expect(files.map((file) => file.path)).toEqual([
      `${directory}/content.md`,
      `${directory}/pages/to-do-data-source-abc123/google-docs-fix-integration-page-def456/content.md`,
      `${directory}/pages/child-page-page-abc789/content.md`,
      `${directory}/pages/grandchild-page-page-fed321/content.md`,
    ]);
    // Raw mirror: no generated summary.md or sections/ files.
    expect(files[0]?.content).toContain("# Content: Customer Notes");
    expect(files[0]?.content).toContain("## Processed Markdown");
    expect(files[0]?.content).toContain("Full processed page markdown.");
    expect(files[0]?.content).toContain("## Comments");
    expect(files[0]?.content).not.toContain("Page overview.");
    for (const file of files.filter((candidate) => candidate.content.includes("```json"))) {
      for (const fence of jsonFences(file.content)) {
        expect(() => JSON.parse(fence)).not.toThrow();
      }
    }
    expect(files[1]?.content).toContain("Fix the Google Docs ingestion path.");
    expect(files[1]?.content).toContain("Page ID: row-1");
    expect(files[1]?.content).toContain("## Structured Facts");
    expect(files[1]?.content).toContain("\"rowPageId\": \"row-1\"");
    expect(files[1]?.content).toContain("\"blockStructure\"");
    expect(files[2]?.content).toContain("Nested child content.");
    expect(files[2]?.content).toContain("Source: Notion child page");
    expect(files[2]?.content).toContain("Parent block ID: child-block-1");
    expect(files[2]?.content).toContain("\"childPageId\": \"child-1\"");
    expect(files[2]?.content).toContain("\"nestedChildPageIds\"");
    expect(files[3]?.content).toContain("Nested grandchild content.");
    expect(files[3]?.content).toContain("Parent block ID: grandchild-block-1");
    expect(files[3]?.content).toContain("\"childPageId\": \"grandchild-1\"");
    expect(files[0]?.meta?.sourceRefs).toEqual([
      { anchor: "Processed Markdown", sha256: "page-hash", url: "https://notion.so/page-123" },
      { anchor: "Comments", sha256: "page-hash", url: "https://notion.so/page-123" },
    ]);
    expect(files[1]?.meta?.sourceRefs).toEqual([
      { anchor: "Source Metadata", sha256: "row-hash" },
      { anchor: "Comments", sha256: "row-hash" },
    ]);
    expect(files[2]?.meta?.sourceRefs).toEqual([
      { anchor: "Source Metadata", sha256: "child-hash", url: "https://notion.so/child-1" },
      { anchor: "Comments", sha256: "child-hash", url: "https://notion.so/child-1" },
    ]);
    expect(files[3]?.meta?.sourceRefs).toEqual([
      { anchor: "Source Metadata", sha256: "grandchild-hash", url: "https://notion.so/grandchild-1" },
    ]);
    expect(executeMock).toHaveBeenCalledTimes(19);
    const statements = executeMock.mock.calls.map((call) => sqlParts(call[0]).join(" "));
    const rootIndex = statements.find((parts) => parts.includes("sources/index.md")) ?? "";
    expect(rootIndex).toContain("Notion");
  });

  it("does not infer Notion evidence from a navigation URL when legacy content identity is absent", async () => {
    const files = await materializeNotionPageSourceWiki({
      userId: "u1",
      pageId: "page-no-hash",
      title: "Legacy page",
      url: "https://notion.so/page-no-hash",
      sourceMarkdown: "Legacy rendered content.",
      refreshIndexes: false,
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.meta?.sourceRefs).toEqual([]);
  });

  it("materializes Granola meetings as summary and transcript markdown", async () => {
    const files = await materializeGranolaMeetingSourceWiki("u1", {
      eventId: "event-1",
      sourceEventId: "granola:meeting-123",
      timestamp: "2026-06-25T14:00:00.000Z",
      rawPayload: {
        granolaId: "meeting-123",
        title: "Design Review",
        summaryMarkdown: "Meeting summary.",
        owner: { name: "Elijah", email: "elijah@example.com" },
        calendarEvent: {
          calendar_event_id: "cal-42",
          scheduled_start_time: "2026-06-25T14:00:00.000Z",
          organiser: "lead@example.com",
          invitees: [{ email: "invitee@example.com" }],
        },
        transcript: [{
          text: "Let's ship the source mirror.",
          start_time: "00:01",
          speaker: { name: "Ishan" },
        }, {
          text: "Owner-only audio channel.",
          start_time: "00:02",
          speaker: { source: "microphone" },
        }, {
          text: "Neutral system channel.",
          start_time: "00:03",
          speaker: { source: "system" },
        }],
      },
    });

    const directory = granolaMeetingSourceDirectory("meeting-123", "Design Review");
    expect(files.map((file) => file.path)).toEqual([
      `${directory}/summary.md`,
      `${directory}/transcript.md`,
    ]);
    expect(directory).toMatch(/^sources\/granola\/design-review-meeting-[a-f0-9]{12}$/u);
    expect(files[0]?.content).toContain("Meeting summary.");
    expect(files[1]?.content).toContain("Ishan: Let's ship the source mirror.");
    expect(files[1]?.content).toContain("Elijah: Owner-only audio channel.");
    expect(files[1]?.content).toContain("speaker_unknown: Neutral system channel.");
    expect(files[1]?.content).not.toContain("microphone:");
    expect(files[1]?.content).not.toContain("system:");
    // Envelope carries the owner as actor identity and the calendar linkage.
    expect(files[0]?.meta).toMatchObject({
      provider: "granola",
      externalId: "meeting-123",
      authorEmail: "elijah@example.com",
      authorName: "Elijah",
      updatedByEmail: "elijah@example.com",
      meetingStartTime: "2026-06-25T14:00:00.000Z",
    });
    expect(files[0]?.meta?.kind).toBe("document");
    expect(files[1]?.meta?.kind).toBe("transcript");
    expect(files[0]?.meta?.aliases).toEqual(expect.arrayContaining([
      { kind: "gcal_event", value: "cal-42" },
      { kind: "email", value: "elijah@example.com" },
      { kind: "email", value: "lead@example.com" },
      { kind: "email", value: "invitee@example.com" },
    ]));
    expect(executeMock).toHaveBeenCalledTimes(17);
  });

  it("enqueues metadata-only envelope refreshes without pretending content changed", async () => {
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlParts(query).join(" ");
      return text.includes("INSERT INTO mirror_files")
        ? [{ path: "existing.md", updated_at: "2026-07-01T00:00:00.000Z", content_changed: false }]
        : [];
    });

    await materializeGranolaMeetingSourceWiki("u1", {
      eventId: "event-1",
      sourceEventId: "granola:meeting-meta",
      timestamp: "2026-07-01T00:00:00.000Z",
      rawPayload: {
        granolaId: "meeting-meta",
        title: "Metadata refresh",
        summaryText: "Unchanged content.",
        owner: { name: "New Owner", email: "owner@example.com" },
        transcript: [],
      },
    }, { refreshIndexes: false });

    expect(enqueueGraphIngestMock).toHaveBeenCalledTimes(2);
    expect(enqueueGraphIngestMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      contentSha: expect.any(String),
      meta: expect.objectContaining({ authorEmail: "owner@example.com" }),
      metadataOnly: true,
    }));
  });

  it("deletes Granola meeting source mirrors by stable suffix when only the note ID is known", async () => {
    await deleteGranolaMeetingSourceWiki("u1", "meeting-123");

    const suffix = granolaMeetingSourceDirectory("meeting-123").match(/meeting-[a-f0-9]{12}$/u)?.[0];
    expect(suffix).toBeTruthy();
    const cleanupParts = sqlParts(executeMock.mock.calls[0]?.[0]).join(" ");
    expect(cleanupParts).toContain(`sources/granola/${suffix}/%`);
    expect(cleanupParts).toContain(`sources/granola/%-${suffix}/%`);
  });

  it("feeds Slack window source metadata clocks into conversation chunk metadata", async () => {
    const input = {
      channelId: "C123",
      channelName: "engineering",
      messages: [
        slackMessage("1719792000.000000", "Planning. ".repeat(60), "Alex", "U1"),
        slackMessage("1719792300.000000", "Decision. ".repeat(60), "Blair", "U2"),
      ],
    };

    const result = await materializeSlackWindowSourceWiki("u1", input, { refreshIndexes: false });
    const windowFile = result.files.find((file) => file.path.includes("/sessions/")) ?? result.files[0];
    const start = windowFile.content.match(/^- Start: (.+)$/mu)?.[1];
    const end = windowFile.content.match(/^- End: (.+)$/mu)?.[1];

    const chunks = chunkMarkdown(windowFile.content, {
      minChunkChars: 1,
      parseSourceMetadataClocks: true,
    });

    expect(start).toBe("2024-07-01T00:00:00.000Z");
    expect(end).toBe("2024-07-01T00:05:00.000Z");
    expect(chunks).not.toHaveLength(0);
    expect(chunks.every((chunk) => chunk.meta.startTime === start)).toBe(true);
    expect(chunks.every((chunk) => chunk.meta.endTime === end)).toBe(true);
  });

  it("writes Slack window envelopes with per-message source refs and sender aliases", async () => {
    const input = {
      channelId: "C123",
      channelName: "engineering",
      messages: [
        slackMessage("1719792000.000000", "Planning. ".repeat(60), "Alex", "U1", undefined, "slack:C123:1719792000.000000"),
        slackMessage("1719792300.000000", "Decision. ".repeat(60), "Blair", "U2", undefined, "slack:C123:1719792300.000000"),
      ],
    };

    const result = await materializeSlackWindowSourceWiki("u1", input, { refreshIndexes: false });
    const windowFile = result.files.find((file) => file.path.includes("/sessions/")) ?? result.files[0];

    expect(windowFile.meta).toMatchObject({
      provider: "slack",
      externalId: "C123:session:2024-07-01T0000",
      kind: "conversation_window",
      title: "Session: engineering - 2024-07-01T0000",
      sourceUpdatedAt: "2024-07-01T00:05:00.000Z",
      sourceAcl: {},
    });
    expect(windowFile.meta?.aliases).toEqual(expect.arrayContaining([
      { kind: "slack_uid", value: "U1" },
      { kind: "slack_uid", value: "U2" },
    ]));
    expect(windowFile.meta?.sourceRefs).toEqual([
      { anchor: "1719792000.000000", sourceEventId: "slack:C123:1719792000.000000" },
      { anchor: "1719792300.000000", sourceEventId: "slack:C123:1719792300.000000" },
    ]);
  });

  it("renders Slack mention and reaction display text in window files deterministically", async () => {
    const input = {
      channelId: "C123",
      channelName: "engineering",
      messages: [
        slackMessage(
          "1719792000.000000",
          "@Blair owns the retry logic [reactions: :thumbsup:×3 (Dana Ruiz, Alex, Blair)] ".repeat(8),
          "Alex",
          "U1",
        ),
      ],
    };

    const first = await materializeSlackWindowSourceWiki("u1", input, { refreshIndexes: false });
    executeMock.mockClear();
    const second = await materializeSlackWindowSourceWiki("u1", input, { refreshIndexes: false });

    expect(first.files[0]?.content).toContain("@Blair owns the retry logic");
    expect(first.files[0]?.content).toContain("[reactions: :thumbsup:×3 (Dana Ruiz, Alex, Blair)]");
    expect(second.files.map((file) => file.content)).toEqual(first.files.map((file) => file.content));
  });

  it("materializes cyclic Notion child page trees without recursive overflow", async () => {
    const childPage: any = {
      pageId: "child-cycle",
      title: "Cyclic child",
      url: "https://notion.so/child-cycle",
      parentBlockId: "child-block-cycle",
      relativePath: "pages/cyclic-child-page-abc123/content.md",
      sourceContent: "# Cyclic child\n\nThis page points at itself.",
      contentHash: "child-cycle-hash",
      structuredFacts: { childPageId: "child-cycle" },
      childPages: [],
    };
    childPage.childPages.push(childPage);

    const files = await materializeNotionPageSourceWiki({
      userId: "u1",
      pageId: "page-cycle",
      title: "Cycle root",
      sourceMarkdown: "Root content.",
      childPages: [childPage],
    });

    const childFiles = files.filter((file) => file.path.endsWith("pages/cyclic-child-page-abc123/content.md"));
    expect(childFiles).toHaveLength(1);
    expect(childFiles[0]?.content).toContain("This page points at itself.");
  });

  it("deletes Notion page source mirrors by stable suffix when only the page ID is known", async () => {
    await deleteNotionPageSourceWiki("u1", "page-123");

    expect(executeMock).toHaveBeenCalledTimes(14);
    const suffix = notionPageSourceDirectory("page-123").match(/page-[a-f0-9]{12}$/u)?.[0];
    expect(suffix).toBeTruthy();
    const cleanupParts = sqlParts(executeMock.mock.calls[0]?.[0]).join(" ");
    expect(cleanupParts).toContain(`sources/notion/${suffix}/%`);
    expect(cleanupParts).toContain(`sources/notion/%-${suffix}/%`);
  });

  it("materializes Gmail messages as dated per-message files", async () => {
    const file = await materializeGmailMessageSourceWiki("u1", {
      eventId: "event-1",
      sourceEventId: "gmail:msg-1",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload: {
        gmailId: "msg-1",
        threadId: "thread-1",
        labelIds: ["INBOX", "UNREAD"],
        from: "Stripe Billing <billing@stripe.com>",
        to: "ishan@askshepherd.ai",
        subject: "Your invoice is paid",
        date: "Sun, 28 Jun 2026 12:00:00 +0000",
        messageId: "<abc@mail.gmail.com>",
        bodySource: "text/plain",
        bodyText: "Invoice INV-42 was paid in full.",
        attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 12345 }],
        _from_email: "billing@stripe.com",
        _from_name: "Stripe Billing",
      },
    }, { refreshIndexes: false });

    expect(file).not.toBeNull();
    expect(file?.path).toBe(gmailMessageSourcePath("msg-1", {
      timestamp: "2026-06-28T12:00:00.000Z",
      fromEmail: "billing@stripe.com",
      fromName: "Stripe Billing",
      subject: "Your invoice is paid",
      labelIds: ["INBOX", "UNREAD"],
    }));
    expect(file?.path).toMatch(/^sources\/gmail\/inbox\/2026\/06\/2026-06-28--billing--your-invoice-is-paid--message-[a-f0-9]{12}\.md$/u);
    expect(file?.content).toContain("# Your invoice is paid");
    expect(file?.content).toContain("- From: Stripe Billing <billing@stripe.com>");
    expect(file?.content).not.toContain("- Labels:");
    expect(file?.content).not.toContain("UNREAD");
    expect(file?.content).toContain("Invoice INV-42 was paid in full.");
    expect(file?.content).toContain("- invoice.pdf (application/pdf, 12345 bytes)");
    // upsert + stale-path sweep
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("keeps rendered Gmail content identical across volatile label-only changes", async () => {
    let upserts = 0;
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlParts(query).join(" ");
      if (!text.includes("INSERT INTO mirror_files")) return [];
      upserts++;
      return upserts === 1
        ? [{ path: "sources/gmail/inbox/message.md", updated_at: "2026-06-28T12:00:00.000Z", content_changed: true }]
        : [];
    });
    const base = {
      eventId: "event-1",
      sourceEventId: "gmail:msg-labels",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload: {
        gmailId: "msg-labels",
        threadId: "thread-1",
        labelIds: ["INBOX", "UNREAD", "STARRED"],
        from: "Alice <alice@example.com>",
        to: "me@example.com",
        subject: "Stable message",
        date: "Sun, 28 Jun 2026 12:00:00 +0000",
        bodyText: "The message body does not change.",
      },
    };

    const before = await materializeGmailMessageSourceWiki("u1", base, { refreshIndexes: false });
    const after = await materializeGmailMessageSourceWiki("u1", {
      ...base,
      rawPayload: { ...base.rawPayload, labelIds: ["INBOX", "IMPORTANT", "CATEGORY_UPDATES"] },
    }, { refreshIndexes: false });

    expect(after?.path).toBe(before?.path);
    expect(after?.content).toBe(before?.content);
    expect(after?.content).not.toContain("UNREAD");
    expect(after?.content).not.toContain("IMPORTANT");
    // The content-hash upsert returns no changed row for the second render,
    // so only the initial write enters graph ingestion.
    expect(enqueueGraphIngestMock).toHaveBeenCalledTimes(1);
  });

  it("re-paths Gmail mailbox moves and deletes the old graph path", async () => {
    graphIngestEnabledMock.mockReturnValue(true);
    const inboxPath = gmailMessageSourcePath("msg-move", {
      timestamp: "2026-06-28T12:00:00.000Z",
      fromEmail: "alice@example.com",
      subject: "Move me",
      labelIds: ["INBOX"],
    });
    let stalePathSelects = 0;
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlParts(query).join(" ");
      if (text.includes("SELECT path") && text.includes("sources/gmail/")) {
        stalePathSelects++;
        return stalePathSelects === 2 ? [{ path: inboxPath }] : [];
      }
      return [];
    });
    const base = {
      sourceEventId: "gmail:msg-move",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload: {
        gmailId: "msg-move",
        labelIds: ["INBOX"],
        from: "Alice <alice@example.com>",
        _from_email: "alice@example.com",
        subject: "Move me",
        bodyText: "Same content, different mailbox.",
      },
    };

    const inbox = await materializeGmailMessageSourceWiki("u1", base, { refreshIndexes: false });
    const archived = await materializeGmailMessageSourceWiki("u1", {
      ...base,
      rawPayload: { ...base.rawPayload, labelIds: [] },
    }, { refreshIndexes: false });

    expect(inbox?.path).toBe(inboxPath);
    expect(archived?.path).toMatch(/^sources\/gmail\/archive\//u);
    expect(archived?.content).toBe(inbox?.content);
    expect(enqueueGraphDeleteMock).toHaveBeenCalledTimes(1);
    expect(enqueueGraphDeleteMock).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "u1", path: inboxPath },
    );
  });

  it("removes rather than materializes Gmail messages that are deleted or spam/trash", async () => {
    const spamFile = await materializeGmailMessageSourceWiki("u1", {
      sourceEventId: "gmail:msg-spam",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload: { gmailId: "msg-spam", subject: "Spam", bodySource: "text/plain", labelIds: ["SPAM"] },
    }, { refreshIndexes: false });
    const deletedFile = await materializeGmailMessageSourceWiki("u1", {
      sourceEventId: "gmail:msg-gone",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload: { gmailId: "msg-gone", subject: "Gone", bodySource: "text/plain", _deleted: true },
    }, { refreshIndexes: false });

    expect(spamFile).toBeNull();
    expect(deletedFile).toBeNull();
    expect(executeMock).toHaveBeenCalledTimes(2);
    const suffix = gmailMessageSourcePath("msg-spam").match(/message-[a-f0-9]{12}/u)?.[0];
    expect(suffix).toBeTruthy();
    const deleteParts = executeMock.mock.calls
      .map((call) => sqlParts(call[0]).join(" "))
      .find((parts) => parts.includes(`sources/gmail/%--${suffix}.md`));
    expect(deleteParts).toBeTruthy();

    executeMock.mockClear();
    await deleteGmailMessageSourceWiki("u1", "msg-spam", { refreshIndexes: false });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("renders the Gmail provider index with month counts and recent messages", async () => {
    const message = await materializeGmailMessageSourceWiki("u1", {
      sourceEventId: "gmail:msg-1",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload: {
        gmailId: "msg-1",
        subject: "Your invoice is paid",
        bodySource: "text/plain",
        bodyText: "Paid.",
        labelIds: ["INBOX"],
        _from_email: "billing@stripe.com",
      },
    }, { refreshIndexes: false });
    executeMock.mockClear();
    executeMock.mockResolvedValue([]);

    const indexes = await materializeSourceWikiIndexes("u1", message ? [message] : []);
    const gmailIndex = indexes.find((file) => file.path === "sources/gmail/index.md");
    const rootIndex = indexes.find((file) => file.path === "sources/index.md");

    expect(gmailIndex?.content).toContain("Total messages: 1");
    expect(gmailIndex?.content).toContain("- inbox: 1 message");
    expect(gmailIndex?.content).toContain("- inbox/2026/06: 1 message");
    expect(gmailIndex?.content).toContain("2026-06-28 - billing - your invoice is paid");
    expect(rootIndex?.content).toContain("[Gmail](gmail/index.md): 1 item");
  });

  it("materializes Slack as one channel-ID day file from stored events", async () => {
    executeMock.mockResolvedValueOnce([
      {
        event_id: "event-1",
        event_type: "message",
        source_event_id: "slack:C123:1800000000.000100",
        timestamp: "2027-01-15T08:00:00.100Z",
        source_updated_at: "2027-01-15T08:02:00.000Z",
        raw_payload: {
          ts: "1800000000.000100",
          text: "Updated launch note",
          _channel: "C123",
          _channel_name: "launch",
          _channel_type: "public_channel",
          _user_name: "Ada",
          _user_email: "ada@example.com",
          edited: { ts: "1800000120.000000" },
          reactions: [{ name: "white_check_mark", users: ["U2"], count: 2 }],
          files: [{ name: "roadmap.pdf", url_private: "[redacted: credentialed ephemeral URL]" }],
        },
      },
    ]);

    const file = await materializeSlackChannelDaySourceWiki("u1", {
      channelId: "C123",
      dayKey: "2027-01-15",
    }, { refreshIndexes: false });

    expect(file?.path).toBe(slackChannelDaySourcePath("C123", "2027-01-15"));
    expect(file?.path).toBe("sources/slack/C123/2027-01-15.md");
    expect(file?.content).toContain("# Slack launch - 2027-01-15");
    expect(file?.content).toContain("Channel ID: C123");
    expect(file?.content).toContain("**08:00** Ada <ada@example.com>: Updated launch note [file: roadmap.pdf]");
    expect(file?.content).toContain("edited 2027-01-15T08:02:00.000Z");
    expect(file?.content).toContain("reactions :white_check_mark: x2");
    expect(file?.content).not.toContain("url_private");
  });
});

describe("staged-document envelope (mirror_files.meta)", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
  });

  it("writes the Gmail envelope with an immutable externalId and content-sha versionRef", async () => {
    const rawPayload = {
      gmailId: "msg-1",
      threadId: "thread-1",
      labelIds: ["INBOX"],
      from: "Stripe Billing <billing@stripe.com>",
      to: "ishan@askshepherd.ai",
      cc: "Ops <ops@askshepherd.ai>",
      subject: "Your invoice is paid",
      date: "Sun, 28 Jun 2026 12:00:00 +0000",
      bodySource: "text/plain",
      bodyText: "Paid.",
      _from_email: "billing@stripe.com",
      _from_name: "Stripe Billing",
    };
    const file = await materializeGmailMessageSourceWiki("u1", {
      eventId: "event-1",
      sourceEventId: "gmail:msg-1",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload,
    }, { refreshIndexes: false });

    expect(file?.meta).toMatchObject({
      provider: "gmail",
      externalId: "msg-1",
      kind: "conversation_window",
      title: "Your invoice is paid",
      authorEmail: "billing@stripe.com",
      authorName: "Stripe Billing",
      sourceAcl: {},
    });
    expect(file?.meta?.aliases).toEqual(expect.arrayContaining([
      { kind: "email", value: "billing@stripe.com" },
      { kind: "email", value: "ishan@askshepherd.ai" },
      { kind: "email", value: "ops@askshepherd.ai" },
    ]));
    expect(file?.meta?.sourceRefs).toEqual([{ anchor: "Body", sourceEventId: "gmail:msg-1" }]);

    // The persisted envelope gets the content-sha versionRef fallback, and a
    // meta-less write can never clobber it (COALESCE in the upsert).
    const upsertCall = executeMock.mock.calls
      .find((call) => sqlParts(call[0]).join(" ").includes("INSERT INTO mirror_files"));
    expect(upsertCall).toBeTruthy();
    expect(sqlParts(upsertCall![0]).join(" ")).toContain("COALESCE(EXCLUDED.meta, mirror_files.meta)");
    expect(sqlParts(upsertCall![0]).join(" ")).toContain("mirror_files.meta_sha IS DISTINCT FROM EXCLUDED.meta_sha");
    const metaParam = sqlParts(upsertCall![0])
      .find((param): param is string => typeof param === "string" && param.includes("\"provider\":\"gmail\""));
    expect(metaParam).toBeTruthy();
    const persisted = JSON.parse(metaParam!);
    expect(persisted.externalId).toBe("msg-1");
    expect(persisted.versionRef).toEqual(expect.any(String));
    expect(persisted.versionRef.length).toBeGreaterThan(0);

    // externalId is immutable: a re-render under a new subject keeps the id.
    const renamed = await materializeGmailMessageSourceWiki("u1", {
      eventId: "event-1",
      sourceEventId: "gmail:msg-1",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload: { ...rawPayload, subject: "Re: totally different subject" },
    }, { refreshIndexes: false });
    expect(renamed?.meta?.externalId).toBe("msg-1");
    expect(renamed?.meta?.title).toBe("Re: totally different subject");
  });

  it("writes the Slack channel-day envelope with per-message sourceRefs and identity aliases", async () => {
    executeMock.mockResolvedValueOnce([
      {
        event_id: "event-1",
        event_type: "message",
        source_event_id: "slack:C123:1800000000.000100",
        timestamp: "2027-01-15T08:00:00.100Z",
        source_updated_at: "2027-01-15T08:02:00.000Z",
        raw_payload: {
          ts: "1800000000.000100",
          text: "Updated launch note",
          user: "U1",
          _channel: "C123",
          _channel_name: "launch",
          _channel_type: "public_channel",
          _user_name: "Ada",
          _user_email: "ada@example.com",
        },
      },
      {
        event_id: "event-2",
        event_type: "message",
        source_event_id: "slack:C123:1800000300.000200",
        timestamp: "2027-01-15T08:05:00.200Z",
        source_updated_at: null,
        raw_payload: {
          ts: "1800000300.000200",
          text: "Second message",
          user: "U2",
          _channel: "C123",
          _channel_name: "launch",
          _channel_type: "public_channel",
        },
      },
    ]);

    const file = await materializeSlackChannelDaySourceWiki("u1", {
      channelId: "C123",
      dayKey: "2027-01-15",
    }, { refreshIndexes: false });

    expect(file?.meta).toMatchObject({
      provider: "slack",
      externalId: "C123:2027-01-15",
      kind: "conversation_window",
      title: "Slack launch - 2027-01-15",
      sourceUpdatedAt: "2027-01-15T08:05:00.200Z",
      sourceAcl: {},
    });
    expect(file?.meta?.aliases).toEqual(expect.arrayContaining([
      { kind: "slack_uid", value: "U1" },
      { kind: "slack_uid", value: "U2" },
      { kind: "email", value: "ada@example.com" },
    ]));
    expect(file?.meta?.sourceRefs).toEqual([
      { anchor: "1800000000.000100", sourceEventId: "slack:C123:1800000000.000100" },
      { anchor: "1800000300.000200", sourceEventId: "slack:C123:1800000300.000200" },
    ]);
  });

  it("writes the Calendar envelope keyed by calendar+event id, immune to retitles", async () => {
    const snapshot = {
      calendarId: "cal-1",
      eventId: "evt-1",
      summary: "Design sync",
      status: "confirmed",
      eventType: "default",
      start: { dateTime: "2026-07-01T10:00:00Z" },
      end: { dateTime: "2026-07-01T11:00:00Z" },
      sourceUpdatedAt: "2026-06-30T09:00:00.000Z",
      rawPayload: {
        updated: "2026-06-30T09:00:00.000Z",
        htmlLink: "https://calendar.google.com/event?eid=abc",
        organizer: { email: "host@example.com", name: "Host" },
        creator: { email: "creator@example.com", name: "Creator" },
        attendees: [
          { email: "guest@example.com", name: "Guest", responseStatus: "accepted", organizer: true },
          {
            email: "room@resource.calendar.google.com",
            responseStatus: "needsAction",
            resource: true,
          },
        ],
        rawEvent: { visibility: "private" },
      },
    };
    const file = await materializeCalendarEventSourceWiki("u1", snapshot, { refreshIndexes: false });

    expect(file?.meta).toMatchObject({
      provider: "calendar",
      externalId: "cal-1:evt-1",
      kind: "document",
      title: "Design sync",
      versionRef: "2026-06-30T09:00:00.000Z",
      authorEmail: "creator@example.com",
      authorName: "Creator",
      sourceAcl: { visibility: "private", hasHumanAttendee: true },
    });
    expect(file?.meta?.aliases).toEqual(expect.arrayContaining([
      { kind: "gcal_event", value: "evt-1" },
      { kind: "email", value: "host@example.com" },
      { kind: "email", value: "creator@example.com" },
      { kind: "email", value: "guest@example.com" },
    ]));
    expect(file?.meta?.sourceRefs).toEqual([{
      anchor: "Description",
      sourceEventId: "gcal:cal-1:evt-1",
      url: "https://calendar.google.com/event?eid=abc",
    }]);
    expect(file?.content).toContain("- guest@example.com - RSVP: accepted - Organizer: true");
    expect(file?.content).toContain("- room@resource.calendar.google.com - RSVP: needsAction - Resource: true");
    expect(file?.content).not.toContain("(accepted)");

    const renamed = await materializeCalendarEventSourceWiki(
      "u1",
      { ...snapshot, summary: "Renamed meeting" },
      { refreshIndexes: false },
    );
    expect(renamed?.meta?.externalId).toBe("cal-1:evt-1");
  });

  it("stages a calcom_booking alias from conference data, location, or description", async () => {
    const base = {
      calendarId: "cal-1",
      summary: "15 Min Meeting between Venushker and Ishan Ramrakhiani",
      status: "confirmed",
      start: { dateTime: "2026-07-01T10:00:00Z" },
    };
    const fromConference = await materializeCalendarEventSourceWiki("u1", {
      ...base,
      eventId: "_c9gm4cj3evt",
      rawPayload: {
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://cal.com/video/wLDVU78KVvby7vf6C6ivh9" }],
        },
        // Conference data is scanned first; this differing description UID is ignored.
        description: "backup https://cal.com/video/zzIgnoredUid99",
      },
    }, { refreshIndexes: false });
    expect(fromConference?.meta?.aliases).toEqual(expect.arrayContaining([
      { kind: "gcal_event", value: "_c9gm4cj3evt" },
      { kind: "calcom_booking", value: "wLDVU78KVvby7vf6C6ivh9" },
    ]));

    const fromLocation = await materializeCalendarEventSourceWiki("u1", {
      ...base,
      eventId: "_et648lilevt",
      rawPayload: { location: "https://cal.com/video/wLDVU78KVvby7vf6C6ivh9" },
    }, { refreshIndexes: false });
    expect(fromLocation?.meta?.aliases).toContainEqual({ kind: "calcom_booking", value: "wLDVU78KVvby7vf6C6ivh9" });

    const fromDescription = await materializeCalendarEventSourceWiki("u1", {
      ...base,
      eventId: "evt-desc",
      rawPayload: { description: "Join here: https://app.cal.com/booking/AbCd1234xyz" },
    }, { refreshIndexes: false });
    expect(fromDescription?.meta?.aliases).toContainEqual({ kind: "calcom_booking", value: "AbCd1234xyz" });

    const fromHangoutLink = await materializeCalendarEventSourceWiki("u1", {
      ...base,
      eventId: "evt-hangout",
      rawPayload: { hangoutLink: "https://cal.com/video/wLDVU78KVvby7vf6C6ivh9" },
    }, { refreshIndexes: false });
    expect(fromHangoutLink?.meta?.aliases).toContainEqual({ kind: "calcom_booking", value: "wLDVU78KVvby7vf6C6ivh9" });
  });

  it("stages no calcom_booking alias for short UIDs or non-booking cal.com links", async () => {
    const file = await materializeCalendarEventSourceWiki("u1", {
      calendarId: "cal-1",
      eventId: "evt-none",
      summary: "Plain meeting",
      status: "confirmed",
      rawPayload: {
        location: "https://cal.com/video/abc1234", // 7-char UID: rejected
        description: "book me at https://cal.com/ishan/15min",
      },
    }, { refreshIndexes: false });
    expect(file?.meta?.aliases?.some((alias) => alias.kind === "calcom_booking")).toBe(false);
  });

  it("records a false Calendar participation signal without persisting attendee data", async () => {
    const file = await materializeCalendarEventSourceWiki("u1", {
      calendarId: "cal-1",
      eventId: "focus-1",
      summary: "Focus time",
      status: "confirmed",
      rawPayload: {
        attendees: [
          { email: "room@resource.calendar.google.com", resource: true },
          { email: "engineering@group.calendar.google.com" },
          { email: "calendar-notification@google.com" },
        ],
      },
    }, { refreshIndexes: false });

    expect(file?.meta?.sourceAcl).toEqual({ hasHumanAttendee: false });
  });

  it("omits the Calendar participation signal when an attendee cannot be classified", async () => {
    const file = await materializeCalendarEventSourceWiki("u1", {
      calendarId: "cal-1",
      eventId: "unknown-1",
      summary: "Unknown attendee shape",
      status: "confirmed",
      rawPayload: { attendees: [{ displayName: "Jordan Smith" }] },
    }, { refreshIndexes: false });

    expect(file?.meta?.sourceAcl).toEqual({});
  });

  it("enqueues a graph delete before removing a cancelled Calendar event", async () => {
    graphIngestEnabledMock.mockReturnValue(true);
    const doomedPath = "sources/calendar/2026/07/2026-07-01--design-sync--event-deadbeef1234.md";
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlParts(query).join(" ");
      return text.includes("SELECT path") && text.includes("sources/calendar/")
        ? [{ path: doomedPath }]
        : [];
    });

    const file = await materializeCalendarEventSourceWiki("u1", {
      calendarId: "cal-1",
      eventId: "evt-1",
      summary: "Design sync",
      status: "cancelled",
      rawPayload: {},
    }, { refreshIndexes: false });

    expect(file).toBeNull();
    expect(enqueueGraphDeleteMock).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "u1", path: doomedPath },
    );
    const deleteCallIndex = executeMock.mock.calls.findIndex(([query]) => {
      const text = sqlParts(query).join(" ");
      return text.includes("DELETE FROM mirror_files");
    });
    expect(deleteCallIndex).toBeGreaterThan(0);
    expect(enqueueGraphDeleteMock.mock.invocationCallOrder[0]).toBeLessThan(
      executeMock.mock.invocationCallOrder[deleteCallIndex]!,
    );
  });

  it("writes Google Docs source refs against the exact tab snapshot revision", async () => {
    const files = await materializeGoogleDocSourceWiki({
      userId: "u1",
      docId: "doc-123",
      title: "Product Plan",
      overview: "",
      tabSummaries: {},
      tabContents: [{ tabId: "tab-a", tabName: "Overview", revisionId: "rev-tab-8", content: "Body." }],
      rawJson: { documentId: "doc-123", revisionId: "rev-9" },
      revisionId: "rev-9",
      lastUpdated: "2026-06-25T12:00:00.000Z",
      refreshIndexes: false,
    });

    const tabFile = files.find((file) => file.path.includes("/tabs/"));
    expect(tabFile?.meta).toMatchObject({
      provider: "google-docs",
      externalId: "doc-123:tab-a",
      kind: "document",
      title: "Product Plan - Overview",
      versionRef: "rev-tab-8",
      sourceUpdatedAt: "2026-06-25T12:00:00.000Z",
    });
    expect(tabFile?.meta?.sourceRefs).toEqual([{
      anchor: "Content",
      sourceEventId: "gdoc:doc-123:tab-a:rev-tab-8",
      url: "https://docs.google.com/document/d/doc-123/edit?tab=tab-a",
    }]);

    const rawFile = files.find((file) => file.path.endsWith("/raw.md"));
    expect(rawFile?.meta).toMatchObject({
      provider: "google-docs",
      externalId: "doc-123",
      kind: "document",
      versionRef: "rev-9",
    });
    expect(rawFile?.meta?.sourceRefs).toEqual([{
      anchor: "Raw Google Docs API response (lossless)",
      sourceEventId: "gdoc:doc-123:rev-9",
      url: "https://docs.google.com/document/d/doc-123/edit",
    }]);
  });

  it("persists the iMessage month envelope to mirror_files (not just built in memory)", async () => {
    const file = await materializeImessageMonthSourceWiki("u1", {
      conversationId: "chat-1",
      conversationName: "Family",
      monthKey: "2026-06",
      messages: [
        { timestamp: "2026-06-02T10:00:00.000Z", text: "Hi", senderHandle: "mom@example.com" },
        { timestamp: "2026-06-03T11:00:00.000Z", text: "Hello", isFromMe: true },
      ],
    }, { refreshIndexes: false });

    expect(file?.meta).toMatchObject({
      provider: "imessage",
      externalId: "chat-1:2026-06",
      kind: "conversation_window",
      sourceUpdatedAt: "2026-06-03T11:00:00.000Z",
      sourceAcl: {},
    });
    expect(file?.meta?.aliases).toEqual([{ kind: "email", value: "mom@example.com" }]);

    const upsertCall = executeMock.mock.calls
      .find((call) => sqlParts(call[0]).join(" ").includes("INSERT INTO mirror_files"));
    expect(upsertCall).toBeTruthy();
    const metaParam = sqlParts(upsertCall![0])
      .find((param): param is string => typeof param === "string" && param.includes("\"provider\":\"imessage\""));
    expect(metaParam).toBeTruthy();
    expect(JSON.parse(metaParam!).externalId).toBe("chat-1:2026-06");
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonFences(value: string): string[] {
  const fences: string[] = [];
  const regex = /```json\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value))) {
    fences.push(match[1] ?? "");
  }
  return fences;
}

function slackMessage(
  ts: string,
  text: string,
  senderName: string,
  senderHandle: string,
  threadTs?: string,
  sourceEventId?: string,
) {
  return {
    ts,
    text,
    senderName,
    senderHandle,
    threadTs,
    sourceEventId,
  };
}

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [String(chunk)];
  });
}
