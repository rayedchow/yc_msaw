// @ts-nocheck
// Sales MCP order desk tools (orders@ → CRM, the way RevOps logs them), spliced into compile/server.template.ts.
// In scope: server, z, sys, load, cache, rulesOf, cases, ctxDesc, brief, caveatsFor, ok, tracked, META, RULES.
import { parseOrder, asReceivedOrder } from "./src/domain.ts";

const wonStageOf = (d, pipelineId) => (d.pipelines.find((p) => p.id === pipelineId)?.stages ?? []).find((s) => /closed won/i.test(s.label))?.id ?? null;
const ownerLabel = (d, id) => { const o = d.owners.find((x) => String(x.id) === String(id)); return o ? `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() : null; };
const ORDER_KINDS = ["order_target", "order_company", "order_pipeline", "order_arr", "order_amount", "order_owner", "order_deal_name"];

/** Plan the CRM changes for one order email, field by field, with the rule behind each value. */
function planOrder(d, order, t) {
  const p = parseOrder(order);
  const msg = asReceivedOrder(order);
  const missing = [];
  const val = (kind) => {
    const r = cases(kind);
    if (!r) { missing.push(kind); return { v: null, by: null }; }
    const v = r.fn(msg, d.ctx);
    if (v == null) missing.push(kind);
    return { v, by: r.id };
  };
  const company = val("order_company"), target = val("order_target");
  const arr = val("order_arr"), amount = val("order_amount");
  const plan = { order: { order_id: order.id, from: order.from, subject: order.subject, ...p }, company: null, contact: null, deal: null, rules: [], missing,
    caveats: caveatsFor([...ORDER_KINDS, "new_contact_owner"]) };

  // company: reuse or create
  if (company.v && company.v !== "new") {
    const c = d.ctx.companies.get(String(company.v));
    plan.company = { action: "reuse", id: String(company.v), name: c?.properties.name ?? null, because: company.by };
  } else plan.company = { action: "create", properties: { name: p.customer, domain: p.domain, country: p.country }, because: company.by };

  // contact: reuse the person, or create them with the territory owner
  const existing = d.ctx.contactsAt(t).find((c) => String(c.properties.email).toLowerCase() === p.email);
  if (existing) plan.contact = { action: "reuse", id: existing.id, email: p.email };
  else {
    const cr = cases("new_contact_owner");
    const owner = cr ? cr.fn({ id: "new", properties: { email: p.email, country: p.country } }, d.ctx) : null;
    if (owner == null) missing.push("new_contact_owner");
    plan.contact = { action: "create", because: cr?.id ?? null,
      properties: { email: p.email, firstname: p.email.split("@")[0].split(".")[0], country: p.country, lifecyclestage: "customer", lead_source: "INBOUND", hubspot_owner_id: owner == null ? null : String(owner) } };
  }

  // deal: close the account's open deal, or create one
  if (target.v && target.v !== "new") {
    const deal = d.ctx.deals.get(String(target.v));
    plan.deal = { action: "close", id: String(target.v), name: deal?.properties.dealname ?? null, because: target.by,
      properties: { dealstage: wonStageOf(d, deal?.properties.pipeline), amount: amount.v, arr: arr.v, closedate: order.received_at }, values_by: { amount: amount.by, arr: arr.by } };
  } else {
    const pipeline = val("order_pipeline"), owner = val("order_owner"), name = val("order_deal_name");
    plan.deal = { action: "create", because: target.by, owner_name: ownerLabel(d, owner.v),
      properties: { dealname: name.v, pipeline: pipeline.v, dealstage: wonStageOf(d, pipeline.v), amount: amount.v, arr: arr.v, closedate: order.received_at, hubspot_owner_id: owner.v == null ? null : String(owner.v), booked: "false" },
      values_by: { dealname: name.by, pipeline: pipeline.by, amount: amount.by, arr: arr.by, hubspot_owner_id: owner.by } };
  }
  const ids = [...new Set([plan.company.because, plan.contact.because, plan.deal.because, ...Object.values(plan.deal.values_by ?? {})].filter(Boolean))];
  plan.rules = ids.map((id) => { const r = RULES.find((x) => x.id === id); return r ? brief(r) : { id }; });
  return plan;
}

if (META.tools.includes("list_new_orders")) server.tool({
  name: "list_new_orders",
  description: "Order emails in GurtAI's orders@ inbox that are not logged in the CRM yet (no Logged label), with the fields from each order form. Start here when keeping the CRM in sync with orders.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true },
}, tracked("list_new_orders", async () => {
  const d = await load();
  const pending = d.orders.filter((o) => !o.labels.includes("Logged"));
  return ok({ count: pending.length, orders: pending.map((o) => ({ order_id: o.id, from: o.from, subject: o.subject, ...parseOrder(o) })),
    next: pending.length ? "Call plan_order_sync for each order to see the CRM changes, then apply_order_sync to write them." : "Nothing to log." });
}));

if (META.tools.includes("plan_order_sync")) server.tool({
  name: "plan_order_sync",
  description: "Dry run: the exact CRM changes GurtAI's RevOps would make for an order email (company, contact, deal and every field value), each with the company rule that decided it. Writes nothing." + ctxDesc(ORDER_KINDS),
  inputSchema: z.object({ order_id: z.string().describe("order_id from list_new_orders"), as_of: z.string().optional().describe("ISO time to plan as of; defaults to now (used to replay past orders)") }),
  annotations: { readOnlyHint: true },
}, tracked("plan_order_sync", async ({ order_id, as_of }) => {
  const d = await load();
  const order = d.orders.find((o) => o.id === order_id);
  if (!order) throw new Error(`no order "${order_id}" in orders@. Call list_new_orders for valid ids.`);
  const t = as_of ? Date.parse(as_of) : Date.now();
  if (Number.isNaN(t)) throw new Error(`could not read as_of "${as_of}"; pass an ISO date`);
  const plan = planOrder(d, order, t);
  return ok({ ...plan, already_logged: order.labels.includes("Logged"), ready: plan.missing.length === 0 });
}));

if (META.tools.includes("apply_order_sync")) server.tool({
  name: "apply_order_sync",
  description: "Write an order into the CRM the way GurtAI's RevOps does (the plan from plan_order_sync), then label the email Logged. Safe to retry: an order that is already logged is not written twice.",
  inputSchema: z.object({ order_id: z.string().describe("order_id from list_new_orders") }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, tracked("apply_order_sync", async ({ order_id }) => {
  const d = await load();
  const order = d.orders.find((o) => o.id === order_id);
  if (!order) throw new Error(`no order "${order_id}" in orders@. Call list_new_orders for valid ids.`);
  if (order.labels.includes("Logged")) return ok({ order_id, already_logged: true, written: [] });
  const plan = planOrder(d, order, Date.now());
  if (plan.missing.length) throw new Error(`this MCP version has no company rule for: ${plan.missing.join(", ")}. Log this order by hand or ask walter to learn it.`);
  const actor = "walter-sales-mcp";
  const must = (r, what) => { if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };
  const written = [];
  let companyId = plan.company.id;
  if (plan.company.action === "create") {
    companyId = must(await sys.post("/crm/v3/objects/companies", { properties: plan.company.properties, actor }), "create company").id;
    written.push({ object: "company", action: "created", id: companyId, name: plan.company.properties.name });
  }
  if (plan.contact.action === "create") {
    const c = must(await sys.post("/crm/v3/objects/contacts", { properties: { ...plan.contact.properties, company_id: companyId }, actor }), "create contact");
    written.push({ object: "contact", action: "created", id: c.id, email: plan.contact.properties.email });
  }
  let dealId = plan.deal.id;
  if (plan.deal.action === "create") {
    dealId = must(await sys.post("/crm/v3/objects/deals", { properties: { ...plan.deal.properties, company_id: companyId }, actor }), "create deal").id;
    written.push({ object: "deal", action: "created", id: dealId, name: plan.deal.properties.dealname });
  } else {
    must(await sys.patch(`/crm/v3/objects/deals/${dealId}`, { properties: plan.deal.properties, actor }), "close deal");
    written.push({ object: "deal", action: "closed won", id: dealId, name: plan.deal.name });
  }
  must(await sys.post(`/mail/gmail/v1/users/orders@gurtai.example/threads/${order.id}/modify`, { addLabelIds: ["Logged"] }), "label email");
  cache = null; // the CRM changed
  return ok({ order_id, written, deal: { id: dealId, ...plan.deal.properties }, rules: plan.rules,
    note: "Deals go in Closed Won with booked=false; RevOps books them, which is when they start counting toward commit." });
}));
