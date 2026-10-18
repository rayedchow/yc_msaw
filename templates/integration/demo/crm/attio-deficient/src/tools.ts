import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { rawRequest } from "./client.ts";

// HOST-SEEDED DEFICIENT ADAPTER (benchmark label): ported from the HubSpot adapter's conventions. search_records
// sends HubSpot-style filterGroups to Attio's query endpoint; update_record always uses PUT. Not model-authored.
type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };
const auth = () => ({ authorization: `Bearer ${process.env.ATTIO_TOKEN ?? ""}` });
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
      out(await rawRequest({ baseUrl: base(), authHeaders: auth() }, { method: "POST", path: `/v2/objects/${encodeURIComponent(object)}/records/query`, body: { filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }], limit: limit ?? 100 } })),
  );
  server.tool(
    {
      name: "get_record",
      description: "Get one Attio record by object slug and record id.",
      inputSchema: z.object({ object: z.string(), record_id: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ object, record_id }) => out(await rawRequest({ baseUrl: base(), authHeaders: auth() }, { method: "GET", path: `/v2/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(record_id)}` })),
  );
  server.tool(
    {
      name: "update_record",
      description: "Update attribute values of one Attio record.",
      inputSchema: z.object({ object: z.string(), record_id: z.string(), properties: z.record(z.string(), z.unknown()).describe("attribute slug -> value") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ object, record_id, properties }) =>
      out(await rawRequest({ baseUrl: base(), authHeaders: auth() }, { method: "PUT", path: `/v2/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(record_id)}`, body: { data: { values: properties } } })),
  );
}
