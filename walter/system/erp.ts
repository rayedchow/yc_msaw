/**
 * GurtAI's ERP: a deterministic, simulated NetSuite-style accounts payable system with ~22 months of history.
 *
 * Rules the finance team follows (nowhere in the API; only visible in system notes and payment runs):
 *   payment run   every Friday AP pays open bills that are due within 7 days, approved by the controller in
 *                 custbody_14 ("T"), and not on hold (custbody_hold). The native approvalstatus field is set to
 *                 Approved by a workflow on almost every bill and means nothing. Bills of the intercompany
 *                 subsidiary (3) are never paid in a run; the controller nets them at month end.
 *                 From 2026-09-01, bills over $25,000 also need CFO approval in custbody_22.
 *   amount        a run pays each bill's amountremaining (after vendor credits), not its amount
 *   GL coding     AP codes each bill to the account of its vendor's category, except vendors flagged
 *                 custentity_cogs, which go to 5010 (COGS)
 */
import { DAY, exportPage, iso, mulberry32, NOW, START, type Res } from "./common.js";

export const ERP_USERS = [
  { id: "e-1", name: "Ana Torres", role: "CFO" },
  { id: "e-3", name: "Ben Okafor", role: "AP Specialist" },
  { id: "e-7", name: "Maya Ortiz", role: "Controller" },
  { id: "-4", name: "System", role: "Workflow" },
];
export const SUBSIDIARIES = [
  { id: "1", name: "GurtAI Inc.", country: "US" },
  { id: "2", name: "GurtAI Ltd", country: "GB" },
  { id: "3", name: "GurtAI Intercompany Holdings", country: "US" },
];
export const ACCOUNTS = [
  { id: "5010", acctnumber: "5010", acctname: "COGS - Hosting & Data", accttype: "COGS" },
  { id: "6150", acctnumber: "6150", acctname: "Software Subscriptions", accttype: "Expense" },
  { id: "6200", acctnumber: "6200", acctname: "Contractors", accttype: "Expense" },
  { id: "6400", acctnumber: "6400", acctname: "Travel", accttype: "Expense" },
  { id: "6500", acctnumber: "6500", acctname: "Office & Facilities", accttype: "Expense" },
  { id: "6600", acctnumber: "6600", acctname: "Legal & Professional", accttype: "Expense" },
  { id: "1990", acctnumber: "1990", acctname: "Intercompany Payable", accttype: "OthCurrLiab" },
];
const ACCOUNT_OF: Record<string, string> = { software: "6150", contractors: "6200", travel: "6400", hosting: "5010", office: "6500", legal: "6600", intercompany: "1990" };
const VENDOR_NAMES: [string, string, boolean?][] = [
  ["Atlassian", "software"], ["Slack Technologies", "software"], ["Figma", "software"], ["Notion Labs", "software"], ["Snowpipe Data", "software", true],
  ["Vectorly AI", "software", true], ["Okta", "software"], ["Linear Orbit", "software"], ["DocuSign", "software"], ["Gong.io", "software"],
  ["Northwind Contracting", "contractors"], ["Kestrel Dev Shop", "contractors"], ["Bluefin Design", "contractors"], ["Ironclad Staffing", "contractors"],
  ["Delta Air Lines", "travel"], ["Marriott Bonvoy", "travel"], ["Navan Travel", "travel"], ["Uber for Business", "travel"],
  ["Amazon Web Services", "hosting"], ["Google Cloud", "hosting"], ["Cloudflare", "hosting"], ["Datadog", "hosting"], ["MongoDB Atlas", "hosting"],
  ["WeWork", "office"], ["Staples", "office"], ["Grubhub Corporate", "office"], ["Keystone Facilities", "office"],
  ["Cooley LLP", "legal"], ["Deloitte", "legal"], ["Carta", "legal", true],
  ["GurtAI Ltd (IC)", "intercompany"], ["GurtAI GmbH (IC)", "intercompany"], ["GurtAI KK (IC)", "intercompany"],
];

export type Rec = { id: string; [k: string]: string };
export interface Note { record: "vendorbill" | "vendor"; id: string; field: string; old: string | null; new: string | null; date: string; user: string }
export interface PaymentRun { run_date: string; bill_ids: string[]; total_usd: number; paid_by: string }
export interface ErpWorld { vendors: Rec[]; bills: Rec[]; notes: Note[]; runs: PaymentRun[] }

