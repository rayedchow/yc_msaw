import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { fetchAndMaterializeNotionPageContentSourceWiki } from "../integrations/notion/source-wiki.js";
import { mapWithConcurrency, parseConcurrencyEnv } from "../lib/concurrency.js";
import { normalizeSlackText, renderSlackReactions, type SlackUserDirectory } from "./slack-text.js";
import { foldSlackWindowRows, slackWindowFoldColumns } from "./slack-fold.js";
import {
  materializeCalendarEventSourceWiki,
  materializeGmailMessageSourceWiki,
  materializeGoogleDocSourceWiki,
  materializeGranolaMeetingSourceWiki,
  materializeNotionPageSourceWiki,
  materializeSourceWikiIndexes,
  type GoogleDocTabContent,
  type GoogleDocTabSummary,
  type NotionSectionSummary,
  type SlackMirrorMessage,
  type SlackWindowMaterializeResult,
} from "./materializer.js";

const SOURCE_WIKI_BACKFILL_CONCURRENCY = parseConcurrencyEnv("SOURCE_WIKI_BACKFILL_CONCURRENCY", 8, { max: 10 });

export const SOURCE_WIKI_BACKFILL_SOURCES = [
  "gmail",
  "calendar",
  "imessage",
  "google-docs",
  "notion",
  "granola",
  "slack",
] as const;

export type SourceWikiBackfillSource = (typeof SOURCE_WIKI_BACKFILL_SOURCES)[number];

export type SourceWikiBackfillResult = {
  userId: string;
  sources: SourceWikiBackfillSource[];
  gmail: SourceWikiBackfillCount;
  calendar: SourceWikiBackfillCount;
  imessage: SourceWikiBackfillCount;
  googleDocs: SourceWikiBackfillCount;
  notion: SourceWikiBackfillCount;
  granola: SourceWikiBackfillCount;
  slack: SourceWikiBackfillCount;
  indexes: number;
};

export type SourceWikiBackfillCount = {
  rows: number;
  files: number;
};

type BackfillOptions = {
  userId: string;
  sources?: SourceWikiBackfillSource[];
  limitPerSource?: number | null;
};

type GoogleDocSummaryRow = {
  doc_id: string;
  title: string;
  overview: string;
  tab_summaries: Record<string, GoogleDocTabSummary> | GoogleDocTabSummary[] | null;
  last_updated: string | Date | null;
};

type NotionPageSummaryRow = {
  page_id: string;
  title: string;
  url: string | null;
  parent_type: string | null;
  parent_id: string | null;
  data_source_id: string | null;
  overview: string;
  section_summaries: Record<string, NotionSectionSummary> | NotionSectionSummary[] | null;
  content_hash: string | null;
  last_edited_time: string | Date | null;
  markdown_truncated: boolean | null;
};

type GranolaEventRow = {
  id: string;
  source_event_id: string;
  timestamp: string | Date | null;
  raw_payload: Record<string, unknown> | null;
};

export async function backfillSourceWikiMirror(options: BackfillOptions): Promise<SourceWikiBackfillResult> {
  const sources = options.sources?.length ? options.sources : [...SOURCE_WIKI_BACKFILL_SOURCES];
  const limitPerSource = options.limitPerSource && options.limitPerSource > 0
    ? Math.floor(options.limitPerSource)
    : null;

  const result: SourceWikiBackfillResult = {
    userId: options.userId,
    sources,
    gmail: { rows: 0, files: 0 },
    calendar: { rows: 0, files: 0 },
    imessage: { rows: 0, files: 0 },
    googleDocs: { rows: 0, files: 0 },
    notion: { rows: 0, files: 0 },
    granola: { rows: 0, files: 0 },
    slack: { rows: 0, files: 0 },
    indexes: 0,
  };

  await Promise.all([
    sources.includes("gmail")
      ? backfillGmail(options.userId, limitPerSource).then((count) => { result.gmail = count; })
      : Promise.resolve(),
    sources.includes("calendar")
      ? backfillCalendar(options.userId, limitPerSource).then((count) => { result.calendar = count; })
      : Promise.resolve(),
    sources.includes("imessage")
      ? backfillImessage(options.userId, limitPerSource).then((count) => { result.imessage = count; })
      : Promise.resolve(),
    sources.includes("google-docs")
      ? backfillGoogleDocs(options.userId, limitPerSource).then((count) => { result.googleDocs = count; })
      : Promise.resolve(),
    sources.includes("notion")
      ? backfillNotion(options.userId, limitPerSource).then((count) => { result.notion = count; })
      : Promise.resolve(),
    sources.includes("granola")
      ? backfillGranola(options.userId, limitPerSource).then((count) => { result.granola = count; })
      : Promise.resolve(),
    sources.includes("slack")
      ? backfillSlack(options.userId, limitPerSource).then((count) => { result.slack = count; })
      : Promise.resolve(),
  ]);

  result.indexes = (await materializeSourceWikiIndexes(options.userId)).length;
  return result;
}

