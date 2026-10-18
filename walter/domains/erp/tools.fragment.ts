// @ts-nocheck
// Finance (AP) MCP tools, spliced into compile/server.template.ts. In scope: server, z, load, rulesOf, cases, ctxDesc, brief, caveatsFor, ok, tracked, META.
import { openAt } from "./src/domain.ts";

const DAY_MS = 86_400_000;
const nextFriday = (t) => { const d = new Date(t); const add = (5 - d.getUTCDay() + 7) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 12); };
const runRules = () => ({ inc: rulesOf("bill_in_run").filter((r) => r.role !== "exclude"), exc: rulesOf("bill_in_run").filter((r) => r.role === "exclude"), value: cases("run_total") });
const billView = (d, b, runAt) => { const s = d.ctx.stateAt("vendorbill", b.id, runAt); return { id: b.id, tranid: b.tranid, vendor: b.vendorname, amount: Number(b.amount), amountremaining: Number(s.amountremaining ?? b.amountremaining), duedate: b.duedate }; };

if (META.tools.includes("payment_run")) server.tool({
  name: "payment_run",
  description: "The bills GurtAI's AP payment run pays and the total, decided the way the finance team actually runs it (which approvals count, what is held back, what amount is paid). Runs happen on Fridays; defaults to the next run." + ctxDesc(["bill_in_run", "run_total"]),
  inputSchema: z.object({ run_date: z.string().optional().describe("ISO date or datetime of the run (a Friday); defaults to the next Friday") }),
  annotations: { readOnlyHint: true },
}, tracked("payment_run", async ({ run_date }) => {
  const d = await load();
  const runAt = run_date ? (run_date.length <= 10 ? Date.parse(run_date + "T12:00:00Z") : Date.parse(run_date)) : nextFriday(Date.now());
  if (Number.isNaN(runAt)) throw new Error(`could not read run_date "${run_date}"; pass an ISO date like 2026-10-30`);
  const { inc, exc, value } = runRules();
  const pay = [], held = [];
  for (const b of openAt(d, d.ctx, runAt)) {
    const yes = inc.filter((r) => r.fn(b, runAt, d.ctx)), no = exc.filter((r) => r.fn(b, runAt, d.ctx));
    if (yes.length && !no.length) pay.push({ ...billView(d, b, runAt), pay_usd: value ? Number(value.fn(b, runAt, d.ctx)) : Number(b.amountremaining), paid_by: yes.map((r) => r.id) });
    else if (yes.length) held.push({ ...billView(d, b, runAt), held_by: no.map((r) => r.id) });
  }
  return ok({ run_date: new Date(runAt).toISOString(), total_usd: pay.reduce((s, b) => s + b.pay_usd, 0), bill_count: pay.length, held_back: held.length,
    rules_applied: [...inc, ...exc, ...(value ? [value] : [])].map(brief), caveats: caveatsFor(["bill_in_run", "run_total"]), bills: pay, held: held.slice(0, 25) });
}));

if (META.tools.includes("explain_bill")) server.tool({
  name: "explain_bill",
  description: "Whether a vendor bill will be paid in the next payment run, and which GurtAI rule decides it." + ctxDesc(["bill_in_run"]),
  inputSchema: z.object({ bill: z.string().describe("bill internal id or tranid (e.g. BILL-8123)"), run_date: z.string().optional() }),
  annotations: { readOnlyHint: true },
}, tracked("explain_bill", async ({ bill, run_date }) => {
  const d = await load();
  const b = d.bills.find((x) => x.id === bill || String(x.tranid).toLowerCase() === bill.toLowerCase());
  if (!b) throw new Error(`no vendor bill "${bill}"`);
  const runAt = run_date ? Date.parse(run_date.length <= 10 ? run_date + "T12:00:00Z" : run_date) : nextFriday(Date.now());
  const s = d.ctx.stateAt("vendorbill", b.id, runAt);
  if (s.status && s.status !== "open") return ok({ bill: billView(d, b, runAt), will_pay: false, reason: `already ${s.status}` });
  const { inc, exc } = runRules();
  const fired = inc.filter((r) => r.fn(b, runAt, d.ctx)).map(brief), blocked = exc.filter((r) => r.fn(b, runAt, d.ctx)).map(brief);
  return ok({ bill: billView(d, b, runAt), run_date: new Date(runAt).toISOString(), will_pay: fired.length > 0 && blocked.length === 0, qualifies_by: fired, blocked_by: blocked,
    not_yet: fired.length ? [] : inc.map(brief), caveats: caveatsFor(["bill_in_run"]) });
}));

if (META.tools.includes("code_bill")) server.tool({
  name: "code_bill",
  description: "The GL account GurtAI's AP team codes a new bill from this vendor to." + ctxDesc(["gl_account"]),
  inputSchema: z.object({ vendor: z.string().describe("vendor name or id"), amount: z.number().optional(), memo: z.string().optional() }),
  annotations: { readOnlyHint: true },
}, tracked("code_bill", async ({ vendor, amount, memo }) => {
  const d = await load();
  const q = vendor.trim().toLowerCase();
  const v = d.vendors.find((x) => x.id === vendor || String(x.companyname).toLowerCase() === q) ?? d.vendors.find((x) => String(x.companyname).toLowerCase().includes(q));
  if (!v) throw new Error(`no vendor matching "${vendor}". Known vendors: ${d.vendors.map((x) => x.companyname).join(", ")}`);
  const r = cases("gl_account");
  if (!r) throw new Error("no GL coding rule in this version");
  const account = String(r.fn({ id: "new", entity: v.id, vendorname: v.companyname, subsidiary: v.subsidiary, amount: String(amount ?? 0), memo: memo ?? "" }, d.ctx));
  const a = d.ctx.accounts.get(account);
  return ok({ vendor: { id: v.id, name: v.companyname, category: v.category }, account, account_name: a?.acctname ?? null, rule: brief(r), caveats: caveatsFor(["gl_account"]) });
}));
