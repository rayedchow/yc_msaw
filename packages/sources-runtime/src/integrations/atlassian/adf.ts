export interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

interface AdfMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

export function adfToMarkdown(doc: unknown): string {
  if (!isAdfNode(doc)) return "";
  return normalizeMarkdown(renderBlocks([doc]));
}

function renderBlocks(nodes: AdfNode[] | undefined): string {
  const parts = (nodes ?? [])
    .map(renderBlock)
    .filter((part) => part.trim().length > 0);
  return parts.join("\n\n");
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case "doc":
      return renderBlocks(node.content);
    case "paragraph":
      return renderInline(node.content);
    case "heading": {
      const level = numberAttr(node, "level") ?? 1;
      return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${renderInline(node.content)}`.trim();
    }
    case "bulletList":
      return renderList(node, false);
    case "orderedList":
      return renderList(node, true);
    case "listItem":
      return renderBlocks(node.content);
    case "blockquote":
      return renderBlocks(node.content).split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    case "codeBlock":
      return fencedBlock(stringAttr(node, "language") ?? "", plainText(node));
    case "rule":
      return "---";
    case "table":
      return renderTable(node);
    case "mediaSingle":
      return renderMediaSingle(node);
    case "text":
    case "mention":
    case "hardBreak":
      return renderInlineNode(node);
    default:
      return [unknownNodeComment(node), renderBlocks(node.content)]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
  }
}

function renderInline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(renderInlineNode).join("").replace(/[ \t\r\n]+/g, " ").trim();
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks);
    case "hardBreak":
      return "\n";
    case "mention":
      return `@${stringAttr(node, "text") ?? stringAttr(node, "displayName") ?? stringAttr(node, "id") ?? "unknown"}`;
    case "mediaSingle":
      return renderMediaSingle(node);
    case "emoji":
      return stringAttr(node, "text") ?? `:${stringAttr(node, "shortName") ?? stringAttr(node, "id") ?? "emoji"}:`;
    case "inlineCard": {
      const url = stringAttr(node, "url");
      return url ? `[${url}](${url})` : "<!-- adf-node:inlineCard -->";
    }
    default:
      return unknownInlineNode(node);
  }
}

function applyMarks(value: string, marks: AdfMark[] | undefined): string {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  let rendered = value.slice(leading.length, value.length - trailing.length);
  if (rendered.length === 0) return value;
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case "strong":
        rendered = `**${rendered}**`;
        break;
      case "em":
        rendered = `*${rendered}*`;
        break;
      case "code":
        rendered = `\`${rendered}\``;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : null;
        if (href) rendered = `[${rendered}](${href})`;
        break;
      }
      default:
        break;
    }
  }
  return `${leading}${rendered}${trailing}`;
}

function renderList(node: AdfNode, ordered: boolean): string {
  const items = (node.content ?? []).filter((item) => item.type === "listItem");
  return items.map((item, index) => {
    const marker = ordered ? `${index + 1}. ` : "- ";
    const lines = (renderBlocks(item.content).trim() || "").split("\n");
    return lines.map((line, lineIndex) => {
      if (lineIndex === 0) return `${marker}${line}`.trimEnd();
      return `${" ".repeat(marker.length)}${line}`.trimEnd();
    }).join("\n");
  }).join("\n");
}

function renderTable(node: AdfNode): string {
  const rows = (node.content ?? []).filter((row) => row.type === "tableRow");
  if (tableHasMergedCells(rows)) return renderHtmlTable(rows);
  const cells = rows.map((row) => (row.content ?? [])
    .filter((cell) => cell.type === "tableCell" || cell.type === "tableHeader")
    .map(renderCellMarkdown));
  if (cells.length === 0) return "";
  const header = cells[0];
  const body = cells.slice(1);
  return [
    `| ${header.map(escapePipeCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${padRow(row, header.length).map(escapePipeCell).join(" | ")} |`),
  ].join("\n");
}

function renderHtmlTable(rows: AdfNode[]): string {
  return `<table>${rows.map((row) => `<tr>${(row.content ?? [])
    .filter((cell) => cell.type === "tableCell" || cell.type === "tableHeader")
    .map(renderHtmlCell)
    .join("")}</tr>`).join("")}</table>`;
}

function renderHtmlCell(cell: AdfNode): string {
  const tag = cell.type === "tableHeader" ? "th" : "td";
  const attrs = [
    htmlSpanAttr(cell, "colspan"),
    htmlSpanAttr(cell, "rowspan"),
  ].filter(Boolean).join("");
  return `<${tag}${attrs}>${renderCellMarkdown(cell)}</${tag}>`;
}

function htmlSpanAttr(node: AdfNode, name: "colspan" | "rowspan"): string {
  const value = numberAttr(node, name);
  return value && value > 1 ? ` ${name}="${value}"` : "";
}

function tableHasMergedCells(rows: AdfNode[]): boolean {
  return rows.some((row) => (row.content ?? []).some((cell) =>
    (cell.type === "tableCell" || cell.type === "tableHeader")
    && (
      (numberAttr(cell, "colspan") ?? 1) > 1
      || (numberAttr(cell, "rowspan") ?? 1) > 1
      || descendantTables(cell).some((table) => tableHasMergedCells((table.content ?? []).filter((row) => row.type === "tableRow")))
    )
  ));
}

function renderCellMarkdown(cell: AdfNode): string {
  return normalizeMarkdown(renderBlocks(cell.content)).replace(/\n/g, "<br>");
}

function renderMediaSingle(node: AdfNode): string {
  const media = firstDescendant(node, "media");
  const id = media ? stringAttr(media, "id") : null;
  return id ? `![[media:${id}]]` : "<!-- media:unknown -->";
}

function firstDescendant(node: AdfNode, type: string): AdfNode | null {
  for (const child of node.content ?? []) {
    if (child.type === type) return child;
    const found = firstDescendant(child, type);
    if (found) return found;
  }
  return null;
}

function plainText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(plainText).join("");
}

function descendantTables(node: AdfNode): AdfNode[] {
  const tables: AdfNode[] = [];
  for (const child of node.content ?? []) {
    if (child.type === "table") tables.push(child);
    tables.push(...descendantTables(child));
  }
  return tables;
}

function fencedBlock(language: string, body: string): string {
  return `\`\`\`${language.replace(/[^A-Za-z0-9_+.-]/gu, "")}\n${body.replace(/\s+$/gu, "")}\n\`\`\``;
}

function unknownNodeComment(node: AdfNode): string {
  return `<!-- adf-node:${sanitizeComment(node.type ?? "unknown")} -->`;
}

function unknownInlineNode(node: AdfNode): string {
  const text = plainText(node).replace(/\s+/gu, " ").trim();
  return `${unknownNodeComment(node)}${text}`;
}

function stringAttr(node: AdfNode, name: string): string | null {
  const value = node.attrs?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberAttr(node: AdfNode, name: string): number | null {
  const value = node.attrs?.[name];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  return null;
}

function padRow(row: string[], length: number): string[] {
  return Array.from({ length }, (_, index) => row[index] ?? "");
}

function escapePipeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, " ").trim();
}

function sanitizeComment(value: string): string {
  return value.replace(/--/gu, "- -");
}

function normalizeMarkdown(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isAdfNode(value: unknown): value is AdfNode {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