type GmailEventRow = {
  id: string;
  source_event_id: string;
  timestamp: string | Date | null;
  raw_payload: Record<string, unknown> | null;
};

async function backfillGmail(userId: string, limitPerSource: number | null): Promise<SourceWikiBackfillCount> {
  const rows = rowsFromExecute<GmailEventRow>(await db.execute(sql`
    SELECT id, source_event_id, "timestamp", raw_payload
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'gmail'
      AND raw_payload->>'bodySource' IS NOT NULL
      AND COALESCE(raw_payload->>'_deleted', 'false') <> 'true'
    ORDER BY "timestamp" DESC, id ASC
    ${limitSql(limitPerSource)}
  `));

  const filesByRow = await mapWithConcurrency(rows, SOURCE_WIKI_BACKFILL_CONCURRENCY, async (row) => {
    const materialized = await materializeGmailMessageSourceWiki(userId, {
      eventId: row.id,
      sourceEventId: row.source_event_id,
      timestamp: row.timestamp,
      rawPayload: row.raw_payload ?? {},
    }, { refreshIndexes: false });
    return materialized ? 1 : 0;
  });
  const files = filesByRow.reduce((sum: number, count: number) => sum + count, 0);
  return { rows: rows.length, files };
}

type ImessageGroupRow = { conv: string; month: string; chat_name: string | null; n: number };
type ImessageMessageRow = {
  timestamp: string | Date;
  text: string | null;
  sender_name: string | null;
  sender_handle: string | null;
  is_from_me: boolean | null;
  reaction: string | null;
  has_attachments: boolean | null;
};

type SlackMessageRow = {
  ts: string | null;
  source_event_id: string | null;
  text: string | null;
  deleted: boolean;
  sender_name: string | null;
  sender_handle: string | null;
  thread_ts: string | null;
  channel_name: string | null;
  reactions: unknown;
  mentions: unknown;
};

type SlackDirectoryRow = {
  id: string | null;
  name: string | null;
};

