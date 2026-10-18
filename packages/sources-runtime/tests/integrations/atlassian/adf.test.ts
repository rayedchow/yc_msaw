import { describe, expect, it } from "vitest";
import { adfToMarkdown } from "../../../src/integrations/atlassian/adf.js";

describe("Atlassian Document Format markdown converter", () => {
  it("renders marks, mentions, media placeholders, simple tables, merged tables, and unknown nodes", () => {
    const markdown = adfToMarkdown({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Jira Context" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ship ", marks: [{ type: "strong" }] },
            { type: "text", text: "carefully", marks: [{ type: "em" }] },
            { type: "text", text: " with " },
            { type: "text", text: "runbook", marks: [{ type: "code" }, { type: "link", attrs: { href: "https://example.com/runbook" } }] },
            { type: "text", text: " and " },
            { type: "mention", attrs: { text: "Ada" } },
          ],
        },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Key" }] }] },
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
            ] },
            { type: "tableRow", content: [
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
            ] },
          ],
        },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [
              { type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "Merged" }] }] },
            ] },
          ],
        },
        {
          type: "mediaSingle",
          content: [{ type: "media", attrs: { id: "media-1" } }],
        },
        { type: "extension", attrs: { extensionKey: "unknown" } },
      ],
    });

    expect(markdown).toBe(`## Jira Context

**Ship** *carefully* with [\`runbook\`](https://example.com/runbook) and @Ada

| Key | Value |
| --- | --- |
| A | B |

<table><tr><th colspan="2">Merged</th></tr></table>

![[media:media-1]]

<!-- adf-node:extension -->`);
  });

  it("returns an empty string for null or non-document input", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown("not adf")).toBe("");
  });

  it("keeps unknown block bodies and marks unknown inline nodes before descendant text", () => {
    expect(adfToMarkdown({
      type: "doc",
      content: [
        {
          type: "panel",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First paragraph." }] },
            { type: "paragraph", content: [{ type: "text", text: "Second paragraph." }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Before " },
            { type: "unknownInline", content: [{ type: "text", text: "kept text" }] },
            { type: "text", text: " after." },
          ],
        },
      ],
    })).toBe(`<!-- adf-node:panel -->

First paragraph.

Second paragraph.

Before <!-- adf-node:unknownInline -->kept text after.`);
  });

  it("uses block-aware table cells and escalates an outer table when a nested table has merged cells", () => {
    expect(adfToMarkdown({
      type: "doc",
      content: [{
        type: "table",
        content: [
          { type: "tableRow", content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Checklist" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Owner" }] }] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", content: [{
              type: "bulletList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] },
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Two" }] }] },
              ],
            }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "ENG" }] }] },
          ] },
        ],
      }],
    })).toBe(`| Checklist | Owner |
| --- | --- |
| - One<br>- Two | ENG |`);

    expect(adfToMarkdown({
      type: "doc",
      content: [{
        type: "table",
        content: [{
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [{
                type: "table",
                content: [{
                  type: "tableRow",
                  content: [{
                    type: "tableCell",
                    attrs: { colspan: 2 },
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Nested" }] }],
                  }],
                }],
              }],
            },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Other" }] }] },
          ],
        }],
      }],
    })).toBe("<table><tr><td><table><tr><td colspan=\"2\">Nested</td></tr></table></td><td>Other</td></tr></table>");
  });
});
