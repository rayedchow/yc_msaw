import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  enqueueGraphDeleteForMirrorFile,
  enqueueGraphIngestForMirrorFile,
  graphIngestEnabled,
} from "../graph/wiring/ingest-hook.js";
import { assembleSessionWindows, type SessionMessage } from "../graph/bridge/session-windows.js";
import { redactEphemeralUris } from "../vault/redaction.js";

export { redactEphemeralUris } from "../vault/redaction.js";
import { adfToMarkdown } from "../integrations/atlassian/adf.js";
import { storageFormatToMarkdown } from "../integrations/atlassian/storage-format.js";
import { classifyGoogleCalendarParticipant } from "../integrations/google/calendar/common.js";
import { slugify } from "../lib/utils.js";
import {
  emailAliases,
  firstEmail,
  stagedDocumentMeta,
  type StagedDocumentAlias,
  type StagedDocumentMeta,
  type StagedDocumentSourceRef,
} from "./envelope.js";
import { CALCOM_BOOKING_ALIAS_KIND, calcomBookingUid } from "./calcom.js";
import { wikiContentSha } from "./hashes.js";

export type { StagedDocumentMeta } from "./envelope.js";

const SOURCES_ROOT = "sources";
const GOOGLE_DOCS_SOURCE_ROOT = `${SOURCES_ROOT}/google-docs`;
const NOTION_SOURCE_ROOT = `${SOURCES_ROOT}/notion`;
const GRANOLA_SOURCE_ROOT = `${SOURCES_ROOT}/granola`;
const SLACK_SOURCE_ROOT = `${SOURCES_ROOT}/slack`;
const GMAIL_SOURCE_ROOT = `${SOURCES_ROOT}/gmail`;
const CALENDAR_SOURCE_ROOT = `${SOURCES_ROOT}/calendar`;
const JIRA_SOURCE_ROOT = `${SOURCES_ROOT}/jira`;
const CONFLUENCE_SOURCE_ROOT = `${SOURCES_ROOT}/confluence`;
const BITBUCKET_SOURCE_ROOT = `${SOURCES_ROOT}/bitbucket`;
const GITHUB_SOURCE_ROOT = `${SOURCES_ROOT}/github`;
const GITHUB_COMMENT_RENDER_LIMIT = 200;

const GMAIL_BODY_MAX_CHARS = 60_000;
const GMAIL_INDEX_RECENT_MESSAGES = 100;
const BITBUCKET_COMMENTS_MAX = 200;
// Labels whose presence means the message should not exist in the mirror.
const GMAIL_EXCLUDED_LABELS = new Set(["SPAM", "TRASH"]);

const SOURCE_PROVIDER_DEFINITIONS = [
  {
    key: "gmail",
    title: "Gmail",
    root: GMAIL_SOURCE_ROOT,
    description: "Full email messages mirrored from the connected Gmail account, one file per message.",
  },
  {
    key: "calendar",
    title: "Google Calendar",
    root: CALENDAR_SOURCE_ROOT,
    description: "Calendar events mirrored one file per event, dated by start time.",
  },
  {
    key: "imessage",
    title: "iMessage",
    root: `${SOURCES_ROOT}/imessage`,
    description: "iMessage conversations mirrored one chronological file per conversation per month.",
  },
  {
    key: "google-docs",
    title: "Google Docs",
    root: GOOGLE_DOCS_SOURCE_ROOT,
    description: "Document-level and tab-level Google Docs summaries.",
  },
  {
    key: "notion",
    title: "Notion",
    root: NOTION_SOURCE_ROOT,
    description: "Page-level, nested-page, and section-level Notion summaries.",
  },
  {
    key: "granola",
    title: "Granola",
    root: GRANOLA_SOURCE_ROOT,
    description: "Meeting summaries and transcripts from Granola.",
  },
  {
    key: "slack",
    title: "Slack",
    root: SLACK_SOURCE_ROOT,
    description: "Slack conversations mirrored as one chronological channel-day file.",
  },
  {
    key: "jira",
    title: "Jira",
    root: JIRA_SOURCE_ROOT,
    description: "Jira issues mirrored from Nango records, one markdown file per issue.",
  },
  {
    key: "confluence",
    title: "Confluence",
    root: CONFLUENCE_SOURCE_ROOT,
    description: "Confluence pages mirrored from Nango records, one markdown file per page.",
  },
  {
    key: "bitbucket",
    title: "Bitbucket",
    root: BITBUCKET_SOURCE_ROOT,
    description: "Bitbucket issues, pull requests, and repository records mirrored from Nango records.",
  },
  {
    key: "github",
    title: "GitHub",
    root: GITHUB_SOURCE_ROOT,
    description: "GitHub issues, pull requests, and repository records mirrored from Nango records.",
  },
] as const;
const SOURCE_PROVIDERS = SOURCE_PROVIDER_DEFINITIONS;

export type SourceWikiFile = {
  path: string;
  content: string;
  /** Staged-document envelope persisted to mirror_files.meta (absent for generated indexes). */
  meta?: StagedDocumentMeta;
};

export type GoogleDocTabSummary = {
  tabId: string;
  tabName: string;
  summary: string;
  contentHash?: string | null;
};

export type NotionSectionSummary = {
  sectionId: string;
  sectionTitle: string;
  summary: string;
  contentHash?: string | null;
  sectionKind?: string | null;
  anchorBlockId?: string | null;
  rootBlockIds?: string[] | null;
  warningCodes?: string[] | null;
  structuredFacts?: Record<string, unknown> | null;
  sourceContent?: string | null;
};

export type NotionRowPageSource = {
  pageId: string;
  title: string;
  url?: string | null;
  dataSourceId: string;
  dataSourceTitle: string;
  relativePath: string;
  sourceContent: string;
  contentHash?: string | null;
  hasComments?: boolean;
  structuredFacts?: Record<string, unknown> | null;
};

export type NotionChildPageSource = {
  pageId: string;
  title?: string | null;
  url?: string | null;
  parentBlockId?: string | null;
  relativePath: string;
  sourceContent?: string | null;
  contentHash?: string | null;
  hasComments?: boolean;
  structuredFacts?: Record<string, unknown> | null;
  childPages?: NotionChildPageSource[] | null;
};

export type GranolaMeetingSourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  timestamp?: string | Date | null;
  rawPayload: Record<string, unknown>;
};

export type GmailMessageSourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  timestamp?: string | Date | null;
  rawPayload: Record<string, unknown>;
};

export type SlackChannelDayMessage = {
  eventId?: string | null;
  sourceEventId: string;
  eventType: string;
  timestamp: string | Date;
  sourceUpdatedAt?: string | Date | null;
  rawPayload: Record<string, unknown>;
};

export type JiraIssueSourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  connectionId?: string | null;
  rawPayload: Record<string, unknown>;
  /** Exact raw comment rows supplied by fresh capture or a local rebuild. */
  commentSourceEvents?: Array<{ commentId: string; sourceEventId: string }> | null;
};

export type ConfluencePageSourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  rawPayload: Record<string, unknown>;
};

export type BitbucketPullRequestSourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  repoFullName: string;
  pullRequestId: string;
  rawPayload: Record<string, unknown>;
};

export type BitbucketIssueSourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  repoFullName: string;
  issueId: string;
  rawPayload: Record<string, unknown>;
};

export type BitbucketRepositorySourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  repoFullName: string;
  rawPayload: Record<string, unknown>;
};

export type GithubIssueSourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  repoKey: string;
  repoFullName: string;
  number: string;
  rawPayload: Record<string, unknown>;
};

export type GithubPullRequestSourcePayload = GithubIssueSourcePayload;

export type GithubParentSourceRef = {
  kind: "issue" | "pull_request";
  repoFullName: string;
  number: string;
};

export type GithubRepositorySourcePayload = {
  eventId?: string | null;
  sourceEventId: string;
  repoKey: string;
  repoFullName: string;
  rawPayload: Record<string, unknown>;
};

export type GoogleDocTabSuggestion = {
  suggestionId: string;
  insertedText: string;
  deletedText: string;
  /** Base-content snippet before the suggested span (durable placement anchor). */
  contextBefore?: string;
  /** Base-content snippet after the suggested span. */
  contextAfter?: string;
};

export type GoogleDocTabContent = {
  tabId: string;
  tabName?: string | null;
  /** Immutable google_doc_tab_snapshots.revision_id backing this tab. */
  revisionId?: string | null;
  content: string;
  /** Pending (unaccepted) suggested edits captured from SUGGESTIONS_INLINE. */
  suggestions?: GoogleDocTabSuggestion[];
  /**
   * False when the fetch fell back to the preview view because the account
   * lacks permission to view suggested changes (reader-only file role).
   */
  suggestionsAccessible?: boolean;
};

export async function materializeGoogleDocSourceWiki(input: {
  userId: string;
  docId: string;
  title: string;
  overview: string;
  tabSummaries: Record<string, GoogleDocTabSummary> | GoogleDocTabSummary[] | null | undefined;
  /** Actual per-tab document content; when present, tab files render content-first. */
  tabContents?: GoogleDocTabContent[] | null;
  /**
   * The complete `documents.get` JSON - materialized as `raw.md`, the
   * lossless companion to the best-effort markdown tabs. Ephemeral
   * requester-scoped `contentUri` values are redacted before writing.
   */
  rawJson?: unknown;
  lastUpdated?: string | Date | null;
  /** Docs API revisionId behind the tab contents (versionRef for the envelope). */
  revisionId?: string | null;
  /** Doc owner (first Drive owner) - absent for shared-drive files. */
  authorEmail?: string | null;
  authorName?: string | null;
  /** Drive lastModifyingUser email as captured with this content. */
  updatedByEmail?: string | null;
  /**
   * Keep an existing raw.md when this materialization has no rawJson in hand
   * (snapshot-backed renders: the raw JSON is only available at capture time).
   */
  preserveExistingRawFile?: boolean;
  refreshIndexes?: boolean;
}): Promise<SourceWikiFile[]> {
  const directory = googleDocSourceDirectory(input.docId, input.title);
  const summaries = normalizeGoogleDocTabSummaries(input.tabSummaries);
  const contentByTab = new Map((input.tabContents ?? []).map((tab) => [tab.tabId, tab]));
  const summaryByTab = new Map(summaries.map((tab) => [tab.tabId, tab]));
  const tabIds = [...new Set([...summaryByTab.keys(), ...contentByTab.keys()])];
  const tabs = tabIds.map((tabId) => ({
    tabId,
    tabName: summaryByTab.get(tabId)?.tabName
      ?? stringValue(contentByTab.get(tabId)?.tabName)
      ?? tabId,
    summary: summaryByTab.get(tabId)?.summary ?? "",
    contentHash: summaryByTab.get(tabId)?.contentHash ?? null,
  }));
  const revisionId = stringValue(input.revisionId)
    ?? stringValue((objectValue(input.rawJson) ?? {}).revisionId);
  // Access metadata: captured Drive folder lineage plus best-effort Drive
  // permissions principals. Missing permission data is represented by absent
  // readers/writers fields, never by blocking the mirror write.
  const sourceAcl = await googleDocFolderAcl(input.userId, input.docId);
  // Raw mirror: actual tab content only - no generated overview or summaries.
  const files: SourceWikiFile[] = tabs.map((tab) => ({
    path: `${directory}/tabs/${stableEntityPath("tab", tab.tabId)}.md`,
    content: renderGoogleDocTab(input, tab, contentByTab.get(tab.tabId) ?? null),
    meta: googleDocTabMeta(input, tab, contentByTab.get(tab.tabId) ?? null, revisionId, sourceAcl),
  }));
  // Lossless companion: the complete Docs API JSON, wrapped in markdown (the
  // mirror is markdown-only). The per-tab files are a best-effort projection of
  // this; `raw.md` is the faithful source of truth for anything markdown can't
  // represent. The `json` fence is safe - JSON never contains a ``` sequence.
  // One exception to "unmodified": embedded-object `contentUri` values are
  // requester-scoped image-access URLs (whoever reads them can fetch the bytes
  // as the original requester while they're valid) - they must never be
  // persisted. Redacted here; actual image bytes live in google_doc_images.
  if (input.rawJson !== undefined && input.rawJson !== null) {
    files.push({
      path: `${directory}/raw.md`,
      content: [
        "# Raw Google Docs API response (lossless)",
        "",
        "The complete `documents.get` JSON - the faithful source of truth",
        "(ephemeral requester-scoped image `contentUri` values redacted; image",
        "bytes are captured separately). The per-tab markdown files are a",
        "best-effort projection of this.",
        "",
        "```json",
        JSON.stringify(redactEphemeralUris(input.rawJson), null, 2),
        "```",
        "",
      ].join("\n"),
      meta: stagedDocumentMeta({
        provider: "google-docs",
        externalId: input.docId,
        kind: "document",
        title: input.title,
        versionRef: revisionId,
        sourceUpdatedAt: input.lastUpdated,
        authorEmail: input.authorEmail,
        authorName: input.authorName,
        updatedByEmail: input.updatedByEmail,
        sourceAcl,
        aliases: emailAliases(input.authorEmail, input.updatedByEmail),
        sourceRefs: [{
          anchor: "Raw Google Docs API response (lossless)",
          sourceEventId: googleDocSnapshotSourceEventId(input.docId, null, revisionId),
          url: googleDocUrl(input.docId),
        }],
      }),
    });
  }
  await replaceSourceWikiDirectory(input.userId, directory, files, {
    sourceRoot: GOOGLE_DOCS_SOURCE_ROOT,
    entitySuffix: stableEntityPath("doc", input.docId),
  }, {
    keepPaths: input.preserveExistingRawFile && input.rawJson === undefined
      ? [`${directory}/raw.md`]
      : [],
  });
  if (input.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(input.userId, files);
  }
  return files;
}

export async function materializeNotionPageSourceWiki(input: {
  userId: string;
  pageId: string;
  title: string;
  url?: string | null;
  parentType?: string | null;
  parentId?: string | null;
  dataSourceId?: string | null;
  /** Accepted for API-shape compatibility; the raw mirror does not render generated overviews. */
  overview?: string;
  sectionSummaries?: Record<string, NotionSectionSummary> | NotionSectionSummary[] | null;
  sourceMarkdown?: string | null;
  contentHash?: string | null;
  hasComments?: boolean;
  lastEditedTime?: string | Date | null;
  markdownTruncated?: boolean;
  structuredIngestion?: boolean;
  warnings?: Array<{ code?: string; message?: string; blockId?: string | null; type?: string | null }> | null;
  references?: Array<{ kind?: string; targetId?: string | null; title?: string | null; url?: string | null }> | null;
  rowPages?: NotionRowPageSource[] | null;
  childPages?: NotionChildPageSource[] | null;
  refreshIndexes?: boolean;
}): Promise<SourceWikiFile[]> {
  const directory = notionPageSourceDirectory(input.pageId, input.title);
  const rowPages = normalizeNotionRowPages(input.rowPages);
  const childPages = normalizeNotionChildPages(input.childPages);
  const allSections = normalizeNotionSectionSummaries(input.sectionSummaries);
  const sections = allSections.filter((section) => section.sectionKind !== "database_row_page");
  void sections;
  // Raw mirror: actual page content and nested pages only - no generated
  // overview, section summaries, or structured-fact dumps.
  const files: SourceWikiFile[] = [
    ...(stringValue(input.sourceMarkdown)
      ? [
        {
          path: `${directory}/content.md`,
          content: renderNotionPageContentFile(input),
          meta: stagedDocumentMeta({
            provider: "notion",
            externalId: input.pageId,
            kind: "document",
            title: input.title,
            versionRef: input.contentHash,
            sourceUpdatedAt: input.lastEditedTime,
            sourceAcl: {
              parentType: input.parentType ?? null,
              parentId: input.parentId ?? null,
              dataSourceId: input.dataSourceId ?? null,
            },
            sourceRefs: notionProjectionSourceRefs({
              anchor: "Processed Markdown",
              contentHash: input.contentHash,
              hasComments: input.hasComments,
              url: input.url,
            }),
          }),
        },
      ]
      : []),
    ...rowPages.map((rowPage) => ({
      path: `${directory}/${rowPage.relativePath}`,
      content: renderNotionRowPageSourceFile(rowPage),
      meta: stagedDocumentMeta({
        provider: "notion",
        externalId: rowPage.pageId,
        kind: "document",
        title: rowPage.title,
        versionRef: rowPage.contentHash,
        sourceAcl: { parentType: "data_source_id", parentId: rowPage.dataSourceId },
        sourceRefs: notionProjectionSourceRefs({
          anchor: "Source Metadata",
          contentHash: rowPage.contentHash,
          hasComments: rowPage.hasComments,
          url: rowPage.url,
        }),
      }),
    })),
    ...childPages.map((childPage) => ({
      path: `${directory}/${childPage.relativePath}`,
      content: renderNotionChildPageSourceFile(childPage),
      meta: stagedDocumentMeta({
        provider: "notion",
        externalId: childPage.pageId,
        kind: "document",
        title: childPage.title,
        versionRef: childPage.contentHash,
        sourceAcl: {
          parentType: "page_id",
          parentId: input.pageId,
          parentBlockId: childPage.parentBlockId ?? null,
        },
        sourceRefs: notionProjectionSourceRefs({
          anchor: "Source Metadata",
          contentHash: childPage.contentHash,
          hasComments: childPage.hasComments,
          url: childPage.url,
        }),
      }),
    })),
  ];
  await replaceSourceWikiDirectory(input.userId, directory, files, {
    sourceRoot: NOTION_SOURCE_ROOT,
    entitySuffix: stableEntityPath("page", input.pageId),
  });
  if (input.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(input.userId, files);
  }
  return files;
}

export async function materializeGranolaMeetingSourceWiki(
  userId: string,
  input: GranolaMeetingSourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile[]> {
  const meetingId = stringValue(input.rawPayload.granolaId)
    ?? input.sourceEventId.replace(/^granola:/, "")
    ?? input.sourceEventId;
  const title = stringValue(input.rawPayload.title) ?? meetingId;
  const directory = granolaMeetingSourceDirectory(meetingId, title);
  const granolaMeta = (anchor: string): StagedDocumentMeta => granolaMeetingMeta(input, meetingId, title, anchor);
  const files: SourceWikiFile[] = [
    {
      path: `${directory}/summary.md`,
      content: renderGranolaSummary(input),
      meta: granolaMeta("Summary"),
    },
    {
      path: `${directory}/transcript.md`,
      content: renderGranolaTranscript(input),
      meta: { ...granolaMeta("Transcript"), kind: "transcript" },
    },
  ];
  await replaceSourceWikiDirectory(userId, directory, files, {
    sourceRoot: GRANOLA_SOURCE_ROOT,
    entitySuffix: stableEntityPath("meeting", meetingId),
  });
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, files);
  }
  return files;
}

