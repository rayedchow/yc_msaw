/**
 * Check what an agent wrote for the pending orders against what GurtAI's RevOps would have done (the simulator's
 * planted habits, evaluated as of each order's arrival). Read-only.
 *
 *   npx tsx walter/scripts/verify-orders.ts
 */
import { SystemClient } from "../mine/data.js";
import { sales } from "../domains/sales/index.js";
import { asReceivedOrder } from "../domains/sales/runtime.js";
import { compileRule } from "../mine/backtest.js";
import { loadState } from "../state.js";

const st = await loadState();
const c = new SystemClient(st.system!.url!, st.system!.token!);
const data = await sales.fetchData(c);
const ctx = sales.makeCtx(data);
const TERR: Record<string, string> = { "United Kingdom": "201", Germany: "201", France: "201", Netherlands: "201", Norway: "201", Spain: "201", "United States": "202", Canada: "202", Brazil: "202", Mexico: "202", Japan: "203", Australia: "203", Singapore: "203", India: "203" };
const company = compileRule(`(o, ctx) => { const t = Date.parse(o.received_at), p = ctx.parseOrder(o); const co = ctx.companiesAt(t).find((c) => !c.properties.merged_into && ctx.rootDomain(c.properties.domain) === p.domain); return co ? co.id : "new"; }`);
const target = compileRule(`(o, ctx, coId) => { const t = Date.parse(o.received_at); if (coId === "new") return "new"; const d = ctx.dealsAt(t).filter((d) => d.properties.company_id === coId && ["contractsent", "8812350", "9900002"].includes(ctx.stateAt("deal", d.id, t).dealstage)).sort((a, b) => a.properties.createdate.localeCompare(b.properties.createdate)).pop(); return d ? d.id : "new"; }`);

const agentEvents = data.history.filter((h: any) => String(h.changed_by).startsWith("api:"));
const pending = data.orders.filter((o) => o.received_at >= "2026-10-29");
let bad = 0;
for (const o of pending) {
  const p = ctx.parseOrder(o), msg = asReceivedOrder(o), t = Date.parse(o.received_at);
  const coId = company(msg, ctx);
  const tgt = target(msg, ctx, coId);
  const lastDeal = coId === "new" ? null : ctx.dealsAt(t).filter((d: any) => d.properties.company_id === coId).sort((a: any, b: any) => a.properties.createdate.localeCompare(b.properties.createdate)).pop();
  const expect = {
    company: coId, deal_action: tgt === "new" ? "create" : `close ${tgt}`,
    pipeline: p.seats >= 100 ? "8812345" : "default", arr: String(p.total - p.onboarding), amount: String(p.total),
    owner: lastDeal ? (ctx.stateAt("deal", lastDeal.id, t).hubspot_owner_id ?? lastDeal.properties.hubspot_owner_id) : TERR[p.country!], name: `${p.customer!.split(" ")[0]} – ${p.plan} ${p.seats} seats`,
    contact_owner: TERR[p.country!], booked: "false",
  };
  // what the agent did: deal events for this order's company/name, contact created with this email
  const dealIds = [...new Set(agentEvents.filter((h: any) => h.object === "deal").map((h: any) => h.id))];
  const deal = dealIds.map((id) => ctx.deals.get(id)).find((d: any) => d && (d.properties.dealname === expect.name || (tgt !== "new" && d.id === tgt)));
  const contact = data.contacts.find((x: any) => x.properties.email === p.email);
  const got = deal ? {
    company: coId === "new" ? (agentEvents.some((h: any) => h.object === "company" && h.id === deal.properties.company_id) ? "new" : deal.properties.company_id) : deal.properties.company_id,
    deal_action: agentEvents.some((h: any) => h.object === "deal" && h.id === deal.id && h.property === "dealname" && h.old === null) ? "create" : `close ${deal.id}`,
    pipeline: deal.properties.pipeline, arr: deal.properties.arr, amount: deal.properties.amount, owner: deal.properties.hubspot_owner_id, name: deal.properties.dealname,
    contact_owner: contact?.properties.hubspot_owner_id, booked: deal.properties.booked,
  } : null;
  const diffs = got ? Object.keys(expect).filter((k) => String((expect as any)[k]) !== String((got as any)[k])) : ["no deal written"];
  if (diffs.length) bad++;
  console.log(`${o.labels.includes("Logged") ? "Logged " : "PENDING"} ${p.po} ${p.customer} (${p.seats} seats, ${p.country}) → ${diffs.length ? "DIFF " + diffs.map((k) => `${k}: expected ${(expect as any)[k]} got ${got ? (got as any)[k] : "-"}`).join("; ") : "all fields match RevOps"}`);
}
const created = (obj: string) => new Set(agentEvents.filter((h: any) => h.object === obj && h.old === null).map((h: any) => h.id)).size;
console.log(`\n${pending.length - bad}/${pending.length} orders exactly as RevOps would log them; agent field writes: ${agentEvents.length}; created ${created("deal")} deals, ${created("contact")} contacts, ${created("company")} companies (more deals than orders would mean duplicates)`);
