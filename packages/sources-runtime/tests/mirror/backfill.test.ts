import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const fetchAndMaterializeNotionMock = vi.hoisted(() => vi.fn());
const materializeGmailMock = vi.hoisted(() => vi.fn());
const materializeCalendarMock = vi.hoisted(() => vi.fn());
const materializeGoogleDocMock = vi.hoisted(() => vi.fn());
const materializeGranolaMock = vi.hoisted(() => vi.fn());
const materializeNotionMock = vi.hoisted(() => vi.fn());
const materializeSourceWikiIndexesMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../src/integrations/notion/source-wiki.js", () => ({
  fetchAndMaterializeNotionPageContentSourceWiki: fetchAndMaterializeNotionMock,
}));

const materializeSlackMock = vi.hoisted(() => vi.fn());
const snapshotDocContentMock = vi.hoisted(() => vi.fn());
const fetchDocContentMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/integrations/google/gdocs/content-snapshot.js", () => ({
  snapshotDocContent: snapshotDocContentMock,
}));

vi.mock("../../src/integrations/google/gdocs/content.js", () => ({
  fetchDocContent: fetchDocContentMock,
}));

vi.mock("../../src/mirror/materializer.js", () => ({
  materializeSlackWindowSourceWiki: materializeSlackMock,
  materializeCalendarEventSourceWiki: materializeCalendarMock,
  materializeGmailMessageSourceWiki: materializeGmailMock,
  materializeGoogleDocSourceWiki: materializeGoogleDocMock,
  materializeGranolaMeetingSourceWiki: materializeGranolaMock,
  materializeNotionPageSourceWiki: materializeNotionMock,
  materializeImessageMonthSourceWiki: vi.fn(),
  materializeSourceWikiIndexes: materializeSourceWikiIndexesMock,
}));

import {
  backfillSourceWikiMirror,
  SOURCE_WIKI_BACKFILL_SOURCES,
  mirrorSlackChannelWindows,
} from "../../src/mirror/backfill.js";

