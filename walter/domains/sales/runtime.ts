// Sales (CRM) data and rule context. Shipped inside the compiled MCP as src/domain.ts.
import { indexHistory, quarterOf, quarterRange, rootDomain, stateAtFrom, type SystemClient } from "../../mine/data.js";

export async function fetchData(c: SystemClient) {
  const [deals, contacts, companies, history, snaps, pipelines, owners, orders] = await Promise.all([
    c.all("/crm/v3/objects/deals"), c.all("/crm/v3/objects/contacts"), c.all("/crm/v3/objects/companies"),
    c.all("/warehouse/field_history", 5000), c.get("/warehouse/forecast_snapshots"), c.get("/crm/v3/pipelines/deals"), c.get("/crm/v3/owners"),
    c.get("/mail/export/orders"),
  ]);
  // Values the system actually uses; tools refuse anything else instead of guessing.
  const countries = [...new Set(contacts.map((x: any) => x.properties.country).filter(Boolean))].sort() as string[];
  return { deals, contacts, companies, history, snapshots: snaps.body.results as { as_of: string; quarter: string; reported_commit_usd: number; deal_ids: string[] }[], pipelines: pipelines.body.results, owners: owners.body.results as any[], countries,
    orders: (orders.body?.results ?? []) as { id: string; from: string; to: string; subject: string; body: string; received_at: string; labels: string[]; logged_deal?: string }[] };
}
export type SalesData = Awaited<ReturnType<typeof fetchData>>;

export function makeCtx(d: SalesData) {
  const idx = indexHistory(d.history);
  const at = (x: any) => Date.parse(x.properties.createdate);
  return {
    stateAt: (object: string, id: string, t: number) => stateAtFrom(idx, object, id, t), quarterOf, quarterRange, rootDomain, parseOrder,
    deals: new Map(d.deals.map((x: any) => [x.id, x])), companies: new Map(d.companies.map((x: any) => [x.id, x])), contacts: new Map(d.contacts.map((x: any) => [x.id, x])),
    /** records that existed at time t (by createdate) */
    companiesAt: (t: number) => d.companies.filter((x: any) => at(x) <= t), contactsAt: (t: number) => d.contacts.filter((x: any) => at(x) <= t), dealsAt: (t: number) => d.deals.filter((x: any) => at(x) <= t),
  };
}

/** What a rule sees of an order email: the message as it arrived. */
export const asReceivedOrder = (o: SalesData["orders"][number]) => ({ id: o.id, from: o.from, subject: o.subject, body: o.body, received_at: o.received_at });

/** Fields printed on every GurtAI order form (format, not tribal knowledge). */
export function parseOrder(o: { from: string; subject: string; body: string; received_at: string }) {
  const f = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "mi").exec(o.body)?.[1]?.trim() ?? null;
  const money = (s: string | null) => (s ? Number(s.replace(/[^0-9.]/g, "")) : 0);
  const cust = /^(.*)\s+\(([^)]+)\)$/.exec(f("Customer") ?? "");
  return {
    customer: cust?.[1] ?? f("Customer"), country: cust?.[2] ?? null, plan: f("Plan"), seats: Number(f("Seats") ?? 0),
    onboarding: money(f("One-time onboarding")), total: money(f("Total due")), po: f("PO number"),
    kind: /renewal/i.test(o.subject) ? "renewal" : /expansion/i.test(o.subject) ? "expansion" : "new",
    email: o.from.toLowerCase(), domain: o.from.toLowerCase().split("@")[1] ?? "", received_at: o.received_at,
  };
}
