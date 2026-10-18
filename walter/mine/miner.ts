/**
 * The miner: a Fireworks agent that explores a system through its API and history, proposes rules as code, and
 * keeps the ones that hold on history. The host owns every check: backtests are deterministic and run here; the
 * model only proposes. Nothing company-specific is in the prompt beyond what the system is; the agent has to find it.
 */
import vm from "node:vm";
import { chat, MODELS, type Msg, type ToolSpec } from "../llm.js";
import type { SystemClient } from "./data.js";
import type { Domain } from "../domains/types.js";
import { backtestRule, compileRule, firstValue, HELD_OUT_FROM, makeBench, orderCases, type Bench, type Rule, type RuleResult } from "./backtest.js";

export interface Question { rule_id: string; question: string; options: string[]; evidence: string }
export interface MineResult { rules: Rule[]; questions: Question[]; summary: string; transcript: Msg[]; steps: number }

const clip = (s: string, n = 6000) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars]` : s);

const system = (d: Domain) => `You are walter's miner. You study ONE company's business system and discover its unwritten rules ("tribal knowledge"):
how people at this company actually use the system, which nobody wrote down.

The system: ${d.title}.

You work only from evidence: the system's current records and its full change history. walter has turned that history into
"decisions" people made repeatedly (list_decisions). Your job: write rules as small JavaScript functions that predict those
decisions, then check them with backtest_rule. The host runs every backtest deterministically: learned months are before
${HELD_OUT_FROM}, later months are held out.

How to work:
1. describe_system, list_decisions. Use api_get and analyze to look at real records and history (who changed what, when).
   Fields that look authoritative are not always the ones people actually use: check against what happened.
2. Form a hypothesis, write it as a function, backtest it. Read the counterexamples, refine, backtest again.
3. Keep rules ATOMIC: one business fact per rule. For decision kinds marked combine="set", give each rule a role:
   "include" (an item is in if any include rule fires) or "exclude" (an item is never in if an exclude rule fires).
   For other kinds, rules are cases: return null where the rule does not apply. The first rule that returns a value
   decides, and a rule that returns a value for everything is the fallback (applied last). Together the cases of a kind
   should cover every decision; backtests report what share each rule applies to.
4. save_rule only what holds on learned history (normally >= 97%). Give each a plain-English title and a short label of at
   most 18 characters.
5. If history cannot settle something (a few unexplained cases, a rule that only fits a handful of decisions, or a change
   in recent months), call ask_question with evidence and 2-3 options. Do not guess.
6. When every decision kind has rules (or a question), call finish with a short summary.

