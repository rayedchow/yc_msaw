interface TextNode {
  type: "text";
  value: string;
}

interface ElementNode {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: StorageNode[];
}

type StorageNode = TextNode | ElementNode;

const BLOCK_TAGS = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "ul",
  "ac:layout",
  "ac:layout-cell",
  "ac:layout-section",
  "ac:structured-macro",
]);

export function storageFormatToMarkdown(input: string | null | undefined): string {
  if (!input) return "";
  const root = parseStorage(input);
  return normalizeMarkdown(renderBlocks(root.children));
}

function parseStorage(input: string): ElementNode {
  const root: ElementNode = { type: "element", name: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const tokenPattern = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(input)) !== null) {
    const token = match[0];
    const parent = stack[stack.length - 1] ?? root;
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("<![CDATA[")) {
      parent.children.push({ type: "text", value: match[1] ?? "" });
      continue;
    }
    if (!token.startsWith("<")) {
      parent.children.push({ type: "text", value: token });
      continue;
    }
    if (/^<\s*\//u.test(token)) {
      const closingName = token.match(/^<\s*\/\s*([^\s>]+)\s*>$/u)?.[1]?.toLowerCase();
      if (!closingName) continue;
      while (stack.length > 1) {
        const open = stack.pop();
        if (open?.name.toLowerCase() === closingName) break;
      }
      continue;
    }
    const open = parseOpenTag(token);
    if (!open) continue;
    parent.children.push(open.node);
    if (!open.selfClosing) stack.push(open.node);
  }
  return root;
}

function parseOpenTag(token: string): { node: ElementNode; selfClosing: boolean } | null {
  const match = token.match(/^<\s*([^\s/>]+)([\s\S]*?)>$/u);
  if (!match) return null;
  const name = match[1];
  const attrSource = match[2] ?? "";
  const selfClosing = /\/\s*>$/u.test(token) || isVoidTag(name);
  return {
    node: {
      type: "element",
      name,
      attrs: parseAttrs(attrSource),
      children: [],
    },
    selfClosing,
  };
}

function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(input)) !== null) {
    attrs[match[1]] = decodeHtml(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function renderBlocks(nodes: StorageNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    const rendered = renderBlock(node);
    if (rendered.trim().length > 0) parts.push(rendered.trim());
  }
  return parts.join("\n\n");
}

function renderBlock(node: StorageNode): string {
  if (node.type === "text") return inlineText(node.value).trim();
  const tag = node.name.toLowerCase();
  if (/^h[1-6]$/u.test(tag)) {
    return `${"#".repeat(Number(tag.slice(1)))} ${renderInline(node.children).trim()}`;
  }
  if (tag === "p" || tag === "div") return renderInline(node.children).trim();
  if (tag === "blockquote") {
    return renderBlocks(node.children).split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
  }
  if (tag === "ul" || tag === "ol") return renderList(node, tag === "ol");
  if (tag === "li") return renderBlocks(node.children);
  if (tag === "br") return "\n";
  if (tag === "table") return renderTable(node);
  if (tag === "pre") return fencedBlock("", textContent(node));
  if (tag === "ac:structured-macro") return renderMacro(node);
  if (tag === "ac:link") return renderAcLink(node);
  if (tag === "ac:emoticon") return renderEmoticon(node);
  if (tag === "ac:image") return renderImage(node);
  return hasBlockChild(node) ? renderBlocks(node.children) : renderInline(node.children).trim();
}

function renderInline(nodes: StorageNode[]): string {
  return nodes.map(renderInlineNode).join("").replace(/[ \t\r\n]+/g, " ").trim();
}

function renderInlineNode(node: StorageNode): string {
  if (node.type === "text") return inlineText(node.value);
  const tag = node.name.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "strong" || tag === "b") return `**${renderInline(node.children)}**`;
  if (tag === "em" || tag === "i") return `*${renderInline(node.children)}*`;
  if (tag === "code") return `\`${textContent(node).trim()}\``;
  if (tag === "a") {
    const href = node.attrs.href;
    const label = renderInline(node.children) || href || "";
    return href ? `[${label}](${href})` : label;
  }
  if (tag === "ac:link") return renderAcLink(node);
  if (tag === "ac:emoticon") return renderEmoticon(node);
  if (tag === "ac:image") return renderImage(node);
  if (tag === "ac:structured-macro") return renderMacro(node);
  return renderInline(node.children);
}