export async function materializeJiraIssueSourceWiki(
  userId: string,
  input: JiraIssueSourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const payload = input.rawPayload;
  const issueId = stringValue(payload.id) ?? stringValue(payload.issueId);
  const key = jiraIssueKey(payload);
  if (!key) return null;
  if (payload.deleted === true || payload._deleted === true || isDeletedNangoPayload(payload)) {
    await deleteJiraIssueSourceWiki(userId, key, { refreshIndexes: options.refreshIndexes });
    return null;
  }

  const projectKey = jiraProjectKey(payload, key);
  const fields = objectValue(payload.fields);
  const commentSourceEvents = new Map(
    (input.commentSourceEvents ?? []).map(({ commentId, sourceEventId }) => [commentId, sourceEventId]),
  );
  const file: SourceWikiFile = {
    path: `${JIRA_SOURCE_ROOT}/${atlassianPathSegment(projectKey, "UNKNOWN")}/${atlassianPathSegment(key, "UNKNOWN")}.md`,
    content: renderJiraIssue(input, key, projectKey, issueId),
    meta: stagedDocumentMeta({
      provider: "jira",
      // Native numeric issue id survives renames/moves; the key does not
      // (it lives in aliases). Key is the last resort when id is absent.
      externalId: issueId ?? key,
      kind: "document",
      title: `${key}: ${stringValue(payload.summary) ?? stringValue(fields?.summary) ?? key}`,
      // Raw version-append keys jira issues on the updated stamp (§3).
      versionRef: dateText(payload.updated_at ?? payload.updatedAt ?? fields?.updated),
      sourceUpdatedAt: dateText(payload.updated_at ?? payload.updatedAt ?? fields?.updated),
      authorEmail: jiraPersonEmail(payload.reporter ?? fields?.reporter),
      authorName: jiraPersonName(payload.reporter ?? fields?.reporter),
      updatedByEmail: jiraUpdatedByEmail(payload),
      sourceAcl: {
        projectKey,
        cloudId: stringValue(payload.cloudId) ?? stringValue(payload.cloud_id) ?? null,
      },
      aliases: [
        { kind: "jira_key", value: key },
        ...emailAliases(
          jiraPersonEmail(payload.assignee ?? fields?.assignee),
          jiraPersonEmail(payload.reporter ?? fields?.reporter),
        ),
      ],
      sourceRefs: [
        {
          anchor: "Description",
          sourceEventId: input.sourceEventId,
          url: stringValue(payload.url)
            ?? stringValue(payload.webUrl)
            ?? stringValue(payload.web_url)
            ?? stringValue(payload.html_url)
            ?? undefined,
        },
        ...jiraComments(payload).map((comment, index) => jiraCommentSourceRef(
          comment,
          index,
          commentSourceEvents.get(stringValue(comment.id) ?? ""),
        )),
      ],
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

type JiraCapturedEventRow = {
  id: string | number;
  event_type: string;
  source_event_id: string;
  raw_payload: unknown;
  timestamp?: string | Date | null;
  source_updated_at?: string | Date | null;
};

/**
 * Rebuild an issue mirror after an independently captured Jira comment. The
 * raw ledger already holds both inputs, so no provider refetch is needed when
 * an Issue/IssueDetail record for the parent has previously been captured.
 */
export async function rematerializeJiraIssueFromCapturedComments(
  userId: string,
  ref: { issueId: string | null; issueKey: string | null },
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  if (!ref.issueId && !ref.issueKey) return null;

  const parentRows = rowsFromExecute<JiraCapturedEventRow>(await db.execute(sql`
    SELECT id, event_type, source_event_id, raw_payload, timestamp, source_updated_at
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'jira'
      AND event_type IN ('issue_detail', 'issue')
      AND (
        (${ref.issueId}::text IS NOT NULL AND (raw_payload->>'id' = ${ref.issueId} OR raw_payload->>'issueId' = ${ref.issueId}))
        OR (${ref.issueKey}::text IS NOT NULL AND (raw_payload->>'key' = ${ref.issueKey} OR raw_payload->>'issueKey' = ${ref.issueKey}))
      )
    ORDER BY CASE WHEN event_type = 'issue_detail' THEN 0 ELSE 1 END,
      COALESCE(source_updated_at, timestamp) DESC,
      id DESC
    LIMIT 1
  `));
  const parent = parentRows[0];
  const parentPayload = parent ? jsonPayload(parent.raw_payload) : null;
  if (!parent || !parentPayload) return null;

  const commentRows = rowsFromExecute<JiraCapturedEventRow>(await db.execute(sql`
    SELECT id, event_type, source_event_id, raw_payload, timestamp, source_updated_at
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'jira'
      AND event_type IN ('issue_comment', 'issue_comment.deleted')
      AND (
        (${ref.issueId}::text IS NOT NULL AND raw_payload->>'issueId' = ${ref.issueId})
        OR (${ref.issueKey}::text IS NOT NULL AND raw_payload->>'issueKey' = ${ref.issueKey})
      )
    ORDER BY COALESCE(source_updated_at, timestamp) ASC, id ASC
  `));
  const latestById = new Map<string, JiraCapturedEventRow>();
  for (const row of commentRows) {
    const payload = jsonPayload(row.raw_payload);
    const commentId = payload ? stringValue(payload.id) : null;
    if (commentId) latestById.set(commentId, row);
  }
  const liveCommentRows = [...latestById.values()]
    .filter((row) => !row.event_type.endsWith(".deleted"));
  const capturedComments = liveCommentRows
    .map((row) => jsonPayload(row.raw_payload))
    .filter((row): row is Record<string, unknown> => Boolean(row));
  const commentSourceEvents = liveCommentRows.flatMap((row) => {
    const commentId = stringValue(jsonPayload(row.raw_payload)?.id);
    return commentId ? [{ commentId, sourceEventId: row.source_event_id }] : [];
  });

  return materializeJiraIssueSourceWiki(userId, {
    eventId: String(parent.id),
    sourceEventId: parent.source_event_id,
    rawPayload: mergeJiraCommentsIntoIssue(parentPayload, capturedComments),
    commentSourceEvents,
  }, options);
}

/** Merge richer paged/ledger comments into the issue payload used by Jira's renderer. */
export function mergeJiraCommentsIntoIssue(
  payload: Record<string, unknown>,
  comments: Record<string, unknown>[],
  reportedTotal?: number | null,
): Record<string, unknown> {
  const fields = objectValue(payload.fields);
  const container = objectValue(payload.comment) ?? objectValue(fields?.comment);
  const merged = normalizeJiraComments([...jiraComments(payload), ...comments]);
  const total = Math.max(reportedTotal ?? 0, finiteNumber(container?.total) ?? 0, merged.length);
  const nextContainer = { ...container, total, comments: merged };
  if (fields) {
    return { ...payload, fields: { ...fields, comment: nextContainer } };
  }
  return { ...payload, comment: nextContainer };
}

export async function deleteJiraIssueSourceWiki(
  userId: string,
  key: string,
  options: { refreshIndexes?: boolean } = {},
): Promise<void> {
  const safeKey = atlassianPathSegment(key, "UNKNOWN");
  await enqueueGraphDeletesForMatchingMirrorFiles(userId, sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${JIRA_SOURCE_ROOT}/%/${safeKey}.md`}
  `);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${JIRA_SOURCE_ROOT}/%/${safeKey}.md`}
  `);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId);
  }
}

export async function materializeConfluencePageSourceWiki(
  userId: string,
  input: ConfluencePageSourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const payload = input.rawPayload;
  const pageId = stringValue(payload.id) ?? stringValue(payload.pageId);
  const spaceId = confluenceSpaceId(payload);
  if (!pageId || !spaceId) return null;
  if (payload.deleted === true || payload._deleted === true || isDeletedNangoPayload(payload)) {
    await deleteConfluencePageSourceWiki(userId, spaceId, pageId, { refreshIndexes: options.refreshIndexes });
    return null;
  }

  const version = confluenceVersionNumber(payload);
  const links = objectValue(payload._links);
  const file: SourceWikiFile = {
    path: `${CONFLUENCE_SOURCE_ROOT}/${atlassianPathSegment(spaceId, "unknown-space")}/${atlassianPathSegment(pageId, "unknown-page")}.md`,
    content: renderConfluencePage(input, pageId, spaceId),
    meta: stagedDocumentMeta({
      provider: "confluence",
      externalId: pageId,
      kind: "document",
      title: stringValue(payload.title) ?? pageId,
      // Matches the raw version-append scheme confluence:page:<id>:v<n>.
      versionRef: version ? `v${version}` : null,
      sourceUpdatedAt: dateText(payload.updated_at ?? payload.updatedAt ?? objectValue(payload.version)?.when),
      authorEmail: confluencePersonEmail(payload.author ?? payload.createdBy ?? payload.owner),
      authorName: confluencePersonName(payload.author ?? payload.createdBy ?? payload.owner),
      sourceAcl: {
        spaceId,
        cloudId: stringValue(payload.cloudId) ?? stringValue(payload.cloud_id) ?? null,
      },
      aliases: emailAliases(confluencePersonEmail(payload.author ?? payload.createdBy ?? payload.owner)),
      sourceRefs: [{
        anchor: "Content",
        sourceEventId: input.sourceEventId,
        url: stringValue(payload.url) ?? stringValue(links?.webui) ?? undefined,
      }],
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

export async function deleteConfluencePageSourceWiki(
  userId: string,
  spaceId: string,
  pageId: string,
  options: { refreshIndexes?: boolean } = {},
): Promise<void> {
  const path = `${CONFLUENCE_SOURCE_ROOT}/${atlassianPathSegment(spaceId, "unknown-space")}/${atlassianPathSegment(pageId, "unknown-page")}.md`;
  // A deleted page takes its aggregated comments doc with it.
  const commentsPath = confluenceCommentsSourcePath(spaceId, pageId);
  await enqueueGraphDeletesForPaths(userId, [path, commentsPath]);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND path IN (${path}, ${commentsPath})
  `);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId);
  }
}

export type ConfluenceCommentsContainerRef = {
  containerType: "page" | "blog_post";
  containerId: string;
};

type ConfluenceCommentEventRow = {
  id: string | number;
  event_type: string;
  source_event_id: string;
  raw_payload: unknown;
  timestamp: string | Date | null;
  source_updated_at: string | Date | null;
};

type ConfluenceCommentState = {
  commentId: string;
  deleted: boolean;
  inline: boolean;
  payload: Record<string, unknown>;
  sourceEventId: string;
  versionNumber: number | null;
  /** ISO timestamp of this comment version (payload date, else event dates). */
  updatedAt: string | null;
};

/**
 * Rebuild the aggregated comments doc for one Confluence page (or blog post)
 * from every captured footer/inline comment event. The raw ledger keeps one
 * `activity_events` row per comment version plus `.deleted` tombstones, so
 * the doc is always derivable from capture alone (the same rebuild-per-
 * materialize shape as the Jira issue renderer). The doc reflects current
 * state: the latest live version of each comment; tombstoned comments are
 * omitted while their raw rows stay durable.
 *
 * Returns null without writing when no comment was ever captured for the
 * container, or when the container's space is not yet known (the page
 * record's arrival re-triggers the rebuild with the space in hand). Deletes
 * the doc when the container is tombstoned or no live comments remain.
 */
export async function materializeConfluenceCommentsSourceWiki(
  userId: string,
  ref: ConfluenceCommentsContainerRef,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const containerId = ref.containerId;
  const refKeys: [string, string] = ref.containerType === "page"
    ? ["pageId", "page_id"]
    : ["blogPostId", "blog_post_id"];
  const rows = rowsFromExecute<ConfluenceCommentEventRow>(await db.execute(sql`
    SELECT id, event_type, source_event_id, raw_payload, timestamp, source_updated_at
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'confluence'
      AND event_type IN ('footer_comment', 'inline_comment', 'footer_comment.deleted', 'inline_comment.deleted')
      AND (raw_payload->>${refKeys[0]} = ${containerId} OR raw_payload->>${refKeys[1]} = ${containerId})
    ORDER BY COALESCE(source_updated_at, timestamp) ASC, id ASC
  `));
  // Tombstones stay in the raw ledger forever, so zero rows means no comment
  // was ever captured for this container - no comments doc can exist yet.
  if (rows.length === 0) return null;

  const states = latestConfluenceCommentStates(rows);
  const live = states.filter((state) => !state.deleted);

  const containerRow = await latestConfluenceContainerRow(userId, ref);
  const containerPayload = containerRow ? jsonPayload(containerRow.raw_payload) : null;
  const containerDeleted = containerRow?.event_type?.endsWith(".deleted") ?? false;
  const spaceId = (containerPayload ? confluenceSpaceId(containerPayload) : null)
    ?? firstNonNull(states.map((state) => confluenceSpaceId(state.payload)));
  // Without a space the doc has no home under sources/confluence/<spaceId>/;
  // comments stay raw-only until the container record lands.
  if (!spaceId) return null;

  const path = confluenceCommentsSourcePath(spaceId, containerId);
  if (containerDeleted || live.length === 0) {
    await enqueueGraphDeletesForPaths(userId, [path]);
    await db.execute(sql`
      DELETE FROM mirror_files
      WHERE user_id = ${userId}
        AND path = ${path}
    `);
    if (options.refreshIndexes !== false) {
      await materializeSourceWikiIndexes(userId);
    }
    return null;
  }

  const title = stringValue(containerPayload?.title) ?? containerId;
  const latestUpdated = maxIsoDate(live.map((state) => state.updatedAt));
  const latestState = live.reduce((left, right) => ((right.updatedAt ?? "") >= (left.updatedAt ?? "") ? right : left));
  const file: SourceWikiFile = {
    path,
    content: renderConfluenceComments(ref, spaceId, title, live, latestUpdated),
    meta: stagedDocumentMeta({
      provider: "confluence",
      externalId: `${containerId}:comments`,
      kind: "comments",
      title: `Comments: ${title}`,
      versionRef: latestUpdated,
      sourceUpdatedAt: latestUpdated,
      authorEmail: firstNonNull(live.map((state) => confluenceCommentAuthorEmail(state.payload))),
      authorName: firstNonNull(live.map((state) => confluenceCommentAuthorName(state.payload))),
      updatedByEmail: confluenceCommentAuthorEmail(latestState.payload),
      sourceAcl: ref.containerType === "page"
        ? { spaceId, pageId: containerId }
        : { spaceId, blogPostId: containerId },
      aliases: emailAliases(...live.map((state) => confluenceCommentAuthorEmail(state.payload))),
      sourceRefs: [
        // Section-level drill-down: the container record behind the doc, then
        // one ref per rendered comment heading.
        containerRow ? { anchor: "Comments", sourceEventId: containerRow.source_event_id } : null,
        ...live.map((state) => ({ anchor: `Comment ${state.commentId}`, sourceEventId: state.sourceEventId })),
      ],
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

export async function materializeBitbucketPullRequestSourceWiki(
  userId: string,
  input: BitbucketPullRequestSourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const filePath = `${gitProviderRepoDirectory(BITBUCKET_SOURCE_ROOT, input.repoFullName)}/pr-${gitProviderPathSegment(input.pullRequestId, "unknown")}.md`;
  if (input.rawPayload.deleted === true || input.rawPayload._deleted === true || isDeletedNangoPayload(input.rawPayload)) {
    await deleteGitProviderSourceWikiFile(userId, filePath, options);
    return null;
  }

  if (input.repoFullName !== "unknown-repo") {
    const unknownRepoPath = `${gitProviderRepoDirectory(BITBUCKET_SOURCE_ROOT, "unknown-repo")}/pr-${gitProviderPathSegment(input.pullRequestId, "unknown")}.md`;
    if (await sourceWikiFileExists(userId, unknownRepoPath)) {
      await deleteGitProviderSourceWikiFile(userId, unknownRepoPath, { refreshIndexes: false });
    }
  }

  const payload = input.rawPayload;
  const comments = await latestBitbucketComments(userId, "pr_comment", input.repoFullName, input.pullRequestId);
  const repoUuid = bitbucketRepoUuid(payload);
  const file: SourceWikiFile = {
    path: filePath,
    content: renderBitbucketPullRequest(input, comments),
    meta: stagedDocumentMeta({
      provider: "bitbucket",
      // PR ids are per-repo; scope by the repo UUID when the record carries
      // one (full name is the mutable fallback the renderer actually has).
      externalId: `${repoUuid ?? input.repoFullName}:pr:${input.pullRequestId}`,
      kind: "document",
      title: stringValue(payload.title) ?? `Pull request ${input.pullRequestId}`,
      versionRef: dateText(payload.updated_on ?? payload.updatedAt),
      sourceUpdatedAt: dateText(payload.updated_on ?? payload.updatedAt),
      authorEmail: bitbucketPersonEmail(payload.author),
      authorName: bitbucketPersonName(payload.author),
      sourceAcl: { repoFullName: input.repoFullName, repoUuid: repoUuid ?? null },
      aliases: emailAliases(bitbucketPersonEmail(payload.author)),
      sourceRefs: [
        {
          anchor: "Description",
          sourceEventId: input.sourceEventId,
          url: bitbucketWebUrl(payload) ?? undefined,
        },
        ...comments.comments.map((comment) => ({
          anchor: `Comment ${comment.commentId}`,
          sourceEventId: comment.sourceEventId,
        })),
      ],
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

export async function materializeBitbucketIssueSourceWiki(
  userId: string,
  input: BitbucketIssueSourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const filePath = `${gitProviderRepoDirectory(BITBUCKET_SOURCE_ROOT, input.repoFullName)}/issue-${gitProviderPathSegment(input.issueId, "unknown")}.md`;
  if (input.rawPayload.deleted === true || input.rawPayload._deleted === true || isDeletedNangoPayload(input.rawPayload)) {
    await deleteGitProviderSourceWikiFile(userId, filePath, options);
    return null;
  }

  const payload = input.rawPayload;
  const comments = await latestBitbucketComments(userId, "issue_comment", input.repoFullName, input.issueId);
  const repository = objectValue(payload.repository);
  const repoUuid = stringValue(repository?.uuid);
  const author = payload.reporter ?? payload.author;
  const file: SourceWikiFile = {
    path: filePath,
    content: renderBitbucketIssue(input, comments),
    meta: stagedDocumentMeta({
      provider: "bitbucket",
      externalId: `${repoUuid ?? input.repoFullName}:issue:${input.issueId}`,
      kind: "document",
      title: stringValue(payload.title) ?? `Issue ${input.issueId}`,
      versionRef: dateText(payload.updated_on ?? payload.updatedAt),
      sourceUpdatedAt: dateText(payload.updated_on ?? payload.updatedAt),
      authorEmail: bitbucketPersonEmail(author),
      authorName: bitbucketPersonName(author),
      sourceAcl: { repoFullName: input.repoFullName, repoUuid: repoUuid ?? null },
      aliases: emailAliases(bitbucketPersonEmail(author)),
      sourceRefs: [
        {
          anchor: "Body",
          sourceEventId: input.sourceEventId,
          url: bitbucketWebUrl(payload) ?? undefined,
        },
        ...comments.comments.map((comment) => ({
          anchor: `Comment ${comment.commentId}`,
          sourceEventId: comment.sourceEventId,
        })),
      ],
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

export async function materializeBitbucketRepositorySourceWiki(
  userId: string,
  input: BitbucketRepositorySourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const filePath = `${gitProviderRepoDirectory(BITBUCKET_SOURCE_ROOT, input.repoFullName)}/repo.md`;
  if (input.rawPayload.deleted === true || input.rawPayload._deleted === true || isDeletedNangoPayload(input.rawPayload)) {
    await deleteGitProviderSourceWikiFile(userId, filePath, options);
    return null;
  }

  const payload = input.rawPayload;
  const file: SourceWikiFile = {
    path: filePath,
    content: renderBitbucketRepository(input),
    meta: stagedDocumentMeta({
      provider: "bitbucket",
      externalId: stringValue(payload.uuid) ?? idValue(payload.id) ?? input.repoFullName,
      kind: "document",
      title: stringValue(payload.name) ?? input.repoFullName,
      versionRef: dateText(payload.updated_on ?? payload.updatedAt),
      sourceUpdatedAt: dateText(payload.updated_on ?? payload.updatedAt),
      sourceAcl: {
        repoFullName: input.repoFullName,
        private: typeof (payload.is_private ?? payload.isPrivate) === "boolean"
          ? payload.is_private ?? payload.isPrivate
          : null,
      },
      sourceRefs: [{
        anchor: "Description",
        sourceEventId: input.sourceEventId,
        url: bitbucketWebUrl(payload) ?? undefined,
      }],
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

export async function materializeGithubIssueSourceWiki(
  userId: string,
  input: GithubIssueSourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const filePath = `${gitProviderRepoDirectory(GITHUB_SOURCE_ROOT, input.repoFullName)}/issue-${gitProviderPathSegment(input.number, "unknown")}.md`;
  if (input.rawPayload.deleted === true || input.rawPayload._deleted === true || isDeletedNangoPayload(input.rawPayload)) {
    await deleteGitProviderSourceWikiFile(userId, filePath, options);
    return null;
  }

  const comments = await currentGithubComments(userId, {
    kind: "issue",
    repoFullName: input.repoFullName,
    number: input.number,
  });
  const file: SourceWikiFile = {
    path: filePath,
    content: renderGithubIssue(input, comments),
    meta: githubRecordMeta(input, {
      externalId: idValue(input.rawPayload.id) ?? `${input.repoKey}:issue:${input.number}`,
      title: stringValue(input.rawPayload.title) ?? `Issue ${input.number}`,
      anchor: "Body",
      additionalSourceRefs: githubCommentSourceRefs(comments),
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

export async function materializeGithubPullRequestSourceWiki(
  userId: string,
  input: GithubPullRequestSourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const filePath = `${gitProviderRepoDirectory(GITHUB_SOURCE_ROOT, input.repoFullName)}/pr-${gitProviderPathSegment(input.number, "unknown")}.md`;
  if (input.rawPayload.deleted === true || input.rawPayload._deleted === true || isDeletedNangoPayload(input.rawPayload)) {
    await deleteGitProviderSourceWikiFile(userId, filePath, options);
    return null;
  }

  const comments = await currentGithubComments(userId, {
    kind: "pull_request",
    repoFullName: input.repoFullName,
    number: input.number,
  });
  const file: SourceWikiFile = {
    path: filePath,
    content: renderGithubPullRequest(input, comments),
    meta: githubRecordMeta(input, {
      externalId: idValue(input.rawPayload.id) ?? `${input.repoKey}:pr:${input.number}`,
      title: stringValue(input.rawPayload.title) ?? `Pull request ${input.number}`,
      anchor: "Body",
      additionalSourceRefs: githubCommentSourceRefs(comments),
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

/** Re-render a GitHub issue/PR from its latest captured parent version. */
export async function rematerializeGithubParentSourceWiki(
  userId: string,
  ref: GithubParentSourceRef,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const eventTypes = ref.kind === "issue"
    ? ["issue", "issue.deleted"]
    : ["pull_request_detail", "pull_request_detail.deleted", "pull_request", "pull_request.deleted"];
  const repositoryUrlSuffix = `/repos/${ref.repoFullName}`;
  const htmlUrlSuffix = `/${ref.kind === "issue" ? "issues" : "pull"}/${ref.number}`;
  const rows = rowsFromExecute<{
    id: string | number;
    event_type: string;
    source_event_id: string;
    raw_payload: unknown;
  }>(await db.execute(sql`
    SELECT id, event_type, source_event_id, raw_payload
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'github'
      AND event_type IN (${sql.join(eventTypes.map((eventType) => sql`${eventType}`), sql`, `)})
      AND raw_payload->>'number' = ${ref.number}
      AND (
        raw_payload#>>'{base,repo,full_name}' = ${ref.repoFullName}
        OR raw_payload#>>'{repository,full_name}' = ${ref.repoFullName}
        OR right(COALESCE(raw_payload->>'repository_url', ''), ${repositoryUrlSuffix.length}) = ${repositoryUrlSuffix}
        OR right(COALESCE(raw_payload->>'html_url', ''), ${htmlUrlSuffix.length}) = ${htmlUrlSuffix}
      )
    ORDER BY
      CASE WHEN event_type IN ('pull_request_detail', 'pull_request_detail.deleted') THEN 0 ELSE 1 END,
      COALESCE(source_updated_at, timestamp) DESC,
      id DESC
    LIMIT 1
  `));
  const row = rows[0];
  if (!row) return null;
  const payload = jsonPayload(row.raw_payload) ?? {};
  const baseRepo = objectValue(objectValue(payload.base)?.repo);
  const repository = objectValue(payload.repository);
  const repoKey = idValue(baseRepo?.id) ?? idValue(repository?.id) ?? ref.repoFullName;
  const input: GithubIssueSourcePayload = {
    eventId: String(row.id),
    sourceEventId: row.source_event_id,
    repoKey,
    repoFullName: ref.repoFullName,
    number: ref.number,
    rawPayload: payload,
  };
  return ref.kind === "issue"
    ? materializeGithubIssueSourceWiki(userId, input, options)
    : materializeGithubPullRequestSourceWiki(userId, input, options);
}

export async function materializeGithubRepositorySourceWiki(
  userId: string,
  input: GithubRepositorySourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const filePath = `${gitProviderRepoDirectory(GITHUB_SOURCE_ROOT, input.repoFullName)}/repo.md`;
  if (input.rawPayload.deleted === true || input.rawPayload._deleted === true || isDeletedNangoPayload(input.rawPayload)) {
    await deleteGitProviderSourceWikiFile(userId, filePath, options);
    return null;
  }

  const file: SourceWikiFile = {
    path: filePath,
    content: renderGithubRepository(input),
    meta: githubRecordMeta(input, {
      externalId: idValue(input.rawPayload.id)
        ?? idValue(input.rawPayload.repoId)
        ?? idValue(input.rawPayload.repository_id)
        ?? input.repoKey,
      title: input.repoFullName,
      anchor: "Description",
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

function githubRecordMeta(
  input: { sourceEventId: string; repoKey: string; repoFullName: string; rawPayload: Record<string, unknown> },
  opts: {
    externalId: string;
    title: string;
    anchor: string;
    additionalSourceRefs?: StagedDocumentSourceRef[];
  },
): StagedDocumentMeta {
  const payload = input.rawPayload;
  const author = objectValue(payload.user ?? payload.author);
  return stagedDocumentMeta({
    provider: "github",
    externalId: opts.externalId,
    kind: "document",
    title: opts.title,
    versionRef: dateText(payload.updated_at ?? payload.updatedAt ?? payload.pushed_at),
    sourceUpdatedAt: dateText(payload.updated_at ?? payload.updatedAt ?? payload.pushed_at),
    authorEmail: stringValue(author?.email),
    authorName: stringValue(author?.login) ?? stringValue(author?.name),
    sourceAcl: { repoKey: input.repoKey, repoFullName: input.repoFullName },
    aliases: emailAliases(stringValue(author?.email)),
    sourceRefs: [{
      anchor: opts.anchor,
      sourceEventId: input.sourceEventId,
      url: stringValue(payload.html_url ?? payload.url) ?? undefined,
    }, ...(opts.additionalSourceRefs ?? [])],
  });
}

function bitbucketRepoUuid(payload: Record<string, unknown>): string | null {
  const destinationRepo = objectValue(objectValue(payload.destination)?.repository);
  const sourceRepo = objectValue(objectValue(payload.source)?.repository);
  return stringValue(destinationRepo?.uuid) ?? stringValue(sourceRepo?.uuid);
}

function bitbucketPersonEmail(value: unknown): string | null {
  const record = objectValue(value);
  return stringValue(record?.email) ?? stringValue(record?.emailAddress);
}

function bitbucketPersonName(value: unknown): string | null {
  const record = objectValue(value);
  return stringValue(record?.display_name)
    ?? stringValue(record?.displayName)
    ?? stringValue(record?.nickname)
    ?? stringValue(record?.username)
    ?? stringValue(record?.name);
}

async function deleteGitProviderSourceWikiFile(
  userId: string,
  path: string,
  options: { refreshIndexes?: boolean } = {},
): Promise<void> {
  const normalizedPath = normalizeSourcePath(path);
  await enqueueGraphDeletesForPaths(userId, [normalizedPath]);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND path = ${normalizedPath}
  `);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId);
  }
}

async function sourceWikiFileExists(userId: string, path: string): Promise<boolean> {
  const normalizedPath = normalizeSourcePath(path);
  const rows = rowsFromExecute<{ path: string }>(await db.execute(sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND path = ${normalizedPath}
    LIMIT 1
  `));
  return rows.some((row) => row.path === normalizedPath);
}

/**
 * Mirror one full Gmail message into the source wiki as a single markdown
 * file. Returns null (and removes any previously mirrored file) when the
 * message should not exist in the mirror: deleted upstream, or currently
 * labeled SPAM/TRASH. Label churn re-materializes to the same stable path.
 */
export type SlackMirrorMessage = {
  ts: string | Date;
  text?: string | null;
  senderName?: string | null;
  senderHandle?: string | null;
  threadTs?: string | null;
  sourceEventId?: string | null;
};

export type SlackWindowMaterializeResult = {
  files: SourceWikiFile[];
  threads: {
    writtenPaths: string[];
    crumbsSkipped: number;
  };
  sessions: {
    writtenPaths: string[];
    crumbsSkipped: number;
  };
};

type SlackWindowFile = SourceWikiFile & {
  kind: "thread" | "session";
  crumb: boolean;
};

export function slackChannelSourceDirectory(channelId: string, channelName?: string | null): string {
  return titledEntityDirectory(SLACK_SOURCE_ROOT, channelName, "Unnamed Slack Channel", "channel", channelId);
}

export async function materializeSlackWindowSourceWiki(
  userId: string,
  input: {
    channelId: string;
    channelName?: string | null;
    messages: SlackMirrorMessage[];
  },
  options: { refreshIndexes?: boolean } = {},
): Promise<SlackWindowMaterializeResult> {
  const directory = slackChannelSourceDirectory(input.channelId, input.channelName);
  const threadGroups = new Map<string, SlackMirrorMessage[]>();
  const sessionMessages: SlackMirrorMessage[] = [];

  for (const message of input.messages) {
    const threadTs = stringValue(message.threadTs);
    if (threadTs) {
      const group = threadGroups.get(threadTs) ?? [];
      group.push(message);
      threadGroups.set(threadTs, group);
    } else {
      sessionMessages.push(message);
    }
  }

  const threadFiles = [...threadGroups.entries()]
    .sort(([a], [b]) => slackTsDate(a).getTime() - slackTsDate(b).getTime() || a.localeCompare(b))
    .flatMap(([threadTs, messages]) => renderSlackThreadWindowFiles(directory, input, threadTs, messages));
  const sessionFiles = renderSlackSessionWindowFiles(directory, input, sessionMessages);
  const files = [...threadFiles, ...sessionFiles].filter((file) => !file.crumb);

  await replaceSourceWikiDirectory(userId, directory, files, {
    sourceRoot: SLACK_SOURCE_ROOT,
    entitySuffix: stableEntityPath("channel", input.channelId),
  });
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, files);
  }

  return {
    files,
    threads: {
      writtenPaths: files.filter((file) => file.kind === "thread").map((file) => file.path),
      // Threads are curated conversation structure; even short threads are graph-worthy.
      crumbsSkipped: 0,
    },
    sessions: {
      writtenPaths: files.filter((file) => file.kind === "session").map((file) => file.path),
      crumbsSkipped: sessionFiles.filter((file) => file.crumb).length,
    },
  };
}

function renderSlackThreadWindowFiles(
  directory: string,
  input: {
    channelId: string;
    channelName?: string | null;
  },
  threadTs: string,
  messages: SlackMirrorMessage[],
): SlackWindowFile[] {
  const windows = assembleSessionWindows(messages.map(slackMessageToSessionMessage), {
    gapMs: Number.POSITIVE_INFINITY,
    minChars: 0,
  });
  return windows.map((window, index) => {
    const windowKey = index === 0 ? threadTs : `${threadTs}-${index + 1}`;
    const windowMessages = slackMessagesInWindow(messages, window.startTs, window.endTs);
    return {
      kind: "thread",
      crumb: window.crumb,
      path: `${directory}/threads/${slackTsPathSegment(windowKey)}.md`,
      content: renderSlackWindowFile(input, {
        titlePrefix: "Thread",
        windowKind: "Thread",
        windowKey,
        threadTs,
        startTs: window.startTs,
        endTs: window.endTs,
        messageCount: window.messageCount,
        content: window.content,
      }),
      meta: slackWindowMeta(input, {
        titlePrefix: "Thread",
        windowKind: "Thread",
        windowKey,
        startTs: window.startTs,
        endTs: window.endTs,
      }, windowMessages),
    };
  });
}

function renderSlackSessionWindowFiles(
  directory: string,
  input: {
    channelId: string;
    channelName?: string | null;
  },
  messages: SlackMirrorMessage[],
): SlackWindowFile[] {
  const windows = assembleSessionWindows(messages.map(slackMessageToSessionMessage));
  return windows.map((window) => {
    const windowMessages = slackMessagesInWindow(messages, window.startTs, window.endTs);
    return {
      kind: "session",
      crumb: window.crumb,
      path: `${directory}/sessions/${window.windowKey}.md`,
      content: renderSlackWindowFile(input, {
        titlePrefix: "Session",
        windowKind: "Session",
        windowKey: window.windowKey,
        startTs: window.startTs,
        endTs: window.endTs,
        messageCount: window.messageCount,
        content: window.content,
      }),
      meta: slackWindowMeta(input, {
        titlePrefix: "Session",
        windowKind: "Session",
        windowKey: window.windowKey,
        startTs: window.startTs,
        endTs: window.endTs,
      }, windowMessages),
    };
  });
}

function slackWindowMeta(
  input: {
    channelId: string;
    channelName?: string | null;
  },
  window: {
    titlePrefix: string;
    windowKind: string;
    windowKey: string;
    startTs: Date;
    endTs: Date;
  },
  messages: SlackMirrorMessage[],
): StagedDocumentMeta {
  const channelName = stringValue(input.channelName) ?? input.channelId;
  const aliases: StagedDocumentAlias[] = [];
  const sourceRefs: StagedDocumentSourceRef[] = [];
  for (const message of messages) {
    const senderHandle = stringValue(message.senderHandle);
    if (senderHandle) aliases.push({ kind: "slack_uid", value: senderHandle });
    const anchor = slackTsKey(message.ts);
    sourceRefs.push({
      anchor,
      sourceEventId: stringValue(message.sourceEventId) ?? `slack:${input.channelId}:${anchor}`,
    });
  }
  return stagedDocumentMeta({
    provider: "slack",
    externalId: `${input.channelId}:${window.windowKind.toLowerCase()}:${window.windowKey}`,
    kind: "conversation_window",
    title: `${window.titlePrefix}: ${channelName} - ${window.windowKey}`,
    sourceUpdatedAt: window.endTs,
    sourceAcl: { channelId: input.channelId },
    aliases,
    sourceRefs,
  });
}

function slackMessagesInWindow(
  messages: SlackMirrorMessage[],
  startTs: Date,
  endTs: Date,
): SlackMirrorMessage[] {
  const start = startTs.getTime();
  const end = endTs.getTime();
  return messages.filter((message) => {
    const timestamp = slackTsDate(message.ts).getTime();
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
}

function renderSlackWindowFile(
  input: {
    channelId: string;
    channelName?: string | null;
  },
  window: {
    titlePrefix: string;
    windowKind: string;
    windowKey: string;
    threadTs?: string | null;
    startTs: Date;
    endTs: Date;
    messageCount: number;
    content: string;
  },
): string {
  const channelName = stringValue(input.channelName) ?? input.channelId;
  return [
    `# ${window.titlePrefix}: ${headingText(channelName)} — ${window.windowKey}`,
    "",
    sourceMetadata([
      ["Source", "Slack"],
      ["Channel ID", input.channelId],
      ["Channel", channelName],
      ["Window kind", window.windowKind],
      ["Window", window.windowKey],
      ["Thread TS", window.threadTs ?? null],
      ["Messages", String(window.messageCount)],
      ["Start", window.startTs.toISOString()],
      ["End", window.endTs.toISOString()],
    ]),
    "",
    "## Messages",
    "",
    window.content,
  ].join("\n");
}

function slackMessageToSessionMessage(message: SlackMirrorMessage): SessionMessage {
  return {
    timestamp: slackTsDate(message.ts),
    text: message.text,
    senderName: message.senderName,
    senderHandle: message.senderHandle,
  };
}

function slackTsDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(String(value));
}

function slackTsPathSegment(value: string): string {
  const safe = value.trim().replace(/[^0-9A-Za-z._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return safe || "unknown";
}

function slackTsKey(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export async function materializeGmailMessageSourceWiki(
  userId: string,
  input: GmailMessageSourcePayload,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const payload = input.rawPayload;
  const gmailId = stringValue(payload.gmailId) ?? input.sourceEventId.replace(/^gmail:/, "");
  if (!gmailId) return null;

  const labelIds = Array.isArray(payload.labelIds)
    ? payload.labelIds.filter((label): label is string => typeof label === "string")
    : [];
  const excluded = payload._deleted === true || labelIds.some((label) => GMAIL_EXCLUDED_LABELS.has(label));
  if (excluded) {
    await deleteGmailMessageSourceWiki(userId, gmailId, { refreshIndexes: false });
    return null;
  }

  const file: SourceWikiFile = {
    path: gmailMessageSourcePath(gmailId, {
      timestamp: input.timestamp,
      fromEmail: stringValue(payload._from_email) ?? stringValue(payload.from),
      fromName: stringValue(payload._from_name),
      subject: stringValue(payload.subject),
      labelIds,
    }),
    content: renderGmailMessage(input, gmailId),
    meta: stagedDocumentMeta({
      provider: "gmail",
      externalId: gmailId,
      kind: "conversation_window",
      title: stringValue(payload.subject) ?? "(no subject)",
      // Messages are immutable one-row raw - versionRef = content sha fallback.
      sourceUpdatedAt: dateText(payload.date ?? input.timestamp),
      authorEmail: stringValue(payload._from_email) ?? firstEmail(stringValue(payload.from)),
      authorName: stringValue(payload._from_name),
      sourceAcl: { threadId: stringValue(payload.threadId) ?? null },
      aliases: emailAliases(
        stringValue(payload._from_email) ?? stringValue(payload.from),
        stringValue(payload.to),
        stringValue(payload.cc),
      ),
      sourceRefs: [{ anchor: "Body", sourceEventId: input.sourceEventId }],
    }),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  // Label churn can move a message between boxes (inbox -> archive); sweep
  // any copy of this message left at a previous path.
  await enqueueGraphDeletesForMatchingMirrorFiles(userId, sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${GMAIL_SOURCE_ROOT}/%--${stableEntityPath("message", gmailId)}.md`}
      AND path <> ${file.path}
  `);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${GMAIL_SOURCE_ROOT}/%--${stableEntityPath("message", gmailId)}.md`}
      AND path <> ${file.path}
  `);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

export async function deleteGmailMessageSourceWiki(
  userId: string,
  gmailId: string,
  options: { refreshIndexes?: boolean } = {},
): Promise<void> {
  const suffix = stableEntityPath("message", gmailId);
  await enqueueGraphDeletesForMatchingMirrorFiles(userId, sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${GMAIL_SOURCE_ROOT}/%--${suffix}.md`}
  `);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${GMAIL_SOURCE_ROOT}/%--${suffix}.md`}
  `);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId);
  }
}

export function slackChannelDaySourcePath(channelId: string, dayKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) throw new Error(`invalid Slack day key: ${dayKey}`);
  return `${SLACK_SOURCE_ROOT}/${slackPathSegment(channelId, "unknown-channel")}/${dayKey}.md`;
}

/**
 * Rewrite one Slack channel/day file from stored raw events. Callers provide
 * the channel id and UTC day touched by a captured message/edit/delete/reaction.
 */
export async function materializeSlackChannelDaySourceWiki(
  userId: string,
  input: { channelId: string; dayKey: string },
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const path = slackChannelDaySourcePath(input.channelId, input.dayKey);
  const start = new Date(`${input.dayKey}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid Slack day key: ${input.dayKey}`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const rows = rowsFromExecute<{
    event_id: string;
    event_type: string;
    source_event_id: string;
    timestamp: Date | string;
    source_updated_at: Date | string | null;
    raw_payload: Record<string, unknown>;
  }>(await db.execute(sql`
    SELECT
      id AS event_id,
      event_type,
      source_event_id,
      timestamp,
      source_updated_at,
      raw_payload
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'slack'
      AND raw_payload->>'_channel' = ${input.channelId}
      AND COALESCE(raw_payload->>'_ledger', '') <> 'true'
      AND timestamp >= ${start.toISOString()}::timestamptz
      AND timestamp < ${end.toISOString()}::timestamptz
    ORDER BY timestamp ASC, source_event_id ASC
  `));

  if (rows.length === 0) {
    await enqueueGraphDeletesForPaths(userId, [path]);
    await db.execute(sql`
      DELETE FROM mirror_files
      WHERE user_id = ${userId}
        AND path = ${path}
    `);
    if (options.refreshIndexes !== false) await materializeSourceWikiIndexes(userId);
    return null;
  }

  const messages = rows.map((row) => ({
    eventId: row.event_id,
    eventType: row.event_type,
    sourceEventId: row.source_event_id,
    timestamp: row.timestamp,
    sourceUpdatedAt: row.source_updated_at,
    rawPayload: row.raw_payload,
  }));
  const file: SourceWikiFile = {
    path,
    content: renderSlackChannelDay(input.channelId, input.dayKey, messages),
    meta: slackChannelDayMeta(input.channelId, input.dayKey, messages),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

function slackChannelDayMeta(
  channelId: string,
  dayKey: string,
  messages: SlackChannelDayMessage[],
): StagedDocumentMeta {
  const firstPayload = messages[0]?.rawPayload ?? {};
  const channelName = stringValue(firstPayload._channel_name);
  const aliases: StagedDocumentAlias[] = [];
  const sourceRefs: StagedDocumentSourceRef[] = [];
  let latest: Date | null = null;
  for (const message of messages) {
    const payload = message.rawPayload;
    const userId = stringValue(payload.user);
    if (userId) aliases.push({ kind: "slack_uid", value: userId });
    aliases.push(...emailAliases(stringValue(payload._user_email)));
    const ts = stringValue(payload.ts) ?? slackSourceTs(message.sourceEventId);
    // Anchor = the message ts (the rendered HH:MM stamps derive from it).
    if (ts) sourceRefs.push({ anchor: ts, sourceEventId: message.sourceEventId });
    const timestamp = dateValue(message.sourceUpdatedAt) ?? dateValue(message.timestamp);
    if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
  }
  return stagedDocumentMeta({
    provider: "slack",
    externalId: `${channelId}:${dayKey}`,
    kind: "conversation_window",
    title: `Slack ${channelName ?? channelId} - ${dayKey}`,
    sourceUpdatedAt: latest,
    sourceAcl: {
      channelId,
      channelType: stringValue(firstPayload._channel_type) ?? null,
    },
    aliases,
    sourceRefs,
  });
}

function renderSlackChannelDay(
  channelId: string,
  dayKey: string,
  messages: SlackChannelDayMessage[],
): string {
  const firstPayload = messages[0]?.rawPayload ?? {};
  const channelName = stringValue(firstPayload._channel_name);
  const channelType = stringValue(firstPayload._channel_type);
  const lines = messages
    .map(renderSlackMessageLine)
    .filter((line): line is string => Boolean(line));

  return [
    `# Slack ${headingText(channelName ?? channelId)} - ${dayKey}`,
    "",
    sourceMetadata([
      ["Source", "Slack"],
      ["Channel ID", channelId],
      ["Channel name", channelName],
      ["Channel type", channelType],
      ["UTC date", dayKey],
      ["Messages", String(messages.length)],
    ]),
    "",
    "## Messages",
    "",
    lines.length > 0 ? lines.join("\n") : "_No renderable Slack messages captured for this day._",
  ].join("\n");
}

function renderSlackMessageLine(message: SlackChannelDayMessage): string | null {
  const payload = message.rawPayload;
  const ts = stringValue(payload.ts) ?? slackSourceTs(message.sourceEventId);
  const date = slackDate(ts) ?? dateValue(message.timestamp);
  if (!date) return null;
  const deleted = payload._deleted === true;
  const author = slackAuthorLabel(payload);
  const text = deleted ? "[deleted]" : bodyText(stringValue(payload.text), "");
  const parts = [text];
  const files = slackNamedItems(payload.files, "file");
  const canvases = [
    ...slackNamedItems(payload.canvases, "canvas"),
    ...slackNamedItems(payload.canvas, "canvas"),
  ];
  if (files.length > 0) parts.push(files.join(" "));
  if (canvases.length > 0) parts.push(canvases.join(" "));

  const edited = objectValue(payload.edited);
  const editedAt = dateText(edited?.ts ? slackDate(String(edited.ts)) : message.sourceUpdatedAt);
  const reactions = slackReactions(payload.reactions);
  const threadTs = stringValue(payload._thread_ts) ?? stringValue(payload.thread_ts);
  const threadSuffix = threadTs && threadTs !== ts ? ` (thread ${inlineText(threadTs)})` : "";
  const suffixes = [
    editedAt && !deleted ? `edited ${editedAt}` : null,
    reactions,
  ].filter(Boolean).join("; ");
  const body = parts.filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  if (!body && !suffixes) return null;
  return `**${date.toISOString().slice(11, 16)}** ${inlineText(author)}${threadSuffix}: ${body}${suffixes ? ` _${suffixes}_` : ""}`;
}

function slackAuthorLabel(payload: Record<string, unknown>): string {
  const name = stringValue(payload._user_name)
    ?? stringValue(payload._user_real_name)
    ?? stringValue(payload.username)
    ?? stringValue(payload.user)
    ?? stringValue(payload.bot_id)
    ?? "unknown";
  const email = stringValue(payload._user_email);
  return email ? `${name} <${email}>` : name;
}

function slackNamedItems(value: unknown, label: string): string[] {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return rows
    .map((item) => objectValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => stringValue(item.name) ?? stringValue(item.title) ?? stringValue(item.id))
    .filter((name): name is string => Boolean(name))
    .map((name) => `[${label}: ${inlineText(name)}]`);
}

function slackReactions(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rendered = value
    .map((item) => objectValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => {
      const name = stringValue(item.name);
      const count = typeof item.count === "number" && Number.isFinite(item.count) ? item.count : null;
      if (!name) return null;
      return count ? `:${name}: x${count}` : `:${name}:`;
    })
    .filter(Boolean);
  return rendered.length > 0 ? `reactions ${rendered.join(", ")}` : null;
}

function slackSourceTs(sourceEventId: string): string | null {
  const parts = sourceEventId.split(":");
  return parts.length >= 3 ? parts.at(-1) ?? null : null;
}

function slackDate(ts: string | null): Date | null {
  if (!ts) return null;
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function slackPathSegment(value: string | null | undefined, fallback: string): string {
  return (value ?? "").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || fallback;
}

const IMESSAGE_SOURCE_ROOT = `${SOURCES_ROOT}/imessage`;
const IMESSAGE_MONTH_FILE_MAX_CHARS = 500_000;

export type ImessageMirrorMessage = {
  timestamp: string | Date;
  text?: string | null;
  senderName?: string | null;
  senderHandle?: string | null;
  isFromMe?: boolean | null;
  reaction?: string | null;
  hasAttachments?: boolean | null;
};

export function imessageConversationSourceDirectory(conversationId: string, conversationName?: string | null): string {
  return titledEntityDirectory(IMESSAGE_SOURCE_ROOT, conversationName, "Unnamed Conversation", "chat", conversationId);
}

/**
 * Mirror one (conversation, month) of iMessages as a single chronological
 * markdown file. Grouped monthly on purpose: per-message files at iMessage
 * volume (100k+) would sink the sandbox wiki snapshot. Callers pass the FULL
 * month's messages; the file is rewritten wholesale (newest kept on
 * truncation).
 */
export async function materializeImessageMonthSourceWiki(
  userId: string,
  input: {
    conversationId: string;
    conversationName?: string | null;
    monthKey: string; // "yyyy-mm"
    messages: ImessageMirrorMessage[];
  },
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  if (!/^\d{4}-\d{2}$/u.test(input.monthKey)) throw new Error(`invalid imessage month key: ${input.monthKey}`);
  const directory = imessageConversationSourceDirectory(input.conversationId, input.conversationName);
  const lines = input.messages
    .map((message) => renderImessageLine(message))
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return null;

  let body = lines.join("\n");
  let dropped = 0;
  while (body.length > IMESSAGE_MONTH_FILE_MAX_CHARS && lines.length > 1) {
    // Drop oldest lines until within budget; note what was elided.
    const drop = Math.max(1, Math.ceil(lines.length * 0.1));
    lines.splice(0, drop);
    dropped += drop;
    body = lines.join("\n");
  }

  const latestTimestamp = input.messages.reduce<Date | null>((latest, message) => {
    const date = dateValue(message.timestamp);
    return date && (!latest || date > latest) ? date : latest;
  }, null);
  const file: SourceWikiFile = {
    path: `${directory}/${input.monthKey}.md`,
    meta: stagedDocumentMeta({
      provider: "imessage",
      externalId: `${input.conversationId}:${input.monthKey}`,
      kind: "conversation_window",
      title: `${stringValue(input.conversationName) ?? "Unnamed Conversation"} - ${input.monthKey}`,
      sourceUpdatedAt: latestTimestamp,
      sourceAcl: { conversationId: input.conversationId },
      // Handles that are addresses; phone-number handles have no alias kind.
      aliases: emailAliases(...input.messages.map((message) => message.senderHandle)),
    }),
    content: [
      `# ${headingText(stringValue(input.conversationName) ?? "Unnamed Conversation")} - ${input.monthKey}`,
      "",
      sourceMetadata([
        ["Source", "iMessage"],
        ["Conversation ID", input.conversationId],
        ["Month", input.monthKey],
        ["Messages", String(lines.length + dropped)],
        ["Elided oldest", dropped > 0 ? String(dropped) : null],
      ]),
      "",
      "## Messages",
      "",
      body,
    ].join("\n"),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

function renderImessageLine(message: ImessageMirrorMessage): string | null {
  const date = message.timestamp instanceof Date ? message.timestamp : new Date(String(message.timestamp));
  if (Number.isNaN(date.getTime())) return null;
  const text = stringValue(message.text);
  const reaction = stringValue(message.reaction);
  const attachment = message.hasAttachments === true;
  if (!text && !reaction && !attachment) return null;
  const sender = message.isFromMe === true
    ? "me"
    : stringValue(message.senderName) ?? stringValue(message.senderHandle) ?? "unknown";
  const stamp = `${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 16)}`;
  const parts = [
    reaction ? `(${reaction})` : null,
    text,
    attachment && !text ? "[attachment]" : attachment ? "[+attachment]" : null,
  ].filter(Boolean).join(" ");
  return `**${stamp}** ${inlineText(sender)}: ${parts.replace(/\s+/g, " ").trim()}`;
}

export type CalendarEventSourceSnapshot = {
  calendarId: string;
  eventId: string;
  summary?: string | null;
  status?: string | null;
  eventType?: string | null;
  start?: unknown;
  end?: unknown;
  sourceUpdatedAt?: string | Date | null;
  rawPayload: Record<string, unknown>;
};

/**
 * Mirror one Google Calendar event snapshot as a single markdown file, dated
 * by start time. Cancelled events remove the file. Rescheduled events move
 * the file (stale-path sweep on the stable event suffix).
 */
export async function materializeCalendarEventSourceWiki(
  userId: string,
  input: CalendarEventSourceSnapshot,
  options: { refreshIndexes?: boolean } = {},
): Promise<SourceWikiFile | null> {
  const suffix = stableEntityPath("event", `${input.calendarId}:${input.eventId}`);
  if ((input.status ?? "").toLowerCase() === "cancelled") {
    await enqueueGraphDeletesForMatchingMirrorFiles(userId, sql`
      SELECT path
      FROM mirror_files
      WHERE user_id = ${userId}
        AND path LIKE ${`${CALENDAR_SOURCE_ROOT}/%--${suffix}.md`}
    `);
    await db.execute(sql`
      DELETE FROM mirror_files
      WHERE user_id = ${userId}
        AND path LIKE ${`${CALENDAR_SOURCE_ROOT}/%--${suffix}.md`}
    `);
    if (options.refreshIndexes !== false) await materializeSourceWikiIndexes(userId);
    return null;
  }

  const startDate = calendarDateValue(input.start);
  const bucket = startDate
    ? `${startDate.getUTCFullYear()}/${String(startDate.getUTCMonth() + 1).padStart(2, "0")}`
    : "undated";
  const dayPrefix = startDate ? `${startDate.toISOString().slice(0, 10)}--` : "";
  const file: SourceWikiFile = {
    path: `${CALENDAR_SOURCE_ROOT}/${bucket}/${dayPrefix}${gmailPathSegment(input.summary, "untitled-event", 60)}--${suffix}.md`,
    content: renderCalendarEvent(input, startDate),
    meta: calendarEventMeta(input),
  };
  await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  await enqueueGraphDeletesForMatchingMirrorFiles(userId, sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${CALENDAR_SOURCE_ROOT}/%--${suffix}.md`}
      AND path <> ${file.path}
  `);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${CALENDAR_SOURCE_ROOT}/%--${suffix}.md`}
      AND path <> ${file.path}
  `);
  if (options.refreshIndexes !== false) {
    await materializeSourceWikiIndexes(userId, [file]);
  }
  return file;
}

function calendarEventMeta(input: CalendarEventSourceSnapshot): StagedDocumentMeta {
  const payload = input.rawPayload;
  const organizer = objectValue(payload.organizer);
  const creator = objectValue(payload.creator);
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const hasHumanAttendee = calendarHumanAttendeeSignal(attendees);
  const rawEvent = objectValue(payload.rawEvent);
  // A Cal.com booking duplicates one real meeting across two gcal event ids;
  // the shared cal.com/video|booking UID is the deterministic join key the
  // graph writer converges on (see src/mirror/calcom.ts). Scan order:
  // conference data, location, description, hangoutLink — first match wins.
  const calcomUid = calcomBookingUid(
    payload.conferenceData == null ? null : JSON.stringify(payload.conferenceData),
    stringValue(payload.location),
    stringValue(payload.description),
    stringValue(payload.hangoutLink),
  );
  return stagedDocumentMeta({
    provider: "calendar",
    externalId: `${input.calendarId}:${input.eventId}`,
    kind: "document",
    title: stringValue(input.summary) ?? "(untitled event)",
    versionRef: dateText(payload.updated) ?? dateText(input.sourceUpdatedAt),
    sourceUpdatedAt: input.sourceUpdatedAt,
    authorEmail: calendarPersonEmail(creator) ?? calendarPersonEmail(organizer),
    authorName: calendarPersonName(creator) ?? calendarPersonName(organizer),
    sourceAcl: {
      calendarId: input.calendarId,
      visibility: stringValue(rawEvent?.visibility) ?? null,
      // The graph needs only a deterministic participation classification,
      // never attendee records. `false` is retained by the envelope
      // compactor; ambiguous participant shapes omit the signal entirely.
      ...(hasHumanAttendee === null ? {} : { hasHumanAttendee }),
    },
    aliases: [
      { kind: "gcal_event", value: input.eventId },
      ...(calcomUid ? [{ kind: CALCOM_BOOKING_ALIAS_KIND, value: calcomUid }] : []),
      ...emailAliases(
        calendarPersonEmail(organizer),
        calendarPersonEmail(creator),
        ...attendees.map((attendee) => calendarPersonEmail(objectValue(attendee))),
      ),
    ],
    sourceRefs: [{
      anchor: "Description",
      sourceEventId: `gcal:${input.calendarId}:${input.eventId}`,
      url: stringValue(payload.htmlLink) ?? undefined,
    }],
  });
}

function calendarHumanAttendeeSignal(attendees: readonly unknown[]): boolean | null {
  let ambiguous = false;
  for (const attendee of attendees) {
    const participant = objectValue(attendee);
    if (!participant) {
      ambiguous = true;
      continue;
    }
    const kind = classifyGoogleCalendarParticipant(participant);
    if (kind === "human") return true;
    if (kind === "unknown") ambiguous = true;
  }
  return ambiguous ? null : false;
}

function calendarPersonEmail(record: Record<string, unknown> | null): string | null {
  return stringValue(record?.email) ?? null;
}

function calendarPersonName(record: Record<string, unknown> | null): string | null {
  return stringValue(record?.name) ?? stringValue(record?.displayName);
}

function calendarDateValue(value: unknown): Date | null {
  if (!isRecord(value)) return null;
  const raw = stringValue(value.dateTime) ?? stringValue(value.date);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function renderCalendarEvent(input: CalendarEventSourceSnapshot, startDate: Date | null): string {
  const payload = input.rawPayload;
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const organizer = isRecord(payload.organizer)
    ? stringValue(payload.organizer.email) ?? stringValue(payload.organizer.displayName)
    : null;
  return [
    `# ${headingText(stringValue(input.summary) ?? "(untitled event)")}`,
    "",
    sourceMetadata([
      ["Source", "Google Calendar"],
      ["Calendar", input.calendarId],
      ["Event ID", input.eventId],
      ["Status", stringValue(input.status)],
      ["Type", stringValue(input.eventType)],
      ["Start", startDate ? startDate.toISOString() : stringValue((input.start as Record<string, unknown> | undefined)?.date as string)],
      ["End", calendarDateValue(input.end)?.toISOString() ?? null],
      ["Organizer", organizer],
      ["Location", stringValue(payload.location)],
      ["Recurring event", stringValue(payload.recurringEventId)],
      ["Recurrence", Array.isArray(payload.recurrence) ? payload.recurrence.join("; ") : null],
      ["Meet/URL", stringValue(payload.hangoutLink) ?? stringValue(payload.htmlLink)],
      ["Updated", dateText(input.sourceUpdatedAt)],
    ]),
    "",
    "## Attendees",
    "",
    attendees.length > 0
      ? attendees.map((attendee) => {
        if (!isRecord(attendee)) return "";
        const who = stringValue(attendee.email) ?? stringValue(attendee.displayName) ?? "unknown";
        const details = [
          stringValue(attendee.responseStatus) ? `RSVP: ${inlineText(String(attendee.responseStatus))}` : null,
          typeof attendee.resource === "boolean" ? `Resource: ${attendee.resource}` : null,
          attendee.organizer === true ? "Organizer: true" : null,
        ].filter(Boolean);
        return `- ${inlineText(who)}${details.length > 0 ? ` - ${details.join(" - ")}` : ""}`;
      }).filter(Boolean).join("\n")
      : "- No attendee list.",
    "",
    "## Description",
    "",
    bodyText(stringValue(payload.description), "_No description._"),
  ].join("\n");
}

export function gmailMessageSourcePath(
  gmailId: string,
  meta: {
    timestamp?: string | Date | null;
    fromEmail?: string | null;
    fromName?: string | null;
    subject?: string | null;
    labelIds?: readonly string[] | null;
  } = {},
): string {
  const labels = new Set(meta.labelIds ?? []);
  // Mailbox-style top level; volatile labels and category tabs do not enter
  // the rendered body.
  const box = labels.has("SENT") ? "sent" : labels.has("INBOX") ? "inbox" : "archive";
  const date = meta.timestamp instanceof Date ? meta.timestamp : new Date(String(meta.timestamp ?? ""));
  const dated = !Number.isNaN(date.getTime());
  const bucket = dated
    ? `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`
    : "undated";
  const dayPrefix = dated ? `${date.toISOString().slice(0, 10)}--` : "";
  const senderSlug = gmailPathSegment(gmailSenderLabel(meta.fromEmail, meta.fromName), "unknown-sender", 40);
  const subjectSlug = gmailPathSegment(meta.subject, "no-subject", 60);
  return `${GMAIL_SOURCE_ROOT}/${box}/${bucket}/${dayPrefix}${senderSlug}--${subjectSlug}--${stableEntityPath("message", gmailId)}.md`;
}

export async function materializeSourceWikiIndexes(
  userId: string,
  additionalFiles: readonly SourceWikiFile[] = [],
): Promise<SourceWikiFile[]> {
  const sourcePaths = await listSourceWikiPaths(userId);
  const allPaths = new Set(sourcePaths);
  for (const file of additionalFiles) {
    allPaths.add(normalizeSourcePath(file.path));
  }

  const providerIndexes = SOURCE_PROVIDERS.map((provider) => ({
    provider,
    items: provider.key === "gmail"
      ? gmailMessageIndexItems(allPaths)
      : providerIndexItems(provider.root, allPaths),
  }));
  const files: SourceWikiFile[] = [
    {
      path: `${SOURCES_ROOT}/index.md`,
      content: renderSourcesRootIndex(providerIndexes),
    },
    ...providerIndexes.map(({ provider, items }) => ({
      path: `${provider.root}/index.md`,
      content: provider.key === "gmail"
        ? renderGmailProviderIndex(provider.title, provider.description, allPaths)
        : renderSourceProviderIndex(provider.title, provider.description, provider.root, items),
    })),
  ];

  for (const file of files) {
    await upsertSourceWikiFile(userId, file.path, file.content);
  }
  return files;
}

export async function deleteSourceWikiPrefix(userId: string, prefix: string): Promise<void> {
  const normalized = normalizeSourcePath(prefix).replace(/\/+$/u, "");
  await enqueueGraphDeletesForMatchingMirrorFiles(userId, sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND (path = ${normalized} OR path LIKE ${`${normalized}/%`})
  `);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND (path = ${normalized} OR path LIKE ${`${normalized}/%`})
  `);
}

export async function deleteNotionPageSourceWiki(userId: string, pageId: string): Promise<void> {
  await deleteSourceWikiEntityDirectories(userId, NOTION_SOURCE_ROOT, stableEntityPath("page", pageId));
  await materializeSourceWikiIndexes(userId);
}

export async function deleteGranolaMeetingSourceWiki(userId: string, meetingId: string): Promise<void> {
  await deleteSourceWikiEntityDirectories(userId, GRANOLA_SOURCE_ROOT, stableEntityPath("meeting", meetingId));
  await materializeSourceWikiIndexes(userId);
}

export function googleDocSourceDirectory(docId: string, title?: string | null): string {
  return titledEntityDirectory(GOOGLE_DOCS_SOURCE_ROOT, title, "Untitled Google Doc", "doc", docId);
}

export function notionPageSourceDirectory(pageId: string, title?: string | null): string {
  return titledEntityDirectory(NOTION_SOURCE_ROOT, title, "Untitled Notion Page", "page", pageId);
}

export function granolaMeetingSourceDirectory(meetingId: string, title?: string | null): string {
  return titledEntityDirectory(GRANOLA_SOURCE_ROOT, title, "Untitled Granola Meeting", "meeting", meetingId);
}

async function replaceSourceWikiDirectory(
  userId: string,
  directory: string,
  files: SourceWikiFile[],
  stableEntity?: { sourceRoot: string; entitySuffix: string },
  options: { keepPaths?: readonly string[] } = {},
): Promise<void> {
  const normalizedDirectory = normalizeSourcePath(directory).replace(/\/+$/u, "");
  const normalizedFiles = files.map((file) => ({
    path: normalizeSourcePath(file.path),
    content: markdownFile(file.content),
    meta: file.meta ?? null,
  }));
  for (const file of normalizedFiles) {
    if (!file.path.startsWith(`${normalizedDirectory}/`)) {
      throw new Error(`source wiki file ${file.path} is outside ${normalizedDirectory}`);
    }
    if (!file.path.endsWith(".md")) {
      throw new Error(`source wiki file must be markdown: ${file.path}`);
    }
  }

  for (const file of normalizedFiles) {
    await upsertSourceWikiFile(userId, file.path, file.content, file.meta);
  }

  const keptPaths = [
    ...normalizedFiles.map((file) => file.path),
    ...(options.keepPaths ?? []).map((path) => normalizeSourcePath(path)),
  ];
  if (keptPaths.length === 0) {
    await deleteSourceWikiPrefix(userId, normalizedDirectory);
    return;
  }

  await enqueueGraphDeletesForMatchingMirrorFiles(userId, sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${normalizedDirectory}/%`}
      AND path NOT IN (${sql.join(keptPaths.map((path) => sql`${path}`), sql`, `)})
  `);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${normalizedDirectory}/%`}
      AND path NOT IN (${sql.join(keptPaths.map((path) => sql`${path}`), sql`, `)})
  `);

  if (stableEntity) {
    await deleteSourceWikiEntityDirectories(
      userId,
      stableEntity.sourceRoot,
      stableEntity.entitySuffix,
      normalizedDirectory,
    );
  }
}

async function upsertSourceWikiFile(
  userId: string,
  path: string,
  content: string,
  meta?: StagedDocumentMeta | null,
): Promise<void> {
  const normalizedPath = normalizeSourcePath(path);
  const normalizedContent = markdownFile(content);
  const contentSha = wikiContentSha(normalizedContent);
  // versionRef falls back to the rendered content sha for sources without a
  // native version identity (plan §3: "content sha acceptable fallback").
  const normalizedMeta = meta
    ? (meta.versionRef ? meta : { ...meta, versionRef: contentSha })
    : null;
  const metaJson = normalizedMeta ? JSON.stringify(normalizedMeta) : null;
  const metaSha = metaJson ? createHash("sha256").update(metaJson).digest("hex") : null;
  // Meta-less writes (index files) must never clobber an existing envelope.
  // updated_at only advances on content change (the CASE below). JSONB
  // meta_sha IS DISTINCT FROM is the envelope-only comparison: meta-only changes are
  // returned and enqueue a metadata refresh, while the graph's content hash
  // short-circuit prevents re-chunking unchanged bytes.
  const changedRows = rowsFromExecute<{ path: string; updated_at?: Date | string | null; content_changed?: boolean }>(await db.execute(sql`
    INSERT INTO mirror_files (path, user_id, content, content_sha, meta, meta_sha, updated_at)
    VALUES (${normalizedPath}, ${userId}, ${normalizedContent}, ${contentSha}, ${metaJson}::jsonb, ${metaSha}, NOW())
    ON CONFLICT (user_id, path) DO UPDATE
    SET content = EXCLUDED.content,
        content_sha = EXCLUDED.content_sha,
        meta = COALESCE(EXCLUDED.meta, mirror_files.meta),
        meta_sha = COALESCE(EXCLUDED.meta_sha, mirror_files.meta_sha),
        updated_at = CASE
          WHEN mirror_files.content IS DISTINCT FROM EXCLUDED.content THEN NOW()
          ELSE mirror_files.updated_at
        END
    WHERE mirror_files.content_sha IS DISTINCT FROM EXCLUDED.content_sha
       OR mirror_files.content IS DISTINCT FROM EXCLUDED.content
       OR (EXCLUDED.meta_sha IS NOT NULL AND mirror_files.meta_sha IS DISTINCT FROM EXCLUDED.meta_sha)
    RETURNING path, updated_at, (updated_at = now()) AS content_changed
  `));
  const changedRow = changedRows[0];
  if (changedRow) {
    await enqueueGraphIngestForMirrorFile(db, {
      tenantId: userId,
      path: normalizedPath,
      contentSha,
      meta: normalizedMeta,
      metadataOnly: changedRow.content_changed !== true,
    });
  }
}

async function listSourceWikiPaths(userId: string): Promise<string[]> {
  const result = await db.execute<{ path: string }>(sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND path LIKE ${`${SOURCES_ROOT}/%`}
    ORDER BY path ASC
  `);
  return rowsFromExecute<{ path: string }>(result)
    .map((row) => row.path)
    .filter((path) => typeof path === "string" && path.startsWith(`${SOURCES_ROOT}/`));
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function providerIndexItems(root: string, paths: ReadonlySet<string>): Array<{ label: string; href: string }> {
  const prefix = `${root}/`;
  const items = new Map<string, { label: string; href: string }>();
  for (const path of [...paths].sort()) {
    if (!path.startsWith(prefix) || !path.endsWith(".md")) continue;
    const relative = path.slice(prefix.length);
    if (!relative || relative === "index.md") continue;
    const directChild = relative.split("/")[0];
    if (!directChild) continue;

    const isMarkdownFile = directChild.endsWith(".md");
    const itemKey = directChild;
    if (items.has(itemKey)) continue;

    const href = isMarkdownFile
      ? directChild
      : pathExists(paths, `${root}/${directChild}/summary.md`)
        ? `${directChild}/summary.md`
        : `${directChild}/index.md`;
    items.set(itemKey, {
      label: sourceIndexLabel(directChild),
      href,
    });
  }
  return [...items.values()].sort((a, b) => a.label.localeCompare(b.label) || a.href.localeCompare(b.href));
}

function pathExists(paths: ReadonlySet<string>, path: string): boolean {
  return paths.has(path);
}

function renderSourcesRootIndex(
  providers: Array<{ provider: (typeof SOURCE_PROVIDERS)[number]; items: Array<{ label: string; href: string }> }>,
): string {
  return [
    "# Sources",
    "",
    "Deterministic source mirror generated from connected provider data. Do not edit by hand.",
    "",
    "## Providers",
    "",
    providers.map(({ provider, items }) => (
      `- [${provider.title}](${provider.key}/index.md): ${items.length} item${items.length === 1 ? "" : "s"}`
    )).join("\n"),
  ].join("\n");
}

function renderSourceProviderIndex(
  title: string,
  description: string,
  root: string,
  items: Array<{ label: string; href: string }>,
): string {
  return [
    `# ${title}`,
    "",
    description,
    "",
    "This directory is generated from provider data. Do not edit by hand.",
    "",
    "## Items",
    "",
    items.length > 0
      ? items.map((item) => `- [${inlineText(item.label)}](${item.href})`).join("\n")
      : `- No ${sourceIndexLabel(root.split("/").at(-1) ?? "source")} source files have been materialized yet.`,
  ].join("\n");
}

function sourceIndexLabel(value: string): string {
  return value
    .replace(/\.md$/u, "")
    .replace(/-(doc|page|meeting|session|tab|section)-[a-f0-9]{12}$/u, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    || value;
}

function renderGoogleDocSummary(
  input: {
    docId: string;
    title: string;
    overview: string;
    lastUpdated?: string | Date | null;
  },
  tabs: GoogleDocTabSummary[],
): string {
  return [
    `# ${headingText(input.title || "Untitled Google Doc")}`,
    "",
    sourceMetadata([
      ["Source", "Google Docs"],
      ["Document ID", input.docId],
      ["Last updated", dateText(input.lastUpdated)],
    ]),
    "",
    "## Overview",
    "",
    bodyText(input.overview, "No document overview has been generated yet."),
    "",
    "## Tabs",
    "",
    tabs.length > 0
      ? tabs.map((tab) => `- [${inlineText(tab.tabName || tab.tabId)}](tabs/${stableEntityPath("tab", tab.tabId)}.md)`).join("\n")
      : "- No tab summaries have been generated yet.",
  ].join("\n");
}

function googleDocTabMeta(
  input: {
    docId: string;
    title: string;
    lastUpdated?: string | Date | null;
    authorEmail?: string | null;
    authorName?: string | null;
    updatedByEmail?: string | null;
  },
  tab: { tabId: string; tabName: string },
  tabContent: GoogleDocTabContent | null,
  revisionId: string | null,
  sourceAcl: Record<string, unknown>,
): StagedDocumentMeta {
  const docTitle = stringValue(input.title);
  // Snapshot-backed backfills can legitimately render different tabs from
  // different latest revisions (for example, a tab removed in a later
  // revision). Use the row's exact key, never a document-wide best guess.
  const snapshotRevisionId = stringValue(tabContent?.revisionId) ?? revisionId;
  const tabUrl = `${googleDocUrl(input.docId)}?tab=${encodeURIComponent(tab.tabId)}`;
  const sourceEventId = googleDocSnapshotSourceEventId(input.docId, tab.tabId, snapshotRevisionId);
  const sourceRefs: StagedDocumentSourceRef[] = [{
    anchor: "Content",
    sourceEventId,
    url: tabUrl,
  }];
  // Pending suggestions are rendered as their own headings and are captured
  // inside this immutable tab snapshot. Activity records do not expose the
  // Docs API suggestionId, so the snapshot is the only exact non-guessed ref.
  if (snapshotRevisionId) {
    for (const suggestion of tabContent?.suggestions ?? []) {
      const suggestionId = stringValue(suggestion.suggestionId);
      if (!suggestionId || (!suggestion.insertedText && !suggestion.deletedText)) continue;
      sourceRefs.push({
        anchor: `Suggestion ${suggestionId}`,
        sourceEventId,
        url: tabUrl,
      });
    }
  }
  return stagedDocumentMeta({
    provider: "google-docs",
    externalId: `${input.docId}:${tab.tabId}`,
    kind: "document",
    title: docTitle && docTitle !== tab.tabName ? `${docTitle} - ${tab.tabName}` : tab.tabName,
    versionRef: snapshotRevisionId,
    sourceUpdatedAt: input.lastUpdated,
    authorEmail: input.authorEmail,
    authorName: input.authorName,
    updatedByEmail: input.updatedByEmail,
    sourceAcl,
    aliases: emailAliases(input.authorEmail, input.updatedByEmail),
    sourceRefs,
  });
}

/**
 * Captured Drive folder lineage plus best-effort Drive access principals for
 * a doc. Folder lineage reads already-captured google_doc_sync_state rows;
 * permissions.list failures leave principal fields absent and never block
 * the mirror write.
 */
async function googleDocFolderAcl(userId: string, docId: string): Promise<Record<string, unknown>> {
  const acl: Record<string, unknown> = {};
  try {
    const result = (await db.execute(sql`
      SELECT folder_ids
      FROM google_doc_sync_state
      WHERE user_id = ${userId}
        AND doc_id = ${docId}
      LIMIT 1
    `)) as unknown;
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{ folder_ids?: unknown }>;
    const folderIds = rows[0]?.folder_ids;
    if (Array.isArray(folderIds) && folderIds.length > 0) {
      acl.driveFolderIds = folderIds.map(String);
    }
  } catch {
    // folder scoping is best-effort
  }
  // Access principals: person↔document linking is premised on ACCESS
  // (product decision 2026-07-12). Best-effort Drive permissions fetch —
  // failures leave the ACL fields absent, never block the mirror write.
  try {
    const { getGoogleAccessToken } = await import("../vault/google-auth.js");
    const token = await getGoogleAccessToken(userId);
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/permissions?fields=permissions(emailAddress,role,type)&supportsAllDrives=true&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (response.ok) {
      const data = await response.json() as { permissions?: Array<{ emailAddress?: string; role?: string; type?: string }> };
      const readers: string[] = [];
      const writers: string[] = [];
      for (const permission of data.permissions ?? []) {
        const email = permission.emailAddress?.trim().toLowerCase();
        if (!email || (permission.type !== "user" && permission.type !== "group")) continue;
        if (permission.role === "owner" || permission.role === "writer" || permission.role === "fileOrganizer" || permission.role === "organizer") writers.push(email);
        else readers.push(email);
      }
      if (readers.length > 0) acl.readers = [...new Set(readers)];
      if (writers.length > 0) acl.writers = [...new Set(writers)];
    }
  } catch {
    // permission fetch is best-effort
  }
  return acl;
}

function googleDocUrl(docId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(docId)}/edit`;
}

/**
 * Existing Google Docs source-ref vocabulary, qualified by the immutable
 * snapshot revision when the renderer has one. Revisionless legacy renders
 * deliberately retain their old identifier rather than inventing a version.
 */
function googleDocSnapshotSourceEventId(
  docId: string,
  tabId: string | null,
  revisionId: string | null,
): string {
  return ["gdoc", docId, ...(tabId ? [tabId] : []), ...(revisionId ? [revisionId] : [])].join(":");
}

function renderGoogleDocTab(
  input: { docId: string; title: string },
  tab: GoogleDocTabSummary,
  tabContent: GoogleDocTabContent | null,
): string {
  const content = stringValue(tabContent?.content) ?? "";
  const suggestions = (tabContent?.suggestions ?? []).filter(
    (s) => s.insertedText || s.deletedText,
  );
  const suggestionsHidden = tabContent?.suggestionsAccessible === false;
  const lines = [
    `# ${headingText(tab.tabName || "Untitled Tab")}`,
    "",
    sourceMetadata([
      ["Source", "Google Docs"],
      ["Document", input.title || input.docId],
      ["Document ID", input.docId],
      ["Tab ID", tab.tabId],
      ["Content hash", tab.contentHash ?? null],
      ["Pending suggestions", suggestions.length > 0 ? String(suggestions.length) : null],
      ["Suggestions", suggestionsHidden ? "not visible (view-only access to this document)" : null],
      ["Rendering", "best-effort markdown - VERIFY against ../raw.md"],
    ]),
    "",
    "> This is a lossy markdown projection of the document. Lists, styling, and",
    "> tables are rendered best-effort and may not match the source exactly;",
    "> some structure (footnotes, equations, positioned objects, merged cells,",
    "> colors/fonts) is dropped. The complete, faithful content is `raw.md`",
    "> in the document directory. **Verify the markdown against `raw.md`",
    "> before relying on structural fidelity.**",
    "",
    "## Content",
    "",
    bodyText(content, "_No tab content was captured for this tab._"),
  ];
  if (suggestions.length > 0) {
    lines.push("", "## Pending suggestions", "");
    for (const suggestion of suggestions) {
      lines.push(`### Suggestion ${suggestion.suggestionId}`, "");
      const before = suggestion.contextBefore?.trim();
      const after = suggestion.contextAfter?.trim();
      if (before || after) {
        lines.push(`Location: …${before ?? ""} ⟦here⟧ ${after ?? ""}…`, "");
      }
      if (suggestion.deletedText) {
        lines.push("Proposes deleting:", "", quoteBlock(suggestion.deletedText), "");
      }
      if (suggestion.insertedText) {
        lines.push("Proposes inserting:", "", quoteBlock(suggestion.insertedText), "");
      }
    }
    while (lines[lines.length - 1] === "") lines.pop();
  }
  return lines.join("\n");
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function renderNotionPageSummary(
  input: {
    pageId: string;
    title: string;
    url?: string | null;
    parentType?: string | null;
    parentId?: string | null;
    dataSourceId?: string | null;
    overview: string;
    sourceMarkdown?: string | null;
    contentHash?: string | null;
    lastEditedTime?: string | Date | null;
    markdownTruncated?: boolean;
    structuredIngestion?: boolean;
    warnings?: Array<{ code?: string; message?: string; blockId?: string | null; type?: string | null }> | null;
    references?: Array<{ kind?: string; targetId?: string | null; title?: string | null; url?: string | null }> | null;
  },
  sections: NotionSectionSummary[],
  rowPages: NotionRowPageSource[],
  childPages: NotionChildPageSource[],
): string {
  const nestedPageLines = [
    ...rowPages.map((rowPage) => `- [${inlineText(rowPage.title || rowPage.pageId)}](${rowPage.relativePath}) (database row in ${inlineText(rowPage.dataSourceTitle)})`),
    ...childPages.map((childPage) => `- [${inlineText(childPage.title || childPage.pageId)}](${childPage.relativePath}) (child page)`),
  ];
  return [
    `# ${headingText(input.title || "Untitled Notion Page")}`,
    "",
    sourceMetadata([
      ["Source", "Notion"],
      ["Page ID", input.pageId],
      ["URL", input.url ?? null],
      ["Parent", [input.parentType, input.parentId].filter(Boolean).join(": ") || null],
      ["Data source ID", input.dataSourceId ?? null],
      ["Last edited", dateText(input.lastEditedTime)],
      ["Content hash", input.contentHash ?? null],
      ["Structured ingestion", input.structuredIngestion === undefined ? null : input.structuredIngestion ? "yes" : "no"],
      ["Markdown truncated", input.markdownTruncated ? "yes" : null],
      ["Processed content", stringValue(input.sourceMarkdown) ? "[content.md](content.md)" : null],
    ]),
    "",
    "## Overview",
    "",
    bodyText(input.overview, "No page overview has been generated yet."),
    "",
    "## Sections",
    "",
    sections.length > 0
      ? sections.map((section) => `- [${inlineText(section.sectionTitle || section.sectionId)}](sections/${stableEntityPath("section", section.sectionId)}.md)`).join("\n")
      : "- No section summaries have been generated yet.",
    "",
    "## Nested Pages",
    "",
    nestedPageLines.length > 0
      ? nestedPageLines.join("\n")
      : "- No content-bearing nested pages were materialized.",
    "",
    "## References",
    "",
    renderNotionReferences(input.references),
    "",
    "## Processing Warnings",
    "",
    renderNotionWarnings(input.warnings),
  ].join("\n");
}

function renderNotionPageContentFile(
  input: {
    pageId: string;
    title: string;
    url?: string | null;
    sourceMarkdown?: string | null;
    contentHash?: string | null;
    lastEditedTime?: string | Date | null;
    markdownTruncated?: boolean;
    structuredIngestion?: boolean;
    warnings?: Array<{ code?: string; message?: string; blockId?: string | null; type?: string | null }> | null;
  },
): string {
  return [
    `# Content: ${headingText(input.title || "Untitled Notion Page")}`,
    "",
    sourceMetadata([
      ["Source", "Notion"],
      ["Page ID", input.pageId],
      ["URL", input.url ?? null],
      ["Last edited", dateText(input.lastEditedTime)],
      ["Content hash", input.contentHash ?? null],
      ["Structured ingestion", input.structuredIngestion === undefined ? null : input.structuredIngestion ? "yes" : "no"],
      ["Markdown truncated", input.markdownTruncated ? "yes" : null],
    ]),
    "",
    "## Processed Markdown",
    "",
    bodyText(input.sourceMarkdown, "No processed Notion Markdown was available."),
  ].join("\n");
}

function renderNotionSectionSummary(
  input: { pageId: string; title: string; url?: string | null },
  section: NotionSectionSummary,
): string {
  return [
    `# ${headingText(section.sectionTitle || "Untitled Section")}`,
    "",
    sourceMetadata([
      ["Source", "Notion"],
      ["Page", input.title || input.pageId],
      ["Page ID", input.pageId],
      ["URL", input.url ?? null],
      ["Section ID", section.sectionId],
      ["Section kind", section.sectionKind ?? null],
      ["Anchor block ID", section.anchorBlockId ?? null],
      ["Root block IDs", Array.isArray(section.rootBlockIds) && section.rootBlockIds.length ? section.rootBlockIds.join(", ") : null],
      ["Warning codes", Array.isArray(section.warningCodes) && section.warningCodes.length ? section.warningCodes.join(", ") : null],
      ["Content hash", section.contentHash ?? null],
    ]),
    "",
    "## Source Content",
    "",
    bodyText(section.sourceContent ?? null, "No processed section content was captured for this summary."),
    "",
    "## Summary",
    "",
    bodyText(section.summary, "No section summary has been generated yet."),
    "",
    "## Structured Facts",
    "",
    fencedJson(section.structuredFacts, "No structured section facts were captured for this summary."),
  ].join("\n");
}

function renderNotionRowPageSourceFile(rowPage: NotionRowPageSource): string {
  return [
    bodyText(rowPage.sourceContent, `# ${headingText(rowPage.title || "Untitled Notion page")}`),
    "",
    "## Source Metadata",
    "",
    sourceMetadata([
      ["Source", "Notion nested page"],
      ["Page ID", rowPage.pageId],
      ["URL", rowPage.url ?? null],
      ["Parent data source", rowPage.dataSourceTitle],
      ["Parent data source ID", rowPage.dataSourceId],
      ["Content hash", rowPage.contentHash ?? null],
    ]),
    "",
    "## Structured Facts",
    "",
    fencedJson(rowPage.structuredFacts, "No structured nested-page facts were captured for this row page."),
  ].join("\n");
}

function renderNotionChildPageSourceFile(childPage: NotionChildPageSource): string {
  return [
    bodyText(childPage.sourceContent ?? null, `# ${headingText(childPage.title || "Untitled Notion child page")}`),
    "",
    "## Source Metadata",
    "",
    sourceMetadata([
      ["Source", "Notion child page"],
      ["Page ID", childPage.pageId],
      ["URL", childPage.url ?? null],
      ["Parent block ID", childPage.parentBlockId ?? null],
      ["Content hash", childPage.contentHash ?? null],
    ]),
    "",
    "## Structured Facts",
    "",
    fencedJson(childPage.structuredFacts, "No structured nested-page facts were captured for this child page."),
  ].join("\n");
}


function renderGmailMessage(
  input: GmailMessageSourcePayload,
  gmailId: string,
): string {
  const payload = input.rawPayload;
  const subject = stringValue(payload.subject) ?? "(no subject)";
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const rawBody = stringValue(payload.bodyMarkdown)
    ?? stringValue(payload.bodyText)
    ?? stringValue(payload.snippet)
    ?? "";
  const truncated = rawBody.length > GMAIL_BODY_MAX_CHARS;
  const body = truncated ? rawBody.slice(0, GMAIL_BODY_MAX_CHARS) : rawBody;
  return [
    `# ${headingText(subject)}`,
    "",
    sourceMetadata([
      ["Source", "Gmail"],
      ["From", stringValue(payload.from)],
      ["To", stringValue(payload.to)],
      ["Cc", stringValue(payload.cc)],
      ["Date", dateText(payload.date ?? input.timestamp)],
      ["Subject", stringValue(payload.subject)],
      ["Gmail ID", gmailId],
      ["Thread ID", stringValue(payload.threadId)],
      ["Message-ID", stringValue(payload.messageId)],
      ["In reply to", stringValue(payload.inReplyTo)],
      ["Event ID", input.eventId ?? null],
      ["Source event ID", input.sourceEventId],
      ["Body source", stringValue(payload.bodySource)],
    ]),
    "",
    "## Attachments",
    "",
    attachments.length > 0
      ? attachments.map(renderGmailAttachmentItem).filter(Boolean).join("\n")
      : "- No attachments.",
    "",
    "## Body",
    "",
    bodyText(body, "_No message body was available._"),
    ...(truncated
      ? ["", `_Body truncated at ${GMAIL_BODY_MAX_CHARS} characters; the full text lives on the raw event (${input.sourceEventId})._`]
      : []),
  ].join("\n");
}

function renderGmailAttachmentItem(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const row = item as Record<string, unknown>;
  const filename = stringValue(row.filename) ?? "unnamed attachment";
  const details = [
    stringValue(row.mimeType),
    typeof row.size === "number" && Number.isFinite(row.size) ? `${row.size} bytes` : null,
  ].filter(Boolean).join(", ");
  return `- ${inlineText(filename)}${details ? ` (${details})` : ""}`;
}

function gmailSenderLabel(fromEmail: string | null | undefined, fromName: string | null | undefined): string | null {
  const email = stringValue(fromEmail);
  if (email) {
    const address = email.includes("<") ? email.slice(email.indexOf("<") + 1).replace(/>.*$/u, "") : email;
    const localPart = address.split("@")[0];
    if (localPart?.trim()) return localPart;
  }
  return stringValue(fromName);
}

function gmailPathSegment(value: string | null | undefined, fallback: string, maxLength: number): string {
  const slug = slugify((value ?? "").trim()).slice(0, maxLength).replace(/-+$/u, "");
  return slug || fallback;
}

function gmailMessagePaths(paths: ReadonlySet<string>): string[] {
  const prefix = `${GMAIL_SOURCE_ROOT}/`;
  return [...paths]
    .filter((path) => path.startsWith(prefix) && path.endsWith(".md") && path !== `${GMAIL_SOURCE_ROOT}/index.md`)
    .sort();
}

function gmailMessageIndexItems(paths: ReadonlySet<string>): Array<{ label: string; href: string }> {
  return gmailMessagePaths(paths).map((path) => {
    const relative = path.slice(GMAIL_SOURCE_ROOT.length + 1);
    return { label: gmailMessageIndexLabel(relative), href: relative };
  });
}

function gmailMessageIndexLabel(relativePath: string): string {
  const filename = relativePath.split("/").at(-1) ?? relativePath;
  const parts = filename.replace(/\.md$/u, "").replace(/--message-[a-f0-9]{12}$/u, "").split("--");
  const dated = /^\d{4}-\d{2}-\d{2}$/u.test(parts[0] ?? "");
  const date = dated ? parts[0] : null;
  const sender = (dated ? parts[1] : parts[0]) ?? "unknown-sender";
  const subject = (dated ? parts.slice(2) : parts.slice(1)).join(" ") || "no subject";
  return [date, sender, subject.replace(/-/g, " ")].filter(Boolean).join(" - ");
}

function renderGmailProviderIndex(title: string, description: string, paths: ReadonlySet<string>): string {
  const messagePaths = gmailMessagePaths(paths);
  const boxCounts = new Map<string, number>();
  const monthCounts = new Map<string, number>();
  for (const path of messagePaths) {
    const relative = path.slice(GMAIL_SOURCE_ROOT.length + 1);
    const segments = relative.split("/");
    const box = segments.length > 1 ? segments[0]! : "archive";
    boxCounts.set(box, (boxCounts.get(box) ?? 0) + 1);
    const bucket = segments.slice(0, -1).join("/") || "undated";
    monthCounts.set(bucket, (monthCounts.get(bucket) ?? 0) + 1);
  }
  // Path order is box-first; recency lives in the dated filename.
  const recent = [...messagePaths]
    .sort((a, b) => (b.split("/").at(-1) ?? "").localeCompare(a.split("/").at(-1) ?? ""))
    .slice(0, GMAIL_INDEX_RECENT_MESSAGES);
  return [
    `# ${title}`,
    "",
    description,
    "",
    "This directory is generated from provider data. Do not edit by hand.",
    "",
    `Total messages: ${messagePaths.length}`,
    "",
    "## Messages by box",
    "",
    boxCounts.size > 0
      ? [...boxCounts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([box, count]) => `- ${box}: ${count} message${count === 1 ? "" : "s"}`)
        .join("\n")
      : "- No Gmail messages have been materialized yet.",
    "",
    "## Messages by month",
    "",
    monthCounts.size > 0
      ? [...monthCounts.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([bucket, count]) => `- ${bucket}: ${count} message${count === 1 ? "" : "s"}`)
        .join("\n")
      : "- No Gmail messages have been materialized yet.",
    "",
    `## Recent messages${messagePaths.length > recent.length ? ` (latest ${recent.length})` : ""}`,
    "",
    recent.length > 0
      ? recent.map((path) => {
        const relative = path.slice(GMAIL_SOURCE_ROOT.length + 1);
        return `- [${inlineText(gmailMessageIndexLabel(relative))}](${relative})`;
      }).join("\n")
      : "- No Gmail messages have been materialized yet.",
  ].join("\n");
}

function granolaMeetingMeta(
  input: GranolaMeetingSourcePayload,
  meetingId: string,
  title: string,
  anchor: string,
): StagedDocumentMeta {
  const payload = input.rawPayload;
  const calendarEvent = objectValue(payload.calendarEvent) ?? objectValue(payload.calendar_event);
  const calendarEventId = stringValue(payload.calendarEventId)
    ?? stringValue(payload.calendar_event_id)
    ?? stringValue(calendarEvent?.calendar_event_id)
    ?? stringValue(calendarEvent?.calendarEventId);
  const owner = objectValue(payload.owner);
  const ownerEmail = firstEmail(stringValue(owner?.email));
  const sourceUpdatedAt = stringValue(payload.updatedAt) ?? input.timestamp;
  const meetingStartTime = dateText(calendarEvent?.scheduled_start_time ?? calendarEvent?.scheduledStartTime)
    ?? dateText(input.timestamp)
    ?? dateText(sourceUpdatedAt);
  return stagedDocumentMeta({
    provider: "granola",
    externalId: meetingId,
    kind: "document",
    title,
    // Raw version-append keys granola notes on updatedAt; same ref here.
    versionRef: stringValue(payload.updatedAt),
    sourceUpdatedAt,
    meetingStartTime,
    // Granola exposes only the note owner as actor identity: the owner is the
    // creator and the only known editor of a personal meeting note.
    authorEmail: ownerEmail,
    authorName: stringValue(owner?.name),
    updatedByEmail: ownerEmail,
    aliases: [
      ...(calendarEventId ? [{ kind: "gcal_event", value: calendarEventId }] : []),
      ...granolaEmailAliases(payload),
    ],
    sourceRefs: [{
      anchor,
      sourceEventId: input.sourceEventId,
      url: stringValue(payload.webUrl) ?? undefined,
    }],
  });
}

/** Owner/attendee/invitee/speaker emails already present in the captured note payload. */
function granolaEmailAliases(payload: Record<string, unknown>): StagedDocumentAlias[] {
  const aliases: StagedDocumentAlias[] = [];
  const pushEmail = (value: unknown): void => {
    const email = firstEmail(stringValue(value));
    if (email) aliases.push({ kind: "email", value: email });
  };
  pushEmail(objectValue(payload.owner)?.email);
  for (const key of ["people", "attendees"]) {
    const rows = Array.isArray(payload[key]) ? payload[key] as unknown[] : [];
    for (const row of rows) {
      const record = objectValue(row);
      if (record) pushEmail(record.email);
    }
  }
  const calendarEvent = objectValue(payload.calendarEvent) ?? objectValue(payload.calendar_event);
  if (calendarEvent) {
    pushEmail(calendarEvent.organiser ?? calendarEvent.organizer);
    const invitees = Array.isArray(calendarEvent.invitees) ? calendarEvent.invitees : [];
    for (const invitee of invitees) pushEmail(objectValue(invitee)?.email);
  }
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  for (const item of transcript) {
    const speaker = objectValue(objectValue(item)?.speaker);
    if (speaker) pushEmail(speaker.email);
  }
  return aliases;
}

function renderGranolaSummary(input: GranolaMeetingSourcePayload): string {
  const payload = input.rawPayload;
  const title = stringValue(payload.title) ?? stringValue(payload.granolaId) ?? "Untitled Granola Meeting";
  const summary = [stringValue(payload.summaryMarkdown), stringValue(payload.summaryText)]
    .filter(Boolean)
    .join("\n\n");
  return [
    `# ${headingText(title)}`,
    "",
    sourceMetadata([
      ["Source", "Granola"],
      ["Meeting ID", stringValue(payload.granolaId) ?? input.sourceEventId.replace(/^granola:/, "")],
      ["Event ID", input.eventId ?? null],
      ["Source event ID", input.sourceEventId],
      ["URL", stringValue(payload.webUrl)],
      ["Created", dateText(payload.createdAt)],
      ["Updated", dateText(payload.updatedAt ?? input.timestamp)],
      ["Transcript", "[transcript.md](transcript.md)"],
    ]),
    "",
    "## Summary",
    "",
    bodyText(summary, "No Granola summary was available for this meeting."),
  ].join("\n");
}

function renderGranolaTranscript(input: GranolaMeetingSourcePayload): string {
  const payload = input.rawPayload;
  const owner = objectValue(payload.owner);
  const ownerLabel = stringValue(owner?.name) ?? firstEmail(stringValue(owner?.email));
  const title = stringValue(payload.title) ?? stringValue(payload.granolaId) ?? "Untitled Granola Meeting";
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  return [
    `# Transcript: ${headingText(title)}`,
    "",
    sourceMetadata([
      ["Source", "Granola"],
      ["Meeting ID", stringValue(payload.granolaId) ?? input.sourceEventId.replace(/^granola:/, "")],
      ["Event ID", input.eventId ?? null],
      ["Source event ID", input.sourceEventId],
      ["Updated", dateText(payload.updatedAt ?? input.timestamp)],
    ]),
    "",
    "## Transcript",
    "",
    transcript.length > 0
      ? transcript.map((item) => renderGranolaTranscriptItem(item, ownerLabel)).filter(Boolean).join("\n\n")
      : "_Transcript unavailable._",
  ].join("\n");
}

function renderGranolaTranscriptItem(item: unknown, ownerLabel: string | null): string {
  if (!item || typeof item !== "object") return "";
  const row = item as Record<string, unknown>;
  const text = stringValue(row.text);
  if (!text) return "";
  const speaker = granolaSpeakerLabel(row.speaker, ownerLabel);
  const start = stringValue(row.start_time);
  const end = stringValue(row.end_time);
  const timing = [start, end].filter(Boolean).join(" - ");
  return `${timing ? `**${inlineText(timing)}** ` : ""}${inlineText(speaker)}: ${text}`;
}

function granolaSpeakerLabel(value: unknown, ownerLabel: string | null): string {
  if (!value || typeof value !== "object") return "speaker_unknown";
  const record = value as Record<string, unknown>;
  const namedLabel = stringValue(record.name)
    ?? stringValue(record.email)
    ?? stringValue(record.diarization_label);
  if (namedLabel) return namedLabel;
  return stringValue(record.source)?.toLowerCase() === "microphone"
    ? ownerLabel ?? "speaker_unknown"
    : "speaker_unknown";
}

type BitbucketCommentEventRow = {
  id: string | number;
  event_type: string;
  source_event_id: string;
  raw_payload: unknown;
  timestamp: string | Date | null;
  source_updated_at: string | Date | null;
};

type BitbucketCommentState = {
  commentId: string;
  deleted: boolean;
  payload: Record<string, unknown>;
  sourceEventId: string;
  createdAt: string | null;
  updatedAt: string | null;
};

type BitbucketCommentCollection = {
  comments: BitbucketCommentState[];
  total: number;
  omitted: number;
};

async function latestBitbucketComments(
  userId: string,
  eventType: "issue_comment" | "pr_comment",
  repoFullName: string,
  parentId: string,
): Promise<BitbucketCommentCollection> {
  const sourceEventPrefix = `nango:bitbucket:${eventType}:${repoFullName}#${parentId}#`;
  const rows = rowsFromExecute<BitbucketCommentEventRow>(await db.execute(sql`
    SELECT id, event_type, source_event_id, raw_payload, timestamp, source_updated_at
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'bitbucket'
      AND event_type IN (${eventType}, ${`${eventType}.deleted`})
      AND starts_with(source_event_id, ${sourceEventPrefix})
    ORDER BY COALESCE(source_updated_at, timestamp) ASC, id ASC
  `));
  const byId = new Map<string, BitbucketCommentState>();
  for (const row of rows) {
    const payload = jsonPayload(row.raw_payload);
    if (!payload) continue;
    const commentId = idValue(payload.id) ?? bitbucketCommentIdFromSourceEvent(row.source_event_id, sourceEventPrefix);
    if (!commentId) continue;
    byId.set(commentId, {
      commentId,
      deleted: row.event_type.endsWith(".deleted")
        || payload.deleted === true
        || payload._deleted === true
        || isDeletedNangoPayload(payload),
      payload,
      sourceEventId: row.source_event_id,
      createdAt: dateText(payload.created_on ?? payload.createdAt) ?? dateText(row.timestamp),
      updatedAt: dateText(payload.updated_on ?? payload.updatedAt ?? payload.created_on ?? payload.createdAt)
        ?? dateText(row.source_updated_at)
        ?? dateText(row.timestamp),
    });
  }
  const live = [...byId.values()]
    .filter((state) => !state.deleted)
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? "") || left.commentId.localeCompare(right.commentId));
  const omitted = Math.max(0, live.length - BITBUCKET_COMMENTS_MAX);
  return {
    comments: live.slice(omitted),
    total: live.length,
    omitted,
  };
}

function bitbucketCommentIdFromSourceEvent(sourceEventId: string, prefix: string): string | null {
  if (!sourceEventId.startsWith(prefix)) return null;
  return stringValue(sourceEventId.slice(prefix.length).split(":", 1)[0]);
}

function renderBitbucketPullRequest(
  input: BitbucketPullRequestSourcePayload,
  comments: BitbucketCommentCollection,
): string {
  const payload = input.rawPayload;
  const title = stringValue(payload.title) ?? `Pull request ${input.pullRequestId}`;
  const lines = [
    `# ${headingText(title)}`,
    "",
    sourceMetadata([
      ["Source", "Bitbucket"],
      ["Repository", input.repoFullName],
      ["Pull request", input.pullRequestId],
      ["State", stringValue(payload.state)],
      ["Author", bitbucketPersonLabel(payload.author)],
      ["URL", bitbucketWebUrl(payload)],
      ["Source event ID", input.sourceEventId],
      ["Event ID", input.eventId ?? null],
      ["Updated", dateText(payload.updated_on ?? payload.updatedAt)],
    ]),
    "",
    "## Description",
    "",
    bodyText(bitbucketDescription(payload), "_No description._"),
  ];
  const reviews = bitbucketReviewLines(payload);
  if (reviews.length > 0) lines.push("", "## Reviews", "", ...reviews);
  lines.push("", ...renderBitbucketComments(comments));
  return lines.join("\n");
}

function renderBitbucketIssue(
  input: BitbucketIssueSourcePayload,
  comments: BitbucketCommentCollection,
): string {
  const payload = input.rawPayload;
  const title = stringValue(payload.title) ?? `Issue ${input.issueId}`;
  return [
    `# ${headingText(title)}`,
    "",
    sourceMetadata([
      ["Source", "Bitbucket"],
      ["Repository", input.repoFullName],
      ["Issue", input.issueId],
      ["State", stringValue(payload.state)],
      ["Author", bitbucketPersonLabel(payload.reporter ?? payload.author)],
      ["URL", bitbucketWebUrl(payload)],
      ["Source event ID", input.sourceEventId],
      ["Event ID", input.eventId ?? null],
      ["Created", dateText(payload.created_on ?? payload.createdAt)],
      ["Updated", dateText(payload.updated_on ?? payload.updatedAt)],
    ]),
    "",
    "## Body",
    "",
    bodyText(bitbucketIssueBody(payload), "_No body._"),
    "",
    ...renderBitbucketComments(comments),
  ].join("\n");
}

function renderBitbucketComments(collection: BitbucketCommentCollection): string[] {
  const lines = ["## Comments", ""];
  if (collection.total === 0) return [...lines, "_No comments._"];
  if (collection.omitted > 0) {
    lines.push(
      `_Showing the latest ${collection.comments.length} of ${collection.total} comments; ${collection.omitted} earlier comments omitted._`,
      "",
    );
  }
  lines.push(...collection.comments.flatMap((comment, index) => [
    ...(index > 0 ? [""] : []),
    renderBitbucketComment(comment),
  ]));
  return lines;
}

function renderBitbucketComment(comment: BitbucketCommentState): string {
  const payload = comment.payload;
  const content = objectValue(payload.content);
  return [
    `### ${headingText(`Comment ${comment.commentId}`)}`,
    "",
    sourceMetadata([
      ["Author", bitbucketPersonLabel(payload.user ?? payload.author)],
      ["Created", dateText(payload.created_on ?? payload.createdAt)],
      ["Updated", comment.updatedAt],
      ["Source event ID", comment.sourceEventId],
    ]),
    "",
    bodyText(stringValue(content?.raw) ?? stringValue(content?.markup) ?? stringValue(payload.body), "_No comment body._"),
  ].join("\n");
}

/**
 * Reviewer verdicts from the FULL detail payload's `participants` (slim sync
 * records lack the field, so their renders are unchanged). Current state per
 * reviewer only — the per-event approval history stays raw (`pr_activity`).
 */
function bitbucketReviewLines(payload: Record<string, unknown>): string[] {
  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  const lines: string[] = [];
  for (const value of participants) {
    const participant = objectValue(value);
    if (!participant) continue;
    const verdict = stringValue(participant.state)
      ?? (participant.approved === true ? "approved" : null);
    if (!verdict) continue;
    const who = bitbucketPersonLabel(participant.user) ?? "Unknown reviewer";
    const when = dateText(participant.participated_on);
    lines.push(`- ${who} — ${inlineText(verdict.replace(/_/gu, " "))}${when ? ` (${when})` : ""}`);
  }
  return lines;
}

function renderBitbucketRepository(input: BitbucketRepositorySourcePayload): string {
  const payload = input.rawPayload;
  const name = stringValue(payload.name) ?? input.repoFullName;
  return [
    `# ${headingText(name)}`,
    "",
    sourceMetadata([
      ["Source", "Bitbucket"],
      ["Repository", input.repoFullName],
      ["Name", name],
      ["UUID", stringValue(payload.uuid) ?? stringValue(payload.id)],
      ["Language", stringValue(payload.language)],
      ["Private", booleanText(payload.is_private ?? payload.isPrivate)],
      ["URL", bitbucketWebUrl(payload)],
      ["Source event ID", input.sourceEventId],
      ["Event ID", input.eventId ?? null],
      ["Updated", dateText(payload.updated_on ?? payload.updatedAt)],
    ]),
    "",
    "## Description",
    "",
    bodyText(stringValue(payload.description), "_No description._"),
  ].join("\n");
}

type GithubCommentState = {
  commentId: string;
  payload: Record<string, unknown>;
  sourceEventId: string;
  createdAt: string | null;
  updatedAt: string | null;
};

type GithubCommentSet = {
  comments: GithubCommentState[];
  total: number;
};

async function currentGithubComments(
  userId: string,
  ref: GithubParentSourceRef,
): Promise<GithubCommentSet> {
  const issueSuffix = `/repos/${ref.repoFullName}/issues/${ref.number}`;
  const pullSuffix = `/repos/${ref.repoFullName}/pulls/${ref.number}`;
  const rows = rowsFromExecute<{
    comment_id: string;
    event_type: string;
    source_event_id: string;
    raw_payload: unknown;
    created_at: string | Date | null;
    updated_at: string | Date | null;
    total_count: string | number;
  }>(await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (raw_payload->>'id')
        raw_payload->>'id' AS comment_id,
        event_type,
        source_event_id,
        raw_payload,
        COALESCE(NULLIF(raw_payload->>'created_at', '')::timestamptz, timestamp) AS created_at,
        COALESCE(NULLIF(raw_payload->>'updated_at', '')::timestamptz, source_updated_at, timestamp) AS updated_at
      FROM activity_events
      WHERE user_id = ${userId}
        AND source = 'github'
        AND event_type IN ('issue_comment', 'issue_comment.deleted', 'pr_review_comment', 'pr_review_comment.deleted')
        AND raw_payload->>'id' IS NOT NULL
        AND (
          (event_type IN ('issue_comment', 'issue_comment.deleted')
            AND right(COALESCE(raw_payload->>'issue_url', ''), ${issueSuffix.length}) = ${issueSuffix})
          OR (${ref.kind === "pull_request"}
            AND event_type IN ('pr_review_comment', 'pr_review_comment.deleted')
            AND right(COALESCE(raw_payload->>'pull_request_url', ''), ${pullSuffix.length}) = ${pullSuffix})
        )
      ORDER BY raw_payload->>'id', COALESCE(source_updated_at, timestamp) DESC, id DESC
    ), live AS (
      SELECT *
      FROM latest
      WHERE event_type NOT LIKE '%.deleted'
    )
    SELECT *, count(*) OVER () AS total_count
    FROM live
    ORDER BY created_at DESC, comment_id DESC
    LIMIT ${GITHUB_COMMENT_RENDER_LIMIT}
  `));
  const comments = rows.map((row) => ({
    commentId: row.comment_id,
    payload: jsonPayload(row.raw_payload) ?? {},
    sourceEventId: row.source_event_id,
    createdAt: dateText(row.created_at),
    updatedAt: dateText(row.updated_at),
  })).reverse();
  const rawTotal = rows[0]?.total_count ?? 0;
  const total = typeof rawTotal === "number" ? rawTotal : Number.parseInt(rawTotal, 10) || 0;
  return { comments, total };
}

function githubCommentSourceRefs(comments: GithubCommentSet): StagedDocumentSourceRef[] {
  return comments.comments.map((comment) => ({
    anchor: `Comment ${comment.commentId}`,
    sourceEventId: comment.sourceEventId,
  }));
}

function renderGithubIssue(input: GithubIssueSourcePayload, comments: GithubCommentSet): string {
  const payload = input.rawPayload;
  const title = stringValue(payload.title) ?? `Issue ${input.number}`;
  return [
    `# ${headingText(title)}`,
    "",
    sourceMetadata([
      ["Source", "GitHub"],
      ["Repository", input.repoFullName],
      ["Repository key", input.repoKey],
      ["Issue", input.number],
      ["State", stringValue(payload.state)],
      ["Author", githubPersonLabel(payload.user ?? payload.author)],
      ["Author type", githubPersonType(payload.user ?? payload.author)],
      ["URL", stringValue(payload.html_url ?? payload.url)],
      ["Source event ID", input.sourceEventId],
      ["Event ID", input.eventId ?? null],
      ["Updated", dateText(payload.updated_at ?? payload.updatedAt)],
    ]),
    "",
    "## Body",
    "",
    bodyText(stringValue(payload.body), "_No body._"),
    "",
    ...renderGithubComments(comments),
  ].join("\n");
}

function renderGithubPullRequest(input: GithubPullRequestSourcePayload, comments: GithubCommentSet): string {
  const payload = input.rawPayload;
  const title = stringValue(payload.title) ?? `Pull request ${input.number}`;
  return [
    `# ${headingText(title)}`,
    "",
    sourceMetadata([
      ["Source", "GitHub"],
      ["Repository", input.repoFullName],
      ["Repository key", input.repoKey],
      ["Pull request", input.number],
      ["State", stringValue(payload.state)],
      ["Draft", booleanText(payload.draft ?? payload.isDraft)],
      ["Merged", booleanText(payload.merged ?? payload.isMerged)],
      ["Review decision", stringValue(payload.reviewDecision ?? payload.review_decision)],
      ["Author", githubPersonLabel(payload.user ?? payload.author)],
      ["Author type", githubPersonType(payload.user ?? payload.author)],
      ["URL", stringValue(payload.html_url ?? payload.url)],
      ["Source event ID", input.sourceEventId],
      ["Event ID", input.eventId ?? null],
      ["Updated", dateText(payload.updated_at ?? payload.updatedAt)],
    ]),
    "",
    "## Body",
    "",
    bodyText(stringValue(payload.body), "_No body._"),
    "",
    ...renderGithubComments(comments),
  ].join("\n");
}

function renderGithubComments(input: GithubCommentSet): string[] {
  const omitted = Math.max(0, input.total - input.comments.length);
  const lines = ["## Comments"];
  if (omitted > 0) {
    lines.push("", `_Showing the latest ${input.comments.length} of ${input.total} comments; ${omitted} earlier comments omitted._`);
  }
  if (input.comments.length === 0) return [...lines, "", "_No comments._"];
  for (const comment of input.comments) {
    lines.push(
      "",
      `### Comment ${comment.commentId}`,
      "",
      sourceMetadata([
        ["Author", githubPersonLabel(comment.payload.user ?? comment.payload.author)],
        ["Updated", dateText(comment.payload.updated_at ?? comment.payload.created_at) ?? comment.updatedAt ?? comment.createdAt],
      ]),
      "",
      bodyText(stringValue(comment.payload.body), "_No comment body._"),
    );
  }
  return lines;
}

function renderGithubRepository(input: GithubRepositorySourcePayload): string {
  const payload = input.rawPayload;
  const name = stringValue(payload.name) ?? input.repoFullName;
  return [
    `# ${headingText(input.repoFullName)}`,
    "",
    sourceMetadata([
      ["Source", "GitHub"],
      ["Repository", input.repoFullName],
      ["Repository key", input.repoKey],
      ["Name", name],
      ["ID", stringValue(payload.id) ?? stringValue(payload.repoId) ?? stringValue(payload.repository_id)],
      ["Language", stringValue(payload.language)],
      ["Visibility", stringValue(payload.visibility)],
      ["Private", booleanText(payload.private ?? payload.isPrivate)],
      ["Archived", booleanText(payload.archived)],
      ["URL", stringValue(payload.html_url ?? payload.url)],
      ["Source event ID", input.sourceEventId],
      ["Event ID", input.eventId ?? null],
      ["Updated", dateText(payload.updated_at ?? payload.updatedAt ?? payload.pushed_at)],
    ]),
    "",
    "## Description",
    "",
    bodyText(stringValue(payload.description), "_No description._"),
  ].join("\n");
}

function renderJiraIssue(
  input: JiraIssueSourcePayload,
  key: string,
  projectKey: string,
  issueId: string | null,
): string {
  const payload = input.rawPayload;
  const fields = objectValue(payload.fields);
  const summary = stringValue(payload.summary) ?? stringValue(fields?.summary) ?? key;
  const status = jiraNamedValue(payload.status) ?? jiraNamedValue(fields?.status);
  const issueType = jiraNamedValue(payload.issueType ?? payload.issue_type) ?? jiraNamedValue(fields?.issuetype);
  const assignee = jiraPersonLabel(payload.assignee ?? fields?.assignee);
  const reporter = jiraPersonLabel(payload.reporter ?? fields?.reporter);
  const labels = arrayStrings(payload.labels ?? fields?.labels);
  const description = jiraAdfOrText(payload.description ?? fields?.description);
  const comments = jiraComments(payload);
  const omittedComments = jiraOmittedCommentCount(payload, comments.length);
  const cloudOrConnection = stringValue(payload.cloudId)
    ?? stringValue(payload.cloud_id)
    ?? input.connectionId
    ?? null;
  const externalId = issueId ? `issue:${cloudOrConnection ?? "unknown"}:${issueId}` : null;

  return [
    `# ${headingText(`${key}: ${summary}`)}`,
    "",
    sourceMetadata([
      ["Source", "Jira"],
      ["Project", projectKey],
      ["Issue key", key],
      ["Issue ID", issueId],
      ["External ID", externalId],
      ["Source event ID", input.sourceEventId],
      ["Event ID", input.eventId ?? null],
      ["Status", status],
      ["Assignee", assignee],
      ["Reporter", reporter],
      ["Type", issueType],
      ["Labels", labels.length > 0 ? labels.join(", ") : null],
      ["Comments omitted", omittedComments > 0 ? String(omittedComments) : null],
      ["Updated", dateText(payload.updated_at ?? payload.updatedAt ?? fields?.updated)],
    ]),
    "",
    "## Description",
    "",
    bodyText(description, "_No description._"),
    "",
    "## Comments",
    "",
    comments.length > 0 ? comments.map(renderJiraComment).join("\n\n") : "_No comments captured in this record._",
  ].join("\n");
}

function renderConfluencePage(
  input: ConfluencePageSourcePayload,
  pageId: string,
  spaceId: string,
): string {
  const payload = input.rawPayload;
  const title = stringValue(payload.title) ?? pageId;
  const version = confluenceVersionNumber(payload);
  const bodyStorage = confluenceBodyStorage(payload);
  const markdown = storageFormatToMarkdown(bodyStorage);
  const author = confluencePersonLabel(payload.author ?? payload.createdBy ?? payload.owner);

  return [
    `# ${headingText(title)}`,
    "",
    sourceMetadata([
      ["Source", "Confluence"],
      ["Space", spaceId],
      ["Page ID", pageId],
      ["External ID", `page:${pageId}`],
      ["Version", version ? `v${version}` : null],
      ["Source event ID", input.sourceEventId],
      ["Event ID", input.eventId ?? null],
      ["Author", author],
      ["Updated", dateText(payload.updated_at ?? payload.updatedAt ?? objectValue(payload.version)?.when)],
    ]),
    "",
    "## Content",
    "",
    bodyText(markdown, "_No page body was captured in this record._"),
  ].join("\n");
}

function confluenceCommentsSourcePath(spaceId: string, containerId: string): string {
  return `${CONFLUENCE_SOURCE_ROOT}/${atlassianPathSegment(spaceId, "unknown-space")}/${atlassianPathSegment(containerId, "unknown-page")}-comments.md`;
}

/**
 * Latest captured record for the comments doc's container: the page (or blog
 * post) event supplies the space, title, and whether the container itself is
 * tombstoned.
 */
async function latestConfluenceContainerRow(
  userId: string,
  ref: ConfluenceCommentsContainerRef,
): Promise<{ event_type: string; source_event_id: string; raw_payload: unknown } | null> {
  const eventTypes: [string, string] = ref.containerType === "page"
    ? ["page", "page.deleted"]
    : ["blog_post", "blog_post.deleted"];
  const rows = rowsFromExecute<{ event_type: string; source_event_id: string; raw_payload: unknown }>(await db.execute(sql`
    SELECT event_type, source_event_id, raw_payload
    FROM activity_events
    WHERE user_id = ${userId}
      AND source = 'confluence'
      AND event_type IN (${eventTypes[0]}, ${eventTypes[1]})
      AND (raw_payload->>'id' = ${ref.containerId} OR raw_payload->>'pageId' = ${ref.containerId})
    ORDER BY COALESCE(source_updated_at, timestamp) DESC, id DESC
    LIMIT 1
  `));
  return rows[0] ?? null;
}

/**
 * Collapse the per-version comment ledger to one current state per comment
 * id. Rows arrive sorted ascending by update time; a `.deleted` tombstone is
 * terminal, higher version numbers win among live rows, and otherwise the
 * later row does.
 */
function latestConfluenceCommentStates(rows: ConfluenceCommentEventRow[]): ConfluenceCommentState[] {
  const byId = new Map<string, ConfluenceCommentState>();
  for (const row of rows) {
    const payload = jsonPayload(row.raw_payload);
    if (!payload || typeof row.event_type !== "string") continue;
    const commentId = stringValue(payload.id) ?? stringValue(payload.uuid);
    if (!commentId) continue;
    const version = confluenceVersionNumber(payload);
    const versionNumber = version !== null && Number.isFinite(Number(version)) ? Number(version) : null;
    const candidate: ConfluenceCommentState = {
      commentId,
      deleted: row.event_type.endsWith(".deleted")
        || payload.deleted === true
        || payload._deleted === true
        || isDeletedNangoPayload(payload),
      inline: row.event_type.startsWith("inline_comment"),
      payload,
      sourceEventId: row.source_event_id,
      versionNumber,
      updatedAt: dateText(
        payload.updated_at
          ?? payload.updatedAt
          ?? objectValue(payload.version)?.when
          ?? objectValue(payload.version)?.createdAt,
      ) ?? dateText(row.source_updated_at) ?? dateText(row.timestamp),
    };
    const current = byId.get(commentId);
    byId.set(commentId, pickLaterConfluenceCommentState(current, candidate));
  }
  return [...byId.values()];
}

function pickLaterConfluenceCommentState(
  current: ConfluenceCommentState | undefined,
  candidate: ConfluenceCommentState,
): ConfluenceCommentState {
  if (!current) return candidate;
  if (current.deleted) return current;
  if (candidate.deleted) return candidate;
  if (
    candidate.versionNumber !== null
    && current.versionNumber !== null
    && candidate.versionNumber !== current.versionNumber
  ) {
    return candidate.versionNumber > current.versionNumber ? candidate : current;
  }
  return candidate;
}

type ConfluenceCommentThread = {
  state: ConfluenceCommentState;
  replies: ConfluenceCommentThread[];
};

/**
 * Thread comments by `parentCommentId`. Replies whose parent is deleted or
 * not (yet) captured render as top-level rather than being dropped.
 */
function confluenceCommentThreads(states: ConfluenceCommentState[]): ConfluenceCommentThread[] {
  const nodes = new Map<string, ConfluenceCommentThread>();
  for (const state of states) {
    if (!nodes.has(state.commentId)) nodes.set(state.commentId, { state, replies: [] });
  }
  const roots: ConfluenceCommentThread[] = [];
  for (const node of nodes.values()) {
    const parentId = stringValue(node.state.payload.parentCommentId)
      ?? stringValue(node.state.payload.parent_comment_id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function renderConfluenceComments(
  ref: ConfluenceCommentsContainerRef,
  spaceId: string,
  title: string,
  live: ConfluenceCommentState[],
  latestUpdated: string | null,
): string {
  const threads = confluenceCommentThreads(live);
  return [
    `# ${headingText(`Comments: ${title}`)}`,
    "",
    sourceMetadata([
      ["Source", "Confluence"],
      ["Space", spaceId],
      [ref.containerType === "page" ? "Page ID" : "Blog post ID", ref.containerId],
      ["External ID", `${ref.containerId}:comments`],
      ["Comments", String(live.length)],
      ["Updated", latestUpdated],
    ]),
    "",
    "## Comments",
    "",
    threads.map((thread) => renderConfluenceCommentThread(thread, 3)).join("\n\n"),
  ].join("\n");
}

function renderConfluenceCommentThread(thread: ConfluenceCommentThread, depth: number): string {
  const state = thread.state;
  const payload = state.payload;
  const heading = "#".repeat(Math.min(depth, 6));
  const resolution = state.inline
    ? stringValue(payload.resolutionStatus ?? payload.resolution_status)
    : null;
  const parts = [
    // Reply nesting is expressed by heading depth; the label stays
    // `Comment <id>` so envelope sourceRef anchors match at every depth.
    `${heading} ${headingText(`Comment ${state.commentId}`)}`,
    "",
    sourceMetadata([
      ["Type", state.inline ? "Inline comment" : "Footer comment"],
      ["Author", confluenceCommentAuthorLabel(payload)],
      ["Created", dateText(payload.createdAt ?? payload.created_at ?? payload.created)],
      ["Updated", state.updatedAt],
      ["Version", state.versionNumber !== null ? `v${state.versionNumber}` : null],
      ["Resolution", resolution],
      ["Highlighted text", confluenceInlineCommentContext(payload)],
      ["Source event ID", state.sourceEventId],
    ]),
    "",
    bodyText(storageFormatToMarkdown(confluenceBodyStorage(payload)), "_No comment body was captured in this record._"),
  ];
  for (const reply of thread.replies) {
    parts.push("", renderConfluenceCommentThread(reply, depth + 1));
  }
  return parts.join("\n");
}

/** Inline-comment highlighted-text context (v2 API `inlineOriginalSelection`). */
function confluenceInlineCommentContext(payload: Record<string, unknown>): string | null {
  const properties = objectValue(payload.properties);
  const selection = stringValue(properties?.inlineOriginalSelection)
    ?? stringValue(properties?.["inline-original-selection"])
    ?? stringValue(payload.inlineOriginalSelection)
    ?? stringValue(payload.inline_original_selection);
  return selection ? `"${inlineText(selection)}"` : null;
}

/**
 * Comment author: display name/email when the payload carries a person
 * object, else the bare accountId the v2 comment APIs expose (top-level or
 * on the current version).
 */
function confluenceCommentAuthorLabel(payload: Record<string, unknown>): string | null {
  return confluencePersonLabel(payload.author ?? payload.createdBy ?? payload.owner)
    ?? stringValue(payload.authorId)
    ?? stringValue(payload.author_id)
    ?? stringValue(objectValue(payload.version)?.authorId);
}

function confluenceCommentAuthorEmail(payload: Record<string, unknown>): string | null {
  return confluencePersonEmail(payload.author ?? payload.createdBy ?? payload.owner);
}

function confluenceCommentAuthorName(payload: Record<string, unknown>): string | null {
  return confluencePersonName(payload.author ?? payload.createdBy ?? payload.owner);
}

function jsonPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return objectValue(value);
}

function firstNonNull<T>(values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function maxIsoDate(values: Array<string | null>): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (value && (!max || value > max)) max = value;
  }
  return max;
}

function jiraIssueKey(payload: Record<string, unknown>): string | null {
  return stringValue(payload.key) ?? stringValue(payload.issueKey) ?? stringValue(payload.issue_key);
}

function jiraProjectKey(payload: Record<string, unknown>, issueKey: string): string {
  const fields = objectValue(payload.fields);
  const project = objectValue(payload.project) ?? objectValue(fields?.project);
  return stringValue(payload.projectKey)
    ?? stringValue(payload.project_key)
    ?? stringValue(project?.key)
    ?? issueKey.split("-")[0]
    ?? "UNKNOWN";
}

function jiraNamedValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const record = objectValue(value);
  return stringValue(record?.name)
    ?? stringValue(record?.displayName)
    ?? stringValue(record?.value)
    ?? stringValue(record?.id);
}

function jiraPersonLabel(value: unknown): string | null {
  const record = objectValue(value);
  if (!record) return stringValue(value);
  const name = stringValue(record.displayName) ?? stringValue(record.name) ?? stringValue(record.publicName);
  const email = stringValue(record.emailAddress) ?? stringValue(record.email) ?? stringValue(record.accountEmail);
  if (name && email) return `${inlineText(name)} <${email}>`;
  return name ?? email ?? stringValue(record.accountId) ?? stringValue(record.id);
}

function jiraPersonEmail(value: unknown): string | null {
  const record = objectValue(value);
  return stringValue(record?.emailAddress) ?? stringValue(record?.email) ?? stringValue(record?.accountEmail);
}

/**
 * Last updater from the issue's edit changelog (`expand=changelog` payloads,
 * captured by the proxy detail lane). Histories are scanned for the latest
 * `created` stamp; unparseable stamps fall back to array order (Jira emits
 * histories chronologically). Absent when the payload has no changelog.
 */
function jiraUpdatedByEmail(payload: Record<string, unknown>): string | null {
  const changelog = objectValue(payload.changelog);
  const histories = Array.isArray(changelog?.histories) ? changelog.histories : [];
  let latest: Record<string, unknown> | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const item of histories) {
    const history = objectValue(item);
    if (!history) continue;
    const at = Date.parse(stringValue(history.created) ?? "");
    const stamp = Number.isFinite(at) ? at : latestAt;
    if (stamp >= latestAt) {
      latestAt = stamp;
      latest = history;
    }
  }
  return latest ? jiraPersonEmail(latest.author) : null;
}

function jiraPersonName(value: unknown): string | null {
  const record = objectValue(value);
  return stringValue(record?.displayName) ?? stringValue(record?.name) ?? stringValue(record?.publicName);
}

function confluencePersonEmail(value: unknown): string | null {
  const record = objectValue(value);
  return stringValue(record?.email) ?? stringValue(record?.emailAddress);
}

function confluencePersonName(value: unknown): string | null {
  const record = objectValue(value);
  return stringValue(record?.displayName) ?? stringValue(record?.publicName) ?? stringValue(record?.name);
}

function idValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function confluencePersonLabel(value: unknown): string | null {
  const record = objectValue(value);
  if (!record) return stringValue(value);
  const name = stringValue(record.displayName) ?? stringValue(record.publicName) ?? stringValue(record.name);
  const email = stringValue(record.email) ?? stringValue(record.emailAddress);
  if (name && email) return `${inlineText(name)} <${email}>`;
  return name ?? email ?? stringValue(record.accountId) ?? stringValue(record.id);
}

function bitbucketPersonLabel(value: unknown): string | null {
  const record = objectValue(value);
  if (!record) return stringValue(value);
  const name = stringValue(record.display_name)
    ?? stringValue(record.displayName)
    ?? stringValue(record.nickname)
    ?? stringValue(record.username)
    ?? stringValue(record.name);
  const email = stringValue(record.email) ?? stringValue(record.emailAddress);
  if (name && email) return `${inlineText(name)} <${email}>`;
  return name ?? email ?? stringValue(record.account_id) ?? stringValue(record.accountId) ?? stringValue(record.uuid);
}

function githubPersonLabel(value: unknown): string | null {
  const record = objectValue(value);
  if (!record) return stringValue(value);
  const login = stringValue(record.login) ?? stringValue(record.name);
  const email = stringValue(record.email);
  if (login && email) return `${inlineText(login)} <${email}>`;
  return login ?? email ?? stringValue(record.id);
}

function githubPersonType(value: unknown): string | null {
  const record = objectValue(value);
  return stringValue(record?.type) ?? stringValue(record?.__typename);
}

function jiraAdfOrText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return adfToMarkdown(value);
}

function jiraComments(payload: Record<string, unknown>): Record<string, unknown>[] {
  const fields = objectValue(payload.fields);
  const commentContainer = objectValue(payload.comment) ?? objectValue(fields?.comment);
  const rows = payload.comments ?? commentContainer?.comments;
  return normalizeJiraComments(Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => Boolean(objectValue(row)))
    : []);
}

function normalizeJiraComments(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  const withoutId: Record<string, unknown>[] = [];
  for (const row of rows) {
    const id = stringValue(row.id);
    if (id) byId.set(id, row);
    else withoutId.push(row);
  }
  return [...byId.values(), ...withoutId].sort((left, right) => {
    const leftDate = dateText(left.created ?? left.updated) ?? "";
    const rightDate = dateText(right.created ?? right.updated) ?? "";
    return leftDate.localeCompare(rightDate)
      || (stringValue(left.id) ?? "").localeCompare(stringValue(right.id) ?? "");
  });
}

function jiraOmittedCommentCount(payload: Record<string, unknown>, rendered: number): number {
  const fields = objectValue(payload.fields);
  const container = objectValue(payload.comment) ?? objectValue(fields?.comment);
  return Math.max(0, (finiteNumber(container?.total) ?? rendered) - rendered);
}

function jiraCommentAnchor(comment: Record<string, unknown>, index: number): string {
  return `Comment ${stringValue(comment.id) ?? index + 1}`;
}

function jiraCommentSourceRef(
  comment: Record<string, unknown>,
  index: number,
  capturedSourceEventId?: string,
): StagedDocumentSourceRef | null {
  return capturedSourceEventId
    ? { anchor: jiraCommentAnchor(comment, index), sourceEventId: capturedSourceEventId }
    : null;
}

function renderJiraComment(comment: Record<string, unknown>, index: number): string {
  const author = jiraPersonLabel(comment.author ?? comment.updateAuthor);
  const updated = dateText(comment.updated ?? comment.created);
  const body = jiraAdfOrText(comment.body);
  return [
    `### ${headingText(jiraCommentAnchor(comment, index))}`,
    "",
    sourceMetadata([
      ["Author", author],
      ["Updated", updated],
    ]),
    "",
    bodyText(body, "_No comment body._"),
  ].join("\n");
}

function confluenceSpaceId(payload: Record<string, unknown>): string | null {
  const space = objectValue(payload.space);
  return stringValue(payload.spaceId)
    ?? stringValue(payload.space_id)
    ?? stringValue(space?.id)
    ?? stringValue(space?.key);
}

function confluenceVersionNumber(payload: Record<string, unknown>): string | null {
  const version = payload.versionNumber ?? payload.version_number ?? objectValue(payload.version)?.number;
  if (typeof version === "number" && Number.isFinite(version)) return String(version);
  return stringValue(version);
}

function confluenceBodyStorage(payload: Record<string, unknown>): string | null {
  const body = objectValue(payload.body);
  const storage = objectValue(body?.storage) ?? objectValue(payload.bodyStorage);
  return stringValue(payload.bodyStorage)
    ?? stringValue(payload.body_storage)
    ?? stringValue(storage?.value)
    ?? stringValue(body?.value);
}

function isDeletedNangoPayload(payload: Record<string, unknown>): boolean {
  const metadata = objectValue(payload._nango_metadata) ?? objectValue(payload._nangoMetadata);
  const action = stringValue(metadata?.last_action ?? metadata?.lastAction)?.toUpperCase();
  return action === "DELETED";
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item))
    : [];
}

