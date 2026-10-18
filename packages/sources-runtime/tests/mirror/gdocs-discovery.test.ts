import { beforeEach, describe, expect, it, vi } from "vitest";

// Discovery + deletion propagation are DB- and API-edge logic: mock both edges
// (gdocs-api, db client, vault) and assert the orchestration between them.
const listWorkspaceFilesMock = vi.hoisted(() => vi.fn());
const listSharedDrivesMock = vi.hoisted(() => vi.fn());
const pollDriveChangesMock = vi.hoisted(() => vi.fn());
const getStartPageTokenMock = vi.hoisted(() => vi.fn());
const queryActivityMock = vi.hoisted(() => vi.fn());
const getDriveFileParentsMock = vi.hoisted(() => vi.fn());
const dbExecuteMock = vi.hoisted(() => vi.fn());
const scopeEntryMock = vi.hoisted(() => vi.fn());
const insertChainMock = vi.hoisted(() => vi.fn());
const insertValuesMock = vi.hoisted(() => vi.fn());
const insertReturningMock = vi.hoisted(() => vi.fn());
const updateWhereMock = vi.hoisted(() => vi.fn());
const updateSetMock = vi.hoisted(() => vi.fn());
const summaryDirtyMock = vi.hoisted(() => vi.fn());
const intakeBinaryDocumentMock = vi.hoisted(() => vi.fn());
const tombstoneBinaryDocumentMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/polling/_archived-gdocs/gdocs-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/polling/_archived-gdocs/gdocs-api.js")>();
  return {
    ...actual,
    listWorkspaceFiles: listWorkspaceFilesMock,
    listSharedDrives: listSharedDrivesMock,
    pollDriveChanges: pollDriveChangesMock,
    getStartPageToken: getStartPageTokenMock,
    queryActivity: queryActivityMock,
    getDriveFileParents: getDriveFileParentsMock,
    INTER_DOC_DELAY_MS: 0,
  };
});
vi.mock("../../src/db/client.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertValuesMock(row);
        return {
          onConflictDoUpdate: insertChainMock,
          onConflictDoNothing: () => ({ returning: insertReturningMock }),
        };
      },
    }),
    update: () => ({ set: updateSetMock.mockReturnValue({ where: updateWhereMock }) }),
    execute: dbExecuteMock,
  },
}));
vi.mock("../../src/graph/wiring/ingest-hook.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/graph/wiring/ingest-hook.js")>(),
  enqueueGraphIngestForGoogleDocScopeEntry: scopeEntryMock,
}));
vi.mock("../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));
vi.mock("../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));
vi.mock("../../src/vault/google-auth.js", () => ({
  getGoogleAccessToken: vi.fn(async () => "token"),
  GOOGLE_DOCS_DELEGATION_SCOPES: ["scope"],
  GOOGLE_PEOPLE_IDENTITY_DELEGATION_SCOPES: ["scope"],
}));
vi.mock("../../src/vault/tokens.js", () => ({
  getTokenMetadata: vi.fn(async () => ({ drivePageToken: "pt-1", email: "me@x.com" })),
  mergeTokenMetadata: vi.fn(async () => {}),
}));
vi.mock("../../src/polling/_archived-gdocs/document-summary-tracker.js", () => ({
  markGoogleDocSummaryDirty: summaryDirtyMock,
}));
vi.mock("../../src/integrations/binary/intake.js", () => ({
  intakeBinaryDocument: intakeBinaryDocumentMock,
  tombstoneBinaryDocument: tombstoneBinaryDocumentMock,
}));
vi.mock("../../src/polling/_archived-gdocs/gdocs-edits.js", () => ({
  processEditActivity: vi.fn(async () => 0),
}));
vi.mock("../../src/polling/_archived-gdocs/gdocs-comments.js", () => ({
  processCommentActivity: vi.fn(async () => 0),
}));

import { discoverGoogleDocs, pollGoogleDocs, writeDocTombstones } from "../../src/polling/_archived-gdocs/gdocs.js";

const DOC_MIME = "application/vnd.google-apps.document";
const PDF_MIME = "application/pdf";

function file(id: string, over: Record<string, unknown> = {}) {
  return { id, name: `Doc ${id}`, mimeType: DOC_MIME, modifiedTime: "2026-07-01T00:00:00Z", trashed: false, parents: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertChainMock.mockResolvedValue(undefined);
  insertReturningMock.mockResolvedValue([{ id: "evt-1" }]);
  updateWhereMock.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "w1" }]) });
  queryActivityMock.mockResolvedValue([]);
  getDriveFileParentsMock.mockResolvedValue([]);
  dbExecuteMock.mockResolvedValue([]);
  scopeEntryMock.mockResolvedValue(0);
  intakeBinaryDocumentMock.mockResolvedValue({ status: "stored" });
  tombstoneBinaryDocumentMock.mockResolvedValue(0);
  enqueueCollectedEventMock.mockResolvedValue(undefined);
  enqueueTaskMock.mockResolvedValue(undefined);
});

