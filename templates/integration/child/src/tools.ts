import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };

type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };

/** Register this integration's MCP tools. Keep tool names in sync with integration.json "tools". */
export function registerTools(server: MCPServer) {
  server.tool(
    {
      name: "integration_info",
      description: "Describe this integration: upstream service, tools, and required configuration (never secret values).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, env: (manifest.env as EnvVar[]).map((e) => ({ name: e.name, required: e.required, secret: e.secret })) };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );
}
