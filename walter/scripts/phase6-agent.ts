/**
 * Phase 6: an outside agent (Fireworks GLM) does GurtAI work two ways and is scored against history.
 *   raw    the CRM REST API only (what a generic HubSpot connector gives an agent)
 *   walter the hosted walter MCP on Manufact (tools discovered over MCP, no extra prompt)
 *
 *   npx tsx walter/scripts/phase6-agent.ts [--model glm|kimi|minimax]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { chat, MODELS, usage, type Msg, type ToolSpec } from "../llm.js";
import { connectMcp } from "../mcp-client.js";
import { SystemClient } from "../mine/data.js";
import { generate, rootDomain } from "../system/gurtai.js";
import { loadState, STATE_DIR } from "../state.js";

const st = await loadState();
if (!st.system?.url || !st.mcps?.sales?.mcpUrl) throw new Error("phases 1 and 4 must have run");
const model = MODELS[((process.argv[process.argv.indexOf("--model") + 1] ?? "glm") in MODELS ? process.argv[process.argv.indexOf("--model") + 1] : "glm") as keyof typeof MODELS];
const w = generate();

// Tasks with answers taken from what GurtAI people actually did.
const sep = w.snapshots.find((s) => s.as_of.startsWith("2026-09"))!;
const merged = w.history.filter((h) => h.property === "merged_into").at(-1)!;
const dup = w.companies.find((c) => c.id === merged.id)!;
const TASKS = [
  { id: "commit", prompt: `What was GurtAI's commit for ${sep.quarter} as of ${sep.as_of.slice(0, 10)}? Answer with one USD number.`, check: (a: string) => nums(a).includes(sep.reported_commit_usd), truth: `$${sep.reported_commit_usd.toLocaleString()}` },
  { id: "owner", prompt: "A new lead, anna.berg@kraftwerk.de, from Germany just came in. Which GurtAI owner id should own the contact?", check: (a: string) => /\b201\b/.test(a) && !/\b20[2-5]\b/.test(a), truth: "201" },
  { id: "account", prompt: `An agent is about to create a company for ${dup.properties.domain}. Which existing GurtAI company record id should it use instead?`, check: (a: string) => new RegExp(`\\b${merged.new}\\b`).test(a), truth: String(merged.new) },
];
function nums(a: string): number[] {
  return [...a.replace(/(\d),(?=\d{3})/g, "$1").matchAll(/\$?\s?(\d+(?:\.\d+)?)\s*(k|m|million)?/gi)].map((m) => Math.round(Number(m[1]) * (/^m/i.test(m[2] ?? "") ? 1e6 : /k/i.test(m[2] ?? "") ? 1e3 : 1)));
}

async function runAgent(system: string, tools: ToolSpec[], exec: (name: string, args: any) => Promise<string>, prompt: string) {
  const messages: Msg[] = [{ role: "system", content: system }, { role: "user", content: prompt }];
  let calls = 0;
  for (let i = 0; i < 16; i++) {
    const r = await chat(model, messages, tools, { maxTokens: 16000, temperature: 0 });
    messages.push(r);
    if (!r.tool_calls?.length) {
      if (String(r.content ?? "").trim()) return { answer: String(r.content), calls, messages };
      messages.push({ role: "user", content: "Give your final answer now." });   // some models stop with empty content
      continue;
    }
    for (const tc of r.tool_calls) {
      calls++;
      let out: string;
      try { out = await exec(tc.function.name, JSON.parse(tc.function.arguments || "{}")); } catch (e) { out = `error: ${(e as Error).message}`; }
      messages.push({ role: "tool", tool_call_id: tc.id, content: out.length > 12_000 ? out.slice(0, 12_000) + "…[truncated]" : out });
    }
  }
  return { answer: "(no answer within 16 steps)", calls, messages };
}

// raw: generic CRM API access
const sys = new SystemClient(st.system.url, st.system.token!);
const RAW_TOOLS: ToolSpec[] = [
  { type: "function", function: { name: "crm_get", description: "GET a GurtAI CRM REST path (HubSpot v3 style), e.g. /crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,closedate&after=100, /crm/v3/pipelines/deals, /crm/v3/owners, /crm/v3/properties/deals", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "crm_search", description: "POST /crm/v3/objects/{type}/search with a HubSpot filterGroups body. Dates are epoch ms strings.", parameters: { type: "object", properties: { type: { type: "string" }, body: { type: "object" } }, required: ["type", "body"] } } },
];
const rawExec = async (name: string, a: any) => {
  if (String(a.path ?? "").startsWith("/warehouse")) return "error: not available through this connector";
  const r = name === "crm_get" ? await sys.get(String(a.path)) : await sys.post(`/crm/v3/objects/${a.type}/search`, a.body);
  return JSON.stringify(r.body);
};

// walter: whatever the hosted MCP exposes
const mcp = await connectMcp(st.mcps.sales.mcpUrl, {}, `fireworks-${model.split("/").pop()}`);
const MCP_TOOLS: ToolSpec[] = mcp.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown> } }));
const mcpExec = async (name: string, a: any) => (await mcp.call(name, a)).text;

const SYSTEM = "You are an operations agent at GurtAI. Use the tools to answer precisely. Finish with a short final answer.";
const results = [];
for (const t of TASKS) {
  for (const [mode, tools, exec] of [["raw", RAW_TOOLS, rawExec], ["walter", MCP_TOOLS, mcpExec]] as const) {
    const t0 = Date.now();
    const r = await runAgent(SYSTEM, tools as ToolSpec[], exec, t.prompt);
    const ok = t.check(r.answer);
    results.push({ task: t.id, mode, ok, truth: t.truth, answer: r.answer.slice(-400), toolCalls: r.calls, seconds: Math.round((Date.now() - t0) / 1000), transcript: r.messages.slice(1) });
    console.log(`${t.id.padEnd(8)} ${mode.padEnd(7)} ${ok ? "✓" : "✗"}  calls ${String(r.calls).padStart(2)}  truth ${t.truth}  answer: ${r.answer.replace(/\s+/g, " ").slice(-160)}`);
  }
}
await mcp.call("report_outcome", { tool: "get_commit", correct: results.find((r) => r.task === "commit" && r.mode === "walter")?.ok ?? false, note: "phase 6 agent run" });
await mcp.close();
await fs.mkdir(path.join(STATE_DIR, "agent"), { recursive: true });
await fs.writeFile(path.join(STATE_DIR, "agent", "phase6.json"), JSON.stringify({ model, at: new Date().toISOString(), usage, results }, null, 2));
const tokens = usage;
void tokens;
const score = (m: string) => `${results.filter((r) => r.mode === m && r.ok).length}/${TASKS.length}`;
console.log(`\nraw API ${score("raw")}  ·  walter MCP ${score("walter")}  (${model})`);
void rootDomain;