describe("discoverGoogleDocs", () => {
  it("rejects zero or multiple modes", async () => {
    await expect(discoverGoogleDocs("u1", {})).rejects.toThrow(/exactly one/);
    await expect(discoverGoogleDocs("u1", { query: "x", driveIds: "all" })).rejects.toThrow(/exactly one/);
  });

  it("query mode: wraps the caller's q with the mime + trashed filter and tracks every page", async () => {
    listWorkspaceFilesMock
      .mockResolvedValueOnce({ files: [file("a"), file("skip", { trashed: true })], nextPageToken: "p2" })
      .mockResolvedValueOnce({ files: [file("b")] });

    const result = await discoverGoogleDocs("u1", { query: "name contains 'spec'" });

    expect(result).toMatchObject({ mode: "query", filesSeen: 2, tracked: 2, foldersTruncated: false });
    const q = listWorkspaceFilesMock.mock.calls[0][1].q;
    expect(q).toContain("(name contains 'spec')");
    expect(q).toContain("trashed=false");
    expect(q).toContain(DOC_MIME);
    // Both live files upserted a watermark; the trashed one did not.
    expect(insertChainMock).toHaveBeenCalledTimes(4);
  });

  it("folders mode: recurses into subfolders and stops at the folder cap with foldersTruncated", async () => {
    // Each folder yields one doc page and one subfolder page pointing at the next folder.
    let folderN = 0;
    listWorkspaceFilesMock.mockImplementation(async (_t: string, opts: { q: string }) => {
      if (opts.q.includes("apps.folder")) {
        folderN++;
        return { files: [file(`sub-${folderN}`, { mimeType: "application/vnd.google-apps.folder" })] };
      }
      return { files: [file(`doc-${folderN}`)] };
    });

    const result = await discoverGoogleDocs("u1", { folderIds: ["root"] });

    // The synthetic folder chain is infinite, so a finishing walk means the
    // cap (GDOCS_DISCOVERY_MAX_FOLDERS, read at module load) kicked in.
    expect(result.foldersTruncated).toBe(true);
    expect(result.foldersScanned).toBeGreaterThan(0);
    expect(result.tracked).toBe(result.filesSeen);
  });

  it("shared-drives mode: enumerates drives via drives.list and crawls each with its driveId", async () => {
    listSharedDrivesMock.mockResolvedValue([{ id: "d1", name: "Eng" }, { id: "d2", name: "Ops" }]);
    listWorkspaceFilesMock
      .mockResolvedValueOnce({ files: [file("x")] })
      .mockResolvedValueOnce({ files: [file("y")] });

    const result = await discoverGoogleDocs("u1", { driveIds: "all", days: 30 });

    expect(result).toMatchObject({ mode: "shared-drives", drivesScanned: 2, tracked: 2 });
    expect(listWorkspaceFilesMock.mock.calls[0][1].driveId).toBe("d1");
    expect(listWorkspaceFilesMock.mock.calls[1][1].driveId).toBe("d2");
    expect(listWorkspaceFilesMock.mock.calls[0][1].q).toContain("modifiedTime > ");
  });

  it("explicit driveIds skips drives.list", async () => {
    listWorkspaceFilesMock.mockResolvedValue({ files: [] });
    await discoverGoogleDocs("u1", { driveIds: ["d9"] });
    expect(listSharedDrivesMock).not.toHaveBeenCalled();
    expect(listWorkspaceFilesMock.mock.calls[0][1].driveId).toBe("d9");
  });

  it("enqueues a content-snapshot task per discovered Google Doc, with author identity, skipping sheets", async () => {
    listWorkspaceFilesMock.mockResolvedValueOnce({
      files: [
        file("doc-a", {
          lastModifyingUser: { displayName: "Ed Itor", emailAddress: "editor@corp.com" },
          owners: [{ displayName: "Own Er", emailAddress: "owner@corp.com" }],
        }),
        file("sheet-b", { mimeType: "application/vnd.google-apps.spreadsheet" }),
        file("skip", { trashed: true }),
      ],
    });

    const result = await discoverGoogleDocs("u1", { query: "name contains 'spec'" });

    expect(result.snapshotsEnqueued).toBe(1);
    const snapshotCalls = enqueueTaskMock.mock.calls
      .map((c) => c[0])
      .filter((t) => t.kind === "gdocs.content-snapshot");
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toMatchObject({
      queue: "sync",
      tenantId: "u1",
      groupKey: "u1:gdocs",
      dedupeKey: "gdocs-content-snapshot:u1:doc-a",
      priority: -5,
      payload: {
        userId: "u1",
        docId: "doc-a",
        modifiedTime: "2026-07-01T00:00:00Z",
        authorEmail: "owner@corp.com",
        authorName: "Own Er",
        updatedByEmail: "editor@corp.com",
        updatedByName: "Ed Itor",
      },
    });
  });

  it("discovery still tracks docs when snapshot enqueue fails (fail-soft)", async () => {
    listWorkspaceFilesMock.mockResolvedValueOnce({ files: [file("doc-a")] });
    enqueueTaskMock.mockRejectedValue(new Error("queue down"));

    const result = await discoverGoogleDocs("u1", { query: "name contains 'spec'" });

    expect(result.tracked).toBe(1);
    expect(result.snapshotsEnqueued).toBe(0);
  });

  it("fires the graph scope-entry hook when a discovered doc enters a new folder lineage", async () => {
    listWorkspaceFilesMock.mockResolvedValueOnce({ files: [file("doc-a", { parents: ["new-folder"] })] });
    getDriveFileParentsMock.mockResolvedValueOnce([]);
    dbExecuteMock.mockResolvedValueOnce([{ folder_ids: ["old-folder"] }]);

    await discoverGoogleDocs("u1", { query: "name contains 'spec'" });

    expect(scopeEntryMock).toHaveBeenCalledWith(expect.any(Object), {
      tenantId: "u1",
      docId: "doc-a",
      mirrorPathPrefix: expect.stringMatching(/^sources\/google-docs\//),
      folderIds: ["new-folder"],
      previousFolderIds: ["old-folder"],
    });
  });
});

describe("pollGoogleDocs deletion propagation", () => {
  it("deactivates watermarks for removed and trashed changes", async () => {
    pollDriveChangesMock.mockResolvedValue({
      changes: [
        { fileId: "gone", removed: true },
        { fileId: "binned", file: { name: "B", mimeType: DOC_MIME, modifiedTime: "2026-07-01T00:00:00Z", trashed: true } },
        { fileId: "live", file: { name: "L", mimeType: DOC_MIME, modifiedTime: "2026-07-01T00:00:00Z", trashed: false } },
      ],
      newPageToken: "pt-2",
    });

    await pollGoogleDocs("u1");

    // Per dead doc: one is_active=false watermark update plus one close-out of
    // still-open suggestion rows; the live doc goes through the normal
    // tracking upsert instead.
    const setCalls = updateSetMock.mock.calls.map((c) => c[0]);
    expect(setCalls.filter((s) => s.isActive === false)).toHaveLength(2);
    expect(setCalls.filter((s) => s.status === "unknown")).toHaveLength(2);
    expect(insertChainMock).toHaveBeenCalledTimes(2);
    expect(tombstoneBinaryDocumentMock).toHaveBeenCalledWith({
      tenantId: "u1",
      provider: "drive-pdf",
      externalId: "gone",
    });
  });

  it("does not touch watermarks when nothing was removed", async () => {
    pollDriveChangesMock.mockResolvedValue({
      changes: [{ fileId: "live", file: { name: "L", mimeType: DOC_MIME, modifiedTime: "2026-07-01T00:00:00Z", trashed: false } }],
      newPageToken: "pt-2",
    });

    await pollGoogleDocs("u1");
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("routes PDF changes through the binary intake branch only", async () => {
    pollDriveChangesMock.mockResolvedValue({
      changes: [
        {
          fileId: "pdf-1",
          file: {
            name: "Spec.pdf",
            mimeType: PDF_MIME,
            modifiedTime: "2026-07-01T00:00:00Z",
            md5Checksum: "md5-pdf-1",
            lastModifyingUser: { displayName: "Editor", emailAddress: "editor@example.com" },
            trashed: false,
          },
        },
      ],
      newPageToken: "pt-2",
    });

    await pollGoogleDocs("u1");

    expect(intakeBinaryDocumentMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "u1",
      provider: "drive-pdf",
      externalId: "pdf-1",
      mimeType: PDF_MIME,
      versionRef: "md5-pdf-1",
      sourceUpdatedAt: "2026-07-01T00:00:00Z",
      authorEmail: "editor@example.com",
      sourceAcl: { provider: "drive-pdf", fileId: "pdf-1" },
      fetchBytes: expect.any(Function),
    }));
    expect(insertChainMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it("writes tombstone activity events for removed and trashed changes", async () => {
    pollDriveChangesMock.mockResolvedValue({
      changes: [
        { fileId: "gone", removed: true },
        { fileId: "binned", file: { name: "B", mimeType: DOC_MIME, modifiedTime: "2026-07-01T00:00:00Z", trashed: true } },
      ],
      newPageToken: "pt-2",
    });

    await pollGoogleDocs("u1");

    const rows = insertValuesMock.mock.calls.map((c) => c[0]);
    const tombstones = rows.filter((r) => String(r.sourceEventId ?? "").startsWith("gdocs:tombstone:"));
    expect(tombstones.map((r) => r.sourceEventId).sort()).toEqual([
      "gdocs:tombstone:binned:trashed",
      "gdocs:tombstone:gone:removed",
    ]);
    expect(enqueueCollectedEventMock).toHaveBeenCalledTimes(2);
  });

  it("enqueues a content-snapshot task per changed Google Doc, skipping sheets and PDFs", async () => {
    pollDriveChangesMock.mockResolvedValue({
      changes: [
        {
          fileId: "live",
          file: {
            name: "L",
            mimeType: DOC_MIME,
            modifiedTime: "2026-07-01T00:00:00Z",
            lastModifyingUser: { displayName: "Ed Itor", emailAddress: "editor@corp.com" },
            owners: [{ displayName: "Own Er", emailAddress: "owner@corp.com" }],
            trashed: false,
          },
        },
        { fileId: "sheet", file: { name: "S", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-07-01T00:00:00Z", trashed: false } },
        { fileId: "pdf", file: { name: "P.pdf", mimeType: PDF_MIME, modifiedTime: "2026-07-01T00:00:00Z", trashed: false } },
      ],
      newPageToken: "pt-2",
    });

    await pollGoogleDocs("u1");

    const snapshotCalls = enqueueTaskMock.mock.calls
      .map((c) => c[0])
      .filter((t) => t.kind === "gdocs.content-snapshot");
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toMatchObject({
      queue: "sync",
      tenantId: "u1",
      groupKey: "u1:gdocs",
      dedupeKey: "gdocs-content-snapshot:u1:live",
      priority: -5,
      payload: {
        userId: "u1",
        docId: "live",
        modifiedTime: "2026-07-01T00:00:00Z",
        authorEmail: "owner@corp.com",
        authorName: "Own Er",
        updatedByEmail: "editor@corp.com",
        updatedByName: "Ed Itor",
      },
    });
  });
});

describe("writeDocTombstones", () => {
  it("writes deterministically-keyed tombstone rows with gmail-style _deleted markers", async () => {
    const written = await writeDocTombstones("u1", [
      { fileId: "gone", removed: true },
      { fileId: "binned", file: { name: "B", mimeType: DOC_MIME, modifiedTime: "2026-07-01T00:00:00Z", trashed: true } },
    ]);

    expect(written).toBe(2);
    const rows = insertValuesMock.mock.calls.map((c) => c[0]);
    const gone = rows.find((r) => r.sourceEventId === "gdocs:tombstone:gone:removed");
    expect(gone).toMatchObject({ userId: "u1", source: "gdocs", eventType: "doc_removed", processingStatus: "received" });
    expect((gone!.rawPayload as Record<string, unknown>)._deleted).toBe(true);
    expect((gone!.rawPayload as Record<string, unknown>)._deleted_at).toEqual(expect.any(String));
    expect((gone!.rawPayload as Record<string, unknown>)._removal_kind).toBe("removed");

    const binned = rows.find((r) => r.sourceEventId === "gdocs:tombstone:binned:trashed");
    expect(binned).toMatchObject({ eventType: "doc_trashed" });
    expect((binned!.rawPayload as Record<string, unknown>)._file_name).toBe("B");
    expect(enqueueCollectedEventMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes repeat deliveries on the stable sourceEventId (onConflictDoNothing)", async () => {
    insertReturningMock.mockResolvedValue([]);

    const written = await writeDocTombstones("u1", [{ fileId: "gone", removed: true }]);

    expect(written).toBe(0);
    expect(enqueueCollectedEventMock).not.toHaveBeenCalled();
  });
});
