/**
 * The walter MCP: the control plane agents use to give a company MCPs that know how it actually runs.
 *
 * An agent (in Claude, Cursor, ChatGPT, …) connects a system, watches walter learn its unwritten rules from history,
 * gets back a company-owned MCP on Manufact, and can create ops agents that run on those MCPs. Humans only show up
 * for questions history cannot settle (the question view).
 */
import { MCPServer } from "mcp-use";
import { oauthWorkOSProvider } from "mcp-use/oauth/workos";
import { z } from "zod";
import { Fleet, type FleetMcp } from "./fleet.js";
import { loadState } from "../state.js";

// What the build and question views read (loose: extra fields pass through).
const BuildOut = z.looseObject({ build_id: z.string(), mcp: z.string(), status: z.string(), stage: z.string(), progress: z.number(), log: z.array(z.string()) });
const QuestionsOut = z.looseObject({ questions: z.array(z.looseObject({ mcp: z.string(), question: z.number(), text: z.string(), options: z.array(z.string()) })) });

const ok = (data: unknown, text?: string) => ({ content: [{ type: "text" as const, text: text ?? JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: `error: ${message}` }], isError: true });
const userOf = (ctx: any): string => ctx?.auth?.user?.id ?? "local";
/** Wait (server-side) until `done()` or the time runs out, so agents don't have to poll. */
async function waitFor(done: () => boolean, seconds: number) {
  const end = Date.now() + Math.max(0, Math.min(seconds, 50)) * 1000;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
}

function clientConfig(m: FleetMcp) {
  const key = `gurtai-${m.id}`;
  return {
    url: m.mcpUrl,
    claude_code: `claude mcp add --transport http ${key} ${m.mcpUrl}`,
    cursor: { mcpServers: { [key]: { url: m.mcpUrl } } },
    chatgpt: `Settings → Connectors → Add custom connector → ${m.mcpUrl}`,
  };
}
const summary = (m: FleetMcp) => ({
  id: m.id, name: m.name, systems: m.systems, version: `v${m.version}`, url: m.mcpUrl, tools: m.tools.map((t) => t.name),
  rules: m.rules.length, open_questions: m.questions.length,
  evals: m.evals.map((e) => `${e.tool}: ${e.ok}/${e.n} past cases replayed exactly (held out: ${e.heldOutOk}/${e.heldOutN})`),
});

