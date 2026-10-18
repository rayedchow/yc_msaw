import { createHash } from "node:crypto";
import {
  materializeNotionPageSourceWiki,
  type NotionChildPageSource,
  type NotionRowPageSource,
  type NotionSectionSummary,
  type SourceWikiFile,
} from "../../mirror/materializer.js";
import {
  fetchNotionPageContent,
  notionChildPageStructuredFacts,
  notionDatabaseRowPageStructuredFacts,
  renderChildPageContent,
  renderDatabaseRowPageContent,
  type NotionChildPage,
  type NotionDatabaseRowPage,
  type NotionPageContent,
} from "./content.js";
import { buildNotionNativeSnapshot } from "./native.js";
import { persistNotionNativeSnapshot } from "./snapshot.js";

export type StoredNotionSectionSummary = Partial<NotionSectionSummary> & {
  structuredFactSummary?: Record<string, unknown> | null;
};

export type StoredNotionSectionSummaries =
  | Record<string, StoredNotionSectionSummary>
  | StoredNotionSectionSummary[]
  | null
  | undefined;

export type MaterializeNotionPageSourceWikiInput = Parameters<typeof materializeNotionPageSourceWiki>[0];

export function notionPageContentSourceWikiInput(input: {
  userId: string;
  pageContent: NotionPageContent;
  overview: string;
  sectionSummaries: StoredNotionSectionSummaries;
  refreshIndexes?: boolean;
}): MaterializeNotionPageSourceWikiInput {
  const { pageContent } = input;
  return {
    userId: input.userId,
    pageId: pageContent.pageId,
    title: pageContent.title,
    url: pageContent.url,
    parentType: pageContent.parentType,
    parentId: pageContent.parentId,
    dataSourceId: pageContent.dataSourceId,
    overview: input.overview,
    sectionSummaries: sourceWikiNotionSections(pageContent, input.sectionSummaries),
    sourceMarkdown: notionSourceMarkdown(pageContent),
    contentHash: pageContent.contentHash,
    hasComments: pageContent.comments.length > 0,
    lastEditedTime: pageContent.lastEditedTime,
    markdownTruncated: pageContent.markdownTruncated,
    structuredIngestion: pageContent.structuredIngestion,
    warnings: pageContent.warnings,
    references: pageContent.references,
    rowPages: pageContent.rowPages.map(notionRowPageSource),
    childPages: pageContent.childPages.map(notionChildPageSource),
    refreshIndexes: input.refreshIndexes,
  };
}

export async function materializeNotionPageContentSourceWiki(input: {
  userId: string;
  pageContent: NotionPageContent;
  overview: string;
  sectionSummaries: StoredNotionSectionSummaries;
  refreshIndexes?: boolean;
}): Promise<SourceWikiFile[]> {
  return materializeNotionPageSourceWiki(notionPageContentSourceWikiInput(input));
}

export async function fetchAndMaterializeNotionPageContentSourceWiki(input: {
  userId: string;
  pageId: string;
  overview: string;
  sectionSummaries: StoredNotionSectionSummaries;
  refreshIndexes?: boolean;
}): Promise<SourceWikiFile[]> {
  const pageContent = await fetchNotionPageContent(input.userId, input.pageId);
  // Persist the native snapshot store (pages/blocks/data sources/comments -
  // the seven notion_* tables) BEFORE staging: capture-plane writes come
  // first, and a persist failure retries the render rather than leaving raw
  // capture behind the mirror. Built from the pageContent the walker already
  // fetched; only views/templates load supplemental context (fail-soft
  // reads inside buildNotionNativeSnapshot).
  const snapshot = await buildNotionNativeSnapshot(input.userId, pageContent);
  await persistNotionNativeSnapshot(input.userId, pageContent.pageId, snapshot);
  return materializeNotionPageContentSourceWiki({
    userId: input.userId,
    pageContent,
    overview: input.overview,
    sectionSummaries: input.sectionSummaries,
    refreshIndexes: input.refreshIndexes,
  });
}

