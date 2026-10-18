/**
 * Runs an ops agent: a Fireworks model with the tools of the company MCPs it was given, connected over MCP like any
 * other client. Each step is recorded so the run can be shown and audited.
 */
import { chat, MODELS, type Msg, type ToolSpec } from "../llm.js";
import { connectMcp, type Mcp } from "../mcp-client.js";

export interface AgentSpec { id: string; name: string; goal: string; instructions: string; mcps: { id: string; name: string; url: string }[]; schedule: string | null; model?: string; createdAt: string }
export interface RunStep { at: string; kind: "call" | "result" | "note"; tool?: string; mcp?: string; text: string }
export interface AgentRun { id: string; agent: string; status: "running" | "done" | "failed"; startedAt: string; finishedAt?: string; steps: RunStep[]; answer?: string; toolCalls: number; error?: string }

const clip = (s: string, n = 12_000) => (s.length > n ? s.slice(0, n) + "…[truncated]" : s);

export async function runAgent(spec: AgentSpec, run: AgentRun, opts: { maxSteps?: number; clientName?: string } = {}): Promise<AgentRun> {
  const note = (kind: RunStep["kind"], text: string, extra: Partial<RunStep> = {}) => run.steps.push({ at: new Date().toISOString(), kind, text, ...extra });
  const conns: { id: string; name: string; mcp: Mcp }[] = [];
  try {
    for (const m of spec.mcps) {
      conns.push({ id: m.id, name: m.name, mcp: await connectMcp(m.url, {}, opts.clientName ?? `walter-agent-${spec.id}`) });
      note("note", `connected to ${m.name}`);
    }
    // tool names are namespaced by MCP so agents can hold several company MCPs at once
    const route = new Map<string, { conn: (typeof conns)[number]; tool: string }>();
    const tools: ToolSpec[] = [];
    for (const c of conns) for (const t of c.mcp.tools) {
      const name = conns.length > 1 ? `${c.id}__${t.name}` : t.name;
      route.set(name, { conn: c, tool: t.name });
      tools.push({ type: "function", function: { name, description: `[${c.name}] ${t.description ?? ""}`, parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown> } });
    }
    const messages: Msg[] = [
      { role: "system", content: `You are "${spec.name}", an operations agent at GurtAI.\n\n${spec.instructions}\n\nUse the company MCP tools; they already apply GurtAI's rules. Do the work, then finish with a short report of what you changed.` },
      { role: "user", content: `Run now. Goal: ${spec.goal}` },
    ];
    for (let i = 0; i < (opts.maxSteps ?? 24); i++) {
      const r = await chat(spec.model ?? MODELS.glm, messages, tools, { maxTokens: 16_000, temperature: 0 });
      messages.push(r);
      if (!r.tool_calls?.length) {
        if (String(r.content ?? "").trim()) { run.answer = String(r.content); break; }
        messages.push({ role: "user", content: "Give your final report now." });
        continue;
      }
      for (const tc of r.tool_calls) {
        const target = route.get(tc.function.name);
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* model sent bad JSON */ }
        run.toolCalls++;
        note("call", JSON.stringify(args), { tool: target?.tool ?? tc.function.name, mcp: target?.conn.name });
        let out: string;
        if (!target) out = `error: no tool ${tc.function.name}`;
        else {
          const res = await target.conn.mcp.call(target.tool, args).catch((e) => ({ text: `error: ${(e as Error).message}`, isError: true }));
          out = res.text;
        }
        note("result", clip(out, 600), { tool: target?.tool ?? tc.function.name, mcp: target?.conn.name });
        messages.push({ role: "tool", tool_call_id: tc.id, content: clip(out) });
      }
    }
    run.status = "done";
    run.answer ??= "(the agent stopped without a report)";
  } catch (e) {
    run.status = "failed";
    run.error = (e as Error).message;
  } finally {
    run.finishedAt = new Date().toISOString();
    for (const c of conns) await c.mcp.close().catch(() => {});
  }
  return run;
}
