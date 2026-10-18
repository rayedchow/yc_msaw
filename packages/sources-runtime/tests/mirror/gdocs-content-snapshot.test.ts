import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture-time content persistence: mock the DB and API edges, keep the real
// renderer (parseDocContent) and the real redaction layer in the loop so the
// contentUri guarantee is tested end-to-end.
const selectLimitMock = vi.hoisted(() => vi.fn());
const insertValuesMock = vi.hoisted(() => vi.fn());
const insertReturningMock = vi.hoisted(() => vi.fn());
const fetchDocContentMock = vi.hoisted(() => vi.fn());
const storeDocImagesMock = vi.hoisted(() => vi.fn());
const materializeGoogleDocMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimitMock }) }) }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertValuesMock(row);
        return { onConflictDoNothing: () => ({ returning: insertReturningMock }) };
      },
    }),
  },
}));
vi.mock("../../src/integrations/google/gdocs/content.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/integrations/google/gdocs/content.js")>();
  return { ...actual, fetchDocContent: fetchDocContentMock };
});
vi.mock("../../src/integrations/google/gdocs/images.js", () => ({
  storeDocImages: storeDocImagesMock,
}));
vi.mock("../../src/mirror/materializer.js", () => ({
  materializeGoogleDocSourceWiki: materializeGoogleDocMock,
}));

import { snapshotDocContent } from "../../src/integrations/google/gdocs/content-snapshot.js";
import { parseDocContent } from "../../src/integrations/google/gdocs/content.js";

// A documents.get response carrying a live requester-scoped contentUri — the
// exact credential shape that must never reach a persisted row.
const EPHEMERAL_URI = "https://lh3.googleusercontent.com/docs/ephemeral-requester-token";
const fixtureRaw = {
  documentId: "doc-1",
  title: "Design Doc",
  revisionId: "rev-2",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Overview" },
      documentTab: {
        body: {
          content: [
            { paragraph: { elements: [{ textRun: { content: "Hello world\n" } }] } },
            { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: "img1" } }] } },
          ],
        },
        inlineObjects: {
          img1: {
            inlineObjectProperties: {
              embeddedObject: { title: "Q3 chart", imageProperties: { contentUri: EPHEMERAL_URI } },
            },
          },
        },
      },
    },
    {
      tabProperties: { tabId: "t.1", title: "Appendix" },
      documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "Notes\n" } }] } }] } },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimitMock.mockResolvedValue([]);
  insertReturningMock.mockResolvedValue([{ tabId: "t" }]);
  storeDocImagesMock.mockResolvedValue({ refsFound: 1, fetched: 1, skippedFresh: 0, skippedTooLarge: 0, failed: 0 });
  fetchDocContentMock.mockImplementation(async () => parseDocContent(fixtureRaw));
  materializeGoogleDocMock.mockResolvedValue([]);
});

