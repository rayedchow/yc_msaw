import { beforeEach, describe, expect, it, vi } from "vitest";

const getGoogleAccessTokenMock = vi.hoisted(() => vi.fn());
const mergeTokenMetadataMock = vi.hoisted(() => vi.fn());
const getTokenMetadataMock = vi.hoisted(() => vi.fn());
const updateTokenMetadataMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const materializeGmailMock = vi.hoisted(() => vi.fn());
const materializeSourceWikiIndexesMock = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => {
  const limit = vi.fn(async () => []);
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit })),
    })),
  }));
  const returning = vi.fn(async () => [{ id: "event-1" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  }));
  return { select, insert, update, values, returning, onConflictDoNothing, limit };
});

// The mailbox roster/state module reads connections + google_mailbox_sync_state
// via db.execute; tests drive cursors through getTokenMetadata, so mirror that
// metadata into the roster/state surface (legacy single-mailbox semantics).
vi.mock("../../../src/integrations/google/mailboxes.js", () => ({
  listGoogleMailboxes: vi.fn(async () => {
    const metadata = (await getTokenMetadataMock("t", "google")) ?? {};
    return metadata.email ? [String(metadata.email).toLowerCase()] : [];
  }),
  getGoogleMailboxState: vi.fn(async () => {
    const metadata = (await getTokenMetadataMock("t", "google")) ?? {};
    return {
      historyId: metadata.historyId ?? null,
      lastBackfillAt: metadata.lastBackfillAt ?? null,
      drivePageToken: metadata.drivePageToken ?? null,
      lastEditPollAt: metadata.lastEditPollAt ?? null,
      lastCommentPollAt: metadata.lastCommentPollAt ?? null,
      lastDocsBackfillAt: metadata.lastDocsBackfillAt ?? null,
    };
  }),
  updateGoogleMailboxState: vi.fn(async () => {}),
}));

vi.mock("../../../src/db/client.js", () => ({
  db: dbMock,
}));

vi.mock("../../../src/vault/google-auth.js", () => ({
  GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES: ["https://www.googleapis.com/auth/gmail.readonly"],
  getGoogleAccessToken: getGoogleAccessTokenMock,
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  getTokenMetadata: getTokenMetadataMock,
  mergeTokenMetadata: mergeTokenMetadataMock,
  updateTokenMetadata: updateTokenMetadataMock,
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

vi.mock("../../../src/mirror/materializer.js", () => ({
  materializeGmailMessageSourceWiki: materializeGmailMock,
  materializeSourceWikiIndexes: materializeSourceWikiIndexesMock,
  deleteGmailMessageSourceWiki: vi.fn(),
}));

const intakeBinaryDocumentMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/integrations/binary/intake.js", () => ({
  intakeBinaryDocument: intakeBinaryDocumentMock,
}));

import { backfillGmailDetailed, pollGmail } from "../../../src/integrations/gmail/poller.js";

