/** ERP: GurtAI's NetSuite-style accounts payable (vendors, vendor bills, system notes, payment runs). */
import path from "node:path";
import type { Decision } from "../../mine/data.js";
import { aggregateSet, HELD_OUT_FROM } from "../../mine/backtest.js";
import type { Domain, ReplayCase } from "../types.js";
import { fetchData, makeCtx, openAt, type ErpData } from "./runtime.js";
import { WALTER_DIR } from "../../paths.js";

const month = (iso: string) => iso.slice(0, 7);

export const erp: Domain<ErpData> = {
  id: "erp",
  name: "GurtAI Finance MCP",
  title: "GurtAI's NetSuite-style ERP: accounts payable (vendors, vendor bills, GL accounts), system notes and AP payment runs",
  description: "GurtAI's accounts payable with the finance team's own rules built in. Use these tools to know what gets paid, when, for how much, and how bills are coded.",
  systems: ["GurtAI ERP", "AP payment runs"],
  integrations: [["gurtai-erp.md", "GurtAI ERP", "SuiteTalk REST · read only", "GURTAI_TOKEN"], ["gurtai-ap-runs.md", "AP payment runs", "system notes · run log", "GURTAI_TOKEN"]],
  mdFile: "gurtai-erp.md",
  dir: path.join(WALTER_DIR, "domains", "erp"),
  fetchData, makeCtx,
  ctxHelp: 'ctx.stateAt("vendorbill" | "vendor", id, epochMs) -> fields as of that time, ctx.vendor(vendorId) -> vendor record, ctx.bills / ctx.accounts (Map id -> record), ctx.DAY (ms in a day)',

  kinds: {
    bill_in_run: {
      description: "Every Friday AP runs a payment run. For every vendor bill still open at that moment, did the run pay it?",
      signature: "(bill, runAt, ctx) where bill = current vendorBill record (fields are strings), runAt = epoch ms of the run; use ctx.stateAt('vendorbill', bill.id, runAt) for fields as of the run",
      returns: "true if the bill was paid in that run", unit: "bill-runs", combine: "set",
    },
    run_total: {
      description: "The total a payment run paid, in USD (amount per paid bill, summed).",
      signature: "(bill, runAt, ctx) where bill = current vendorBill record; ctx.stateAt('vendorbill', bill.id, runAt) gives fields just before payment",
      returns: "what the run paid for this bill in USD (number)", unit: "payment runs",
      apply: (fn, d, ctx) => (d.args[0] as string[]).reduce((s, id) => s + Number(fn(ctx.bills.get(id), d.args[1], ctx)), 0),
    },
    gl_account: {
      description: "When AP entered a vendor bill, which GL expense account did they code it to?",
      signature: "(bill, ctx) where bill = { id, entity (vendor id), vendorname, amount, memo, subsidiary, ... }; ctx.vendor(bill.entity) gives the vendor record",
      returns: "account number as a string", unit: "bills",
    },
  },

  decisions(d, ctx): Decision[] {
    const out: Decision[] = [];
    for (const run of d.runs) {
      const runAt = Date.parse(run.run_date);
      const paid = new Set(run.bill_ids);
      for (const b of openAt(d, ctx, runAt)) out.push({ kind: "bill_in_run", month: month(run.run_date), key: `${run.run_date.slice(0, 10)}:${b.id}`, args: [b, runAt], recorded: paid.has(b.id) });
      out.push({ kind: "run_total", month: month(run.run_date), key: run.run_date.slice(0, 10), args: [run.bill_ids, runAt], recorded: run.total_usd });
    }
    const coded = new Map<string, string>();
    for (const n of d.notes) if (n.record === "vendorbill" && n.field === "account" && n.old === null) coded.set(n.id, String(n.new));
    for (const b of d.bills) if (coded.has(b.id)) out.push({ kind: "gl_account", month: month(b.trandate), key: b.id, args: [{ ...b, account: undefined }], recorded: coded.get(b.id) });
    return out;
  },

  async describe(d, c) {
    return {
      endpoints: ["GET /erp/services/rest/record/v1/{vendor|vendorBill|account|subsidiary|employee}?limit&offset&q=field IS value", "GET /erp/services/rest/record/v1/{type}/{id}", "GET /erp/tables", "GET /erp/system_notes?record&field&id&limit&after", "GET /erp/payment_runs"],
      counts: { vendors: d.vendors.length, bills: d.bills.length, notes: d.notes.length, runs: d.runs.length },
      fields: { vendorBill: Object.keys(d.bills[0]!), vendor: Object.keys(d.vendors[0]!) },
      accounts: d.accounts, subsidiaries: d.subsidiaries, users: d.users,
      tables: (await c.get("/erp/tables")).body,
      analyze_data: "data = { vendors, bills, accounts, subsidiaries, users, notes, runs }",
    };
  },

  aggregate: {
    setKind: "bill_in_run", valueKind: "run_total",
    run: (b, rules) => aggregateSet(rules, "bill_in_run", "run_total", b.ctx, b.data.runs.map((run: any) => {
      const runAt = Date.parse(run.run_date);
      return { month: run.run_date.slice(0, 7), label: `payment run ${run.run_date.slice(0, 10)}`, candidates: openAt(b.data, b.ctx, runAt),
        args: (bill: any) => [bill, runAt], recordedIds: run.bill_ids, recorded: run.total_usd, value: (fn: any, bill: any) => Number(fn(bill, runAt, b.ctx)) };
    })),
  },

  tools: [
    { name: "payment_run", sig: "payment_run(run_date)", d: "Which bills a payment run pays, and the total", kinds: ["bill_in_run", "run_total"], task: "Payment run, as AP paid it" },
    { name: "explain_bill", sig: "explain_bill(bill)", d: "Will this bill be paid, and if not why", kinds: ["bill_in_run"] },
    { name: "code_bill", sig: "code_bill(vendor)", d: "The GL account a new bill is coded to", kinds: ["gl_account"], task: "GL coding, as AP entered it" },
    { name: "submit_payment_run", sig: "submit_payment_run(run_date)", d: "Submit the proposed run for release", kinds: ["bill_in_run", "run_total"] },
    { name: "request_cfo_approval", sig: "request_cfo_approval(bills)", d: "Ask the CFO to sign off bills", kinds: ["bill_in_run"] },
  ],

  async replay(mcp, d) {
    const names = new Set(mcp.tools.map((t) => t.name));
    const out: ReplayCase[] = [];
    const push = (c: Omit<ReplayCase, "heldOut">) => out.push({ ...c, heldOut: c.month >= HELD_OUT_FROM });
    if (names.has("payment_run")) {
      for (const run of d.runs) {
        const r = await mcp.call("payment_run", { run_date: run.run_date });
        const ids: string[] = (r.data?.pays?.bills ?? r.data?.bills ?? []).map((b: any) => b.id);
        const exact = r.data?.total_usd === run.total_usd && ids.length === run.bill_ids.length && ids.every((id) => run.bill_ids.includes(id));
        push({ tool: "payment_run", month: run.run_date.slice(0, 7), label: `payment run ${run.run_date.slice(0, 10)}`, expected: run.total_usd, got: r.data?.total_usd ?? r.text.slice(0, 160), ok: exact });
      }
    }
    if (names.has("code_bill")) {
      const coded = new Map<string, string>();
      for (const n of d.notes) if (n.record === "vendorbill" && n.field === "account" && n.old === null) coded.set(n.id, String(n.new));
      const step = Math.max(1, Math.floor(d.bills.length / 60));
      for (let i = 0; i < d.bills.length; i += step) {
        const b = d.bills[i]!;
        const r = await mcp.call("code_bill", { vendor: b.vendorname, amount: Number(b.amount) });
        push({ tool: "code_bill", month: b.trandate.slice(0, 7), label: `${b.vendorname} bill ${b.tranid}`, expected: coded.get(b.id), got: r.data?.account ?? null, ok: r.data?.account === coded.get(b.id) });
      }
    }
    return out;
  },
};
