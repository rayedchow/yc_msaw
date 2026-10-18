/**
 * The miner: a Fireworks agent that explores a system through its API and history, proposes rules as code, and
 * keeps the ones that hold on history. The host owns every check: backtests are deterministic and run here; the
 * model only proposes. Nothing GurtAI-specific is in the prompt; the agent has to find it.
 */
import vm from "node:vm";
import { chat, MODELS, type Msg, type ToolSpec } from "../llm.js";
import { DECISION_KINDS, rootDomain, quarterOf, quarterRange, type Dataset, type DecisionKind, SystemClient } from "./data.js";
import { backtestRule, HELD_OUT_FROM, makeBench, replayCommit, type Bench, type Rule, type RuleResult } from "./backtest.js";

export interface Question { rule_id: string; question: string; options: string[]; evidence: string }
export interface MineResult { rules: Rule[]; questions: Question[]; summary: string; transcript: Msg[]; steps: number }

const clip = (s: string, n = 6000) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars]` : s);

const SYSTEM = `You are walter's miner. You study ONE company's business system and discover its unwritten rules ("tribal knowledge"):
how people at this company actually use the system, which nobody wrote down.

You work only from evidence: the system's current records and its full change history. walter has turned that history into
"decisions" people made repeatedly (list_decisions). Your job: write rules as small JavaScript functions that predict those
decisions, then check them with backtest_rule. The host runs every backtest deterministically: learned months are before
${HELD_OUT_FROM}, later months are held out.

How to work:
1. describe_system, list_decisions. Use api_get and analyze to look at real records and history (who changed what, when).
2. Form a hypothesis, write it as a function, backtest it. Read the counterexamples, refine, backtest again.
3. Keep rules ATOMIC: one business fact per rule (e.g. "only booked deals count" and "the sandbox pipeline never counts"
   are two rules). For commit_membership, give each rule a role: "include" (a deal counts if any include rule fires) or
   "exclude" (a deal never counts if an exclude rule fires).
4. save_rule only what holds on learned history (normally >= 97%). Give each a plain-English title and a 2-3 word short label.
5. If history cannot settle something (a few unexplained cases, or a rule that only fits a handful of decisions, or a change
   in recent months), call ask_question with evidence and 2-3 options. Do not guess.
6. When every decision kind has rules (or a question), call finish with a short summary.