function renderList(node: ElementNode, ordered: boolean): string {
  const items = node.children.filter(isElementNamed("li"));
  return items.map((item, index) => {
    const marker = ordered ? `${index + 1}. ` : "- ";
    const content = renderBlocks(item.children).trim();
    const lines = content.length > 0 ? content.split("\n") : [""];
    return lines.map((line, lineIndex) => {
      if (lineIndex === 0) return `${marker}${line}`.trimEnd();
      return `${" ".repeat(marker.length)}${line}`.trimEnd();
    }).join("\n");
  }).join("\n");
}

function renderTable(node: ElementNode): string {
  if (tableHasMergedCells(node)) return serializeHtml(node);
  const rows = tableRows(node).map((row) => tableCells(row).map(renderCellMarkdown));
  if (rows.length === 0) return "";
  const header = rows[0];
  const body = rows.slice(1);
  return [
    `| ${header.map(escapePipeCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${padRow(row, header.length).map(escapePipeCell).join(" | ")} |`),
  ].join("\n");
}

function renderMacro(node: ElementNode): string {
  const name = attr(node, "ac:name") || attr(node, "name") || "unknown";
  const params = macroParams(node);
  if (name === "code") {
    const language = params.language ?? params.lang ?? "";
    const body = firstDescendant(node, "ac:plain-text-body");
    return fencedBlock(language, body ? textContent(body) : "");
  }
  return `<!-- macro:${sanitizeComment(name)} params:${sanitizeComment(JSON.stringify(params))} -->`;
}

function renderAcLink(node: ElementNode): string {
  const body = firstDescendant(node, "ac:plain-text-link-body");
  const bodyLabel = body ? textContent(body).trim() : "";
  const page = firstDescendant(node, "ri:page");
  const pageTitle = page ? attr(page, "ri:content-title") || attr(page, "content-title") : "";
  if (pageTitle) return `[${bodyLabel || pageTitle}](page:${pageTitle})`;

  const attachment = firstDescendant(node, "ri:attachment");
  const filename = attachment ? attr(attachment, "ri:filename") || attr(attachment, "filename") : "";
  if (filename) return `[[attachment:${filename}]]`;

  const space = firstDescendant(node, "ri:space");
  const spaceKey = space
    ? attr(space, "ri:space-key") || attr(space, "space-key") || attr(space, "ri:key") || attr(space, "key")
    : "";
  if (spaceKey) return `[[space:${spaceKey}]]`;

  const urlNode = firstDescendant(node, "ri:url");
  const url = urlNode ? attr(urlNode, "ri:value") || attr(urlNode, "value") : "";
  if (url) return `[${bodyLabel || url}](${url})`;
  return "<!-- link:unknown -->";
}

function renderEmoticon(node: ElementNode): string {
  return attr(node, "ac:emoji-fallback")
    || attr(node, "emoji-fallback")
    || `:${attr(node, "ac:name") || attr(node, "name") || "emoticon"}:`;
}

function renderImage(node: ElementNode): string {
  const attachment = firstDescendant(node, "ri:attachment");
  const filename = attachment ? attr(attachment, "ri:filename") || attr(attachment, "filename") : "";
  if (filename) return `![[attachment:${filename}]]`;
  const urlNode = firstDescendant(node, "ri:url");
  const url = urlNode ? attr(urlNode, "ri:value") || attr(urlNode, "value") : "";
  if (url) return `![](${url})`;
  return "<!-- image:unknown -->";
}

function macroParams(node: ElementNode): Record<string, string> {
  const params: Record<string, string> = {};
  for (const child of descendants(node)) {
    if (child.name.toLowerCase() !== "ac:parameter") continue;
    const name = attr(child, "ac:name") || attr(child, "name");
    if (name) params[name] = textContent(child).trim();
  }
  return params;
}

