import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import manifest from "../integration.json" with { type: "json" };

// Read-only search over the pinned CRM docs snapshot (paraphrased official vendor docs). DOCS_DIR points at the
// corpus; DOCS_VENDORS (comma list) restricts which vendor folders this deployment serves.
type Page = { id: string; vendor: string; title: string; text: string };
let pages: Page[] | null = null;
function load(): Page[] {
  if (pages) return pages;
  const root = process.env.DOCS_DIR ?? "";
  const allow = new Set((process.env.DOCS_VENDORS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const out: Page[] = [];
  for (const vendor of readdirSync(root).sort()) {
    const d = path.join(root, vendor);
    if (!statSync(d).isDirectory() || (allow.size && !allow.has(vendor))) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".md")).sort()) {
      const text = readFileSync(path.join(d, f), "utf8");
      const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? /title:\s*(.+)/.exec(text)?.[1] ?? f;
      out.push({ id: `${vendor}/${f.replace(/\.md$/, "")}`, vendor, title: title.trim(), text });
    }
  }
  return (pages = out);
}

export function registerTools(server: MCPServer) {
  server.tool(
    { name: "integration_info", description: "Describe this integration.", inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, vendors: [...new Set(load().map((p) => p.vendor))] };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );
  server.tool(
    {
      name: "docs_search",
      description: "Search the pinned API documentation snapshot (paraphrased official vendor docs). Returns matching page ids, titles and snippets. Optional vendor filter.",
      inputSchema: z.object({ query: z.string().min(1), vendor: z.string().optional().describe("e.g. hubspot, pipedrive, zoho, attio") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ query, vendor }) => {
      const terms = query.toLowerCase().split(/[^a-z0-9_$.;-]+/).filter((t) => t.length > 1);
      const hits = load()
        .filter((p) => !vendor || p.vendor === vendor.toLowerCase())
        .map((p) => {
          const lower = p.text.toLowerCase();
          const score = terms.reduce((a, t) => a + (lower.split(t).length - 1) + (p.title.toLowerCase().includes(t) ? 5 : 0), 0);
          const i = terms.map((t) => lower.indexOf(t)).filter((x) => x >= 0).sort((a, b) => a - b)[0] ?? 0;
          return { id: p.id, vendor: p.vendor, title: p.title, score, snippet: p.text.slice(Math.max(0, i - 120), i + 280).replace(/\s+/g, " ") };
        })
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return { content: [{ type: "text", text: JSON.stringify(hits) }], structuredContent: { results: hits } };
    },
  );
  server.tool(
    {
      name: "docs_read",
      description: "Read one documentation page by id (from docs_search or docs_list).",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      const p = load().find((x) => x.id === id);
      if (!p) return { isError: true, content: [{ type: "text", text: `no page ${id}; use docs_list` }] };
      return { content: [{ type: "text", text: p.text }], structuredContent: { id: p.id, vendor: p.vendor, title: p.title } };
    },
  );
  server.tool(
    { name: "docs_list", description: "List all documentation pages (id, vendor, title).", inputSchema: z.object({ vendor: z.string().optional() }), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    async ({ vendor }) => {
      const list = load().filter((p) => !vendor || p.vendor === vendor.toLowerCase()).map((p) => ({ id: p.id, vendor: p.vendor, title: p.title }));
      return { content: [{ type: "text", text: JSON.stringify(list) }], structuredContent: { pages: list } };
    },
  );
}
