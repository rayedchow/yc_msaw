// @ts-nocheck
// Finance (AP) MCP tools, spliced into compile/server.template.ts. In scope: server, z, load, rulesOf, cases, ctxDesc, brief, caveatsFor, ok, tracked, META.
import { openAt } from "./src/domain.ts";

const DAY_MS = 86_400_000;
const nextFriday = (t) => { const d = new Date(t); const add = (5 - d.getUTCDay() + 7) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 12); };
const runRules = () => ({ inc: rulesOf("bill_in_run").filter((r) => r.role !== "exclude"), exc: rulesOf("bill_in_run").filter((r) => r.role === "exclude"), value: cases("run_total") });
const billView = (d, b, runAt) => { const s = d.ctx.stateAt("vendorbill", b.id, runAt); return { id: b.id, tranid: b.tranid, vendor: b.vendorname, amount: Number(b.amount), amountremaining: Number(s.amountremaining ?? b.amountremaining), duedate: b.duedate }; };

/** The next run nobody has paid yet: the Friday after the last recorded run (or after today, if later). */
const defaultRunAt = (d) => nextFriday(Math.max(Date.now(), ...d.runs.map((r) => Date.parse(r.run_date) + DAY_MS)));
const readRunDate = (d, run_date) => {
  const t = run_date ? (run_date.length <= 10 ? Date.parse(run_date + "T12:00:00Z") : Date.parse(run_date)) : defaultRunAt(d);
  if (Number.isNaN(t)) throw new Error(`could not read run_date "${run_date}"; pass an ISO date like 2026-11-06`);
  return t;
};
/** Who actually sets a flag, from the system notes (e.g. custbody_22 → "Ana Torres (CFO)"). */
function setterOf(d, field) {
  const counts = {};
  for (const n of d.notes) if (n.field === field && n.new === "T") counts[n.user] = (counts[n.user] ?? 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const u = d.users.find((x) => x.id === top);
  return u ? `${u.name} (${u.role})` : null;
}
/** For a bill no rule pays: which unset sign-off flag, once set, would let a payment rule pay it. */
function unlocksFor(d, b, runAt, inc, exc) {
  const s = d.ctx.stateAt("vendorbill", b.id, runAt);
  const out = [];
  // every sign-off flag on the bill, including ones never set (they have no history yet)
  const flags = new Set([...Object.keys(b), ...Object.keys(s)].filter((k) => /^custbody_/.test(k)));
  for (const f of [...flags].filter((k) => s[k] !== "T")) {
    const ctx2 = { ...d.ctx, stateAt: (r, id, t) => (r === "vendorbill" && id === b.id ? { ...d.ctx.stateAt(r, id, t), [f]: "T" } : d.ctx.stateAt(r, id, t)) };
    const fired = inc.filter((r) => r.fn(b, runAt, ctx2));
    if (fired.length && !exc.some((r) => r.fn(b, runAt, ctx2))) out.push({ field: f, set_by: setterOf(d, f), then_paid_by: fired.map((r) => r.id).join("+") });
  }
  return out;
}
/** A payment run the way GurtAI's AP decides it: what gets paid, what is held back, and what is due but no rule pays. */
function computeRun(d, runAt) {
  const { inc, exc, value } = runRules();
  const pay = [], held = [], unpaid = [];
  for (const b of openAt(d, d.ctx, runAt)) {
    const yes = inc.filter((r) => r.fn(b, runAt, d.ctx)), no = exc.filter((r) => r.fn(b, runAt, d.ctx));
    if (yes.length && !no.length) pay.push({ ...billView(d, b, runAt), pay_usd: value ? Number(value.fn(b, runAt, d.ctx)) : Number(b.amountremaining), paid_by: yes.map((r) => r.id) });
    else if (no.length) { if (yes.length) held.push({ ...billView(d, b, runAt), held_by: no.map((r) => r.id) }); }
    else {
      // due and nothing blocks it, yet no payment rule covers it: say which facts are missing
      const s = d.ctx.stateAt("vendorbill", b.id, runAt);
      unpaid.push({ ...billView(d, b, runAt), facts: { controller_approved: s.custbody_14 === "T", cfo_signoff: s.custbody_22 === "T", on_hold: s.custbody_hold === "T", intercompany: b.subsidiary === "3" },
        unlocks: unlocksFor(d, b, runAt, inc, exc) });
    }
  }
  return { runAt, inc, exc, value, pay, held, unpaid, total: pay.reduce((s, b) => s + b.pay_usd, 0) };
}

/** Compact enough for any agent: one short row per bill, and what the uncovered bills have in common. */
function runSummary(r) {
  const row = (b) => ({ id: b.id, tranid: b.tranid, vendor: b.vendor, amount: b.amountremaining, due: b.duedate });
  // what would release the uncovered bills, grouped: "custbody_22 (set by Ana Torres (CFO)) → paid by F7": 29
  const needs = {};
  for (const b of r.unpaid) { const k = b.unlocks.length ? b.unlocks.map((u) => `${u.field}, set by ${u.set_by ?? "unknown"}, then paid by ${u.then_paid_by}`).join(" or ") : "nothing walter knows of"; (needs[k] ??= []).push(b.tranid); }
  const facts = Object.keys(r.unpaid[0]?.facts ?? {});
  const common = Object.fromEntries(facts.map((k) => [k, [...new Set(r.unpaid.map((b) => b.facts[k]))]]).filter(([, v]) => v.length === 1).map(([k, v]) => [k, v[0]]));
  return {
    run_date: new Date(r.runAt).toISOString().slice(0, 10), currency: "USD", total_usd: r.total,
    pays: { count: r.pay.length, bills: r.pay.map((b) => ({ ...row(b), pay_usd: b.pay_usd, by: b.paid_by.join("+") })) },
    held_back: { count: r.held.length, bills: r.held.map((b) => ({ ...row(b), held_by: b.held_by.join("+") })) },
    due_but_not_covered: { count: r.unpaid.length, all_of_them: common, why: "due, but no payment rule pays them as they stand", ...(r.unpaid.some((b) => b.unlocks.some((u) => u.field === "custbody_22")) ? { action: `request_cfo_approval with run_date ${new Date(r.runAt).toISOString().slice(0, 10)} asks the CFO to sign off all of them that need it` } : {}),
      needs: Object.entries(needs).map(([what, bills]) => ({ what, count: bills.length })), bills: r.unpaid.map(row) },
    rules: [...r.inc, ...r.exc, ...(r.value ? [r.value] : [])].map((x) => `${x.id} ${x.title}`),
    caveats: caveatsFor(["bill_in_run", "run_total"]),
  };
}

if (META.tools.includes("payment_run")) server.tool({
  name: "payment_run",
  description: "The bills GurtAI's AP payment run pays and the total, decided the way the finance team actually runs it (which approvals count, what is held back, what amount is paid), plus bills that are due but that no payment rule covers yet. Runs happen on Fridays; defaults to the next run that has not happened yet. Read-only: use submit_payment_run to submit it." + ctxDesc(["bill_in_run", "run_total"]),
  inputSchema: z.object({ run_date: z.string().optional().describe("ISO date of the run (a Friday); defaults to the next unpaid run") }),
  annotations: { readOnlyHint: true },
}, tracked("payment_run", async ({ run_date }) => {
  const d = await load();
  const r = computeRun(d, readRunDate(d, run_date));
  return ok(runSummary(r));
}));

if (META.tools.includes("explain_bill")) server.tool({
  name: "explain_bill",
  description: "Whether one vendor bill will be paid in a payment run, which GurtAI rule decides it, and what sign-off would release it. For a whole run, payment_run already gives this for every bill, so you rarely need this tool." + ctxDesc(["bill_in_run"]),
  inputSchema: z.object({ bill: z.string().describe("bill internal id or tranid (e.g. BILL-8123)"), run_date: z.string().optional() }),
  annotations: { readOnlyHint: true },
}, tracked("explain_bill", async ({ bill, run_date }) => {
  const d = await load();
  const b = d.bills.find((x) => x.id === bill || String(x.tranid).toLowerCase() === bill.toLowerCase());
  if (!b) throw new Error(`no vendor bill "${bill}"`);
  const runAt = readRunDate(d, run_date);
  const s = d.ctx.stateAt("vendorbill", b.id, runAt);
  if (s.status && s.status !== "open") return ok({ bill: billView(d, b, runAt), will_pay: false, reason: `already ${s.status}` });
  const { inc, exc } = runRules();
  const fired = inc.filter((r) => r.fn(b, runAt, d.ctx)).map(brief), blocked = exc.filter((r) => r.fn(b, runAt, d.ctx)).map(brief);
  return ok({ bill: billView(d, b, runAt), run_date: new Date(runAt).toISOString(), will_pay: fired.length > 0 && blocked.length === 0, qualifies_by: fired, blocked_by: blocked,
    ...(fired.length || blocked.length ? {} : { released_by: unlocksFor(d, b, runAt, inc, exc) }), caveats: caveatsFor(["bill_in_run"]) });
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
