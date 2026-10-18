/**
 * Deterministic backtests: run a rule's JavaScript against recorded decisions in a node:vm sandbox and score it
 * month by month. Learned months are before HELD_OUT_FROM; later months are held out.
 *
 * A rule is { id, kind, role, code } where code is the source of one JS function whose signature matches its
 * decision kind. For commit_membership, rules combine: a deal counts if any "include" rule says so and no
 * "exclude" rule does. Each rule's own evidence is measured on the decisions it fires on.
 */
import vm from "node:vm";
import { buildDecisions, indexHistory, rootDomain, stateAtFrom, quarterOf, quarterRange, type Dataset, type Decision, type DecisionKind } from "./data.js";

export const HELD_OUT_FROM = "2026-07";

export interface Rule { id: string; title: string; kind: DecisionKind; role?: "include" | "exclude"; code: string; short?: string; evidence?: string }
export interface MonthScore { month: string; n: number; ok: number }
export interface RuleResult {
  id: string; title: string; kind: DecisionKind; role?: string; short?: string;
  train: { n: number; ok: number }; heldOut: { n: number; ok: number }; months: MonthScore[];
  counterexamples: { month: string; key: string; expected: unknown; got: unknown }[];
  change?: { month: string; agreement: number }; error?: string;
}

export function compileRule(code: string): (...args: any[]) => any {
  const ctx = vm.createContext({ Math, Number, String, Date, JSON, Array, Object, Set, Map, RegExp, parseInt, parseFloat, isNaN });
  const fn = new vm.Script(`(${code})`, { filename: "rule.js" }).runInContext(ctx, { timeout: 1000 });
  if (typeof fn !== "function") throw new Error("rule code must evaluate to a function");
  return (...args: any[]) => fn(...args);
}

export interface Bench { ds: Dataset; decisions: Decision[]; ctx: RuleCtx }
export interface RuleCtx { stateAt(object: string, id: string, t: number): Record<string, string>; quarterOf: typeof quarterOf; quarterRange: typeof quarterRange; rootDomain: typeof rootDomain; deals: Map<string, any>; companies: Map<string, any> }

export function makeBench(ds: Dataset): Bench {
  const idx = indexHistory(ds.history);
  const ctx: RuleCtx = {
    stateAt: (object, id, t) => stateAtFrom(idx, object, id, t), quarterOf, quarterRange, rootDomain,
    deals: new Map(ds.deals.map((d) => [d.id, d])), companies: new Map(ds.companies.map((c) => [c.id, c])),
  };
  return { ds, decisions: buildDecisions(ds), ctx };
}

const same = (a: unknown, b: unknown) => (typeof a === "number" || typeof b === "number" ? Math.abs(Number(a) - Number(b)) < 0.5 : String(a) === String(b));

function predict(rule: Rule, fn: (...a: any[]) => any, d: Decision, ctx: RuleCtx): unknown {
  switch (rule.kind) {
    case "commit_membership": return Boolean(fn(d.input.deal, d.input.asOf, ctx));
    case "commit_total": return d.input.members.reduce((s: number, id: string) => s + Number(fn(ctx.deals.get(id), ctx)), 0);
    case "new_contact_owner": return String(fn(d.input.contact, ctx));
    case "returning_contact_owner": return String(fn(d.input.contact, d.input.ownerBefore, ctx));
    case "same_company": return Boolean(fn(d.input.a, d.input.b, ctx));
  }
}

/** Score one rule on its own. include/exclude membership rules are scored on the decisions where they fire. */
export function backtestRule(b: Bench, rule: Rule, others: Rule[] = []): RuleResult {
  const res: RuleResult = { id: rule.id, title: rule.title, kind: rule.kind, ...(rule.role ? { role: rule.role } : {}), ...(rule.short ? { short: rule.short } : {}), train: { n: 0, ok: 0 }, heldOut: { n: 0, ok: 0 }, months: [], counterexamples: [] };
  let fn: (...a: any[]) => any;
  try {
    fn = compileRule(rule.code);
  } catch (e) {
    return { ...res, error: `compile: ${(e as Error).message}` };
  }
  const months = new Map<string, MonthScore>();
  // An include rule is judged only on deals that no exclude rule already explains (rules combine).
  const excluders = rule.kind === "commit_membership" && rule.role === "include"
    ? others.filter((o) => o.kind === "commit_membership" && o.role === "exclude" && o.id !== rule.id).map((o) => { try { return compileRule(o.code); } catch { return null; } }).filter((f): f is (...a: any[]) => any => !!f)
    : [];
  try {
    for (const d of b.decisions) {
      if (d.kind !== rule.kind) continue;
      let expected = d.recorded, got = predict(rule, fn, d, b.ctx);
      if (rule.kind === "commit_membership" && rule.role) {
        if (!got) continue; // the rule does not fire on this deal: no evidence either way
        if (excluders.some((x) => x(d.input.deal, d.input.asOf, b.ctx))) continue;
        expected = rule.role === "include" ? d.recorded : !d.recorded;
        got = true;
      }
      const ok = same(expected, got);
      const m = months.get(d.month) ?? { month: d.month, n: 0, ok: 0 };
      m.n++; if (ok) m.ok++;
      months.set(d.month, m);
      const bucket = d.month >= HELD_OUT_FROM ? res.heldOut : res.train;
      bucket.n++; if (ok) bucket.ok++;
      if (!ok && res.counterexamples.length < 25) res.counterexamples.push({ month: d.month, key: d.key, expected, got });
    }
  } catch (e) {
    return { ...res, error: `runtime: ${(e as Error).message}` };
  }
  res.months = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const trainRate = res.train.n ? res.train.ok / res.train.n : 0;
  for (const m of res.months) {
    if (m.month < HELD_OUT_FROM || m.n === 0) continue;
    if (trainRate >= 0.97 && m.ok / m.n < 0.9) { res.change = { month: m.month, agreement: m.ok / m.n }; break; }
  }
  return res;
}

/** Combine include/exclude membership rules + a value rule and replay each month's reported commit exactly. */
export function replayCommit(b: Bench, rules: Rule[]): { month: string; quarter: string; recorded: number; got: number; recordedIds: number; gotIds: number; match: boolean }[] {
  const inc = rules.filter((r) => r.kind === "commit_membership" && r.role !== "exclude").map((r) => compileRule(r.code));
  const exc = rules.filter((r) => r.kind === "commit_membership" && r.role === "exclude").map((r) => compileRule(r.code));
  const valueRule = rules.find((r) => r.kind === "commit_total");
  const value = valueRule ? compileRule(valueRule.code) : (d: any) => Number(d.properties.amount);
  return b.ds.snapshots.map((s) => {
    const asOf = Date.parse(s.as_of);
    const q = quarterOf(asOf);
    const ids = b.ds.deals.filter((d) => {
      const c = Date.parse(String(d.properties.closedate));
      if (c < q.start || c > q.end) return false;
      return inc.some((f) => f(d, asOf, b.ctx)) && !exc.some((f) => f(d, asOf, b.ctx));
    });
    const got = ids.reduce((sum, d) => sum + Number(value(d, b.ctx)), 0);
    const exact = got === s.reported_commit_usd && ids.length === s.deal_ids.length && ids.every((d) => s.deal_ids.includes(d.id));
    return { month: s.as_of.slice(0, 7), quarter: s.quarter, recorded: s.reported_commit_usd, got, recordedIds: s.deal_ids.length, gotIds: ids.length, match: exact };
  });
}
