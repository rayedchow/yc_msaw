// ERP (accounts payable) data and rule context. Shipped inside the compiled MCP as src/domain.ts.
import { indexHistory, stateAtFrom, type SystemClient } from "../../mine/data.js";

async function records(c: SystemClient, type: string): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await c.get(`/erp/services/rest/record/v1/${type}?limit=1000&offset=${offset}`);
    if (r.status !== 200) throw new Error(`GET ${type} -> ${r.status}`);
    out.push(...r.body.items);
    if (!r.body.hasMore) return out;
  }
}

export async function fetchData(c: SystemClient) {
  const [vendors, bills, accounts, subsidiaries, users, notes, runs] = await Promise.all([
    records(c, "vendor"), records(c, "vendorBill"), records(c, "account"), records(c, "subsidiary"), records(c, "employee"),
    c.all("/erp/system_notes", 10_000), c.all("/erp/payment_runs", 1000),
  ]);
  return { vendors, bills, accounts, subsidiaries, users, notes: notes as { record: string; id: string; field: string; old: string | null; new: string | null; date: string; user: string }[], runs: runs as { run_date: string; bill_ids: string[]; total_usd: number; paid_by: string }[] };
}
export type ErpData = Awaited<ReturnType<typeof fetchData>>;

export function makeCtx(d: ErpData) {
  const idx = indexHistory(d.notes.map((n) => ({ object: n.record, id: n.id, property: n.field, old: n.old, new: n.new, changed_at: n.date, changed_by: n.user })));
  const vendors = new Map(d.vendors.map((v: any) => [v.id, v]));
  return {
    /** record is "vendorbill" | "vendor"; fields as of epoch ms t */
    stateAt: (record: string, id: string, t: number) => stateAtFrom(idx, record, id, t),
    vendor: (id: string) => vendors.get(id) ?? null,
    bills: new Map(d.bills.map((b: any) => [b.id, b])),
    accounts: new Map(d.accounts.map((a: any) => [a.id, a])),
    DAY: 86_400_000,
  };
}

/** Bills still open at a payment run: the candidates the run decides on. */
export function openAt(d: ErpData, ctx: ReturnType<typeof makeCtx>, runAt: number) {
  return d.bills.filter((b: any) => Date.parse(b.trandate) <= runAt && ctx.stateAt("vendorbill", b.id, runAt).status === "open");
}
