// @ts-nocheck
// Sales MCP tools, spliced into compile/server.template.ts. In scope: server, z, load, rulesOf, cases, brief, caveatsFor, ok, tracked, META,
// and the rule helpers (quarterOf, quarterRange, rootDomain).
if (META.tools.includes("get_commit")) server.tool({
  name: "get_commit",
  description: "GurtAI's commit (forecast) for a quarter, computed the way RevOps reports it: which deals count, what value each counts at, and why. Defaults to the current quarter as of now.",
  inputSchema: z.object({ quarter: z.string().optional().describe("e.g. 2026-Q4"), as_of: z.string().optional().describe("ISO date; defaults to now") }),
  annotations: { readOnlyHint: true },
}, tracked("get_commit", async ({ quarter, as_of }) => {
  const d = await load();
  const asOf = as_of ? Date.parse(as_of) : Date.now();
  const q = quarter ? { label: quarter, ...quarterRange(quarter) } : quarterOf(asOf);
  const inc = rulesOf("commit_membership").filter((r) => r.role !== "exclude"), exc = rulesOf("commit_membership").filter((r) => r.role === "exclude");
  const value = cases("commit_total");
  const rows = [];
  let excluded = 0;
  for (const deal of d.deals) {
    const c = Date.parse(String(deal.properties.closedate));
    if (c < q.start || c > q.end) continue;
    const yes = inc.filter((r) => r.fn(deal, asOf, d.ctx)), no = exc.filter((r) => r.fn(deal, asOf, d.ctx));
    if (!yes.length || no.length) { if (yes.length) excluded++; continue; }
    const v = value ? Number(value.fn(deal, d.ctx)) : Number(deal.properties.amount);
    rows.push({ id: deal.id, name: deal.properties.dealname, stage: d.ctx.stateAt("deal", deal.id, asOf).dealstage ?? deal.properties.dealstage, value_usd: v, counted_by: yes.map((r) => r.id) });
  }
  rows.sort((a, b) => b.value_usd - a.value_usd);
  return ok({ quarter: q.label, as_of: new Date(asOf).toISOString(), commit_usd: rows.reduce((s, r) => s + r.value_usd, 0), deal_count: rows.length, excluded_by_rules: excluded,
    rules_applied: [...inc, ...exc, ...(value ? [value] : [])].map(brief), caveats: caveatsFor(["commit_membership", "commit_total"]), deals: rows.slice(0, 50) });
}));

if (META.tools.includes("route_contact")) server.tool({
  name: "route_contact",
  description: "Who should own a contact at GurtAI. Pass an email (and, for new people, the country by full English name, e.g. \"Germany\"). Returning contacts and new contacts follow different company rules; the answer says which applied.",
  inputSchema: z.object({ email: z.string().optional(), country: z.string().optional().describe("full English country name, e.g. Germany"), contact_id: z.string().optional() }),
  annotations: { readOnlyHint: true },
}, tracked("route_contact", async ({ email, country, contact_id }) => {
  const d = await load();
  const existing = d.contacts.find((c) => (contact_id && c.id === contact_id) || (email && String(c.properties.email).toLowerCase() === email.toLowerCase()));
  const ownerName = (id) => { const o = d.owners.find((x) => String(x.id) === String(id)); return o ? `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email : null; };
  if (existing) {
    const r = cases("returning_contact_owner");
    const before = existing.properties.hubspot_owner_id;
    const owner = r ? String(r.fn(existing, before, d.ctx)) : before;
    return ok({ contact: existing.id, existing: true, owner_id: owner, owner: ownerName(owner), rule: r ? brief(r) : null, caveats: caveatsFor(["returning_contact_owner"]) });
  }
  if (!country) throw new Error("new contact: pass country");
  const known = d.countries.find((c) => c.toLowerCase() === country.trim().toLowerCase());
  if (!known) throw new Error(`GurtAI stores countries by full name, and "${country}" is not one it has used. Pass one of: ${d.countries.join(", ")}.`);
  country = known;
  const r = cases("new_contact_owner");
  const owner = String(r.fn({ id: "new", properties: { email: email ?? null, country } }, d.ctx));
  return ok({ existing: false, owner_id: owner, owner: ownerName(owner), rule: brief(r), caveats: caveatsFor(["new_contact_owner"]) });
}));

if (META.tools.includes("find_account")) server.tool({
  name: "find_account",
  description: "Find GurtAI's canonical company record for a domain or name, with known duplicates folded in the way RevOps merges them.",
  inputSchema: z.object({ query: z.string().describe("domain, URL or company name") }),
  annotations: { readOnlyHint: true },
}, tracked("find_account", async ({ query }) => {
  const d = await load();
  const same = cases("same_company");
  const ql = query.toLowerCase();
  const hits = d.companies.filter((c) => String(c.properties.name ?? "").toLowerCase().includes(ql) || (same ? same.fn(String(c.properties.domain), query, d.ctx) : c.properties.domain === query));
  const groups = [];
  for (const c of hits) {
    const g = groups.find((g) => same ? same.fn(String(g[0].properties.domain), String(c.properties.domain), d.ctx) : false);
    g ? g.push(c) : groups.push([c]);
  }
  return ok({ query, accounts: groups.map((g) => {
    const canon = g.find((c) => !c.properties.merged_into) ?? g[0];
    return { id: canon.id, name: canon.properties.name, domain: canon.properties.domain, duplicates: g.filter((c) => c !== canon).map((c) => ({ id: c.id, domain: c.properties.domain, merged_into: c.properties.merged_into ?? null })) };
  }), rule: same ? brief(same) : null });
}));

