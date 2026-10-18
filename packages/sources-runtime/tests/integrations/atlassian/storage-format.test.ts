import { describe, expect, it } from "vitest";
import { storageFormatToMarkdown } from "../../../src/integrations/atlassian/storage-format.js";

describe("Confluence storage-format markdown converter", () => {
  it("renders a realistic page without flattening constructs markdown cannot represent", () => {
    const markdown = storageFormatToMarkdown(`
      <h1>Release Plan</h1>
      <p>See <a href="https://example.com/spec">the spec</a> before launch.</p>
      <ul>
        <li><p>Alpha</p></li>
        <li><p>Beta</p></li>
      </ul>
      <table>
        <tbody>
          <tr><th>Area</th><th>Owner</th></tr>
          <tr><td>API</td><td>Ishan</td></tr>
        </tbody>
      </table>
      <table>
        <tbody>
          <tr><th rowspan="2">Area</th><th>Risk</th></tr>
          <tr><td>Migration</td></tr>
        </tbody>
      </table>
      <p>Architecture <ac:image><ri:attachment ri:filename="diagram.png" /></ac:image> follows.</p>
      <p>External <ac:image><ri:url ri:value="https://cdn.example.com/image.png" /></ac:image>.</p>
      <ac:structured-macro ac:name="toc">
        <ac:parameter ac:name="maxLevel">3</ac:parameter>
      </ac:structured-macro>
      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">typescript</ac:parameter>
        <ac:plain-text-body><![CDATA[const value = "<ok>";]]></ac:plain-text-body>
      </ac:structured-macro>
    `);

    expect(markdown).toBe(`# Release Plan

See [the spec](https://example.com/spec) before launch.

- Alpha
- Beta

| Area | Owner |
| --- | --- |
| API | Ishan |

<table><tbody><tr><th rowspan="2">Area</th><th>Risk</th></tr><tr><td>Migration</td></tr></tbody></table>

Architecture ![[attachment:diagram.png]] follows.

External ![](https://cdn.example.com/image.png).

<!-- macro:toc params:{"maxLevel":"3"} -->

\`\`\`typescript
const value = "<ok>";
\`\`\``);
    expect(markdown.indexOf("Architecture ![[attachment:diagram.png]] follows.")).toBeGreaterThan(0);
    expect(markdown).toContain("<th rowspan=\"2\">Area</th>");
  });

  it("returns an empty string for empty input", () => {
    expect(storageFormatToMarkdown("")).toBe("");
    expect(storageFormatToMarkdown(null)).toBe("");
  });

  it("preserves Confluence page links, attachment and space link placeholders, and emoticons", () => {
    expect(storageFormatToMarkdown(`
      <p>
        <ac:link><ri:page ri:content-title="Runbook" /></ac:link>
        <ac:link><ri:page ri:content-title="Incident" /><ac:plain-text-link-body><![CDATA[incident process]]></ac:plain-text-link-body></ac:link>
        <ac:link><ri:attachment ri:filename="budget.xlsx" /></ac:link>
        <ac:link><ri:space ri:space-key="ENG" /></ac:link>
        <ac:emoticon ac:name="warning" ac:emoji-fallback=":warning:" />
        <ac:emoticon ac:name="smile" />
      </p>
    `)).toBe("[Runbook](page:Runbook) [incident process](page:Incident) [[attachment:budget.xlsx]] [[space:ENG]] :warning: :smile:");
  });

  it("uses block-aware table cells and escalates an outer table when a nested table has merged cells", () => {
    expect(storageFormatToMarkdown(`
      <table>
        <tr><th>Checklist</th><th>Owner</th></tr>
        <tr><td><ul><li>One</li><li>Two</li></ul></td><td>ENG</td></tr>
      </table>
    `)).toBe(`| Checklist | Owner |
| --- | --- |
| - One<br>- Two | ENG |`);

    expect(storageFormatToMarkdown(`
      <table>
        <tbody>
          <tr>
            <td><table><tbody><tr><td colspan="2">Nested</td></tr></tbody></table></td>
            <td>Other</td>
          </tr>
        </tbody>
      </table>
    `)).toBe("<table><tbody><tr><td><table><tbody><tr><td colspan=\"2\">Nested</td></tr></tbody></table></td><td>Other</td></tr></tbody></table>");
  });

  it("treats Confluence layouts as pass-through block containers", () => {
    expect(storageFormatToMarkdown(`
      <ac:layout>
        <ac:layout-section ac:type="single">
          <ac:layout-cell>
            <h2>Cell Heading</h2>
            <p>Cell paragraph.</p>
          </ac:layout-cell>
        </ac:layout-section>
      </ac:layout>
    `)).toBe(`## Cell Heading

Cell paragraph.`);
  });
});
