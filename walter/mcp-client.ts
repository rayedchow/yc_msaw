/** Thin MCP client over streamable HTTP (used by verification, evals and the end-to-end agent). */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
export interface Mcp { tools: McpTool[]; call(name: string, args?: Record<string, unknown>): Promise<{ text: string; data: any; isError: boolean }>; close(): Promise<void> }

export async function connectMcp(url: string, headers: Record<string, string> = {}, clientName = "walter"): Promise<Mcp> {
  const client = new Client({ name: clientName, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  const { tools } = (await client.listTools()) as { tools: McpTool[] };
  return {
    tools,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
      const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
      let data: any = r.structuredContent ?? null;
      if (data == null) { try { data = JSON.parse(text); } catch { data = null; } }
      return { text, data, isError: Boolean(r.isError) };
    },
    close: () => client.close(),
  };
}
