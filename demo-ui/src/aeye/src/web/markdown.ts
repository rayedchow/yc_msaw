/*
 * Port of AEye src/web/markdown.ts (askshepherd/aeye-shepherd @ a49aae10e219a7b3aa36102099b649340c2d42b0)
 * for agent prose: the same markdown-it configuration (HTML disabled,
 * linkify, no typographer), the same external-link rel rule, image rule (no
 * citations exist here, so every image reads "Figure unavailable") and
 * table wrapper, and leadingMarkdownTitle verbatim. Omitted: KaTeX, citation markers, Knowledge link
 * normalization and passage highlights, which only apply to Knowledge pages.
 */
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});

const defaultLinkRule = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  const token = tokens[index];
  const hrefIndex = token?.attrIndex("href") ?? -1;
  const href = hrefIndex >= 0 ? token?.attrs?.[hrefIndex]?.[1] : undefined;
  if (href?.startsWith("http://") || href?.startsWith("https://")) {
    token?.attrSet("rel", "noreferrer noopener");
  }
  return defaultLinkRule ? defaultLinkRule(tokens, index, options, environment, self) : self.renderToken(tokens, index, options);
};

markdown.renderer.rules.image = (tokens, index) => {
  const alt = tokens[index]?.content.trim() ?? "";
  return `<span class="figure-unavailable" role="note">Figure unavailable${alt ? `: ${escapeHtml(alt)}` : ""}</span>`;
};

markdown.renderer.rules.table_open = () => `<div class="markdown-table-wrap"><table>`;
markdown.renderer.rules.table_close = () => `</table></div>`;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderMarkdown(value: string): string {
  return markdown.render(value);
}

/**
 * The text of the level-one heading a Markdown page opens with (after any
 * YAML frontmatter, blank lines and HTML comments), or null. A view that
 * shows a page's title must not add its own H1 when the page already has
 * one, or the title is announced and shown twice.
 */
export function leadingMarkdownTitle(markdown: string): string | null {
  let rest = markdown.replace(/^\uFEFF/u, "");
  const frontmatter = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(rest);
  if (frontmatter !== null) rest = rest.slice(frontmatter[0].length);
  rest = rest.replace(/^(?:\s|<!--[\s\S]*?-->)*/u, "");
  const heading = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/u.exec(rest);
  const text = heading?.[1]?.trim() ?? "";
  return text === "" ? null : text;
}
