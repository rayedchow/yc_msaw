/**
 * Generates the HOST-AUTHORED CRM adapter overlays under templates/integration/demo/crm/ (frozen for the matrix):
 *   hubspot | pipedrive | zoho | attio   correct vendor-specific raw-contract tools (method/path/query/body preserved)
 *   attio-deficient                      HOST-LABELED DEFICIENT Attio adapter for the far-repair demo
 *   generic-http                         connection-scoped generic HTTP tool for the cold-create demo
 * Every overlay is applied on top of templates/integration/child (childTemplateFiles + overlay files).
 *
 *   npx tsx scripts/crm-gen-adapters.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve("templates/integration/demo/crm");

interface VendorDef {
  key: "hubspot" | "pipedrive" | "zoho" | "attio";
  title: string;
  upstream: string;
  docs: string[];
  envPrefix: string;
  pathRe: string;
  pathHint: string;
  authHeader: (tokenExpr: string) => string;
  description: string;
}

const VENDORS: VendorDef[] = [
  {
    key: "hubspot",
    title: "HubSpot CRM",
    upstream: "HubSpot CRM API (v3 objects/search/properties/pipelines, v4 associations) — synthetic contract fixture",
    docs: ["https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm", "https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide"],
    envPrefix: "HUBSPOT",
    pathRe: "^/crm/v[34]/",
    pathHint: "/crm/v3/... or /crm/v4/...",
    authHeader: (t) => `{ authorization: \`Bearer \${${t}}\` }`,
    description: "Call the HubSpot CRM REST API of this organization's HubSpot account. Raw HubSpot contract: you choose the HTTP method, path (/crm/v3/... or /crm/v4/...), query and JSON body exactly as HubSpot documents them; the private-app bearer token is injected for you.",
  },
  {
    key: "pipedrive",
    title: "Pipedrive",
    upstream: "Pipedrive API (v2 organizations/deals/pipelines/stages, v1 fields) — synthetic contract fixture",
    docs: ["https://developers.pipedrive.com/docs/api/v1/Deals", "https://pipedrive.readme.io/docs/core-api-concepts-custom-fields"],
    envPrefix: "PIPEDRIVE",
    pathRe: "^/api/v[12]/",
    pathHint: "/api/v2/... or /api/v1/...",
    authHeader: (t) => `{ "x-api-token": ${t} }`,
    description: "Call the Pipedrive REST API of this organization's Pipedrive company account. Raw Pipedrive contract: you choose the HTTP method, path (/api/v2/... or /api/v1/...), query and JSON body exactly as Pipedrive documents them; the API token is injected for you.",
  },
  {
    key: "zoho",
    title: "Zoho CRM",
    upstream: "Zoho CRM REST API v8 — synthetic contract fixture",
    docs: ["https://www.zoho.com/crm/developer/docs/api/v8/get-records.html", "https://www.zoho.com/crm/developer/docs/api/v8/update-records.html"],
    envPrefix: "ZOHO",
    pathRe: "^/crm/v8/",
    pathHint: "/crm/v8/...",
    authHeader: (t) => `{ authorization: \`Zoho-oauthtoken \${${t}}\` }`,
    description: "Call the Zoho CRM REST API (v8) of this organization's Zoho CRM org. Raw Zoho contract: you choose the HTTP method, path (/crm/v8/...), query and JSON body exactly as Zoho documents them; the OAuth access token is injected for you.",
  },
  {
    key: "attio",
    title: "Attio",
    upstream: "Attio REST API v2 — synthetic contract fixture",
    docs: ["https://api.attio.com/openapi/api", "https://docs.attio.com/rest-api/guides/filtering-and-sorting"],
    envPrefix: "ATTIO",
    pathRe: "^/v2/",
    pathHint: "/v2/...",
    authHeader: (t) => `{ authorization: \`Bearer \${${t}}\` }`,
    description: "Call the Attio REST API (v2) of this organization's Attio workspace. Raw Attio contract: you choose the HTTP method, path (/v2/...), query and JSON body exactly as Attio documents them; the workspace access token is injected for you.",
  },
];

const clientTs = `/** Minimal raw HTTP client: forwards method/path/query/body unchanged, injects auth, returns status/headers/body. */
export interface RawResponse {
  http_status: number;
  request_id: string | null;
  headers: Record<string, string>;
  body: unknown;
}

