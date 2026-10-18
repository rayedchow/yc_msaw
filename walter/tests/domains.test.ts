import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SystemClient } from "../mine/data.js";
import { backtestRule, makeBench, type Bench, type Rule } from "../mine/backtest.js";
import { erp } from "../domains/erp/index.js";
import { mail } from "../domains/mail/index.js";
import { startSystemServer } from "../system/serve.js";

let s: Awaited<ReturnType<typeof startSystemServer>>;
let fin: Bench, inbox: Bench;
beforeAll(async () => {
  s = await startSystemServer("tk");
  const c = new SystemClient(s.url, "tk");
  fin = makeBench(erp, await erp.fetchData(c));
  inbox = makeBench(mail, await mail.fetchData(c));
});
afterAll(async () => s.close());
const all = (r: ReturnType<typeof backtestRule>) => [r.train.ok + r.heldOut.ok, r.train.n + r.heldOut.n];

// The finance team's actual rules, as code (what a good miner should find).
const approvedDue: Rule = { id: "F1", title: "controller-approved and due within 7 days", kind: "bill_in_run", role: "include",
  code: `(bill, runAt, ctx) => { const s = ctx.stateAt("vendorbill", bill.id, runAt); return s.custbody_14 === "T" && Date.parse(bill.duedate) <= runAt + 7 * ctx.DAY; }` };
const hold: Rule = { id: "F2", title: "on hold", kind: "bill_in_run", role: "exclude", code: `(bill, runAt, ctx) => ctx.stateAt("vendorbill", bill.id, runAt).custbody_hold === "T"` };
const ic: Rule = { id: "F3", title: "intercompany", kind: "bill_in_run", role: "exclude", code: `(bill) => bill.subsidiary === "3"` };
const remaining: Rule = { id: "F4", title: "pay amountremaining", kind: "run_total", code: `(bill, runAt, ctx) => Number(ctx.stateAt("vendorbill", bill.id, runAt).amountremaining)` };
const cfo: Rule = { id: "F5", title: "big bills need CFO from Sep", kind: "bill_in_run", role: "exclude",
  code: `(bill, runAt, ctx) => runAt >= Date.UTC(2026, 8, 1) && Number(bill.amount) > 25000 && ctx.stateAt("vendorbill", bill.id, runAt).custbody_22 !== "T"` };
const gl: Rule = { id: "F6", title: "GL by category, COGS vendors 5010", kind: "gl_account",
  code: `(bill, ctx) => { const v = ctx.vendor(bill.entity); if (v.custentity_cogs === "T") return "5010"; return ({ software: "6150", contractors: "6200", travel: "6400", hosting: "5010", office: "6500", legal: "6600", intercompany: "1990" })[v.category]; }` };

describe("ERP: the finance team's rules are in the history", () => {
  it("payment runs replay exactly with the real rules until September; the CFO rule fixes September on", () => {
    const before = erp.aggregate!.run(fin, [approvedDue, hold, ic, remaining]);
    expect(before.length).toBeGreaterThan(90);
    expect(before.filter((x) => x.month < "2026-09").every((x) => x.match)).toBe(true);
    expect(before.filter((x) => x.month >= "2026-09").some((x) => !x.match)).toBe(true);
    expect(erp.aggregate!.run(fin, [approvedDue, hold, ic, remaining, cfo]).every((x) => x.match)).toBe(true);
  });

  it("the include rule is flagged as a change in September; approvalstatus (the obvious field) does not explain runs", () => {
    const r = backtestRule(fin, approvedDue, [hold, ic]);
    expect(r.train.ok).toBe(r.train.n);
    expect(r.change?.month).toBe("2026-09");
    const naive = backtestRule(fin, { ...approvedDue, id: "X", code: `(bill, runAt, ctx) => ctx.stateAt("vendorbill", bill.id, runAt).approvalstatus === "2" && Date.parse(bill.duedate) <= runAt + 7 * ctx.DAY` }, [hold, ic]);
    expect(naive.train.ok / naive.train.n).toBeLessThan(0.97);
  });

  it("GL coding: category map with the COGS override explains every bill; category alone does not", () => {
    const [ok, n] = all(backtestRule(fin, gl));
    expect(ok).toBe(n);
    const plain = backtestRule(fin, { ...gl, id: "Y", code: `(bill, ctx) => ({ software: "6150", contractors: "6200", travel: "6400", hosting: "5010", office: "6500", legal: "6600", intercompany: "1990" })[ctx.vendor(bill.entity).category]` });
    expect(plain.counterexamples.length).toBeGreaterThan(0);
  });
});

const label: Rule = { id: "M1", title: "automated first, then billing keywords", kind: "thread_label",
  code: `(t, ctx) => /^(noreply|no-reply|notifications|alerts|mailer-daemon)$/.test(ctx.localOf(t.from)) ? "Automated" : /invoice|refund|receipt|charge|billing/i.test(t.subject) ? "Billing" : "Support"` };
const eu = `[".de", ".fr", ".nl", ".es", ".it", ".se", ".co.uk", ".ie"]`;
const assignee = (omar: boolean): Rule => ({ id: "M2", title: "assignee", kind: "thread_assignee",
  code: `(t, ctx) => { const auto = /^(noreply|no-reply|notifications|alerts|mailer-daemon)$/.test(ctx.localOf(t.from)); if (auto) return "none";
    if (/invoice|refund|receipt|charge|billing/i.test(t.subject)) return ${omar ? `Date.parse(t.received_at) >= Date.UTC(2026, 7, 1) ? "omar@gurtai.example" : ` : ""}"dana@gurtai.example";
    return ${eu}.some((x) => ctx.domainOf(t.from).endsWith(x)) ? "lena@gurtai.example" : "sam@gurtai.example"; }` });

describe("Mail: the support team's triage rules are in the history", () => {
  it("label rule (automated before billing keywords) explains every thread; keywords alone do not", () => {
    const [ok, n] = all(backtestRule(inbox, label));
    expect(ok).toBe(n);
    const naive = backtestRule(inbox, { ...label, id: "X", code: `(t) => /invoice|refund|receipt|charge|billing/i.test(t.subject) ? "Billing" : "Support"` });
    expect(naive.counterexamples.length).toBeGreaterThan(0);
  });

  it("assignee: the pre-August rule breaks in August (Omar takes billing); the dated rule explains everything", () => {
    const old = backtestRule(inbox, assignee(false));
    expect(old.train.ok).toBe(old.train.n);
    expect(old.change?.month).toBe("2026-08");
    const [ok, n] = all(backtestRule(inbox, assignee(true)));
    expect(ok).toBe(n);
  });
});
