// The Files tab's tree from the run's recorded paths (AEye HandbookTreeNode shape).
// Run: npx tsx demo-ui/tests/file-tree.test.ts
import assert from "node:assert/strict";
import { recordedFileTree } from "../src/workbench.js";
import { expandedForSelection } from "../src/aeye/web/components/workspace/draft-tree.js";
import { leadingMarkdownTitle, renderMarkdown } from "../src/aeye/src/web/markdown.js";
import { resolveRecordedLink } from "../src/file-links.js";

const file = (path: string) => ({ path, kind: path.startsWith("memory/") ? "memory" : "source", before: null, after: "x", truncated: false });
const paths = [
  "mcps/github-read/docs/research.md", "mcps/github-read/src/github.ts", "mcps/github-read/src/tools.ts",
  "mcps/github-read/tests/github.test.ts", "memory/index.md", "memory/integrations/github-read.md", "memory/integrations/index.md",
];
const tree = recordedFileTree(paths.map(file));
const shape = (nodes: ReturnType<typeof recordedFileTree>): unknown => nodes.map((node) => node.kind === "file" ? node.title : { [node.title]: shape(node.children) });
assert.deepEqual(shape(tree), [
  { mcps: [{ "github-read": [{ docs: ["research.md"] }, { src: ["github.ts", "tools.ts"] }, { tests: ["github.test.ts"] }] }] },
  { memory: [{ integrations: ["github-read.md", "index.md"] }, "index.md"] },
], "folders first, then files, each by name; leaves are basenames");
const leaf = tree[0]!.children[0]!.children[1]!.children[0]!;
assert.equal(leaf.path, "mcps/github-read/src/github.ts", "a leaf keeps its full recorded path");
assert.equal(tree[0]!.children[0]!.path, "mcps/github-read", "folders are addressed by their path");
const expanded = expandedForSelection(new Set(["memory"]), tree, "mcps/github-read/src/tools.ts", false);
assert.deepEqual([...expanded].sort(), ["mcps", "mcps/github-read", "mcps/github-read/src", "memory"], "selection opens its ancestors and closes nothing");
assert.deepEqual(recordedFileTree([]), []);
// Markdown files render through AEye's pipeline (HTML disabled): recorded HTML stays text.
const page = renderMarkdown("# Research log\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n- [docs](https://docs.github.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst a = '<b>';\n```\n");
assert.ok(page.includes("<h1>Research log</h1>"));
assert.ok(!/<script|<img/u.test(page) && page.includes("&lt;script&gt;"), "raw HTML is escaped, never active");
assert.ok(page.includes('rel="noreferrer noopener"') && page.includes('<div class="markdown-table-wrap"><table>') && page.includes("&lt;b&gt;"));
assert.equal(leadingMarkdownTitle("---\ntitle: x\n---\n\n# Title\n"), "Title");
assert.equal(leadingMarkdownTitle("Intro text\n# Later"), null, "a page without a leading title gets its file name as h1");
// Relative links in a recorded Markdown file open the recorded file they name, in the same viewer.
const recorded = new Set(paths);
assert.deepEqual(resolveRecordedLink("memory/index.md", "integrations/index.md", recorded), { kind: "file", path: "memory/integrations/index.md" });
assert.deepEqual(resolveRecordedLink("memory/index.md", "integrations/github-read.md", recorded), { kind: "file", path: "memory/integrations/github-read.md" });
assert.deepEqual(resolveRecordedLink("memory/integrations/index.md", "github-read.md", recorded), { kind: "file", path: "memory/integrations/github-read.md" });
assert.deepEqual(resolveRecordedLink("memory/integrations/github-read.md", "../index.md", recorded), { kind: "file", path: "memory/index.md" });
assert.deepEqual(resolveRecordedLink("memory/integrations/index.md", "./github-read.md#ref", recorded), { kind: "file", path: "memory/integrations/github-read.md" }, "anchors and ./ are ignored for the target");
assert.deepEqual(resolveRecordedLink("memory/index.md", "integrations/github%2Dread.md", recorded), { kind: "file", path: "memory/integrations/github-read.md" }, "percent-encoding is decoded");
assert.deepEqual(resolveRecordedLink("memory/index.md", "integrations", recorded), { kind: "file", path: "memory/integrations/index.md" }, "a folder link opens its recorded index");
assert.deepEqual(resolveRecordedLink("memory/index.md", "integrations/ledgerly/index.md", recorded), { kind: "missing", path: "memory/integrations/ledgerly/index.md" }, "an unrecorded target is missing, never invented");
assert.equal(resolveRecordedLink("memory/index.md", "../../../etc/passwd", recorded).kind, "missing", "nothing above the recorded root");
assert.deepEqual(resolveRecordedLink("memory/index.md", "/memory/index.md", recorded), { kind: "file", path: "memory/index.md" });
assert.deepEqual(resolveRecordedLink("memory/index.md", "https://docs.github.com/en/rest", recorded), { kind: "external" });
assert.deepEqual(resolveRecordedLink("memory/index.md", "mailto:a@b.c", recorded), { kind: "external" });
assert.deepEqual(resolveRecordedLink("memory/index.md", "#section", recorded), { kind: "anchor" });
assert.equal(resolveRecordedLink("memory/index.md", "javascript:alert(1)", recorded).kind, "external", "a script URL is not followed by the viewer");
assert.ok(!/href="javascript:/iu.test(renderMarkdown("[x](javascript:alert(1))")), "markdown-it never makes a script URL a link");
console.log("file tree checks passed");
