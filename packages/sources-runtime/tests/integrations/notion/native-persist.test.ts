import { beforeEach, describe, expect, it, vi } from "vitest";

// The dirty->render walk (render task + mirror backfill both funnel through
// fetchAndMaterializeNotionPageContentSourceWiki) must persist the native
// snapshot store from the page content it already fetched — no second walk.
const fetchNotionPageContentMock = vi.hoisted(() => vi.fn());
const buildNotionNativeSnapshotMock = vi.hoisted(() => vi.fn());
const persistNotionNativeSnapshotMock = vi.hoisted(() => vi.fn());
const materializeNotionPageMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/integrations/notion/content.js", () => ({
  fetchNotionPageContent: fetchNotionPageContentMock,
  notionChildPageStructuredFacts: vi.fn(() => ({})),
  notionDatabaseRowPageStructuredFacts: vi.fn(() => ({})),
  renderChildPageContent: vi.fn(() => ""),
  renderDatabaseRowPageContent: vi.fn(() => ""),
}));

vi.mock("../../../src/integrations/notion/native.js", () => ({
  buildNotionNativeSnapshot: buildNotionNativeSnapshotMock,
}));

vi.mock("../../../src/integrations/notion/snapshot.js", () => ({
  persistNotionNativeSnapshot: persistNotionNativeSnapshotMock,
}));

vi.mock("../../../src/mirror/materializer.js", () => ({
  materializeNotionPageSourceWiki: materializeNotionPageMock,
}));

import {
  fetchAndMaterializeNotionPageContentSourceWiki,
  notionSourceMarkdown,
} from "../../../src/integrations/notion/source-wiki.js";

const pageContent = {
  pageId: "page-1",
  title: "Roadmap",
  url: "https://notion.so/page-1",
  parentType: "workspace",
  parentId: "workspace-1",
  dataSourceId: null,
  contentHash: "hash-1",
  lastEditedTime: new Date("2026-07-01T00:00:00.000Z"),
  markdown: "Body.",
  markdownTruncated: false,
  structuredIngestion: true,
  warnings: [],
  references: [],
  sections: [],
  rowPages: [],
  childPages: [],
  comments: [],
};

const nativeSnapshot = {
  objects: [],
  edges: [],
  blocks: [],
  dataSources: [],
  databases: [],
  views: [],
  templates: [],
  comments: [],
};

describe("notion native snapshot persistence during render", () => {
  beforeEach(() => {
    fetchNotionPageContentMock.mockReset().mockResolvedValue(pageContent);
    buildNotionNativeSnapshotMock.mockReset().mockResolvedValue(nativeSnapshot);
    persistNotionNativeSnapshotMock.mockReset().mockResolvedValue(undefined);
    materializeNotionPageMock.mockReset().mockResolvedValue([]);
  });

  it("persists the native snapshot from the walker's fetched content, before staging", async () => {
    await fetchAndMaterializeNotionPageContentSourceWiki({
      userId: "u1",
      pageId: "page-1",
      overview: "Overview.",
      sectionSummaries: null,
      refreshIndexes: false,
    });

    expect(buildNotionNativeSnapshotMock).toHaveBeenCalledWith("u1", pageContent);
    expect(persistNotionNativeSnapshotMock).toHaveBeenCalledWith("u1", "page-1", nativeSnapshot);
    expect(materializeNotionPageMock).toHaveBeenCalledTimes(1);
    // Capture-plane write lands before the staged mirror write.
    expect(persistNotionNativeSnapshotMock.mock.invocationCallOrder[0])
      .toBeLessThan(materializeNotionPageMock.mock.invocationCallOrder[0]);
  });

  it("keeps a stable Comments heading for embedded page-comment evidence", () => {
    expect(notionSourceMarkdown({
      ...pageContent,
      sections: [
        { sectionId: "body", sectionTitle: "Body", content: "Page body.", contentHash: "body-hash", kind: "page_body" },
        { sectionId: "comments", sectionTitle: "Comments", content: "- Comment body.", contentHash: "comment-hash", kind: "comments" },
      ],
    } as any)).toContain("## Comments\n\n- Comment body.");
  });

  it("propagates a persist failure so the render retries instead of staging past raw capture", async () => {
    persistNotionNativeSnapshotMock.mockRejectedValueOnce(new Error("native store down"));

    await expect(fetchAndMaterializeNotionPageContentSourceWiki({
      userId: "u1",
      pageId: "page-1",
      overview: "",
      sectionSummaries: null,
    })).rejects.toThrow("native store down");
    expect(materializeNotionPageMock).not.toHaveBeenCalled();
  });
});