export function createWalterServer(fleet: Fleet, opts: { auth?: boolean; hash?: string } = {}) {
  const oauth = opts.auth ? oauthWorkOSProvider() : undefined;
  const server = new MCPServer({
    name: "walter",
    title: "walter",
    version: "1.0.0",
    description: "Give your agents MCPs that know how your company actually uses its systems. walter connects a system (CRM, ERP, inbox), learns its unwritten rules from history, proves them by replaying past work, and deploys a company-owned MCP on Manufact. Then create ops agents that run on those MCPs.",
    instructions: [
      "walter turns a company's systems into MCPs that already know the company's unwritten rules.",
      "Typical flow: list_templates → connect_system → build_status (until live) → create_agent (with run_now) → agent_status.",
      "Company MCPs apply the rules in their tools; get_playbook explains them. When walter has a question only a person can answer, show open_questions to the user and pass their choice to answer_question.",
    ].join("\n"),
    ...(oauth ? { oauth } : {}),
  } as any);

  server.tool({
    name: "list_templates",
    title: "List system templates",
    description: "Systems walter can connect right now without credentials: GurtAI's demo CRM + orders inbox, ERP and support inbox. Each was already mined from 22 months of history, so connecting takes seconds. To connect your own system, call connect_system with kind, url and credential instead.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_a: unknown, ctx: any) => {
    const connected = new Set(fleet.connected(userOf(ctx)).map((m) => m.id));
    return ok({ templates: fleet.templates().map((t) => ({ ...t, connected: connected.has(fleet.byTemplate(t.template)!.id) })) });
  });

  server.tool({
    name: "connect_system",
    title: "Connect a system",
    description: "Connect a business system so walter can learn how the company uses it and build its MCP. Either pass `template` (from list_templates; ready in seconds) or your own system: `kind` (crm, erp or inbox), `name`, `url`, `credential` (API token, or the contents of a .env-style credentials file) and optional `notes` (markdown: what your team already knows about the system). Returns a build_id; poll build_status until it is live.",
    inputSchema: z.object({
      template: z.string().optional().describe("template id from list_templates, e.g. gurtai-sales"),
      kind: z.enum(["crm", "erp", "inbox"]).optional().describe("for your own system: which kind it is"),
      name: z.string().optional().describe("for your own system: what the MCP should be called, e.g. Acme Sales"),
      url: z.string().optional().describe("for your own system: its API base URL"),
      credential: z.string().optional().describe("API token, or a credentials file's contents (TOKEN=..., API_KEY=...)"),
      notes: z.string().optional().describe("markdown notes about the system; shipped to agents in the MCP's playbook"),
    }),
    outputSchema: BuildOut,
    view: { name: "build-progress" },
  } as any, async (a: any, ctx: any) => {
    try {
      const user = userOf(ctx);
      if (a.template) {
        const b = fleet.connectTemplate(user, a.template);
        return ok({ build_id: b.id, mcp: b.mcp, status: b.status, stage: b.stage, progress: b.progress, log: b.log, next: "Call build_status with this build_id; it waits for the build to go live (about 10 seconds)." });
      }
      if (!a.kind || !a.name || !a.url || !a.credential) return fail("pass either template, or kind + name + url + credential for your own system. Call list_templates to see templates.");
      const token = /^[A-Z0-9_]+\s*=/m.test(a.credential) ? (/(?:TOKEN|API_KEY|KEY|SECRET)\s*=\s*["']?([^"'\n]+)/i.exec(a.credential)?.[1] ?? "").trim() : a.credential.trim();
      if (!token) return fail("could not find a token in that credentials file; expected a line like API_TOKEN=...");
      const b = await fleet.connectCustom(user, { kind: a.kind, name: a.name, url: a.url, credential: token, notes: a.notes });
      return ok({ build_id: b.id, mcp: b.mcp, status: b.status, stage: b.stage, progress: b.progress, log: b.log, next: "Mining takes 5–15 minutes. Poll build_status with this build_id." });
    } catch (e) { return fail((e as Error).message); }
  });

  server.tool({
    name: "build_status",
    title: "Build status",
    description: "Progress of a build started by connect_system or answer_question: stage, what walter has found so far, and once live the MCP's URL, tools and client setup. Waits up to wait_seconds (default 20) for the build to finish before answering, so one call is usually enough for a template.",
    inputSchema: z.object({ build_id: z.string().describe("build_id from connect_system or answer_question"), wait_seconds: z.number().min(0).max(50).optional().describe("how long to wait for the build to finish (default 20, 0 = answer now)") }),
    annotations: { readOnlyHint: true },
    outputSchema: BuildOut,
  } as any, async (a: any, ctx: any) => {
    const b = fleet.getBuild(userOf(ctx), a.build_id);
    if (!b) return fail(`no build "${a.build_id}" in your workspace`);
    await waitFor(() => b.status !== "running", a.wait_seconds ?? 20);
    const m = fleet.get(b.mcp);
    return ok({ build_id: b.id, mcp: b.mcp, status: b.status, stage: b.stage, progress: b.progress, log: b.log, error: b.error ?? null,
      ...(b.status === "live" && m ? { result: { ...summary(m), connect: clientConfig(m) }, next: "Use create_agent to put this MCP to work, or connect it to any MCP client with the config above." } : {}) });
  });

  server.tool({
    name: "list_mcps",
    title: "List company MCPs",
    description: "The company MCPs connected in this workspace: what each knows (rules, open questions), how well it matched history, and ready-to-paste setup for Claude Code, Cursor and ChatGPT.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_a: unknown, ctx: any) => {
    const ms = fleet.connected(userOf(ctx));
    return ok({ mcps: ms.map((m) => ({ ...summary(m), connect: clientConfig(m) })), ...(ms.length ? {} : { next: "Nothing connected yet. Call list_templates, then connect_system." }) });
  });

  server.tool({
    name: "get_playbook",
    title: "Get a playbook",
    description: "An MCP's playbook in markdown: the verified rules with their evidence, policies walter observed, what people told it, and what is still unsettled. Read it to explain or double-check what a company MCP does.",
    inputSchema: z.object({ mcp: z.string().describe("MCP id from list_mcps, e.g. sales") }),
    annotations: { readOnlyHint: true },
  }, async (a: any) => {
    const m = fleet.get(a.mcp);
    if (!m) return fail(`no MCP "${a.mcp}". Call list_mcps for ids.`);
    return ok({ mcp: m.id, playbook: m.playbook }, m.playbook);
  });

  server.tool({
    name: "open_questions",
    title: "Open questions",
    description: "Questions walter could not settle from history (usually a policy that changed). Show them to the user: only a person at the company can answer. Pass their choice to answer_question.",
    inputSchema: z.object({ mcp: z.string().optional().describe("limit to one MCP") }),
    annotations: { readOnlyHint: true },
    outputSchema: QuestionsOut,
    view: { name: "question-card" },
  } as any, async (a: any, ctx: any) => {
    const ms = fleet.connected(userOf(ctx)).filter((m) => !a.mcp || m.id === a.mcp);
    const qs = ms.flatMap((m) => m.questions.map((q) => ({ mcp: m.id, mcp_name: m.name, question: q.index, rule: q.rule_id, text: q.question, options: q.options, evidence: q.evidence })));
    return ok({ questions: qs, ...(qs.length ? {} : { note: ms.length ? "No open questions." : "Connect a system first (connect_system)." }) });
  });

  server.tool({
    name: "answer_question",
    title: "Answer a question",
    description: "Record a person's answer to one of walter's questions. walter revises the affected rule, checks it against history again, and redeploys the MCP as a new version. Returns a build_id to follow with build_status.",
    inputSchema: z.object({ mcp: z.string(), question: z.number().int().describe("question number from open_questions"), option: z.number().int().describe("index of the chosen option, starting at 0") }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (a: any, ctx: any) => {
    try {
      const b = await fleet.answer(userOf(ctx), a.mcp, a.question, a.option);
      return ok({ build_id: b.id, status: b.status, log: b.log, next: "Rebuilding takes 2–4 minutes. Poll build_status." });
    } catch (e) { return fail((e as Error).message); }
  });

  server.tool({
    name: "create_agent",
    title: "Create an ops agent",
    description: "Create an operations agent from a goal (e.g. \"every day, log new orders from the orders inbox into the CRM\"). walter picks the company MCPs it needs, writes its instructions, and schedules it. If a needed system is not connected yet, the reply says which template to connect first. Set run_now to run it immediately: the reply waits for the run (up to about a minute) and includes its report.",
    inputSchema: z.object({
      goal: z.string().describe("what the agent should do, in plain words"),
      name: z.string().optional(),
      schedule: z.string().nullable().optional().describe('e.g. "daily 08:00 UTC"; null for on demand only'),
      mcps: z.array(z.string()).optional().describe("MCP ids to use; walter picks if omitted"),
      run_now: z.boolean().optional().describe("start a run right away"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (a: any, ctx: any) => {
    try {
      const user = userOf(ctx);
      const { agent, missing } = await fleet.createAgent(user, a);
      if (missing.length) return ok({ created: false, needs: missing, next: `Connect ${missing.map((m) => m.template).join(", ")} with connect_system first, then call create_agent again.` });
      const run = a.run_now ? fleet.run(user, agent.id) : null;
      if (run) await waitFor(() => run.status !== "running", 50);
      return ok({ created: true, agent_id: agent.id, name: agent.name, mcps: agent.mcps.map((m) => m.name), schedule: agent.schedule ?? "on demand", instructions: agent.instructions,
        ...(run ? { run_id: run.id, run_status: run.status, tool_calls: run.toolCalls, report: run.answer ?? null, ...(run.error ? { error: run.error } : {}),
          next: run.status === "running" ? "The run is still going; call agent_status with this run_id (it waits for the result)." : "Done. agent_status with this run_id and detail: true shows every tool call it made." }
          : { next: "Call create_agent with run_now, or wait for the schedule." }) });
    } catch (e) { return fail((e as Error).message); }
  });

  server.tool({
    name: "agent_status",
    title: "Agent status",
    description: "Follow an ops agent: pass run_id for one run (each tool call it made and its final report), or agent_id for its recent runs. Set detail to also see what each tool call returned (to audit a run).",
    inputSchema: z.object({ run_id: z.string().optional(), agent_id: z.string().optional(), detail: z.boolean().optional().describe("include each tool call's result (trimmed)"), wait_seconds: z.number().min(0).max(50).optional().describe("for a running run: how long to wait for it to finish (default 20, 0 = answer now)") }),
    annotations: { readOnlyHint: true },
  }, async (a: any, ctx: any) => {
    const user = userOf(ctx);
    if (a.run_id) {
      const r = fleet.getRun(user, a.run_id);
      if (!r) return fail(`no run "${a.run_id}" in your workspace`);
      await waitFor(() => r.status !== "running", a.wait_seconds ?? 20);
      const steps = r.steps.filter((s) => a.detail || s.kind !== "result").map((s) => (s.kind === "call" ? `${s.mcp ? s.mcp + " · " : ""}${s.tool}(${s.text})` : s.kind === "result" ? `   → ${s.text}` : s.text));
      return ok({ run_id: r.id, agent: r.agent, status: r.status, tool_calls: r.toolCalls, started: r.startedAt, finished: r.finishedAt ?? null, steps, report: r.answer ?? null, error: r.error ?? null,
        ...(r.status === "running" ? { next: "Still running; call agent_status again in a few seconds." } : {}) });
    }
    const agents = fleet.agents(user).filter((x) => !a.agent_id || x.id === a.agent_id);
    return ok({ agents: agents.map((x) => ({ agent_id: x.id, name: x.name, goal: x.goal, schedule: x.schedule ?? "on demand", mcps: x.mcps.map((m) => m.name), runs: fleet.runs(user, x.id).map((r) => ({ run_id: r.id, status: r.status, started: r.startedAt, tool_calls: r.toolCalls })) })) });
  });

  server.tool({
    name: "reset_demo_data",
    title: "Reset demo data",
    description: "Put GurtAI's demo systems back to their original state (undoes CRM writes and inbox labels made by agents), so a demo or test can be run again from the start. Only affects the GurtAI demo systems.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async () => {
    const st = await loadState();
    if (!st.system?.url || !st.system.token) return fail("demo systems are not configured on this walter server");
    const r = await fetch(st.system.url + "/admin/reset", { method: "POST", headers: { authorization: `Bearer ${st.system.token}`, "content-type": "application/json" }, body: "{}" });
    return r.ok ? ok({ reset: true, ...(await r.json()) }) : fail(`reset failed: ${r.status}`);
  });

  server.prompt({
    name: "create_ops_agent",
    title: "Create an ops agent",
    description: "Turn a goal into a running agent: connect the systems it needs, let walter learn them, create the agent and run it once.",
    schema: z.object({ goal: z.string().describe("e.g. Every day, read the orders inbox and keep the CRM up to date") }),
  } as any, async (a: any) => ({ messages: [{ role: "user", content: { type: "text", text:
    `Create an ops agent for this goal: "${a.goal}".\n\n1. Call list_templates and connect_system for each system the goal needs; follow build_status until each is live and tell me in one line what walter learned.\n2. Call create_agent with the goal and run_now: true.\n3. Follow agent_status until the run is done, then summarize what the agent changed and which company rules it applied.\n4. If walter has open questions, show them to me with open_questions.` } }] }));

  server.prompt({
    name: "onboard_system",
    title: "Onboard a system",
    description: "Connect one system and show what walter learned about how the company uses it.",
    schema: z.object({ template: z.string().optional().describe("template id, e.g. gurtai-finance") }),
  } as any, async (a: any) => ({ messages: [{ role: "user", content: { type: "text", text:
    `Connect ${a.template ? `the ${a.template} template` : "a system (ask me which one, or use list_templates)"} with walter. Follow build_status until it is live, then read get_playbook and explain the three most important company rules it learned, with the evidence. Finish with the setup line for Claude Code and Cursor.` } }] }));

  server.prompt({
    name: "audit_company_mcps",
    title: "Audit company MCPs",
    description: "Review every connected MCP: how well it matches history, and what still needs a person's answer.",
  } as any, async () => ({ messages: [{ role: "user", content: { type: "text", text:
    "Call list_mcps and open_questions. For each MCP, give one line on how well it matched history (the evals), then show me any open questions so I can answer them." } }] }));

  server.resourceTemplate({ name: "playbook", uriTemplate: "walter://mcps/{id}/playbook", title: "MCP playbook", description: "A company MCP's playbook (markdown)", mimeType: "text/markdown" } as any,
    async (uri: URL, params: any) => {
      const m = fleet.get(String(params.id));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: m?.playbook ?? `No MCP "${params.id}".` }] };
    });

  // Manufact answers /health itself; walter checks which build is live here.
  server.get("/walter/health", (c: any) => c.json({ ok: true, name: "walter", hash: opts.hash ?? null, templates: fleet.templates().length }));

  return server;
}
