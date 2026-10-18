import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { rawRequest } from "./client.ts";

type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };
const PATH_RE = /^\/v2\//;

export function registerTools(server: MCPServer) {
  server.tool(
    {
      name: "integration_info",
      description: "Describe this integration: upstream service, tools, and configuration names (never secret values).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, env: (manifest.env as EnvVar[]).map((e) => ({ name: e.name, required: e.required, secret: e.secret })), instance: process.env.ATTIO_INSTANCE_LABEL ?? null };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  server.tool(
    {
      name: "attio_request",
      description: "Call the Attio REST API (v2) of this organization's Attio workspace. Raw Attio contract: you choose the HTTP method, path (/v2/...), query and JSON body exactly as Attio documents them; the workspace access token is injected for you. Returns {http_status, request_id, headers, body}; non-2xx responses are returned as tool errors with the vendor's error body unchanged.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method"),
        path: z.string().describe("API path starting with /v2/... (no host)"),
        query: z.record(z.string(), z.unknown()).optional().describe("Query string parameters (values are sent as strings; arrays repeat the key)"),
        body: z.unknown().optional().describe("JSON request body, exactly as the vendor documents it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ method, path, query, body }) => {
      const baseUrl = process.env.ATTIO_BASE_URL;
      const token = process.env.ATTIO_TOKEN;
      if (!baseUrl || !token) return { isError: true, content: [{ type: "text", text: "integration not configured (ATTIO_BASE_URL/ATTIO_TOKEN missing)" }] };
      if (!PATH_RE.test(path) || path.includes("..") || /^https?:/i.test(path)) {
        return { isError: true, content: [{ type: "text", text: "path must start with /v2/..." }] };
      }
      try {
        const r = await rawRequest({ baseUrl, authHeaders: { authorization: `Bearer ${token}` } }, { method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) });
        return { ...(r.http_status >= 400 ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: { ...r } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `network error calling Attio: ${String((error as Error)?.message ?? error)}` }] };
      }
    },
  );
}