export const ERP_TRUTH = {
  cfoFrom: "2026-09-01", cfoThreshold: 25_000, dueWithinDays: 7,
  rules: ["custbody_14 is the approval that matters (approvalstatus is noise)", "intercompany subsidiary never paid in a run", "on-hold bills skipped", "pay amountremaining", "GL = vendor category account, COGS-flagged vendors to 5010", "from Sep 2026 bills > $25k need custbody_22"],
};

export function generateErp(seed = 777): ErpWorld {
  const r = mulberry32(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const notes: Note[] = [];
  const note = (record: Note["record"], id: string, field: string, old: string | null, nw: string | null, t: number, user: string) => notes.push({ record, id, field, old, new: nw, date: iso(t), user });

  const vendors: Rec[] = VENDOR_NAMES.map(([name, cat, cogs], i) => {
    const id = String(1100 + i);
    const ic = cat === "intercompany";
    const v: Rec = { id, entityid: `V${id}`, companyname: name, category: cat, subsidiary: ic ? "3" : r() < 0.8 ? "1" : "2", terms: ic ? "Net 30" : pick(["Net 15", "Net 30", "Net 30"]), custentity_cogs: cogs ? "T" : "F", currency: "USD" };
    note("vendor", id, "companyname", null, name, START - 30 * DAY, "e-3");
    if (cogs) note("vendor", id, "custentity_cogs", "F", "T", START - 20 * DAY, "e-7");
    return v;
  });

  // Bills: created through the period; approvals, holds and CFO sign-offs land in system notes.
  type B = Rec & { _t: number; _due: number; _amt: number; _rem: number; _appr: number | null; _hold: [number, number] | null; _cfo: number | null; _v: Rec };
  const bills: B[] = [];
  let n = 0;
  for (let week = START; week < NOW - 3 * DAY; week += 7 * DAY) {
    const count = 13 + Math.floor(r() * 7);
    for (let k = 0; k < count; k++) {
      const v = r() < 0.06 ? pick(vendors.filter((x) => x.category === "intercompany")) : pick(vendors.filter((x) => x.category !== "intercompany"));
      const t = week + Math.floor(r() * 7 * DAY);
      if (t > NOW - DAY) continue;
      const big = r() < 0.32;
      const amt = Math.round(big ? 25_000 + r() * 95_000 : 300 + r() * 22_000);
      const credit = r() < 0.2 ? Math.round(amt * (0.05 + r() * 0.2)) : 0;
      const terms = v.terms === "Net 15" ? 15 : 30;
      const due = Date.parse(iso(t + terms * DAY).slice(0, 10)); // due dates are dates
      const id = String(50_000 + n++);
      const acct = v.custentity_cogs === "T" ? "5010" : ACCOUNT_OF[v.category!]!;
      const b: B = { id, tranid: `BILL-${8000 + n}`, entity: v.id, vendorname: v.companyname!, subsidiary: v.subsidiary!, trandate: iso(t).slice(0, 10), duedate: iso(due).slice(0, 10),
        amount: String(amt), amountremaining: String(amt - credit), account: acct, memo: `${v.companyname} ${pick(["invoice", "monthly", "services", "subscription", "Q" + (1 + Math.floor(r() * 4))])}`,
        status: "open", approvalstatus: "1", custbody_14: "F", custbody_22: "F", custbody_hold: "F",
        _t: t, _due: due, _amt: amt, _rem: amt - credit, _appr: null, _hold: null, _cfo: null, _v: v };
      note("vendorbill", id, "status", null, "open", t, "e-3");
      note("vendorbill", id, "amount", null, String(amt), t, "e-3");
      note("vendorbill", id, "amountremaining", null, String(amt), t, "e-3");
      note("vendorbill", id, "account", null, acct, t + 3_600_000, "e-3");
      // the native workflow approves nearly everything, approved or not
      if (r() < 0.97) { note("vendorbill", id, "approvalstatus", "1", "2", t + 600_000, "-4"); b.approvalstatus = "2"; }
      if (credit) note("vendorbill", id, "amountremaining", String(amt), String(amt - credit), t + 2 * DAY, "e-3");
      // controller approval (the real one)
      if (r() < 0.92) b._appr = t + (1 + Math.floor(r() * 6)) * DAY + 10 * 3_600_000;
      // disputes put a bill on hold for a while
      if (r() < 0.035) { const h0 = t + Math.floor(r() * 5) * DAY; b._hold = [h0, r() < 0.6 ? h0 + (7 + Math.floor(r() * 30)) * DAY : Infinity]; }
      // CFO sign-off: noise before the policy, required for big bills after
      if (big && t > Date.UTC(2026, 7, 10)) { if (r() < 0.55) b._cfo = (b._appr ?? t) + Math.floor(r() * 12) * DAY + 3_600_000; }
      else if (amt > 15_000 && r() < 0.4) b._cfo = t + Math.floor(r() * 9) * DAY;
      bills.push(b);
    }
  }
  for (const b of bills) {
    if (b._appr && b._appr < NOW) { note("vendorbill", b.id, "custbody_14", "F", "T", b._appr, "e-7"); b.custbody_14 = "T"; }
    if (b._hold) {
      note("vendorbill", b.id, "custbody_hold", "F", "T", b._hold[0], "e-3"); b.custbody_hold = "T";
      if (b._hold[1] < NOW) { note("vendorbill", b.id, "custbody_hold", "T", "F", b._hold[1], "e-3"); b.custbody_hold = "F"; }
    }
    if (b._cfo && b._cfo < NOW) { note("vendorbill", b.id, "custbody_22", "F", "T", b._cfo, "e-1"); b.custbody_22 = "T"; }
  }

  // Weekly payment runs (Fridays, noon UTC) and month-end intercompany netting.
  const runs: PaymentRun[] = [];
  const firstFriday = START + ((5 - new Date(START).getUTCDay() + 7) % 7) * DAY + 12 * 3_600_000;
  const paidAt = new Map<string, number>();
  const cfoFrom = Date.parse(ERP_TRUTH.cfoFrom);
  for (let run = firstFriday; run < NOW; run += 7 * DAY) {
    const paid = bills.filter((b) => {
      if (paidAt.has(b.id) || b._t > run || b._v.subsidiary === "3") return false;
      if (!(b._appr && b._appr <= run)) return false;
      if (b._hold && b._hold[0] <= run && run < b._hold[1]) return false;
      if (b._due > run + ERP_TRUTH.dueWithinDays * DAY) return false;
      if (run >= cfoFrom && b._amt > ERP_TRUTH.cfoThreshold && !(b._cfo && b._cfo <= run)) return false;
      return true;
    });
    for (const b of paid) {
      paidAt.set(b.id, run);
      note("vendorbill", b.id, "status", "open", "paidInFull", run + 4 * 3_600_000, "e-3");
      note("vendorbill", b.id, "amountremaining", String(b._rem), "0", run + 4 * 3_600_000, "e-3");
      b.status = "paidInFull"; b.amountremaining = "0";
    }
    runs.push({ run_date: iso(run), bill_ids: paid.map((b) => b.id), total_usd: paid.reduce((s, b) => s + b._rem, 0), paid_by: "e-3" });
  }
  for (let m = 0; ; m++) {
    const end = Date.UTC(2025, m + 1, 1) - 3_600_000;
    if (end > NOW) break;
    for (const b of bills) if (b._v.subsidiary === "3" && b._t < end && !paidAt.has(b.id)) {
      paidAt.set(b.id, end);
      note("vendorbill", b.id, "status", "open", "closed", end, "e-7");
      b.status = "closed";
    }
  }
  notes.sort((a, b) => a.date.localeCompare(b.date));
  const clean = bills.map((b) => Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith("_"))) as Rec);
  return { vendors, bills: clean, notes, runs };
}