export async function mirrorSlackChannelWindows(
  userId: string,
  channelId: string,
  channelName?: string | null,
): Promise<SlackWindowMaterializeResult> {
  const { materializeSlackWindowSourceWiki } = await import("./materializer.js");
  // SOURCE-LANE PATCH (slack request 1): current state, the ledger folded per row (slack-fold.ts); raw rows are unchanged.
  const rows = foldSlackWindowRows(rowsFromExecute<SlackMessageRow & { fold_base?: unknown; fold_ledger?: unknown }>(await db.execute(sql`
    SELECT
      raw_payload->>'ts' AS ts,
      source_event_id,
      raw_payload->>'text' AS text,
      raw_payload->>'_deleted' = 'true' AS deleted,
      raw_payload->>'_user_name' AS sender_name,
      raw_payload->>'user' AS sender_handle,
      COALESCE(raw_payload->>'_thread_ts', raw_payload->>'thread_ts') AS thread_ts,
      raw_payload->>'_channel_name' AS channel_name,
      raw_payload->'reactions' AS reactions,
      raw_payload->'_mentions' AS mentions,
      ${slackWindowFoldColumns()}
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'slack'
      AND raw_payload->>'_channel' = ${channelId}
      AND event_type = 'message'
      AND COALESCE(raw_payload->>'_ledger', '') <> 'true'
      AND (
        COALESCE(raw_payload->>'text', '') <> ''
        OR raw_payload->>'_deleted' = 'true'
      )
    ORDER BY "timestamp" ASC, source_event_id ASC
  `)));
  const fallbackDirectory = slackWorkspaceFallbackDirectory(rowsFromExecute<SlackDirectoryRow>(await db.execute(sql`
    SELECT DISTINCT ON (raw_payload->>'user')
      raw_payload->>'user' AS id,
      raw_payload->>'_user_name' AS name
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'slack'
      AND COALESCE(raw_payload->>'user', '') <> ''
      AND COALESCE(raw_payload->>'_user_name', '') <> ''
    ORDER BY raw_payload->>'user', "timestamp" DESC, source_event_id DESC
  `)));

  return materializeSlackWindowSourceWiki(userId, {
    channelId,
    channelName: channelName ?? rows.find((row) => row.channel_name)?.channel_name ?? null,
    messages: dedupeSlackMessages(rows
      .map((row) => slackRowToMessage(row, fallbackDirectory))
      .filter((message): message is SlackMirrorMessage => message !== null)),
  }, { refreshIndexes: false });
}

function slackRowToMessage(row: SlackMessageRow, fallbackDirectory: SlackUserDirectory): SlackMirrorMessage | null {
  if (!row.ts) return null;
  const directory = overlaySlackMentionDirectory(fallbackDirectory, row.mentions);
  const text = row.deleted ? "[deleted]" : row.text ? normalizeSlackText(row.text, directory) : row.text;
  const reactions = renderSlackReactions(parseSlackReactions(row.reactions), directory);
  return {
    ts: row.ts,
    sourceEventId: row.source_event_id,
    text: text && reactions ? `${text} ${reactions}` : text,
    senderName: row.sender_name,
    senderHandle: row.sender_handle,
    threadTs: row.thread_ts,
  };
}

function slackWorkspaceFallbackDirectory(rows: SlackDirectoryRow[]): Map<string, string> {
  const directory = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.id === "string" && row.id && typeof row.name === "string" && row.name) {
      directory.set(row.id, row.name);
    }
  }
  return directory;
}

function overlaySlackMentionDirectory(fallbackDirectory: SlackUserDirectory, mentions: unknown): Map<string, string> {
  const directory = new Map(fallbackDirectory);
  if (!mentions || typeof mentions !== "object" || Array.isArray(mentions)) return directory;
  for (const [id, name] of Object.entries(mentions)) {
    if (typeof name === "string" && name.trim()) {
      directory.set(id, name.trim());
    }
  }
  return directory;
}

function parseSlackReactions(value: unknown): Array<{ name: string; users: string[]; count: number }> | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((reaction) => {
    if (!reaction || typeof reaction !== "object") return [];
    const candidate = reaction as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const count = typeof candidate.count === "number" ? candidate.count : Number(candidate.count);
    const users = Array.isArray(candidate.users)
      ? candidate.users.filter((user): user is string => typeof user === "string")
      : [];
    if (!name || !Number.isFinite(count) || users.length === 0) return [];
    return [{ name, users, count }];
  });
}

function dedupeSlackMessages(messages: SlackMirrorMessage[]): SlackMirrorMessage[] {
  const byTs = new Map<string, SlackMirrorMessage>();
  for (const message of messages) {
    const ts = slackTsKey(message.ts);
    const existing = byTs.get(ts);
    if (!existing) {
      byTs.set(ts, message);
      continue;
    }
    if (!existing.threadTs && message.threadTs) {
      byTs.set(ts, message);
    }
  }
  return [...byTs.values()];
}

