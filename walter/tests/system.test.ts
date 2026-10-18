import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, quarterOf, rootDomain, stateAt, territoryOf, isContractStage, isWonStage, TRUTH } from "../system/gurtai.js";
import { startSystemServer } from "../system/serve.js";

const w = generate();

describe("GurtAI world: the planted rules really are in the history", () => {
  it("commit = booked Closed Won + Contract Sent, at arr, sandbox excluded, reproduces every snapshot before the change", () => {
    const changeAt = Date.parse(TRUTH.drift.from);
    for (const s of w.snapshots) {
      const asOf = Date.parse(s.as_of);
      const q = quarterOf(asOf);
      const contract = asOf < changeAt;
      const ids = w.deals
        .filter((d) => d.properties.pipeline !== "9900001")
        .filter((d) => { const c = Date.parse(d.properties.closedate!); return c >= q.start && c <= q.end; })
        .filter((d) => { const st = stateAt(w.history, "deal", d.id, asOf); return (isWonStage(st.dealstage ?? "") && st.booked === "true") || (contract && isContractStage(st.dealstage ?? "")); })
        .map((d) => d.id);
      expect(ids.sort()).toEqual([...s.deal_ids].sort());
      const total = w.deals.filter((d) => ids.includes(d.id)).reduce((a, d) => a + Number(d.properties.arr), 0);
      expect(total).toBe(s.reported_commit_usd);
    }
  });

  it("the old commit rule breaks in October 2026 (the policy change is visible)", () => {
    const oct = w.snapshots.find((s) => s.as_of.startsWith("2026-10"))!;
    const asOf = Date.parse(oct.as_of);
    const q = quarterOf(asOf);
    const oldRule = w.deals
      .filter((d) => d.properties.pipeline !== "9900001")
      .filter((d) => { const c = Date.parse(d.properties.closedate!); return c >= q.start && c <= q.end; })
      .filter((d) => { const st = stateAt(w.history, "deal", d.id, asOf); return (isWonStage(st.dealstage ?? "") && st.booked === "true") || isContractStage(st.dealstage ?? ""); });
    expect(oldRule.length).toBeGreaterThan(oct.deal_ids.length);
  });

  it("amount differs from arr on most deals, so summing amount is wrong", () => {
    expect(w.deals.filter((d) => d.properties.amount !== d.properties.arr).length / w.deals.length).toBeGreaterThan(0.5);
  });

  it("initial contact owners follow territory; one returning contact was moved by hand", () => {
    const initial = w.history.filter((h) => h.object === "contact" && h.property === "hubspot_owner_id" && h.old === null);
    for (const h of initial) expect(h.new).toBe(territoryOf(w.contacts.find((c) => c.id === h.id)!.properties.country!));
    // the manual exception: a contact that reappeared at a 2026 event and was then moved to its territory owner
    const back = w.history.filter((h) => h.property === "last_event" && h.changed_at >= "2026");
    const moved = back.filter((r) => w.history.some((h) => h.id === r.id && h.property === "hubspot_owner_id" && h.changed_at > r.changed_at
      && Date.parse(h.changed_at) - Date.parse(r.changed_at) < 30 * 86_400_000));
    expect(moved.length).toBe(1);
  });

  it("every merged company shares its target's root domain", () => {
    const merges = w.history.filter((h) => h.property === "merged_into");
    expect(merges.length).toBe(14);
    for (const m of merges) {
      const dup = w.companies.find((c) => c.id === m.id)!;
      const target = w.companies.find((c) => c.id === m.new)!;
      expect(rootDomain(dup.properties.domain!)).toBe(rootDomain(target.properties.domain!));
    }
  });
});

describe("GurtAI REST API over HTTP", () => {
  let s: Awaited<ReturnType<typeof startSystemServer>>;
  const get = (p: string, token = "t0k") => fetch(s.url + p, { headers: { authorization: `Bearer ${token}` } });
  beforeAll(async () => { s = await startSystemServer("t0k"); });
  afterAll(async () => { await s.close(); });

  it("rejects a missing or wrong token", async () => {
    expect((await fetch(s.url + "/crm/v3/owners")).status).toBe(401);
    expect((await get("/crm/v3/owners", "nope")).status).toBe(401);
  });

  it("pages objects and filters search with epoch-ms dates", async () => {
    const page = await (await get("/crm/v3/objects/deals?limit=50")).json();
    expect(page.results.length).toBe(50);
    expect(page.paging.next.after).toBe("50");
    const q = quarterOf(Date.UTC(2026, 6, 15));
    const r = await fetch(s.url + "/crm/v3/objects/deals/search", { method: "POST", headers: { authorization: "Bearer t0k", "content-type": "application/json" },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "closedate", operator: "BETWEEN", value: String(q.start), highValue: String(q.end) }] }], limit: 200 }) });
    const body = await r.json();
    expect(body.total).toBeGreaterThan(10);
    const bad = await fetch(s.url + "/crm/v3/objects/deals/search", { method: "POST", headers: { authorization: "Bearer t0k", "content-type": "application/json" },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "closedate", operator: "GTE", value: "2026-07-01" }] }] }) });
    expect(bad.status).toBe(400);
  });

  it("serves the warehouse: field history and forecast snapshots", async () => {
    const fh = await (await get("/warehouse/field_history?object=deal&property=booked&limit=5")).json();
    expect(fh.results[0]).toMatchObject({ object: "deal", property: "booked", new: "true", changed_by: "204" });
    const snaps = await (await get("/warehouse/forecast_snapshots")).json();
    expect(snaps.results.length).toBe(22);
  });
});