describe("Gmail poller raw capture", () => {
  beforeEach(() => {
    getGoogleAccessTokenMock.mockReset().mockResolvedValue("google-token");
    mergeTokenMetadataMock.mockReset().mockResolvedValue(undefined);
    getTokenMetadataMock.mockReset().mockResolvedValue({});
    updateTokenMetadataMock.mockReset().mockResolvedValue(undefined);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    materializeGmailMock.mockReset().mockResolvedValue(undefined);
    materializeSourceWikiIndexesMock.mockReset().mockResolvedValue(undefined);
    dbMock.select.mockClear();
    dbMock.insert.mockClear();
    dbMock.update.mockClear();
    dbMock.values.mockClear();
    dbMock.returning.mockClear();
    dbMock.onConflictDoNothing.mockClear();
    dbMock.limit.mockReset().mockResolvedValue([]);
    intakeBinaryDocumentMock.mockReset().mockResolvedValue({ status: "stored" });
    vi.unstubAllGlobals();
  });

  it("stores the full redacted Gmail message resource plus derived fields without inline attachment bytes", async () => {
    const bodyData = base64Url("Hello from Gmail");
    const inlineAttachmentData = base64Url("INLINE_ATTACHMENT_BYTES");
    const message = {
      id: "msg-1",
      threadId: "thread-1",
      labelIds: ["INBOX"],
      snippet: "Hello",
      historyId: "777",
      internalDate: "1704067200000",
      sizeEstimate: 1234,
      provider_extra: { retained: true },
      downloadUrl: "https://example.com/export?token=secret",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Alice <alice@example.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Subject", value: "Full payload" },
          { name: "Date", value: "Mon, 1 Jan 2024 00:00:00 +0000" },
          { name: "X-Provider-Only", value: "keep-me" },
        ],
        body: { size: 0 },
        parts: [
          {
            mimeType: "text/plain",
            filename: "",
            headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
            body: { size: 16, data: bodyData },
          },
          {
            mimeType: "image/png",
            filename: "diagram.png",
            headers: [
              { name: "Content-Disposition", value: "inline; filename=\"diagram.png\"" },
              { name: "Content-ID", value: "<diagram>" },
            ],
            body: { size: 24, data: inlineAttachmentData },
          },
          {
            partId: "2",
            mimeType: "application/pdf",
            filename: "report.pdf",
            body: { size: 99, attachmentId: "attachment-1" },
          },
        ],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith("/profile")) {
        return jsonResponse({ historyId: "history-2", emailAddress: "me@example.com" });
      }
      if (url.pathname.endsWith("/messages")) {
        return jsonResponse({ messages: [{ id: "msg-1" }] });
      }
      if (url.pathname.endsWith("/messages/msg-1")) {
        return jsonResponse(message);
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await backfillGmailDetailed("tenant-1", { maxMessages: 1 });

    expect(result.stored).toBe(1);
    const activityValues = (dbMock.values.mock.calls as unknown as Array<[any]>)
      .map(([value]) => value)
      .find((value) => value?.source === "gmail");
    expect(activityValues?.sourceEventId).toBe("gmail:msg-1");
    const payload = activityValues?.rawPayload as Record<string, any>;
    expect(payload.id).toBe("msg-1");
    expect(payload.threadId).toBe("thread-1");
    expect(payload.provider_extra).toEqual({ retained: true });
    expect(payload.downloadUrl).toContain("[redacted:");
    expect(payload.gmailId).toBe("msg-1");
    expect(payload.subject).toBe("Full payload");
    expect(payload.bodyText).toBe("Hello from Gmail");

    const parts = payload.payload.parts as Array<Record<string, any>>;
    expect(parts[0].body.data).toBe(bodyData);
    expect(parts[1].filename).toBe("diagram.png");
    expect(parts[1].body).toEqual({ size: 24 });
    expect(parts[2].body).toEqual({ size: 99, attachmentId: "attachment-1" });
    expect(JSON.stringify(payload)).not.toContain(inlineAttachmentData);

    // Attachment metadata in the convenience array carries the ids too.
    const attachments = payload.attachments as Array<Record<string, any>>;
    expect(attachments).toEqual([
      { filename: "diagram.png", mimeType: "image/png", size: 24 },
      { filename: "report.pdf", mimeType: "application/pdf", size: 99, attachmentId: "attachment-1", partId: "2" },
    ]);

    // Attachment BYTES go to the shared binary lane: the inline image from
    // its base64 data, the PDF via attachments.get - both keyed by a stable
    // (message, part) external id, never the volatile attachmentId.
    expect(intakeBinaryDocumentMock).toHaveBeenCalledTimes(2);
    const intakes = intakeBinaryDocumentMock.mock.calls.map(([input]) => input);
    expect(intakes[0]).toMatchObject({
      tenantId: "tenant-1",
      provider: "gmail-attachment",
      externalId: "msg-1:p0.1",
      mimeType: "image/png",
      versionRef: "gmail:msg-1:p0.1",
      authorEmail: "alice@example.com",
      sourceAcl: expect.objectContaining({ gmailId: "msg-1", threadId: "thread-1", filename: "diagram.png" }),
    });
    expect(intakes[1]).toMatchObject({
      provider: "gmail-attachment",
      externalId: "msg-1:2",
      mimeType: "application/pdf",
      versionRef: "gmail:msg-1:2",
    });
    const inlineBytes = await intakes[0].fetchBytes();
    expect(Buffer.from(inlineBytes).toString("utf8")).toBe("INLINE_ATTACHMENT_BYTES");
    expect(result.attachments).toMatchObject({ seen: 2, stored: 2, skippedOversize: 0, skippedUnsupportedType: 0, failed: 0 });
  });

  it("skips oversize attachment bytes with a visible counter and routes unsupported types through the lane", async () => {
    const message = {
      id: "msg-2",
      threadId: "thread-2",
      labelIds: ["INBOX"],
      internalDate: "1704067200000",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Bob <bob@example.com>" },
          { name: "Subject", value: "Big and odd" },
        ],
        body: { size: 0 },
        parts: [
          {
            partId: "1",
            mimeType: "application/pdf",
            filename: "huge.pdf",
            body: { size: 30 * 1024 * 1024, attachmentId: "attachment-huge" },
          },
          {
            partId: "2",
            mimeType: "application/zip",
            filename: "archive.zip",
            body: { size: 10, attachmentId: "attachment-zip" },
          },
        ],
      },
    };
    intakeBinaryDocumentMock.mockResolvedValue({ status: "failed_unsupported" });
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith("/profile")) {
        return jsonResponse({ historyId: "history-3", emailAddress: "me@example.com" });
      }
      if (url.pathname.endsWith("/messages")) {
        return jsonResponse({ messages: [{ id: "msg-2" }] });
      }
      if (url.pathname.endsWith("/messages/msg-2")) {
        return jsonResponse(message);
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await backfillGmailDetailed("tenant-1", { maxMessages: 1 });

    // Oversize never reaches the lane; unsupported goes through it and lands
    // as a metadata-only failed_unsupported row.
    expect(intakeBinaryDocumentMock).toHaveBeenCalledTimes(1);
    expect(intakeBinaryDocumentMock.mock.calls[0][0]).toMatchObject({
      externalId: "msg-2:2",
      mimeType: "application/zip",
    });
    expect(result.attachments).toMatchObject({
      seen: 2,
      stored: 0,
      skippedOversize: 1,
      skippedUnsupportedType: 1,
      failed: 0,
    });
  });
});