describe("snapshotDocContent", () => {
  it("appends one row per tab keyed by the doc revision (version-append)", async () => {
    const result = await snapshotDocContent("u1", "doc-1", { modifiedTime: "2026-07-07T10:00:00Z" });

    expect(result).toMatchObject({ docId: "doc-1", status: "captured", revisionId: "rev-2", tabRowsInserted: 2 });
    const rows = insertValuesMock.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tabId)).toEqual(["t.0", "t.1"]);
    for (const row of rows) {
      expect(row).toMatchObject({ userId: "u1", docId: "doc-1", revisionId: "rev-2" });
      expect(row.contentSha).toEqual(expect.any(String));
      expect(row.sourceUpdatedAt).toBeInstanceOf(Date);
      expect(row.capturedAt).toBeInstanceOf(Date);
    }
    const overview = rows[0] as { title: string; content: { content: string } };
    expect(overview.title).toBe("Overview");
    expect(overview.content.content).toContain("Hello world");
    expect(overview.content.content).toContain("[image: Q3 chart]");
  });

  it("never persists a contentUri or requester-scoped URL, but image bytes fetch from the live raw", async () => {
    await snapshotDocContent("u1", "doc-1", { modifiedTime: "2026-07-07T10:00:00Z" });

    for (const call of insertValuesMock.mock.calls) {
      const serialized = JSON.stringify(call[0]);
      expect(serialized).not.toContain("ephemeral-requester-token");
      expect(serialized).not.toContain("googleusercontent");
      expect(serialized).not.toContain("contentUri");
    }
    // storeDocImages must receive the UNredacted response — the contentUri is
    // consumed in-process, inside its window, to capture the bytes.
    expect(storeDocImagesMock).toHaveBeenCalledTimes(1);
    const rawArg = storeDocImagesMock.mock.calls[0][2] as typeof fixtureRaw;
    expect(rawArg.tabs[0].documentTab?.inlineObjects?.img1.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri).toBe(EPHEMERAL_URI);
  });

  it("dedupes an already-stored revision instead of overwriting", async () => {
    insertReturningMock.mockResolvedValue([]);

    const result = await snapshotDocContent("u1", "doc-1", { modifiedTime: "2026-07-07T10:00:00Z" });

    expect(result).toMatchObject({ status: "deduped_revision", tabRowsInserted: 0 });
    // Rows were offered but the (user, doc, tab, revision) unique key rejected
    // them — version-append semantics, never an UPDATE.
    expect(insertValuesMock).toHaveBeenCalledTimes(2);
    // No new revision rows -> no mirror re-render.
    expect(materializeGoogleDocMock).not.toHaveBeenCalled();
  });

  it("materializes the per-tab mirror docs from the just-persisted redacted content", async () => {
    await snapshotDocContent("u1", "doc-1", { modifiedTime: "2026-07-07T10:00:00Z" });

    expect(materializeGoogleDocMock).toHaveBeenCalledTimes(1);
    const input = materializeGoogleDocMock.mock.calls[0][0];
    expect(input).toMatchObject({
      userId: "u1",
      docId: "doc-1",
      title: "Design Doc",
      revisionId: "rev-2",
    });
    expect(input.tabContents.map((tab: { tabId: string }) => tab.tabId)).toEqual(["t.0", "t.1"]);
    expect(input.tabContents.map((tab: { revisionId: string }) => tab.revisionId)).toEqual(["rev-2", "rev-2"]);
    expect(input.tabContents[0].content).toContain("Hello world");
    // The mirror renders from the REDACTED raw only — never the live response.
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("ephemeral-requester-token");
    expect(serialized).not.toContain("googleusercontent");
    expect(serialized).toContain("[redacted: ephemeral requester-scoped URL]");
  });

  it("persists author/updater identity on the snapshot rows and threads it to the mirror envelope", async () => {
    await snapshotDocContent("u1", "doc-1", {
      modifiedTime: "2026-07-07T10:00:00Z",
      authorEmail: "owner@corp.com",
      authorName: "Own Er",
      updatedByEmail: "editor@corp.com",
      updatedByName: "Ed Itor",
    });

    for (const call of insertValuesMock.mock.calls) {
      const content = (call[0] as { content: Record<string, unknown> }).content;
      expect(content).toMatchObject({
        authorEmail: "owner@corp.com",
        authorName: "Own Er",
        updatedByEmail: "editor@corp.com",
        updatedByName: "Ed Itor",
      });
    }
    expect(materializeGoogleDocMock.mock.calls[0][0]).toMatchObject({
      authorEmail: "owner@corp.com",
      authorName: "Own Er",
      updatedByEmail: "editor@corp.com",
    });
  });

  it("leaves identity fields absent when Drive exposed none (never guessed)", async () => {
    await snapshotDocContent("u1", "doc-1", { modifiedTime: "2026-07-07T10:00:00Z" });

    for (const call of insertValuesMock.mock.calls) {
      const content = (call[0] as { content: Record<string, unknown> }).content;
      expect(content).not.toHaveProperty("authorEmail");
      expect(content).not.toHaveProperty("updatedByEmail");
    }
  });

  it("skips the Docs fetch entirely when the change's modifiedTime is already covered", async () => {
    selectLimitMock.mockResolvedValue([{ revisionId: "rev-1" }]);

    const result = await snapshotDocContent("u1", "doc-1", { modifiedTime: "2026-07-07T10:00:00Z" });

    expect(result).toMatchObject({ status: "skipped_fresh", revisionId: "rev-1", tabRowsInserted: 0 });
    expect(fetchDocContentMock).not.toHaveBeenCalled();
    expect(storeDocImagesMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(materializeGoogleDocMock).not.toHaveBeenCalled();
  });
});
