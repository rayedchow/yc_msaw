import { convert } from "html-to-text";
import TurndownService from "turndown";

export type GmailBodySource = "text/plain" | "html_to_text" | "snippet" | "empty";

export type GmailBodyInput = {
  bodyText?: unknown;
  bodyHtml?: unknown;
  bodyMarkdown?: unknown;
  snippet?: unknown;
};

export type GmailBodyNormalizationOptions = {
  allowSnippetFallback?: boolean;
  includeMarkdown?: boolean;
};

export type NormalizedGmailBody = {
  bodyText: string;
  bodyMarkdown: string;
  bodySource: GmailBodySource;
};

const INVISIBLE_EMAIL_PADDING = /[\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g;

export function normalizeGmailBody(
  input: GmailBodyInput,
  options: GmailBodyNormalizationOptions = {},
): NormalizedGmailBody {
  const plain = cleanEmailText(stringValue(input.bodyText));
  const html = stringValue(input.bodyHtml);
  const existingMarkdown = cleanEmailText(stringValue(input.bodyMarkdown));

  if (plain) {
    return {
      bodyText: plain,
      bodyMarkdown: options.includeMarkdown ? existingMarkdown || htmlToMarkdown(html) : existingMarkdown,
      bodySource: "text/plain",
    };
  }

  const htmlBodyText = htmlToText(html);
  if (htmlBodyText) {
    return {
      bodyText: htmlBodyText,
      bodyMarkdown: options.includeMarkdown ? existingMarkdown || htmlToMarkdown(html) : existingMarkdown,
      bodySource: "html_to_text",
    };
  }

  const snippet = options.allowSnippetFallback ? cleanEmailText(stringValue(input.snippet)) : "";
  if (snippet) {
    return {
      bodyText: snippet,
      bodyMarkdown: existingMarkdown,
      bodySource: "snippet",
    };
  }

  return {
    bodyText: "",
    bodyMarkdown: existingMarkdown,
    bodySource: "empty",
  };
}

export function cleanEmailText(value: string): string {
  return value
    .replace(/\x00/g, "")
    .replace(/\\u0000/g, "")
    .replace(INVISIBLE_EMAIL_PADDING, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html: string): string {
  if (!html.trim()) return "";
  return cleanEmailText(convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "head", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "noscript", format: "skip" },
      { selector: "[hidden]", format: "skip" },
      { selector: "[aria-hidden=\"true\"]", format: "skip" },
      { selector: "[style*=\"display:none\"]", format: "skip" },
      { selector: "[style*=\"display: none\"]", format: "skip" },
      { selector: "[style*=\"max-height:0\"]", format: "skip" },
      { selector: "[style*=\"max-height: 0\"]", format: "skip" },
      { selector: "[style*=\"opacity:0\"]", format: "skip" },
      { selector: "[style*=\"opacity: 0\"]", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "h4", options: { uppercase: false } },
      { selector: "h5", options: { uppercase: false } },
      { selector: "h6", options: { uppercase: false } },
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  }));
}

function htmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    linkStyle: "inlined",
  });
  turndown.remove(["style", "script", "noscript"]);
  turndown.remove((node) => isHiddenElement(node));
  turndown.addRule("dropImages", {
    filter: "img",
    replacement: () => "",
  });
  turndown.addRule("plainLinks", {
    filter: "a",
    replacement: (content) => content,
  });
  return cleanEmailText(turndown.turndown(html));
}

function isHiddenElement(node: HTMLElement): boolean {
  if (node.hasAttribute("hidden")) return true;
  if (node.getAttribute("aria-hidden") === "true") return true;
  const style = node.getAttribute("style")?.toLowerCase() ?? "";
  return style.includes("display:none")
    || style.includes("display: none")
    || style.includes("max-height:0")
    || style.includes("max-height: 0")
    || style.includes("opacity:0")
    || style.includes("opacity: 0");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
