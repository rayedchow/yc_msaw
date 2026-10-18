import { beforeEach, describe, expect, it, vi } from "vitest";

// processEditActivity vs the changes-feed fast path: when the poll already
// wrote a `gdocs:edit_detected:...` doc_edited row for an edit, the later
// (minutes-latent) Activity API report of the same edit must not insert a
// second row - and edits by a DIFFERENT actor in the same window must.
const insertValuesMock = vi.hoisted(() => vi.fn());
const insertReturningMock = vi.hoisted(() => vi.fn());
const insertConflictUpdateMock = vi.hoisted(() => vi.fn());
const executeMock = vi.hoisted(() => vi.fn());
const resolveActorEmailsMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertValuesMock(row);
        return {
          onConflictDoUpdate: insertConflictUpdateMock,
          onConflictDoNothing: () => ({ returning: insertReturningMock }),
        };
      },
    }),
    execute: executeMock,
  },
}));
vi.mock("../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));
vi.mock("../../src/polling/_archived-gdocs/gdocs-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/polling/_archived-gdocs/gdocs-api.js")>();
  return {
    ...actual,
    resolveActorEmails: resolveActorEmailsMock,
    getFileMetadata: vi.fn(async () => null),
  };
});
vi.mock("../../src/polling/_archived-gdocs/document-summary-tracker.js", () => ({
  markGoogleDocSummaryDirty: vi.fn(async () => {}),
}));

import { processEditActivity } from "../../src/polling/_archived-gdocs/gdocs-edits.js";

const DOC_MIME = "application/vnd.google-apps.document";
const NOW = Date.now();

function editActivity(over: Record<string, unknown> = {}) {
  return {
    timestamp: new Date(NOW - 5 * 60_000).toISOString(),
    actors: [{ user: { knownUser: { personName: "people/123", isCurrentUser: false } } }],
    targets: [{ driveItem: { name: "items/file-1", title: "Doc", mimeType: DOC_MIME } }],
    primaryActionDetail: { edit: {} },
    ...over,
  };
}

const changedFiles = new Map([["file-1", { name: "Doc", mimeType: DOC_MIME }]]);

function run(activity: Record<string, unknown>) {
  return processEditActivity("u1", [activity] as never, "token", "me@x.com", changedFiles, {
    actorIdentityAccessToken: "identity-token",
  });
}

function editedInserts() {
  return insertValuesMock.mock.calls.map((c) => c[0]).filter((r) => r.eventType === "doc_edited");
}

beforeEach(() => {
  vi.clearAllMocks();
  insertReturningMock.mockResolvedValue([{ id: "evt-1" }]);
  insertConflictUpdateMock.mockResolvedValue(undefined);
  executeMock.mockResolvedValue({ rows: [] });
  resolveActorEmailsMock.mockResolvedValue(new Map([["people/123", { email: "editor@corp.com", name: "Ed Itor" }]]));
  enqueueCollectedEventMock.mockResolvedValue(undefined);
});

describe("processEditActivity changes-feed dedupe", () => {
  it("skips an Activity edit already covered by a changes-feed row (same actor, in window)", async () => {
    executeMock.mockResolvedValue({ rows: [{ actor_email: "editor@corp.com" }] });

    const count = await run(editActivity());

    expect(count).toBe(0);
    expect(editedInserts()).toHaveLength(0);
    expect(enqueueCollectedEventMock).not.toHaveBeenCalled();
  });

  it("skips when the changes-feed row has no actor email (conservative: no double-count)", async () => {
    executeMock.mockResolvedValue({ rows: [{ actor_email: null }] });

    expect(await run(editActivity())).toBe(0);
    expect(editedInserts()).toHaveLength(0);
  });

  it("inserts when no changes-feed row covers the window", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    const count = await run(editActivity());

    expect(count).toBe(1);
    const rows = editedInserts();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].sourceEventId)).toMatch(/^gdocs:edit:file-1:/);
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("evt-1", "u1");
  });

  it("keeps a different actor's edit in the same window (both rows are real edits)", async () => {
    executeMock.mockResolvedValue({ rows: [{ actor_email: "someone-else@corp.com" }] });

    expect(await run(editActivity())).toBe(1);
    expect(editedInserts()).toHaveLength(1);
  });

  it("skips the lookup entirely for old activities (backfill re-scans)", async () => {
    const count = await run(editActivity({ timestamp: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString() }));

    expect(executeMock).not.toHaveBeenCalled();
    expect(count).toBe(1);
  });

  it("does not run the dedupe lookup for non-edit actions", async () => {
    const count = await run(editActivity({ primaryActionDetail: { rename: { oldTitle: "A", newTitle: "B" } } }));

    expect(executeMock).not.toHaveBeenCalled();
    expect(count).toBe(1);
    expect(insertValuesMock.mock.calls.map((c) => c[0]).filter((r) => r.eventType === "doc_renamed")).toHaveLength(1);
  });
});
