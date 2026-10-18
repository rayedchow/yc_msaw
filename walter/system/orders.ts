/**
 * GurtAI's order desk: order emails to orders@gurtai.example and what RevOps did in the CRM after each one.
 *
 * Generated into the CRM world (separate random stream, so the rest of the CRM history is unchanged). The unwritten
 * rules RevOps follows when logging an order:
 *   company    reuse the company whose root domain matches the sender's domain; otherwise create it (root domain,
 *              country from the order)
 *   contact    reuse the contact with that email; otherwise create it, owned by the territory of the country
 *   deal       if the account has a deal at Contract Sent, the order closes that deal as won with the order's values
 *              instead of creating a duplicate; otherwise create "<Company> – <Plan> <seats> seats"
 *   pipeline   Enterprise (8812345) from 100 seats, else the default Sales Pipeline
 *   values     arr = seats × list price × 12 (recurring only); amount = arr + one-time onboarding
 *   owner      a new deal goes to the account's current owner (latest deal), or the territory owner for new accounts
 *   stage      Closed Won with booked = false; RevOps ticks booked 3–10 days later (the commit rule)
 * The last orders of October 2026 are not logged yet: that is the work an agent picks up.
 */
import { DAY, iso, mulberry32, NOW } from "./common.js";

export const PLANS: Record<string, number> = { Starter: 30, Growth: 50, Scale: 80 };
export interface Order { id: string; from: string; to: string; subject: string; body: string; received_at: string; labels: string[]; logged_deal?: string }
type Obj = { id: string; properties: Record<string, string> };
type Log = (object: "deal" | "contact" | "company", id: string, property: string, old: string | null, nw: string | null, t: number, by: string) => void;

const NEW_NAMES = ["Kraftwerk", "Lumiere", "Tulpen", "Sevilla", "Nordisk", "Harbour", "Maple", "Samba", "Merlion", "Sakura", "Kangaroo", "Bollywood", "Emerald", "Milano", "Baltic", "Aurora", "Cascade", "Dynamo"];
const COUNTRY_OF_TLD: [string, string][] = [[".de", "Germany"], [".fr", "France"], [".nl", "Netherlands"], [".es", "Spain"], [".co.uk", "United Kingdom"], [".com.au", "Australia"], [".jp", "Japan"], [".sg", "Singapore"], [".in", "India"], [".ca", "Canada"], [".com.br", "Brazil"], [".com", "United States"], [".io", "United States"]];
const FIRST = ["anna", "jonas", "chloe", "mateo", "priya", "kenji", "lea", "oliver", "sara", "tom", "yuki", "nina"];

