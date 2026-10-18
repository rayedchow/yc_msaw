import { beforeEach, describe, expect, it, vi } from "vitest";

// Poll-path update signals: webhooks are the only other emitter of Notion
// page signal events and may not be enabled, so a poll-detected
// last_edited_time advance must leave a versioned page.content_updated
// ledger row (and an unchanged or first-seen page must not).
const dbMock = vi.hoisted(() => ({
  delete: vi.fn(),
  select: vi.fn(),
  execute: vi.fn(),
}));
const searchNotionPagesMock = vi.hoisted(() => vi.fn());
const collectNotionDataSourcesMock = vi.hoisted(() => vi.fn());
const emitNotionTombstoneEventMock = vi.hoisted(() => vi.fn());
const mergeTokenMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({ db: dbMock }));
vi.mock("../../../src/mirror/materializer.js", () => ({
  deleteNotionPageSourceWiki: vi.fn(),
}));
vi.mock("../../../src/vault/tokens.js", () => ({
  mergeTokenMetadata: mergeTokenMetadataMock,
}));
vi.mock("../../../src/integrations/notion/client.js", () => ({
  searchNotionPages: searchNotionPagesMock,
  collectNotionDataSources: collectNotionDataSourcesMock,
  isNotionDataSourceRow: () => false,
  notionDataSourceParentPageId: () => null,
  notionEmbeddingDocId: (pageId: string) => `notion:${pageId}`,
  retrieveNotionDatabase: vi.fn(),
  retrieveNotionDataSource: vi.fn(),
  retrieveNotionPage: vi.fn(),
}));
vi.mock("../../../src/integrations/notion/content.js", () => ({
  notionPageSummaryMetadataPayload: () => ({}),
  notionPageSummaryStoredPropertiesPayload: () => ({}),
  summarizeNotionPageMetadata: (page: { id: string; url?: string; last_edited_time?: string }) => ({
    pageId: page.id,
    title: `Title ${page.id}`,
    url: page.url ?? `https://notion.so/${page.id}`,
    parentType: null,
    parentId: null,
    dataSourceId: null,
    lastEditedTime: page.last_edited_time ? new Date(page.last_edited_time) : null,
  }),
}));
vi.mock("../../../src/integrations/notion/snapshot.js", () => ({
  removeNotionNativePageSnapshot: vi.fn(),
  removeNotionNativeDataSourceSnapshot: vi.fn(),
}));
vi.mock("../../../src/integrations/notion/tombstone.js", () => ({
  emitNotionTombstoneEvent: emitNotionTombstoneEventMock,
}));

import { syncNotionPages } from "../../../src/integrations/notion/poller.js";

function page(id: string, lastEdited: string) {
  return { object: "page", id, last_edited_time: lastEdited, in_trash: false, is_archived: false, archived: false };
}

function mockExistingRows(rows: Array<{ pageId: string; lastEditedTime: Date | null; dirtyAt: Date | null }>) {
  dbMock.select.mockReturnValue({
    from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.execute.mockResolvedValue(undefined);
  collectNotionDataSourcesMock.mockResolvedValue([]);
  emitNotionTombstoneEventMock.mockResolvedValue(true);
  mergeTokenMetadataMock.mockResolvedValue(undefined);
});

describe("Notion poll page.content_updated signal events", () => {
  it("emits a versioned page.content_updated row when a known page's last_edited_time advances", async () => {
    searchNotionPagesMock.mockResolvedValue([page("page-1", "2026-07-08T12:00:00.000Z")]);
    mockExistingRows([{ pageId: "page-1", lastEditedTime: new Date("2026-07-08T09:00:00.000Z"), dirtyAt: null }]);

    await syncNotionPages("user-1", { maxPages: 10 });

    expect(emitNotionTombstoneEventMock).toHaveBeenCalledTimes(1);
    expect(emitNotionTombstoneEventMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      eventType: "page.content_updated",
      externalId: "page-1",
      // -> source_event_id `notion:page_content_updated:page-1:2026-07-08T12:00:00.000Z`
      versionRef: "2026-07-08T12:00:00.000Z",
      timestamp: new Date("2026-07-08T12:00:00.000Z"),
      payload: expect.objectContaining({
        eventType: "page.content_updated",
        detectedVia: "poll",
        pageId: "page-1",
        lastEditedTime: "2026-07-08T12:00:00.000Z",
        previousLastEditedTime: "2026-07-08T09:00:00.000Z",
      }),
    }));
    // Existing re-render behavior preserved: the summary upsert still runs.
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });

  it("emits nothing when last_edited_time is unchanged", async () => {
    searchNotionPagesMock.mockResolvedValue([page("page-1", "2026-07-08T09:00:00.000Z")]);
    mockExistingRows([{ pageId: "page-1", lastEditedTime: new Date("2026-07-08T09:00:00.000Z"), dirtyAt: null }]);

    await syncNotionPages("user-1", { maxPages: 10 });

    expect(emitNotionTombstoneEventMock).not.toHaveBeenCalled();
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });

  it("emits nothing for first-time discovery (backfill is not an edit)", async () => {
    searchNotionPagesMock.mockResolvedValue([page("page-new", "2026-07-08T12:00:00.000Z")]);
    mockExistingRows([]);

    await syncNotionPages("user-1", { maxPages: 10 });

    expect(emitNotionTombstoneEventMock).not.toHaveBeenCalled();
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });
});