Rule code is one JS arrow function, no imports, deterministic. Helpers on ctx: ${d.ctxHelp}.`;

function tools(d: Domain): ToolSpec[] {
  const kinds = Object.keys(d.kinds);
  return [
    { type: "function", function: { name: "describe_system", description: "Endpoints, object types, fields, reference data, history tables and record counts.", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "api_get", description: "GET a REST path on the system (auth is injected). Paths come from describe_system.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    { type: "function", function: { name: "analyze", description: "Run a JS function body over all data and return its result as JSON. In scope: data (see describe_system.analyze_data) and ctx (the same helpers rules get). Must `return` something small. 5 s limit.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } } },
    { type: "function", function: { name: "list_decisions", description: "The decision kinds walter extracted from history, with counts, what each rule function receives and must return.", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "backtest_rule", description: "Backtest a rule against recorded decisions. Returns learned/held-out agreement, a month-by-month series, change detection and counterexamples. For set kinds, saved exclude rules are applied before include rules are judged.", parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, kind: { type: "string", enum: kinds }, role: { type: "string", enum: ["include", "exclude"] }, code: { type: "string" } }, required: ["id", "title", "kind", "code"] } } },
    { type: "function", function: { name: "save_rule", description: "Keep a backtested rule. Same fields as backtest_rule plus short (at most 18 characters) and evidence (one sentence on what in history supports it).", parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, short: { type: "string" }, evidence: { type: "string" }, kind: { type: "string", enum: kinds }, role: { type: "string", enum: ["include", "exclude"] }, code: { type: "string" } }, required: ["id", "title", "short", "evidence", "kind", "code"] } } },
    { type: "function", function: { name: "ask_question", description: "Ask a human something history cannot settle. Tie it to a rule id.", parameters: { type: "object", properties: { rule_id: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } }, evidence: { type: "string" } }, required: ["rule_id", "question", "options", "evidence"] } } },
    { type: "function", function: { name: "finish", description: "Done mining.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
  ];
}

export function summarize(r: RuleResult): Record<string, unknown> {
  const pct = (x: { n: number; ok: number }) => (x.n ? Math.round((1000 * x.ok) / x.n) / 10 : null);
  return {
    id: r.id, kind: r.kind, ...(r.role ? { role: r.role } : {}), ...(r.error ? { error: r.error } : {}),
    appliesTo: `${r.applies.n}/${r.applies.of}`,
    learned: `${r.train.ok}/${r.train.n} (${pct(r.train)}%)`, heldOut: `${r.heldOut.ok}/${r.heldOut.n} (${pct(r.heldOut)}%)`,
    months: r.months.map((m) => `${m.month}:${m.n ? Math.round((100 * m.ok) / m.n) : "-"}%`).join(" "),
    ...(r.change ? { change: r.change } : {}),
    counterexamples: r.counterexamples.slice(0, 8),
  };
}

/** Exact replay of the domain's recorded aggregate (commit, payment runs) once set + value rules exist. */
export function aggregateReplay(b: Bench, rules: Rule[]): string[] | string | null {
  const agg = b.domain.aggregate;
  if (!agg) return null;
  if (!rules.some((r) => r.kind === agg.setKind && r.role !== "exclude") || !rules.some((r) => r.kind === agg.valueKind)) return null;
  try {
    return agg.run(b, rules).map((x) => `${x.label} ${x.match ? "exact" : `recorded ${x.recorded} (${x.recordedIds} items) vs ${Math.round(x.got)} (${x.gotIds})`}`);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

/** Coverage of each non-set kind by its case rules together (decisions no rule returns a value for). */
export function coverage(b: Bench, rules: Rule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [kind, spec] of Object.entries(b.domain.kinds)) {
    if (spec.combine === "set") continue;
    const fns = orderCases(rules.filter((r) => r.kind === kind)).map((r) => { try { return compileRule(r.code); } catch { return null; } }).filter(Boolean) as ((...a: any[]) => any)[];
    if (!fns.length) continue;
    let n = 0, covered = 0, ok = 0;
    for (const d of b.decisions) {
      if (d.kind !== kind) continue;
      n++;
      let got: unknown;
      try { got = spec.apply ? spec.apply((...a: any[]) => firstValue(fns, a), d, b.ctx) : firstValue(fns, [...d.args, b.ctx]); } catch { got = null; }
      if (got !== null && got !== undefined) covered++;
      if (got !== null && got !== undefined && (typeof got === "number" ? Math.abs(got - Number(d.recorded)) < 0.5 : String(got) === String(d.recorded))) ok++;
    }
    out[kind] = `rules together decide ${covered}/${n}, ${ok}/${n} match what people did`;
  }
  return out;
}

export async function mine(domain: Domain, client: SystemClient, opts: { model?: string; maxSteps?: number; log?: (s: string) => void } = {}): Promise<MineResult & { bench: Bench }> {
  const log = opts.log ?? (() => {});
  const data = await domain.fetchData(client);
  const bench = makeBench(domain, data);
  const saved = new Map<string, Rule>();
  const questions: Question[] = [];
  let summary = "";
  const sandbox = vm.createContext({ data, ctx: bench.ctx, Math, Number, String, Date, JSON, Array, Object, Set, Map, RegExp });

  const counts: Record<string, number> = {};
  for (const d of bench.decisions) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  const aggKinds = new Set([domain.aggregate?.setKind, domain.aggregate?.valueKind].filter(Boolean));

  const handlers: Record<string, (a: any) => Promise<unknown> | unknown> = {
    describe_system: () => domain.describe(data, client),
    api_get: async (a) => {
      const r = await client.get(String(a.path));
      return { status: r.status, body: r.body };
    },
    analyze: (a) => new vm.Script(`(() => { ${a.code} })()`).runInContext(sandbox, { timeout: 5000 }),
    list_decisions: () => Object.entries(domain.kinds).map(([k, v]) => ({ kind: k, count: counts[k] ?? 0, description: v.description, signature: v.signature, returns: v.returns, ...(v.combine ? { combine: v.combine } : {}) })),
    backtest_rule: (a) => {
      const rule: Rule = { id: a.id, title: a.title, kind: a.kind, ...(a.role ? { role: a.role } : {}), code: a.code };
      const out: Record<string, unknown> = summarize(backtestRule(bench, rule, [...saved.values()]));
      if (aggKinds.has(rule.kind)) {
        const replay = aggregateReplay(bench, [...[...saved.values()].filter((r) => r.id !== rule.id), rule]);
        if (replay) out.replay = Array.isArray(replay) && replay.length > 40 ? [`${replay.filter((x) => x.endsWith("exact")).length}/${replay.length} exact`, ...replay.filter((x) => !x.endsWith("exact")).slice(0, 12)] : replay;
      }
      return out;
    },
    save_rule: (a) => {
      const rule: Rule = { id: a.id, title: a.title, short: a.short, evidence: a.evidence, kind: a.kind, ...(a.role ? { role: a.role } : {}), code: a.code };
      const res = backtestRule(bench, rule, [...saved.values()]);
      if (res.error) return { saved: false, error: res.error };
      saved.set(rule.id, { ...rule, fallback: res.applies.n === res.applies.of });
      return { saved: true, ...summarize(res), together: coverage(bench, [...saved.values()]) };
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

  const messages: Msg[] = [{ role: "system", content: system(domain) }, { role: "user", content: "Mine this system. Start with describe_system and list_decisions." }];
  const maxSteps = opts.maxSteps ?? 60;
  let steps = 0;
  const specs = tools(domain);
  for (; steps < maxSteps && !summary; steps++) {
    const reply = await chat(opts.model ?? MODELS.kimi, messages, specs, { maxTokens: 8000 });
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
