/** Call one tool on the deployed MCP: npx tsx walter/scripts/probe.ts <tool> '<json args>' */
import { connectMcp } from "../mcp-client.js";
import { loadState } from "../state.js";

const st = await loadState();
const mcp = await connectMcp(st.mcps!.sales!.mcpUrl!);
const r = await mcp.call(process.argv[2]!, JSON.parse(process.argv[3] ?? "{}"));
console.log(r.isError ? "ERROR" : "OK", r.text.slice(0, 600));
await mcp.close();