function tableHasMergedCells(node: ElementNode): boolean {
  return tableRows(node).some((row) => tableCells(row).some((cell) =>
    mergedAttr(cell, "rowspan")
    || mergedAttr(cell, "colspan")
    || descendants(cell).some((descendant) => descendant.name.toLowerCase() === "table" && tableHasMergedCells(descendant))
  ));
}

function mergedAttr(node: ElementNode, name: string): boolean {
  const value = attr(node, name);
  return value !== null && Number(value || "1") > 1;
}

function tableRows(node: ElementNode): ElementNode[] {
  const rows: ElementNode[] = [];
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const tag = child.name.toLowerCase();
    if (tag === "tr") rows.push(child);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") rows.push(...tableRows(child));
  }
  return rows;
}

function tableCells(row: ElementNode): ElementNode[] {
  return row.children.filter((child): child is ElementNode =>
    child.type === "element" && (child.name.toLowerCase() === "th" || child.name.toLowerCase() === "td")
  );
}

function renderCellMarkdown(cell: ElementNode): string {
  const rendered = hasBlockChild(cell) ? renderBlocks(cell.children) : renderInline(cell.children);
  return normalizeMarkdown(rendered).replace(/\n/gu, "<br>");
}

function serializeHtml(node: StorageNode): string {
  if (node.type === "text") {
    const text = decodeHtml(node.value).trim();
    return text.length > 0 ? escapeHtml(text) : "";
  }
  const attrs = Object.entries(node.attrs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join("");
  return `<${node.name}${attrs}>${node.children.map(serializeHtml).join("")}</${node.name}>`;
}

function fencedBlock(language: string, body: string): string {
  const lang = language.replace(/[^A-Za-z0-9_+.-]/gu, "");
  return `\`\`\`${lang}\n${body.replace(/\s+$/gu, "")}\n\`\`\``;
}

function hasBlockChild(node: ElementNode): boolean {
  return node.children.some((child) => child.type === "element" && BLOCK_TAGS.has(child.name.toLowerCase()));
}

function firstDescendant(node: ElementNode, name: string): ElementNode | null {
  const lowered = name.toLowerCase();
  for (const child of descendants(node)) {
    if (child.name.toLowerCase() === lowered) return child;
  }
  return null;
}

function descendants(node: ElementNode): ElementNode[] {
  const found: ElementNode[] = [];
  for (const child of node.children) {
    if (child.type !== "element") continue;
    found.push(child, ...descendants(child));
  }
  return found;
}

function textContent(node: ElementNode): string {
  return node.children.map((child) => child.type === "text" ? decodeHtml(child.value) : textContent(child)).join("");
}

function inlineText(value: string): string {
  return decodeHtml(value).replace(/\s+/gu, " ");
}

function padRow(row: string[], length: number): string[] {
  return Array.from({ length }, (_, index) => row[index] ?? "");
}

function escapePipeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, " ").trim();
}

function attr(node: ElementNode, name: string): string | null {
  return node.attrs[name] ?? node.attrs[name.toLowerCase()] ?? null;
}

function isElementNamed(name: string): (node: StorageNode) => node is ElementNode {
  return (node): node is ElementNode => node.type === "element" && node.name.toLowerCase() === name;
}

function isVoidTag(name: string): boolean {
  return ["br", "hr", "img", "input", "meta", "link"].includes(name.toLowerCase());
}

function normalizeMarkdown(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, body: string) => {
    const lowered = body.toLowerCase();
    if (lowered === "amp") return "&";
    if (lowered === "lt") return "<";
    if (lowered === "gt") return ">";
    if (lowered === "quot") return "\"";
    if (lowered === "apos") return "'";
    if (lowered === "nbsp") return " ";
    if (lowered.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lowered.slice(2), 16));
    if (lowered.startsWith("#")) return String.fromCodePoint(Number.parseInt(lowered.slice(1), 10));
    return entity;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function sanitizeComment(value: string): string {
  return value.replace(/--/gu, "- -");
}