const page = (rows: Rec[], q: Record<string, string>) => {
  const limit = Math.max(1, Math.min(Number(q.limit ?? 100), 1000));
  const offset = Number(q.offset ?? 0);
  const items = rows.slice(offset, offset + limit);
  return { links: [], count: items.length, hasMore: offset + items.length < rows.length, offset, totalResults: rows.length, items };
};

export interface Proposal { id: string; run_date: string; bill_ids: string[]; total_usd: number; held: { bill_id: string; reason: string }[]; prepared_by: string; status: "awaiting_approval"; created_at: string }
export interface ApprovalRequest { id: string; bill_id: string; tranid: string; approver: string; reason: string; requested_by: string; status: "pending"; created_at: string }

export class ErpSystem {
  readonly world = generateErp();
  proposals: Proposal[] = [];
  approvals: ApprovalRequest[] = [];
  handle(method: string, p: string, q: Record<string, string>, body?: unknown): Res {
    const b = (body ?? {}) as Record<string, any>;
    // AP writes: a proposed payment run (for the controller to release) and approval requests to the CFO
    if (p === "/erp/payment_runs/proposals") {
      if (method === "GET") return { status: 200, body: { results: this.proposals } };
      if (method === "POST") {
        if (!b.run_date || !Array.isArray(b.bill_ids)) return { status: 400, body: { title: "Invalid proposal", status: 400, "o:errorDetails": [{ detail: "run_date and bill_ids are required" }] } };
        const unknown = b.bill_ids.filter((id: string) => !this.world.bills.some((x) => x.id === id));
        if (unknown.length) return { status: 400, body: { title: "Invalid proposal", status: 400, "o:errorDetails": [{ detail: `unknown bills: ${unknown.join(", ")}` }] } };
        const existing = this.proposals.find((x) => x.run_date.slice(0, 10) === String(b.run_date).slice(0, 10));
        if (existing) return { status: 200, body: existing };
        const prop: Proposal = { id: `PR-${1000 + this.proposals.length + 1}`, run_date: String(b.run_date), bill_ids: b.bill_ids, total_usd: Number(b.total_usd ?? 0), held: b.held ?? [], prepared_by: String(b.prepared_by ?? "agent"), status: "awaiting_approval", created_at: iso(Date.now()) };
        this.proposals.push(prop);
        return { status: 201, body: prop };
      }
    }
    if (p === "/erp/approval_requests") {
      if (method === "GET") return { status: 200, body: { results: this.approvals } };
      if (method === "POST") {
        const bill = this.world.bills.find((x) => x.id === b.bill_id || x.tranid === b.bill_id);
        if (!bill) return { status: 404, body: { title: "Record not found", status: 404, "o:errorDetails": [{ detail: `vendorBill ${b.bill_id} does not exist.` }] } };
        const existing = this.approvals.find((x) => x.bill_id === bill.id && x.approver === String(b.approver ?? "e-1"));
        if (existing) return { status: 200, body: existing };
        const req: ApprovalRequest = { id: `AR-${2000 + this.approvals.length + 1}`, bill_id: bill.id, tranid: bill.tranid!, approver: String(b.approver ?? "e-1"), reason: String(b.reason ?? ""), requested_by: String(b.requested_by ?? "agent"), status: "pending", created_at: iso(Date.now()) };
        this.approvals.push(req);
        return { status: 201, body: req };
      }
    }
    if (method !== "GET") return { status: 405, body: { title: "Method not allowed", status: 405 } };
    const base = "/erp/services/rest/record/v1/";
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/erp\/services\/rest\/record\/v1\/(vendor|vendorBill|account|subsidiary|employee)(?:\/([^/]+))?$/))) {
      const rows: Rec[] = m[1] === "vendor" ? this.world.vendors : m[1] === "vendorBill" ? this.world.bills : m[1] === "account" ? ACCOUNTS as Rec[] : m[1] === "subsidiary" ? SUBSIDIARIES as Rec[] : ERP_USERS as Rec[];
      if (m[2]) {
        const one = rows.find((x) => x.id === m![2]);
        return one ? { status: 200, body: one } : { status: 404, body: { title: "Record not found", status: 404, "o:errorDetails": [{ detail: `${m[1]} ${m[2]} does not exist.` }] } };
      }
      let list = rows;
      // NetSuite-style q filter: field IS value [AND field IS value]
      if (q.q) for (const cond of q.q.split(/\s+AND\s+/i)) {
        const c = /^(\w+)\s+(IS|ANY_OF)\s+"?([^"]*)"?$/i.exec(cond.trim());
        if (!c) return { status: 400, body: { title: "Invalid query", status: 400, "o:errorDetails": [{ detail: `Cannot parse condition: ${cond}` }] } };
        const vals = c[3]!.split(",").map((s) => s.trim().toLowerCase());
        list = list.filter((x) => vals.includes(String(x[c[1]!] ?? "").toLowerCase()));
      }
      return { status: 200, body: page(list, q) };
    }
    if (p === "/erp/system_notes") {
      let rows = this.world.notes;
      if (q.record) rows = rows.filter((x) => x.record === q.record);
      if (q.field) rows = rows.filter((x) => x.field === q.field);
      if (q.id) rows = rows.filter((x) => x.id === q.id);
      return { status: 200, body: exportPage(rows, q, 10_000) };
    }
    if (p === "/erp/payment_runs") return { status: 200, body: exportPage(this.world.runs, q) };
    if (p === "/erp/tables") return { status: 200, body: { tables: [
      { name: "system_notes", columns: ["record", "id", "field", "old", "new", "date", "user"], description: "Every field change on vendor bills and vendors, with who made it" },
      { name: "payment_runs", columns: ["run_date", "bill_ids", "total_usd", "paid_by"], description: "AP payment runs and the bills each one paid" },
    ], records: ["vendor", "vendorBill", "account", "subsidiary", "employee"].map((x) => base + x) } };
    return { status: 404, body: { title: "Not found", status: 404, "o:errorDetails": [{ detail: `No route ${p}` }] } };
  }
}
