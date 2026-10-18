/** The GurtAI CRM simulator as an mcp-use project for Manufact: REST routes for the CRM and warehouse. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeProject } from "./project.js";

const INDEX = `import { MCPServer } from "mcp-use";
import { z } from "zod";
import { GurtaiSystem } from "./src/gurtai.ts";
import { WALTER_DIR } from "../paths.js";

// Simulated third-party system (HubSpot-style CRM + warehouse) for the walter demo. Token comes from Manufact env.
const system = new GurtaiSystem(process.env.GURTAI_TOKEN ?? "");

const server = new MCPServer({
  name: "gurtai-crm",
  title: "GurtAI systems (simulated)",
  version: "1.0.0",
  description: "Simulated GurtAI systems with 22 months of history: HubSpot-style CRM (/crm/v3, /warehouse), NetSuite-style ERP (/erp) and a Gmail-style support inbox (/mail).",
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
server.get("/walter/health", (c: any) => c.json({ ok: true, name: "gurtai-crm", hash: "__HASH__" }));
server.get("/crm/*", route);
server.post("/crm/*", route);
server.get("/warehouse/*", route);
server.get("/erp/*", route);
server.get("/mail/*", route);
server.post("/mail/*", route);
server.patch("/crm/*", route);
server.post("/admin/*", route);

export default server;
`;

/** Writes the project and returns its build hash (served at /walter/health so walter knows which build is live). */
export async function writeSystemProject(dir: string): Promise<string> {
  const here = path.join(WALTER_DIR, "system");
  const files: Record<string, string> = {};
  for (const f of ["gurtai", "common", "erp", "mail", "orders"]) {
    // bundle-friendly relative imports inside the project
    files[`src/${f}.ts`] = (await fs.readFile(path.join(here, `${f}.ts`), "utf8")).replace(/from "\.\/(\w+)\.js"/g, 'from "./$1.ts"');
  }
  const hash = createHash("sha256").update(INDEX + Object.values(files).join("")).digest("hex").slice(0, 12);
  files["index.ts"] = INDEX.replace("__HASH__", hash);
  await writeProject(dir, "gurtai-crm", "Simulated GurtAI systems for the walter demo", files);
  return hash;
}
