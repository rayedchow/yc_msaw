import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SystemClient } from "../mine/data.js";
import { backtestRule, makeBench, type Bench, type Rule } from "../mine/backtest.js";
import { sales } from "../domains/sales/index.js";
import { startSystemServer } from "../system/serve.js";

let s: Awaited<ReturnType<typeof startSystemServer>>;
let b: Bench;
beforeAll(async () => {
  s = await startSystemServer("tk");
  b = makeBench(sales, await sales.fetchData(new SystemClient(s.url, "tk")));
});
afterAll(async () => s.close());

const WON = `["closedwon","8812351","9900003"]`;
const CONTRACT = `["contractsent","8812350"]`;
const booked: Rule = { id: "R1", title: "Closed Won counts only when booked", kind: "commit_membership", role: "include",
  code: `(deal, asOf, ctx) => { const s = ctx.stateAt("deal", deal.id, asOf); return ${WON}.includes(s.dealstage) && s.booked === "true"; }` };
const contract: Rule = { id: "R1b", title: "Contract Sent counts", kind: "commit_membership", role: "include",
  code: `(deal, asOf, ctx) => ${CONTRACT}.includes(ctx.stateAt("deal", deal.id, asOf).dealstage)` };
const sandbox: Rule = { id: "R3", title: "Partner Sandbox never counts", kind: "commit_membership", role: "exclude", code: `(deal) => deal.properties.pipeline === "9900001"` };
const arr: Rule = { id: "R2", title: "Value is arr", kind: "commit_total", code: `(deal) => Number(deal.properties.arr)` };
const amount: Rule = { id: "X", title: "Value is amount", kind: "commit_total", code: `(deal) => Number(deal.properties.amount)` };

describe("sales backtests against GurtAI's history (over the REST API)", () => {
  it("correct commit rules replay every reported month until the October policy change", () => {
    const r = sales.aggregate!.run(b, [booked, contract, sandbox, arr]);
    expect(r.length).toBe(22);
    expect(r.filter((x) => x.month < "2026-10").every((x) => x.match)).toBe(true);
    expect(r.find((x) => x.month === "2026-10")!.match).toBe(false);
  });

  it("the Contract Sent rule is flagged as a change in October; the booked rule is not", () => {
    const c = backtestRule(b, contract, [sandbox]);
    expect(c.train.ok / c.train.n).toBeGreaterThanOrEqual(0.97);
    expect(c.change?.month).toBe("2026-10");
    const bk = backtestRule(b, booked, [sandbox]);
    expect(bk.train.ok).toBe(bk.train.n);
    expect(bk.change).toBeUndefined();
  });

  it("valuing at amount is caught; arr matches every month", () => {
    expect(backtestRule(b, arr).train.ok).toBe(backtestRule(b, arr).train.n);
    const a = backtestRule(b, amount);
    expect(a.train.ok).toBeLessThan(a.train.n / 2);
    expect(a.counterexamples.length).toBeGreaterThan(0);
  });

  it("owner rules: territory explains every new contact; keep-owner explains all but one returning contact", () => {
    const territory: Rule = { id: "R4", title: "territory", kind: "new_contact_owner",
      code: `(c) => ({ "United Kingdom":"201", Germany:"201", France:"201", Netherlands:"201", Norway:"201", Spain:"201", "United States":"202", Canada:"202", Brazil:"202", Mexico:"202", Japan:"203", Australia:"203", Singapore:"203", India:"203" })[c.properties.country]` };
    const t = backtestRule(b, territory);
    expect(t.train.ok + t.heldOut.ok).toBe(t.train.n + t.heldOut.n);
    const keep: Rule = { id: "R5", title: "keep", kind: "returning_contact_owner", code: `(c, before) => before` };
    const k = backtestRule(b, keep);
    expect(k.train.n + k.heldOut.n - (k.train.ok + k.heldOut.ok)).toBe(1);
  });

  it("company identity: root domain explains every merge and every non-merge", () => {
    const r = backtestRule(b, { id: "R6", title: "root", kind: "same_company", code: `(a, b, ctx) => ctx.rootDomain(a) === ctx.rootDomain(b)` });
    expect(r.train.ok + r.heldOut.ok).toBe(r.train.n + r.heldOut.n);
    const naive = backtestRule(b, { id: "X", title: "exact", kind: "same_company", code: `(a, b) => a === b` });
    expect(naive.counterexamples.length).toBeGreaterThan(0);
  });

  it("broken rule code is reported, not thrown", () => {
    expect(backtestRule(b, { id: "E", title: "bad", kind: "same_company", code: "(a, b) => a.nope.x" }).error).toMatch(/runtime/);
    expect(backtestRule(b, { id: "E", title: "bad", kind: "same_company", code: "not js (" }).error).toMatch(/compile/);
  });
});
