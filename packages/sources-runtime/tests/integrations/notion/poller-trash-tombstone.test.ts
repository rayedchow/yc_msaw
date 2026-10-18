import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  delete: vi.fn(),
}));
const searchNotionPagesMock = vi.hoisted(() => vi.fn());
const collectNotionDataSourcesMock = vi.hoisted(() => vi.fn());
const deleteNotionPageSourceWikiMock = vi.hoisted(() => vi.fn());
const removeNotionNativePageSnapshotMock = vi.hoisted(() => vi.fn());
const emitNotionTombstoneEventMock = vi.hoisted(() => vi.fn());
const mergeTokenMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({ db: dbMock }));
vi.mock("../../../src/mirror/materializer.js", () => ({
  deleteNotionPageSourceWiki: deleteNotionPageSourceWikiMock,
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
  summarizeNotionPageMetadata: vi.fn(),
}));
vi.mock("../../../src/integrations/notion/snapshot.js", () => ({
  removeNotionNativePageSnapshot: removeNotionNativePageSnapshotMock,
  removeNotionNativeDataSourceSnapshot: vi.fn(),
}));
vi.mock("../../../src/integrations/notion/tombstone.js", () => ({
  emitNotionTombstoneEvent: emitNotionTombstoneEventMock,
}));

import { syncNotionPages } from "../../../src/integrations/notion/poller.js";

describe("Notion poll trash tombstones", () => {
  beforeEach(() => {
    dbMock.delete.mockReset().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    searchNotionPagesMock.mockReset();
    collectNotionDataSourcesMock.mockReset().mockResolvedValue([]);
    deleteNotionPageSourceWikiMock.mockReset().mockResolvedValue(undefined);
    removeNotionNativePageSnapshotMock.mockReset().mockResolvedValue(undefined);
    emitNotionTombstoneEventMock.mockReset().mockResolvedValue(true);
    mergeTokenMetadataMock.mockReset().mockResolvedValue(undefined);
  });

  it("writes a page.deleted tombstone before removing poll-detected trashed pages", async () => {
    const trashedPage = {
      object: "page",
      id: "page-trashed",
      in_trash: true,
      last_edited_time: "2026-07-03T09:00:00.000Z",
    };
    searchNotionPagesMock.mockResolvedValue([trashedPage]);

    await syncNotionPages("user-1", { maxPages: 10, includeDataSources: true });

    expect(emitNotionTombstoneEventMock).toHaveBeenCalledTimes(1);
    expect(emitNotionTombstoneEventMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      eventType: "page.deleted",
      externalId: "page-trashed",
      versionRef: "2026-07-03T09:00:00.000Z",
      payload: expect.objectContaining({
        eventType: "page.deleted",
        detectedVia: "poll",
        pageId: "page-trashed",
        inTrash: true,
        page: trashedPage,
      }),
    }));
    // Existing removal behavior is preserved (mirror + snapshot + summary).
    expect(deleteNotionPageSourceWikiMock).toHaveBeenCalledWith("user-1", "page-trashed");
    expect(removeNotionNativePageSnapshotMock).toHaveBeenCalledWith("user-1", "page-trashed");
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
    // Ledger row precedes removal.
    expect(emitNotionTombstoneEventMock.mock.invocationCallOrder[0])
      .toBeLessThan(deleteNotionPageSourceWikiMock.mock.invocationCallOrder[0]);
  });
});
