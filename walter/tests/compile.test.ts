import { describe, expect, it } from "vitest";
import { rulesModule, type Knowledge } from "../compile/compile.js";
import { uiEvals, uiMcp } from "../platform/view.js";

const rule = (id: string, kind: any, extra: object = {}) => ({ id, title: `rule ${id}`, short: id.toLowerCase(), kind, code: "(x) => true", train: { n: 10, ok: 10 }, heldOut: { n: 4, ok: 4 }, months: [{ month: "2026-06", n: 10, ok: 10 }, { month: "2026-08", n: 4, ok: 4 }], change: null, ...extra });
const k: Knowledge = {
  mcp: "sales", system: "test", version: 2,
  rules: [rule("R1", "commit_membership", { role: "include" }), rule("R2", "commit_membership", { role: "include", change: { month: "2026-10", agreement: 0.2 } }), rule("R3", "same_company", { status: "retired" })],
  questions: [{ rule_id: "R2", question: "Did it change?", options: ["yes", "no"], evidence: "9 deals" }],
};

describe("compiler and platform views", () => {
  it("embeds shipped rules as real functions and drops retired ones", async () => {
    const src = rulesModule(k);
    expect(src).toContain("fn: (x) => true");
    expect(src).not.toContain('"R3"');
    const mod = await import("data:text/javascript," + encodeURIComponent(src));
    expect(mod.RULES.map((r: any) => r.id)).toEqual(["R1", "R2"]);
    expect(mod.RULES[1].status).toBe("changed");
    expect(mod.RULES[0].fn()).toBe(true);
  });

  it("builds the UI model from knowledge: open question, asked rule, tools from rule kinds", () => {
    const m = uiMcp("sales", k, {}, null, null);
    expect(m.status).toBe("ask");
    expect(m.question?.index).toBe(0);
    expect(m.rules.find((r) => r[0] === "R2")?.[3]).toBe("asked");
    expect(m.tools.map((t) => t[0])).toEqual(["get_commit(quarter, as_of)", "company_rules()", "report_outcome(…)"]);
  });

  it("evals: month strip from backtests, held-out boundary at July 2026", () => {
    const e = uiEvals(k, null)!;
    expect(e.window.months.length).toBe(2);
    expect(e.window.heldOutFrom).toBe(1);
    expect(e.rules.find((r) => r.id === "R2")?.drift).toMatch(/Oct/);
  });
});
