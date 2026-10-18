/* Vendored from AEye web/components/workspace/text-file-view.tsx (askshepherd/aeye-shepherd @ a49aae10e219a7b3aa36102099b649340c2d42b0); verbatim apart from this note. */

import React, { memo, useMemo } from "react";

/**
 * A text file in the trace and workspace previews: the whole file, one
 * scrollable document, rendered in blocks of lines. Each block skips layout,
 * paint and accessibility work while it is off screen
 * (`content-visibility: auto`), so a near-1 MB HTML or log file opens at once
 * and never stalls later clicks. A cited span is marked inside the blocks it
 * touches; the other blocks are not re-rendered when it moves.
 */

export const TEXT_BLOCK_LINES = 200;
/** One block also ends at this many characters, so minified one-line files still split. */
export const TEXT_BLOCK_CHARACTERS = 32 * 1024;

export interface TextBlock {
  start: number;
  end: number;
  lines: number;
}

/** Block boundaries (UTF-16 offsets) covering `content` exactly, in order. */
export function textBlocks(
  content: string,
  maxLines = TEXT_BLOCK_LINES,
  maxCharacters = TEXT_BLOCK_CHARACTERS,
): TextBlock[] {
  const blocks: TextBlock[] = [];
  let start = 0;
  while (start < content.length) {
    let end = start;
    let lines = 0;
    while (end < content.length && lines < maxLines) {
      const newline = content.indexOf("\n", end);
      const lineEnd = newline < 0 ? content.length : newline + 1;
      if (lineEnd - start <= maxCharacters) {
        end = lineEnd;
        lines += 1;
        continue;
      }
      // This line would overfill the block: end the block before it, or cut
      // a line that is longer than a whole block on its own.
      if (end === start) {
        end = start + maxCharacters;
        // Never split a surrogate pair.
        const code = content.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end += 1;
        lines += 1;
      }
      break;
    }
    blocks.push({ start, end, lines });
    start = end;
  }
  return blocks;
}

interface Highlight {
  startOffset: number;
  endOffset: number;
}

/** A verified span fully inside the text, or null. */
export function validHighlight(content: string, highlight: Highlight | undefined): Highlight | null {
  return highlight !== undefined &&
    highlight.startOffset >= 0 &&
    highlight.endOffset > highlight.startOffset &&
    highlight.endOffset <= content.length
    ? highlight
    : null;
}

const TextBlockView = memo(function TextBlockView({
  content,
  start,
  end,
  lines,
  markStart,
  markEnd,
  markId,
}: {
  content: string;
  start: number;
  end: number;
  lines: number;
  /** The marked part of this block (offsets into `content`), or -1. */
  markStart: number;
  markEnd: number;
  markId: boolean;
}) {
  const style = { containIntrinsicSize: `auto ${Math.max(1, lines) * 18}px` } as React.CSSProperties;
  if (markStart < 0) {
    return <span className="text-file-block" style={style}>{content.slice(start, end)}</span>;
  }
  return (
    <span className="text-file-block" style={style}>
      {content.slice(start, markStart)}
      <mark id={markId ? "cited-passage" : undefined} className="cited-text">{content.slice(markStart, markEnd)}</mark>
      {content.slice(markEnd, end)}
    </span>
  );
});

export function TextFileView({ content, highlight }: { content: string; highlight?: Highlight | undefined }) {
  const blocks = useMemo(() => textBlocks(content), [content]);
  const marked = validHighlight(content, highlight);
  return (
    <pre className="build-preview-code text-file-view">
      <code>
        {blocks.map((block, index) => {
          const markStart = marked === null ? -1 : Math.max(block.start, marked.startOffset);
          const markEnd = marked === null ? -1 : Math.min(block.end, marked.endOffset);
          const touches = marked !== null && markStart < markEnd;
          return (
            <TextBlockView
              key={index}
              content={content}
              start={block.start}
              end={block.end}
              lines={block.lines}
              markStart={touches ? markStart : -1}
              markEnd={touches ? markEnd : -1}
              markId={touches && marked !== null && block.start <= marked.startOffset}
            />
          );
        })}
      </code>
    </pre>
  );
}
