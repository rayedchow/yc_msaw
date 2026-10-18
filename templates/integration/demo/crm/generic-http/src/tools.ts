import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { rawRequest } from "./client.ts";

// Generic connection-scoped HTTP tool (no CRM-specific knowledge). Connections come from host env
// CONNECTIONS_JSON = [{"name","vendor","label","baseUrlEnv","tokenEnv","authScheme","docs"}]; credentials are injected.
type Conn = { name: string; vendor: string; label: string; baseUrlEnv: string; tokenEnv: string; authScheme: "bearer" | "zoho-oauthtoken" | "x-api-token"; docs: string[] };
type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };
const conns = (): Conn[] => JSON.parse(process.env.CONNECTIONS_JSON ?? "[]");
const authFor = (c: Conn, t: string): Record<string, string> =>
  c.authScheme === "x-api-token" ? { "x-api-token": t } : { authorization: c.authScheme === "zoho-oauthtoken" ? `Zoho-oauthtoken ${t}` : `Bearer ${t}` };

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
      if (!c) return { isError: true, content: [{ type: "text", text: `unknown connection ${connection}; call list_connections` }] };
      const baseUrl = process.env[c.baseUrlEnv];
      const token = process.env[c.tokenEnv];
      if (!baseUrl || !token) return { isError: true, content: [{ type: "text", text: `connection ${connection} not configured` }] };
      if (!path.startsWith("/") || path.includes("..")) return { isError: true, content: [{ type: "text", text: "path must start with / and not contain .." }] };
      try {
        const r = await rawRequest({ baseUrl, authHeaders: authFor(c, token) }, { method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) });
        return { ...(r.http_status >= 400 ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: { ...r } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `network error: ${String((error as Error)?.message ?? error)}` }] };
      }
    },
  );
}
