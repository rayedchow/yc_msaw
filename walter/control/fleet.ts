/**
 * The walter control plane's state: the company MCPs walter can connect (templates for GurtAI's demo systems, plus
 * anything connected for real), builds in progress, ops agents and their runs. Kept per signed-in user.
 *
 * Templates point at MCPs walter already mined, compiled and deployed to Manufact from the same history; connecting
 * one replays that build's real log in seconds instead of re-mining for 10 minutes. Custom connections run the real
 * pipeline (mine → compile → deploy → evals) here, in the walter server.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Knowledge } from "../compile/compile.js";
import { playbookMarkdown } from "../compile/playbook.js";
import { domainOf, DOMAINS } from "../domains/index.js";
import { makeBench } from "../mine/backtest.js";
import { SystemClient } from "../mine/data.js";
import { settle } from "../mine/settle.js";
import { buildAndShip, connectionFor, evalsPath, knowledgePath, mineToKnowledge, readJson } from "../pipeline.js";
import { loadState, saveState, STATE_DIR } from "../state.js";
import { chat, MODELS } from "../llm.js";
import { runAgent, type AgentRun, type AgentSpec } from "../agents/runner.js";

export interface FleetMcp {
  id: string; pack: string; name: string; systems: string[]; mcpUrl: string; version: number;
  tools: { name: string; description: string }[];
  rules: { id: string; title: string; status: string }[];
  evals: { tool: string; ok: number; n: number; heldOutOk: number; heldOutN: number }[];
  questions: { index: number; rule_id: string; question: string; options: string[]; evidence: string }[];
  playbook: string;
  build: { steps: number; seconds: number; log: string[] };
  template?: { id: string; title: string; description: string };
}
export interface Build { id: string; kind: "template" | "custom" | "answer"; mcp: string; status: "running" | "live" | "failed"; stage: string; progress: number; log: string[]; startedAt: string; finishedAt?: string; error?: string }
interface Workspace { connected: Set<string>; builds: Map<string, Build>; agents: Map<string, AgentSpec>; runs: Map<string, AgentRun>; timers: Map<string, ReturnType<typeof setInterval>> }

const TEMPLATE_COPY: Record<string, { id: string; title: string; description: string }> = {
  sales: { id: "gurtai-sales", title: "GurtAI CRM + orders inbox", description: "HubSpot-style CRM (deals, contacts, companies, forecast history) and the orders@ mailbox" },
  erp: { id: "gurtai-finance", title: "GurtAI ERP (accounts payable)", description: "NetSuite-style vendors, vendor bills, system notes and AP payment runs" },
  mail: { id: "gurtai-support", title: "GurtAI support inbox", description: "Gmail-style support@ shared inbox with label and assignment history" },
};

/** Build the fleet snapshot from local walter state (used when packaging the walter MCP, and when running locally). */
export async function snapshotFleet(): Promise<FleetMcp[]> {
  const st = await loadState();
  const out: FleetMcp[] = [];
  for (const [id, dep] of Object.entries(st.mcps ?? {})) {
    const k = await readJson<Knowledge>(knowledgePath(id));
    if (!k || !dep.mcpUrl) continue;
    const domain = domainOf(k.pack ?? id);
    const ev = await readJson<{ summary: { tool: string; ok: number; n: number; heldOut: { ok: number; n: number } }[] }>(evalsPath(id));
    const live = k.rules.filter((r) => r.status !== "retired");
    const open = k.questions.map((q, i) => ({ q, i })).filter((x) => !x.q.answer);
    const tools = [...domain.tools.filter((t) => t.kinds.some((kd) => live.some((r) => r.kind === kd))).map((t) => ({ name: t.name, description: t.d })),
      { name: "company_rules", description: "The rules this MCP applies, with evidence, and the full playbook" }, { name: "report_outcome", description: "Tell walter when an answer was wrong" }];
    const notes = st.connections?.[id]?.notes ?? (await fs.readFile(path.join(domain.dir, "..", "..", "integrations", domain.mdFile), "utf8").catch(() => ""));
    out.push({
      id, pack: domain.id, name: k.name ?? domain.name, systems: domain.systems, mcpUrl: dep.mcpUrl, version: dep.version ?? k.version ?? 1, tools,
      rules: live.map((r) => ({ id: r.id, title: r.title, status: open.some((x) => x.q.rule_id === r.id) ? "waiting on an answer" : r.change && r.status !== "confirmed" ? "changed recently" : "confirmed by history" })),
      evals: (ev?.summary ?? []).map((s) => ({ tool: s.tool, ok: s.ok, n: s.n, heldOutOk: s.heldOut.ok, heldOutN: s.heldOut.n })),
      questions: open.map(({ q, i }) => ({ index: i, rule_id: q.rule_id, question: q.question, options: q.options, evidence: q.evidence })),
      playbook: playbookMarkdown(k, domain, { name: k.name ?? domain.name, notes, tools: tools.map((t) => t.name) }),
      build: { steps: (k as any).steps ?? 0, seconds: (k as any).seconds ?? 0, log: buildLog(k) },
      ...(id === domain.id && TEMPLATE_COPY[id] ? { template: TEMPLATE_COPY[id] } : {}),
    });
  }
  return out;
}

