import { createHash } from "node:crypto";
import type { StagedDocumentSourceRef } from "../../mirror/envelope.js";

export interface ChunkDraft {
  ordinal: number;
  text: string;
  chunkHash: string;
  meta: {
    headingPath: string[];
    startLine: number;
    endLine: number;
    startTime?: string;
    endTime?: string;
    sourceRefs?: StagedDocumentSourceRef[];
  };
}

export interface ChunkMarkdownOptions {
  minChunkChars?: number;
  maxChunkChars?: number;
  parseSourceMetadataClocks?: boolean;
  mirrorPath?: string | null;
  sourceUpdatedAt?: Date | string | null;
  sourceRefs?: readonly StagedDocumentSourceRef[] | null;
}

export interface ChunkTranscriptOptions extends ChunkMarkdownOptions {
  gapSeconds?: number;
  meetingStartTime?: Date | string | null;
}

interface Section {
  text: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
}

interface TextBlock {
  text: string;
  startLine: number;
  endLine: number;
  kind: "plain" | "fence" | "table";
}

interface TranscriptBlock {
  startLine: number;
  endLine: number;
  headingPath: string[];
  renderedText: string;
  startTime?: string;
  endTime?: string;
}

const DEFAULT_MIN_CHUNK_CHARS = 200;
const DEFAULT_MAX_CHUNK_CHARS = 6000;
const DEFAULT_TRANSCRIPT_GAP_SECONDS = 120;
const TRANSCRIPT_TURN_RE = /^\*\*(.+?)\*\*[ \t]+([^:\n]+):[ \t]*(.*)$/s;

export function chunkMarkdown(content: string, opts: ChunkMarkdownOptions = {}): ChunkDraft[] {
  const minChunkChars = opts.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  const maxChunkChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const sourceMetadataClocks = opts.parseSourceMetadataClocks
    ? parseSourceMetadataClocks(content)
    : null;
  const splitSections = splitAtHeadings(content).flatMap((section) =>
    splitLargeSection(section, maxChunkChars)
  );
  const merged = mergeSmallSections(splitSections, minChunkChars);

  return merged
    .filter((section) => normalizeChunkText(section.text).length > 0)
    .map((section, index) => {
      const normalized = normalizeChunkText(section.text);
      const chunkClocks = parseImessageLineClocks(normalized, opts) ?? sourceMetadataClocks;
      return {
        ordinal: index,
        text: normalized,
        chunkHash: sha256Hex(normalized),
        meta: {
          headingPath: section.headingPath,
          startLine: section.startLine,
          endLine: section.endLine,
          ...chunkClocks,
          ...sourceRefsMeta(opts.sourceRefs),
        },
      };
    });
}

export function chunkTranscript(content: string, opts: ChunkTranscriptOptions = {}): ChunkDraft[] {
  const minChunkChars = opts.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  const maxChunkChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const gapSeconds = opts.gapSeconds ?? DEFAULT_TRANSCRIPT_GAP_SECONDS;
  const parsedBlocks = parseTranscriptBlocks(content, opts.meetingStartTime);
  const firstTurnIndex = parsedBlocks.findIndex((block) => block.startTime);
  const blocks = firstTurnIndex >= 0 ? parsedBlocks.slice(firstTurnIndex) : parsedBlocks;
  const chunks: TranscriptBlock[][] = [];
  let current: TranscriptBlock[] = [];

  for (const block of blocks) {
    const previousTurn = lastTurnBlock(current);
    if (
      block.startTime
      && previousTurn?.endTime
      && secondsBetween(previousTurn.endTime, block.startTime) > gapSeconds
      && current.length > 0
      && renderTranscriptChunk(current).length >= minChunkChars
    ) {
      chunks.push(current);
      current = [];
    }

    if (current.length > 0 && renderTranscriptChunk([...current, block]).length > maxChunkChars) {
      chunks.push(current);
      current = [];
    }

    current.push(block);
  }

  if (current.length > 0) chunks.push(current);

  return chunks
    .map((chunk) => transcriptChunkFromBlocks(chunk))
    .filter((chunk) => normalizeChunkText(chunk.text).length > 0)
    .map((chunk, index) => ({
      ordinal: index,
      text: chunk.text,
      chunkHash: sha256Hex(chunk.text),
      meta: {
        ...chunk.meta,
        ...sourceRefsMeta(opts.sourceRefs),
      },
    }));
}