const KEEP_HEADERS = ["content-type", "x-fixture-request-id", "x-hubspot-correlation-id", "x-request-id", "retry-after", "location"];

export async function rawRequest(
  opts: { baseUrl: string; authHeaders: Record<string, string>; fetchImpl?: typeof fetch },
  req: { method: string; path: string; query?: Record<string, unknown>; body?: unknown },
): Promise<RawResponse> {
  const url = new URL(opts.baseUrl.replace(/\\/+$/, "") + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const hasBody = req.body !== undefined && req.method !== "GET";
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: req.method,
    headers: { accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}), ...opts.authHeaders },
    ...(hasBody ? { body: typeof req.body === "string" ? req.body : JSON.stringify(req.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const headers: Record<string, string> = {};
  for (const h of KEEP_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return { http_status: res.status, request_id: res.headers.get("x-fixture-request-id") ?? res.headers.get("x-hubspot-correlation-id") ?? res.headers.get("x-request-id"), headers, body };
}
`;

function vendorTools(v: VendorDef): string {
  return `import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { rawRequest } from "./client.ts";

type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };
const PATH_RE = /${v.pathRe.replace(/\//g, "\\/")}/;

export function registerTools(server: MCPServer) {
  server.tool(
    {
      name: "integration_info",
      description: "Describe this integration: upstream service, tools, and configuration names (never secret values).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, env: (manifest.env as EnvVar[]).map((e) => ({ name: e.name, required: e.required, secret: e.secret })), instance: process.env.${v.envPrefix}_INSTANCE_LABEL ?? null };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  server.tool(
    {
      name: "${v.key}_request",
      description: ${JSON.stringify(v.description + " Returns {http_status, request_id, headers, body}; non-2xx responses are returned as tool errors with the vendor's error body unchanged.")},
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method"),
        path: z.string().describe(${JSON.stringify(`API path starting with ${v.pathHint} (no host)`)}),
        query: z.record(z.string(), z.unknown()).optional().describe("Query string parameters (values are sent as strings; arrays repeat the key)"),
        body: z.unknown().optional().describe("JSON request body, exactly as the vendor documents it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ method, path, query, body }) => {
      const baseUrl = process.env.${v.envPrefix}_BASE_URL;
      const token = process.env.${v.envPrefix}_TOKEN;
      if (!baseUrl || !token) return { isError: true, content: [{ type: "text", text: "integration not configured (${v.envPrefix}_BASE_URL/${v.envPrefix}_TOKEN missing)" }] };
      if (!PATH_RE.test(path) || path.includes("..") || /^https?:/i.test(path)) {
        return { isError: true, content: [{ type: "text", text: ${JSON.stringify(`path must start with ${v.pathHint}`)} }] };
      }
      try {
        const r = await rawRequest({ baseUrl, authHeaders: ${v.authHeader("token")} }, { method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) });
        return { ...(r.http_status >= 400 ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: { ...r } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: \`network error calling ${v.title}: \${String((error as Error)?.message ?? error)}\` }] };
      }
    },
  );
}
`;
}

function vendorManifest(v: VendorDef, slug: string) {
  return {
    slug,
    title: v.title,
    description: `${v.title} raw REST contract tool for this organization's ${v.title} instance (synthetic contract fixture upstream in this benchmark).`,
    version: "1.0.0",
    upstream: { name: v.upstream, docs: v.docs },
    tools: ["integration_info", `${v.key}_request`],
    env: [
      { name: `${v.envPrefix}_BASE_URL`, required: true, secret: false, description: `${v.title} API base URL` },
      { name: `${v.envPrefix}_TOKEN`, required: true, secret: true, description: `${v.title} credential (injected by the host)` },
      { name: `${v.envPrefix}_INSTANCE_LABEL`, required: false, secret: false, description: "Human label of the connected instance" },
    ],
    smoke: [
      { name: "integration_info responds", steps: [{ tool: "integration_info", arguments: {}, expect: [{ path: "structuredContent.slug", op: "equals", value: slug }] }] },
      {
        name: `fixture: ${v.key} metadata read`,
        fixture: { name: "crm-fixture", config: { vendor: v.key, seed: `smoke-${v.key}`, spec: SMOKE_SPEC } },
        env: { [`${v.envPrefix}_BASE_URL`]: "{{fixture.url}}", [`${v.envPrefix}_TOKEN`]: "{{fixture.token}}" },
        steps: [{ tool: `${v.key}_request`, arguments: SMOKE_CALL[v.key], expect: [{ path: "structuredContent.http_status", op: "equals", value: 200 }] }],
      },
    ],
  };
}

const SMOKE_SPEC = { instanceLabel: "Smoke Org", target: { name: "Smoke Target Co", domain: "smoke-target.example" }, duplicateDomain: "smoke-target-holdings.example", fillerNames: ["Filler One", "Filler Two", "Filler Three"], family: "exec-review" };
const SMOKE_CALL: Record<VendorDef["key"], Record<string, unknown>> = {
  hubspot: { method: "GET", path: "/crm/v3/pipelines/deals" },
  pipedrive: { method: "GET", path: "/api/v2/pipelines" },
  zoho: { method: "GET", path: "/crm/v8/settings/modules" },
  attio: { method: "GET", path: "/v2/objects" },
};

const testTs = (v: VendorDef) => `// Unit tests with a FAKE fetch (no network in the sandbox).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rawRequest } from "../src/client.ts";

test("forwards method/path/query/body unchanged and injects auth", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { "x-fixture-request-id": "req-1" } });
  }) as unknown as typeof fetch;
  const r = await rawRequest({ baseUrl: "http://127.0.0.1:9/", authHeaders: { "x-test": "t" }, fetchImpl }, { method: "POST", path: "${v.pathHint.split(" ")[0]!.replace("...", "x")}", query: { a: 1 }, body: { b: 2 } });
  assert.equal(r.http_status, 201);
  assert.equal(r.request_id, "req-1");
  assert.ok(seen!.url.endsWith("?a=1"));
  assert.equal((seen!.init.headers as Record<string, string>)["x-test"], "t");
  assert.equal(seen!.init.body, JSON.stringify({ b: 2 }));
});
`;

// ---------------------------------------------------------------- deficient Attio (far-repair seed)
const deficientTools = `import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { rawRequest } from "./client.ts";

// HOST-SEEDED DEFICIENT ADAPTER (benchmark label): ported from the HubSpot adapter's conventions. search_records
// sends HubSpot-style filterGroups to Attio's query endpoint; update_record always uses PUT. Not model-authored.
type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };
const auth = () => ({ authorization: \`Bearer \${process.env.ATTIO_TOKEN ?? ""}\` });
const base = () => process.env.ATTIO_BASE_URL ?? "";
const out = (r: Awaited<ReturnType<typeof rawRequest>>) => ({ ...(r.http_status >= 400 ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(r) }], structuredContent: { ...r } });

export function registerTools(server: MCPServer) {
  server.tool(
    { name: "integration_info", description: "Describe this integration: upstream service, tools, and configuration names.", inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, env: (manifest.env as EnvVar[]).map((e) => ({ name: e.name, required: e.required, secret: e.secret })), instance: process.env.ATTIO_INSTANCE_LABEL ?? null };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );
  server.tool(
    {
      name: "search_records",
      description: "Search Attio records of an object where a property equals a value.",
      inputSchema: z.object({ object: z.string().describe("Object slug, e.g. companies or deals"), property: z.string(), value: z.string(), limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ object, property, value, limit }) =>
      out(await rawRequest({ baseUrl: base(), authHeaders: auth() }, { method: "POST", path: \`/v2/objects/\${encodeURIComponent(object)}/records/query\`, body: { filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }], limit: limit ?? 100 } })),
  );
  server.tool(
    {
      name: "get_record",
      description: "Get one Attio record by object slug and record id.",
      inputSchema: z.object({ object: z.string(), record_id: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ object, record_id }) => out(await rawRequest({ baseUrl: base(), authHeaders: auth() }, { method: "GET", path: \`/v2/objects/\${encodeURIComponent(object)}/records/\${encodeURIComponent(record_id)}\` })),
  );
  server.tool(
    {
      name: "update_record",
      description: "Update attribute values of one Attio record.",
      inputSchema: z.object({ object: z.string(), record_id: z.string(), properties: z.record(z.string(), z.unknown()).describe("attribute slug -> value") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ object, record_id, properties }) =>
      out(await rawRequest({ baseUrl: base(), authHeaders: auth() }, { method: "PUT", path: \`/v2/objects/\${encodeURIComponent(object)}/records/\${encodeURIComponent(record_id)}\`, body: { data: { values: properties } } })),
  );
}
`;

// ---------------------------------------------------------------- generic HTTP (cold-create)
const genericTools = `import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { rawRequest } from "./client.ts";

// Generic connection-scoped HTTP tool (no CRM-specific knowledge). Connections come from host env
// CONNECTIONS_JSON = [{"name","vendor","label","baseUrlEnv","tokenEnv","authScheme","docs"}]; credentials are injected.
type Conn = { name: string; vendor: string; label: string; baseUrlEnv: string; tokenEnv: string; authScheme: "bearer" | "zoho-oauthtoken" | "x-api-token"; docs: string[] };
type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };
const conns = (): Conn[] => JSON.parse(process.env.CONNECTIONS_JSON ?? "[]");
const authFor = (c: Conn, t: string): Record<string, string> =>
  c.authScheme === "x-api-token" ? { "x-api-token": t } : { authorization: c.authScheme === "zoho-oauthtoken" ? \`Zoho-oauthtoken \${t}\` : \`Bearer \${t}\` };

export function registerTools(server: MCPServer) {
  server.tool(
    { name: "integration_info", description: "Describe this integration: upstream service, tools, and configuration names.", inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, env: (manifest.env as EnvVar[]).map((e) => ({ name: e.name, required: e.required, secret: e.secret })) };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );
  server.tool(
    { name: "list_connections", description: "List the organization's configured API connections (name, vendor, instance label, docs links). Credentials are never shown.", inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    async () => {
      const list = conns().map((c) => ({ name: c.name, vendor: c.vendor, label: c.label, auth: "injected by the host", docs: c.docs }));
      return { content: [{ type: "text", text: JSON.stringify(list) }], structuredContent: { connections: list } };
    },
  );
  server.tool(
    {
      name: "http_request",
      description: "Send one raw HTTP request through a named connection. The path, method, query and JSON body are forwarded unchanged to the connection's API base URL with its credential injected. Returns {http_status, request_id, headers, body}.",
      inputSchema: z.object({
        connection: z.string().describe("Connection name from list_connections"),
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
        path: z.string().describe("Path relative to the connection base URL, starting with /"),
        query: z.record(z.string(), z.unknown()).optional(),
        body: z.unknown().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ connection, method, path, query, body }) => {
      const c = conns().find((x) => x.name === connection);
      if (!c) return { isError: true, content: [{ type: "text", text: \`unknown connection \${connection}; call list_connections\` }] };
      const baseUrl = process.env[c.baseUrlEnv];
      const token = process.env[c.tokenEnv];
      if (!baseUrl || !token) return { isError: true, content: [{ type: "text", text: \`connection \${connection} not configured\` }] };
      if (!path.startsWith("/") || path.includes("..")) return { isError: true, content: [{ type: "text", text: "path must start with / and not contain .." }] };
      try {
        const r = await rawRequest({ baseUrl, authHeaders: authFor(c, token) }, { method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) });
        return { ...(r.http_status >= 400 ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: { ...r } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: \`network error: \${String((error as Error)?.message ?? error)}\` }] };
      }
    },
  );
}
`;


// ---------------------------------------------------------------- docs (host-owned, read-only pinned doc snapshot)
const docsTools = `import { z } from "zod";
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
      const title = /^#\\s+(.+)$/m.exec(text)?.[1] ?? /title:\\s*(.+)/.exec(text)?.[1] ?? f;
      out.push({ id: \`\${vendor}/\${f.replace(/\\.md$/, "")}\`, vendor, title: title.trim(), text });
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
          return { id: p.id, vendor: p.vendor, title: p.title, score, snippet: p.text.slice(Math.max(0, i - 120), i + 280).replace(/\\s+/g, " ") };
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
      if (!p) return { isError: true, content: [{ type: "text", text: \`no page \${id}; use docs_list\` }] };
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
`;

async function write(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(ROOT, dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
}

for (const v of VENDORS) {
  const slug = `crm-${v.key}`;
  await write(v.key, {
    "integration.json": `${JSON.stringify(vendorManifest(v, slug), null, 1)}\n`,
    "src/client.ts": clientTs,
    "src/tools.ts": vendorTools(v),
    [`tests/${v.key}.test.ts`]: testTs(v),
  });
}
await write("attio-deficient", {
  "integration.json": `${JSON.stringify(
    {
      slug: "crm-attio",
      title: "Attio",
      description: "Attio records integration (HOST-SEEDED DEFICIENT revision for the far-repair demo; ported from HubSpot adapter conventions).",
      version: "0.1.0",
      upstream: { name: "Attio REST API v2 — synthetic contract fixture", docs: ["https://api.attio.com/openapi/api"] },
      tools: ["integration_info", "search_records", "get_record", "update_record"],
      env: [
        { name: "ATTIO_BASE_URL", required: true, secret: false, description: "Attio API base URL" },
        { name: "ATTIO_TOKEN", required: true, secret: true, description: "Attio credential (injected by the host)" },
        { name: "ATTIO_INSTANCE_LABEL", required: false, secret: false, description: "Human label of the connected instance" },
      ],
      smoke: [
        { name: "integration_info responds", steps: [{ tool: "integration_info", arguments: {}, expect: [{ path: "structuredContent.slug", op: "equals", value: "crm-attio" }] }] },
        {
          name: "fixture: get_record of unknown id returns a structured error",
          fixture: { name: "crm-fixture", config: { vendor: "attio", seed: "smoke-attio", spec: SMOKE_SPEC } },
          env: { ATTIO_BASE_URL: "{{fixture.url}}", ATTIO_TOKEN: "{{fixture.token}}" },
          steps: [{ tool: "get_record", arguments: { object: "deals", record_id: "00000000-0000-4000-8000-000000000000" }, expect: [{ path: "structuredContent.http_status", op: "equals", value: 404 }] }],
        },
      ],
    },
    null,
    1,
  )}\n`,
  "src/client.ts": clientTs,
  "src/tools.ts": deficientTools,
  "tests/attio.test.ts": testTs(VENDORS[3]!),
});
await write("generic-http", {
  "integration.json": `${JSON.stringify(
    {
      slug: "generic-http",
      title: "Generic HTTP connections",
      description: "Generic connection-scoped HTTP tool: forwards raw requests to the organization's configured API connections with credentials injected. No vendor-specific logic.",
      version: "1.0.0",
      upstream: { name: "Organization API connections (synthetic contract fixtures in this benchmark)", docs: [] },
      tools: ["integration_info", "list_connections", "http_request"],
      env: [{ name: "CONNECTIONS_JSON", required: true, secret: false, description: "Connection descriptors (names of credential env vars only)" }],
      smoke: [{ name: "integration_info responds", steps: [{ tool: "integration_info", arguments: {}, expect: [{ path: "structuredContent.slug", op: "equals", value: "generic-http" }] }] }],
    },
    null,
    1,
  )}\n`,
  "src/client.ts": clientTs,
  "src/tools.ts": genericTools,
  "tests/generic.test.ts": testTs(VENDORS[3]!).replace("/v2/x", "/x"),
});
await write("docs", {
  "integration.json": `${JSON.stringify({ slug: "crm-docs", title: "CRM API docs", description: "Read-only pinned snapshot of official CRM API documentation (paraphrased) for the organization's connected CRMs.", version: "1.0.0", upstream: { name: "Pinned docs snapshot 2026-10-17", docs: [] }, tools: ["integration_info", "docs_search", "docs_read", "docs_list"], env: [{ name: "DOCS_DIR", required: true, secret: false }, { name: "DOCS_VENDORS", required: false, secret: false }], smoke: [{ name: "integration_info responds", steps: [{ tool: "integration_info", arguments: {}, expect: [{ path: "structuredContent.slug", op: "equals", value: "crm-docs" }] }] }] }, null, 1)}\n`,
  "src/tools.ts": docsTools,
});
console.log(`wrote adapters under ${ROOT}`);