describe("source wiki backfill", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    fetchAndMaterializeNotionMock.mockReset();
    materializeGmailMock.mockReset();
    materializeCalendarMock.mockReset();
    materializeGoogleDocMock.mockReset();
    materializeGranolaMock.mockReset();
    materializeNotionMock.mockReset();
    materializeSourceWikiIndexesMock.mockReset();
    materializeSourceWikiIndexesMock.mockResolvedValue([]);
    materializeSlackMock.mockReset();
    materializeSlackMock.mockResolvedValue({
      files: [],
      threads: { writtenPaths: [], crumbsSkipped: 0 },
      sessions: { writtenPaths: [], crumbsSkipped: 0 },
    });
    snapshotDocContentMock.mockReset();
    fetchDocContentMock.mockReset();
  });

  it("materializes Notion in the default source mirror backfill set", () => {
    expect([...SOURCE_WIKI_BACKFILL_SOURCES]).toEqual([
      "gmail",
      "calendar",
      "imessage",
      "google-docs",
      "notion",
      "granola",
      "slack",
    ]);
  });

  it("backfills Slack windows for every stored channel", async () => {
    executeMock
      .mockResolvedValueOnce([
        { channel_id: "C123", channel_name: "engineering", n: 2 },
      ])
      .mockResolvedValueOnce([
        slackBackfillRow("1719792000.000000", "Parent"),
        slackBackfillRow("1719813660.000000", "Channel update"),
      ])
      .mockResolvedValueOnce([]);
    materializeSlackMock.mockResolvedValueOnce({
      files: [
        { path: "sources/slack/engineering-channel-c123/threads/1719792000.000000.md", content: "thread" },
        { path: "sources/slack/engineering-channel-c123/sessions/2024-07-01T0601.md", content: "session" },
      ],
      threads: {
        writtenPaths: ["sources/slack/engineering-channel-c123/threads/1719792000.000000.md"],
        crumbsSkipped: 0,
      },
      sessions: {
        writtenPaths: ["sources/slack/engineering-channel-c123/sessions/2024-07-01T0601.md"],
        crumbsSkipped: 0,
      },
    });

    const result = await backfillSourceWikiMirror({ userId: "u1", sources: ["slack"] });

    expect(sqlParts(executeMock.mock.calls[0]?.[0]).join(" ")).toContain("GROUP BY 1");
    expect(materializeSlackMock).toHaveBeenCalledWith("u1", expect.objectContaining({
      channelId: "C123",
      channelName: "engineering",
    }), { refreshIndexes: false });
    expect(result.slack).toEqual({ rows: 2, files: 2 });
  });

  it("mirrors stored Gmail events into per-message source files", async () => {
    executeMock.mockResolvedValueOnce([
      {
        id: "event-1",
        source_event_id: "gmail:msg-1",
        timestamp: "2026-06-28T12:00:00.000Z",
        raw_payload: { gmailId: "msg-1", subject: "Invoice", bodySource: "text/plain", bodyText: "Paid." },
      },
      {
        id: "event-2",
        source_event_id: "gmail:msg-2",
        timestamp: "2026-06-29T12:00:00.000Z",
        raw_payload: { gmailId: "msg-2", subject: "Spammy", bodySource: "text/plain", labelIds: ["SPAM"] },
      },
    ]);
    materializeGmailMock
      .mockResolvedValueOnce({ path: "sources/gmail/2026/06/file.md", content: "email" })
      .mockResolvedValueOnce(null);

    const result = await backfillSourceWikiMirror({
      userId: "u1",
      sources: ["gmail"],
    });

    expect(materializeGmailMock).toHaveBeenCalledTimes(2);
    expect(materializeGmailMock).toHaveBeenCalledWith("u1", {
      eventId: "event-1",
      sourceEventId: "gmail:msg-1",
      timestamp: "2026-06-28T12:00:00.000Z",
      rawPayload: { gmailId: "msg-1", subject: "Invoice", bodySource: "text/plain", bodyText: "Paid." },
    }, { refreshIndexes: false });
    expect(result.gmail).toEqual({ rows: 2, files: 1 });
  });

  it("refreshes Notion source files through the structured parser", async () => {
    const sectionSummaries = {
      sectionA: {
        sectionId: "sectionA",
        sectionTitle: "Discovery",
        summary: "Stored section summary.",
        contentHash: "old-section-hash",
      },
    };
    executeMock.mockResolvedValueOnce([notionRow({ section_summaries: sectionSummaries })]);
    fetchAndMaterializeNotionMock.mockResolvedValueOnce([
      { path: "sources/notion/customer-notes-page-aaa/summary.md", content: "summary" },
      { path: "sources/notion/customer-notes-page-aaa/content.md", content: "content" },
      { path: "sources/notion/customer-notes-page-aaa/sections/section-bbb.md", content: "section" },
    ]);
    materializeSourceWikiIndexesMock.mockResolvedValueOnce([
      { path: "sources/index.md", content: "index" },
    ]);

    const result = await backfillSourceWikiMirror({
      userId: "u1",
      sources: ["notion"],
    });

    const query = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(query).not.toContain("COALESCE(overview, '') <> ''");
    expect(query).not.toContain("section_summaries <> '{}'::jsonb");
    expect(fetchAndMaterializeNotionMock).toHaveBeenCalledWith({
      userId: "u1",
      pageId: "page-123",
      overview: "Stored overview.",
      sectionSummaries,
      refreshIndexes: false,
    });
    expect(materializeNotionMock).not.toHaveBeenCalled();
    expect(result.notion).toEqual({ rows: 1, files: 3 });
    expect(result.indexes).toBe(1);
  });

  it("renders Google Docs tab content from stored snapshots — no Docs API call", async () => {
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlParts(query).join(" ");
      if (text.includes("FROM document_summaries")) {
        return [{
          doc_id: "doc-1",
          title: "Plan",
          overview: "Overview.",
          tab_summaries: {},
          last_updated: "2026-07-01T00:00:00.000Z",
        }];
      }
      if (text.includes("FROM google_doc_tab_snapshots")) {
        return [{
          tab_id: "t.0",
          revision_id: "rev-7",
          title: "Main",
          content: {
            content: "Body from snapshot.",
            suggestions: [],
            suggestionsAccessible: true,
            authorEmail: "owner@corp.com",
            authorName: "Own Er",
            updatedByEmail: "editor@corp.com",
          },
          captured_at: "2026-07-01T00:00:00.000Z",
        }, {
          // A tab may legitimately have an older latest snapshot after it
          // was removed from a later document revision. Its evidence must
          // stay bound to this row, not t.0's newer revision.
          tab_id: "t.1",
          revision_id: "rev-5",
          title: "Archived",
          content: {
            content: "Body from older snapshot.",
            suggestions: [],
            suggestionsAccessible: true,
          },
          captured_at: "2026-06-30T00:00:00.000Z",
        }];
      }
      return [];
    });
    materializeGoogleDocMock.mockResolvedValue([{ path: "sources/google-docs/x/tabs/t.md", content: "tab" }]);

    const result = await backfillSourceWikiMirror({ userId: "u1", sources: ["google-docs"] });

    expect(fetchDocContentMock).not.toHaveBeenCalled();
    expect(snapshotDocContentMock).not.toHaveBeenCalled();
    expect(materializeGoogleDocMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      docId: "doc-1",
      revisionId: null,
      preserveExistingRawFile: true,
      // Envelope authorship threads through from the capture-time snapshot.
      authorEmail: "owner@corp.com",
      authorName: "Own Er",
      updatedByEmail: "editor@corp.com",
      tabContents: [
        {
          tabId: "t.0",
          tabName: "Main",
          revisionId: "rev-7",
          content: "Body from snapshot.",
          suggestions: [],
          suggestionsAccessible: true,
        },
        {
          tabId: "t.1",
          tabName: "Archived",
          revisionId: "rev-5",
          content: "Body from older snapshot.",
          suggestions: [],
          suggestionsAccessible: true,
        },
      ],
      refreshIndexes: false,
    }));
    expect(materializeGoogleDocMock.mock.calls[0][0].rawJson).toBeUndefined();
    expect(result.googleDocs).toEqual({ rows: 1, files: 1 });
  });

  it("self-heals a snapshotless doc through the capture path, then renders from the table", async () => {
    let captured = false;
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlParts(query).join(" ");
      if (text.includes("FROM document_summaries")) {
        return [{
          doc_id: "doc-legacy",
          title: "Legacy",
          overview: "Overview.",
          tab_summaries: {},
          last_updated: "2026-07-01T00:00:00.000Z",
        }];
      }
      if (text.includes("FROM google_doc_tab_snapshots")) {
        return captured
          ? [{
            tab_id: "t.0",
            revision_id: "rev-1",
            title: "Main",
            content: { content: "Healed body.", suggestions: [], suggestionsAccessible: true },
            captured_at: "2026-07-07T00:00:00.000Z",
          }]
          : [];
      }
      return [];
    });
    snapshotDocContentMock.mockImplementation(async () => {
      captured = true;
      return { docId: "doc-legacy", status: "captured", revisionId: "rev-1", tabRowsInserted: 1 };
    });
    materializeGoogleDocMock.mockResolvedValue([{ path: "sources/google-docs/x/tabs/t.md", content: "tab" }]);

    await backfillSourceWikiMirror({ userId: "u1", sources: ["google-docs"] });

    // Fallback goes THROUGH the capture path so it persists the snapshot rows.
    expect(snapshotDocContentMock).toHaveBeenCalledWith("u1", "doc-legacy");
    expect(materializeGoogleDocMock).toHaveBeenCalledWith(expect.objectContaining({
      docId: "doc-legacy",
      revisionId: null,
      tabContents: [expect.objectContaining({ content: "Healed body.", revisionId: "rev-1" })],
    }));
  });

  it("falls back to stored Notion summaries when live structured parsing fails", async () => {
    const row = notionRow({ markdown_truncated: true });
    executeMock.mockResolvedValueOnce([row]);
    fetchAndMaterializeNotionMock.mockRejectedValueOnce(new Error("Notion fetch failed"));
    materializeNotionMock.mockResolvedValueOnce([
      { path: "sources/notion/customer-notes-page-aaa/summary.md", content: "summary" },
    ]);

    const result = await backfillSourceWikiMirror({
      userId: "u1",
      sources: ["notion"],
    });

    expect(materializeNotionMock).toHaveBeenCalledWith({
      userId: "u1",
      pageId: "page-123",
      title: "Customer Notes",
      url: "https://notion.so/page-123",
      parentType: "workspace",
      parentId: "workspace-1",
      dataSourceId: "data-source-1",
      overview: "Stored overview.",
      sectionSummaries: {},
      contentHash: "stored-page-hash",
      lastEditedTime: "2026-06-25T13:00:00.000Z",
      markdownTruncated: true,
      refreshIndexes: false,
    });
    expect(result.notion).toEqual({ rows: 1, files: 1 });
  });

  it("mirrors Slack channel windows from one full-history channel query", async () => {
    executeMock
      .mockResolvedValueOnce([
      {
        ts: "1719792000.000000",
        text: "Parent",
        sender_name: "Alex",
        sender_handle: "U1",
        thread_ts: "1719792000.000000",
        channel_name: "engineering",
        reactions: null,
        mentions: null,
      },
      {
        ts: "1719813660.000000",
        text: "Channel update",
        sender_name: "Blair",
        sender_handle: "U2",
        thread_ts: null,
        channel_name: "engineering",
        reactions: null,
        mentions: null,
      },
      ])
      .mockResolvedValueOnce([]);
    materializeSlackMock.mockResolvedValueOnce({
      files: [{ path: "sources/slack/engineering-channel-abc/sessions/2024-07-01T0601.md", content: "session" }],
      threads: { writtenPaths: ["sources/slack/engineering-channel-abc/threads/1719792000.000000.md"], crumbsSkipped: 0 },
      sessions: { writtenPaths: ["sources/slack/engineering-channel-abc/sessions/2024-07-01T0601.md"], crumbsSkipped: 0 },
    });

    const result = await mirrorSlackChannelWindows("u1", "C123");

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(sqlParts(executeMock.mock.calls[0]?.[0]).join(" ")).toContain("source = 'slack'");
    expect(sqlParts(executeMock.mock.calls[0]?.[0]).join(" ")).toContain("raw_payload->'reactions' AS reactions");
    expect(sqlParts(executeMock.mock.calls[0]?.[0]).join(" ")).toContain("raw_payload->'_mentions' AS mentions");
    expect(sqlParts(executeMock.mock.calls[0]?.[0]).join(" ")).toContain("event_type = 'message'");
    expect(sqlParts(executeMock.mock.calls[0]?.[0]).join(" ")).toContain("raw_payload->>'_ledger'");
    expect(sqlParts(executeMock.mock.calls[1]?.[0]).join(" ")).toContain("DISTINCT ON (raw_payload->>'user')");
    expect(materializeSlackMock).toHaveBeenCalledTimes(1);
    expect(materializeSlackMock).toHaveBeenCalledWith("u1", {
      channelId: "C123",
      channelName: "engineering",
      messages: [
        {
          ts: "1719792000.000000",
          text: "Parent",
          senderName: "Alex",
          senderHandle: "U1",
          threadTs: "1719792000.000000",
        },
        {
          ts: "1719813660.000000",
          text: "Channel update",
          senderName: "Blair",
          senderHandle: "U2",
          threadTs: null,
        },
      ],
    }, { refreshIndexes: false });
    expect(result.files).toHaveLength(1);
  });

  it("dedupes duplicate Slack rows by ts and keeps threaded attribution", async () => {
    executeMock
      .mockResolvedValueOnce([
      {
        ts: "1719792000.000000",
        text: "Broadcast reply",
        sender_name: "Alex",
        sender_handle: "U1",
        thread_ts: null,
        channel_name: "engineering",
        reactions: null,
        mentions: null,
      },
      {
        ts: "1719792000.000000",
        text: "Broadcast reply",
        sender_name: "Alex",
        sender_handle: "U1",
        thread_ts: "1719788400.000000",
        channel_name: "engineering",
        reactions: null,
        mentions: null,
      },
      ])
      .mockResolvedValueOnce([]);

    await mirrorSlackChannelWindows("u1", "C123");

    expect(materializeSlackMock).toHaveBeenCalledWith("u1", {
      channelId: "C123",
      channelName: "engineering",
      messages: [
        {
          ts: "1719792000.000000",
          text: "Broadcast reply",
          senderName: "Alex",
          senderHandle: "U1",
          threadTs: "1719788400.000000",
        },
      ],
    }, { refreshIndexes: false });
  });

  it("passes resolved Slack mentions and reactions through to the materializer", async () => {
    executeMock
      .mockResolvedValueOnce([
        {
          ts: "1719792000.000000",
          text: "<@U2> owns retries",
          sender_name: "Alex",
          sender_handle: "U1",
          thread_ts: null,
          channel_name: "engineering",
          reactions: [{ name: "thumbsup", count: 3, users: ["U1", "U2", "U3"] }],
          mentions: null,
        },
      ])
      .mockResolvedValueOnce([
        { id: "U1", name: "Dana Ruiz" },
        { id: "U2", name: "Blair" },
        { id: "U3", name: "Alex" },
      ]);

    await mirrorSlackChannelWindows("u1", "C123");

    expect(materializeSlackMock).toHaveBeenCalledWith("u1", {
      channelId: "C123",
      channelName: "engineering",
      messages: [{
        ts: "1719792000.000000",
        text: "@Blair owns retries [reactions: :thumbsup:×3 (Dana Ruiz, Blair, Alex)]",
        senderName: "Alex",
        senderHandle: "U1",
        threadTs: null,
      }],
    }, { refreshIndexes: false });
  });

  it("lets per-message mention stamps beat fallback Slack names", async () => {
    executeMock
      .mockResolvedValueOnce([
        {
          ts: "1719792000.000000",
          text: "<@U2> owns retries",
          sender_name: "Alex",
          sender_handle: "U1",
          thread_ts: null,
          channel_name: "engineering",
          reactions: null,
          mentions: { U2: "Stamped Blair" },
        },
      ])
      .mockResolvedValueOnce([{ id: "U2", name: "Fallback Blair" }]);

    await mirrorSlackChannelWindows("u1", "C123");

    expect(materializeSlackMock.mock.calls[0]?.[1].messages[0].text).toBe("@Stamped Blair owns retries");
  });

  it("never turns standalone Slack reaction events into window messages", async () => {
    executeMock
      .mockResolvedValueOnce([
        {
          ts: "1719792000.000000",
          text: "real message",
          sender_name: "Alex",
          sender_handle: "U1",
          thread_ts: null,
          channel_name: "engineering",
          reactions: null,
          mentions: null,
        },
      ])
      .mockResolvedValueOnce([]);

    await mirrorSlackChannelWindows("u1", "C123");

    expect(sqlParts(executeMock.mock.calls[0]?.[0]).join(" ")).toContain("event_type = 'message'");
    expect(materializeSlackMock.mock.calls[0]?.[1].messages).toHaveLength(1);
    expect(materializeSlackMock.mock.calls[0]?.[1].messages[0].text).toBe("real message");
  });

  it("renders deleted Slack messages as tombstones without leaking original text", async () => {
    executeMock
      .mockResolvedValueOnce([{
        ...slackBackfillRow("1719792000.000000", "secret original text"),
        deleted: true,
      }])
      .mockResolvedValueOnce([]);

    await mirrorSlackChannelWindows("u1", "C123");

    const message = materializeSlackMock.mock.calls[0]?.[1].messages[0];
    expect(message.text).toBe("[deleted]");
    expect(JSON.stringify(message)).not.toContain("secret original text");
  });

  it("keeps sibling Slack window bytes stable when one stored message gains a reaction", async () => {
    materializeSlackMock.mockImplementation(async (_userId: string, input: any) => ({
      files: input.messages.map((message: any) => ({
        path: `sources/slack/engineering-channel-abc/sessions/${message.ts}.md`,
        content: message.text,
      })),
      threads: { writtenPaths: [], crumbsSkipped: 0 },
      sessions: {
        writtenPaths: input.messages.map((message: any) => `sources/slack/engineering-channel-abc/sessions/${message.ts}.md`),
        crumbsSkipped: 0,
      },
    }));
    executeMock
      .mockResolvedValueOnce([
        slackBackfillRow("1719792000.000000", "first"),
        slackBackfillRow("1719813660.000000", "second"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        slackBackfillRow("1719792000.000000", "first", [{ name: "thumbsup", count: 1, users: ["U1"] }]),
        slackBackfillRow("1719813660.000000", "second"),
      ])
      .mockResolvedValueOnce([{ id: "U1", name: "Alex" }]);

    const before = await mirrorSlackChannelWindows("u1", "C123");
    const after = await mirrorSlackChannelWindows("u1", "C123");

    expect(after.files[0]?.content).not.toBe(before.files[0]?.content);
    expect(after.files[1]?.content).toBe(before.files[1]?.content);
  });
});

function notionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    page_id: "page-123",
    title: "Customer Notes",
    url: "https://notion.so/page-123",
    parent_type: "workspace",
    parent_id: "workspace-1",
    data_source_id: "data-source-1",
    overview: "Stored overview.",
    section_summaries: {},
    content_hash: "stored-page-hash",
    last_edited_time: "2026-06-25T13:00:00.000Z",
    markdown_truncated: false,
    ...overrides,
  };
}

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [];
  });
}

function slackBackfillRow(
  ts: string,
  text: string,
  reactions: Array<{ name: string; count: number; users: string[] }> | null = null,
) {
  return {
    ts,
    source_event_id: `slack:C123:${ts}`,
    text,
    deleted: false,
    sender_name: "Alex",
    sender_handle: "U1",
    thread_ts: null,
    channel_name: "engineering",
    reactions,
    mentions: null,
  };
}