function slackTsKey(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

type SlackChannelGroupRow = {
  channel_id: string;
  channel_name: string | null;
  n: number;
};

async function backfillSlack(userId: string, limitPerSource: number | null): Promise<SourceWikiBackfillCount> {
  const groups = rowsFromExecute<SlackChannelGroupRow>(await db.execute(sql`
    SELECT
      raw_payload->>'_channel' AS channel_id,
      max(raw_payload->>'_channel_name') AS channel_name,
      count(*)::int AS n
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'slack'
      AND event_type = 'message'
      AND COALESCE(raw_payload->>'_channel', '') <> ''
      AND COALESCE(raw_payload->>'_ledger', '') <> 'true'
    GROUP BY 1
    ORDER BY 3 DESC, 1 ASC
    ${limitSql(limitPerSource)}
  `));

  const filesByChannel = await mapWithConcurrency(groups, SOURCE_WIKI_BACKFILL_CONCURRENCY, async (group) => {
    const materialized = await mirrorSlackChannelWindows(userId, group.channel_id, group.channel_name);
    return materialized.files.length;
  });
  return {
    rows: groups.reduce((sum, group) => sum + Number(group.n ?? 0), 0),
    files: filesByChannel.reduce((sum, count) => sum + count, 0),
  };
}

/**
 * Rewrite the mirror file for one (conversation, month) from the full set of
 * that month's stored messages. Shared by the backfill lane and the live
 * ingest hook.
 */
export async function mirrorImessageConversationMonth(
  userId: string,
  conversationId: string,
  monthKey: string,
  chatName: string | null,
): Promise<boolean> {
  const { materializeImessageMonthSourceWiki } = await import("./materializer.js");
  const messages = rowsFromExecute<ImessageMessageRow>(await db.execute(sql`
    SELECT
      "timestamp",
      raw_payload->>'text' AS text,
      raw_payload->>'_resolved_name' AS sender_name,
      raw_payload->>'_sender_handle' AS sender_handle,
      (raw_payload->>'_is_from_me')::boolean AS is_from_me,
      raw_payload->>'reaction' AS reaction,
      (raw_payload->>'_has_attachments')::boolean AS has_attachments
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'imessage'
      AND raw_payload->>'_normalized_conversation_id' = ${conversationId}
      AND to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM') = ${monthKey}
    ORDER BY "timestamp" ASC
  `));
  const materialized = await materializeImessageMonthSourceWiki(userId, {
    conversationId,
    conversationName: chatName,
    monthKey,
    messages: messages.map((row) => ({
      timestamp: row.timestamp,
      text: row.text,
      senderName: row.sender_name,
      senderHandle: row.sender_handle,
      isFromMe: row.is_from_me,
      reaction: row.reaction,
      hasAttachments: row.has_attachments,
    })),
  }, { refreshIndexes: false });
  return materialized !== null;
}

async function backfillImessage(userId: string, limitPerSource: number | null): Promise<SourceWikiBackfillCount> {
  // Group pass first: one file per (conversation, month); per-message files
  // at iMessage volume would sink the sandbox snapshot.
  const groups = rowsFromExecute<ImessageGroupRow>(await db.execute(sql`
    SELECT
      raw_payload->>'_normalized_conversation_id' AS conv,
      to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
      max(raw_payload->>'_chat_name') AS chat_name,
      count(*)::int AS n
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'imessage'
      AND raw_payload->>'_normalized_conversation_id' IS NOT NULL
      AND COALESCE(raw_payload->>'text', '') <> ''
    GROUP BY 1, 2
    ORDER BY 2 DESC, 4 DESC
    ${limitSql(limitPerSource)}
  `));

  const filesByGroup = await mapWithConcurrency(groups, SOURCE_WIKI_BACKFILL_CONCURRENCY, async (group) => {
    const materialized = await mirrorImessageConversationMonth(userId, group.conv, group.month, group.chat_name);
    return materialized ? 1 : 0;
  });
  const files = filesByGroup.reduce((sum: number, count: number) => sum + count, 0);
  return { rows: groups.reduce((sum, group) => sum + Number(group.n ?? 0), 0), files };
}

type CalendarSnapshotRow = {
  calendar_id: string;
  event_id: string;
  summary: string | null;
  status: string | null;
  event_type: string | null;
  start: unknown;
  end: unknown;
  source_updated_at: string | Date | null;
  raw_payload: Record<string, unknown> | null;
};

async function backfillCalendar(userId: string, limitPerSource: number | null): Promise<SourceWikiBackfillCount> {
  const rows = rowsFromExecute<CalendarSnapshotRow>(await db.execute(sql`
    SELECT calendar_id, event_id, summary, status, event_type, "start", "end", source_updated_at, raw_payload
    FROM google_calendar_event_snapshots
    WHERE user_id = ${userId}
    ORDER BY source_updated_at DESC NULLS LAST, event_id ASC
    ${limitSql(limitPerSource)}
  `));

  const filesByRow = await mapWithConcurrency(rows, SOURCE_WIKI_BACKFILL_CONCURRENCY, async (row) => {
    const materialized = await materializeCalendarEventSourceWiki(userId, {
      calendarId: row.calendar_id,
      eventId: row.event_id,
      summary: row.summary,
      status: row.status,
      eventType: row.event_type,
      start: row.start,
      end: row.end,
      sourceUpdatedAt: row.source_updated_at,
      rawPayload: row.raw_payload ?? {},
    }, { refreshIndexes: false });
    return materialized ? 1 : 0;
  });
  const files = filesByRow.reduce((sum: number, count: number) => sum + count, 0);
  return { rows: rows.length, files };
}

type GoogleDocTabSnapshotRow = {
  tab_id: string;
  revision_id: string;
  title: string;
  content: {
    content?: string;
    suggestions?: GoogleDocTabContent["suggestions"];
    suggestionsAccessible?: boolean;
    authorEmail?: string;
    authorName?: string;
    updatedByEmail?: string;
  } | null;
  captured_at: string | Date;
};

async function loadLatestGoogleDocTabSnapshots(userId: string, docId: string): Promise<GoogleDocTabSnapshotRow[]> {
  // SOURCE-LANE PATCH (google-docs request 1): render only the tabs of the latest captured revision, so a tab
  // deleted in a later revision is not resurrected from an older one (every revision's tabs are written in one
  // transaction by content-snapshot.ts).
  return rowsFromExecute<GoogleDocTabSnapshotRow>(await db.execute(sql`
    SELECT tab_id, revision_id, title, content, captured_at
    FROM google_doc_tab_snapshots
    WHERE user_id = ${userId}
      AND doc_id = ${docId}
      AND revision_id = (
        SELECT latest.revision_id FROM google_doc_tab_snapshots latest
        WHERE latest.user_id = ${userId} AND latest.doc_id = ${docId}
        ORDER BY latest.captured_at DESC, latest.revision_id DESC
        LIMIT 1
      )
    ORDER BY tab_id ASC
  `));
}

async function backfillGoogleDocs(userId: string, limitPerSource: number | null): Promise<SourceWikiBackfillCount> {
  const rows = rowsFromExecute<GoogleDocSummaryRow>(await db.execute(sql`
    SELECT doc_id, title, overview, tab_summaries, last_updated
    FROM document_summaries
    WHERE user_id = ${userId}
      AND (COALESCE(overview, '') <> '' OR tab_summaries <> '{}'::jsonb)
      -- SOURCE-LANE PATCH (google-docs request 1): trashed/removed docs stay tombstoned.
      AND NOT EXISTS (
        SELECT 1 FROM gdocs_file_checkpoints c
        WHERE c.tenant_id = document_summaries.user_id
          AND c.file_id = document_summaries.doc_id
          AND c.lifecycle_state <> 'active'
      )
    ORDER BY last_updated DESC, doc_id ASC
    ${limitSql(limitPerSource)}
  `));

  // Tab content renders from capture-time rows in google_doc_tab_snapshots
  // (reshape is a DB operation, never a provider re-fetch). The live Docs
  // fetch survives only as a self-healing fallback for docs that predate the
  // snapshot table: fetch once THROUGH the capture path (snapshotDocContent
  // persists the snapshot rows + image bytes), then render from the table.
  // SOURCE_WIKI_GDOCS_CONTENT_FETCH_LIMIT caps only that fallback path; rows
  // are last_updated DESC so the budget goes to the most recent docs first.
  const contentFetchLimit = Math.max(0, Math.floor(Number(process.env.SOURCE_WIKI_GDOCS_CONTENT_FETCH_LIMIT ?? 25)));
  let fallbackFetches = 0;
  const filesByRow = await mapWithConcurrency(rows, SOURCE_WIKI_BACKFILL_CONCURRENCY, async (row) => {
    let snapshots = await loadLatestGoogleDocTabSnapshots(userId, row.doc_id);
    if (snapshots.length === 0 && fallbackFetches < contentFetchLimit) {
      fallbackFetches += 1;
      try {
        const { snapshotDocContent } = await import("../integrations/google/gdocs/content-snapshot.js");
        await snapshotDocContent(userId, row.doc_id);
        snapshots = await loadLatestGoogleDocTabSnapshots(userId, row.doc_id);
      } catch {
        snapshots = [];
      }
    }
    const tabContents = snapshots.length > 0
      ? snapshots.map((snapshot) => ({
        tabId: snapshot.tab_id,
        tabName: snapshot.title,
        revisionId: snapshot.revision_id,
        content: typeof snapshot.content?.content === "string" ? snapshot.content.content : "",
        suggestions: snapshot.content?.suggestions ?? [],
        suggestionsAccessible: snapshot.content?.suggestionsAccessible !== false,
      }))
      : null;
    const latestSnapshot = snapshots.reduce<GoogleDocTabSnapshotRow | null>((latest, snapshot) => (
      !latest || new Date(String(snapshot.captured_at)) > new Date(String(latest.captured_at)) ? snapshot : latest
    ), null);
    const materialized = await materializeGoogleDocSourceWiki({
      userId,
      docId: row.doc_id,
      title: row.title,
      overview: row.overview,
      tabSummaries: row.tab_summaries,
      tabContents,
      // Every snapshot-backed tab carries its own revisionId above. Do not
      // apply one latest document revision to a summary-only/legacy tab whose
      // backing snapshot is unknown.
      revisionId: null,
      // Envelope authorship from the capture-time snapshot rows - reshape is
      // a DB operation, never a provider re-fetch; absent when the capture
      // predates identity threading.
      authorEmail: latestSnapshot?.content?.authorEmail ?? null,
      authorName: latestSnapshot?.content?.authorName ?? null,
      updatedByEmail: latestSnapshot?.content?.updatedByEmail ?? null,
      // raw.md is only writable at capture time (the snapshot table has no
      // raw JSON); never sweep away a capture-written raw.md from here.
      preserveExistingRawFile: true,
      lastUpdated: row.last_updated,
      refreshIndexes: false,
    });
    return materialized.length;
  });
  const files = filesByRow.reduce((sum, count) => sum + count, 0);
  return { rows: rows.length, files };
}

async function backfillNotion(userId: string, limitPerSource: number | null): Promise<SourceWikiBackfillCount> {
  const rows = rowsFromExecute<NotionPageSummaryRow>(await db.execute(sql`
    SELECT
      page_id, title, url, parent_type, parent_id, data_source_id,
      overview, section_summaries, content_hash, last_edited_time, markdown_truncated
    FROM notion_page_summaries
    WHERE user_id = ${userId}
    ORDER BY COALESCE(last_edited_time, updated_at) DESC, page_id ASC
    ${limitSql(limitPerSource)}
  `));

  const filesByRow = await mapWithConcurrency(rows, SOURCE_WIKI_BACKFILL_CONCURRENCY, async (row) => {
    const materialized = await materializeNotionBackfillRow(userId, row);
    return materialized.length;
  });
  const files = filesByRow.reduce((sum, count) => sum + count, 0);
  return { rows: rows.length, files };
}

async function materializeNotionBackfillRow(userId: string, row: NotionPageSummaryRow) {
  try {
    return await fetchAndMaterializeNotionPageContentSourceWiki({
      userId,
      pageId: row.page_id,
      overview: row.overview,
      sectionSummaries: row.section_summaries,
      refreshIndexes: false,
    });
  } catch {
    return materializeNotionStoredSummarySourceWiki(userId, row);
  }
}

function materializeNotionStoredSummarySourceWiki(userId: string, row: NotionPageSummaryRow) {
  return materializeNotionPageSourceWiki({
    userId,
    pageId: row.page_id,
    title: row.title,
    url: row.url,
    parentType: row.parent_type,
    parentId: row.parent_id,
    dataSourceId: row.data_source_id,
    overview: row.overview,
    sectionSummaries: row.section_summaries,
    contentHash: row.content_hash,
    lastEditedTime: row.last_edited_time,
    markdownTruncated: row.markdown_truncated ?? false,
    refreshIndexes: false,
  });
}

async function backfillGranola(userId: string, limitPerSource: number | null): Promise<SourceWikiBackfillCount> {
  // SOURCE-LANE PATCH (granola request 1): render each note's current state
  // only - its latest snapshot (provider updated_at, then capture order; the
  // rule of granola_source_notes, drizzle/9500) - and skip notes whose newest
  // observation is a deletion tombstone. Rendering every revision concurrently
  // left an arbitrary revision as the projection and resurrected deleted notes.
  // Granola fidelity P1: a note with only the user's typed notes is rendered too.
  const rows = rowsFromExecute<GranolaEventRow>(await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (source_object_id) id, source_object_id, source_event_id, "timestamp", raw_payload, created_at
      FROM activity_events
      WHERE user_id = ${userId}
        AND source = 'granola'
        AND event_type = 'meeting_note'
      ORDER BY source_object_id, source_updated_at DESC NULLS LAST, created_at DESC, id DESC
    ), deleted AS (
      SELECT source_object_id, max(created_at) AS deleted_at
      FROM activity_events
      WHERE user_id = ${userId}
        AND source = 'granola'
        AND event_type = 'meeting_note.deleted'
      GROUP BY source_object_id
    )
    SELECT l.id, l.source_event_id, l."timestamp", l.raw_payload
    FROM latest l
    LEFT JOIN deleted d ON d.source_object_id = l.source_object_id
    WHERE (d.deleted_at IS NULL OR d.deleted_at < l.created_at)
      AND (
        COALESCE(l.raw_payload->>'summaryMarkdown', '') <> ''
        OR COALESCE(l.raw_payload->>'summaryText', '') <> ''
        OR jsonb_typeof(l.raw_payload->'transcript') = 'array'
        OR COALESCE(l.raw_payload->>'notes_markdown', l.raw_payload->>'notes_plain', l.raw_payload->>'notesMarkdown', l.raw_payload->>'notesPlain', '') <> ''
      )
    ORDER BY l."timestamp" DESC, l.id ASC
    ${limitSql(limitPerSource)}
  `));

  const filesByRow = await mapWithConcurrency(rows, SOURCE_WIKI_BACKFILL_CONCURRENCY, async (row) => {
    const materialized = await materializeGranolaMeetingSourceWiki(userId, {
      eventId: row.id,
      sourceEventId: row.source_event_id,
      timestamp: row.timestamp,
      rawPayload: row.raw_payload ?? {},
    }, { refreshIndexes: false });
    return materialized.length;
  });
  const files = filesByRow.reduce((sum, count) => sum + count, 0);
  return { rows: rows.length, files };
}


function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function limitSql(limitPerSource: number | null) {
  return limitPerSource ? sql`LIMIT ${limitPerSource}` : sql``;
}
