import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { rawRequest } from "./client.ts";

type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };
const PATH_RE = /^\/crm\/v[34]\//;

export function registerTools(server: MCPServer) {
  server.tool(
    {
      name: "integration_info",
      description: "Describe this integration: upstream service, tools, and configuration names (never secret values).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, env: (manifest.env as EnvVar[]).map((e) => ({ name: e.name, required: e.required, secret: e.secret })), instance: process.env.HUBSPOT_INSTANCE_LABEL ?? null };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  server.tool(
    {
      name: "hubspot_request",
      description: "Call the HubSpot CRM REST API of this organization's HubSpot account. Raw HubSpot contract: you choose the HTTP method, path (/crm/v3/... or /crm/v4/...), query and JSON body exactly as HubSpot documents them; the private-app bearer token is injected for you. Returns {http_status, request_id, headers, body}; non-2xx responses are returned as tool errors with the vendor's error body unchanged.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method"),
        path: z.string().describe("API path starting with /crm/v3/... or /crm/v4/... (no host)"),
        query: z.record(z.string(), z.unknown()).optional().describe("Query string parameters (values are sent as strings; arrays repeat the key)"),
        body: z.unknown().optional().describe("JSON request body, exactly as the vendor documents it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ method, path, query, body }) => {
      const baseUrl = process.env.HUBSPOT_BASE_URL;
      const token = process.env.HUBSPOT_TOKEN;
      if (!baseUrl || !token) return { isError: true, content: [{ type: "text", text: "integration not configured (HUBSPOT_BASE_URL/HUBSPOT_TOKEN missing)" }] };
      if (!PATH_RE.test(path) || path.includes("..") || /^https?:/i.test(path)) {
        return { isError: true, content: [{ type: "text", text: "path must start with /crm/v3/... or /crm/v4/..." }] };
      }
      try {
        const r = await rawRequest({ baseUrl, authHeaders: { authorization: `Bearer ${token}` } }, { method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) });
        return { ...(r.http_status >= 400 ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: { ...r } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `network error calling HubSpot CRM: ${String((error as Error)?.message ?? error)}` }] };
      }
    },
  );
}