/** The milestones of a real mining run, in order: what walter found and how well it held on history. */
function buildLog(k: Knowledge): string[] {
  const pct = (x: { n: number; ok: number }) => (x.n ? Math.round((100 * x.ok) / x.n) : 0);
  return [
    ...k.rules.filter((r) => r.status !== "retired").map((r) => `${r.id} ${r.title} (agrees on ${pct({ n: r.train.n + r.heldOut.n, ok: r.train.ok + r.heldOut.ok })}% of ${(r.train.n + r.heldOut.n).toLocaleString()} past decisions)`),
    ...k.questions.filter((q) => !q.answer).map((q) => `question for a human on ${q.rule_id}: ${q.question}`),
  ];
}

export class Fleet {
  private mcps = new Map<string, FleetMcp>();
  private spaces = new Map<string, Workspace>();
  constructor(snapshot: FleetMcp[]) { for (const m of snapshot) this.mcps.set(m.id, m); }

  space(user: string): Workspace {
    let w = this.spaces.get(user);
    if (!w) this.spaces.set(user, (w = { connected: new Set(), builds: new Map(), agents: new Map(), runs: new Map(), timers: new Map() }));
    return w;
  }
  templates() { return [...this.mcps.values()].filter((m) => m.template).map((m) => ({ template: m.template!.id, title: m.template!.title, description: m.template!.description, gives: m.name, tools: m.tools.map((t) => t.name), rules: m.rules.length })); }
  get(id: string) { return this.mcps.get(id) ?? null; }
  connected(user: string) { return [...this.space(user).connected].map((id) => this.mcps.get(id)!).filter(Boolean); }
  byTemplate(t: string) { return [...this.mcps.values()].find((m) => m.template?.id === t) ?? null; }

  /** Template: replay the real build of a prebuilt MCP in a few seconds. */
  connectTemplate(user: string, templateId: string): Build {
    const m = this.byTemplate(templateId);
    if (!m) throw new Error(`no template "${templateId}". Call list_templates for the options.`);
    const w = this.space(user);
    const b: Build = { id: `b_${randomUUID().slice(0, 8)}`, kind: "template", mcp: m.id, status: "running", stage: "connecting", progress: 3, log: [], startedAt: new Date().toISOString() };
    w.builds.set(b.id, b);
    const steps: [string, string, number][] = [
      ["connecting", `connected to ${m.systems.join(" and ")} (template credentials)`, 900],
      ["reading history", "reading 22 months of records and change history", 1600],
      ...m.build.log.map((l): [string, string, number] => ["mining", `found ${l}`, 1100]),
      ["compiling", `compiling ${m.rules.length} rules into ${m.tools.length} tools and a playbook`, 1200],
      ["deploying", "deploying to Manufact", 1500],
      ["evals", `replaying history through the MCP: ${m.evals.map((e) => `${e.tool} ${e.ok}/${e.n}`).join(", ")}`, 1200],
    ];
    (async () => {
      for (let i = 0; i < steps.length; i++) {
        const [stage, text, ms] = steps[i]!;
        b.stage = stage; b.log.push(text); b.progress = Math.round(5 + (90 * (i + 1)) / steps.length);
        await new Promise((r) => setTimeout(r, ms));
      }
      w.connected.add(m.id);
      b.status = "live"; b.stage = "live"; b.progress = 100; b.finishedAt = new Date().toISOString();
      b.log.push(`live at ${m.mcpUrl}`);
    })();
    return b;
  }

