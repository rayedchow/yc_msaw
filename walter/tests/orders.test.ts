import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SystemClient } from "../mine/data.js";
import { backtestRule, makeBench, type Bench, type Rule } from "../mine/backtest.js";
import { sales } from "../domains/sales/index.js";
import { startSystemServer } from "../system/serve.js";

let s: Awaited<ReturnType<typeof startSystemServer>>;
let b: Bench;
let c: SystemClient;
beforeAll(async () => {
  s = await startSystemServer("tk");
  c = new SystemClient(s.url, "tk");
  b = makeBench(sales, await sales.fetchData(c));
});
afterAll(async () => s.close());
const all = (r: ReturnType<typeof backtestRule>) => [r.train.ok + r.heldOut.ok, r.train.n + r.heldOut.n];

// RevOps' real order-desk habits, as code (what a good miner should find)
const company = `(o, ctx) => { const t = Date.parse(o.received_at), p = ctx.parseOrder(o); const co = ctx.companiesAt(t).find((c) => !c.properties.merged_into && ctx.rootDomain(c.properties.domain) === p.domain); return co ? co.id : "new"; }`;
const R: Record<string, Rule> = {
  target: { id: "T", title: "close the Contract Sent deal", kind: "order_target", code: `(o, ctx) => { const t = Date.parse(o.received_at), co = (${company})(o, ctx); if (co === "new") return "new";
    const d = ctx.dealsAt(t).filter((d) => d.properties.company_id === co && ["contractsent", "8812350", "9900002"].includes(ctx.stateAt("deal", d.id, t).dealstage)).sort((a, b) => a.properties.createdate.localeCompare(b.properties.createdate)).pop(); return d ? d.id : "new"; }` },
  company: { id: "C", title: "root domain", kind: "order_company", code: company },
  pipeline: { id: "P", title: "Enterprise from 100 seats", kind: "order_pipeline", code: `(o, ctx) => ctx.parseOrder(o).seats >= 100 ? "8812345" : "default"` },
  arr: { id: "A", title: "arr = recurring", kind: "order_arr", code: `(o, ctx) => { const p = ctx.parseOrder(o); return p.total - p.onboarding; }` },
  amount: { id: "M", title: "amount = total", kind: "order_amount", code: `(o, ctx) => ctx.parseOrder(o).total` },
  owner: { id: "O", title: "account owner, else territory", kind: "order_owner", code: `(o, ctx) => { const t = Date.parse(o.received_at), co = (${company})(o, ctx), p = ctx.parseOrder(o);
    const last = co === "new" ? null : ctx.dealsAt(t).filter((d) => d.properties.company_id === co).sort((a, b) => a.properties.createdate.localeCompare(b.properties.createdate)).pop();
    return last ? ctx.stateAt("deal", last.id, t).hubspot_owner_id ?? last.properties.hubspot_owner_id : ({ "United Kingdom":"201", Germany:"201", France:"201", Netherlands:"201", Norway:"201", Spain:"201", "United States":"202", Canada:"202", Brazil:"202", Mexico:"202", Japan:"203", Australia:"203", Singapore:"203", India:"203" })[p.country]; }` },
  name: { id: "N", title: "Company – Plan N seats", kind: "order_deal_name", code: `(o, ctx) => { const p = ctx.parseOrder(o); return p.customer.split(" ")[0] + " – " + p.plan + " " + p.seats + " seats"; }` },
};

describe("orders@ → CRM: RevOps' order-desk habits are in the history", () => {
  it("there is order history, plus a few new orders nobody has logged yet", () => {
    expect(b.data.orders.length).toBeGreaterThan(100);
    expect(b.data.orders.filter((o: any) => !o.labels.includes("Logged")).length).toBe(4);
  });
  for (const [k, rule] of Object.entries(R)) {
    it(`${k}: the real habit explains every logged order`, () => {
      const r = backtestRule(b, rule);
      const [ok, n] = all(r);
      expect(r.error).toBeUndefined();
      expect(n).toBeGreaterThan(10);
      expect(ok).toBe(n);
    });
  }
  it("summing amount as arr is caught (onboarding is one-time)", () => {
    const r = backtestRule(b, { ...R.arr!, code: `(o, ctx) => ctx.parseOrder(o).total` });
    expect(r.counterexamples.length).toBeGreaterThan(0);
  });
});

describe("CRM writes and the orders mailbox", () => {
  it("creates and updates records, labels an order, and resets", async () => {
    const created = await c.post("/crm/v3/objects/deals", { properties: { dealname: "Test – Growth 10 seats", pipeline: "default" }, actor: "test" });
    expect(created.status).toBe(201);
    const upd = await c.patch(`/crm/v3/objects/deals/${created.body.id}`, { properties: { arr: "6000" } });
    expect(upd.body.properties.arr).toBe("6000");
    expect((await c.post("/crm/v3/objects/deals", { properties: { nope: 1 } })).status).toBe(400);
    const pending = await c.get("/mail/gmail/v1/users/orders@gurtai.example/threads?q=-label:logged");
    expect(pending.body.resultSizeEstimate).toBe(4);
    await c.post(`/mail/gmail/v1/users/orders@gurtai.example/threads/${pending.body.threads[0].id}/modify`, { addLabelIds: ["Logged"] });
    expect((await c.get("/mail/gmail/v1/users/orders@gurtai.example/threads?q=-label:logged")).body.resultSizeEstimate).toBe(3);
    await c.post("/admin/reset", {});
    expect((await c.get("/mail/gmail/v1/users/orders@gurtai.example/threads?q=-label:logged")).body.resultSizeEstimate).toBe(4);
  });
});