Rule code is one JS arrow function, no imports, deterministic. Helpers on ctx: ctx.stateAt(object, id, epochMs) -> properties
as of that time (object is "deal" | "contact" | "company"), ctx.quarterOf(ms), ctx.quarterRange("2026-Q3"), ctx.rootDomain(s).`;

const TOOLS: ToolSpec[] = [
  { type: "function", function: { name: "describe_system", description: "Endpoints, object types, properties, pipelines/stages, owners, warehouse tables and record counts.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "api_get", description: "GET a REST path on the system (auth is injected). e.g. /crm/v3/objects/deals?limit=5&properties=dealname,dealstage or /warehouse/field_history?object=deal&property=booked&limit=20", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "analyze", description: "Run a JS function body over all data and return its result as JSON. In scope: data = { deals, contacts, companies, history, snapshots } and ctx (stateAt, quarterOf, quarterRange, rootDomain). Must `return` something small. 5 s limit.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } } },
  { type: "function", function: { name: "list_decisions", description: "The decision kinds walter extracted from history, with counts, what each rule function receives and must return.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "backtest_rule", description: "Backtest a rule against recorded decisions. Returns learned/held-out agreement, a month-by-month series, change detection and counterexamples. For commit_membership include rules, saved exclude rules are applied first.", parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, kind: { type: "string", enum: Object.keys(DECISION_KINDS) }, role: { type: "string", enum: ["include", "exclude"] }, code: { type: "string" } }, required: ["id", "title", "kind", "code"] } } },
  { type: "function", function: { name: "save_rule", description: "Keep a backtested rule. Same fields as backtest_rule plus short (2-3 words) and evidence (one sentence on what in history supports it).", parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, short: { type: "string" }, evidence: { type: "string" }, kind: { type: "string", enum: Object.keys(DECISION_KINDS) }, role: { type: "string", enum: ["include", "exclude"] }, code: { type: "string" } }, required: ["id", "title", "short", "evidence", "kind", "code"] } } },
  { type: "function", function: { name: "ask_question", description: "Ask a human something history cannot settle. Tie it to a rule id.", parameters: { type: "object", properties: { rule_id: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } }, evidence: { type: "string" } }, required: ["rule_id", "question", "options", "evidence"] } } },
  { type: "function", function: { name: "finish", description: "Done mining.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];

export function summarize(r: RuleResult): Record<string, unknown> {
  const pct = (x: { n: number; ok: number }) => (x.n ? Math.round((1000 * x.ok) / x.n) / 10 : null);
  return {
    id: r.id, kind: r.kind, ...(r.role ? { role: r.role } : {}), ...(r.error ? { error: r.error } : {}),
    learned: `${r.train.ok}/${r.train.n} (${pct(r.train)}%)`, heldOut: `${r.heldOut.ok}/${r.heldOut.n} (${pct(r.heldOut)}%)`,
    months: r.months.map((m) => `${m.month}:${m.n ? Math.round((100 * m.ok) / m.n) : "-"}%`).join(" "),
    ...(r.change ? { change: r.change } : {}),
    counterexamples: r.counterexamples.slice(0, 8),
  };
}

export async function mine(client: SystemClient, opts: { model?: string; maxSteps?: number; log?: (s: string) => void } = {}): Promise<MineResult & { bench: Bench }> {
  const log = opts.log ?? (() => {});
  const ds: Dataset = await client.dataset();
  const bench = makeBench(ds);
  const saved = new Map<string, Rule>();
  const questions: Question[] = [];
  let summary = "";
  const sandbox = vm.createContext({ data: ds, ctx: bench.ctx, Math, Number, String, Date, JSON, Array, Object, Set, Map, RegExp });

  const counts: Record<string, number> = {};
  for (const d of bench.decisions) counts[d.kind] = (counts[d.kind] ?? 0) + 1;

  const handlers: Record<string, (a: any) => Promise<unknown> | unknown> = {
    describe_system: async () => ({
      endpoints: ["GET /crm/v3/objects/{deals|contacts|companies}?limit&after&properties", "GET /crm/v3/objects/{type}/{id}", "POST /crm/v3/objects/{type}/search", "GET /crm/v3/pipelines/deals", "GET /crm/v3/owners", "GET /crm/v3/properties/{type}", "GET /warehouse/tables", "GET /warehouse/field_history?object&property&id&since&until&limit&after", "GET /warehouse/forecast_snapshots"],
      counts: { deals: ds.deals.length, contacts: ds.contacts.length, companies: ds.companies.length, history: ds.history.length, snapshots: ds.snapshots.length },
      properties: { deals: Object.keys(ds.deals[0]!.properties), contacts: Object.keys(ds.contacts[0]!.properties), companies: [...new Set(ds.companies.flatMap((c) => Object.keys(c.properties)))] },
      pipelines: ds.pipelines, owners: ds.owners,
      warehouse: (await client.get("/warehouse/tables")).body,
    }),
    api_get: async (a) => {
      const r = await client.get(String(a.path));
      return { status: r.status, body: r.body };
    },
    analyze: (a) => {
      const fn = new vm.Script(`(() => { ${a.code} })()`).runInContext(sandbox, { timeout: 5000 });
      return fn;
    },
    list_decisions: () => Object.entries(DECISION_KINDS).map(([k, v]) => ({ kind: k, count: counts[k] ?? 0, ...v })),
    backtest_rule: (a) => {
      const rule: Rule = { id: a.id, title: a.title, kind: a.kind as DecisionKind, ...(a.role ? { role: a.role } : {}), code: a.code };
      const res = backtestRule(bench, rule, [...saved.values()]);
      const out: Record<string, unknown> = summarize(res);
      if (rule.kind === "commit_membership" || rule.kind === "commit_total") {
        const rules = [...[...saved.values()].filter((r) => r.id !== rule.id), rule];
        if (rules.some((r) => r.kind === "commit_membership" && r.role !== "exclude") && rules.some((r) => r.kind === "commit_total")) {
          try {
            out.replay = replayCommit(bench, rules).map((x) => `${x.month} ${x.match ? "exact" : `recorded $${x.recorded} (${x.recordedIds} deals) vs $${x.got} (${x.gotIds})`}`);
          } catch (e) {
            out.replay = `error: ${(e as Error).message}`;
          }
        }
      }
      return out;
    },
    save_rule: (a) => {
      const rule: Rule = { id: a.id, title: a.title, short: a.short, evidence: a.evidence, kind: a.kind as DecisionKind, ...(a.role ? { role: a.role } : {}), code: a.code };
      const res = backtestRule(bench, rule, [...saved.values()]);
      if (res.error) return { saved: false, error: res.error };
      saved.set(rule.id, rule);
      return { saved: true, ...summarize(res) };
    },
    ask_question: (a) => {
      questions.push({ rule_id: a.rule_id, question: a.question, options: a.options, evidence: a.evidence });
      return { recorded: true };
    },
    finish: (a) => {
      summary = String(a.summary ?? "");
      return { done: true };
    },
  };

  const messages: Msg[] = [{ role: "system", content: SYSTEM }, { role: "user", content: "Mine this system. Start with describe_system and list_decisions." }];
  const maxSteps = opts.maxSteps ?? 60;
  let steps = 0;
  for (; steps < maxSteps && !summary; steps++) {
    const reply = await chat(opts.model ?? MODELS.kimi, messages, TOOLS, { maxTokens: 6000 });
    messages.push(reply);
    if (!reply.tool_calls?.length) {
      messages.push({ role: "user", content: "Continue with tools. Call finish when every decision kind has a rule or a question." });
      continue;
    }
    for (const tc of reply.tool_calls) {
      let result: unknown;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        result = await handlers[tc.function.name]?.(args) ?? { error: `unknown tool ${tc.function.name}` };
        log(`step ${steps} ${tc.function.name} ${tc.function.name === "save_rule" || tc.function.name === "ask_question" ? JSON.stringify(args).slice(0, 160) : ""}`);
      } catch (e) {
        result = { error: (e as Error).message.slice(0, 500) };
        log(`step ${steps} ${tc.function.name} error ${(e as Error).message.slice(0, 120)}`);
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: clip(JSON.stringify(result) ?? "null") });
    }
  }
  return { rules: [...saved.values()], questions, summary, transcript: messages, steps, bench };
}