  /** Custom: the real pipeline against a system someone points walter at. */
  async connectCustom(user: string, input: { kind: string; name: string; url: string; credential: string; notes?: string }): Promise<Build> {
    const pack = { crm: "sales", erp: "erp", inbox: "mail", sales: "sales", mail: "mail" }[input.kind] ?? input.kind;
    const domain = DOMAINS[pack];
    if (!domain) throw new Error(`kind must be one of crm, erp, inbox (got "${input.kind}")`);
    const id = input.name.toLowerCase().replace(/^gurtai\s+/, "").replace(/\bmcp\b/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || pack;
    if (this.mcps.has(id)) throw new Error(`an MCP called "${id}" already exists; pick another name`);
    const url = input.url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) throw new Error("url must start with http:// or https://");
    const client = new SystemClient(url, input.credential);
    try { await Promise.race([domain.fetchData(client), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 60s")), 60_000))]); }
    catch (e) { throw new Error(`could not read ${domain.systems[0]} at ${url} with that credential: ${(e as Error).message.slice(0, 200)}`); }
    const st = await loadState();
    st.connections = { ...(st.connections ?? {}), [id]: { pack, name: input.name, url, token: input.credential, notes: input.notes ?? "", createdAt: new Date().toISOString() } };
    await saveState(st);
    const w = this.space(user);
    const b: Build = { id: `b_${randomUUID().slice(0, 8)}`, kind: "custom", mcp: id, status: "running", stage: "mining", progress: 5, log: [`connected to ${domain.systems[0]} at ${url}`], startedAt: new Date().toISOString() };
    w.builds.set(b.id, b);
    (async () => {
      try {
        const { knowledge } = await mineToKnowledge(domain, id, { name: input.name, client, onStep: (n) => { b.progress = Math.min(75, 5 + Math.round((n / 60) * 70)); },
          log: (s) => { if (/ save_rule /.test(s)) b.log.push(`found rule ${b.log.filter((l) => l.startsWith("found rule")).length + 1} and checked it against history`); else if (/ ask_question /.test(s)) b.log.push("asked a question history can't settle"); } });
        b.log.push(`mined ${knowledge.rules.length} rules and ${knowledge.questions.length} questions`);
        b.stage = "deploying"; b.progress = 80;
        await buildAndShip(knowledge, { log: (s) => { b.log.push(s); if (/^live at/.test(s)) { b.stage = "evals"; b.progress = 92; } } });
        const snap = (await snapshotFleet()).find((m) => m.id === id);
        if (snap) this.mcps.set(id, snap);
        w.connected.add(id);
        b.status = "live"; b.stage = "live"; b.progress = 100;
      } catch (e) {
        b.status = "failed"; b.error = (e as Error).message; b.log.push(`failed: ${b.error}`);
      } finally { b.finishedAt = new Date().toISOString(); }
    })();
    return b;
  }

  /** A human answered a question: settle the rule, rebuild, redeploy the same server, re-run evals. */
  async answer(user: string, mcpId: string, index: number, option: number): Promise<Build> {
    const m = this.mcps.get(mcpId);
    const k = await readJson<Knowledge>(knowledgePath(mcpId));
    const q = k?.questions[index];
    if (!m || !k) throw new Error(`no MCP "${mcpId}". Call list_mcps for ids.`);
    if (!q || q.answer) throw new Error(`no open question ${index} on ${mcpId}. Call open_questions for the list.`);
    const choice = q.options[option];
    if (!choice) throw new Error(`option must be between 0 and ${q.options.length - 1}`);
    const b: Build = { id: `b_${randomUUID().slice(0, 8)}`, kind: "answer", mcp: mcpId, status: "running", stage: "settling", progress: 10, log: [`answer: "${choice}"`], startedAt: new Date().toISOString() };
    this.space(user).builds.set(b.id, b);
    (async () => {
      try {
        const conn = connectionFor(await loadState(), mcpId);
        const domain = domainOf(k.pack ?? mcpId);
        const bench = makeBench(domain, await domain.fetchData(new SystemClient(conn.url, conn.token)));
        const s = await settle(bench, k, index, choice);
        b.log.push(`${s.action} ${s.rule.id}: ${s.note}`);
        const version = (k.version ?? 1) + 1;
        k.rules = k.rules.map((r) => (r.id === s.rule.id ? s.rule : r));
        k.questions[index] = { ...q, answer: choice, answeredAt: new Date().toISOString() };
        k.version = version;
        k.changelog = [...(k.changelog ?? []), { version, note: `${s.rule.id}: ${s.note || s.action}`, at: new Date().toISOString() }];
        await fs.writeFile(knowledgePath(mcpId), JSON.stringify(k, null, 2));
        b.stage = "deploying"; b.progress = 40;
        await buildAndShip(k, { log: (t) => { b.log.push(t); if (/^live at/.test(t)) { b.stage = "evals"; b.progress = 85; } } });
        const snap = (await snapshotFleet()).find((x) => x.id === mcpId);
        if (snap) this.mcps.set(mcpId, { ...snap, template: m.template });
        b.status = "live"; b.stage = "live"; b.progress = 100; b.log.push(`v${version} live`);
      } catch (e) {
        b.status = "failed"; b.error = (e as Error).message; b.log.push(`failed: ${b.error}`);
      } finally { b.finishedAt = new Date().toISOString(); }
    })();
    return b;
  }

  /** Design an ops agent for a goal from the MCPs this workspace has: which MCPs, what instructions, what schedule. */
  async createAgent(user: string, input: { goal: string; name?: string; mcps?: string[]; schedule?: string | null }): Promise<{ agent: AgentSpec; missing: { template: string; why: string }[] }> {
    const w = this.space(user);
    const catalog = [...this.mcps.values()].map((m) => ({ id: m.id, name: m.name, connected: w.connected.has(m.id), template: m.template?.id ?? null, systems: m.systems, tools: m.tools.map((t) => `${t.name}: ${t.description}`) }));
    const reply = await chat(MODELS.glm, [
      { role: "system", content: "You design operations agents for a company. Given a goal and the company MCPs available, reply with JSON only: {\"name\": short agent name, \"mcps\": [ids of MCPs the agent needs], \"instructions\": numbered steps the agent should follow each run, using the MCP tools by name, \"schedule\": \"daily 08:00 UTC\" style text or null}. Pick only MCPs whose tools are needed." },
      { role: "user", content: JSON.stringify({ goal: input.goal, requested_mcps: input.mcps ?? null, requested_schedule: input.schedule ?? null, available: catalog }) },
    ], [], { maxTokens: 4000, temperature: 0 });
    const text = String(reply.content ?? "");
    let design: { name?: string; mcps?: string[]; instructions?: string | string[]; schedule?: string | null };
    try { design = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { throw new Error("could not design the agent (model did not return JSON); try again"); }
    const want = (input.mcps?.length ? input.mcps : design.mcps ?? []).filter((id) => this.mcps.has(id));
    if (!want.length) throw new Error("no company MCP fits this goal. Call list_templates and connect_system first.");
    const missing = want.filter((id) => !w.connected.has(id)).map((id) => ({ template: this.mcps.get(id)!.template?.id ?? id, why: `${this.mcps.get(id)!.name} is needed for this goal` }));
    const agent: AgentSpec = {
      id: `a_${randomUUID().slice(0, 8)}`, name: input.name ?? design.name ?? "ops agent", goal: input.goal,
      instructions: Array.isArray(design.instructions) ? design.instructions.map((s: unknown, i: number) => `${i + 1}. ${String(s).replace(/^\d+[.)]\s*/, "")}`).join("\n") : String(design.instructions ?? input.goal), schedule: input.schedule === undefined ? design.schedule ?? null : input.schedule,
      mcps: want.map((id) => ({ id, name: this.mcps.get(id)!.name, url: this.mcps.get(id)!.mcpUrl })), createdAt: new Date().toISOString(),
    };
    if (!missing.length) {
      w.agents.set(agent.id, agent);
      if (agent.schedule) this.schedule(user, agent);
    }
    return { agent, missing };
  }

  /** Start a run now. Runs are recorded step by step. */
  run(user: string, agentId: string): AgentRun {
    const w = this.space(user);
    const agent = w.agents.get(agentId);
    if (!agent) throw new Error(`no agent "${agentId}". Call create_agent first.`);
    const run: AgentRun = { id: `r_${randomUUID().slice(0, 8)}`, agent: agent.id, status: "running", startedAt: new Date().toISOString(), steps: [], toolCalls: 0 };
    w.runs.set(run.id, run);
    void runAgent(agent, run);
    return run;
  }

  /** Daily schedule while this walter server is up ("daily HH:MM UTC"; other texts run every 24h from now). */
  private schedule(user: string, agent: AgentSpec) {
    const w = this.space(user);
    const m = /(\d{1,2}):(\d{2})/.exec(agent.schedule ?? "");
    const now = new Date();
    let first = 24 * 3_600_000;
    if (m) { const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[1]), Number(m[2])); first = (t > now.getTime() ? t : t + 86_400_000) - now.getTime(); }
    setTimeout(() => { this.run(user, agent.id); w.timers.set(agent.id, setInterval(() => this.run(user, agent.id), 86_400_000)); }, first);
  }

  agents(user: string) { return [...this.space(user).agents.values()]; }
  runs(user: string, agentId?: string) { return [...this.space(user).runs.values()].filter((r) => !agentId || r.agent === agentId); }
  getRun(user: string, id: string) { return this.space(user).runs.get(id) ?? null; }
  getBuild(user: string, id: string) { return this.space(user).builds.get(id) ?? null; }
  builds(user: string) { return [...this.space(user).builds.values()]; }
}

/** Seed a fresh walter server (on Manufact) with the fleet's knowledge, deploy links and system credentials. */
export async function seedFromSnapshot(dir: string): Promise<void> {
  const knowledgeDir = path.join(dir, "knowledge");
  const files = await fs.readdir(knowledgeDir).catch(() => [] as string[]);
  await fs.mkdir(path.join(STATE_DIR, "knowledge"), { recursive: true });
  for (const f of files) {
    const to = path.join(STATE_DIR, "knowledge", f);
    if (!(await fs.stat(to).catch(() => null))) await fs.copyFile(path.join(knowledgeDir, f), to);
  }
  const links = await readJson<Record<string, unknown>>(path.join(dir, "links.json")) ?? {};
  for (const [name, link] of Object.entries(links)) {
    const p = path.join(STATE_DIR, "projects", name, ".mcp-use", "cloud", "link.json");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(link));
  }
  const st = await loadState();
  const mcps = await readJson<Record<string, any>>(path.join(dir, "mcps.json")) ?? {};
  await saveState({ ...st, mcps: { ...mcps, ...(st.mcps ?? {}) }, system: st.system ?? (process.env.GURTAI_URL ? { url: process.env.GURTAI_URL, token: process.env.GURTAI_TOKEN } : undefined), walterToken: st.walterToken ?? process.env.WALTER_TOKEN });
}