function sourceRefsMeta(
  sourceRefs: readonly StagedDocumentSourceRef[] | null | undefined,
): { sourceRefs?: StagedDocumentSourceRef[] } {
  if (!sourceRefs || sourceRefs.length === 0) return {};
  return { sourceRefs: sourceRefs.map((ref) => ({ ...ref })) };
}

export function normalizeChunkText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitAtHeadings(content: string): Section[] {
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const lines = normalizedContent.split("\n");
  const sections: Section[] = [];
  const headingStack: string[] = [];
  let sectionStart = 0;
  let sectionHeadingPath: string[] = [];
  let inFence = false;
  let fenceMarker: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = fenceMatch(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence.marker;
      } else if (fence.marker === fenceMarker) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }

    if (inFence) continue;

    const heading = headingMatch(line);
    if (!heading) continue;

    if (index > sectionStart) {
      sections.push(sectionFromLines(lines, sectionStart, index - 1, sectionHeadingPath));
    }

    headingStack.splice(heading.level - 1);
    headingStack[heading.level - 1] = heading.title;
    sectionHeadingPath = headingStack.filter(Boolean);
    sectionStart = index;
  }

  if (sectionStart < lines.length) {
    sections.push(sectionFromLines(lines, sectionStart, lines.length - 1, sectionHeadingPath));
  }

  return sections;
}

function splitLargeSection(section: Section, maxChunkChars: number): Section[] {
  if (normalizeChunkText(section.text).length <= maxChunkChars) return [section];

  const blocks = splitIntoBlocks(section.text, section.startLine).flatMap((block) =>
    splitOversizedPlainBlock(block, maxChunkChars)
  );
  const chunks: Section[] = [];
  let current: TextBlock[] = [];
  let currentLength = 0;

  for (const block of blocks) {
    const blockLength = normalizeChunkText(block.text).length;
    if (current.length > 0 && currentLength + blockLength + 2 > maxChunkChars) {
      chunks.push(sectionFromBlocks(current, section.headingPath));
      current = [];
      currentLength = 0;
    }
    current.push(block);
    currentLength += blockLength + (current.length > 1 ? 2 : 0);
  }

  if (current.length > 0) {
    chunks.push(sectionFromBlocks(current, section.headingPath));
  }

  return chunks;
}

function mergeSmallSections(sections: Section[], minChunkChars: number): Section[] {
  const merged: Section[] = [];
  for (const section of sections) {
    const normalizedLength = normalizeChunkText(section.text).length;
    if (normalizedLength < minChunkChars && merged.length > 0) {
      const previous = merged[merged.length - 1];
      previous.text = joinSectionText(previous.text, section.text);
      previous.endLine = section.endLine;
      continue;
    }
    merged.push({ ...section, headingPath: [...section.headingPath] });
  }
  return merged;
}

function splitIntoBlocks(text: string, startLine: number): TextBlock[] {
  const lines = text.split("\n");
  const blocks: TextBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const blockStart = index;
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = fenceMatch(line);
    if (fence) {
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? "";
        index += 1;
        const closingFence = fenceMatch(next);
        if (closingFence?.marker === fence.marker) break;
      }
      blocks.push(blockFromLines(lines, blockStart, index - 1, startLine, "fence"));
      continue;
    }

    if (isMarkdownTableLine(line)) {
      index += 1;
      while (index < lines.length && isMarkdownTableLine(lines[index] ?? "")) {
        index += 1;
      }
      blocks.push(blockFromLines(lines, blockStart, index - 1, startLine, "table"));
      continue;
    }

    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "" || fenceMatch(next) || isMarkdownTableLine(next)) break;
      index += 1;
    }
    blocks.push(blockFromLines(lines, blockStart, index - 1, startLine, "plain"));
  }

  return blocks;
}

