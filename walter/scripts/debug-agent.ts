/** Run an ops agent locally against a hosted company MCP and time every model call (for debugging slow runs). */
import { chat, MODELS, type Msg, type ToolSpec } from "../llm.js";
import { connectMcp } from "../mcp-client.js";
import { loadState } from "../state.js";

const st = await loadState();
const model = MODELS[(process.argv[2] ?? "glm") as keyof typeof MODELS];
const mcp = await connectMcp(st.mcps!.erp!.mcpUrl!, {}, "walter-debug");
const tools: ToolSpec[] = mcp.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown> } }));
const instructions = `1. Call payment_run for this week's proposed run.\n2. Call request_cfo_approval once, passing the list of due bills that need CFO sign-off.\n3. Call submit_payment_run.\n4. Report what gets paid, the total, and what is held back and why.`;
const messages: Msg[] = [
  { role: "system", content: `You are an operations agent at GurtAI.\n\n${instructions}\n\nUse the company MCP tools; they already apply GurtAI's rules. Do the work, then finish with a short report.` },
  { role: "user", content: "Run now." },
];
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  const r = await chat(model, messages, tools, { maxTokens: 8000, temperature: 0, timeoutMs: 180_000, retries: 0 }).catch((e) => ({ role: "assistant" as const, content: `ERROR ${(e as Error).message}` }));
  console.log(`model call ${i}: ${((Date.now() - t0) / 1000).toFixed(1)}s, tool calls: ${r.tool_calls?.map((c) => `${c.function.name}(${c.function.arguments.length} chars)`).join(", ") ?? "none"}, content ${String(r.content ?? "").length} chars`);
  messages.push(r as Msg);
  if (!r.tool_calls?.length) { console.log(String(r.content).slice(0, 600)); break; }
  for (const tc of r.tool_calls) {
    const out = (await mcp.call(tc.function.name, JSON.parse(tc.function.arguments || "{}"))).text;
    console.log(`  ${tc.function.name} → ${out.length} chars`);
    messages.push({ role: "tool", tool_call_id: tc.id, content: out.slice(0, 12_000) });
  }
}
await mcp.close();