function bitbucketDescription(payload: Record<string, unknown>): string | null {
  const rendered = objectValue(payload.rendered);
  const renderedDescription = objectValue(rendered?.description);
  return stringValue(payload.description)
    ?? stringValue(renderedDescription?.raw)
    ?? stringValue(renderedDescription?.markup);
}

function bitbucketIssueBody(payload: Record<string, unknown>): string | null {
  const content = objectValue(payload.content);
  const rendered = objectValue(payload.rendered);
  const renderedContent = objectValue(rendered?.content);
  return stringValue(content?.raw)
    ?? stringValue(content?.markup)
    ?? stringValue(renderedContent?.raw)
    ?? stringValue(renderedContent?.markup)
    ?? stringValue(payload.body)
    ?? stringValue(payload.description);
}

function bitbucketWebUrl(payload: Record<string, unknown>): string | null {
  const links = objectValue(payload.links);
  const html = objectValue(links?.html);
  const self = objectValue(links?.self);
  return stringValue(html?.href)
    ?? stringValue(self?.href)
    ?? stringValue(payload.html_url)
    ?? stringValue(payload.url);
}

function atlassianPathSegment(value: string | null | undefined, fallback: string): string {
  return (value ?? fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    || fallback;
}

/** Mirror directory for one github repo (`sources/github/<owner>/<repo>`) - the path scheme the per-repo purge deletes under. */
export function githubRepoSourceWikiDirectory(repoFullName: string): string {
  return gitProviderRepoDirectory(GITHUB_SOURCE_ROOT, repoFullName);
}

function gitProviderRepoDirectory(root: string, repoFullName: string): string {
  const segments = repoFullName.split("/").filter((segment) => segment.trim().length > 0);
  const safeSegments = segments.length > 0
    ? segments.map((segment) => gitProviderPathSegment(segment, "unknown"))
    : ["unknown-repo"];
  return `${root}/${safeSegments.join("/")}`;
}

function gitProviderPathSegment(value: string | null | undefined, fallback: string): string {
  return (value ?? fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    || fallback;
}

function booleanText(value: unknown): string | null {
  return typeof value === "boolean" ? (value ? "yes" : "no") : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalizeGoogleDocTabSummaries(
  value: Record<string, GoogleDocTabSummary> | GoogleDocTabSummary[] | null | undefined,
): GoogleDocTabSummary[] {
  const rows = Array.isArray(value) ? value : Object.values(value ?? {});
  return rows
    .map((row) => ({
      tabId: stringValue(row.tabId) ?? "unknown-tab",
      tabName: stringValue(row.tabName) ?? stringValue(row.tabId) ?? "Untitled Tab",
      summary: stringValue(row.summary) ?? "",
      contentHash: stringValue(row.contentHash),
    }))
    .sort((a, b) => a.tabName.localeCompare(b.tabName) || a.tabId.localeCompare(b.tabId));
}

function normalizeNotionSectionSummaries(
  value: Record<string, NotionSectionSummary> | NotionSectionSummary[] | null | undefined,
): NotionSectionSummary[] {
  const rows = Array.isArray(value) ? value : Object.values(value ?? {});
  return rows
    .map((row) => ({
      sectionId: stringValue(row.sectionId) ?? "unknown-section",
      sectionTitle: stringValue(row.sectionTitle) ?? stringValue(row.sectionId) ?? "Untitled Section",
      summary: stringValue(row.summary) ?? "",
      contentHash: stringValue(row.contentHash),
      sectionKind: stringValue(row.sectionKind),
      anchorBlockId: stringValue(row.anchorBlockId),
      rootBlockIds: Array.isArray(row.rootBlockIds) ? row.rootBlockIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [],
      warningCodes: Array.isArray(row.warningCodes) ? row.warningCodes.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [],
      structuredFacts: isRecord(row.structuredFacts) ? row.structuredFacts : null,
      sourceContent: stringValue(row.sourceContent),
    }))
    .sort((a, b) => a.sectionTitle.localeCompare(b.sectionTitle) || a.sectionId.localeCompare(b.sectionId));
}

function normalizeNotionRowPages(value: NotionRowPageSource[] | null | undefined): NotionRowPageSource[] {
  return (value ?? [])
    .map((row) => ({
      pageId: stringValue(row.pageId) ?? "unknown-row-page",
      title: stringValue(row.title) ?? stringValue(row.pageId) ?? "Untitled Notion page",
      url: stringValue(row.url),
      dataSourceId: stringValue(row.dataSourceId) ?? "unknown-data-source",
      dataSourceTitle: stringValue(row.dataSourceTitle) ?? stringValue(row.dataSourceId) ?? "Untitled data source",
      relativePath: safeRelativeSourcePath(row.relativePath),
      sourceContent: stringValue(row.sourceContent) ?? "",
      contentHash: stringValue(row.contentHash),
      hasComments: row.hasComments === true,
      structuredFacts: isRecord(row.structuredFacts) ? row.structuredFacts : null,
    }))
    .filter((row) => row.relativePath && row.sourceContent.trim())
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.pageId.localeCompare(b.pageId))
    .filter((row, index, rows) => index === 0 || rows[index - 1]?.pageId !== row.pageId);
}

function normalizeNotionChildPages(value: NotionChildPageSource[] | null | undefined): NotionChildPageSource[] {
  const flattened: NotionChildPageSource[] = [];
  const visitedObjects = new WeakSet<object>();
  const visit = (row: NotionChildPageSource): void => {
    if (row && typeof row === "object") {
      if (visitedObjects.has(row)) return;
      visitedObjects.add(row);
    }
    flattened.push(row);
    for (const child of row.childPages ?? []) visit(child);
  };
  for (const row of value ?? []) visit(row);

  const seen = new Set<string>();
  return flattened
    .map((row) => ({
      pageId: stringValue(row.pageId) ?? "unknown-child-page",
      title: stringValue(row.title) ?? stringValue(row.pageId) ?? "Untitled Notion child page",
      url: stringValue(row.url),
      parentBlockId: stringValue(row.parentBlockId),
      relativePath: safeRelativeSourcePath(row.relativePath),
      sourceContent: stringValue(row.sourceContent) ?? "",
      contentHash: stringValue(row.contentHash),
      hasComments: row.hasComments === true,
      structuredFacts: isRecord(row.structuredFacts) ? row.structuredFacts : null,
    }))
    .filter((row) => row.relativePath && row.sourceContent.trim())
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.pageId.localeCompare(b.pageId))
    .filter((row) => {
      const key = `${row.pageId}\0${row.relativePath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function notionProjectionSourceRefs(input: {
  anchor: string;
  contentHash?: string | null;
  hasComments?: boolean;
  url?: string | null;
}): StagedDocumentSourceRef[] {
  const sha256 = stringValue(input.contentHash);
  if (!sha256) return [];
  const url = stringValue(input.url);
  const evidence = (anchor: string): StagedDocumentSourceRef => ({
    anchor,
    sha256,
    ...(url ? { url } : {}),
  });
  return [
    evidence(input.anchor),
    ...(input.hasComments ? [evidence("Comments")] : []),
  ];
}

function safeRelativeSourcePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/u, "");
  if (!normalized || normalized.includes("\0")) return "";
  if (normalized.split("/").some((part) => part === ".." || part === "")) return "";
  return normalized.endsWith(".md") ? normalized : "";
}

function renderNotionReferences(
  references: Array<{ kind?: string; targetId?: string | null; title?: string | null; url?: string | null }> | null | undefined,
): string {
  const rows = (references ?? [])
    .map((ref) => {
      const kind = stringValue(ref.kind) ?? "reference";
      const title = stringValue(ref.title) ?? stringValue(ref.targetId) ?? "Untitled reference";
      const target = stringValue(ref.targetId);
      const url = stringValue(ref.url);
      const suffix = [target ? `id=${target}` : null, url].filter(Boolean).join("; ");
      return `- ${inlineText(kind)}: ${url ? `[${inlineText(title)}](${url})` : inlineText(title)}${suffix ? ` (${suffix})` : ""}`;
    });
  return rows.length ? rows.join("\n") : "- No Notion references were captured.";
}

function renderNotionWarnings(
  warnings: Array<{ code?: string; message?: string; blockId?: string | null; type?: string | null }> | null | undefined,
): string {
  const rows = (warnings ?? [])
    .map((warning) => {
      const code = stringValue(warning.code) ?? "warning";
      const detail = [
        stringValue(warning.type) ? `type=${stringValue(warning.type)}` : null,
        stringValue(warning.blockId) ? `block=${stringValue(warning.blockId)}` : null,
      ].filter(Boolean).join("; ");
      const message = stringValue(warning.message);
      return `- ${inlineText(code)}${detail ? ` (${detail})` : ""}${message ? `: ${message}` : ""}`;
    });
  return rows.length ? rows.join("\n") : "- No Notion processing warnings.";
}

function sourceMetadata(rows: Array<[string, string | null | undefined]>): string {
  return rows
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join("\n");
}

function bodyText(value: string | null | undefined, fallback: string): string {
  const text = value?.trim();
  return text ? text : fallback;
}

function fencedJson(value: unknown, fallback: string): string {
  if (!isRecord(value) || Object.keys(value).length === 0) return fallback;
  return `\`\`\`json\n${boundedJson(value, 12000)}\n\`\`\``;
}

function boundedJson(value: unknown, maxLength: number): string {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= maxLength) return full;

  const bounded = boundJsonValue(value, { maxDepth: 8, maxArrayItems: 40, maxObjectKeys: 80, maxStringLength: 600 }, 0);
  const wrapped = {
    _truncated: true,
    _original_json_length: full.length,
    value: bounded,
  };
  let json = JSON.stringify(wrapped, null, 2);
  if (json.length <= maxLength) return json;

  json = JSON.stringify({
    _truncated: true,
    _original_json_length: full.length,
    _note: "Structured facts exceeded the source-wiki JSON budget; inspect the native Notion graph for the complete payload.",
    value: boundJsonValue(value, { maxDepth: 5, maxArrayItems: 12, maxObjectKeys: 30, maxStringLength: 200 }, 0),
  }, null, 2);
  if (json.length <= maxLength) return json;

  return JSON.stringify({
    _truncated: true,
    _original_json_length: full.length,
    _note: "Structured facts exceeded the source-wiki JSON budget; inspect the native Notion graph for the complete payload.",
  }, null, 2);
}

function boundJsonValue(
  value: unknown,
  limits: { maxDepth: number; maxArrayItems: number; maxObjectKeys: number; maxStringLength: number },
  depth: number,
): unknown {
  if (typeof value === "string") {
    return value.length <= limits.maxStringLength
      ? value
      : `${value.slice(0, limits.maxStringLength)}...`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= limits.maxDepth) return "[Max depth exceeded]";
  if (Array.isArray(value)) {
    const items = value.slice(0, limits.maxArrayItems).map((item) => boundJsonValue(item, limits, depth + 1));
    if (value.length > limits.maxArrayItems) {
      items.push({ _truncated_items: value.length - limits.maxArrayItems });
    }
    return items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const boundedEntries = entries.slice(0, limits.maxObjectKeys).map(([key, item]) => [
    key,
    boundJsonValue(item, limits, depth + 1),
  ]);
  const result = Object.fromEntries(boundedEntries);
  if (entries.length > limits.maxObjectKeys) {
    result._truncated_keys = entries.length - limits.maxObjectKeys;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stableEntityPath(prefix: string, id: string): string {
  return `${prefix}-${shortHash(id)}`;
}

function titledEntityDirectory(
  sourceRoot: string,
  title: string | null | undefined,
  fallbackTitle: string,
  idPrefix: string,
  id: string,
): string {
  const suffix = stableEntityPath(idPrefix, id);
  const slug = slugify((title ?? "").trim() || fallbackTitle).slice(0, 80).replace(/-$/u, "");
  return `${sourceRoot}/${slug || "untitled"}-${suffix}`;
}

async function deleteSourceWikiEntityDirectories(
  userId: string,
  sourceRoot: string,
  entitySuffix: string,
  keepDirectory?: string,
): Promise<void> {
  const normalizedRoot = normalizeSourcePath(sourceRoot).replace(/\/+$/u, "");
  const normalizedKeepDirectory = keepDirectory ? normalizeSourcePath(keepDirectory).replace(/\/+$/u, "") : null;
  await enqueueGraphDeletesForMatchingMirrorFiles(userId, sql`
    SELECT path
    FROM mirror_files
    WHERE user_id = ${userId}
      AND (
        path LIKE ${`${normalizedRoot}/${entitySuffix}/%`}
        OR path LIKE ${`${normalizedRoot}/%-${entitySuffix}/%`}
      )
      ${normalizedKeepDirectory ? sql`AND path NOT LIKE ${`${normalizedKeepDirectory}/%`}` : sql``}
  `);
  await db.execute(sql`
    DELETE FROM mirror_files
    WHERE user_id = ${userId}
      AND (
        path LIKE ${`${normalizedRoot}/${entitySuffix}/%`}
        OR path LIKE ${`${normalizedRoot}/%-${entitySuffix}/%`}
      )
      ${normalizedKeepDirectory ? sql`AND path NOT LIKE ${`${normalizedKeepDirectory}/%`}` : sql``}
  `);
}

async function enqueueGraphDeletesForMatchingMirrorFiles(userId: string, statement: SQL): Promise<void> {
  if (!graphIngestEnabled()) return;
  const rows = rowsFromExecute<{ path: string }>(await db.execute(statement));
  await enqueueGraphDeletesForPaths(userId, rows.map((row) => row.path));
}

async function enqueueGraphDeletesForPaths(userId: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await enqueueGraphDeleteForMirrorFile(db, { tenantId: userId, path });
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizeSourcePath(value: string): string {
  const path = value.trim().replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!path || path === SOURCES_ROOT || !path.startsWith(`${SOURCES_ROOT}/`)) {
    throw new Error(`source wiki paths must live under ${SOURCES_ROOT}/`);
  }
  if (path.includes("..")) {
    throw new Error(`invalid source wiki path: ${value}`);
  }
  return path;
}

function markdownFile(content: string): string {
  return content.trimEnd() + "\n";
}

function headingText(value: string): string {
  return inlineText(value).replace(/\n+/g, " ").trim() || "Untitled";
}

function inlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