function splitOversizedPlainBlock(block: TextBlock, maxChunkChars: number): TextBlock[] {
  if (block.kind !== "plain" || normalizeChunkText(block.text).length <= maxChunkChars) return [block];

  const pieces: TextBlock[] = [];
  let currentLines: string[] = [];
  let currentStartLine = block.startLine;

  const flushLines = (endLine: number) => {
    if (currentLines.length === 0) return;
    pieces.push({
      text: currentLines.join("\n"),
      startLine: currentStartLine,
      endLine,
      kind: "plain",
    });
    currentLines = [];
  };

  const lines = block.text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = block.startLine + index;
    if (normalizeChunkText(line).length > maxChunkChars) {
      flushLines(lineNumber - 1);
      pieces.push(...splitOversizedLine(line, lineNumber, maxChunkChars));
      currentStartLine = lineNumber + 1;
      continue;
    }

    const candidate = [...currentLines, line].join("\n");
    if (currentLines.length > 0 && normalizeChunkText(candidate).length > maxChunkChars) {
      flushLines(lineNumber - 1);
      currentStartLine = lineNumber;
    }
    currentLines.push(line);
  }
  flushLines(block.endLine);

  return pieces;
}

function splitOversizedLine(line: string, lineNumber: number, maxChunkChars: number): TextBlock[] {
  const sentences = splitAtSentenceBoundaries(line);
  const pieces: TextBlock[] = [];
  let current = "";

  const flush = () => {
    if (normalizeChunkText(current).length === 0) return;
    pieces.push({ text: current, startLine: lineNumber, endLine: lineNumber, kind: "plain" });
    current = "";
  };

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (current && normalizeChunkText(candidate).length > maxChunkChars) flush();
    if (normalizeChunkText(sentence).length > maxChunkChars * 2) {
      flush();
      for (let index = 0; index < sentence.length; index += maxChunkChars) {
        pieces.push({
          text: sentence.slice(index, index + maxChunkChars),
          startLine: lineNumber,
          endLine: lineNumber,
          kind: "plain",
        });
      }
      continue;
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  flush();

  return pieces;
}

function splitAtSentenceBoundaries(line: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let index = line.indexOf(". ");
  while (index >= 0) {
    sentences.push(line.slice(start, index + 1));
    start = index + 2;
    index = line.indexOf(". ", start);
  }
  sentences.push(line.slice(start));
  return sentences.filter((sentence) => sentence.length > 0);
}

function sectionFromBlocks(blocks: TextBlock[], headingPath: string[]): Section {
  return {
    text: blocks.map((block) => block.text).join("\n\n"),
    headingPath: [...headingPath],
    startLine: blocks[0].startLine,
    endLine: blocks[blocks.length - 1].endLine,
  };
}

function sectionFromLines(
  lines: string[],
  startIndex: number,
  endIndex: number,
  headingPath: string[],
): Section {
  return {
    text: lines.slice(startIndex, endIndex + 1).join("\n"),
    headingPath: [...headingPath],
    startLine: startIndex + 1,
    endLine: endIndex + 1,
  };
}

function blockFromLines(
  lines: string[],
  startIndex: number,
  endIndex: number,
  sourceStartLine: number,
  kind: TextBlock["kind"],
): TextBlock {
  return {
    text: lines.slice(startIndex, endIndex + 1).join("\n"),
    startLine: sourceStartLine + startIndex,
    endLine: sourceStartLine + endIndex,
    kind,
  };
}

function joinSectionText(left: string, right: string): string {
  return `${left.replace(/\s+$/g, "")}\n\n${right.replace(/^\s+/g, "")}`;
}

function headingMatch(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

function fenceMatch(line: string): { marker: string } | null {
  const match = /^[ \t]*(```+|~~~+)/.exec(line);
  if (!match) return null;
  return { marker: match[1][0] };
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && trimmed.length > 1;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseTranscriptBlocks(
  content: string,
  meetingStartTime: Date | string | null | undefined,
): TranscriptBlock[] {
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const paragraphs = splitParagraphsWithLineNumbers(normalizedContent);
  const headingStack: string[] = [];
  const blocks: TranscriptBlock[] = [];

  for (const paragraph of paragraphs) {
    const firstLine = paragraph.text.split("\n")[0] ?? "";
    const heading = headingMatch(firstLine);
    if (heading) {
      headingStack.splice(heading.level - 1);
      headingStack[heading.level - 1] = heading.title;
    }

    const headingPath = headingStack.filter(Boolean);
    const turn = parseTranscriptTurn(paragraph.text, meetingStartTime);
    if (turn) {
      blocks.push({
        startLine: paragraph.startLine,
        endLine: paragraph.endLine,
        headingPath,
        renderedText: `${turn.speaker}: ${turn.text}`.trimEnd(),
        startTime: turn.startTime,
        endTime: turn.endTime,
      });
      continue;
    }

    blocks.push({
      startLine: paragraph.startLine,
      endLine: paragraph.endLine,
      headingPath,
      renderedText: paragraph.text,
    });
  }

  return blocks;
}

function splitParagraphsWithLineNumbers(content: string): Array<{ text: string; startLine: number; endLine: number }> {
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const lines = normalizedContent.split("\n");
  const paragraphs: Array<{ text: string; startLine: number; endLine: number }> = [];
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
    if (index >= lines.length) break;

    const startIndex = index;
    while (index < lines.length && (lines[index] ?? "").trim() !== "") index += 1;
    paragraphs.push({
      text: lines.slice(startIndex, index).join("\n"),
      startLine: startIndex + 1,
      endLine: index,
    });
  }

  return paragraphs;
}

function parseTranscriptTurn(
  text: string,
  meetingStartTime: Date | string | null | undefined,
): { startTime: string; endTime: string; speaker: string; text: string } | null {
  const match = TRANSCRIPT_TURN_RE.exec(text);
  if (!match) return null;
  const timing = match[1].split(/\s+-\s+/u);
  const startTime = transcriptClock(timing[0] ?? "", meetingStartTime);
  const endTime = transcriptClock(timing[1] ?? timing[0] ?? "", meetingStartTime);
  if (!startTime || !endTime) return null;
  return {
    startTime,
    endTime,
    speaker: match[2].trim(),
    text: match[3] ?? "",
  };
}

function lastTurnBlock(blocks: TranscriptBlock[]): TranscriptBlock | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].endTime) return blocks[index];
  }
  return null;
}

function renderTranscriptChunk(blocks: TranscriptBlock[]): string {
  const firstTurn = blocks.find((block) => block.startTime);
  const lastTurn = lastTurnBlock(blocks);
  const body = blocks.map((block) => block.renderedText).join("\n\n");
  const text = firstTurn?.startTime && lastTurn?.endTime
    ? `[${truncateIsoToMinute(firstTurn.startTime)} – ${truncateIsoToMinute(lastTurn.endTime)}]\n${body}`
    : body;
  return normalizeChunkText(text);
}

function transcriptChunkFromBlocks(blocks: TranscriptBlock[]): ChunkDraft {
  const firstTurn = blocks.find((block) => block.startTime);
  const lastTurn = lastTurnBlock(blocks);
  const text = renderTranscriptChunk(blocks);
  const meta: ChunkDraft["meta"] = {
    headingPath: [...blocks[0].headingPath],
    startLine: blocks[0].startLine,
    endLine: blocks[blocks.length - 1].endLine,
  };
  if (firstTurn?.startTime && lastTurn?.endTime) {
    meta.startTime = firstTurn.startTime;
    meta.endTime = lastTurn.endTime;
  }
  return {
    ordinal: 0,
    text,
    chunkHash: sha256Hex(text),
    meta,
  };
}

function truncateIsoToMinute(iso: string): string {
  const millis = Date.parse(normalizeUtcIsoDateTime(iso));
  if (Number.isFinite(millis)) return `${new Date(millis).toISOString().slice(0, 16)}Z`;
  return `${iso.slice(0, 16)}Z`;
}

function secondsBetween(leftIso: string, rightIso: string): number {
  return (Date.parse(normalizeUtcIsoDateTime(rightIso)) - Date.parse(normalizeUtcIsoDateTime(leftIso))) / 1000;
}

function parseSourceMetadataClocks(content: string): Pick<ChunkDraft["meta"], "startTime" | "endTime"> | null {
  const rows = parseSourceMetadataRows(content);
  const dateTime = dateMetadataValue(rows.get("Date"));
  const startTime = dateMetadataValue(rows.get("Start")) ?? dateTime;
  const endTime = dateMetadataValue(rows.get("End")) ?? dateTime;
  if (!startTime && !endTime) return null;
  return {
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
  };
}

function parseSourceMetadataRows(content: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("## ")) break;
    const match = /^- ([^:]+):\s*(.+)$/.exec(line);
    if (match) rows.set(match[1], match[2].trim());
  }
  return rows;
}

function dateMetadataValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeUtcIsoDateTime(value);
  return Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function normalizeUtcIsoDateTime(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed)) {
    return `${trimmed}Z`;
  }
  return trimmed;
}

function transcriptClock(
  value: string,
  meetingStartTime: Date | string | null | undefined,
): string | null {
  const trimmed = value.trim();
  const offset = /^(\d+):(\d{2})$/u.exec(trimmed);
  if (offset) {
    const base = dateValue(meetingStartTime);
    const seconds = Number(offset[1]) * 60 + Number(offset[2]);
    if (!base || Number(offset[2]) >= 60 || !Number.isFinite(seconds)) return null;
    return new Date(base.getTime() + seconds * 1000).toISOString();
  }
  const normalized = normalizeUtcIsoDateTime(trimmed);
  return Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function parseImessageLineClocks(
  content: string,
  opts: ChunkMarkdownOptions,
): Pick<ChunkDraft["meta"], "startTime" | "endTime"> | null {
  if (!opts.mirrorPath?.replace(/^\/+/, "").startsWith("sources/imessage/")) return null;
  const yearMonth = imessageYearMonth(opts.mirrorPath, opts.sourceUpdatedAt);
  if (!yearMonth) return null;
  const clocks: string[] = [];
  const stampRe = /^\*\*(\d{2})-(\d{2}) (\d{2}):(\d{2})\*\*/gmu;
  for (const match of content.matchAll(stampRe)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const hour = Number(match[3]);
    const minute = Number(match[4]);
    if (month !== yearMonth.month || day < 1 || day > 31 || hour > 23 || minute > 59) continue;
    const date = new Date(Date.UTC(yearMonth.year, month - 1, day, hour, minute));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    clocks.push(date.toISOString());
  }
  if (clocks.length === 0) return null;
  return { startTime: clocks[0], endTime: clocks.at(-1)! };
}

function imessageYearMonth(
  mirrorPath: string,
  sourceUpdatedAt: Date | string | null | undefined,
): { year: number; month: number } | null {
  const filename = /\/(\d{4})-(\d{2})\.md$/u.exec(mirrorPath);
  if (filename) {
    const month = Number(filename[2]);
    if (month >= 1 && month <= 12) return { year: Number(filename[1]), month };
  }
  const sourceDate = dateValue(sourceUpdatedAt);
  return sourceDate
    ? { year: sourceDate.getUTCFullYear(), month: sourceDate.getUTCMonth() + 1 }
    : null;
}

function dateValue(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
