import { beforeEach, describe, expect, it, vi } from "vitest";

// Fast-path doc_edited emission from the Drive changes feed: mock the DB and
// API edges (same harness as gdocs-discovery.test.ts) and assert the poll
// writes an immediate, versioned doc_edited row for changed workspace files
// without waiting for the Activity API.
const pollDriveChangesMock = vi.hoisted(() => vi.fn());
const queryActivityMock = vi.hoisted(() => vi.fn());
const insertChainMock = vi.hoisted(() => vi.fn());
const insertValuesMock = vi.hoisted(() => vi.fn());
const insertReturningMock = vi.hoisted(() => vi.fn());
const updateWhereMock = vi.hoisted(() => vi.fn());
const updateSetMock = vi.hoisted(() => vi.fn());
const summaryDirtyMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn());
const processEditActivityMock = vi.hoisted(() => vi.fn());
const dbExecuteMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/polling/_archived-gdocs/gdocs-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/polling/_archived-gdocs/gdocs-api.js")>();
  return {
    ...actual,
    pollDriveChanges: pollDriveChangesMock,
    getStartPageToken: vi.fn(async () => "pt-0"),
    queryActivity: queryActivityMock,
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
  intakeBinaryDocument: vi.fn(async () => ({ status: "stored" })),
  tombstoneBinaryDocument: vi.fn(async () => 0),
}));
vi.mock("../../src/polling/_archived-gdocs/gdocs-edits.js", () => ({
  processEditActivity: processEditActivityMock,
}));
vi.mock("../../src/polling/_archived-gdocs/gdocs-comments.js", () => ({
  processCommentActivity: vi.fn(async () => 0),
}));

import { emitDocEditedEventsForChangedDocs, pollGoogleDocs } from "../../src/polling/_archived-gdocs/gdocs.js";

const DOC_MIME = "application/vnd.google-apps.document";

function change(fileId: string, over: Record<string, unknown> = {}) {
  return {
    fileId,
    file: {
      name: `Doc ${fileId}`,
      mimeType: DOC_MIME,
      modifiedTime: "2026-07-08T10:00:00.000Z",
      lastModifyingUser: { displayName: "Ed Itor", emailAddress: "editor@corp.com" },
      parents: [],
      trashed: false,
      ...over,
    },
  };
}

function editedRows() {
  return insertValuesMock.mock.calls
    .map((c) => c[0])
    .filter((r) => r.eventType === "doc_edited");
}

beforeEach(() => {
  vi.clearAllMocks();
  insertChainMock.mockResolvedValue(undefined);
  insertReturningMock.mockResolvedValue([{ id: "evt-1" }]);
  updateWhereMock.mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
  queryActivityMock.mockResolvedValue([]);
  processEditActivityMock.mockResolvedValue(0);
  enqueueCollectedEventMock.mockResolvedValue(undefined);
  enqueueTaskMock.mockResolvedValue(undefined);
  dbExecuteMock.mockResolvedValue([]);
});

describe("pollGoogleDocs changes-feed doc_edited fast path", () => {
  it("emits an immediate versioned doc_edited row for a changed doc, before any Activity API result", async () => {
    pollDriveChangesMock.mockResolvedValue({ changes: [change("live")], newPageToken: "pt-2" });

    const count = await pollGoogleDocs("u1");

    const rows = editedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "u1",
      source: "gdocs",
      eventType: "doc_edited",
      sourceEventId: "gdocs:edit_detected:live:2026-07-08T10:00:00.000Z",
      processingStatus: "received",
    });
    // The edit time (not the poll time) is the event's source freshness.
    expect((rows[0].sourceUpdatedAt as Date).toISOString()).toBe("2026-07-08T10:00:00.000Z");
    expect((rows[0].timestamp as Date).toISOString()).toBe("2026-07-08T10:00:00.000Z");
    expect(rows[0].rawPayload).toMatchObject({
      fileId: "live",
      fileName: "Doc live",
      fileType: "doc",
      actorName: "Ed Itor",
      actorEmail: "editor@corp.com",
      _detected_via: "changes-feed",
    });
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("evt-1", "u1");
    expect(count).toBe(1);
  });

  it("prefers headRevisionId as the version key when Drive exposes one", async () => {
    pollDriveChangesMock.mockResolvedValue({
      changes: [change("rev-doc", { headRevisionId: "rev-42" })],
      newPageToken: "pt-2",
    });

    await pollGoogleDocs("u1");

    expect(editedRows()[0].sourceEventId).toBe("gdocs:edit_detected:rev-doc:rev-42");
  });

  it("is idempotent: the same revision delivered twice collapses to one insert attempt / one enqueue", async () => {
    // Duplicate within one batch dedupes in-memory...
    const written = await emitDocEditedEventsForChangedDocs("u1", [change("dup"), change("dup")] as never);
    expect(written).toBe(1);
    expect(editedRows()).toHaveLength(1);

    // ...and a redelivery across polls hits the (user_id, source_event_id)
    // unique index (returning comes back empty) - no enqueue, no count.
    insertReturningMock.mockResolvedValue([]);
    const rewritten = await emitDocEditedEventsForChangedDocs("u1", [change("dup")] as never);
    expect(rewritten).toBe(0);
    expect(enqueueCollectedEventMock).toHaveBeenCalledTimes(1);
  });

  it("emits nothing for sheets/slides-free polls with no workspace changes", async () => {
    pollDriveChangesMock.mockResolvedValue({
      changes: [{ fileId: "pdf", file: { name: "P.pdf", mimeType: "application/pdf", modifiedTime: "2026-07-08T10:00:00.000Z", trashed: false } }],
      newPageToken: "pt-2",
    });

    const count = await pollGoogleDocs("u1");

    expect(editedRows()).toHaveLength(0);
    expect(count).toBe(0);
  });
});