export function sourceWikiNotionSections(
  pageContent: NotionPageContent,
  summaries: StoredNotionSectionSummaries,
): NotionSectionSummary[] {
  const summariesById = normalizeStoredSectionSummaries(summaries);
  return pageContent.sections.map((section) => {
    const summary = summariesById[section.sectionId];
    return {
      sectionId: section.sectionId,
      sectionTitle: section.sectionTitle,
      summary: typeof summary?.summary === "string" ? summary.summary : "",
      contentHash: section.contentHash,
      sectionKind: section.kind ?? undefined,
      anchorBlockId: section.anchorBlockId ?? null,
      rootBlockIds: section.rootBlockIds ?? [],
      warningCodes: section.warningCodes ?? [],
      structuredFacts: section.structuredFacts ?? {},
      sourceContent: section.content,
    };
  });
}

export function notionSourceMarkdown(pageContent: NotionPageContent): string {
  const structured = pageContent.sections
    .filter((section) => section.kind !== "database_row_page")
    .map((section) => {
      const content = section.content.trim();
      return section.kind === "comments" && content
        ? `## ${section.sectionTitle || "Comments"}\n\n${content}`
        : content;
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return structured || pageContent.markdown.trim();
}

function notionRowPageSource(rowPage: NotionDatabaseRowPage): NotionRowPageSource {
  return {
    pageId: rowPage.pageId,
    title: rowPage.title,
    url: rowPage.url,
    dataSourceId: rowPage.dataSourceId,
    dataSourceTitle: rowPage.dataSourceTitle,
    relativePath: rowPage.relativePath,
    sourceContent: renderDatabaseRowPageContent(rowPage),
    contentHash: rowPageContentHash(rowPage),
    hasComments: rowPage.comments.length > 0,
    structuredFacts: notionDatabaseRowPageStructuredFacts(rowPage),
  };
}

function notionChildPageSource(childPage: NotionChildPage): NotionChildPageSource {
  return {
    pageId: childPage.pageId,
    title: childPage.title,
    url: childPage.url,
    parentBlockId: childPage.parentBlockId,
    relativePath: childPage.relativePath,
    sourceContent: renderChildPageContent(childPage),
    contentHash: childPageContentHash(childPage),
    hasComments: childPage.comments.length > 0,
    structuredFacts: notionChildPageStructuredFacts(childPage),
    childPages: childPage.childPages.map(notionChildPageSource),
  };
}

function normalizeStoredSectionSummaries(
  value: StoredNotionSectionSummaries,
): Record<string, StoredNotionSectionSummary> {
  const summaries: Record<string, StoredNotionSectionSummary> = {};
  if (Array.isArray(value)) {
    for (const row of value) {
      const sectionId = stringValue(row.sectionId);
      if (sectionId) summaries[sectionId] = row;
    }
    return summaries;
  }

  if (!value || typeof value !== "object") return summaries;
  for (const [key, row] of Object.entries(value)) {
    if (!row || typeof row !== "object") continue;
    const sectionId = stringValue(row.sectionId) ?? key;
    if (sectionId) summaries[sectionId] = row;
  }
  return summaries;
}

function rowPageContentHash(rowPage: NotionDatabaseRowPage): string {
  return hashStable({
    pageId: rowPage.pageId,
    values: rowPage.values,
    bodyMarkdown: rowPage.bodyMarkdown,
    breadcrumbTrail: rowPage.breadcrumbTrail,
    comments: rowPage.comments,
  });
}

function childPageContentHash(childPage: NotionChildPage): string {
  return hashStable({
    pageId: childPage.pageId,
    properties: childPage.properties,
    bodyMarkdown: childPage.bodyMarkdown,
    breadcrumbTrail: childPage.breadcrumbTrail,
    comments: childPage.comments,
  });
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
