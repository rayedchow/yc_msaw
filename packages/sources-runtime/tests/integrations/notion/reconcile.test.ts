import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
}));
const discoverNotionPagesMock = vi.hoisted(() => vi.fn());
const removeNotionPageContentMock = vi.hoisted(() => vi.fn());
const retrieveNotionPageMock = vi.hoisted(() => vi.fn());
const retrieveNotionDataSourceMock = vi.hoisted(() => vi.fn());
const retrieveNotionDatabaseMock = vi.hoisted(() => vi.fn());
const emitNotionTombstoneEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({ db: dbMock }));
vi.mock("../../../src/integrations/notion/poller.js", () => ({
  discoverNotionPages: discoverNotionPagesMock,
  removeNotionPageContent: removeNotionPageContentMock,
}));
vi.mock("../../../src/integrations/notion/client.js", () => ({
  retrieveNotionPage: retrieveNotionPageMock,
  retrieveNotionDataSource: retrieveNotionDataSourceMock,
  retrieveNotionDatabase: retrieveNotionDatabaseMock,
  notionApiErrorSummary: (err: unknown) => {
    const status = (err as { status?: unknown } | null)?.status;
    return typeof status === "number" ? { status, code: null, message: "", retryAfterMs: null } : null;
  },
}));
vi.mock("../../../src/integrations/notion/tombstone.js", () => ({
  emitNotionTombstoneEvent: emitNotionTombstoneEventMock,
}));

import { reconcileNotionPages } from "../../../src/integrations/notion/reconcile.js";

function mockKnownRows(rows: Array<Record<string, unknown>>): void {
  dbMock.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(rows),
    })),
  });
}

function knownRow(pageId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageId,
    title: `Title of ${pageId}`,
    url: `https://notion.so/${pageId}`,
    parentType: "workspace",
    parentId: null,
    dataSourceId: null,
    lastEditedTime: new Date("2026-07-01T10:00:00.000Z"),
    ...overrides,
  };
}

function notFound(): { status: number } {
  return { status: 404 };
}

describe("Notion unshare reconciliation", () => {
  beforeEach(() => {
    dbMock.select.mockReset();
    discoverNotionPagesMock.mockReset();
    removeNotionPageContentMock.mockReset().mockResolvedValue(undefined);
    retrieveNotionPageMock.mockReset();
    retrieveNotionDataSourceMock.mockReset();
    retrieveNotionDatabaseMock.mockReset();
    emitNotionTombstoneEventMock.mockReset().mockResolvedValue(true);
  });

  it("tombstones a known page that is missing from the listing and 404s on direct fetch", async () => {
    discoverNotionPagesMock.mockResolvedValue([{ object: "page", id: "page-kept" }]);
    mockKnownRows([knownRow("page-kept"), knownRow("page-gone")]);
    retrieveNotionPageMock.mockRejectedValue(notFound());
    retrieveNotionDataSourceMock.mockRejectedValue(notFound());
    retrieveNotionDatabaseMock.mockRejectedValue(notFound());

    const result = await reconcileNotionPages("user-1");

    expect(result).toMatchObject({ known: 2, listed: 1, missing: 1, tombstoned: 1, stillAccessible: 0, capHit: false });
    expect(emitNotionTombstoneEventMock).toHaveBeenCalledTimes(1);
    expect(emitNotionTombstoneEventMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      eventType: "page.unshared",
      externalId: "page-gone",
      versionRef: "2026-07-01T10:00:00.000Z",
      payload: expect.objectContaining({
        eventType: "page.unshared",
        detectedVia: "reconcile",
        pageId: "page-gone",
        verification: { page: 404, dataSource: 404, database: 404 },
      }),
    }));
    expect(removeNotionPageContentMock).toHaveBeenCalledWith("user-1", "page-gone");
    // Ledger row is written before the mirror/snapshot/summary removal.
    expect(emitNotionTombstoneEventMock.mock.invocationCallOrder[0])
      .toBeLessThan(removeNotionPageContentMock.mock.invocationCallOrder[0]);
  });

  it("does not tombstone a page missing from the listing that is still fetchable", async () => {
    discoverNotionPagesMock.mockResolvedValue([]);
    mockKnownRows([knownRow("page-lagging")]);
    retrieveNotionPageMock.mockResolvedValue({ object: "page", id: "page-lagging", in_trash: false });

    const result = await reconcileNotionPages("user-1");

    expect(result).toMatchObject({ missing: 1, tombstoned: 0, stillAccessible: 1 });
    expect(emitNotionTombstoneEventMock).not.toHaveBeenCalled();
    expect(removeNotionPageContentMock).not.toHaveBeenCalled();
  });

  it("treats a standalone data-source pseudo-page as accessible when the data source still resolves", async () => {
    discoverNotionPagesMock.mockResolvedValue([]);
    mockKnownRows([knownRow("ds-1")]);
    retrieveNotionPageMock.mockRejectedValue(notFound());
    retrieveNotionDataSourceMock.mockResolvedValue({ object: "data_source", id: "ds-1" });

    const result = await reconcileNotionPages("user-1");

    expect(result).toMatchObject({ tombstoned: 0, stillAccessible: 1 });
    expect(emitNotionTombstoneEventMock).not.toHaveBeenCalled();
  });

  it("defers (no tombstone) when the direct fetch fails with a non-404/403 status", async () => {
    discoverNotionPagesMock.mockResolvedValue([]);
    mockKnownRows([knownRow("page-flaky")]);
    retrieveNotionPageMock.mockRejectedValue({ status: 500 });

    const result = await reconcileNotionPages("user-1");

    expect(result.tombstoned).toBe(0);
    expect(result.skips.verifyErrors).toBe(1);
    expect(emitNotionTombstoneEventMock).not.toHaveBeenCalled();
    expect(removeNotionPageContentMock).not.toHaveBeenCalled();
  });

  it("skips the whole sweep when the listing hits its page cap", async () => {
    discoverNotionPagesMock.mockResolvedValue(
      Array.from({ length: 5000 }, (_, i) => ({ object: "page", id: `page-${i}` })),
    );
    mockKnownRows([knownRow("page-unlisted")]);

    const result = await reconcileNotionPages("user-1");

    expect(result.capHit).toBe(true);
    expect(result.skips.listingCapHit).toBe(1);
    expect(retrieveNotionPageMock).not.toHaveBeenCalled();
    expect(emitNotionTombstoneEventMock).not.toHaveBeenCalled();
  });

  it("tombstones a missing-but-fetchable page as deleted when the fetch reports it trashed", async () => {
    discoverNotionPagesMock.mockResolvedValue([]);
    mockKnownRows([knownRow("page-trashed")]);
    retrieveNotionPageMock.mockResolvedValue({
      object: "page",
      id: "page-trashed",
      in_trash: true,
      last_edited_time: "2026-07-02T12:00:00.000Z",
    });

    const result = await reconcileNotionPages("user-1");

    expect(result).toMatchObject({ tombstoned: 0, trashed: 1 });
    expect(emitNotionTombstoneEventMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      eventType: "page.deleted",
      externalId: "page-trashed",
      versionRef: "2026-07-02T12:00:00.000Z",
    }));
    expect(removeNotionPageContentMock).toHaveBeenCalledWith("user-1", "page-trashed");
  });
});
