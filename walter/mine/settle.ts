/**
 * Settling a question: a human picked an answer. A Fireworks model revises the affected rule (or confirms or retires
 * it) in light of the answer and the history; the host backtests the revision and only keeps it if it holds.
 */
import { chat, MODELS } from "../llm.js";
import { backtestRule, type Bench, type Rule } from "./backtest.js";
import { summarize } from "./miner.js";
import type { Knowledge, KnowledgeRule } from "../compile/compile.js";

export interface Settlement { action: "revise" | "confirm" | "retire"; rule: KnowledgeRule; note: string; attempts: number }

const PROMPT = `You maintain one company rule that walter mined from a business system's history. A human just answered an
open question about it. Decide what the answer means for the rule and reply with JSON only:
{"action": "revise" | "confirm" | "retire", "code": "<new JS arrow function if revise>", "title": "<plain-English title>", "short": "<2-3 words>", "note": "<one sentence for the changelog>"}
- revise: the rule's behaviour must change (e.g. it only held until a date, or an exception becomes part of the rule).
  Keep the same function signature. Dates are epoch ms; use Date.UTC(...). ctx helpers are listed in the input.
- confirm: the rule is right as is; the cases it misses are exceptions.
- retire: the rule is wrong and should not ship.`;

export async function settle(bench: Bench, k: Knowledge, qIndex: number, answer: string, opts: { model?: string } = {}): Promise<Settlement> {
  const q = k.questions[qIndex]!;
  const rule = k.rules.find((r) => r.id === q.rule_id);
  if (!rule) throw new Error(`question ${qIndex} refers to unknown rule ${q.rule_id}`);
  const others = k.rules.filter((r) => r.id !== rule.id && r.status !== "retired") as Rule[];
  const before = summarize(backtestRule(bench, rule, others));
  let feedback = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const reply = await chat(opts.model ?? MODELS.kimi, [
      { role: "system", content: PROMPT },
      { role: "user", content: JSON.stringify({ rule: { id: rule.id, kind: rule.kind, role: rule.role, title: rule.title, code: rule.code }, decision_kind: bench.domain.kinds[rule.kind], ctx_helpers: bench.domain.ctxHelp, backtest: before, question: q.question, evidence: q.evidence, answer }) + feedback },
    ], [], { maxTokens: 3000, temperature: 0 });
    const text = String(reply.content ?? "").replace(/^```(json)?|```$/gm, "").trim();
    let j: { action: Settlement["action"]; code?: string; title?: string; short?: string; note?: string };
    try { j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { feedback = "\n\nYour last reply was not valid JSON. Reply with JSON only."; continue; }
    if (j.action !== "revise") {
      return { action: j.action === "retire" ? "retire" : "confirm", rule: { ...rule, status: j.action === "retire" ? "retired" : "confirmed" }, note: j.note ?? "", attempts: attempt };
    }
    const revised: Rule = { ...rule, code: String(j.code ?? ""), title: j.title ?? rule.title, short: j.short && j.short.length <= 18 ? j.short : rule.short };
    const res = backtestRule(bench, revised, others);
    const all = res.train.n + res.heldOut.n, ok = res.train.ok + res.heldOut.ok;
    const agg = bench.domain.aggregate;
    const replay = agg && (rule.kind === agg.setKind || rule.kind === agg.valueKind) ? safeReplay(bench, [...others, revised]) : null;
    if (!res.error && all && ok / all >= 0.97 && !res.change && (!replay || replay.every((x) => x.match))) {
      return { action: "revise", rule: { ...rule, ...revised, train: res.train, heldOut: res.heldOut, months: res.months, change: null, status: "confirmed", counterexamples: res.counterexamples.slice(0, 10) } as KnowledgeRule, note: j.note ?? "", attempts: attempt };
    }
    feedback = `\n\nYour revision did not hold on history: ${JSON.stringify({ ...summarize(res), ...(replay ? { replay: replay.filter((x) => !x.match).slice(0, 12).map((x) => `${x.label}: recorded ${x.recorded} vs ${Math.round(x.got)}`) } : {}) })}. Fix it.`;
  }
  throw new Error(`could not settle ${rule.id}: no revision held on history`);
}

function safeReplay(b: Bench, rules: Rule[]) {
  try { return b.domain.aggregate!.run(b, rules); } catch { return null; }
}
