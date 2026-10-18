/** The GurtAI CRM simulator as an mcp-use project for Manufact: REST routes for the CRM and warehouse. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeProject } from "./project.js";

const INDEX = `import { MCPServer } from "mcp-use";
import { z } from "zod";
import { GurtaiSystem } from "./src/gurtai.ts";

// Simulated third-party system (HubSpot-style CRM + warehouse) for the walter demo. Token comes from Manufact env.
const system = new GurtaiSystem(process.env.GURTAI_TOKEN ?? "");

const server = new MCPServer({
  name: "gurtai-crm",
  title: "GurtAI CRM (simulated)",
  version: "1.0.0",
  description: "Simulated GurtAI HubSpot-style CRM with 22 months of history. REST under /crm/v3 and /warehouse.",
});

server.tool(
  { name: "system_info", description: "Describe this simulated system and its REST endpoints.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: "GurtAI CRM simulator. REST: /crm/v3/objects/{deals|contacts|companies}, /crm/v3/pipelines/deals, /crm/v3/owners, /crm/v3/properties/{type}, /warehouse/field_history, /warehouse/forecast_snapshots. Bearer token required." }] }),
);

const route = async (c: any) => {
  const url = new URL(c.req.url);
  let body: unknown;
  if (c.req.method !== "GET") body = await c.req.json().catch(() => ({}));
  const out = system.handle({ method: c.req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: c.req.header("authorization") ?? null });
  return c.json(out.body, out.status);
};
server.get("/health", route);
server.get("/crm/*", route);
server.post("/crm/*", route);
server.get("/warehouse/*", route);

export default server;
`;

export async function writeSystemProject(dir: string): Promise<void> {
  const src = await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), "../system/gurtai.ts"), "utf8");
  await writeProject(dir, "gurtai-crm", "Simulated GurtAI CRM for the walter demo", { "index.ts": INDEX, "src/gurtai.ts": src });
}