describe("Gmail poll deletion tombstones", () => {
  beforeEach(() => {
    getGoogleAccessTokenMock.mockReset().mockResolvedValue("google-token");
    mergeTokenMetadataMock.mockReset().mockResolvedValue(undefined);
    getTokenMetadataMock.mockReset().mockResolvedValue({ historyId: "h-1", email: "me@example.com" });
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    materializeSourceWikiIndexesMock.mockReset().mockResolvedValue(undefined);
    dbMock.insert.mockClear();
    dbMock.values.mockClear();
    dbMock.returning.mockReset().mockResolvedValue([{ id: "event-1" }]);
    dbMock.update.mockClear();
    dbMock.limit.mockReset();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith("/history")) {
        return jsonResponse({
          historyId: "h-2",
          history: [{ id: "rec-1", messagesDeleted: [{ message: { id: "msg-9", threadId: "t-9" } }] }],
        });
      }
      return new Response("not found", { status: 404 });
    }));
  });

  it("appends a stable-keyed message_deleted observation without mutating the captured message", async () => {
    // The base `gmail:msg-9` row exists (message was captured before deletion).
    dbMock.limit.mockResolvedValue([{ id: "row-1", rawPayload: { gmailId: "msg-9", threadId: "t-9" } }] as never);

    await pollGmail("tenant-1");

    const tombstones = (dbMock.values.mock.calls as unknown as Array<[any]>)
      .map(([value]) => value)
      .filter((value) => value?.eventType === "message_deleted");
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      userId: "tenant-1",
      source: "gmail",
      sourceEventId: "gmail:msg-9:deleted",
      processingStatus: "received",
    });
    expect(tombstones[0].rawPayload).toMatchObject({
      gmailId: "msg-9",
      threadId: "t-9",
      _deleted: true,
    });
    expect(typeof tombstones[0].rawPayload._deleted_at).toBe("string");
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("event-1", "tenant-1");
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("emits no tombstone when the deleted message was never captured", async () => {
    dbMock.limit.mockResolvedValue([]);

    await pollGmail("tenant-1");

    const tombstones = (dbMock.values.mock.calls as unknown as Array<[any]>)
      .map(([value]) => value)
      .filter((value) => value?.eventType === "message_deleted");
    expect(tombstones).toHaveLength(0);
    expect(enqueueCollectedEventMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
