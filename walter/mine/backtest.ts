/**
 * Deterministic backtests: run a rule's JavaScript against recorded decisions in a node:vm sandbox and score it
 * month by month. Learned months are before HELD_OUT_FROM; later months are held out.
 *
 * A rule is { id, kind, role, code } where code is the source of one JS function called as fn(...decision.args, ctx).
 * For "set" kinds, rules combine: an item is in if any "include" rule says so and no "exclude" rule does. For other
 * kinds, rules are cases: a rule returns null where it does not apply, the first rule that returns a value decides, and
 * a rule that applies everywhere is the fallback. Either way a rule's evidence is measured where it applies.
 */
import vm from "node:vm";
import type { Decision } from "./data.js";
import type { AggregateRow, Domain } from "../domains/types.js";

export const HELD_OUT_FROM = "2026-07";

export interface Rule { id: string; title: string; kind: string; role?: "include" | "exclude"; code: string; short?: string; evidence?: string; fallback?: boolean }
export interface MonthScore { month: string; n: number; ok: number }
export interface RuleResult {
  id: string; title: string; kind: string; role?: string; short?: string;
  train: { n: number; ok: number }; heldOut: { n: number; ok: number }; months: MonthScore[];
  counterexamples: { month: string; key: string; expected: unknown; got: unknown }[];
  change?: { month: string; agreement: number }; error?: string;
  /** decisions of this kind the rule applies to (fires on, or returns a value for), out of all of them */
  applies: { n: number; of: number };
}

export function compileRule(code: string): (...args: any[]) => any {
  const ctx = vm.createContext({ Math, Number, String, Date, JSON, Array, Object, Set, Map, RegExp, parseInt, parseFloat, isNaN });
  const fn = new vm.Script(`(${code})`, { filename: "rule.js" }).runInContext(ctx, { timeout: 1000 });
  if (typeof fn !== "function") throw new Error("rule code must evaluate to a function");
  return (...args: any[]) => fn(...args);
}

export interface Bench { domain: Domain; data: any; decisions: Decision[]; ctx: any }

export function makeBench(domain: Domain, data: unknown): Bench {
  const ctx = domain.makeCtx(data);
  return { domain, data, decisions: domain.decisions(data, ctx), ctx };
}

const same = (a: unknown, b: unknown) => (typeof a === "number" || typeof b === "number" ? Math.abs(Number(a) - Number(b)) < 0.5 : String(a) === String(b));

/** Score one rule on its own. Set-kind rules with a role are scored on the decisions where they fire. */
export function backtestRule(b: Bench, rule: Rule, others: Rule[] = []): RuleResult {
  const res: RuleResult = { id: rule.id, title: rule.title, kind: rule.kind, ...(rule.role ? { role: rule.role } : {}), ...(rule.short ? { short: rule.short } : {}), train: { n: 0, ok: 0 }, heldOut: { n: 0, ok: 0 }, months: [], counterexamples: [], applies: { n: 0, of: 0 } };
  const spec = b.domain.kinds[rule.kind];
  if (!spec) return { ...res, error: `unknown decision kind ${rule.kind}` };
  let fn: (...a: any[]) => any;
  try {
    fn = compileRule(rule.code);
  } catch (e) {
    return { ...res, error: `compile: ${(e as Error).message}` };
  }
  const set = spec.combine === "set" && !!rule.role;
  // An include rule is judged only on items that no exclude rule already explains (rules combine).
  const excluders = set && rule.role === "include"
    ? others.filter((o) => o.kind === rule.kind && o.role === "exclude" && o.id !== rule.id).map((o) => { try { return compileRule(o.code); } catch { return null; } }).filter((f): f is (...a: any[]) => any => !!f)
    : [];
  // A case rule is judged where it decides: decisions an earlier case rule of the same kind already decides are skipped.
  const sameKind = others.filter((o) => o.kind === rule.kind).map((o) => (o.id === rule.id ? rule : o));
  const ordered = set ? [] : orderCases(sameKind.some((o) => o.id === rule.id) ? sameKind : [...sameKind, rule]);
  const earlier = ordered.slice(0, ordered.findIndex((o) => o.id === rule.id)).map((o) => { try { return compileRule(o.code); } catch { return null; } }).filter((f): f is (...a: any[]) => any => !!f);
  const months = new Map<string, MonthScore>();
  try {
    for (const d of b.decisions) {
      if (d.kind !== rule.kind) continue;
      res.applies.of++;
      let expected = d.recorded, got: unknown;
      if (set) {
        if (!fn(...d.args, b.ctx)) continue; // the rule does not fire here: no evidence either way
        if (excluders.some((x) => x(...d.args, b.ctx))) continue;
        expected = rule.role === "include" ? d.recorded : !d.recorded;
        got = true;
      } else {
        got = spec.apply ? spec.apply(fn, d, b.ctx) : fn(...d.args, b.ctx);
        if (spec.combine === "set") got = Boolean(got);
        else if (got === null || got === undefined) continue; // a case rule that does not apply here
        else if (!spec.apply && earlier.some((f) => { const v = f(...d.args, b.ctx); return v !== null && v !== undefined; })) { res.applies.n++; continue; }
      }
      res.applies.n++;
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

/**
 * Replay a recorded aggregate exactly (a reported commit, a payment run): candidates are in when an include rule
 * fires and no exclude rule does; the value rule gives each member's amount.
 */
export function aggregateSet(rules: { kind: string; role?: string; code: string; fallback?: boolean }[], setKind: string, valueKind: string, ctx: any,
  units: { month: string; label: string; candidates: { id: string }[]; args: (item: any) => unknown[]; recordedIds: string[]; recorded: number; value: (fn: (...a: any[]) => any, item: any) => number }[]): AggregateRow[] {
  const inc = rules.filter((r) => r.kind === setKind && r.role !== "exclude").map((r) => compileRule(r.code));
  const exc = rules.filter((r) => r.kind === setKind && r.role === "exclude").map((r) => compileRule(r.code));
  const valueFns = orderCases(rules.filter((r) => r.kind === valueKind)).map((r) => compileRule(r.code));
  const value = valueFns.length ? (...a: any[]) => firstValue(valueFns, a) : null;
  return units.map((u) => {
    const ids = u.candidates.filter((c) => inc.some((f) => f(...u.args(c), ctx)) && !exc.some((f) => f(...u.args(c), ctx)));
    const got = value ? ids.reduce((s, c) => s + u.value(value, c), 0) : NaN;
    const exact = Math.abs(got - u.recorded) < 0.5 && ids.length === u.recordedIds.length && ids.every((c) => u.recordedIds.includes(c.id));
    return { month: u.month, label: u.label, recorded: u.recorded, got, recordedIds: u.recordedIds.length, gotIds: ids.length, match: exact };
  });
}

/** Case rules in decision order: fallbacks (rules that apply to every decision) go last. */
export function orderCases<T extends { fallback?: boolean }>(rules: T[]): T[] {
  return [...rules.filter((r) => !r.fallback), ...rules.filter((r) => r.fallback)];
}
export function firstValue(fns: ((...a: any[]) => any)[], args: unknown[]): any {
  for (const f of fns) {
    const v = f(...args);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}
