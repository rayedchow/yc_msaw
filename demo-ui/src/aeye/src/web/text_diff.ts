export type DiffRowKind = "context" | "add" | "del";

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface LineDiff {
  rows: DiffRow[];
  addedLines: number;
  removedLines: number;
  /** True when the inputs were too large for an exact diff. */
  truncated: boolean;
}

const MAX_COMPARISON_CELLS = 4_000_000;

/**
 * A bounded exact line diff (common prefix/suffix trim plus LCS over the
 * middle). When the middle region is too large for the cell budget, the diff
 * degrades honestly to whole-block replacement rows with `truncated` set.
 */
export function diffLines(previous: string, current: string): LineDiff {
  const oldLines = splitLines(previous);
  const newLines = splitLines(current);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);

  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  const pushContext = (text: string) => {
    rows.push({ kind: "context", text, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  };
  const pushDeletion = (text: string) => {
    rows.push({ kind: "del", text, oldLine, newLine: null });
    oldLine += 1;
  };
  const pushAddition = (text: string) => {
    rows.push({ kind: "add", text, oldLine: null, newLine });
    newLine += 1;
  };

  for (let index = 0; index < prefix; index += 1) pushContext(oldLines[index]!);

  let truncated = false;
  if (oldMiddle.length * newMiddle.length > MAX_COMPARISON_CELLS) {
    truncated = true;
    for (const text of oldMiddle) pushDeletion(text);
    for (const text of newMiddle) pushAddition(text);
  } else {
    for (const operation of lcsOperations(oldMiddle, newMiddle)) {
      if (operation.kind === "context") pushContext(operation.text);
      else if (operation.kind === "del") pushDeletion(operation.text);
      else pushAddition(operation.text);
    }
  }

  for (let index = oldLines.length - suffix; index < oldLines.length; index += 1) {
    pushContext(oldLines[index]!);
  }

  return {
    rows,
    addedLines: rows.filter((row) => row.kind === "add").length,
    removedLines: rows.filter((row) => row.kind === "del").length,
    truncated,
  };
}

interface DiffOperation {
  kind: DiffRowKind;
  text: string;
}

function lcsOperations(oldLines: readonly string[], newLines: readonly string[]): DiffOperation[] {
  const rows = oldLines.length;
  const columns = newLines.length;
  if (rows === 0) return newLines.map((text) => ({ kind: "add" as const, text }));
  if (columns === 0) return oldLines.map((text) => ({ kind: "del" as const, text }));

  // lengths[i][j] = LCS length of oldLines[i..] vs newLines[j..]
  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = oldLines[i] === newLines[j]
        ? lengths[(i + 1) * width + j + 1]! + 1
        : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }

  const operations: DiffOperation[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (oldLines[i] === newLines[j]) {
      operations.push({ kind: "context", text: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      operations.push({ kind: "del", text: oldLines[i]! });
      i += 1;
    } else {
      operations.push({ kind: "add", text: newLines[j]! });
      j += 1;
    }
  }
  while (i < rows) {
    operations.push({ kind: "del", text: oldLines[i]! });
    i += 1;
  }
  while (j < columns) {
    operations.push({ kind: "add", text: newLines[j]! });
    j += 1;
  }
  return operations;
}

function splitLines(value: string): string[] {
  if (value === "") return [];
  const normalized = value.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