export function generateOrders(w: { deals: Obj[]; contacts: Obj[]; companies: Obj[] }, log: Log, territory: Record<string, string>, rootDomain: (s: string) => string,
  stateOf: (object: "deal", id: string, t: number) => Record<string, string>, isContract: (stage: string) => boolean, dropLaterEvents: (id: string, t: number) => void, seed = 31337): Order[] {
  const r = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const between = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const orders: Order[] = [];
  let did = 58000, cid = 31000, pid = 48000, n = 0;
  const live = () => w.companies.filter((c) => !c.properties.merged_into);
  const unlogged = new Set<number>();

  // ~150 orders over the period; the last 4 arrive on Oct 29–31 2026 and are not logged yet
  const times: number[] = [];
  for (let t = Date.UTC(2025, 1, 3); t < Date.UTC(2026, 9, 27); t += between(3, 6) * DAY) times.push(t + between(8, 17) * 3_600_000);
  for (const d of [29, 29, 30, 31]) { unlogged.add(times.length); times.push(Date.UTC(2026, 9, d, between(8, 16), between(0, 59))); }

  times.forEach((t, i) => {
    // who is ordering: an existing account (70%) or a new one
    let company: Obj | null = null, domain: string, country: string, name: string;
    if (r() < 0.7 || i === times.length - 3) {
      company = pick(live().filter((c) => Date.parse(c.properties.createdate!) < t));
      domain = rootDomain(company.properties.domain!);
      country = company.properties.country!;
      name = company.properties.name!;
    } else {
      const base = pick(NEW_NAMES);
      const [tld, ctry] = pick(COUNTRY_OF_TLD);
      domain = `${base.toLowerCase()}${between(1, 9) > 7 ? "-group" : ""}${tld}`;
      country = ctry;
      name = `${base} ${pick(["GmbH", "Ltd", "Inc", "SAS", "BV", "Pty"])}`;
      company = live().find((c) => rootDomain(c.properties.domain!) === domain) ?? null; // a repeat new name may already exist
    }
    const plan = pick(Object.keys(PLANS));
    const seats = pick([10, 15, 25, 40, 60, 80, 100, 120, 150, 200, 300]);
    const onboarding = r() < 0.6 ? between(2, 15) * 1000 : 0;
    const arr = seats * PLANS[plan]! * 12;
    const kind = pick(["new", "new", "new", "expansion", "renewal"]);
    const po = `PO-${4000 + i * 7}`;
    const email = `${pick(FIRST)}.${pick(["k", "m", "r", "s", "t"])}@${domain}`;
    const id = (0x19c000000 + n++ * 7907).toString(16);
    const subject = kind === "renewal" ? `Renewal order ${po}: ${seats} seats` : kind === "expansion" ? `Expansion order ${po}: +${seats} seats` : `Signed order form ${po}`;
    const body = `Hi GurtAI team,\n\nPlease find our ${kind === "renewal" ? "renewal" : kind === "expansion" ? "expansion" : "signed"} order below.\n\nCustomer: ${name} (${country})\nPlan: ${plan}\nSeats: ${seats}\nTerm: 12 months, billed annually\n` +
      `${onboarding ? `One-time onboarding: $${onboarding.toLocaleString("en-US")}\n` : ""}Total due: $${(arr + onboarding).toLocaleString("en-US")}\nPO number: ${po}\n\nThanks,\n${email.split("@")[0]!.split(".")[0]!.replace(/^./, (c) => c.toUpperCase())}`;
    const order: Order = { id, from: email, to: "orders@gurtai.example", subject, body, received_at: iso(t), labels: ["INBOX"] };
    orders.push(order);
    if (unlogged.has(i) || t > NOW) return;

    // RevOps logs it a few hours later
    let at = t + between(2, 26) * 3_600_000;
    if (!company) {
      const cId = String(++cid);
      company = { id: cId, properties: { name, domain, country, createdate: iso(at) } };
      w.companies.push(company);
      log("company", cId, "domain", null, domain, at, "204");
    }
    const owners = w.deals.filter((d) => d.properties.company_id === company!.id && Date.parse(d.properties.createdate!) <= t).sort((a, b) => a.properties.createdate!.localeCompare(b.properties.createdate!));
    let contact = w.contacts.find((c) => c.properties.email === email);
    if (!contact) {
      const pId = String(++pid);
      const owner = territory[country]!;
      contact = { id: pId, properties: { email, firstname: email.split(".")[0]!, lastname: "", country, company_id: company.id, lead_source: "INBOUND", lifecyclestage: "customer", hubspot_owner_id: owner, createdate: iso(at) } };
      w.contacts.push(contact);
      log("contact", pId, "hubspot_owner_id", null, owner, at + 60_000, "204");
    }
    at += 10 * 60_000;
    // the account's deal waiting on a signature (Contract Sent): the order is what closes it
    const open = owners.filter((d) => isContract(stateOf("deal", d.id, t).dealstage ?? "")).pop();
    const pipeline = seats >= 100 ? "8812345" : "default";
    const won = pipeline === "8812345" ? "8812351" : "closedwon";
    let deal: Obj;
    if (open) {
      deal = open;
      const st = stateOf("deal", open.id, at);
      const wonOf = open.properties.pipeline === "8812345" ? "8812351" : open.properties.pipeline === "9900001" ? "9900003" : "closedwon";
      dropLaterEvents(open.id, at); // whatever was going to happen to this deal, the order happened first
      log("deal", open.id, "dealstage", st.dealstage ?? null, wonOf, at, "204");
      log("deal", open.id, "amount", open.properties.amount!, String(arr + onboarding), at, "204");
      log("deal", open.id, "arr", open.properties.arr!, String(arr), at, "204");
      log("deal", open.id, "closedate", open.properties.closedate!, iso(t), at, "204");
      Object.assign(open.properties, { dealstage: wonOf, amount: String(arr + onboarding), arr: String(arr), closedate: iso(t), booked: "false" });
    } else {
      const dId = String(++did);
      const owner = owners.at(-1)?.properties.hubspot_owner_id ?? territory[country]!;
      deal = { id: dId, properties: { dealname: `${name.split(" ")[0]} – ${plan} ${seats} seats`, pipeline, dealstage: won, amount: String(arr + onboarding), arr: String(arr),
        closedate: iso(t), hubspot_owner_id: owner, company_id: company.id, createdate: iso(at), booked: "false", partner_tier: "" } };
      w.deals.push(deal);
      for (const [k, v] of [["dealname", deal.properties.dealname], ["pipeline", pipeline], ["dealstage", won], ["amount", deal.properties.amount], ["arr", deal.properties.arr], ["hubspot_owner_id", owner], ["company_id", company.id]] as const) log("deal", dId, k, null, v!, at, "204");
    }
    // RevOps books it a few days later (same habit as every won deal)
    const bt = at + between(3, 10) * DAY;
    if (bt <= NOW) { log("deal", deal.id, "booked", deal.properties.booked ?? "false", "true", bt, "204"); deal.properties.booked = "true"; }
    order.labels.push("Logged");
    order.logged_deal = deal.id;
  });
  return orders;
}

/** Pull the fields every order email carries (not tribal knowledge: the format is printed on the order form). */
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
