// Sales (CRM) data and rule context. Shipped inside the compiled MCP as src/domain.ts.
import { indexHistory, quarterOf, quarterRange, rootDomain, stateAtFrom, type SystemClient } from "../../mine/data.js";

export async function fetchData(c: SystemClient) {
  const [deals, contacts, companies, history, snaps, pipelines, owners] = await Promise.all([
    c.all("/crm/v3/objects/deals"), c.all("/crm/v3/objects/contacts"), c.all("/crm/v3/objects/companies"),
    c.all("/warehouse/field_history", 5000), c.get("/warehouse/forecast_snapshots"), c.get("/crm/v3/pipelines/deals"), c.get("/crm/v3/owners"),
  ]);
  // Values the system actually uses; tools refuse anything else instead of guessing.
  const countries = [...new Set(contacts.map((x: any) => x.properties.country).filter(Boolean))].sort() as string[];
  return { deals, contacts, companies, history, snapshots: snaps.body.results as { as_of: string; quarter: string; reported_commit_usd: number; deal_ids: string[] }[], pipelines: pipelines.body.results, owners: owners.body.results as any[], countries };
}
export type SalesData = Awaited<ReturnType<typeof fetchData>>;

export function makeCtx(d: SalesData) {
  const idx = indexHistory(d.history);
  return {
    stateAt: (object: string, id: string, t: number) => stateAtFrom(idx, object, id, t), quarterOf, quarterRange, rootDomain,
    deals: new Map(d.deals.map((x: any) => [x.id, x])), companies: new Map(d.companies.map((x: any) => [x.id, x])),
  };
}
